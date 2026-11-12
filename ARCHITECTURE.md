# ARCHITECTURE — Distributed Wagering Processor

Documento de decisões técnicas, trade-offs e limitações.
Tudo aqui é **executável**: cada decisão aponta para o código que a implementa.

---

## 1. Visão geral

O serviço recebe operações de aposta (HTTP ou SQS) e as converte em
movimentações financeiras sobre a wallet do jogador. A garantia central é:

> **O saldo materializado da wallet é sempre igual à soma do ledger**, e o
> ledger é append-only, íntegro e auditável.

```
   HTTP ─┐                              ┌── outbox_messages (eventos)
         ├──►  WagerTransactionProcessor ──► wager_transactions (estado)
   SQS  ─┘        (um único use case)       ├── wallets (saldo materializado)
                  │                         └── wallet_ledger_entries (prova)
                  ▼
          PostgreSQL (1 transação SQL)
```

O mesmo use case (`WagerTransactionProcessor.process`) é usado pela entrada
HTTP e pelo consumidor SQS — o enunciado exige isso e evita duas
implementações da regra de negócio.

---

## 2. Decisões e trade-offs

### 2.1 Dinheiro: `string` decimal + `decimal.js` (nunca `number`)

- **Decisão:** `Money` guarda um `Decimal` (decimal.js) internamente e é
  **sempre** exposto como string decimal com escala fixa de 2
  (`src/domain/money.ts`). No banco, `NUMERIC(18,2)`.
- **Por quê:** `0.1 + 0.2 === 0.30000000000000004` em IEEE-754. Em dinheiro isso
  é inaceitável. `number` está proibido pelo enunciado e também não é
  armazenável com segurança em `double precision`.
- **Contrato:** `amount` é string decimal (`"25.00"`); entradas inválidas
  (NaN, Infinity, notação científica, vazio, mais de 2 casas, negativo) são
  rejeitadas na entrada. Operações entre moedas diferentes lançam
  `CurrencyMismatchError`.
- **Arredondamento:** o domínio **não arredonda** — rejeita o que não cabe em
  2 casas. Isso é mais honesto que arredondar silenciosamente um valor que o
  provedor mandou.
- **Alternativa considerada:** guardar centavos em `bigint`. É mais rápido e
  exato, mas perde a noção de "dinheiro" no código e complica a serialização.
  `decimal.js` dá precisão de 40 dígitos, folga de sobra para 2 casas.

### 2.2 Domínio puro separado do ORM

- **Decisão:** `src/domain/*` não importa NestJS nem MikroORM. As entidades de
  persistência (`src/infrastructure/persistence/entities/*`) são projeções
  "burra" do agregado, e o mapeamento é explícito.
- **Por quê:** o enunciado diz que "o domínio não depende de tipos monetários do
  ORM nem de decorators do NestJS". A separação também deixa os testes
  unitários rodarem sem banco e sem container (35 testes em ~60 ms).
- **Custo:**appers manuais (um para wallet, um para transação). É o preço da
  clareza.

### 2.3 ORM: MikroORM 7

- **Decisão:** MikroORM (`@mikro-orm/core` 7.2.9 + `@mikro-orm/postgresql` +
  `@mikro-orm/decorators/legacy`), com Unit of Work e Identity Map explícitos:
  a wallet e o ledger são carregados e alterados como entidades, e o flush
  acontece no fim da transação.
- **Por quê:** o enunciado pede MikroORM como preferencial. O Unit of Work
  casa com o modelo do enunciado (agregado → transação SQL), e a Identity Map
  permite garantir que o saldo lido é o do banco (com `em.clear()` antes da
  leitura crítica).
- **Alternativas:** TypeORM (aceito pelo enunciado) foi descartado por não ter
  Unit of Work/Identity Map reais — o agregado viraria um "bag of columns".
- **Custo/limitação:** no MikroORM 7 (ESM-only) o SQL cru precisa de
  placeholders `?` (o driver formata e escapa os valores) e precisa receber o
  **contexto de transação** para rodar dentro da transação aberta. Isso está
  isolado em `src/infrastructure/persistence/raw-sql.ts`, num único helper
  (`rawExecute`), usado por todas as queries cruas.

### 2.4 Schema: SQL escrito à mão, versionado e reversível

