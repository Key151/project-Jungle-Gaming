/**
 * Testes unitários de Money (seção 6.1 do enunciado).
 * Rodar com: bun test tests/unit
 */
import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
} from '../../src/domain/money';

describe('Money', () => {
  test('cria a partir de string decimal com escala fixa de 2 casas', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(money.amount).toBe('25.00');
    expect(money.currency).toBe('BRL');
  });

  test('normaliza a escala (25.5 -> 25.50, 25 -> 25.00)', () => {
    expect(Money.from({ amount: '25.5', currency: 'BRL' }).amount).toBe('25.50');
    expect(Money.from({ amount: '25', currency: 'BRL' }).amount).toBe('25.00');
    expect(Money.from({ amount: '0', currency: 'BRL' }).amount).toBe('0.00');
  });

  test('rejeita entradas inválidas', () => {
    const invalid = [
      { amount: 25, currency: 'BRL' }, // number
      { amount: '25.00.00', currency: 'BRL' },
      { amount: '25.000', currency: 'BRL' }, // mais de 2 casas
      { amount: '1e2', currency: 'BRL' }, // notação científica
      { amount: '', currency: 'BRL' },
      { amount: 'abc', currency: 'BRL' },
      { amount: 'NaN', currency: 'BRL' },
      { amount: 'Infinity', currency: 'BRL' },
      { amount: '-25.00', currency: 'BRL' }, // negativo
      { amount: '25.00', currency: 'brl' }, // moeda inválida
      { amount: '25.00', currency: 'BRLL' },
    ];

    for (const props of invalid) {
      expect(() => Money.from(props as never)).toThrow(InvalidMoneyError);
    }
  });

  test('operações aritméticas são exatas (0.1 + 0.2 = 0.30)', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });
    expect(a.add(b).amount).toBe('0.30');
    expect(b.subtract(a).amount).toBe('0.10');
    expect(a.add(b).amount).toBe('0.30');
  });

  test('Money é imutável: as operações devolvem novas instâncias', () => {
    const original = Money.from({ amount: '10.00', currency: 'BRL' });
    const sum = original.add(Money.from({ amount: '5.00', currency: 'BRL' }));

    expect(original.amount).toBe('10.00');
    expect(sum.amount).toBe('15.00');
    expect(sum).not.toBe(original);
  });

  test('operações entre moedas diferentes lançam CurrencyMismatchError', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
  });

  test('comparações', () => {
    const zero = Money.zero('BRL');
    const ten = Money.from({ amount: '10.00', currency: 'BRL' });
    const twenty = Money.from({ amount: '20.00', currency: 'BRL' });

    expect(zero.isZero()).toBe(true);
    expect(ten.isPositive()).toBe(true);
    expect(ten.isNegative()).toBe(false);
    expect(ten.negate().isNegative()).toBe(true);
    expect(ten.isLessThan(twenty)).toBe(true);
    expect(twenty.isLessThan(ten)).toBe(false);
    expect(ten.equals(Money.from({ amount: '10.00', currency: 'BRL' }))).toBe(true);
  });

  test('serialização (toJSON/toString) usa string decimal', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(JSON.stringify({ money })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    expect(money.toString()).toBe('25.00 BRL');
  });

  test('precisão alta: soma de muitos valores não perde centavos', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 10; i += 1) {
      total = total.add(Money.from({ amount: '0.10', currency: 'BRL' }));
    }
    expect(total.amount).toBe('1.00');
  });
});
