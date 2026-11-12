/**
 * Filtro global de exceções: traduz erros do domínio/aplicação para status
 * HTTP estáveis e consistentes em TODOS os endpoints.
 *
 * Mapeamento (documentado no README):
 *   400 INVALID_PAYLOAD       — payload inválido / campo ausente
 *   404 NOT_FOUND             — recurso inexistente
 *   409 IDEMPOTENCY_CONFLICT  — mesma key, payload diferente
 *   409 WALLET_ALREADY_EXISTS — wallet duplicada (playerId + currency)
 *   422 BUSINESS_RULE_VIOLATION — rejeição por regra de negócio (REJECTED)
 *   503 INFRASTRUCTURE_ERROR  — falha transitória (pode reenviar)
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { CurrencyMismatchError, InvalidMoneyError } from '../../domain/money';
import { InvalidTransactionStateError } from '../../domain/wager-transaction';
import {
  DuplicateWalletError,
  EntityNotFoundError,
  IdempotencyConflictError,
  InvalidPayloadError,
  TransientInfrastructureError,
} from '../../application/errors';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  failureCode?: string;
  details?: unknown;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const body = this.toBody(exception);

    if (body.statusCode >= 500) {
      this.logger.error(
        `${body.code}: ${body.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof IdempotencyConflictError) {
      return {
        statusCode: HttpStatus.CONFLICT,
        code: 'IDEMPOTENCY_CONFLICT',
        message: exception.message,
      };
    }

    if (exception instanceof DuplicateWalletError) {
      return {
        statusCode: HttpStatus.CONFLICT,
        code: 'WALLET_ALREADY_EXISTS',
        message: exception.message,
      };
    }

    if (exception instanceof EntityNotFoundError) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        code: 'NOT_FOUND',
        message: exception.message,
      };
    }

    if (exception instanceof TransientInfrastructureError) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'INFRASTRUCTURE_ERROR',
        message: exception.message,
      };
    }

    if (
      exception instanceof InvalidPayloadError ||
      exception instanceof InvalidMoneyError ||
      exception instanceof CurrencyMismatchError ||
      exception instanceof InvalidTransactionStateError
    ) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'INVALID_PAYLOAD',
        message: exception.message,
        ...(exception instanceof InvalidPayloadError && exception.details
          ? { details: exception.details }
          : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: unknown })?.message as string | string[]) ?? exception.message;

      return {
        statusCode: status,
        code: status === HttpStatus.BAD_REQUEST ? 'INVALID_PAYLOAD' : 'REQUEST_ERROR',
        message: Array.isArray(message) ? message.join('; ') : message,
        details: typeof payload === 'object' ? payload : undefined,
      };
    }

    // Erros de infraestrutura (PostgreSQL/SQS fora do ar) — transitórios.
    if (isInfrastructureError(exception)) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'INFRASTRUCTURE_ERROR',
        message: 'temporarily unavailable, please retry',
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'internal error',
    };
  }
}

function isInfrastructureError(exception: unknown): boolean {
  if (!(exception instanceof Error)) return false;
  const code = (exception as Error & { code?: string }).code;
  if (!code) return false;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === '57P01' || // postgres: admin_shutdown
    code === '57P02' || // postgres: crash_shutdown
    code === '57P03' || // postgres: cannot_connect_now
    code === '53300' || // postgres: too_many_connections
    code === '40001' || // postgres: serialization_failure
    code === '40P01' // postgres: deadlock_detected
  );
}