- **Decisão:** as tabelas, constraints, índices e a trigger de imutabilidade
  estão em `migrations/001_init.up.sql` (com o `.down.sql` correspondente), e
  um runner próprio (`scripts/migrate.ts`) aplica/reverte, controlando versões
  em `schema_migrations`.
- **Por quê:** (a) as invariantes do enunciado (UNIQUE, CHECK, trigger) são
  **schema**, não aplicação — quero escrevê-las de forma explícita e
  revisável; (b) o gerador de migrations do ORM geraria DDL a partir das
  entidades e eu perderia o controle fino (CHECK de aritmética do ledger,
  trigger anti-UPDATE/DELETE, índice único parcial de reversão);
  (c) `up`/`down` em SQL são reversíveis por construção.
- **Alternativa considerada:** `EntityManager.getSchema()` do MikroORM — mais
  rápido de escrever, mas justamente o que o enunciado pede para ser
  "desenhado com cuidado".

### 2.5 Concorrência: lock pessimista por wallet

- **Decisão:** a unidade de concorrência é a `walletId`. Dentro da transação
  SQL fazemos `SELECT id FROM wallets WHERE id = ? FOR UPDATE` e só então lemos
  e alteramos o saldo.
- **Por quê:**
  - é **por linha**, não global — cumpre a restrição de não usar lock global;
  - funciona com qualquer número de instâncias, porque o lock vive no
    PostgreSQL, não no processo;
  - elimina a janela de lost update sem depender de retry: a transação B
    espera o commit da transação A e então lê o saldo **já atualizado**.
- **Defesa em profundidade no banco:** `CHECK (balance_amount >= 0)` — mesmo
  que alguém escrevesse um caminho de código errado, o banco recusa saldo
  negativo.
- **Alternativas:**
  - *Optimistic locking* (version + retry): exige tratar conflitos com retry
    e códigos de erro; o lock pessimista é mais simples de raciocinar e
    suficiente para a granularidade exigida (por wallet).
  - *Update atômico condicionado* (`UPDATE ... WHERE balance >= ?`): isola o
    débito, mas não protege a sequência "ler saldo → calcular → gravar
    lançamento" (a transação inteira precisaria ser serializada do mesmo
    jeito). O `FOR UPDATE` é a solução que resolve o caso geral.
- **Por que `em.clear()` antes de ler a wallet:** a Identity Map do MikroORM
  pode devolver uma entidade "old" (carregada antes do lock). Limpar o
  identity map garante que a leitura do saldo é o do banco.

### 2.6 Idempotência: constraint no banco + hash do payload

- **Decisão:** `UNIQUE (idempotency_key)` em `wager_transactions` é a fonte da
  verdade. O `Idempotency-Key` do header é obrigatório e é o que identifica a
  operação.
- **Fluxo:**
  1. o processador tenta `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`;
  2. se inseriu → processa;
  3. se não inseriu → outra instância (ou outra mensagem) já processou: lê a
     linha e compara o `payload_hash`;
     - hash igual → **replay**: devolve o resultado original (inclusive o
       saldo observado na época, guardado em `observed_balance_amount`);
     - hash diferente → **conflito** (HTTP 409), não replay.
- **Algoritmo do hash (documentado):** SHA-256, em hexadecimal, sobre o JSON
  canônico (chaves ordenadas recursivamente, sem espaços) de **apenas** o
  subconjunto de campos de negócio:
  `providerId, externalTransactionId, playerId, walletId, roundId, gameId,
  kind, money.amount, money.currency, referenceExternalTransactionId`.
  O header `Idempotency-Key` e metadados de transporte (source HTTP/SQS,
  messageId, timestamps) **não** entram no hash — assim a mesma operação
  recebida pelo HTTP e pela fila tem o mesmo hash.
- **Por que não cache em memória:** some no restart e não é compartilhado
  entre instâncias. O enunciado proíbe; e está certo: a garantia precisa
  sobreviver a reinício.

### 2.7 Inbox e Outbox (padrão Transactional Outbox)

- **Inbox:** `UNIQUE (consumer_name, message_id)`. O consumidor insere a
  mensagem **na mesma transação** do efeito financeiro; se o insert não
  retorna linha, a mensagem já foi vista:
  - com `processed_at` preenchido → duplicata: só dá ack;
  - sem `processed_at` → tentativa anterior que falhou: tenta de novo.
  - O `ack` (delete da mensagem) só acontece **depois do commit**.
