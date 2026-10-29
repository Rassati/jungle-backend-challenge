# Distributed Wagering Processor

Implementação em andamento do desafio Jungle Gaming. O enunciado original está em `CHALLENGE.md`.

## Estado atual

API NestJS com dinheiro, carteira, ledger e regras de apostas/reversões. PostgreSQL e LocalStack configurados. Migrations reversíveis, restrições financeiras e processamento transacional com bloqueio por carteira, idempotência persistente, inbox e gravação de eventos na outbox. Testes reais incluem 50 envios concorrentes e três processos Bun independentes. Consumidores/publicadores SQS e worker de referências pendentes ainda serão implementados.

## Ferramentas

- Bun 1.3.1
- Docker Compose para PostgreSQL e LocalStack

## Verificar esta etapa

```sh
bun install
bun run typecheck
bun run test:unit
```

## Serviços locais

```sh
docker compose up -d --wait
docker compose ps
docker compose stop
```

PostgreSQL: `localhost:55432`, banco/usuário `jungle`, senha local `jungle-local-only`.
LocalStack: `http://localhost:4566`, região `us-east-1`, credenciais fictícias `test`.
Configuração de referência: `.env.example`. Os dados do PostgreSQL persistem no volume do projeto.

As filas são criadas automaticamente: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`.

## Banco e testes de integração

Com os serviços locais disponíveis:

```sh
bun run db:migrate
bun run test:integration
```

A suíte cria um banco temporário com nome aleatório, aplica as migrations e remove somente esse banco ao terminar. O banco padrão é acessado em `localhost:55432`. Para outro ambiente, configure `DATABASE_URL` para a aplicação e `TEST_ADMIN_DATABASE_URL` para a conexão autorizada a criar bancos de teste.

`bun run db:rollback` reverte a última migration e remove as tabelas criadas por ela; use apenas quando a perda desses dados for intencional. Os testes de reversibilidade executam essa operação apenas no banco temporário.

## Executar e testar a API

```sh
docker compose up -d --wait
bun install --frozen-lockfile
bun run db:migrate
bun run start
```

Endereço padrão: `http://127.0.0.1:3000`. Variáveis `PORT` e `HOST` permitem alterar a escuta.

Importe [a coleção do Postman](postman/Jungle-Backend.postman_collection.json) e execute as requisições na ordem. A criação captura o identificador da carteira automaticamente. Após apostar R$ 25, o saldo deve ser R$ 75. Reenviar a mesma aposta retorna `idempotentReplay: true`, sem novo débito. Executar a criação novamente gera um novo jogador/carteira.

### Endpoints

| Método | Caminho | Finalidade |
| --- | --- | --- |
| POST | `/wallets` | Criar carteira |
| GET | `/wallets/:walletId` | Consultar saldo |
| GET | `/wallets/:walletId/ledger?limit=50&cursor=...` | Histórico com cursor opaco |
| POST | `/wagering/transactions` | Submeter operação; requer `Idempotency-Key` |
| GET | `/wagering/transactions/:id` | Consultar por id interno |
| GET | `/providers/:providerId/wagering/transactions/:externalId` | Consultar por id do provedor |
| POST | `/wallets/:walletId/reconciliation` | Conferir saldo contra o ledger |
| GET | `/health/live` | Processo vivo |
| GET | `/health/ready` | PostgreSQL e fila SQS acessíveis |
| GET | `/metrics` | Métricas em formato Prometheus |

HTTP: 201 para carteira criada; 200 para operação processada/replay; 202 para operação pendente; 400 para entrada inválida; 404 para recurso inexistente; 409 para conflito; 422 para rejeição de negócio; 503 para dependência indisponível. Erros internos inesperados retornam 500. Respostas incluem `X-Correlation-Id`; erros incluem o mesmo identificador no corpo. Logs não registram payloads financeiros completos.

Os endpoints estão sem autenticação nesta entrega incremental. `ProviderIdentityGuard` é um ponto de extensão explícito, sem verificação de identidade; o desenho de integração OIDC está descrito em `ARCHITECTURE.md`. Não há controle de acesso implementado.
