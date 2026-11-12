/**
 * Correlation id.
 *
 * Usamos AsyncLocalStorage para propagar o correlationId (header
 * `x-correlation-id`) por toda a requisição — inclusive para os workers
 * (SQS/outbox), que geram o seu próprio.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const storage = new AsyncLocalStorage<{ correlationId: string }>();

export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

export function getCorrelationId(): string {
  return storage.getStore()?.correlationId ?? 'unknown';
}

export function newCorrelationId(): string {
  return randomUUID();
}
