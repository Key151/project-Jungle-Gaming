-- =====================================================================
-- 001_init — schema inicial do "Distributed Wagering Processor"
--
-- Aqui mora parte importante das invariantes financeiras: as garantias de
-- unicidade, imutabilidade e não-negatividade são impostas pelo BANCO,
-- não apenas pelo código de aplicação.
-- =====================================================================

-- ---------------------------------------------------------------------
-- wallets: saldo materializado (atalho) + constraints de unicidade/não-negatividade
-- ---------------------------------------------------------------------
CREATE TABLE wallets (
  id              uuid           PRIMARY KEY,
  player_id       varchar(64)    NOT NULL,
  currency        varchar(3)     NOT NULL,
  balance_amount  numeric(18,2)  NOT NULL DEFAULT 0,
  version         integer        NOT NULL DEFAULT 1,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now(),

  -- no máximo uma wallet por (playerId, currency)
  CONSTRAINT wallets_player_id_currency_key UNIQUE (player_id, currency),
  -- o saldo nunca pode ficar negativo (última linha de defesa do lock pessimista)
  CONSTRAINT wallets_balance_non_negative CHECK (balance_amount >= 0),
  CONSTRAINT wallets_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE INDEX wallets_player_id_idx ON wallets (player_id);

-- ---------------------------------------------------------------------
-- wallet_ledger_entries: livro-razão append-only
-- ---------------------------------------------------------------------
CREATE TABLE wallet_ledger_entries (
  id              uuid           PRIMARY KEY,
  wallet_id       uuid           NOT NULL REFERENCES wallets (id),
  transaction_id  uuid           NOT NULL,
  direction       varchar(8)     NOT NULL,
  amount          numeric(18,2)  NOT NULL,
  currency        varchar(3)     NOT NULL,
  balance_before  numeric(18,2)  NOT NULL,
  balance_after   numeric(18,2)  NOT NULL,
  created_at      timestamptz    NOT NULL DEFAULT now(),

  -- uma transação financeira produz no máximo um lançamento por wallet
  CONSTRAINT wallet_ledger_entries_transaction_id_key UNIQUE (transaction_id),
  CONSTRAINT wallet_ledger_entries_direction_check CHECK (direction IN ('DEBIT', 'CREDIT')),
  CONSTRAINT wallet_ledger_entries_amount_non_negative CHECK (amount >= 0),
  -- a aritmética do lançamento é garantida pelo banco
  CONSTRAINT wallet_ledger_entries_balanced_check CHECK (
    (direction = 'DEBIT'  AND balance_after = balance_before - amount)
    OR
    (direction = 'CREDIT' AND balance_after = balance_before + amount)
  ),
  CONSTRAINT wallet_ledger_entries_balance_after_non_negative CHECK (balance_after >= 0)
);

CREATE INDEX wallet_ledger_entries_wallet_created_idx
  ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------
-- wager_transactions: a operação de aposta
-- ---------------------------------------------------------------------
CREATE TABLE wager_transactions (
  id                              uuid           PRIMARY KEY,
  provider_id                     varchar(64)    NOT NULL,
  external_transaction_id         varchar(128)   NOT NULL,
  idempotency_key                 varchar(255)   NOT NULL,
  payload_hash                    varchar(64)    NOT NULL,
  wallet_id                       uuid           NOT NULL,
  player_id                       varchar(64)    NOT NULL,
  round_id                        varchar(64)    NOT NULL,
  game_id                         varchar(64)    NOT NULL,
  kind                            varchar(16)    NOT NULL,
  amount                          numeric(18,2)  NOT NULL,
  currency                        varchar(3)     NOT NULL,
  reference_external_transaction_id varchar(128),
  reference_transaction_id        uuid           REFERENCES wager_transactions (id),
  status                          varchar(24)    NOT NULL,
  failure_code                    varchar(64),
  attempts                        integer        NOT NULL DEFAULT 0,
  next_attempt_at                 timestamptz,
  processed_at                    timestamptz,
  observed_balance_amount         numeric(18,2),
  observed_balance_currency       varchar(3),
  source                          varchar(16)    NOT NULL,
  correlation_id                  varchar(64)    NOT NULL,
  created_at                      timestamptz    NOT NULL DEFAULT now(),

  -- FONTE DA VERDADE DA IDEMPOTÊNCIA: a constraint do banco, não memória
  CONSTRAINT wager_transactions_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT wager_transactions_provider_external_key UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wager_transactions_kind_check
    CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
  CONSTRAINT wager_transactions_status_check
    CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
  CONSTRAINT wager_transactions_amount_non_negative CHECK (amount >= 0),
  -- REFUND e ROLLBACK sempre exigem referência
  CONSTRAINT wager_transactions_reference_required CHECK (
    kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL
  )
);

CREATE INDEX wager_transactions_status_next_attempt_idx
  ON wager_transactions (status, next_attempt_at);

-- Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.
-- (A checagem "já revertida por qualquer tipo" é feita na aplicação; aqui
-- garantimos o mínimo no banco, como defense in depth.)
CREATE UNIQUE INDEX wager_transactions_reversal_unique
  ON wager_transactions (reference_transaction_id, kind)
  WHERE reference_transaction_id IS NOT NULL
    AND kind IN ('REFUND', 'ROLLBACK')
    AND status = 'PROCESSED';

-- ---------------------------------------------------------------------
-- inbox_messages: deduplicação persistente das mensagens consumidas
-- ---------------------------------------------------------------------
CREATE TABLE inbox_messages (
  id            uuid          PRIMARY KEY,
  consumer_name varchar(128)  NOT NULL,
  message_id    varchar(128)  NOT NULL,
  payload_hash  varchar(64)   NOT NULL,
  received_at   timestamptz   NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  attempts      integer       NOT NULL DEFAULT 0,
  last_error    text,

  CONSTRAINT inbox_messages_consumer_message_key UNIQUE (consumer_name, message_id)
);

-- ---------------------------------------------------------------------
-- outbox_messages: eventos de integração aguardando publicação
-- ---------------------------------------------------------------------
CREATE TABLE outbox_messages (
  id             uuid          PRIMARY KEY,
  aggregate_id   varchar(64)   NOT NULL,
  event_type     varchar(64)   NOT NULL,
  event_version  integer       NOT NULL,
  payload        jsonb         NOT NULL,
  occurred_at    timestamptz   NOT NULL DEFAULT now(),
  attempts       integer       NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  published_at   timestamptz,
  locked_until   timestamptz,
  correlation_id varchar(64)   NOT NULL
);

CREATE INDEX outbox_messages_pending_idx
  ON outbox_messages (next_attempt_at, occurred_at)
  WHERE published_at IS NULL;

-- ---------------------------------------------------------------------
-- Imutabilidade do ledger: trigger que bloqueia UPDATE e DELETE.
-- "Não sobrescrever nem excluir lançamentos do ledger" é lei do banco.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_wallet_ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
