/**
 * Testes de MENSAGERIA (SQS real via LocalStack/MiniStack):
 *  - consumidor processa a mensagem e grava no inbox;
 *  - redelivery da MESMA mensagem não duplica o efeito (inbox);
 *  - payload inválido vai para a DLQ;
 *  - a outbox publica os eventos.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  api,
  createWallet,
  ledgerCount,
  ledgerSum,
  waitForReady,
  withDb,
} from './helpers';

const QUEUE_TRANSACTIONS = 'wager-transactions.fifo';
const QUEUE_TRANSACTIONS_DLQ = 'wager-transactions-dlq.fifo';
const QUEUE_EVENTS = 'wager-events.fifo';

const sqs = new SQSClient({
  region: process.env['AWS_REGION'] ?? 'us-east-1',
  endpoint: process.env['SQS_ENDPOINT'] ?? 'http://localhost:4566',
  credentials: {
    accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
    secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
  },
});

async function queueUrl(name: string): Promise<string> {
  const response = await sqs.send(
    new (await import('@aws-sdk/client-sqs')).GetQueueUrlCommand({ QueueName: name }),
  );
  return response.QueueUrl as string;
}

async function sendToQueue(
  queue: string,
  body: unknown,
  options: { groupId: string; deduplicationId: string },
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(queue),
      MessageBody: JSON.stringify(body),
      MessageGroupId: options.groupId,
      MessageDeduplicationId: options.deduplicationId,
    }),
  );
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

beforeAll(async () => {
  await waitForReady();
});

describe('Mensageria SQS', () => {
  test('mensagem na fila é processada e deduplicada pelo inbox', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const messageId = randomUUID();
    const idempotencyKey = `provider-a:${externalTransactionId}`;

    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: randomUUID(),
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      },
    };

    await sendToQueue(QUEUE_TRANSACTIONS, envelope, {
      groupId: wallet.id,
      deduplicationId: messageId,
    });

    const processed = await waitFor(async () => {
      const response = await api(
        'GET',
        `/providers/provider-a/wagering/transactions/${externalTransactionId}`,
      );
      return response.status === 200 && response.body.status === 'PROCESSED';
    });

    expect(processed).toBe(true);

    await withDb(async (client) => {
      // Inbox registrado e marcado como processado.
      const inbox = await client.query(
        'SELECT processed_at FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2',
        ['wager-transactions-consumer', messageId],
      );
      expect(inbox.rows.length).toBe(1);
      expect(inbox.rows[0].processed_at).not.toBeNull();

      // Efeito financeiro aplicado UMA vez.
      expect(await ledgerCount(client, wallet.id)).toBe(2); // OPENING + 1 débito
      expect(await ledgerSum(client, wallet.id)).toBe('80.00');
    });

    // Redelivery da MESMA mensagem lógica (outro deduplication id do SQS):
    // o inbox impede o processamento duplicado.
    await sendToQueue(QUEUE_TRANSACTIONS, envelope, {
      groupId: wallet.id,
      deduplicationId: randomUUID(),
    });

    await new Promise((resolve) => setTimeout(resolve, 3000));

    await withDb(async (client) => {
      expect(await ledgerCount(client, wallet.id)).toBe(2);
      expect(await ledgerSum(client, wallet.id)).toBe('80.00');
    });
  });

  test('eventos são publicados na fila de integração (outbox)', async () => {
    const wallet = await createWallet('50.00');
    const externalTransactionId = randomUUID();

    await sendToQueue(
      QUEUE_TRANSACTIONS,
      {
        messageId: randomUUID(),
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'provider-a',
          externalTransactionId,
          idempotencyKey: `provider-a:${externalTransactionId}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: randomUUID(),
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      },
      { groupId: wallet.id, deduplicationId: randomUUID() },
    );

    const published = await waitFor(async () => {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: await queueUrl(QUEUE_EVENTS),
          MaxNumberOfMessages: 10,
          VisibilityTimeout: 1,
          WaitTimeSeconds: 1,
        }),
      );
      return (response.Messages ?? []).some((message) =>
        message.Body?.includes(externalTransactionId),
      );
    });

    expect(published).toBe(true);
  }, 30_000); // o publisher roda a cada 500ms, mas o SQS pode demorar um pouco

  test('payload inválido vai para a DLQ', async () => {
    const invalid = {
      messageId: randomUUID(),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        // faltam playerId, walletId, money...
      },
    };

    await sendToQueue(QUEUE_TRANSACTIONS, invalid, {
      groupId: 'invalid',
      deduplicationId: randomUUID(),
    });

    const inDlq = await waitFor(async () => {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: await queueUrl(QUEUE_TRANSACTIONS_DLQ),
          MaxNumberOfMessages: 10,
          VisibilityTimeout: 1,
          WaitTimeSeconds: 1,
        }),
      );
      return (response.Messages ?? []).length > 0;
    });

    expect(inDlq).toBe(true);
  });
});
