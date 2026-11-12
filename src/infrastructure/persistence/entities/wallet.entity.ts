import { DecimalType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * Tabela `wallets`.
 *
 * O saldo materializado (`balance_amount`) é o "atalho"; a verdade é o ledger.
 * As constraints que garantem as invariantes financeiras ficam no schema
 * (ver migrations/001_init.up.sql):
 *   - UNIQUE (player_id, currency)
 *   - CHECK (balance_amount >= 0)
 */
@Entity({ tableName: 'wallets' })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 64 })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  /** NUMERIC(18,2) mapeado como string - nunca number. */
  @Property({ type: DecimalType, precision: 18, scale: 2 })
  balanceAmount!: string;

  /** Optimistic-locking / auditoria de mudanças de saldo. */
  @Property({ type: 'int' })
  version!: number;

  @Property({ type: 'datetime' })
  createdAt!: Date;

  @Property({ type: 'datetime' })
  updatedAt!: Date;
}
