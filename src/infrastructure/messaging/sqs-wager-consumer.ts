import { rawExecute } from '../persistence/raw-sql';
/**
 * SqsWagerConsumer - consome `wager-transactions.fifo`.
 *
 * Regras:
 *  - reutiliza o MESMO use case da entrada HTTP;
 *  - deduplica via inbox persistente por (consumerName, messageId);
 *  - dá ack (delete) SOMENTE depois do commit;
 *  - erro de negócio (terminal) dá ack; erro transitório devolve a
 *    visibilidade (retry com backoff); erro permanente vai para a DLQ;
 *  - no SIGTERM, termina as mensagens em andamento ou devolve a visibilidade.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { Money } from '../../domain/money';
import { WagerTransactionKind } from '../../domain/wager-transaction';
import { MetricsService } from '../../shared/metrics';
import { newCorrelationId } from '../../shared/correlation';
import { hashPayload } from '../../shared/payload-hash';
import { PermanentMessageError } from '../../application/errors';
import {
  businessPayload,
  WagerTransactionProcessor,
} from '../../application/wagering/wager-transaction.processor';
import { SubmitWagerTransactionCommand } from '../../application/wagering/wagering.types';
import { QUEUE_TRANSACTIONS, QUEUE_TRANSACTIONS_DLQ, SqsMessage, SqsService } from './sqs.service';

const CONSUMER_NAME = 'wager-transactions-consumer';

interface WagerMessageEnvelope {
  messageId?: string;
  type?: string;
  occurredAt?: string;
  data?: {
    providerId?: string;
    externalTransactionId?: string;
    idempotencyKey?: string;
    playerId?: string;
    walletId?: string;
    roundId?: string;
    gameId?: string;
    kind?: string;
    money?: { amount?: string; currency?: string };
    referenceExternalTransactionId?: string;
  };
}

@Injectable()
export class SqsWagerConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private running = false;
  private stopped = false;
  private failures = 0;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsService,
    private readonly processor: WagerTransactionProcessor,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.running = true;
    void this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.running = false;
    // Aguarda as mensagens em andamento (graceful shutdown).
    await Promise.allSettled([...this.inFlight]);
  }

  private async loop(): Promise<void> {
    while (this.running && !this.stopped) {
      try {
        const messages = await this.sqs.receive(QUEUE_TRANSACTIONS, 10, 20);
        if (messages.length === 0) continue;

        const tasks = messages.map((message) => {
          const task = this.handle(message).finally(() => this.inFlight.delete(task));
          this.inFlight.add(task);
          return task;
        });
        await Promise.allSettled(tasks);
      } catch (error) {
        if (this.stopped) break;
        this.failures += 1;
        if (this.failures === 1 || this.failures % 10 === 0) {
          this.logger.warn(
            `sqs consumer loop error (${this.failures}x): ${(error as Error).message}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  private async handle(message: SqsMessage): Promise<void> {
    let envelope: WagerMessageEnvelope;
    try {
      envelope = JSON.parse(message.body) as WagerMessageEnvelope;
    } catch {
      this.logger.error('invalid message body (not json) - moving to DLQ');
      await this.moveToDlq(message, 'invalid json body');
      return;
    }

    let command: SubmitWagerTransactionCommand;
    try {
      command = this.toCommand(envelope, message);
    } catch (error) {
      this.logger.error(`invalid message payload - moving to DLQ: ${(error as Error).message}`);
      await this.moveToDlq(message, (error as Error).message);
      return;
    }

    const logicalMessageId = envelope.messageId ?? message.messageId;

    try {
      const outcome = await this.em.fork({ clear: true }).transactional(async (tx) => {
        // ---- INBOX: dedup persistente, na MESMA transação do resto ----
        const inserted = await rawExecute<{ id: string }[]>(tx,
            `INSERT INTO inbox_messages (id, consumer_name, message_id, payload_hash, received_at, processed_at, attempts, last_error)
             VALUES (gen_random_uuid(), ?, ?, ?, now(), NULL, 0, NULL)
             ON CONFLICT (consumer_name, message_id) DO NOTHING
             RETURNING id`,
            [CONSUMER_NAME, logicalMessageId, hashPayload(businessPayload(command))],
            'all',
          );

        if (inserted.length === 0) {
          // Mensagem já vista: se já foi processada, é duplicata pura.
          const existing = await rawExecute<{ processed_at: Date | null }>(tx, 
              `SELECT processed_at FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`,
              [CONSUMER_NAME, logicalMessageId],
              'get',
            );

          if (existing?.processed_at) {
            return { duplicate: true, status: 'DUPLICATE' };
          }
          // Já tentamos antes e falhou (a tentativa anterior foi revertida):
          // tenta de novo.
        }

        // ---- mesmo use case da entrada HTTP ----
        const result = await this.processor.process(tx, command);

        await rawExecute<unknown>(
          tx,
          `UPDATE inbox_messages
             SET processed_at = now(), attempts = attempts + 1, last_error = NULL
             WHERE consumer_name = ? AND message_id = ?`,
          [CONSUMER_NAME, logicalMessageId],
          'run',
        );

        return { duplicate: false, status: result.status };
      });

      if (outcome.duplicate) {
        this.metrics.increment('inbox_duplicates_total', { consumer: CONSUMER_NAME });
      }

      // ---- ACK só depois do commit ----
      await this.sqs.delete(QUEUE_TRANSACTIONS, message.receiptHandle);
    } catch (error) {
      // Erro transitório de infraestrutura: NÃO damos ack. A visibilidade
      // expira, a mensagem volta, e a redrive policy a manda para a DLQ
      // depois de MAX_RECEIVE_COUNT tentativas.
      this.metrics.increment('sqs_retries_total', { consumer: CONSUMER_NAME });
      this.logger.error(
        `transient failure while processing message ${logicalMessageId}: ${(error as Error).message}`,
      );
      await this.registerAttempt(logicalMessageId, (error as Error).message);
    }
  }

  private toCommand(
    envelope: WagerMessageEnvelope,
    message: SqsMessage,
  ): SubmitWagerTransactionCommand {
    const data = envelope.data;
    if (!data) throw new PermanentMessageError('message envelope has no data');

    const required: [string, unknown][] = [
      ['providerId', data.providerId],
      ['externalTransactionId', data.externalTransactionId],
      ['idempotencyKey', data.idempotencyKey],
      ['playerId', data.playerId],
      ['walletId', data.walletId],
      ['roundId', data.roundId],
      ['gameId', data.gameId],
      ['kind', data.kind],
      ['money.amount', data.money?.amount],
      ['money.currency', data.money?.currency],
    ];
    for (const [field, value] of required) {
      if (value === undefined || value === null || value === '') {
        throw new PermanentMessageError(`missing field: ${field}`);
      }
    }

    const kind = data.kind as WagerTransactionKind;
    if (!Object.values(WagerTransactionKind).includes(kind)) {
      throw new PermanentMessageError(`unknown kind: ${data.kind}`);
    }
    if (kind === WagerTransactionKind.Opening) {
      // OPENING é interno: não entra pela fila.
      throw new PermanentMessageError('OPENING cannot be submitted through the queue');
    }

    // Valida o dinheiro no domínio (moeda, escala, sinal).
    const money = Money.from({
      amount: data.money!.amount as string,
      currency: data.money!.currency as string,
    });

    return {
      providerId: data.providerId as string,
      externalTransactionId: data.externalTransactionId as string,
      idempotencyKey: data.idempotencyKey as string,
      playerId: data.playerId as string,
      walletId: data.walletId as string,
      roundId: data.roundId as string,
      gameId: data.gameId as string,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId: data.referenceExternalTransactionId,
      source: 'SQS',
      correlationId: newCorrelationId(),
    };
  }

  /** Registra a tentativa falha (transação separada: a anterior foi rollback). */
  private async registerAttempt(messageId: string, error: string): Promise<void> {
    try {
      await rawExecute<unknown>(
        this.em,
        `UPDATE inbox_messages
           SET attempts = attempts + 1, last_error = ?
           WHERE consumer_name = ? AND message_id = ?`,
        [error.slice(0, 2000), CONSUMER_NAME, messageId],
        'run',
      );
    } catch {
      // best effort
    }
  }

  /** Erro permanente: manda para a DLQ e tira da fila principal. */
  private async moveToDlq(message: SqsMessage, reason: string): Promise<void> {
    this.metrics.increment('sqs_dlq_total', { consumer: CONSUMER_NAME });
    try {
      await this.sqs.send(QUEUE_TRANSACTIONS_DLQ, message.body, {
        groupId: 'dlq',
        deduplicationId: `${message.messageId}-dlq`,
      });
    } catch (error) {
      this.logger.error(`could not move message to DLQ: ${(error as Error).message}`);
    }
    try {
      await this.sqs.delete(QUEUE_TRANSACTIONS, message.receiptHandle);
    } catch (error) {
      this.logger.error(`could not delete message after DLQ move: ${(error as Error).message}`);
    }
  }
}
