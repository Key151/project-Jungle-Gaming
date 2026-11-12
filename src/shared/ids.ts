import { randomUUID } from 'node:crypto';

/** Identificador de agregado/entidade. */
export function newId(): string {
  return randomUUID();
}
