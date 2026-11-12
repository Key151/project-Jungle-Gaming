# Distributed Wagering Processor — Jungle Gaming 🦧

Serviço financeiro distribuído que processa transações de apostas recebidas de
múltiplos provedores de jogos, com **correção monetária garantida** mesmo com
mensagens duplicadas, fora de ordem ou processadas simultaneamente por várias
instâncias.

- **Runtime / package manager / test runner:** Bun 1.x
- **Linguagem:** TypeScript (modo estrito)
- **Framework:** NestJS 11
- **Banco:** PostgreSQL 16 (constraints de integridade no schema)
- **Mensageria:** AWS SQS (SDK v3) via LocalStack
- **ORM:** MikroORM 7 (Unit of Work + Identity Map explícitos)
- **Orquestração:** Docker Compose
- **Migrations:** SQL versionadas e reversíveis (`/migrations`)

---

## 1. Subindo o ambiente

Pré-requisitos: Docker + Docker Compose (e Bun 1.x se for rodar fora do container).

```bash
# sobe PostgreSQL + LocalStack(SQS) + aplica migrations + sobe a aplicação
docker compose up -d --build

# acompanha os logs
docker compose logs -f app

# derruba tudo (mantendo os volumes)
docker compose down
```

Ao subir:

| Serviço | URL |
|---|---|
| API | http://localhost:3000 |
| Health (live/ready) | http://localhost:3000/health/live · /health/ready |
| Métricas | http://localhost:3000/metrics |
| SQS (LocalStack) | http://localhost:4566 |

### Rodando sem Docker (Postgres + SQS locais)

```bash
bun install
cp .env.example .env      # o Bun carrega o .env automaticamente

# terminal 1 - PostgreSQL + SQS (LocalStack)
docker compose up -d postgres localstack

# terminal 2 - migrations + aplicação
bun run migrate
bun run build && bun run start
```

### Comandos

| Comando | O que faz |
|---|---|
| `bun install` | instala as dependências |
| `bun run build` | compila o TypeScript (strict) para `dist/` |
| `bun run start` | executa a aplicação (`bun dist/main.js`) |
| `bun run migrate` | aplica as migrations pendentes |
| `bun run migrate:down` | reverte a última migration aplicada |
| `bun run migrate:status` | mostra o estado das migrations |
| `bun run test` | testes **unitários** (sem infra) |
| `bun run test:integration` | testes de **integração** (exigem o app no ar) |
| `bun run typecheck` | `tsc --noEmit` em src + tests + scripts |

---

## 2. Testes

```bash
# unitários (Money, Wallet, Ledger, WagerTransaction, hash) - 35 testes
bun run test

# integração: precisa do ambiente no ar
docker compose up -d --build
bun run test:integration
```

Os testes de integração **não usam mocks**: batem na API HTTP real e leem o
PostgreSQL real (`pg`) para conferir ledger, inbox e outbox.

Cenários cobertos pela integração:

- criação de wallet, transação `OPENING` e lançamento de abertura;
- BET/WIN/LOSS/REFUND/ROLLBACK e seus `failureCode`;
- idempotência (replay e conflito de payload);
- saldo insuficiente, referência fora de ordem (`PENDING_REFERENCE`);
- **duas apostas de 80 disputando saldo 100** (cenário obrigatório da seção 8);
- **a mesma aposta 50 vezes em paralelo** → um único débito;
- wallets distintas em paralelo;
- ledger, cursor de paginação e reconciliação;
- consumidor SQS: inbox, redelivery sem efeito duplicado, DLQ e outbox.

---

## 3. API HTTP

### Criar wallet

```bash
curl -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1
}
```

O saldo inicial gera, **na mesma transação SQL**, uma transação interna
`OPENING` e o lançamento `CREDIT` correspondente no ledger.

### Submeter transação

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

### Demais endpoints

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/wallets/:walletId` | wallet + saldo + version |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | ledger com cursor opaco e estável |
| `GET` | `/wagering/transactions/:transactionId` | transação por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | transação por id do provedor |
| `POST` | `/wallets/:walletId/reconciliation` | saldo materializado × soma do ledger |
| `GET` | `/health/live` | liveness (sem autenticação) |
| `GET` | `/health/ready` | readiness: PostgreSQL + SQS (sem autenticação) |
| `GET` | `/metrics` | métricas no formato texto do Prometheus |

### Status HTTP (consistentes em toda a API)

| Status | `code` | Quando |
|---|---|---|
| `201` | — | transação aplicada / wallet criada |
| `200` | — | replay idempotente (`idempotentReplay: true`) |
| `202` | — | aceite com referência pendente (`PENDING_REFERENCE`) |
| `400` | `INVALID_PAYLOAD` | payload inválido (inclui `Idempotency-Key` ausente) |
| `404` | `NOT_FOUND` | recurso inexistente |
| `409` | `IDEMPOTENCY_CONFLICT` | mesma key com payload diferente |
| `409` | `WALLET_ALREADY_EXISTS` | wallet duplicada (playerId + moeda) |
| `422` | `BUSINESS_RULE_VIOLATION` | rejeição por regra de negócio (vem `failureCode`) |
| `503` | `INFRASTRUCTURE_ERROR` | falha transitória (PostgreSQL/SQS indisponível) |

Formato do erro:

```json
{ "statusCode": 422, "code": "BUSINESS_RULE_VIOLATION", "message": "...", "failureCode": "INSUFFICIENT_FUNDS" }
```

---

## 4. Mensageria

Filas (criadas idempotentemente pela aplicação no boot):

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada das operações de aposta |
| `wager-transactions-dlq.fifo` | DLQ da fila de entrada (redrive após 5 entregas) |
| `wager-events.fifo` | eventos de integração publicados pela outbox |

Envelope de entrada:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Para publicar de teste (LocalStack):

```bash
awslocal --endpoint-url=http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","data":{...}}' \
  --message-group-id wallet-1 --message-deduplication-id msg-1
```

---

## 5. Estrutura do projeto

```
src/
  domain/                 # regras de negócio puras (sem ORM, sem Nest)
    money.ts              # value object de dinheiro (string decimal)
    wallet.ts             # aggregate root da wallet
    wallet-ledger-entry.ts# livro-razão imutável
    wager-transaction.ts  # aggregate da operação de aposta
    integration-event.ts  # envelope dos eventos + eventos concretos
  application/            # casos de uso (orquestram domínio + persistência)
    wagering/             # processador (usado pelo HTTP e pelo SQS)
    wallet/               # criação, ledger e reconciliação
  infrastructure/
    persistence/          # entidades MikroORM + helper de SQL cru transacional
    messaging/            # SQS: cliente, consumidor, publisher da outbox, worker
  interfaces/http/        # controllers, DTOs, filtro de erros, guard
migrations/               # SQL versionado e reversível
scripts/migrate.ts        # runner das migrations
tests/unit/               # testes puros (bun test)
tests/integration/        # testes contra a app e o Postgres reais
```

---

## 6. Documentação

As decisões técnicas, trade-offs, taxonomia de falhas e limitações estão em
[ARCHITECTURE.md](./ARCHITECTURE.md).
