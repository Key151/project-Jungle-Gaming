/**
 * Erros de aplicação (não são erros de domínio de negócio — são erros de
 * protocolo/API). O `DomainExceptionFilter` traduz cada um para um status
 * HTTP estável.
 */

export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(
      `idempotency key "${idempotencyKey}" was already used with a different payload`,
    );
    this.name = 'IdempotencyConflictError';
  }
}

export class DuplicateWalletError extends Error {
  constructor(public readonly playerId: string, public readonly currency: string) {
    super(`wallet already exists for player ${playerId} in ${currency}`);
    this.name = 'DuplicateWalletError';
  }
}

export class EntityNotFoundError extends Error {
  constructor(public readonly entity: string, public readonly id: string) {
    super(`${entity} "${id}" not found`);
    this.name = 'EntityNotFoundError';
  }
}

export class InvalidPayloadError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

/**
 * Erro permanente de infraestrutura (ex.: payload de fila inválido).
 * Vai para a DLQ — não é retentável.
 */
export class PermanentMessageError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'PermanentMessageError';
  }
}

/**
 * Erro transitório de infraestrutura (ex.: PostgreSQL indisponível).
 * A mensagem volta para a fila (visibility timeout) e, se persistir, vai
 * para a DLQ pela redrive policy.
 */
export class TransientInfrastructureError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'TransientInfrastructureError';
  }
}
