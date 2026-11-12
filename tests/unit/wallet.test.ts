/**
 * Testes unitários da Wallet e do Ledger (seção 6.2 e 6.4).
 */
import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../src/common/money';
import {
  InsufficientFundsError,
  Wallet,
  WalletInvariantError,
} from '../../src/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function openWallet(balance = '100.00'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(balance),
  });
}

describe('Wallet', () => {
  test('abertura: version começa em 1', () => {
    const wallet = openWallet();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.currency).toBe('BRL');
  });

  test('abertura com saldo inicial negativo é inválida', () => {
    // Money.from já rejeita negativos na entrada; o Wallet também se
    // protege (defesa em profundidade).
    const negative = brl('1.00').negate();
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: negative }),
    ).toThrow(WalletInvariantError);
  });

  test('débito altera saldo, incrementa version e gera lançamento DEBIT', () => {
    const wallet = openWallet();
    const entry = wallet.debit({ transactionId: 'tx-1', money: brl('30.00') });

    expect(wallet.balance.amount).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('70.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('débito maior que o saldo é rejeitado e não altera o saldo', () => {
    const wallet = openWallet();
    expect(() => wallet.debit({ transactionId: 'tx-1', money: brl('100.01') })).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('crédito altera saldo, incrementa version e gera lançamento CREDIT', () => {
    const wallet = openWallet();
    const entry = wallet.credit({ transactionId: 'tx-2', money: brl('25.50') });

    expect(wallet.balance.amount).toBe('125.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  test('moeda diferente da wallet é rejeitada', () => {
    const wallet = openWallet();
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => wallet.debit({ transactionId: 'tx', money: usd })).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.credit({ transactionId: 'tx', money: usd })).toThrow(
      CurrencyMismatchError,
    );
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('rehydrate reconstrói o estado persistido', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balanceAmount: '42.00',
      version: 7,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(wallet.balance.amount).toBe('42.00');
    expect(wallet.version).toBe(7);
  });

  test('saldo nunca fica negativo', () => {
    const wallet = openWallet('10.00');
    wallet.debit({ transactionId: 'tx-1', money: brl('10.00') });
    expect(wallet.balance.amount).toBe('0.00');
    expect(() => wallet.debit({ transactionId: 'tx-2', money: brl('0.01') })).toThrow(
      InsufficientFundsError,
    );
  });
});

describe('WalletLedgerEntry', () => {
  test('create calcula balanceAfter e valida a aritmética', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      createdAt: new Date(),
    });

    expect(entry.balanceAfter.amount).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('moeda do lançamento diferente da do saldo é rejeitada', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'e',
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '1.00', currency: 'USD' }),
        balanceBefore: brl('0.00'),
        createdAt: new Date(),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test('rehydrate não revalida e preserva os valores persistidos', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'e',
      walletId: 'w',
      transactionId: 't',
      direction: LedgerDirection.Credit,
      amount: '10.00',
      currency: 'BRL',
      balanceBefore: '0.00',
      balanceAfter: '10.00',
      createdAt: new Date(),
    });

    expect(entry.balanceAfter.amount).toBe('10.00');
    expect(entry.isBalanced()).toBe(true);
  });
});
