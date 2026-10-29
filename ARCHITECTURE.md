# Decisões de arquitetura

Decisões, garantias e limites da implementação.

## Implementado: domínio monetário

`Money` encapsula decimal.js com precisão de 50 dígitos, entrada/saída decimal textual e escala de saída de duas casas. Limite absoluto: `999999999999999999.99`, correspondente ao futuro `NUMERIC(20,2)`. Valores com mais de duas casas são rejeitados em vez de arredondados. Não há conversão monetária para `number`.

O objeto permanece multi-moeda, validando formato de três letras maiúsculas; a fronteira HTTP/SQS aceita somente BRL, como permitido pelo desafio. Operações entre moedas diferentes são erros de domínio.

## Implementado: carteira e ledger

A carteira encapsula o saldo. Créditos e débitos positivos produzem lançamentos com saldo anterior e posterior; falhas deixam o estado intacto. Operações sem efeito financeiro não chamam esses métodos. `version` começa em 1 e só incrementa em movimentações. Uma carteira aberta com saldo positivo disponibiliza um lançamento de abertura; a aplicação persiste a transação interna OPENING e o lançamento atomicamente.

`WalletLedgerEntry` não expõe mutações e copia as datas nas entradas/saídas. Sua factory verifica positividade, direção, não-negatividade dos saldos e aritmética. Reidratação reconstrói estado persistido sem repetir regras de transição.

Essas classes não garantem por si só unicidade ou concorrência entre instâncias. Essas garantias são aplicadas no schema e na camada transacional.

## Configurado: ambiente de desenvolvimento

Docker Compose inicia PostgreSQL e LocalStack com SQS. Portas publicadas apenas em loopback; credenciais fictícias para desenvolvimento. Volume nomeado preserva PostgreSQL entre reinícios. Filas criadas por script de inicialização, incluindo fila FIFO de entrada, DLQ e fila de saída de eventos.

## Implementado: transações de apostas

`WagerTransaction` encapsula estados e valida as operações BET, WIN, LOSS, REFUND e ROLLBACK. Transições aceitas: PENDING e PENDING_REFERENCE podem passar a PROCESSED, REJECTED ou FAILED; operações com referência podem permanecer em PENDING_REFERENCE. Estados terminais não permitem nenhuma transição. Referência existente ainda pendente também gera espera; referência rejeitada/falha causa REFERENCE_NOT_PROCESSED. WIN e LOSS com referência só podem referenciar BET; BET não aceita referência. OPENING não é aceito pela factory pública.

Interpretação de valores: LOSS exige zero, operações financeiras exigem valor positivo. Reversões são integrais. REFUND e ROLLBACK podem cada um reverter uma mesma referência uma vez, conforme a regra de unicidade por tipo do enunciado. Não se exige gameId igual na referência, pois a regra explícita exige provider, player, wallet, moeda e rodada.

Taxonomia inicial de rejeições: INSUFFICIENT_FUNDS (aposta sem saldo), REVERSAL_INSUFFICIENT_FUNDS (reversão sem saldo), WALLET_MISMATCH, CURRENCY_MISMATCH, REFERENCE_MISMATCH, INVALID_REFERENCE_KIND, REFERENCE_NOT_PROCESSED, REFERENCE_AMOUNT_MISMATCH, ALREADY_REVERSED, REFERENCE_NOT_FOUND (expiração da espera), AMOUNT_OUT_OF_RANGE. INFRASTRUCTURE_FAILURE fica reservado para falha permanente auditável.

## Implementado: identificação do payload

Hash SHA-256 do JSON com chaves ordenadas recursivamente, contendo apenas os campos de negócio explicitamente selecionados. Header Idempotency-Key, messageId e correlationId não participam. O valor monetário textual informado é preservado no hash: mudar sua representação é uma mudança de payload. O processamento transacional compara o hash contra o valor persistido para diferenciar replay de conflito.

## Implementado: schema e migrations

MikroORM 6.6 com metadata de persistência separada do domínio. Valor monetário mapeado como string em NUMERIC(20,2). Migrations SQL versionadas e reversíveis criam wallets, wager_transactions, wallet_ledger_entries, inbox_messages e outbox_messages.

