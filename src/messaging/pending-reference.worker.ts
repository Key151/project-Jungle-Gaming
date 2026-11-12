/**
 * PendingReferenceWorker - reprocessa as transações que ficaram
 * PENDING_REFERENCE (a referência chegou depois da operação).
 *
 * Backoff exponencial (5s, 10s, 20s, ... 300s) com limite de 10 tentativas
 * (~21 minutos). Ao estourar, a transação vira REJECTED com
 * REFERENCE_RESOLUTION_TIMEOUT.
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { rawExecute } from '../db/raw-sql';
import { Money } from '../common/money';
import { MetricsService } from '../common/metrics';
import { AppLogger } from '../common/logger';
import { newId } from '../common/ids';
import { WagerTransactionKind } from '../wagering/wager-transaction';
import {
  MAX_REFERENCE_ATTEMPTS,
  SubmitWagerTransactionCommand,
  WagerTransactionRow,
  WAGER_TRANSACTION_COLUMNS,
  WageringService,
} from '../wagering/wager-transaction.service';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new AppLogger('PendingReferenceWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private failures = 0;

  constructor(
    private readonly em: EntityManager,
    private readonly wagering: WageringService,
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
      const rows = await rawExecute<WagerTransactionRow[]>(
        this.em,
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
      // Loga o primeiro erro e depois a cada 10 (evita spam).
      if (this.failures === 1 || this.failures % 10 === 0) {
        this.logger.warn(`worker error (${this.failures}x): ${(error as Error).message}`);
      }
    } finally {
      this.running = false;
    }
  }

  private async reprocess(row: WagerTransactionRow): Promise<void> {
    // Monta o comando de novo a partir da linha do banco.
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
      correlationId: newId(),
    };

    try {
      const outcome = await this.em.fork({ clear: true }).transactional(async (tx) => {
        return this.wagering.process(tx, command);
      });

      this.metrics.increment('pending_reference_reprocessed_total', {
        status: outcome.status,
      });
    } catch (error) {
      this.logger.error(
        `falha ao reprocessar ${row.id}: ${(error as Error).message}`,
      );
    }
  }
}
