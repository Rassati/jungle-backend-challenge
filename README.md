# Distributed Wagering Processor

Implementação em andamento do desafio Jungle Gaming. O enunciado original está em `CHALLENGE.md`.

## Estado atual

Domínio inicial: dinheiro, carteira e lançamentos financeiros com testes unitários. Ambiente PostgreSQL e LocalStack configurado. API, persistência das operações e consumidores ainda serão implementados.

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
