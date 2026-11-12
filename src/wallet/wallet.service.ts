import { rawExecute } from '../db/raw-sql';
/**
 * WalletService - criação de wallet e consultas de leitura.
 *
 * A criação de wallet grava, NA MESMA transação SQL:
 *   - a wallet (saldo materializado);
 *   - a transação interna OPENING (se o saldo inicial > 0);
 *   - o lançamento CREDIT correspondente no ledger.
 */
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { newId } from '../common/ids';
import { MetricsService } from '../common/metrics';
import { Money, MoneyProps } from '../common/money';
import { Wallet } from './wallet';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';
import { WagerTransaction, WagerTransactionKind } from '../wagering/wager-transaction';
import { WalletEntity } from './wallet.entity';
import { WalletLedgerEntryEntity } from './wallet-ledger-entry.entity';
import { DuplicateWalletError, EntityNotFoundError } from '../common/errors';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletResult {
  wallet: Wallet;
  openingTransaction?: WagerTransaction;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export interface LedgerPage {
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

interface LedgerRow {
  id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class WalletService {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
  ) {}

  async create(input: CreateWalletInput): Promise<CreateWalletResult> {
    const money = Money.from(input.initialBalance);

    try {
      return await this.em.fork({ clear: true }).transactional(async (tx) => {
        const existing = await tx.findOne(WalletEntity, {
          playerId: input.playerId,
          currency: money.currency,
        });
        if (existing) {
          throw new DuplicateWalletError(input.playerId, money.currency);
        }

        const now = new Date();
        const wallet = Wallet.open({
          id: newId(),
          playerId: input.playerId,
          initialBalance: money,
          at: now,
        });

        const walletEntity = new WalletEntity();
        walletEntity.id = wallet.id;
        walletEntity.playerId = wallet.playerId;
        walletEntity.currency = wallet.currency;
        walletEntity.balanceAmount = wallet.balance.amount;
        walletEntity.version = wallet.version;
        walletEntity.createdAt = wallet.createdAt;
        walletEntity.updatedAt = wallet.updatedAt;
        tx.persist(walletEntity);

        let openingTransaction: WagerTransaction | undefined;

        if (money.isPositive()) {
          // Transação interna OPENING: registra a origem do saldo.
          openingTransaction = WagerTransaction.create({
            id: newId(),
            providerId: 'internal',
            externalTransactionId: `opening-${wallet.id}`,
            idempotencyKey: `internal:opening:${wallet.id}`,
            payloadHash: 'internal',
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'opening',
            gameId: 'opening',
            kind: WagerTransactionKind.Opening,
            money,
            source: 'INTERNAL',
            correlationId: 'internal',
            at: now,
          });
          openingTransaction.markProcessed(undefined, now);
          openingTransaction.setObservedBalance(wallet.balance);

          await this.insertOpeningTransaction(tx, openingTransaction);

          // Lançamento CREDIT de abertura: balanceBefore 0.00 -> balanceAfter.
          const entry = WalletLedgerEntry.create({
            id: newId(),
            walletId: wallet.id,
            transactionId: openingTransaction.id,
            direction: LedgerDirection.Credit,
            money,
            balanceBefore: Money.zero(money.currency),
            createdAt: now,
          });

          const ledgerEntity = new WalletLedgerEntryEntity();
          ledgerEntity.id = entry.id;
          ledgerEntity.walletId = entry.walletId;
          ledgerEntity.transactionId = entry.transactionId;
          ledgerEntity.direction = entry.direction;
          ledgerEntity.amount = entry.money.amount;
          ledgerEntity.currency = entry.money.currency;
          ledgerEntity.balanceBefore = entry.balanceBefore.amount;
          ledgerEntity.balanceAfter = entry.balanceAfter.amount;
          ledgerEntity.createdAt = entry.createdAt;
          tx.persist(ledgerEntity);
        }

        await tx.flush();

        this.metrics.increment('wallets_created_total', { currency: money.currency });

        return { wallet, openingTransaction };
      });
    } catch (error) {
      // Corrida de criação: a UNIQUE(player_id, currency) do banco decide.
      if (isUniqueViolation(error)) {
        throw new DuplicateWalletError(input.playerId, money.currency);
      }
      throw error;
    }
  }

  async findById(walletId: string): Promise<Wallet> {
    const entity = await this.em.fork({ clear: true }).findOne(WalletEntity, walletId);
    if (!entity) {
      throw new EntityNotFoundError('wallet', walletId);
    }
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balanceAmount: entity.balanceAmount,
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  /**
   * Ledger da wallet com paginação por cursor opaco e estável (keyset:
   * ordered by created_at DESC, id DESC).
   */
  async listLedger(walletId: string, cursor?: string, limit = 50): Promise<LedgerPage> {
    const wallet = await this.findById(walletId);
    const safeLimit = Math.min(Math.max(limit, 1), 200);

    const params: unknown[] = [walletId];
    let where = 'wallet_id = ?';
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        params.push(decoded.createdAt, decoded.id);
        // A ordem dos params segue a ordem dos "?" na query.
        where += ' AND (created_at, id) < (?, ?)';
      }
    }
    params.push(safeLimit + 1);

    const rows = await rawExecute<LedgerRow[]>(
      this.em,
      `SELECT id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
         FROM wallet_ledger_entries
         WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      params,
      'all',
    );

    const hasMore = rows.length > safeLimit;
    const page = hasMore ? rows.slice(0, safeLimit) : rows;

    const entries: LedgerEntryView[] = page.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      direction: row.direction as LedgerDirection,
      amount: { amount: row.amount, currency: row.currency },
      balanceBefore: { amount: row.balance_before, currency: row.currency },
      balanceAfter: { amount: row.balance_after, currency: row.currency },
      createdAt: row.created_at,
    }));

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.created_at, last.id) : null;

    return { entries, nextCursor };
  }

  /**
   * Reconciliação: recalcula o saldo a partir do ledger e compara com o
   * saldo materializado. Divergências NÃO são corrigidas silenciosamente:
   * são logadas, contabilizadas em métrica e devolvidas na resposta.
   */
  async reconcile(walletId: string): Promise<ReconciliationReport> {
    const wallet = await this.findById(walletId);

    const rows = await rawExecute<{ calculated: string; checked: number; currency: string }>(this.em, 
        `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN -amount ELSE amount END), 0) AS calculated,
                COUNT(*) AS checked,
                MIN(currency) AS currency
         FROM wallet_ledger_entries
         WHERE wallet_id = ?`,
        [walletId],
        'get',
      );

    const calculated = Money.from({
      amount: rows?.calculated ?? '0.00',
      currency: rows?.currency ?? wallet.currency,
    });
    const difference = wallet.balance.subtract(calculated);
    const consistent = difference.isZero();

    if (!consistent) {
      this.metrics.increment('reconciliation_divergences_total', { currency: wallet.currency });
    }

    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: Number(rows?.checked ?? 0),
    };
  }

  private async insertOpeningTransaction(
    em: EntityManager,
    transaction: WagerTransaction,
  ): Promise<void> {
    await rawExecute<unknown>(
      em,
      `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency,
           reference_external_transaction_id, reference_transaction_id, status,
           failure_code, attempts, next_attempt_at, processed_at,
           observed_balance_amount, observed_balance_currency, source,
           correlation_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
                   'PROCESSED', NULL, 0, NULL, ?, ?, ?, 'INTERNAL', ?, ?)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          transaction.id,
          transaction.providerId,
          transaction.externalTransactionId,
          transaction.idempotencyKey,
          transaction.payloadHash,
          transaction.walletId,
          transaction.playerId,
          transaction.roundId,
          transaction.gameId,
          transaction.kind,
          transaction.money.amount,
          transaction.money.currency,
          transaction.processedAt,
          transaction.observedBalance?.amount ?? null,
          transaction.observedBalance?.currency ?? null,
          transaction.correlationId,
          transaction.createdAt,
        ],
        'run',
      );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  );
}

interface DecodedCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [createdAt, id] = raw.split('|');
    if (!createdAt || !id) return null;
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return null;
    return { createdAt: date, id };
  } catch {
    return null;
  }
}
