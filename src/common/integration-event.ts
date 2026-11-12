/**
 * Eventos de integração (envelope).
 *
 * O envelope é serializado e gravado na outbox dentro da MESMA transação SQL
 * que altera o saldo. O payload usa MoneyProps (string decimal), nunca a
 * instância de Money, para ser JSON estável e versionável.
 */
import { MoneyProps } from './money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../wagering/wager-transaction';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: T;
  } {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

// ---------------------------------------------------------------------------
// WagerTransactionProcessed — qualquer transação aplicada, inclusive LOSS.
// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  /** Saldo observado após a aplicação (ausente em LOSS). */
  balanceAfter?: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(params: {
    eventId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    transactionId: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    status: WagerTransactionStatus;
    money: MoneyProps;
    balanceAfter?: MoneyProps;
  }): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: params.eventId,
      aggregateId: params.transactionId,
      correlationId: params.correlationId,
      causationId: params.causationId,
      occurredAt: params.occurredAt,
      data: {
        transactionId: params.transactionId,
        providerId: params.providerId,
        externalTransactionId: params.externalTransactionId,
        playerId: params.playerId,
        walletId: params.walletId,
        roundId: params.roundId,
        gameId: params.gameId,
        kind: params.kind,
        status: params.status,
        money: params.money,
        ...(params.balanceAfter ? { balanceAfter: params.balanceAfter } : {}),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// WagerTransactionRejected — rejeição por regra de negócio.
// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  balance?: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(params: {
    eventId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    transactionId: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    failureCode: FailureCode;
    balance?: MoneyProps;
  }): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: params.eventId,
      aggregateId: params.transactionId,
      correlationId: params.correlationId,
      causationId: params.causationId,
      occurredAt: params.occurredAt,
      data: {
        transactionId: params.transactionId,
        providerId: params.providerId,
        externalTransactionId: params.externalTransactionId,
        playerId: params.playerId,
        walletId: params.walletId,
        roundId: params.roundId,
        kind: params.kind,
        money: params.money,
        failureCode: params.failureCode,
        ...(params.balance ? { balance: params.balance } : {}),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// WalletBalanceChanged — só quando o saldo muda.
// ---------------------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(params: {
    eventId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    walletVersion: number;
  }): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: params.eventId,
      aggregateId: params.walletId,
      correlationId: params.correlationId,
      causationId: params.causationId,
      occurredAt: params.occurredAt,
      data: {
        walletId: params.walletId,
        transactionId: params.transactionId,
        direction: params.direction,
        money: params.money,
        balanceBefore: params.balanceBefore,
        balanceAfter: params.balanceAfter,
        walletVersion: params.walletVersion,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// WagerTransactionPendingReference — referência (ainda) ausente.
// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt?: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(params: {
    eventId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    transactionId: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    referenceExternalTransactionId: string;
    attempts: number;
    nextAttemptAt?: Date;
  }): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: params.eventId,
      aggregateId: params.transactionId,
      correlationId: params.correlationId,
      causationId: params.causationId,
      occurredAt: params.occurredAt,
      data: {
        transactionId: params.transactionId,
        providerId: params.providerId,
        externalTransactionId: params.externalTransactionId,
        playerId: params.playerId,
        walletId: params.walletId,
        referenceExternalTransactionId: params.referenceExternalTransactionId,
        attempts: params.attempts,
        ...(params.nextAttemptAt ? { nextAttemptAt: params.nextAttemptAt.toISOString() } : {}),
      },
    });
  }
}
