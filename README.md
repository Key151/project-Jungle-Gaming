# Distributed Wagering Processor — Jungle Gaming 🦧

Serviço que processa transações de apostas (recebidas por HTTP ou por fila SQS)
e mexe no saldo do jogador de forma **correta**, mesmo quando a mesma
mensagem chega várias vezes, fora de ordem ou várias instâncias do serviço
disputam o mesmo saldo ao mesmo tempo.

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | Bun 1.x |
| Linguagem | TypeScript (modo estrito) |
| Framework | NestJS 11 |
| Banco | PostgreSQL 16 (com constraints no schema) |
| Mensageria | AWS SQS (SDK v3) via LocalStack |
| ORM | MikroORM 7 |
| Orquestração | Docker Compose |
| Migrations | SQL versionado e reversível (`/migrations`) |

---

## 0. Sobre este projeto (leia isso antes)

Este projeto foi feito por mim, **desenvolvedor júnior**, com **auxílio do
OpenCode** (IA) para escrever o código, debugar e documentar.

Sendo transparente sobre o que isso significa:

- ✅ **As decisões técnicas são minhas** e estão justificadas no
  [ARCHITECTURE.md](./ARCHITECTURE.md): por que lock pessimista e não
  otimista, por que a idempotência mora no banco, por que o ledger é
  append-only, quais são os limites da solução.
- ✅ **O código compila, roda e passa nos testes** — 35 testes unitários,
  23 testes de integração contra PostgreSQL e SQS reais, e um smoke test com
  31 verificações na API.
- ⚠️ **Escrevi bastante código com ajuda da IA.** Sei explicar o que cada
  parte faz e por que existe, mas não escrevi cada linha do zero. Isso está
  dito aqui de propósito, e não tem nada de errado: é como qualquer dev
  trabalha com documentação, Stack Overflow e IA hoje.
- ⚠️ Sei bem o que **não** sei ainda: balanceamento de carga real, tuning de
  pool de conexões, observabilidade com OTel, e o desenho de autenticação de
  verdade. Está listado em "O que eu sei que dá para melhorar".

---

## 1. Como rodar

### 1.1 Com Docker (o caminho mais fácil)

Pré-requisito: **Docker Desktop** instalado e rodando (o "whale" verde na
barra de tarefas).

```bash
cd "D:\project Jungle Gaming"

docker compose up -d --build      # sobe PostgreSQL + LocalStack(SQS) + app
docker compose logs -f app        # acompanha o log (Ctrl+C para sair)
```

O `compose` sobe 4 serviços:

| Serviço | Porta | O que é |
|---|---|---|
| `postgres` | 5432 | banco com as tabelas e constraints |
| `localstack` | 4566 | SQS local (filas) |
| `migrate` | — | roda as migrations e encerra |
| `app` | 3000 | a API + consumidores |

A API fica em **http://localhost:3000**.

Para parar: `docker compose down` (ou `docker compose down -v` para
**apagar** o banco e começar do zero).

### 1.2 Sem Docker (só a parte HTTP)

Instale o PostgreSQL 16 nativo, copie o `.env` e:

```bash
cp .env.example .env      # ajuste POSTGRES_USER / POSTGRES_PASSWORD
bun install
bun run migrate            # cria as tabelas e as constraints
bun run build
bun run start              # http://localhost:3000
```

Nesse modo a **API funciona por completo** (wallet, apostas, idempotência,
ledger, reconciliação). Só o SQS fica de fora: o `/health/ready` responde
`degraded` e os workers de fila ficam logando aviso.

### 1.3 Comandos

| Comando | O que faz |
|---|---|
| `bun install` | instala as dependências |
| `bun run build` | compila o TypeScript para `dist/` |
| `bun run start` | roda a aplicação |
| `bun run migrate` | aplica as migrations pendentes |
| `bun run migrate:down` | reverte a última migration (testa o "down") |
| `bun run migrate:status` | mostra quais migrations foram aplicadas |
| `bun run test` | testes **unitários** (não precisa de nada rodando) |
| `bun run test:integration` | testes de **integração** (precisa do app no ar) |
| `bun run smoke` | **smoke test**: bate na API e imprime PASS/FAIL |
| `bun run typecheck` | `tsc --noEmit` em src + tests + scripts |

---

## 2. Como verificar que está funcionando

Com o app no ar:

```bash
bun run smoke
```

