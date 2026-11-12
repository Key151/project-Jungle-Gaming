/**
 * SqsService — cliente SQS (AWS SDK v3) apontando para LocalStack/MiniStack
 * em desenvolvimento e para a AWS em produção.
 *
 * As filas são criadas de forma idempotente no boot: o `docker compose` não
 * precisa de script de inicialização e a configuração fica versionada no
 * código.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  CreateQueueCommand,
  SetQueueAttributesCommand,
  QueueAttributeName,
} from '@aws-sdk/client-sqs';

export const QUEUE_TRANSACTIONS = 'wager-transactions.fifo';
export const QUEUE_TRANSACTIONS_DLQ = 'wager-transactions-dlq.fifo';
export const QUEUE_EVENTS = 'wager-events.fifo';
export const QUEUE_EVENTS_DLQ = 'wager-events-dlq.fifo';

/** Quantas vezes uma mensagem é entregue antes de ir para a DLQ. */
export const MAX_RECEIVE_COUNT = 5;

export interface SqsMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes?: Record<string, string>;
}

@Injectable()
export class SqsService implements OnModuleInit {
  private readonly logger = new Logger(SqsService.name);
  private readonly client: SQSClient;
  private readonly queueUrls = new Map<string, string>();
  private retryTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.client = new SQSClient({
      region: process.env['AWS_REGION'] ?? 'us-east-1',
      endpoint: process.env['SQS_ENDPOINT'] ?? 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
        secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
      },
    });
  }

  async onModuleInit(): Promise<void> {
    // O SQS pode estar indisponível no boot (LocalStack subindo, rede
    // instável). Isso NÃO pode derrubar o processo: o app sobe, o
    // /health/ready reporta "degraded" e tentamos de novo em background.
    this.tryEnsureQueues();
    this.retryTimer = setInterval(() => this.tryEnsureQueues(), 10_000);
    this.retryTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  private tryEnsureQueues(): void {
    this.ensureQueues().catch((error) => {
      this.logger.warn(
        `could not prepare SQS queues yet: ${(error as Error).message}`,
      );
    });
  }

  /** Cria as filas (idempotente) com a redrive policy para a DLQ. */
  async ensureQueues(): Promise<void> {
    await this.ensureFifoQueue(QUEUE_TRANSACTIONS_DLQ);
    await this.ensureFifoQueue(QUEUE_EVENTS_DLQ);

    await this.ensureFifoQueue(QUEUE_TRANSACTIONS, QUEUE_TRANSACTIONS_DLQ);
    await this.ensureFifoQueue(QUEUE_EVENTS, QUEUE_EVENTS_DLQ);
  }

  private async ensureFifoQueue(name: string, redriveSource?: string): Promise<void> {
    const url = await this.queueUrl(name);
    if (!redriveSource) return;

    const dlqUrl = await this.queueUrl(redriveSource);
    const dlqArn = await this.queueArn(dlqUrl);
    if (!dlqArn) return;

    await this.client.send(
      new SetQueueAttributesCommand({
        QueueUrl: url,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: MAX_RECEIVE_COUNT,
          }),
        },
      }),
    );
  }

  async queueUrl(name: string): Promise<string> {
    const cached = this.queueUrls.get(name);
    if (cached) return cached;

    const created = await this.client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '30',
          MessageRetentionPeriod: '1209600',
        },
      }),
    );
    if (!created.QueueUrl) throw new Error(`could not create queue ${name}`);
    this.queueUrls.set(name, created.QueueUrl);
    this.logger.log(`SQS queue ready: ${name}`);
    return created.QueueUrl;
  }

  private async queueArn(queueUrl: string): Promise<string | undefined> {
    const response = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [QueueAttributeName.QueueArn],
      }),
    );
    return response.Attributes?.[QueueAttributeName.QueueArn];
  }

  async send(
    queueName: string,
    body: string,
    options?: { groupId?: string; deduplicationId?: string },
  ): Promise<void> {
    const queueUrl = await this.queueUrl(queueName);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        // FIFO: mensagens do mesmo grupo são entregues em ordem.
        MessageGroupId: options?.groupId ?? 'default',
        // Deduplicação por 5 minutos: duas publicações do MESMO evento não
        // viram duas mensagens. Publicações de eventos diferentes têm ids
        // diferentes.
        MessageDeduplicationId: options?.deduplicationId,
      }),
    );
  }

  async receive(
    queueName: string,
    maxMessages = 10,
    waitTimeSeconds = 20,
  ): Promise<SqsMessage[]> {
    const queueUrl = await this.queueUrl(queueName);
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: 30,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['MessageGroupId'],
      }),
    );

    return (response.Messages ?? []).map((message) => ({
      messageId: message.MessageId ?? 'unknown',
      receiptHandle: message.ReceiptHandle ?? '',
      body: message.Body ?? '',
      attributes: {
        ...(message.Attributes?.['MessageGroupId']
          ? { messageGroupId: message.Attributes['MessageGroupId'] }
          : {}),
      },
    }));
  }

  async delete(queueName: string, receiptHandle: string): Promise<void> {
    const queueUrl = await this.queueUrl(queueName);
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  /** Health check de readiness: o SQS está alcançável? */
  async isReachable(): Promise<boolean> {
    try {
      const url = await this.queueUrl(QUEUE_TRANSACTIONS);
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: [QueueAttributeName.QueueArn],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
}
