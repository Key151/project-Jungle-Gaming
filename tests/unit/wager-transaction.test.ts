/**
 * Testes unitários da WagerTransaction (seção 6.3): máquina de estados,
 * direções de ledger eRequirement de referência.
 */
import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import {
  FailureCode,
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';

function create(
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId,
    source: 'HTTP',
    correlationId: 'corr-1',
  });
}

describe('WagerTransaction', () => {
  test('nasce em PENDING', () => {
    const tx = create(WagerTransactionKind.Bet);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
  });

  test('REFUND e ROLLBACK exigem referenceExternalTransactionId', () => {
    expect(() => create(WagerTransactionKind.Refund)).toThrow(InvalidTransactionStateError);
    expect(() => create(WagerTransactionKind.Rollback)).toThrow(InvalidTransactionStateError);
    expect(() => create(WagerTransactionKind.Refund, 'bet-1')).not.toThrow();
  });

  test('transições válidas', () => {
    const tx = create(WagerTransactionKind.Bet);
    const now = new Date();

    tx.markProcessed('ref-1', now);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('ref-1');
    expect(tx.processedAt).toBe(now);
    expect(tx.isTerminal()).toBe(true);

    const rejected = create(WagerTransactionKind.Bet);
    rejected.reject(FailureCode.INSUFFICIENT_FUNDS);
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);

    const failed = create(WagerTransactionKind.Bet);
    failed.fail(FailureCode.INVALID_PAYLOAD);
    expect(failed.status).toBe(WagerTransactionStatus.Failed);

    const pending = create(WagerTransactionKind.Refund, 'bet-1');
    pending.markPendingReference();
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pending.isTerminal()).toBe(false);
  });

  test('estado terminal não muda mais (erro de programação)', () => {
    const tx = create(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, new Date());

    expect(() => tx.markProcessed(undefined, new Date())).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.reject(FailureCode.INSUFFICIENT_FUNDS)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.fail(FailureCode.INVALID_PAYLOAD)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('affectsBalance: LOSS não mexe no saldo', () => {
    expect(create(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    expect(create(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
    expect(create(WagerTransactionKind.Win).affectsBalance()).toBe(true);
    expect(create(WagerTransactionKind.Refund, 'x').affectsBalance()).toBe(true);
  });

  test('requiresReference: apenas REFUND e ROLLBACK', () => {
    expect(create(WagerTransactionKind.Refund, 'x').requiresReference()).toBe(true);
    expect(create(WagerTransactionKind.Rollback, 'x').requiresReference()).toBe(true);
    expect(create(WagerTransactionKind.Bet).requiresReference()).toBe(false);
    expect(create(WagerTransactionKind.Win).requiresReference()).toBe(false);
  });

  test('ledgerDirectionFor por kind', () => {
    expect(create(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(create(WagerTransactionKind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(create(WagerTransactionKind.Refund, 'x').ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  test('ROLLBACK é o inverso da direção da referência', () => {
    const bet = create(WagerTransactionKind.Bet);
    const win = create(WagerTransactionKind.Win);

    expect(create(WagerTransactionKind.Rollback, 'x').ledgerDirectionFor(bet)).toBe(
      LedgerDirection.Credit,
    );
    expect(create(WagerTransactionKind.Rollback, 'x').ledgerDirectionFor(win)).toBe(
      LedgerDirection.Debit,
    );
  });

  test('LOSS não gera lançamento', () => {
    expect(() => create(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('matchesPayload compara o hash do payload', () => {
    const tx = create(WagerTransactionKind.Bet);
    expect(tx.matchesPayload('hash-1')).toBe(true);
    expect(tx.matchesPayload('hash-2')).toBe(false);
  });

  test('rehydrate reconstrói o estado persistido', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'tx-9',
      providerId: 'provider-a',
      externalTransactionId: 'ext-9',
      idempotencyKey: 'k',
      payloadHash: 'h',
      walletId: 'w',
      playerId: 'p',
      roundId: 'r',
      gameId: 'g',
      kind: WagerTransactionKind.Win,
      amount: '10.00',
      currency: 'BRL',
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      status: WagerTransactionStatus.Processed,
      failureCode: null,
      attempts: 0,
      nextAttemptAt: null,
      processedAt: new Date('2026-01-01T00:00:00.000Z'),
      observedBalanceAmount: '110.00',
      observedBalanceCurrency: 'BRL',
      source: 'HTTP',
      correlationId: 'c',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.money.amount).toBe('10.00');
    expect(tx.observedBalance?.amount).toBe('110.00');
  });
});