- **Outbox:** o evento é gravado em `outbox_messages` na **mesma transação** da
  alteração de saldo. O publisher (worker separado) reserva um lote com
  `FOR UPDATE SKIP LOCKED` + lease (`locked_until`), publica no SQS e marca
  `published_at`.
- **Publicação duplicada é possível** (o processo morre entre o `send` e o
  `published_at`) — por isso o consumidor é idempotente (inbox). Publicação
  **perdida** não é: se o processo morre antes de publicar, a linha continua
  pendente e outra instância assume.
- **Ordenação:** as filas são FIFO e o `MessageGroupId` é a `walletId` — a
  ordem por wallet é preservada pelo broker. Isso é otimização, **não** a
  garantia: a garantia final é o banco (constraints + lock).

### 2.8 Referência fora de ordem (`PENDING_REFERENCE`)

- REFUND/ROLLBACK que chegam antes da referência são gravados como
  `PENDING_REFERENCE` e reprocessados por um worker agendado
  (`PendingReferenceWorker`).
- **Backoff exponencial:** 5s, 10s, 20s, 40s, 80s, 160s, 300s (teto) —
  10 tentativas, ≈ 21 minutos de janela.
- **TTL justificado:** 21 minutos cobre a latência típica de um provedor
  (fechamento de rodada + reprocessamento). Passou disso, a transação vira
  `REJECTED` com `REFERENCE_RESOLUTION_TIMEOUT` — terminal e auditável.
- **Reversão parcial está fora de escopo:** o valor da reversão precisa ser
  igual ao da referência; divergência → `REFERENCE_AMOUNT_MISMATCH`.

### 2.9 Autenticação: não implementada (decisão explícita)

- **Decisão:** não há autenticação. O enunciado aceita isso desde que a
  decisão e o **ponto de extensão** fiquem explícitos.
- **Ponto de extensão:** `src/interfaces/http/auth/no-op-auth.guard.ts` é o
  `AuthGuard` no-op aplicado por `@UseGuards` nos controllers. O desenho
  pretendido (documentado no próprio arquivo) é:
  1. validar o Bearer token contra o JWKS de um IdP externo (Keycloak,
     Zitadel, Cognito...);
  2. extrair o `providerId` do token e autorizar a operação;
  3. injetar um `ProviderIdentity` no contexto, validado contra o `providerId`
     da mensagem.
- **Fora do escopo por decisão do enunciado:** `/health/*` fica aberto; a fila
  é canal interno confiável, mas **a identidade do provedor contida na
  mensagem continua sujeita às mesmas validações de domínio** (o `providerId`
  resolve a referência e é validado no escopo da operação).

### 2.10 Bun como runtime, `tsc` como compilador

- **Decisão:** `bun` é o package manager, o runtime e o test runner; a
  **compilação** é feita pelo `tsc` (`bun run build` → `dist/`), e a aplicação
  roda como `bun dist/main.js`.
- **Por quê:** o NestJS depende de `emitDecoratorMetadata` (o DI do Nest usa
  `design:paramtypes`) e o transpilador do Bun não emite metadata de
  decorators. Compilar com `tsc` e **executar** com Bun resolve isso sem
  abrir mão do Bun como runtime.
- Os testes rodam com `bun test` (nativo), sobre os fontes de `src/domain`
  (TypeScript puro, sem decorators).

### 2.11 Observabilidade (simplificada, como o enunciado permite)

- **Logs:** JSON lines no stdout, com `correlationId`, `transactionId`,
  `walletId`, `providerId`, `messageId` e `failureCode`. **Nunca** logamos
  payload financeiro completo nem valores de dinheiro (só identificadores e
  status) — requisito explícito de "sem dados sensíveis".
- **Métricas:** contadores em memória expostos em `/metrics` (texto
  Prometheus): transações por status, duplicatas detectadas, retries, DLQ,
  conflitos de idempotência, outbox lag e latência de processamento.
  **Limitação:** são métricas **por instância** — em produção com N
  instâncias o certo seria exportar para um Prometheus/Pushgateway. Está
  documentado como limitação, não como solução.
