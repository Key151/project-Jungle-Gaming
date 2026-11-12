import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WalletService } from './wallet.service';
import { NoOpAuthGuard } from '../common/auth.guard';
import { CreateWalletDto } from '../common/dto';

@Controller('wallets')
@UseGuards(NoOpAuthGuard)
export class WalletsController {
  constructor(private readonly walletService: WalletService) {}

  /**
   * POST /wallets
   * O saldo inicial (quando > 0) gera uma transação interna OPENING e o
   * lançamento CREDIT correspondente, na mesma transação SQL.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateWalletDto) {
    const result = await this.walletService.create({
      playerId: dto.playerId,
      initialBalance: dto.initialBalance,
    });

    return {
      id: result.wallet.id,
      playerId: result.wallet.playerId,
      balance: result.wallet.balance.toJSON(),
      version: result.wallet.version,
    };
  }

  @Get(':walletId')
  async findOne(@Param('walletId') walletId: string) {
    const wallet = await this.walletService.findById(walletId);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  /** Ledger com cursor opaco e estável. */
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 50;
    const page = await this.walletService.listLedger(
      walletId,
      cursor,
      Number.isFinite(parsedLimit) ? parsedLimit : 50,
    );

    return {
      walletId,
      entries: page.entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.amount,
        balanceBefore: entry.balanceBefore,
        balanceAfter: entry.balanceAfter,
        createdAt: entry.createdAt,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Reconciliação: recalcula o saldo a partir do ledger e compara com o
   * saldo materializado. Divergências são logadas, contabilizadas em
   * métrica e devolvidas na resposta — nunca corrigidas silenciosamente.
   */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string) {
    return this.walletService.reconcile(walletId);
  }
}
