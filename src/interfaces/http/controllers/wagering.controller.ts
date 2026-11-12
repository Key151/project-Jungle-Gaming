import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { WagerTransactionKind } from '../../../domain/wager-transaction';
import { WageringService } from '../../../application/wagering/wagering.service';
import { InvalidPayloadError } from '../../../application/errors';
import { NoOpAuthGuard } from '../auth/no-op-auth.guard';
import { SubmitWagerTransactionDto } from '../dto/wagering.dto';

@Controller()
@UseGuards(NoOpAuthGuard)
export class WageringController {
  constructor(private readonly wageringService: WageringService) {}

  /**
   * POST /wagering/transactions
   *
   * Status HTTP (consistente com o resto da API):
   *   201 — transação aplicada (PROCESSED)
   *   200 — replay idempotente (idempotentReplay: true)
   *   202 — aceite, aguardando referência (PENDING_REFERENCE)
   *   422 — rejeitada por regra de negócio (REJECTED + failureCode)
   *   409 — conflito de idempotência (mesma key, payload diferente)
   *   400 — payload inválido
   *   503 — falha transitória de infraestrutura
   */
  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: SubmitWagerTransactionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new InvalidPayloadError('Idempotency-Key header is required');
    }
    if (dto.kind === WagerTransactionKind.Opening) {
      throw new InvalidPayloadError('OPENING is an internal kind and cannot be submitted');
    }

    const outcome = await this.wageringService.submit({
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: dto.money,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
      source: 'HTTP',
      correlationId: (res.getHeader('x-correlation-id') as string) ?? 'unknown',
    });

    const body = {
      transactionId: outcome.transaction.id,
      status: outcome.status,
      balance: outcome.balance,
      idempotentReplay: outcome.idempotentReplay,
      ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
    };

    if (outcome.status === 'PENDING_REFERENCE') {
      res.status(HttpStatus.ACCEPTED);
    } else if (outcome.status === 'REJECTED') {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY);
    } else if (outcome.idempotentReplay) {
      res.status(HttpStatus.OK);
    } else {
      res.status(HttpStatus.CREATED);
    }

    return body;
  }

  @Get('wagering/transactions/:transactionId')
  async findOne(@Param('transactionId') transactionId: string) {
    const transaction = await this.wageringService.findById(transactionId);
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId,
      status: transaction.status,
      failureCode: transaction.failureCode,
      attempts: transaction.attempts,
      nextAttemptAt: transaction.nextAttemptAt,
      processedAt: transaction.processedAt,
      observedBalance: transaction.observedBalance?.toJSON(),
      createdAt: transaction.createdAt,
    };
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const transaction = await this.wageringService.findByProviderExternal(
      providerId,
      externalTransactionId,
    );
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId,
      status: transaction.status,
      failureCode: transaction.failureCode,
      attempts: transaction.attempts,
      processedAt: transaction.processedAt,
      observedBalance: transaction.observedBalance?.toJSON(),
      createdAt: transaction.createdAt,
    };
  }
}
