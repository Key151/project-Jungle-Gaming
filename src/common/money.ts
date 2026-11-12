/**
 * Money — oMoney type (value object) do domínio.
 *
 * REGRAS (ver seção 6.1 do enunciado):
 *  - o valor NUNCA é number/float: é uma string decimal (ex.: "25.00");
 *  - a escala é fixa em 2 casas;
 *  - operações entre moedas diferentes lançam erro de domínio;
 *  - entradas inválidas são rejeitadas na entrada (NaN, Infinity, notação
 *    científica, string vazia, mais de 2 casas decimais, valor negativo).
 *
 * Este arquivo NÃO importa nada do NestJS, do ORM ou de tipos monetários de
 * framework: é TypeScript puro, para poder ser testado isoladamente.
 */
import { Decimal } from 'decimal.js';

/**
 * Precision do decimal.js. O default (20) seria insuficiente para somar
 * amounts de 18 dígitos inteiros + 2 decimais sem perder precisão em
 *ibatidas. 40 dígitos deixam folga confortável.
 */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface MoneyProps {
  /** Decimal string, sempre com escala fixa de 2 casas. Ex.: "25.00" */
  amount: string;
  /** ISO-4217. Ex.: "BRL" */
  currency: string;
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor(left: string, right: string) {
    super(`Currency mismatch: cannot operate on ${left} and ${right}`);
    this.name = 'CurrencyMismatchError';
  }
}

/** Aceita apenas inteiros até 18 dígitos com 0, 1 ou 2 casas decimais. */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Factory única de entrada. Valida e normaliza.
   * - amount precisa ser string decimal ("25.00"); number é recusado.
   * - currency precisa ser ISO-4217 em maiúsculas ("BRL").
   */
  static from(props: MoneyProps): Money {
    if (!props || typeof props !== 'object') {
      throw new InvalidMoneyError('Money props are required');
    }

    const { amount, currency } = props;

    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string (received ' + typeof amount + ')');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `invalid amount "${amount}": expected a non-negative decimal string with at most 2 decimal places`,
      );
    }
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`invalid currency "${String(currency)}": expected an ISO-4217 code`);
    }

    // O regex já garante no máximo 2 casas; o toDecimalPlaces apenas
    // normaliza a escala (ex.: "25.5" -> "25.50").
    return new Money(new Decimal(amount).toDecimalPlaces(2), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  /**
   * Usado internamente pelo domínio (ex.: negate()) para representar valores
   * negativos, que não são aceitos em contratos de entrada.
   */
  private static unsafe(amount: string, currency: string): Money {
    return new Money(new Decimal(amount).toDecimalPlaces(2), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.unsafe(this.value.negated().toFixed(2), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.gt(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.eq(other.value);
  }

  /** Amount como string decimal com escala fixa de 2. */
  get amount(): string {
    return this.value.toFixed(2);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (!other || other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other ? other.currency : 'undefined');
    }
  }
}
