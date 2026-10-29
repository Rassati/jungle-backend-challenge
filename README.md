# Distributed Wagering Processor

Implementação em andamento do desafio Jungle Gaming. O enunciado original está em `CHALLENGE.md`.

## Estado atual

Domínio: dinheiro, carteira, ledger e regras de apostas/reversões com testes unitários. PostgreSQL e LocalStack configurados. Schema com migrations reversíveis, restrições financeiras e testes de integração reais. API, caso de uso transacional completo e consumidores ainda serão implementados.

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