- **Health:** `/health/live` (processo vivo, sem tocar em dependências) e
  `/health/ready` (PostgreSQL + SQS alcançáveis) — ambos sem autenticação.

---

## 3. Modelo de dados

| Tabela | Papel | Garantias no schema |
|---|---|---|
| `wallets` | saldo materializado | `UNIQUE (player_id, currency)`, `CHECK (balance_amount >= 0)` |
| `wallet_ledger_entries` | livro-razão (append-only) | `UNIQUE (transaction_id)`, `CHECK` da aritmética (`balance_after = balance_before ± amount`), `CHECK (balance_after >= 0)`, **trigger que bloqueia UPDATE e DELETE** |
| `wager_transactions` | estado da operação | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, `CHECK` de `kind`/`status`, `CHECK` de que REFUND/ROLLBACK têm referência, índice único parcial (uma reversão por referência e por tipo) |
| `inbox_messages` | dedup de mensagens | `UNIQUE (consumer_name, message_id)` |
| `outbox_messages` | eventos a publicar | índice parcial das pendentes |

O trigger de imutabilidade:

```sql
CREATE TRIGGER trg_wallet_ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
```

---

## 4. Máquina de estados da transação

```
          create()
              │
              ▼
          PENDING ─────────────────────► REJECTED   (terminal)
              │                            FAILED    (terminal)
              │                            PROCESSED (terminal)
              ▼
      PENDING_REFERENCE ───────────────► REJECTED / PROCESSED
```

- `PROCESSED`, `REJECTED` e `FAILED` são **terminais**: transicionar de novo
  lança `InvalidTransactionStateError` (erro de programação, não caminho de
  negócio).
- `LOSS` é `PROCESSED` sem tocar no saldo e **sem** gerar lançamento.
- `OPENING` é interno: a API e a fila o rejeitam (400 / DLQ).

### Taxonomia de `failureCode`

| Código | Terminal? | Significado |
|---|---|---|
| `INSUFFICIENT_FUNDS` | sim | saldo insuficiente para a aposta |
| `REVERSAL_WOULD_NEGATIVE_BALANCE` | sim | a reversão quebraria o saldo (código **distinto** do anterior, por serem situações operacionalmente diferentes) |
| `WALLET_NOT_FOUND` | sim | wallet inexistente |
| `WALLET_OWNERSHIP_MISMATCH` | sim | wallet de outro jogador |
| `CURRENCY_MISMATCH` | sim | moeda da operação ≠ moeda da wallet |
| `REFERENCE_NOT_FOUND` | sim | referência inexistente (após o TTL vira `REFERENCE_RESOLUTION_TIMEOUT`) |
| `REFERENCE_RESOLUTION_TIMEOUT` | sim | TTL de resolução estourado |
| `REFERENCE_KIND_NOT_REVERSIBLE` | sim | REFUND só reverte BET; ROLLBACK reverte BET/WIN/REFUND |
| `REFERENCE_ALREADY_REVERSED` | sim | a referência já foi revertida |
| `REFERENCE_AMOUNT_MISMATCH` | sim | valor da reversão ≠ valor da referência |
| `REFERENCE_SCOPE_MISMATCH` | sim | referência de outro player/wallet/moeda/rodada |
| `REFERENCE_NOT_APPLICABLE` | sim | a referência está REJECTED/FAILED (nunca será aplicada) |
| `INVALID_PAYLOAD` | sim | payload inválido (formato) |

Todos são **terminais**: o provedor deve corrigir o payload ou desistir. Nenhum
código pede reenvio automático — reenvios são para erros de infraestrutura
(HTTP 503), que não chegam a ser gravados.

### Interpretações adicionais adotadas (documentadas)

1. **Reversão de referência já revertida:** bloqueio para **qualquer** tipo de
   reversão (REFUND ou ROLLBACK), não só para o mesmo tipo. O enunciado proíbe
   "duas vezes pelo mesmo tipo"; o bloqueio mais forte evita creditar duas
   vezes a mesma aposta (REFUND + ROLLBACK sobre a mesma BET).
2. **ROLLBACK de um WIN** debita o valor do prêmio; se o jogador já gastou,
   a reversão é rejeitada com `REVERSAL_WOULD_NEGATIVE_BALANCE` (e a win
   original continua registrada no ledger — o ledger é imutável).