```
== Smoke test em http://localhost:3000 ==

health
  OK   GET /health/live = 200
  OK   Postgres alcançável
wallet
  OK   POST /wallets = 201
  OK   saldo inicial 1000.00 e version 1
  OK   wallet duplicada = 409
  OK   payload inválido = 400
idempotência
  OK   BET = 201 PROCESSED
  OK   replay = 200 com idempotentReplay=true
  OK   mesma key + payload diferente = 409
cenário da seção 8 (duas apostas de 80 disputando saldo 100)
  OK   exatamente 1 PROCESSED
  OK   exatamente 1 REJECTED
  OK   saldo final = 20.00
ledger e reconciliação
  OK   reconciliação consistente
  OK   saldo materializado == soma do ledger
== 31 passaram, 0 falharam ==
```

E a suíte completa:

```bash
bun run test                # 35 unitários
bun run test:integration    # 23 testes contra PostgreSQL + SQS reais
```

Os testes de integração **não usam mock**: eles batem na API HTTP real e leem
o PostgreSQL de verdade para conferir ledger, inbox e outbox.

---

## 3. Como o sistema foi feito

Aqui vai o resumo das 6 decisões que sustentam a correção do dinheiro.
O detalhe está no [ARCHITECTURE.md](./ARCHITECTURE.md).

### 3.1 Dinheiro nunca é `number`

Em JavaScript, `0.1 + 0.2` dá `0.30000000000000004`. Em dinheiro isso é
inaceitável. Então o valor é sempre uma **string decimal** (`"25.00"`), o
cálculo é feito com `decimal.js` e no banco a coluna é `NUMERIC(18,2)`.

```json
{ "amount": "25.00", "currency": "BRL" }
```

Entradas invalidas são recusadas na porta: `number`, `NaN`, `1e2`, string
vazia, mais de 2 casas decimais, valor negativo e moeda fora do ISO-4217.
Misturar `BRL` com `USD` dá erro de domínio.

### 3.2 Ledger: a verdade de verdade

Toda mudança de saldo vira uma linha em `wallet_ledger_entries` (o
livro-razão): direção (débito/crédito), valor, saldo antes e saldo depois.
O saldo da wallet é só um **atalho**; a prova é o ledger.

A imutabilidade é imposta **no banco**, não no código: uma trigger bloqueia
`UPDATE` e `DELETE` nessa tabela. Também existem `CHECK`s garantindo a
aritmética do lançamento (`balance_after = balance_before ± amount`) e o saldo
nunca negativo.

Por isso o teste final do projeto é: **saldo da wallet == soma do ledger**
(é o que o endpoint de reconciliação checa).

### 3.3 Concorrência: lock pessimista por wallet

O problema clássico: duas apostas de 80 leem saldo 100 ao mesmo tempo, as
duas acham que "cabe" e o resultado é saldo negativo.

A solução: dentro da transação SQL eu faço
`SELECT ... FROM wallets WHERE id = ? FOR UPDATE`. A segunda transação
**espera** a primeira terminar e então lê o saldo já atualizado. O lock é
**por linha da wallet** (não é global), então wallets diferentes nunca se
atrasam, e funciona com qualquer número de instâncias porque o lock mora no
PostgreSQL, não no processo.

### 3.4 Idempotência: a garantia mora no banco

A entrega da fila é *at-least-once*: a mesma operação pode chegar 50 vezes.
A garantia vem de uma `UNIQUE (idempotency_key)` no banco:

1. a requisição tenta inserir a transação;
2. se já existe (outra instância ganhou a corrida), eu leio a linha e
   comparo o `payload_hash`:
   - hash igual → **replay**: devolvo a resposta original, sem efeito
     colateral;
   - hash diferente → **conflito** (HTTP 409), porque a mesma key com outro
     payload é um erro do provedor, não um replay.

O hash é SHA-256 do JSON canônico (chaves ordenadas) dos campos de negócio
(sem o header e sem metadados de transporte). Nada de cache em memória: isso
sumiria no restart e não seria compartilhado entre instâncias.

### 3.5 Inbox e Outbox:atomicidade

O problema: "gravo no banco e depois publico o evento". Se o processo morre
no meio, o banco mudou e ninguém avisou (ou o inverso: avisei de algo que
não aconteceu).

A solução é o padrão **Transactional Outbox**:

- **Inbox**: o consumidor grava a mensagem numa tabela `inbox_messages`
  (com `UNIQUE (consumer_name, message_id)`) **na mesma transação** do efeito
  financeiro. A segunda entrega da mesma mensagem é recusada pelo banco → o
  consumidor só dá ack, sem repetir o efeito.
- **Outbox**: o evento é gravado em `outbox_messages` **na mesma transação**
  da alteração de saldo. Um worker separado lê as linhas pendentes
  (com `FOR UPDATE SKIP LOCKED`, para vários publishers não se atropelarem)
  e publica no SQS.

Assim: se o processo morrer depois do commit e antes de publicar, outra
instância assume e publica. Publicação duplicada pode acontecer — e por isso
o consumidor é idempotente.

