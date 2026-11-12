import { DecimalType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

/**
 * Tabela `wager_transactions` - a operação de aposta e seu estado.
 *
 * `idempotency_key` tem UNIQUE no banco: é a fonte da verdade da
 * idempotência (nunca memória). `payload_hash` permite detectar "mesma key,
 * payload diferente" (conflito, não replay).
 */
@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 64 })
  providerId!: string;

  @Property({ type: 'string', length: 128 })
  externalTransactionId!: string;

  @Unique()
  @Property({ type: 'string', length: 255 })
  idempotencyKey!: string;

  @Property({ type: 'string', length: 64 })
  payloadHash!: string;

  @Property({ type: 'string', length: 64 })
  walletId!: string;

  @Property({ type: 'string', length: 64 })
  playerId!: string;

  @Property({ type: 'string', length: 64 })
  roundId!: string;

  @Property({ type: 'string', length: 64 })
  gameId!: string;

  /** BET | WIN | LOSS | REFUND | ROLLBACK | OPENING */
  @Property({ type: 'string', length: 16 })
  kind!: string;

  @Property({ type: DecimalType, precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  /** Id externo no provedor da transação referenciada (não o id interno). */
  @Property({ type: 'string', length: 128, nullable: true })
  referenceExternalTransactionId!: string | null;

  /** Id interno da transação referenciada. */
  @Property({ type: 'string', length: 64, nullable: true })
  referenceTransactionId!: string | null;

  /** PENDING | PENDING_REFERENCE | PROCESSED | REJECTED | FAILED */
  @Property({ type: 'string', length: 24 })
  status!: string;

  @Property({ type: 'string', length: 64, nullable: true })
  failureCode!: string | null;

  /** Tentativas de resolução de referência (backoff). */
  @Property({ type: 'int', default: 0 })
  attempts!: number;

  @Property({ type: 'datetime', nullable: true })
  nextAttemptAt!: Date | null;

  @Property({ type: 'datetime', nullable: true })
  processedAt!: Date | null;

  /** Saldo observado no momento da resolução - devolve no replay idempotente. */
  @Property({ type: DecimalType, precision: 18, scale: 2, nullable: true })
  observedBalanceAmount!: string | null;

  @Property({ type: 'string', length: 3, nullable: true })
  observedBalanceCurrency!: string | null;

  /** HTTP | SQS | INTERNAL */
  @Property({ type: 'string', length: 16 })
  source!: string;

  @Property({ type: 'string', length: 64 })
  correlationId!: string;

  @Property({ type: 'datetime' })
  createdAt!: Date;
}
