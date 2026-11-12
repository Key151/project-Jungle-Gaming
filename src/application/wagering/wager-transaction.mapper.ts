/**
 * Mapeamento entre a linha da tabela `wager_transactions` e o agregado de
 * domínio. Mantém o domínio livre de tipos do ORM.
 */
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionState,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';

export interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  processed_at: Date | null;
  observed_balance_amount: string | null;
  observed_balance_currency: string | null;
  source: string;
  correlation_id: string;
  created_at: Date;
}

export const WAGER_TRANSACTION_COLUMNS = `
  id, provider_id, external_transaction_id, idempotency_key, payload_hash,
  wallet_id, player_id, round_id, game_id, kind, amount, currency,
  reference_external_transaction_id, reference_transaction_id, status,
  failure_code, attempts, next_attempt_at, processed_at,
  observed_balance_amount, observed_balance_currency, source, correlation_id,
  created_at
`;

export function rowToDomainState(row: WagerTransactionRow): WagerTransactionState {
  return {
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    amount: row.amount,
    currency: row.currency,
    referenceExternalTransactionId: row.reference_external_transaction_id,
    referenceTransactionId: row.reference_transaction_id,
    status: row.status as WagerTransactionStatus,
    failureCode: row.failure_code,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    processedAt: row.processed_at,
    observedBalanceAmount: row.observed_balance_amount,
    observedBalanceCurrency: row.observed_balance_currency,
    source: row.source,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
  };
}

export function rowToDomain(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate(rowToDomainState(row));
}
