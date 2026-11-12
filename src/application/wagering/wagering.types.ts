/**
 * Comandos e resultados da camada de aplicação.
 */
import { MoneyProps } from '../../domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';

export type WagerSource = 'HTTP' | 'SQS' | 'INTERNAL';

export interface SubmitWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  /** Fonte da verdade da idempotência (header Idempotency-Key). */
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  source: WagerSource;
  correlationId: string;
}

export interface WagerProcessingOutcome {
  status: WagerTransactionStatus;
  transaction: WagerTransaction;
  /** Saldo observado no momento da resolução (replay devolve o original). */
  balance?: { amount: string; currency: string };
  /** true quando a resposta veio de uma transação já processada (replay). */
  idempotentReplay: boolean;
  /** true quando a transação foi rejeitada por regra de negócio. */
  failureCode?: string;
}
