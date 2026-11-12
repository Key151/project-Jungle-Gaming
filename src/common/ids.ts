import { randomUUID } from 'node:crypto';

/** Gera um id (entidade, transação, correlation id...). */
export function newId(): string {
  return randomUUID();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O id do banco é uuid: se não for, é um id inválido (404, não 500). */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
