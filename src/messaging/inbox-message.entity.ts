import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

/**
 * Tabela `inbox_messages` - deduplicação persistente das mensagens
 * consumidas da fila.
 *
 * UNIQUE (consumer_name, message_id): se a mesma mensagem chegar duas vezes
 * (at-least-once), a segunda inserção é recusada pelo banco e o consumidor
 * apenas dá ack, sem reprocessar. Nada de cache em memória.
 */
@Entity({ tableName: 'inbox_messages' })
@Unique({ properties: ['consumerName', 'messageId'] })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 128 })
  consumerName!: string;

  @Property({ type: 'string', length: 128 })
  messageId!: string;

  @Property({ type: 'string', length: 64 })
  payloadHash!: string;

  @Property({ type: 'datetime' })
  receivedAt!: Date;

  @Property({ type: 'datetime', nullable: true })
  processedAt!: Date | null;

  @Property({ type: 'int', default: 0 })
  attempts!: number;

  @Property({ type: 'text', nullable: true })
  lastError!: string | null;
}
