/**
 * Testes de CONCORRÊNCIA (paralelismo real, contra a aplicação real).
 *
 * Cenário obrigatório da seção 8 do enunciado:
 *   saldo inicial 100.00, duas apostas de 80.00 processadas simultaneamente
 *   -> exatamente uma PROCESSED, a outra REJECTED (saldo insuficiente),
 *      saldo final 20.00, exatamente 1 lançamento de débito.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  api,
  betPayload,
  createWallet,
  ledgerCount,
  ledgerSum,
  waitForReady,
  walletBalance,
  withDb,
} from './helpers';

beforeAll(async () => {
  await waitForReady();
});

describe('Concorrência', () => {
  test('duas apostas de 80 disputando saldo 100 (cenário da seção 8)', async () => {
    const wallet = await createWallet('100.00');

    const first = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      amount: '80.00',
    });
    const second = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      amount: '80.00',
    });

    const responses = await Promise.all([
      api('POST', '/wagering/transactions', {
        body: first.body,
        headers: { 'idempotency-key': first.idempotencyKey },
      }),
      api('POST', '/wagering/transactions', {
        body: second.body,
        headers: { 'idempotency-key': second.idempotencyKey },
      }),
    ]);

    const processed = responses.filter((r) => r.body.status === 'PROCESSED');
    const rejected = responses.filter((r) => r.body.status === 'REJECTED');

    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].body.failureCode).toBe('INSUFFICIENT_FUNDS');

    await withDb(async (client) => {
      expect(await walletBalance(client, wallet.id)).toBe('20.00');
      // OPENING + 1 débito = 2 entradas; exatamente 1 débito.
      expect(await ledgerCount(client, wallet.id)).toBe(2);
      expect(await ledgerSum(client, wallet.id)).toBe('20.00');

      const debits = await client.query(
        `SELECT COUNT(*)::int AS count FROM wallet_ledger_entries
         WHERE wallet_id = $1 AND direction = 'DEBIT'`,
        [wallet.id],
      );
      expect(debits.rows[0].count).toBe(1);
    });
  });

  test('a mesma aposta enviada 50 vezes em paralelo -> um único débito', async () => {
    const wallet = await createWallet('100.00');
    const { idempotencyKey, body } = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      amount: '30.00',
    });

    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        api('POST', '/wagering/transactions', {
          body,
          headers: { 'idempotency-key': idempotencyKey },
        }),
      ),
    );

    // Todas respondem com sucesso (201 ou 200 de replay).
    const statusCount: Record<number, number> = {};
    for (const r of responses) statusCount[r.status] = (statusCount[r.status] ?? 0) + 1;

    expect(
      responses.every((r) => r.status === 201 || r.status === 200),
      `status distribution: ${JSON.stringify(statusCount)} - erros: ${JSON.stringify(
        responses.filter((r) => r.status >= 400).slice(0, 3),
      )}`,
    ).toBe(true);
    expect(responses.filter((r) => r.body.idempotentReplay === true).length).toBe(49);

    const transactionIds = new Set(responses.map((r) => r.body.transactionId));
    expect(transactionIds.size).toBe(1);

    await withDb(async (client) => {
      expect(await walletBalance(client, wallet.id)).toBe('70.00');
      expect(await ledgerCount(client, wallet.id)).toBe(2); // OPENING + 1 débito
      expect(await ledgerSum(client, wallet.id)).toBe('70.00');
    });
  });

  test('wallets distintas são processadas em paralelo sem interferência', async () => {
    const wallets = await Promise.all([
      createWallet('100.00'),
      createWallet('100.00'),
      createWallet('100.00'),
      createWallet('100.00'),
    ]);

    const responses = await Promise.all(
      wallets.map((wallet) => {
        const bet = betPayload({
          playerId: wallet.playerId,
          walletId: wallet.id,
          amount: '40.00',
        });
        return api('POST', '/wagering/transactions', {
          body: bet.body,
          headers: { 'idempotency-key': bet.idempotencyKey },
        });
      }),
    );

    expect(responses.every((r) => r.body.status === 'PROCESSED')).toBe(true);

    await withDb(async (client) => {
      for (const wallet of wallets) {
        expect(await walletBalance(client, wallet.id)).toBe('60.00');
        expect(await ledgerSum(client, wallet.id)).toBe('60.00');
      }
    });
  });

  test('muitas apostas concorrentes na mesma wallet: saldo nunca negativo', async () => {
    const wallet = await createWallet('100.00');

    const bets = Array.from({ length: 20 }, () =>
      betPayload({
        playerId: wallet.playerId,
        walletId: wallet.id,
        amount: '10.00',
      }),
    );

    const responses = await Promise.all(
      bets.map((bet) =>
        api('POST', '/wagering/transactions', {
          body: bet.body,
          headers: { 'idempotency-key': bet.idempotencyKey },
        }),
      ),
    );

    const processed = responses.filter((r) => r.body.status === 'PROCESSED').length;
    expect(processed).toBe(10); // 10 x 10.00 cabem em 100.00

    await withDb(async (client) => {
      const balance = await walletBalance(client, wallet.id);
      expect(Number(balance)).toBe(0);
      expect(await ledgerSum(client, wallet.id)).toBe('0.00');

      const debits = await client.query(
        `SELECT COUNT(*)::int AS count FROM wallet_ledger_entries
         WHERE wallet_id = $1 AND direction = 'DEBIT'`,
        [wallet.id],
      );
      expect(debits.rows[0].count).toBe(10);
    });
  });

  test('inbox/outbox: cada operação gera exatamente uma transação e eventos', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const { idempotencyKey, body } = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      amount: '10.00',
      externalTransactionId,
    });

    await api('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });

    await withDb(async (client) => {
      const transactions = await client.query<{ id: string }>(
        'SELECT id FROM wager_transactions WHERE idempotency_key = $1',
        [idempotencyKey],
      );
      expect(transactions.rows.length).toBe(1);

      // Eventos na outbox: WagerTransactionProcessed + WalletBalanceChanged.
      const events = await client.query(
        `SELECT event_type FROM outbox_messages
         WHERE aggregate_id IN ($1, $2)
         ORDER BY event_type`,
        [wallet.id, transactions.rows[0].id],
      );
      const types = events.rows.map((row) => row.event_type);
      expect(types).toContain('WagerTransactionProcessed');
      expect(types).toContain('WalletBalanceChanged');
    });
  });
});
