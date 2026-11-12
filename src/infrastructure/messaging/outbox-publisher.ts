import { rawExecute } from '../persistence/raw-sql';
/**
 * OutboxPublisher - publica os eventos pendentes da outbox no SQS.
 *
 * Garantias:
 *  - NADA é publicado antes do commit: o evento só existe na outbox depois
 *    que a transação financeira foi commitada;
 *  - se o processo morrer depois do commit e antes da publicação, outra
 *    instância (ou o restarted) assume e publica;
 *  - vários publishers concorrentes não se atropelam: cada um "reserva" um
 *    lote de linhas com `FOR UPDATE SKIP LOCKED` + lease (`locked_until`);
 *  - pode haver publicação DUPLICADA (processo morre entre o send e o
 *    `published_at`) - por isso os consumidores precisam ser idempotentes.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { MetricsService } from '../../shared/metrics';
import { QUEUE_EVENTS, SqsService } from './sqs.service';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  correlation_id: string;
}

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private failures = 0;
  private nextAttemptAt = 0;

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    const interval = Number(process.env['OUTBOX_POLL_INTERVAL_MS'] ?? 500);
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // Aguarda o ciclo em andamento para não deixar mensagem pela metade.
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;

    // Backoff simples quando o banco/SQS está fora: evita inundar o log.
    if (Date.now() < this.nextAttemptAt) return;

    this.running = true;
    try {
      const messages = await this.claimBatch();
      for (const message of messages) {
        await this.publish(message);
      }
      await this.updateLagMetric();
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      this.nextAttemptAt = Date.now() + Math.min(1000 * 2 ** this.failures, 30_000);
      // Loga o primeiro erro e depois a cada 10 falhas (evita spam).
      if (this.failures === 1 || this.failures % 10 === 0) {
        this.logger.warn(
          `outbox publisher tick failed (${this.failures}x): ${(error as Error).message}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  /** Reserva um lote de linhas para este publisher (SKIP LOCKED). */
  private async claimBatch(): Promise<OutboxRow[]> {
    const batchSize = Number(process.env['OUTBOX_BATCH_SIZE'] ?? 20);
    const leaseSeconds = Number(process.env['OUTBOX_LEASE_SECONDS'] ?? 30);

    return rawExecute<OutboxRow[]>(this.em, 
        `UPDATE outbox_messages
         SET locked_until = now() + (? || ' seconds')::interval,
             attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM outbox_messages
           WHERE published_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
             AND (locked_until IS NULL OR locked_until < now())
           ORDER BY occurred_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, aggregate_id, event_type, event_version, payload, occurred_at, attempts, correlation_id`,
        // A ordem dos parâmetros segue a ordem dos "?" na query:
        // primeiro o lease (SET), depois o tamanho do lote (LIMIT).
        [String(leaseSeconds), batchSize],
        'all',
      );
  }

  private async publish(message: OutboxRow): Promise<void> {
    try {
      await this.sqs.send(QUEUE_EVENTS, JSON.stringify(message.payload), {
        // FIFO por wallet: eventos da mesma wallet mantêm a ordem.
        groupId: message.aggregate_id,
        deduplicationId: message.id,
      });

      await rawExecute<unknown>(
        this.em,
        `UPDATE outbox_messages
           SET published_at = now(), locked_until = NULL
           WHERE id = ?`,
        [message.id],
        'run',
      );

      this.metrics.increment('outbox_published_total', { event_type: message.event_type });
    } catch (error) {
      this.metrics.increment('outbox_publish_failures_total', {
        event_type: message.event_type,
      });
      this.logger.error(
        `failed to publish outbox message ${message.id}: ${(error as Error).message}`,
      );

      // Backoff exponencial para a próxima tentativa.
      const attempts = message.attempts;
      const delaySeconds = Math.min(2 ** Math.max(0, attempts - 1), 300);
      await rawExecute<unknown>(
        this.em,
        `UPDATE outbox_messages
           SET next_attempt_at = now() + (? || ' seconds')::interval,
               locked_until = NULL
           WHERE id = ?`,
        [String(delaySeconds), message.id],
        'run',
      );
    }
  }

  /** Outbox lag: idade (em segundos) da mensagem pendente mais antiga. */
  private async updateLagMetric(): Promise<void> {
    const row = await rawExecute<{ lag: number | null }>(this.em, 
        `SELECT EXTRACT(EPOCH FROM (now() - MIN(occurred_at))) AS lag
         FROM outbox_messages
         WHERE published_at IS NULL`,
        [],
        'get',
      );
    this.metrics.setGauge('outbox_lag_seconds', Number(row?.lag ?? 0));
  }
}
