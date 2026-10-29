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

## Planejado: persistência e concorrência

MikroORM e PostgreSQL. Uma transação SQL bloqueará a linha da carteira com `FOR UPDATE` e persistirá conjuntamente carteira, resultado da operação, ledger, inbox e outbox. Carteiras distintas terão bloqueios independentes. A validação e o bloqueio ocorrerão antes de calcular o novo saldo.

Schema com restrições de unicidade para carteira por jogador/moeda, identificadores de operações e lançamentos por operação/carteira; saldo não-negativo e ledger imutável também serão protegidos no banco. O replay devolverá o resultado original salvo, sem recalcular o saldo atual.

## Planejado: publicação e processamento

Outbox persistente para eventos após commit; publicadores concorrentes usarão seleção bloqueada e recuperação com tentativas limitadas por execução. Publicação pode duplicar se houver falha entre envio e marcação de sucesso: consumidores precisam deduplicar por eventId. Inbox persistente deduplicará mensagens de entrada. Confirmação SQS apenas após commit.

## Decisão de escopo: autenticação

Será usado um ponto de extensão explícito sem autenticação real, documentando integração futura com IdP OIDC. O enunciado permite essa omissão e prioriza correção financeira, concorrência e idempotência. Endpoints de saúde permanecerão abertos. Autorização por provedor não será apresentada como implementada.

## Validação disponível nesta etapa

Testes unitários de Money, Wallet e ledger e checagem estática de TypeScript. Os testes reais de banco, mensageria, falhas e múltiplas instâncias ainda precisam ser implementados.
