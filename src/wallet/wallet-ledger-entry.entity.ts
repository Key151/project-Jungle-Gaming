import { DecimalType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * Tabela `wallet_ledger_entries` - livro-razão da wallet.
 *
 * Append-only: uma trigger no banco bloqueia UPDATE e DELETE (ver
 * migrations/001_init.up.sql). Uma transação financeira produz no máximo
 * um lançamento (UNIQUE em transaction_id).
 */
@Entity({ tableName: 'wallet_ledger_entries' })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 64 })
  walletId!: string;

  @Property({ type: 'string', length: 64 })
  transactionId!: string;

  /** DEBIT | CREDIT */
  @Property({ type: 'string', length: 8 })
  direction!: string;

  @Property({ type: DecimalType, precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: DecimalType, precision: 18, scale: 2 })
  balanceBefore!: string;

  @Property({ type: DecimalType, precision: 18, scale: 2 })
  balanceAfter!: string;

  @Property({ type: 'datetime' })
  createdAt!: Date;
}