3. **`LOSS`** é `PROCESSED` (registra o resultado da rodada) e não gera
   lançamento nem altera o saldo.
4. **Replay idempotente** devolve o saldo **observado na época** da operação
   (colunas `observed_balance_*`), não o saldo atual da wallet.

---

## 5. Análise do cenário obrigatório (seção 8)

Saldo inicial 100.00; duas apostas de 80.00 simultâneas:

| Passo | Instância A | Instância B |
|---|---|---|
| 1 | `BEGIN` | `BEGIN` |
| 2 | `SELECT ... FOR UPDATE` na wallet → **trava🚦** | `SELECT ... FOR UPDATE` → **espera** |
| 3 | lê saldo 100.00, calcula 20.00, grava, `COMMIT` | — |
| 4 | — | trava liberada; lê saldo **20.00** (o que A commitou) |
| 5 | — | 20.00 < 80.00 → `REJECTED` / `INSUFFICIENT_FUNDS` |

Resultado: 1 `PROCESSED`, 1 `REJECTED`, saldo 20.00, exatamente 1 lançamento
`DEBIT`. O `CHECK (balance_amount >= 0)` é a rede de segurança final.

Como o lock é por linha, wallets diferentes nunca se bloqueiam entre si.

---

## 6. Recuperação após falhas

| Falha | O que acontece |
|---|---|
| processo morre **antes** do commit | nada foi gravado; a mensagem volta (visibility timeout) e é reprocessada |
| processo morre **depois** do commit, **antes** do ack | a transação está aplicada; na redelivery o `inbox` (ou a `UNIQUE (idempotency_key)`) impede o efeito duplicado e a mensagem é só ack'd |
| processo morre **depois** do commit, **antes** de publicar o evento | a linha da outbox continua pendente; outra instância (ou o restart) publica |
| publicação duplicada | o consumidor é idempotente (inbox + idempotency key) — evento duplicado é seguro |
| PostgreSQL indisponível | erro transivalente → HTTP 503, mensagem não é ack'd (volta para a fila) e vai para a DLQ após 5 tentativas |
| SQS indisponível | o app continua no ar; `/health/ready` reporta `degraded`; o publisher tenta de novo |

**Shutdown gracioso:** no `SIGTERM`, o Nest fecha o servidor HTTP e os workers
param de receber novas mensagens; as mensagens em andamento são concluídas
(quando possível) ou deixadas para a visibilidade expirar (aí o inbox/inbox
dedup garante o resultado).

---

## 7. Limitações conhecidas e o que ficou de fora

| Item | Situação |
|---|---|
| Autenticação | não implementada (aceito pelo enunciado); ponto de extensão explícito (§2.9) |
| Observabilidade | logs JSON + métricas em memória por instância; **sem** OpenTelemetry/dashboard |
| Testes com 3+ instâncias reais | **não executados** neste ambiente. Como eu faria: `docker compose up -d --build app` com `deploy.replicas: 3` (ou 3 processos apontando para o mesmo Postgres/LocalStack) e repetir os testes de concorrência; a correção não depende do número de instâncias porque o lock e as constraints vivem no banco. |
| Teste de carga | não implementado (diferencial opcional) |
| Ledger de partidas dobradas (double-entry) | não implementado (diferencial opcional) |
| Blue/green, canário, rate limiting | fora do escopo |
| Múltiplas moedas | o modelo é multi-moeda e o conflito de moeda é testado, mas o desafio assume BRL |
| SQS FIFO | usado para ordenação por wallet, mas **não** é a garantia de consistência — o banco é |
| `PENDING_REFERENCE` | janela fixa de ~21 minutos; em produção, o TTL deveria vir do provedor (SLA), não de um valor arbitrário |

---

## 8. Como eu evoluiria

1. **Autenticação real** com Keycloak/Zitadel: bearer + JWKS, e o `providerId`
   autenticado passa a ser conferido contra o `providerId` da mensagem.
2. **Métricas**: exporter para Prometheus/Pushgateway (hoje são por instância).
3. **Testes de 3+ instâncias** e **teste de carga** automatizados no compose.
4. **Ledger de partidas dobradas**: dois lançamentos por operação (débito em
   conta de jogo, crédito na wallet), habilitando conciliação por proveedor.
5. **Retry com jitter** no backoff da outbox e do worker de referência (hoje é
   determinístico).
