# Decisões de arquitetura

Documento incremental. As seções distinguem o que já existe do que ainda está planejado.

## Implementado: domínio monetário

`Money` encapsula decimal.js com precisão de 50 dígitos, entrada/saída decimal textual e escala de saída de duas casas. Limite absoluto: `999999999999999999.99`, correspondente ao futuro `NUMERIC(20,2)`. Valores com mais de duas casas são rejeitados em vez de arredondados. Não há conversão monetária para `number`.

O objeto permanece multi-moeda, validando formato de três letras maiúsculas; a futura fronteira HTTP/SQS aceitará somente BRL, como permitido pelo desafio. Operações entre moedas diferentes são erros de domínio.

## Implementado: carteira e ledger

A carteira encapsula o saldo. Créditos e débitos positivos produzem lançamentos com saldo anterior e posterior; falhas deixam o estado intacto. Operações sem efeito financeiro não chamam esses métodos. `version` começa em 1 e só incrementa em movimentações. Uma carteira aberta com saldo positivo disponibiliza um lançamento de abertura; a aplicação deverá persistir a transação interna OPENING e o lançamento atomicamente.

`WalletLedgerEntry` não expõe mutações e copia as datas nas entradas/saídas. Sua factory verifica positividade, direção, não-negatividade dos saldos e aritmética. Reidratação reconstrói estado persistido sem repetir regras de transição.

Essas classes não garantem por si só unicidade ou concorrência entre instâncias. Essas garantias serão aplicadas no schema e na camada transacional.

## Configurado: ambiente de desenvolvimento

Docker Compose inicia PostgreSQL e LocalStack com SQS. Portas publicadas apenas em loopback; credenciais fictícias para desenvolvimento. Volume nomeado preserva PostgreSQL entre reinícios. Filas criadas por script de inicialização, incluindo fila FIFO de entrada, DLQ e fila de saída de eventos.

## Implementado: transações de apostas

`WagerTransaction` encapsula estados e valida as operações BET, WIN, LOSS, REFUND e ROLLBACK. Transições aceitas: PENDING e PENDING_REFERENCE podem passar a PROCESSED, REJECTED ou FAILED; operações com referência podem permanecer em PENDING_REFERENCE. Estados terminais não permitem nenhuma transição. Referência existente ainda pendente também gera espera; referência rejeitada/falha causa REFERENCE_NOT_PROCESSED. WIN e LOSS com referência só podem referenciar BET; BET não aceita referência. OPENING não é aceito pela factory pública.

Interpretação de valores: LOSS exige zero, operações financeiras exigem valor positivo. Reversões são integrais. REFUND e ROLLBACK podem cada um reverter uma mesma referência uma vez, conforme a regra de unicidade por tipo do enunciado. Não se exige gameId igual na referência, pois a regra explícita exige provider, player, wallet, moeda e rodada.

Taxonomia inicial de rejeições: INSUFFICIENT_FUNDS (aposta sem saldo), REVERSAL_INSUFFICIENT_FUNDS (reversão sem saldo), WALLET_MISMATCH, CURRENCY_MISMATCH, REFERENCE_MISMATCH, INVALID_REFERENCE_KIND, REFERENCE_NOT_PROCESSED, REFERENCE_AMOUNT_MISMATCH, ALREADY_REVERSED, REFERENCE_NOT_FOUND (expiração da espera), AMOUNT_OUT_OF_RANGE. INFRASTRUCTURE_FAILURE fica reservado para falha permanente auditável.

## Implementado: identificação do payload

Hash SHA-256 do JSON com chaves ordenadas recursivamente, contendo apenas os campos de negócio explicitamente selecionados. Header Idempotency-Key, messageId e correlationId não participam. O valor monetário textual informado é preservado no hash: mudar sua representação é uma mudança de payload. O código prepara o hash e permite compará-lo; ainda não constitui idempotência persistente sem o caso de uso transacional.

## Implementado: schema e migrations

MikroORM 6.6 com metadata de persistência separada do domínio. Valor monetário mapeado como string em NUMERIC(20,2). Migrations SQL versionadas e reversíveis criam wallets, wager_transactions, wallet_ledger_entries, inbox_messages e outbox_messages.

O schema protege saldo não-negativo, carteira única por player/moeda, chave de idempotência global, identificador externo único por provedor, lançamento único por transação/carteira e reversão processada única por referência/tipo. Chaves estrangeiras compostas alinham carteira e moeda dos registros. CHECK valida a aritmética do ledger; triggers proíbem UPDATE, DELETE e TRUNCATE do ledger e UPDATE de transações terminais. O administrador do banco ainda pode alterar o schema: a proteção pressupõe uma aplicação que não modifica DDL em operação normal.

## Implementado: caso de uso e concorrência

`WageringStore` usa `EntityManager.transactional()` e `LockMode.PESSIMISTIC_WRITE` para bloquear a carteira antes de calcular o novo saldo. Carteira, resultado da operação, ledger, inbox e outbox são confirmados juntos. Carteiras distintas usam bloqueios independentes. Abertura com saldo positivo grava OPENING, lançamento e evento de alteração do saldo na mesma transação.

INSERT com ON CONFLICT e as constraints do schema arbitram duplicações. A mesma chave e mesmo hash devolvem o resultado salvo, inclusive saldo histórico. A mesma chave com outro hash ou o mesmo identificador externo com outra chave são conflitos. Chaves de idempotência são globais; recomenda-se prefixá-las pelo provedor. A abertura de carteira repetida é conflito.

Quando a entrada contém identidade de mensagem, o inbox valida seu hash e marca processed_at dentro da mesma transação. Os adaptadores HTTP/SQS usarão a mesma operação submit. O consumidor SQS e a política de ack ainda não existem nesta etapa.

Eventos possuem classe abstrata e subclasses concretas com nomes e versão definidos no tipo. Payloads monetários são objetos serializáveis com strings. Os eventos ficam na outbox; nenhum envio externo ocorre durante a transação financeira.

## Planejado: publicação e processamento

Outbox persistente para eventos após commit; publicadores concorrentes usarão seleção bloqueada e recuperação com tentativas limitadas por execução. Publicação pode duplicar se houver falha entre envio e marcação de sucesso: consumidores precisam deduplicar por eventId. Inbox persistente deduplicará mensagens de entrada. Confirmação SQS apenas após commit.

## Decisão de escopo: autenticação

Será usado um ponto de extensão explícito sem autenticação real, documentando integração futura com IdP OIDC. O enunciado permite essa omissão e prioriza correção financeira, concorrência e idempotência. Endpoints de saúde permanecerão abertos. Autorização por provedor não será apresentada como implementada.

## Validação disponível nesta etapa

77 testes e checagem estática de TypeScript. Integração com PostgreSQL real: mapeamento monetário, constraints, imutabilidade, reversibilidade das migrations, 50 reenvios paralelos com um débito, duas apostas de 80 disputando saldo de 100, três processos Bun independentes, carteiras distintas em paralelo, replay de saldo histórico, reversões concorrentes, inbox e rollback financeiro completo quando a gravação da outbox falha. Testes de SQS, crash após commit/antes do ack, publishers concorrentes e reprocessamento/reinício ainda precisam ser implementados.
