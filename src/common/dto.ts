import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { WagerTransactionKind } from '../wagering/wager-transaction';

/**
 * DTO de dinheiro. A validação aqui é "de borda" (formato); a regra de
 * negócio (escala, moeda, não-negatividade) é validada de novo pelo
 * domínio, que é a fonte da verdade.
 */
export class MoneyDto {
  @IsString({ message: 'amount must be a decimal string' })
  @Matches(/^(0|[1-9]\d{0,17})(\.\d{1,2})?$/, {
    message: 'amount must be a non-negative decimal string with at most 2 decimal places',
  })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code (e.g. BRL)' })
  currency!: string;
}

export class CreateWalletDto {
  @IsString()
  @IsNotEmpty()
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class SubmitWagerTransactionDto {
  @IsString()
  @IsNotEmpty()
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  externalTransactionId!: string;

  @IsString()
  @IsNotEmpty()
  playerId!: string;

  @IsString()
  @IsNotEmpty()
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  gameId!: string;

  @IsEnum(WagerTransactionKind, {
    message: `kind must be one of ${Object.values(WagerTransactionKind).join(', ')}`,
  })
  kind!: WagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  referenceExternalTransactionId?: string;
}