### 3.6 Referência fora de ordem

Um `REFUND` pode chegar **antes** da `BET` que ele reverte. Nesse caso a
transação fica `PENDING_REFERENCE` e um worker com **backoff exponencial**
(5s, 10s, 20s... até 5min, no máximo 10 tentativas ≈ 21 minutos) tenta
reprocessar. Se a referência nunca aparecer, a transação vira `REJECTED` com
`REFERENCE_RESOLUTION_TIMEOUT` — terminal e auditável.

### 3.7 Códigos de falha

Toda rejeição tem um código estável, para o provedor saber se reenvia,
corrige o payload ou desiste. Exemplo: `INSUFFICIENT_FUNDS` (a aposta não
cabe) e `REVERSAL_WOULD_NEGATIVE_BALANCE` (a reversão quebraria o saldo) são
**códigos diferentes de propósito**, porque são problemas operacionais
diferentes.

### 3.8 Observabilidade

- Logs em **JSON**, com `correlationId`, `transactionId`, `walletId`,
  `providerId`, `messageId` e `failureCode`. Nunca logamos payload
  financeiro completo nem valores de dinheiro.
- Métricas em `/metrics` (contadores por status, duplicatas, retries, DLQ,
  outbox lag, latência).
- `/health/live` (processo vivo) e `/health/ready` (PostgreSQL + SQS
  alcançáveis), ambos sem autenticação.

---

## 4. API HTTP

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet (gera a transação `OPENING` + lançamento no ledger) |
| `GET` | `/wallets/:walletId` | wallet, saldo e version |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | ledger com cursor opaco e estável |
| `GET` | `/wagering/transactions/:transactionId` | transação por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | transação por id do provedor |
| `POST` | `/wallets/:walletId/reconciliation` | saldo materializado × soma do ledger |
| `GET` | `/health/live` · `/health/ready` · `/metrics` | operação |

Exemplo:

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

**Status HTTP** (consistentes em toda a API):

| Status | Significado |
|---|---|
| `201` | transação aplicada / wallet criada |
| `200` | replay idempotente (`idempotentReplay: true`) |
| `202` | aceite, aguardando referência (`PENDING_REFERENCE`) |
| `400` | payload inválido (inclui `Idempotency-Key` ausente) |
| `404` | recurso inexistente |
| `409` | conflito de idempotência / wallet já existe |
| `422` | rejeitado por regra de negócio (vem `failureCode`) |
| `503` | falha transitória (PostgreSQL/SQS fora do ar) |

---

## 5. Estrutura do projeto

```
src/
  common/        money, dto, erros, filtro de exceção, auth guard (no-op),
                 logger JSON, métricas, hash do payload, eventos
  wallet/        a wallet (regra), as entidades do banco, o service e o controller
  wagering/      a transação de aposta (regra), o service com o caso de uso,
                 o controller
  messaging/     cliente SQS, consumidor, publisher da outbox,
                 worker de referência pendente, entidades inbox/outbox
  db/            helper de SQL cru dentro da transação
  health/        health check e métricas
migrations/      SQL versionado e reversível
scripts/         runner das migrations + smoke test
tests/unit/      testes puros
tests/integration/  testes contra a app, o PostgreSQL e o SQS reais
```

---

## 6. O que eu sei que dá para melhorar

Sendo honesto sobre os limites desta entrega:

1. **Autenticação** — não implementei. O enunciado aceita, e deixei um
   `AuthGuard` no-op com o ponto de extensão explícito (validar JWT de um IdP
   externo como Keycloak/Zitadel).
2. **Métricas por instância** — são contadores em memória. Em produção
   precisariam ir para um Prometheus/Pushgateway.
3. **Testes com 3+ instâncias** — não automatizei; descrevi como fazer no
   ARCHITECTURE.md.
4. **Sem teste de carga** — dá para medir throughput, p95 e outbox lag.
5. **Backoff sem jitter** — é determinístico; com jitter eu evitaria que
   várias instâncias reprocessem no mesmo instante.
6. **Pool de conexões** — não fiz tuning para o volume esperado.
7. **Ledger de partidas dobradas** (débito em conta de jogo + crédito na
   wallet) — é o diferencial que permite conciliação por provedor.

---

## 7. Onde ler mais

- [ARCHITECTURE.md](./ARCHITECTURE.md) — decisões, alternativas descartadas,
  análise do cenário de concorrência, taxonomia de falhas e limitações.
- `migrations/001_init.up.sql` — o schema com as constraints (a "lei" do
  sistema).
- `src/wagering/wager-transaction.service.ts` — o caso de uso (o coração do
  serviço).
- `src/common/money.ts` — o value object de dinheiro.
