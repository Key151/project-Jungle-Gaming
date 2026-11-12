import { rawExecute } from '../persistence/raw-sql';
/**
 * PendingReferenceWorker - reprocessa transações que ficaram
 * PENDING_REFERENCE (a referência chegou depois da operação).
 *
 * Backoff exponencial (5s, 10s, 20s, ... 300s) com limite de 10 tentativas
 * (~ 21 minutos). Ao estourar, a transação vira REJECTED com
 * REFERENCE_RESOLUTION_TIMEOUT e o evento correspondente é publicado.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { Money } from '../../domain/money';
import { WagerTransactionKind } from '../../domain/wager-transaction';
import { MetricsService } from '../../shared/metrics';
import { newCorrelationId } from '../../shared/correlation';
import {
  MAX_REFERENCE_ATTEMPTS,
  WagerTransactionProcessor,
} from '../../application/wagering/wager-transaction.processor';
import { SubmitWagerTransactionCommand } from '../../application/wagering/wagering.types';
import { WAGER_TRANSACTION_COLUMNS, WagerTransactionRow } from '../../application/wagering/wager-transaction.mapper';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private failures = 0;

  constructor(
    private readonly em: EntityManager,
    private readonly processor: WagerTransactionProcessor,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    const interval = Number(process.env['PENDING_REFERENCE_INTERVAL_MS'] ?? 5000);
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const rows = await rawExecute<WagerTransactionRow[]>(this.em, 
          `SELECT ${WAGER_TRANSACTION_COLUMNS}
           FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE'
             AND attempts < ?
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY next_attempt_at
           LIMIT 50`,
          [MAX_REFERENCE_ATTEMPTS],
          'all',
        );

      for (const row of rows) {
        await this.reprocess(row);
      }
    } catch (error) {
      this.failures += 1;
      if (this.failures === 1 || this.failures % 10 === 0) {
        this.logger.warn(
          `pending reference worker error (${this.failures}x): ${(error as Error).message}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async reprocess(row: WagerTransactionRow): Promise<void> {
    const command: SubmitWagerTransactionCommand = {
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      playerId: row.player_id,
      walletId: row.wallet_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind as WagerTransactionKind,
      money: Money.from({ amount: row.amount, currency: row.currency }).toJSON(),
      referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
      source: 'INTERNAL',
      correlationId: newCorrelationId(),
    };

    try {
      const outcome = await this.em.fork({ clear: true }).transactional(async (tx) => {
        return this.processor.process(tx, command);
      });
      this.metrics.increment('pending_reference_reprocessed_total', {
        status: outcome.status,
      });
    } catch (error) {
      this.logger.error(
        `failed to reprocess pending reference ${row.id}: ${(error as Error).message}`,
      );
    }
  }
}