O schema protege saldo não-negativo, carteira única por player/moeda, chave de idempotência global, identificador externo único por provedor, lançamento único por transação/carteira e reversão processada única por referência/tipo. Chaves estrangeiras compostas alinham carteira e moeda dos registros. CHECK valida a aritmética do ledger; triggers proíbem UPDATE, DELETE e TRUNCATE do ledger e UPDATE de transações terminais. O administrador do banco ainda pode alterar o schema: a proteção pressupõe uma aplicação que não modifica DDL em operação normal.

## Implementado: caso de uso e concorrência

`WageringStore` usa `EntityManager.transactional()` e `LockMode.PESSIMISTIC_WRITE` para bloquear a carteira antes de calcular o novo saldo. Carteira, resultado da operação, ledger, inbox e outbox são confirmados juntos. Carteiras distintas usam bloqueios independentes. Abertura com saldo positivo grava OPENING, lançamento e evento de alteração do saldo na mesma transação.

INSERT com ON CONFLICT e as constraints do schema arbitram duplicações. A mesma chave e mesmo hash devolvem o resultado salvo, inclusive saldo histórico. A mesma chave com outro hash ou o mesmo identificador externo com outra chave são conflitos. Chaves de idempotência são globais; recomenda-se prefixá-las pelo provedor. A abertura de carteira repetida é conflito.

Quando a entrada contém identidade de mensagem, o inbox valida seu hash e marca processed_at dentro da mesma transação. Os adaptadores HTTP/SQS usam a mesma operação submit. O consumidor SQS confirma mensagens somente depois desse método retornar com o commit concluído.

Eventos possuem classe abstrata e subclasses concretas com nomes e versão definidos no tipo. Payloads monetários são objetos serializáveis com strings. Os eventos ficam na outbox; nenhum envio externo ocorre durante a transação financeira.

## Implementado: publicação e processamento

Outbox persistente selecionada por FOR UPDATE SKIP LOCKED, um evento por transação. O bloqueio é mantido durante o envio, limitado por timeout de 5 segundos. Essa escolha reduz complexidade de leases e permite que a queda de um processo libere automaticamente a reserva. O custo é ocupar uma conexão enquanto há uma chamada de rede; foi aceito para o escopo do teste. A transação financeira original já está confirmada antes desse envio.

Tentativas e próxima data de publicação são persistidas, com espera exponencial limitada a 300 segundos. Eventos confirmados não são descartados por limite global de tentativas: uma indisponibilidade prolongada deve permitir recuperação posterior. A publicação pode duplicar se o processo cair após o envio e antes da marcação de sucesso. O eventId é estável; consumidores de saída devem deduplicá-lo em persistência, inclusive além da janela de deduplicação FIFO de cinco minutos.

QueueConsumer valida o mesmo contrato de entrada da API. Mensagens internas não exigem autenticação, mas providerId e demais campos continuam validados. Heartbeat renova a visibilidade durante o processamento. Sucesso e rejeição de negócio persistida resultam em ack após commit. Mensagens inválidas e conflitos permanentes são enviadas à DLQ; falhas transitórias aguardam backoff e têm no máximo cinco recebimentos antes da DLQ. Envio para DLQ precede exclusão na origem e preserva o corpo para diagnóstico. Se houver queda entre as duas ações, a DLQ pode receber duplicatas, identificáveis pelo messageId; isso não reaplica efeitos financeiros.

Referências pendentes têm próximo horário e contador persistidos. ReferenceWorker lista até 20 candidatas por segundo; cada tentativa bloqueia primeiro a carteira e depois revalida estado e horário da transação. Processos que perderem a corrida não reaplicam a operação. A espera inicial é 1 segundo e dobra até o teto de 300 segundos. Após até 12 reprocessamentos sem referência processável, a operação é rejeitada com REFERENCE_NOT_FOUND e evento correspondente. Reiniciar o processo preserva a agenda. Uma referência válida ainda é aplicada na última tentativa antes de decidir a expiração.

