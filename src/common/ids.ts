import { randomUUID } from 'node:crypto';

/** Gera um id (entidade, transação, correlation id...). */
export function newId(): string {
  return randomUUID();
}
