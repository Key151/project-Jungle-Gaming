/**
 * Wallet — Aggregate Root do saldo do jogador.
 *
 * Invariantes garantidos aqui (e reforçados no schema do banco):
 *  - no máximo uma wallet por (playerId, currency);
 *  - o saldo nunca fica negativo;
 *  - toda alteração de saldo gera exatamente um lançamento no ledger;
 *  - `version` só incrementa quando o saldo muda.
 *
 * O controle de concorrência (lost update) NÃO é responsabilidade do objeto
 * de domínio — ele é feito no banco via lock pessimista por linha
 * (`SELECT ... FOR UPDATE` na tabela `wallets`). Ver ARCHITECTURE.md.
 */
import { newId } from '../shared/ids';
import { CurrencyMismatchError, Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export class WalletInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletInvariantError';
  }
}

export class InsufficientFundsError extends Error {
  constructor(public readonly available: Money, public readonly requested: Money) {
    super('insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balanceAmount: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at?: Date;
}

export interface WalletMovement {
  transactionId: string;
  money: Money;
  at?: Date;
  id?: string;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Abertura de wallet. A version começa em 1. */
  static open(props: WalletProps): Wallet {
    if (!props.id) throw new WalletInvariantError('wallet id is required');
    if (!props.playerId) throw new WalletInvariantError('playerId is required');
    if (props.initialBalance.isNegative()) {
      throw new WalletInvariantError('initial balance cannot be negative');
    }
    const at = props.at ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      at,
      at,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from({ amount: state.balanceAmount, currency: state.currency }),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Débito. Lança InsufficientFundsError se o saldo for insuficiente
   * (a wallet nunca fica negativa — a regra é garantida aqui E por um
   * CHECK (balance_amount >= 0) no banco).
   */
  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (movement.money.isNegative()) {
      throw new WalletInvariantError('debit amount cannot be negative');
    }

    const balanceBefore = this._balance;
    if (balanceBefore.isLessThan(movement.money)) {
      throw new InsufficientFundsError(balanceBefore, movement.money);
    }

    const at = movement.at ?? new Date();
    this._balance = balanceBefore.subtract(movement.money);
    this._version += 1;
    this._updatedAt = at;

    return WalletLedgerEntry.create({
      id: movement.id ?? newId(),
      walletId: this.id,
      transactionId: movement.transactionId,
      direction: LedgerDirection.Debit,
      money: movement.money,
      balanceBefore,
      createdAt: at,
    });
  }

  /** Crédito. */
  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);

    const at = movement.at ?? new Date();
    const balanceBefore = this._balance;
    this._balance = balanceBefore.add(movement.money);
    this._version += 1;
    this._updatedAt = at;

    return WalletLedgerEntry.create({
      id: movement.id ?? newId(),
      walletId: this.id,
      transactionId: movement.transactionId,
      direction: LedgerDirection.Credit,
      money: movement.money,
      balanceBefore,
      createdAt: at,
    });
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
