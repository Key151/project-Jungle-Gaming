import { rawExecute } from '../../infrastructure/persistence/raw-sql';
/**
 * WagerTransactionProcessor - o caso de uso central do sistema.
 *
 * ÁEusado TANTO pelo endpoint HTTP quanto pelo consumidor SQS (o enunciado
 * pede explicitamente "reutilizar o mesmo use case"). Ele NÃO abre a
 * transação: recebe um `EntityManager` já dentro de uma transação SQL,
 * para que a transação financeira, o ledger, o inbox e a outbox participem
 * do MESMO commit.
 *
 * Garantis implementadas aqui:
 *  - idempotência: UNIQUE(idempotency_key) no banco + payload_hash;
 *  - concorrência: lock pessimista por wallet (FOR UPDATE) + CHECK >= 0;
 *  - out-of-order: PENDING_REFERENCE + retry com backoff;
 *  - outbox: os eventos são gravados na mesma transação (nunca antes do commit).
 */
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { newId } from '../../shared/ids';
import { hashPayload, JsonValue } from '../../shared/payload-hash';
import { MetricsService } from '../../shared/metrics';
import { Money, MoneyProps } from '../../domain/money';
import {
  Wallet,
  WalletInvariantError,
  InsufficientFundsError,
} from '../../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import {
  IntegrationEvent,
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/integration-event';
import { WalletEntity } from '../../infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { OutboxMessageEntity } from '../../infrastructure/persistence/entities/outbox-message.entity';
import { IdempotencyConflictError } from '../errors';
import {
  SubmitWagerTransactionCommand,
  WagerProcessingOutcome,
} from './wagering.types';
import {
  rowToDomain,
  WAGER_TRANSACTION_COLUMNS,
  WagerTransactionRow,
} from './wager-transaction.mapper';

/**
 * TTL de resolução de referência: 10 tentativas com backoff exponencial
 * (5s, 10s, 20s, 40s, 80s, 160s, 300s, 300s, 300s, 300s) ~ 21 minutos.
 * Depois disso a transação vira REJECTED com REFERENCE_RESOLUTION_TIMEOUT.
 */
export const MAX_REFERENCE_ATTEMPTS = 10;
export const REFERENCE_BACKOFF_BASE_MS = 5_000;
export const REFERENCE_BACKOFF_MAX_MS = 300_000;

const TERMINAL_STATUSES: WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

