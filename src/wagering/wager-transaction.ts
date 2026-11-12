/**
 * WagerTransaction — aggregate da operação de aposta.
 *
 * Máquina de estados (transições válidas):
 *
 *   create() ──► PENDING
 *                  │
 *                  ├── markProcessed()  ──► PROCESSED   (terminal)
 *                  ├── reject()         ──► REJECTED   (terminal)
 *                  ├── fail()           ──► FAILED     (terminal)
 *                  └── markPendingReference() ──► PENDING_REFERENCE
 *                                                     │
 *                     ┌───────────────────────────────┘
 *                     ├── markProcessed() ──► PROCESSED (terminal)
 *                     └── reject()        ──► REJECTED (terminal)
 *
 * PENDING_REFERENCE pode voltar para o fluxo normal (retry do worker) e é
 * terminal apenas depois de resolvido ou rejeitado.
 * PROCESSED / REJECTED / FAILED são TERMINAIS: qualquer tentativa de
 * transicionar de novo é erro de programação (InvalidTransactionStateError).
 */
import { Money } from '../common/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Não pode vir da API/fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/**
 * Taxonomia de falhas: códigos estáveis e legíveis por máquina.
 * O provedor decide com eles se reenvia (TRANSIENT_*), corrige o payload
 * (INVALID_PAYLOAD) ou desiste (todo o resto é terminal).
 */
export const FailureCode = {
  /** Saldo insuficiente para a aposta. Terminal. */
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  /** A wallet não existe. Terminal. */
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  /** A wallet pertence a outro jogador. Terminal. */
  WALLET_OWNERSHIP_MISMATCH: 'WALLET_OWNERSHIP_MISMATCH',
  /** Moeda da operação diferente da moeda da wallet. Terminal. */
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  /** A referência (id externo) não existe (ainda). Terminal após TTL. */
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  /** A referência existe mas não é do tipo que pode ser revertida. Terminal. */
  REFERENCE_KIND_NOT_REVERSIBLE: 'REFERENCE_KIND_NOT_REVERSIBLE',
  /** A referência já foi revertida (REFUND/ROLLBACK) anteriormente. Terminal. */
  REFERENCE_ALREADY_REVERSED: 'REFERENCE_ALREADY_REVERSED',
  /** Valor da reversão diferente do valor da referência. Terminal. */
  REFERENCE_AMOUNT_MISMATCH: 'REFERENCE_AMOUNT_MISMATCH',
  /** Referência de outro player/wallet/moeda/rodada. Terminal. */
  REFERENCE_SCOPE_MISMATCH: 'REFERENCE_SCOPE_MISMATCH',
  /** A referência está rejeitada/falhou — não pode ser revertida. Terminal. */
  REFERENCE_NOT_APPLICABLE: 'REFERENCE_NOT_APPLICABLE',
  /** Estouro do TTL de resolução da referência. Terminal. */
  REFERENCE_RESOLUTION_TIMEOUT: 'REFERENCE_RESOLUTION_TIMEOUT',
  /**
   * A reversão produziria saldo negativo (ex.: reverter um WIN depois que o
   * jogador gastou o prêmio). Terminal — código DISTINTO do de aposta sem
   * saldo, porque são situações operacionalmente diferentes.
   */
  REVERSAL_WOULD_NEGATIVE_BALANCE: 'REVERSAL_WOULD_NEGATIVE_BALANCE',
  /** Payload inválido (não é falha de negócio, é erro do provedor). */
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | null;
  source: string;
  correlationId: string;
  at?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: WagerTransactionStatus;
  failureCode: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  processedAt: Date | null;
  observedBalanceAmount: string | null;
  observedBalanceCurrency: string | null;
  source: string;
  correlationId: string;
  createdAt: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    public readonly correlationId: string,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _attempts = 0,
    private _nextAttemptAt?: Date,
    private _observedBalance?: Money,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const at = props.at ?? new Date();
    const tx = new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId ?? undefined,
      at,
      props.correlationId,
      WagerTransactionStatus.Pending,
    );

    if (tx.requiresReference() && !tx.referenceExternalTransactionId) {
      throw new InvalidTransactionStateError(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    return tx;
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    const tx = new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from({ amount: state.amount, currency: state.currency }),
      state.referenceExternalTransactionId ?? undefined,
      state.createdAt,
      state.correlationId,
      state.status,
      state.referenceTransactionId ?? undefined,
      (state.failureCode as FailureCode | undefined) ?? undefined,
      state.processedAt ?? undefined,
      state.attempts,
      state.nextAttemptAt ?? undefined,
      state.observedBalanceAmount && state.observedBalanceCurrency
        ? Money.from({ amount: state.observedBalanceAmount, currency: state.observedBalanceCurrency })
        : undefined,
    );
    return tx;
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  /** Saldo observado no momento em que a transação foi resolvida. */
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  // ------------------------------------------------------------------
  // Transições
  // ------------------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId ?? this._referenceTransactionId;
    this._processedAt = at;
    this._failureCode = undefined;
  }

  markPendingReference(): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  /** Registra uma tentativa de resolução de referência (backoff). */
  registerReferenceAttempt(nextAttemptAt: Date): void {
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
  }

  /** Registra o saldo observado (usado no replay idempotente). */
  setObservedBalance(balance: Money): void {
    this._observedBalance = balance;
  }

  // ------------------------------------------------------------------
  // Consultas de domínio
  // ------------------------------------------------------------------

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /** LOSS é a única operação que não mexe no saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** REFUND e ROLLBACK sempre precisam de referência. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento no ledger.
   * ROLLBACK é o inverso da direção da referência.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK requires a reference transaction');
        }
        const referenceDirection = reference.ledgerDirectionFor();
        return referenceDirection === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not produce a ledger entry');
      default:
        throw new InvalidTransactionStateError(`unsupported kind ${this.kind}`);
    }
  }

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `cannot ${operation}: transaction is already ${this._status}`,
      );
    }
  }
}