SIGTERM/SIGINT fecham a API, interrompem a aquisição e aguardam iterações em andamento antes de fechar os clientes. Caso uma mensagem seja recebida durante a parada, sua visibilidade é devolvida. Timeout de conexão de banco é 5 segundos; queries e statements têm limite de 10 segundos e locks financeiros de 5 segundos. O Compose concede 30 segundos de encerramento e executa Bun diretamente como PID 1.

## Implementado: fronteira HTTP

NestJS com injeção de dependência explícita para funcionar com Bun sem depender de inferência de metadata de construtores. Zod valida corpos, UUIDs, headers e parâmetros; propriedades extras no corpo são rejeitadas. OPENING e provider interno não são aceitos pela API. Money continua validando suas próprias invariantes, independentemente do transporte.

Controller chama o mesmo processamento transacional do adaptador SQS. Respostas HTTP distinguem entrada inválida (400), ausência (404), conflito (409), rejeição de negócio (422), pendência (202) e falhas transitórias reconhecidas de banco (503, Retry-After). Carteiras criadas retornam 201, operações processadas/replays retornam 200. Falhas inesperadas retornam 500 sem SQL, credenciais ou mensagens internas.

Consultas não alteram dados. Ledger ordenado por (created_at,id), com paginação keyset ascendente e limite de 1 a 100; cursor base64url vinculado à carteira preserva os seis dígitos de microssegundos do PostgreSQL. É um identificador de posição, sem finalidade de autorização. Reconciliação usa uma única consulta SQL para obter saldo e soma do ledger no mesmo snapshot MVCC; sinaliza divergência, registra log e incrementa métrica, sem reparo automático.

Logs JSON de operações expõem identificadores de correlação/operação/carteira/provedor e estado, sem valores financeiros. Métricas cobrem operações por estado, replays, retries por subsistema, DLQ, conflitos de lock, atraso da outbox, processamento, latência HTTP e divergências. Contadores de processo reiniciam com o processo; as garantias financeiras não dependem deles. Health live não verifica dependências; ready consulta PostgreSQL e GetQueueUrl no SQS. Os dois endpoints permanecem abertos.

## Decisão de escopo: autenticação

ProviderIdentityGuard é um ponto de extensão explícito sem autenticação real. Uma integração futura validará assinatura, emissor, audiência e expiração de tokens de IdP OIDC via JWKS, e mapeará o sujeito para a identidade autorizada do provedor antes de aceitar providerId. O enunciado permite a omissão da implementação e prioriza correção financeira, concorrência e idempotência. Endpoints de saúde permanecem abertos. Autorização por provedor não está implementada.

## Validação disponível nesta etapa

100 testes passam em Windows/Bun e Linux/Docker, além da checagem estática. PostgreSQL real: mapeamento monetário, constraints, imutabilidade, migrations reversíveis, 50 reenvios paralelos com um débito, disputa por saldo, três processos Bun, carteiras independentes, replay histórico, reversões concorrentes, inbox e rollback financeiro quando a outbox falha. HTTP: contratos, status, consultas, cursor, reconciliação e dependências indisponíveis. SQS real via LocalStack: redelivery, publicadores concorrentes, retry/DLQ, referências fora de ordem/expiração, processo morto após commit antes do ack e publicador morto após enviar antes de marcar sucesso. Novas conexões/processos retomam o trabalho e a reconciliação verifica o saldo final.

## Limitações e opcionais

Autenticação OIDC é uma extensão documentada. Não foram implementados OpenTelemetry, dashboard, teste de carga nem partidas dobradas. Ordenação estrita de eventos por carteira não é prometida: eventos têm identidade/versão e os consumidores devem tolerar duplicação e reordenação. A saída é um contrato de integração, sem implementação de um sistema downstream de negócio. LocalStack é um emulador local; suas filas não usam armazenamento persistente nesta configuração. O teste de recuperação reinicia processos da aplicação, preservando banco e broker. Não há promessa de reconstruir mensagens já consumidas se o armazenamento do próprio broker for apagado.