@Injectable()
export class WagerTransactionProcessor {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Processa uma operação de aposta dentro da transação corrente.
   */
  async process(
    em: EntityManager,
    cmd: SubmitWagerTransactionCommand,
  ): Promise<WagerProcessingOutcome> {
    const startedAt = Date.now();

    // Normaliza o dinheiro ANTES de qualquer coisa: o hash de idempotência
    // tem que ser o mesmo para "25.5" e "25.50" (e entre HTTP e SQS).
    const normalized: SubmitWagerTransactionCommand = {
      ...cmd,
      money: Money.from(cmd.money).toJSON(),
    };

    const payloadHash = hashPayload(businessPayload(normalized));

    const row = await this.loadOrCreate(em, normalized, payloadHash);

    if (row.payload_hash !== payloadHash) {
      // Mesma idempotency key com payload diferente = CONFLITO, não replay.
      this.metrics.increment('wagering_idempotency_conflicts_total', { source: cmd.source });
      throw new IdempotencyConflictError(cmd.idempotencyKey);
    }

    if (TERMINAL_STATUSES.includes(row.status as WagerTransactionStatus)) {
      // Replay: devolve o resultado original (e o saldo observado na
      // época), sem efeito colateral.
      this.metrics.increment('wagering_transactions_total', {
        status: row.status,
        source: cmd.source,
        outcome: 'replay',
      });
      this.metrics.observe('wagering_processing_duration_ms', Date.now() - startedAt);
      return this.toOutcome(row, true);
    }

    this.metrics.increment('wagering_transactions_total', {
      status: row.status,
      source: cmd.source,
      outcome: 'processed',
    });

    const tx = rowToDomain(row);

    // ------------------------------------------------------------------
    // 1) Resolução da referência (REFUND/ROLLBACK podem chegar antes)
    // ------------------------------------------------------------------
    let reference: WagerTransactionRow | null = null;
    if (tx.requiresReference()) {
      const refRow = await this.findByExternalTransactionId(
        em,
        tx.providerId,
        tx.referenceExternalTransactionId as string,
      );

      if (!refRow) {
        return this.markPendingReference(em, tx, cmd);
      }
      if (
        refRow.status === WagerTransactionStatus.Rejected ||
        refRow.status === WagerTransactionStatus.Failed
      ) {
        // A referência é terminal e nunca será aplicada: não há o que reverter.
        return this.reject(em, tx, FailureCode.REFERENCE_NOT_APPLICABLE);
      }
      if (refRow.status !== WagerTransactionStatus.Processed) {
        // A referência ainda está em processamento (PENDING/PENDING_REFERENCE).
        return this.markPendingReference(em, tx, cmd);
      }

      const invalid = this.validateReference(tx, refRow);
      if (invalid) {
        return this.reject(em, tx, invalid);
      }

      const alreadyReversed = await this.findExistingReversal(em, refRow.id);
      if (alreadyReversed) {
        return this.reject(em, tx, FailureCode.REFERENCE_ALREADY_REVERSED);
      }

      reference = refRow;
    }

    // ------------------------------------------------------------------
    // 2) Aplicação no saldo
    // ------------------------------------------------------------------
    // LOSS não mexe no saldo e não gera lançamento: apenas registra o
    // resultado da rodada.
    if (tx.kind === WagerTransactionKind.Loss) {
      const processed = await this.markProcessed(em, tx, undefined, undefined, cmd);
      this.metrics.observe('wagering_processing_duration_ms', Date.now() - startedAt);
      return processed;
    }

    // Lock pessimista POR LINHA da wallet (não é lock global): a segunda
    // transação que disputa o mesmo saldo espera e depois lê o saldo já
    // atualizado - sem lost update.
    const locked = await rawExecute<{ id: string }>(em, 
        'SELECT id FROM wallets WHERE id = ? FOR UPDATE',
        [tx.walletId],
        'get',
      );

    if (!locked) {
      return this.reject(em, tx, FailureCode.WALLET_NOT_FOUND);
    }

    // Identity map limpo: garantimos que o saldo lido é o saldo COMMITADO
    // (o lock já garante que ninguém mais mexe nesta linha agora).
    em.clear();
    const walletEntity = await em.findOne(WalletEntity, tx.walletId);
    if (!walletEntity) {
      return this.reject(em, tx, FailureCode.WALLET_NOT_FOUND);
    }

    if (walletEntity.playerId !== tx.playerId) {
      return this.reject(em, tx, FailureCode.WALLET_OWNERSHIP_MISMATCH);
    }
    if (walletEntity.currency !== tx.money.currency) {
      return this.reject(em, tx, FailureCode.CURRENCY_MISMATCH);
    }

    const domainWallet = Wallet.rehydrate({
      id: walletEntity.id,
      playerId: walletEntity.playerId,
      currency: walletEntity.currency,
      balanceAmount: walletEntity.balanceAmount,
      version: walletEntity.version,
      createdAt: walletEntity.createdAt,
      updatedAt: walletEntity.updatedAt,
    });

    const direction = tx.ledgerDirectionFor(
      reference ? rowToDomain(reference) : undefined,
    );
    const money = tx.money;

    let entry: WalletLedgerEntry;
    try {
      entry =
        direction === LedgerDirection.Debit
          ? domainWallet.debit({ transactionId: tx.id, money })
          : domainWallet.credit({ transactionId: tx.id, money });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // Situações operacionalmente diferentes -> failureCodes diferentes:
        // aposta sem saldo vs. reversão que quebraria o saldo.
        const code =
          tx.kind === WagerTransactionKind.Rollback
            ? FailureCode.REVERSAL_WOULD_NEGATIVE_BALANCE
            : FailureCode.INSUFFICIENT_FUNDS;
        const outcome = await this.reject(em, tx, code, domainWallet.balance);
        this.metrics.observe('wagering_processing_duration_ms', Date.now() - startedAt);
        return outcome;
      }
      throw error;
    }

