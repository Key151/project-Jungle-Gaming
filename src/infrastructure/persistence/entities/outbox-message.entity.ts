import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * Tabela `outbox_messages` - eventos de integração aguardando publicação.
 *
 * A linha é gravada NA MESMA transação SQL que altera o saldo (nunca antes
 * do commit). Um publisher separado lê as linhas pendentes e publica no SQS.
 */
@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  /** Aggregate que originou o evento (normalmente a wallet). */
  @Property({ type: 'string', length: 64 })
  aggregateId!: string;

  @Property({ type: 'string', length: 64 })
  eventType!: string;

  @Property({ type: 'int' })
  eventVersion!: number;

  /** Envelope completo do IntegrationEvent já serializado. */
  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ type: 'datetime' })
  occurredAt!: Date;

  @Property({ type: 'int', default: 0 })
  attempts!: number;

  @Property({ type: 'datetime', nullable: true })
  nextAttemptAt!: Date | null;

  @Property({ type: 'datetime', nullable: true })
  publishedAt!: Date | null;

  /** Lease: impede que dois publishers peguem a mesma linha ao mesmo tempo. */
  @Property({ type: 'datetime', nullable: true })
  lockedUntil!: Date | null;

  @Property({ type: 'string', length: 64 })
  correlationId!: string;
}
