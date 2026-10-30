# Mapeamento dos requisitos

Referência: [enunciado original](CHALLENGE.md). Os nomes abaixo correspondem aos arquivos e testes da entrega.

| Seção | Implementação e decisão | Evidência |
| --- | --- | --- |
| 2 — Autenticação | ProviderIdentityGuard sem autenticação; integração OIDC documentada, conforme opção permitida | `src/http/app.ts`, `ARCHITECTURE.md` |
| 4 — Stack | Bun 1.3.1, TypeScript strict, NestJS, MikroORM, PostgreSQL, SQS/LocalStack e Compose | `package.json`, `bun.lock`, `tsconfig.json`, `Dockerfile`, `compose.yml` |
| 5 — Garantias | Decimal exato, unicidade persistente, bloqueio por carteira, ledger protegido e eventos após commit | `src/domain/money.ts`, migrations, testes de schema e workers |
| 6 — Modelagem | Factories, domínio separado de ORM/Nest, transições explícitas e objetos de mensagem | `src/domain/`, `tests/unit/` |
| 7 — Regras | BET/WIN/LOSS/REFUND/ROLLBACK, referências compatíveis, reversões integrais e códigos estáveis | `wager-transaction.ts`, `wagering-store.ts`, testes unitários/integrados |
| 7.1 — Fora de ordem | Agenda persistida, backoff, 12 reprocessamentos e rejeição após expiração | `ReferenceWorker`, `retryPending`, `workers.test.ts` |
| 8 — Concorrência | PESSIMISTIC_WRITE por carteira e constraints; carteiras independentes em paralelo | `wagering.test.ts`, fixture `submit-process.ts` |
| 9 — HTTP | Todos os endpoints, validação, status distintos, cursor estável, reconciliação e health | `src/http/`, `queries.ts`, `http.test.ts`, coleção Postman |
| 10 — SQS | Mesmo submit da API, inbox persistente, confirmação após commit, retry de ACK separado, heartbeat, retry/DLQ e encerramento | `QueueConsumer`, `runtime.ts`, `workers.test.ts` |
| 11 — Outbox | Eventos versionados, SQL atômico, publicadores concorrentes e retomada após queda | `integration-event.ts`, `OutboxPublisher`, testes de falha |
| 12 — Observabilidade | Logs JSON, correlação, estados, duplicatas, retries, DLQ, locks, lag e latências | `observability.ts`, `/metrics`, testes HTTP/workers |
| 13 — Testes | 111 testes unitários e integrados; falhas de ACK injetadas no transporte, com PostgreSQL/SQS reais | `tests/unit/`, `tests/integration/`, `tests/fixtures/` |
| 14 — Documentação | Setup, comandos, decisões, garantias e limitações | `README.md`, `ARCHITECTURE.md`, este mapeamento |

## Cenários de concorrência e recuperação exigidos

| Cenário | Teste |
| --- | --- |
| A mesma aposta 50 vezes em paralelo, um débito | `wagering.test.ts` — `50 concurrent identical requests` |
| Duas apostas de 80 disputam saldo 100 | `wagering.test.ts` — `two simultaneous 80.00 bets` |
| Carteiras distintas em paralelo | `wagering.test.ts` — `different wallets process concurrently` |
| Três processos simultâneos | `wagering.test.ts` — `three independent Bun processes` |
| Queda após commit e antes do ack | `workers.test.ts` — `consumer killed after commit before ack` |
| Falha temporária ao excluir após commit | `workers.test.ts` — `transient ACK failures` |
| ACK esgotado, reinício e reentrega com novo handle | `workers.test.ts` — `exhausted ACK retries survive restart` |
| Resposta perdida após exclusão real no SQS | `workers.test.ts` — `lost ACK response after SQS deletion` |
| Handle inválido aguarda nova entrega | `workers.test.ts` — `invalid receipt handle` |
| Retry de ACK após encaminhamento à DLQ | `workers.test.ts` — `ACK retry after DLQ forwarding` |
| Dois publicadores sobre a mesma outbox | `workers.test.ts` — `two concurrent publishers` |
| Estorno antes da aposta | `workers.test.ts` — `refund before bet` |
| Reinício e consistência final | `workers.test.ts` — testes de novas conexões/processos e reconciliação |
| Publicação interrompida após envio | `workers.test.ts` — `publisher killed after sending` |
| Evento não publicado antes do commit | `workers.test.ts` — `publisher cannot see or send an event before its SQL commit` |

## Executar a verificação

```sh
docker compose --profile app up -d --build --wait
docker compose --profile app exec api bun run typecheck
docker compose --profile app exec api bun run test
docker compose --profile app exec api bun run demo:sqs
```

Os testes criam bancos e filas exclusivos, usam os serviços reais e removem seus recursos ao concluir. As fixtures de queda executam processos Bun separados e os interrompem depois de um marco confirmado de commit/publicação. A demonstração cria dados auditáveis no banco local e verifica o saldo contra o histórico.

## Opcionais e limites

OIDC real, partidas dobradas, teste de carga, OpenTelemetry e dashboard não foram implementados. A autenticação é uma omissão expressamente permitida. A saída SQS tem entrega ao menos uma vez; sistemas downstream devem deduplicar o eventId persistido. Se o banco não puder gravar uma falha de infraestrutura, a mensagem preservada na DLQ é a evidência disponível. Outros limites estão descritos em `ARCHITECTURE.md`.
