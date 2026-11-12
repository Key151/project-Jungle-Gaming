/**
 * Testes de integração da API HTTP: regras de negócio, idempotência,
 * ledger e reconciliação (PostgreSQL real).
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

describe('Wallet API', () => {
  test('cria wallet com saldo inicial e transação OPENING', async () => {
    const wallet = await createWallet('1000.00');

    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);

    await withDb(async (client) => {
      // Uma entrada CREDIT de abertura no ledger.
      const entries = await client.query(
        `SELECT direction, amount, balance_before, balance_after
         FROM wallet_ledger_entries WHERE wallet_id = $1`,
        [wallet.id],
      );
      expect(entries.rows.length).toBe(1);
      expect(entries.rows[0].direction).toBe('CREDIT');
      expect(entries.rows[0].amount).toBe('1000.00');
      expect(entries.rows[0].balance_before).toBe('0.00');
      expect(entries.rows[0].balance_after).toBe('1000.00');

      // Transação interna OPENING.
      const opening = await client.query(
        `SELECT kind, status FROM wager_transactions WHERE wallet_id = $1`,
        [wallet.id],
      );
      expect(opening.rows.length).toBe(1);
      expect(opening.rows[0].kind).toBe('OPENING');
      expect(opening.rows[0].status).toBe('PROCESSED');
    });
  });

  test('wallet duplicada (playerId + currency) devolve 409', async () => {
    const wallet = await createWallet('10.00');

    const response = await api('POST', '/wallets', {
      body: {
        playerId: wallet.playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      },
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('payload inválido devolve 400', async () => {
    const response = await api('POST', '/wallets', {
      body: { playerId: randomUUID(), initialBalance: { amount: '10.000', currency: 'BRL' } },
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_PAYLOAD');
  });
});

describe('Wagering API', () => {
  test('BET debita o saldo e gera 1 lançamento DEBIT', async () => {
    const wallet = await createWallet('1000.00');
    const { idempotencyKey, body } = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      amount: '25.00',
    });

    const response = await api('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('PROCESSED');
    expect(response.body.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(response.body.idempotentReplay).toBe(false);

    await withDb(async (client) => {
      expect(await ledgerCount(client, wallet.id)).toBe(2); // OPENING + BET
      expect(await ledgerSum(client, wallet.id)).toBe('975.00');
      expect(await walletBalance(client, wallet.id)).toBe('975.00');
    });
  });

  test('replay idempotente devolve o resultado original', async () => {
    const wallet = await createWallet('1000.00');
    const { idempotencyKey, body } = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      amount: '25.00',
    });

    const first = await api('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    const second = await api('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.idempotentReplay).toBe(true);
    expect(second.body.transactionId).toBe(first.body.transactionId);
    expect(second.body.balance).toEqual(first.body.balance);

    await withDb(async (client) => {
      // Nenhum débito duplicado.
      expect(await ledgerCount(client, wallet.id)).toBe(2);
      expect(await walletBalance(client, wallet.id)).toBe('975.00');
    });
  });

  test('mesma idempotency key com payload diferente é CONFLITO (409)', async () => {
    const wallet = await createWallet('1000.00');
    const externalTransactionId = randomUUID();
    const idempotencyKey = `provider-a:${externalTransactionId}`;

    const first = await api('POST', '/wagering/transactions', {
      body: {
        providerId: 'provider-a',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(first.status).toBe(201);

    const conflict = await api('POST', '/wagering/transactions', {
      body: {
        providerId: 'provider-a',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' }, // payload DIFERENTE
      },
      headers: { 'idempotency-key': idempotencyKey },
    });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('saldo insuficiente é rejeitado com 422 e failureCode', async () => {
    const wallet = await createWallet('50.00');
    const { idempotencyKey, body } = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      amount: '80.00',
    });

    const response = await api('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });

    expect(response.status).toBe(422);
    expect(response.body.status).toBe('REJECTED');
    expect(response.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    await withDb(async (client) => {
      expect(await walletBalance(client, wallet.id)).toBe('50.00');
      expect(await ledgerCount(client, wallet.id)).toBe(1); // só o OPENING
    });
  });

  test('LOSS não altera saldo nem gera lançamento', async () => {
    const wallet = await createWallet('1000.00');
    const { idempotencyKey, body } = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'LOSS',
      amount: '25.00',
    });

    const response = await api('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('PROCESSED');

    await withDb(async (client) => {
      expect(await walletBalance(client, wallet.id)).toBe('1000.00');
      expect(await ledgerCount(client, wallet.id)).toBe(1);
    });
  });

  test('WIN credita o saldo', async () => {
    const wallet = await createWallet('100.00');
    const { idempotencyKey, body } = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'WIN',
      amount: '40.00',
    });

    const response = await api('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });

    expect(response.status).toBe(201);
    expect(response.body.balance).toEqual({ amount: '140.00', currency: 'BRL' });
  });

  test('REFUND de BET credita de volta (uma única vez)', async () => {
    const wallet = await createWallet('100.00');
    const bet = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      amount: '30.00',
    });

    await api('POST', '/wagering/transactions', {
      body: bet.body,
      headers: { 'idempotency-key': bet.idempotencyKey },
    });

    const refund = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'REFUND',
      amount: '30.00',
      // A referência precisa ser da MESMA rodada da BET.
      roundId: bet.body.roundId,
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });

    const first = await api('POST', '/wagering/transactions', {
      body: refund.body,
      headers: { 'idempotency-key': refund.idempotencyKey },
    });
    expect(first.status).toBe(201);
    expect(first.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    // Segundo REFUND da mesma BET: conflito de negócio.
    const second = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'REFUND',
      amount: '30.00',
      roundId: bet.body.roundId,
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });
    const rejected = await api('POST', '/wagering/transactions', {
      body: second.body,
      headers: { 'idempotency-key': second.idempotencyKey },
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
  });

  test('ROLLBACK de WIN debita (inverso) e nunca deixa saldo negativo', async () => {
    const wallet = await createWallet('10.00');

    // WIN de 40 em uma wallet com 10 (o ganho não tem saldo mínimo).
    const win = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'WIN',
      amount: '40.00',
    });
    await api('POST', '/wagering/transactions', {
      body: win.body,
      headers: { 'idempotency-key': win.idempotencyKey },
    });

    // O jogador "gasta" o prêmio: sobra 5.00.
    const spend = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      amount: '45.00',
      roundId: win.body.roundId,
    });
    await api('POST', '/wagering/transactions', {
      body: spend.body,
      headers: { 'idempotency-key': spend.idempotencyKey },
    });

    const rollback = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'ROLLBACK',
      amount: '40.00',
      roundId: win.body.roundId,
      referenceExternalTransactionId: win.body.externalTransactionId,
    });

    const response = await api('POST', '/wagering/transactions', {
      body: rollback.body,
      headers: { 'idempotency-key': rollback.idempotencyKey },
    });

    // O jogador gastou o prêmio: a reversão produziria saldo negativo.
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('REVERSAL_WOULD_NEGATIVE_BALANCE');

    await withDb(async (client) => {
      expect(await walletBalance(client, wallet.id)).toBe('5.00');
    });
  });

  test('referência fora de ordem: PENDING_REFERENCE (202) e reprocessamento', async () => {
    const wallet = await createWallet('100.00');
    // id único: o banco guarda as transações das execuções anteriores.
    const lateBetId = `bet-${randomUUID()}`;

    // A BET ainda não existe: o REFUND fica pendente.
    const refund = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'REFUND',
      amount: '20.00',
      referenceExternalTransactionId: lateBetId,
    });

    const pending = await api('POST', '/wagering/transactions', {
      body: refund.body,
      headers: { 'idempotency-key': refund.idempotencyKey },
    });
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');

    // Agora a BET chega (mesma rodada, mesmo valor).
    const bet = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      amount: '20.00',
      roundId: refund.body.roundId,
    });
    // usa o MESMO id externo da referência
    bet.body.externalTransactionId = lateBetId;
    bet.body.roundId = refund.body.roundId;

    const betResponse = await api('POST', '/wagering/transactions', {
      body: bet.body,
      headers: { 'idempotency-key': `provider-a:${lateBetId}` },
    });
    expect(betResponse.status).toBe(201);

    // O worker reprocessa o REFUND pendente em alguns segundos.
    let settled = false;
    for (let attempt = 0; attempt < 40 && !settled; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const check = await api(
        'GET',
        `/wagering/transactions/${pending.body.transactionId}`,
      );
      settled = check.body.status === 'PROCESSED' || check.body.status === 'REJECTED';
    }

    expect(settled).toBe(true);
  }, 30_000); // o worker reprocessa com backoff de 5s -> precisa de mais tempo

  test('consultas: wallet, ledger (cursor) e transação pelo provedor', async () => {
    const wallet = await createWallet('100.00');
    const { idempotencyKey, body } = betPayload({
      playerId: wallet.playerId,
      walletId: wallet.id,
      amount: '10.00',
    });

    const created = await api('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });

    const found = await api('GET', `/wagering/transactions/${created.body.transactionId}`);
    expect(found.status).toBe(200);
    expect(found.body.status).toBe('PROCESSED');

    const byProvider = await api(
      'GET',
      `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
    );
    expect(byProvider.status).toBe(200);
    expect(byProvider.body.transactionId).toBe(created.body.transactionId);

    const ledger = await api('GET', `/wallets/${wallet.id}/ledger?limit=1`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.entries.length).toBe(1);
    expect(ledger.body.nextCursor).toBeTruthy();

    const page2 = await api(
      'GET',
      `/wallets/${wallet.id}/ledger?limit=1&cursor=${encodeURIComponent(ledger.body.nextCursor)}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.entries.length).toBe(1);
    // paginação estável: entradas diferentes
    expect(page2.body.entries[0].id).not.toBe(ledger.body.entries[0].id);
  });

  test('reconciliação: saldo materializado == soma do ledger', async () => {
    const wallet = await createWallet('500.00');

    for (const amount of ['10.00', '25.00', '5.00']) {
      const bet = betPayload({
        playerId: wallet.playerId,
        walletId: wallet.id,
        amount,
      });
      await api('POST', '/wagering/transactions', {
        body: bet.body,
        headers: { 'idempotency-key': bet.idempotencyKey },
      });
    }

    const reconciliation = await api('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body.consistent).toBe(true);
    expect(reconciliation.body.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(reconciliation.body.checkedEntries).toBe(4); // OPENING + 3 débitos
    expect(reconciliation.body.storedBalance).toEqual(
      reconciliation.body.calculatedBalance,
    );
  });

  test('health e métricas são públicos', async () => {
    const live = await api('GET', '/health/live');
    expect(live.status).toBe(200);
    expect(live.body.status).toBe('ok');

    const ready = await api('GET', '/health/ready');
    expect(ready.status).toBe(200);

    const metrics = await fetch(`${process.env['BASE_URL'] ?? 'http://localhost:3000'}/metrics`);
    expect(metrics.status).toBe(200);
  });
});
