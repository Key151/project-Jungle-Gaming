/**
 * WalletLedgerEntry — o livro-razão da wallet.
 *
 * É estruturalmente imutável: todos os campos são `readonly` e a classe não
 * possui nenhum método de transição. A única forma de criar um lançamento é
 * a factory `create`, que valida a aritmética (balanceBefore ± money ===
 * balanceAfter) antes de devolver o objeto.
 */
import { CurrencyMismatchError, Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (props.money.currency !== props.balanceBefore.currency) {
      throw new CurrencyMismatchError(props.balanceBefore.currency, props.money.currency);
    }
    if (props.money.isNegative()) {
      throw new Error('ledger entry amount cannot be negative');
    }

    const balanceAfter =
      props.direction === LedgerDirection.Debit
        ? props.balanceBefore.subtract(props.money)
        : props.balanceBefore.add(props.money);

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      balanceAfter,
      props.createdAt,
    );

    if (!entry.isBalanced()) {
      throw new Error('ledger entry is not balanced');
    }
    return entry;
  }

  /** Reconstrução a partir do banco: não revalida regras, só reconstrói. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from({ amount: state.amount, currency: state.currency }),
      Money.from({ amount: state.balanceBefore, currency: state.currency }),
      Money.from({ amount: state.balanceAfter, currency: state.currency }),
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