    // Persistência do agregado (wallet + ledger) - o flush acontece no fim.
    walletEntity.balanceAmount = domainWallet.balance.amount;
    walletEntity.version = domainWallet.version;
    walletEntity.updatedAt = domainWallet.updatedAt;
    em.persist(walletEntity);

    const ledgerEntity = new WalletLedgerEntryEntity();
    ledgerEntity.id = entry.id;
    ledgerEntity.walletId = entry.walletId;
    ledgerEntity.transactionId = entry.transactionId;
    ledgerEntity.direction = entry.direction;
    ledgerEntity.amount = entry.money.amount;
    ledgerEntity.currency = entry.money.currency;
    ledgerEntity.balanceBefore = entry.balanceBefore.amount;
    ledgerEntity.balanceAfter = entry.balanceAfter.amount;
    ledgerEntity.createdAt = entry.createdAt;
    em.persist(ledgerEntity);

    const outcome = await this.markProcessed(
      em,
      tx,
      reference?.id,
      domainWallet.balance,
      cmd,
      { direction, entry, walletVersion: domainWallet.version },
    );

    this.metrics.observe('wagering_processing_duration_ms', Date.now() - startedAt);
    return outcome;
  }

  // --------------------------------------------------------------------
  // Persistência da transação de aposta
  // --------------------------------------------------------------------

  /**
   * Carrega a transação pela idempotency key; se não existir, cria.
   * O INSERT usa ON CONFLICT DO NOTHING: a UNIQUE constraint do banco é a
   * fonte da verdade - duas instâncias competem e apenas uma insere.
   */
  private async loadOrCreate(
    em: EntityManager,
    cmd: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): Promise<WagerTransactionRow> {
    let row = await this.findByIdempotencyKey(em, cmd.idempotencyKey);

    if (!row) {
      const inserted = await this.insertPending(em, cmd, payloadHash);
      if (!inserted) {
        // Outra instância ganhou a corrida: recarrega e decide entre
        // replay e conflito.
        row = await this.findByIdempotencyKey(em, cmd.idempotencyKey);
        if (!row) {
          throw new Error('wager transaction disappeared after insert conflict');
        }
        this.metrics.increment('wagering_duplicate_deliveries_total', { source: cmd.source });
      } else {
        row = inserted;
      }
    } else {
      this.metrics.increment('wagering_duplicate_deliveries_total', { source: cmd.source });
    }

    return row;
  }

  private async findByIdempotencyKey(
    em: EntityManager,
    idempotencyKey: string,
  ): Promise<WagerTransactionRow | null> {
    const rows = await rawExecute<WagerTransactionRow[]>(em, 
        `SELECT ${WAGER_TRANSACTION_COLUMNS} FROM wager_transactions WHERE idempotency_key = ?`,
        [idempotencyKey],
        'all',
      );
    return rows.length > 0 ? rows[0] : null;
  }

  private async findByExternalTransactionId(
    em: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionRow | null> {
    const rows = await rawExecute<WagerTransactionRow[]>(em, 
        `SELECT ${WAGER_TRANSACTION_COLUMNS} FROM wager_transactions
         WHERE provider_id = ? AND external_transaction_id = ?`,
        [providerId, externalTransactionId],
        'all',
      );
    return rows.length > 0 ? rows[0] : null;
  }

  /** Procura uma reversão já PROCESSED que aponte para a referência. */
  private async findExistingReversal(
    em: EntityManager,
    referenceTransactionId: string,
  ): Promise<boolean> {
    const rows = await rawExecute<{ exists: boolean }>(em, 
        `SELECT EXISTS (
           SELECT 1 FROM wager_transactions
           WHERE reference_transaction_id = ?
             AND kind IN ('REFUND', 'ROLLBACK')
             AND status = 'PROCESSED'
         ) AS exists`,
        [referenceTransactionId],
        'get',
      );
    return Boolean(rows?.exists);
  }

  private async insertPending(
    em: EntityManager,
    cmd: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): Promise<WagerTransactionRow | null> {
    const id = newId();
    const now = new Date();

    const rows = await rawExecute<WagerTransactionRow[]>(
      em,
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency,
         reference_external_transaction_id, reference_transaction_id, status,
         failure_code, attempts, next_attempt_at, processed_at,
         observed_balance_amount, observed_balance_currency, source,
         correlation_id, created_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'PENDING',
         NULL, 0, NULL, NULL, NULL, NULL, ?, ?, ?
       )
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${WAGER_TRANSACTION_COLUMNS}`,
      [
        id,
        cmd.providerId,
        cmd.externalTransactionId,
        cmd.idempotencyKey,
        payloadHash,
        cmd.walletId,
        cmd.playerId,
        cmd.roundId,
        cmd.gameId,
        cmd.kind,
        cmd.money.amount,
        cmd.money.currency,
        cmd.referenceExternalTransactionId ?? null,
        cmd.source,
        cmd.correlationId,
        now,
      ],
      'all',
    );

    return rows.length > 0 ? rows[0] : null;
  }

  private async updateRow(
    em: EntityManager,
    id: string,
    fields: {
      status?: WagerTransactionStatus;
      failureCode?: string | null;
      referenceTransactionId?: string | null;
      processedAt?: Date | null;
      observedBalance?: Money | null;
      attempts?: number;
      nextAttemptAt?: Date | null;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    const push = (column: string, value: unknown) => {
      params.push(value);
      // O MikroORM v7 usa placeholders "?" (o driver formata e escapa os
      // valores) — a ordem dos params segue a ordem dos "?" na query.
      sets.push(`${column} = ?`);
    };

    if (fields.status !== undefined) push('status', fields.status);
    if (fields.failureCode !== undefined) push('failure_code', fields.failureCode);
    if (fields.referenceTransactionId !== undefined)
      push('reference_transaction_id', fields.referenceTransactionId);
    if (fields.processedAt !== undefined) push('processed_at', fields.processedAt);
    if (fields.observedBalance !== undefined) {
      push('observed_balance_amount', fields.observedBalance?.amount ?? null);
      push('observed_balance_currency', fields.observedBalance?.currency ?? null);
    }
    if (fields.attempts !== undefined) push('attempts', fields.attempts);
    if (fields.nextAttemptAt !== undefined) push('next_attempt_at', fields.nextAttemptAt);

    if (sets.length === 0) return;

    params.push(id);
    await rawExecute<unknown>(
      em,
      `UPDATE wager_transactions SET ${sets.join(', ')} WHERE id = ?`,
      params,
      'run',
    );
  }

  // --------------------------------------------------------------------
  // Fluxos de finalização
  // --------------------------------------------------------------------

  private async markPendingReference(
    em: EntityManager,
    tx: WagerTransaction,
    cmd: SubmitWagerTransactionCommand,
  ): Promise<WagerProcessingOutcome> {
    const attempt = tx.attempts + 1;

    if (attempt >= MAX_REFERENCE_ATTEMPTS) {
      // TTL estourado: rejeita de forma terminal e auditável.
      return this.reject(em, tx, FailureCode.REFERENCE_RESOLUTION_TIMEOUT);
    }

    const nextAttemptAt = new Date(Date.now() + backoffFor(attempt));
    tx.markPendingReference();
    tx.registerReferenceAttempt(nextAttemptAt);

    await this.updateRow(em, tx.id, {
      status: WagerTransactionStatus.PendingReference,
      attempts: attempt,
      nextAttemptAt,
    });

    const event = WagerTransactionPendingReference.from({
      eventId: newId(),
      correlationId: cmd.correlationId,
      causationId: tx.id,
      occurredAt: new Date(),
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      playerId: tx.playerId,
      walletId: tx.walletId,
      referenceExternalTransactionId: tx.referenceExternalTransactionId as string,
      attempts: attempt,
      nextAttemptAt,
    });
    await this.enqueueEvent(em, event);

    await em.flush();

    this.metrics.increment('wagering_pending_reference_total', { source: cmd.source });

    return {
      status: WagerTransactionStatus.PendingReference,
      transaction: tx,
      idempotentReplay: false,
    };
  }

  private async reject(
    em: EntityManager,
    tx: WagerTransaction,
    failureCode: FailureCode,
    observedBalance?: Money,
  ): Promise<WagerProcessingOutcome> {
    tx.reject(failureCode);
    if (observedBalance) tx.setObservedBalance(observedBalance);

    await this.updateRow(em, tx.id, {
      status: WagerTransactionStatus.Rejected,
      failureCode,
      processedAt: new Date(),
      observedBalance: observedBalance ?? null,
    });

    const event = WagerTransactionRejected.from({
      eventId: newId(),
      correlationId: tx.correlationId,
      causationId: tx.id,
      occurredAt: new Date(),
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      playerId: tx.playerId,
      walletId: tx.walletId,
      roundId: tx.roundId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      failureCode,
      ...(observedBalance ? { balance: observedBalance.toJSON() } : {}),
    });
    await this.enqueueEvent(em, event);

    await em.flush();

    this.metrics.increment('wagering_rejections_total', { failure_code: failureCode });

    return {
      status: WagerTransactionStatus.Rejected,
      transaction: tx,
      idempotentReplay: false,
      failureCode,
      ...(observedBalance ? { balance: observedBalance.toJSON() } : {}),
    };
  }

  private async markProcessed(
    em: EntityManager,
    tx: WagerTransaction,
    referenceTransactionId: string | undefined,
    balance: Money | undefined,
    cmd: SubmitWagerTransactionCommand,
    context?: { direction: LedgerDirection; entry: WalletLedgerEntry; walletVersion: number },
  ): Promise<WagerProcessingOutcome> {
    const at = new Date();
    tx.markProcessed(referenceTransactionId, at);
    if (balance) tx.setObservedBalance(balance);

    await this.updateRow(em, tx.id, {
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: referenceTransactionId ?? null,
      processedAt: at,
      observedBalance: balance ?? null,
    });

    const processedEvent = WagerTransactionProcessed.from({
      eventId: newId(),
      correlationId: cmd.correlationId,
      causationId: tx.id,
      occurredAt: at,
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      playerId: tx.playerId,
      walletId: tx.walletId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      status: WagerTransactionStatus.Processed,
      money: tx.money.toJSON(),
      ...(balance ? { balanceAfter: balance.toJSON() } : {}),
    });
    await this.enqueueEvent(em, processedEvent);

    // WalletBalanceChanged só quando o saldo muda.
    if (context && balance) {
      const balanceEvent = WalletBalanceChanged.from({
        eventId: newId(),
        correlationId: cmd.correlationId,
        causationId: tx.id,
        occurredAt: at,
        walletId: tx.walletId,
        transactionId: tx.id,
        direction: context.direction,
        money: context.entry.money.toJSON(),
        balanceBefore: context.entry.balanceBefore.toJSON(),
        balanceAfter: context.entry.balanceAfter.toJSON(),
        walletVersion: context.walletVersion,
      });
      await this.enqueueEvent(em, balanceEvent);
    }

    await em.flush();

    return {
      status: WagerTransactionStatus.Processed,
      transaction: tx,
      idempotentReplay: false,
      ...(balance ? { balance: balance.toJSON() } : {}),
    };
  }

  /**
   * Grava o evento na outbox - NA MESMA transação da alteração financeira.
   * (O evento só é publicado depois do commit, pelo OutboxPublisher.)
   */
  private async enqueueEvent(em: EntityManager, event: IntegrationEvent<unknown>): Promise<void> {
    const entity = new OutboxMessageEntity();
    entity.id = event.eventId;
    entity.aggregateId = event.aggregateId;
    entity.eventType = event.eventType;
    entity.eventVersion = event.version;
    entity.payload = event.toJSON() as unknown as Record<string, unknown>;
    entity.occurredAt = event.occurredAt;
    entity.attempts = 0;
    entity.nextAttemptAt = null;
    entity.publishedAt = null;
    entity.lockedUntil = null;
    entity.correlationId = event.correlationId;
    em.persist(entity);
  }

  // --------------------------------------------------------------------
  // Regras de referência
  // --------------------------------------------------------------------

  private validateReference(
    tx: WagerTransaction,
    reference: WagerTransactionRow,
  ): FailureCode | null {
    // Mesma provider (garantido pela busca), player, wallet, moeda e rodada.
    if (
      reference.player_id !== tx.playerId ||
      reference.wallet_id !== tx.walletId ||
      reference.currency !== tx.money.currency ||
      reference.round_id !== tx.roundId
    ) {
      return FailureCode.REFERENCE_SCOPE_MISMATCH;
    }

    if (tx.kind === WagerTransactionKind.Refund) {
      // REFUND só referencia BET.
      if (reference.kind !== WagerTransactionKind.Bet) {
        return FailureCode.REFERENCE_KIND_NOT_REVERSIBLE;
      }
    } else if (tx.kind === WagerTransactionKind.Rollback) {
      // ROLLBACK referencia BET, WIN ou REFUND.
      if (
        reference.kind !== WagerTransactionKind.Bet &&
        reference.kind !== WagerTransactionKind.Win &&
        reference.kind !== WagerTransactionKind.Refund
      ) {
        return FailureCode.REFERENCE_KIND_NOT_REVERSIBLE;
      }
    }

    // Reversão parcial está fora de escopo: o valor precisa ser igual.
    if (!Money.from({ amount: reference.amount, currency: reference.currency }).equals(tx.money)) {
      return FailureCode.REFERENCE_AMOUNT_MISMATCH;
    }

    return null;
  }

  // --------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------

  private toOutcome(row: WagerTransactionRow, idempotentReplay: boolean): WagerProcessingOutcome {
    const tx = rowToDomain(row);
    const balance: MoneyProps | undefined =
      row.observed_balance_amount && row.observed_balance_currency
        ? { amount: row.observed_balance_amount, currency: row.observed_balance_currency }
        : undefined;

    return {
      status: tx.status,
      transaction: tx,
      idempotentReplay,
      ...(balance ? { balance } : {}),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    };
  }
}

/**
 * Subconjunto de campos de negócio que entra no hash de idempotência.
 * NÃO entram: o header Idempotency-Key, source (HTTP/SQS), messageId,
 * timestamps - assim a mesma operação via HTTP ou via fila tem o mesmo hash.
 */
export function businessPayload(cmd: SubmitWagerTransactionCommand): JsonValue {
  return {
    providerId: cmd.providerId,
    externalTransactionId: cmd.externalTransactionId,
    playerId: cmd.playerId,
    walletId: cmd.walletId,
    roundId: cmd.roundId,
    gameId: cmd.gameId,
    kind: cmd.kind,
    money: { amount: cmd.money.amount, currency: cmd.money.currency },
    referenceExternalTransactionId: cmd.referenceExternalTransactionId ?? null,
  };
}

export function backoffFor(attempt: number): number {
  const delay = REFERENCE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, REFERENCE_BACKOFF_MAX_MS);
}
