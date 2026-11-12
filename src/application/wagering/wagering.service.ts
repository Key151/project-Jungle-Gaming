/**
 * WageringService - casos de uso de leitura e o wrapper transacional do
 * processador.
 *
 * `submit` é usado pelo HTTP e pelo consumidor SQS - o mesmo use case,
 * como pede o enunciado.
 */
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionEntity } from '../../infrastructure/persistence/entities/wager-transaction.entity';
import { EntityNotFoundError } from '../errors';
import { WagerTransactionProcessor } from './wager-transaction.processor';
import { SubmitWagerTransactionCommand, WagerProcessingOutcome } from './wagering.types';

@Injectable()
export class WageringService {
  constructor(
    private readonly em: EntityManager,
    private readonly processor: WagerTransactionProcessor,
  ) {}

  /**
   * Aplica a operação. A transação SQL aberta aqui contém:
   * transação de aposta + saldo + ledger + (inbox) + outbox.
   */
  async submit(cmd: SubmitWagerTransactionCommand): Promise<WagerProcessingOutcome> {
    return this.em.fork({ clear: true }).transactional(async (tx) => {
      return this.processor.process(tx, cmd);
    });
  }

  async findById(transactionId: string): Promise<WagerTransaction> {
    const entity = await this.em
      .fork({ clear: true })
      .findOne(WagerTransactionEntity, transactionId);
    if (!entity) {
      throw new EntityNotFoundError('wager transaction', transactionId);
    }
    return toDomain(entity);
  }

  async findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    const entity = await this.em
      .fork({ clear: true })
      .findOne(WagerTransactionEntity, {
        providerId,
        externalTransactionId,
      });
    if (!entity) {
      throw new EntityNotFoundError('wager transaction', externalTransactionId);
    }
    return toDomain(entity);
  }
}

function toDomain(entity: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash,
    walletId: entity.walletId,
    playerId: entity.playerId,
    roundId: entity.roundId,
    gameId: entity.gameId,
    kind: entity.kind as WagerTransaction['kind'],
    amount: entity.amount,
    currency: entity.currency,
    referenceExternalTransactionId: entity.referenceExternalTransactionId,
    referenceTransactionId: entity.referenceTransactionId,
    status: entity.status as WagerTransaction['status'],
    failureCode: entity.failureCode as string | null,
    attempts: entity.attempts,
    nextAttemptAt: entity.nextAttemptAt,
    processedAt: entity.processedAt,
    observedBalanceAmount: entity.observedBalanceAmount,
    observedBalanceCurrency: entity.observedBalanceCurrency,
    source: entity.source,
    correlationId: entity.correlationId,
    createdAt: entity.createdAt,
  });
}
