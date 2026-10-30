# Distributed Wagering Processor

Implementação do desafio Jungle Gaming. O enunciado original está em `CHALLENGE.md`.

## Estado atual

API NestJS, consumidor SQS, publicador de outbox e worker de referências pendentes. PostgreSQL com migrations reversíveis, bloqueio por carteira, idempotência persistente, ledger imutável e inbox/outbox transacionais. Testes reais incluem 50 envios concorrentes, três processos Bun independentes e processos interrompidos após commit ou publicação. Autenticação real e diferenciais opcionais não estão implementados; decisões e limitações estão em `ARCHITECTURE.md`.

## Iniciar toda a aplicação com Docker

```sh
docker compose --profile app up -d --build --wait
```

Esse comando inicia PostgreSQL, LocalStack, aplica migrations e inicia API e workers. A API fica em `http://127.0.0.1:3000`; a prontidão é consultada em `/health/ready`. O serviço `migrate` termina com sucesso antes da API iniciar. Credenciais são locais e fictícias.

```sh
docker compose --profile app exec api bun run typecheck
docker compose --profile app exec api bun run test
docker compose --profile app exec api bun run demo:sqs
docker compose --profile app logs -f api
docker compose --profile app stop
```

A demonstração cria uma carteira de teste, envia três cópias de uma aposta pela fila e verifica saldo de R$ 75 e reconciliação consistente. Ela deixa os registros auditáveis no banco local. Os testes automatizados, por sua vez, usam bancos e filas temporários exclusivos e removem esses recursos ao terminar.

`stop` preserva o volume do PostgreSQL. Para desenvolver com Bun na máquina, inicie apenas os serviços base como descrito abaixo e não mantenha uma segunda API usando a mesma porta.

## Ferramentas

- Bun 1.3.1
- Docker Compose para a aplicação completa, PostgreSQL e LocalStack

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

`bun run db:rollback` reverte a última migration e remove os objetos criados por ela. Reverter a criação das tabelas elimina seus dados; use apenas quando isso for intencional. Os testes de reversibilidade executam essa operação apenas no banco temporário.

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

## Processamento assíncrono

`bun run start` inicia API e workers. Para executar somente a API, defina `WORKERS_ENABLED=false`. Os nomes das filas podem ser configurados por `SQS_INPUT_QUEUE`, `SQS_DLQ_QUEUE` e `SQS_EVENTS_QUEUE`.

O consumidor valida o envelope da seção 10 do desafio e reutiliza o processamento da API. Confirma a mensagem somente após o commit; o inbox persistente usa `(consumerName,messageId)`. Visibilidade de 30 segundos é renovada durante o processamento e a confirmação. Erros de negócio registrados são confirmados. Mensagens inválidas vão para DLQ; falhas transitórias de processamento usam intervalos crescentes e chegam à DLQ após cinco recebimentos. A confirmação de envio para DLQ precede a exclusão da origem.

O ACK (`DeleteMessage`) tem tratamento separado: até três tentativas por recebimento, com timeout de 5 segundos por chamada e esperas de 100 e 200 ms. Um receipt handle inválido encerra as tentativas daquele recebimento. Se a exclusão continuar falhando, o resultado confirmado fica preservado e a próxima entrega usa um novo handle; a idempotência impede outro débito ou novos eventos. Falha apenas no ACK não grava FAILED nem encaminha a operação à DLQ pela aplicação. Logs distinguem commit, ACK confirmado, falha e confirmação adiada; `wager_ack_failures_total` conta erros de exclusão e `wager_retries_total{subsystem="ack"}` conta novas tentativas. A política de redrive do próprio SQS permanece como proteção após cinco recebimentos sem exclusão; portanto uma mensagem na DLQ pode corresponder a uma operação já confirmada, cujo estado deve ser consultado antes de qualquer reenvio.

Quando falhas de infraestrutura esgotam as tentativas e o banco está disponível, a operação é registrada como `FAILED/INFRASTRUCTURE_FAILURE`, sem alteração de saldo, com inbox e evento `WagerTransactionFailed`. Um resultado anteriormente confirmado nunca é sobrescrito por essa auditoria. Se o próprio banco estiver indisponível, a mensagem preservada na DLQ permanece como evidência para investigação/reenvio.

O publicador seleciona um evento por transação com `FOR UPDATE SKIP LOCKED`. Mantém a reserva enquanto envia ao SQS com timeout; depois marca o evento publicado. Em falha, registra a tentativa e uma nova data no banco. Publicação pode ser repetida após queda entre envio e commit: `eventId` é estável e o consumidor de saída deve deduplicá-lo persistentemente. A deduplicação FIFO é apenas uma proteção adicional.

Referências pendentes são verificadas a cada segundo, em lotes de até 20. O banco armazena tentativas e próximo horário. A espera começa em 1 segundo, dobra e é limitada a 300 segundos; há até 12 reprocessamentos. Referência ainda ausente ao final gera REJECTED/REFERENCE_NOT_FOUND e evento de rejeição. O worker bloqueia primeiro a carteira e revalida o estado para impedir reprocessamento duplicado entre instâncias.

SIGTERM/SIGINT interrompem a aquisição de mensagens e aguardam trabalho em andamento antes de fechar clientes e banco. O Compose concede 30 segundos de encerramento. Após interrupção forçada, transações não confirmadas são desfeitas e mensagens não confirmadas voltam à fila.

## Métricas e validação

`/metrics` expõe estados das operações, duplicatas, tentativas por subsistema, mensagens encaminhadas à DLQ, conflitos de lock, atraso da outbox, latência de processamento, latência HTTP e divergências de reconciliação. Identificadores individuais ficam nos logs, não nos rótulos das métricas.

Validação: 111 testes, com PostgreSQL e LocalStack reais, além da checagem de tipos. A suíte inclui falhas no ACK (inclusive resposta perdida após exclusão), reentrega após tentativas esgotadas, receipt handle inválido, encerramento forçado após commit/antes do ack, publicação interrompida, publicadores concorrentes, referências fora de ordem e recuperação por novas conexões/processos. Os testes de ACK injetam apenas a falha de transporte via middleware do SDK; banco e demais operações SQS continuam reais. A publicação anterior ao commit é verificada explicitamente. O mapeamento entre requisitos, código e testes está em [REQUIREMENTS.md](REQUIREMENTS.md).
