/**
 * Helper de SQL cru ("raw") dentro do MikroORM v7.
 *
 * IMPORTANTE: `em.getConnection().execute(...)` sozinho NÃO é transacional:
 * sem o `ctx` (contexto de transação) a query sai pelo pool, fora da
 * transação. Passando `em.getTransactionContext()`, a query roda na mesma
 * conexão (e portanto na mesma transação) das queries do ORM.
 *
 * Isso é essencial para a atomicidade exigida pelo desafio: transação
 * financeira + ledger + inbox + outbox no MESMO commit.
 */
import { EntityManager } from '@mikro-orm/core';

export async function rawExecute<T>(
  em: EntityManager,
  query: string,
  params: readonly unknown[] = [],
  method: 'all' | 'get' | 'run' = 'all',
): Promise<T> {
  const ctx = em.getTransactionContext();
  return em
    .getConnection()
    .execute<T>(query, params as unknown[], method, ctx as never) as unknown as Promise<T>;
}

/** Executa e devolve as linhas (array). */
export function rawAll<T>(
  em: EntityManager,
  query: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return rawExecute<T[]>(em, query, params, 'all');
}

/** Executa e devolve a primeira linha (ou null). */
export async function rawGet<T>(
  em: EntityManager,
  query: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const row = await rawExecute<T | null>(em, query, params, 'get');
  return row ?? null;
}

/** Executa um comando sem retorno de linhas (INSERT/UPDATE/DELETE). */
export async function rawRun(
  em: EntityManager,
  query: string,
  params: readonly unknown[] = [],
): Promise<void> {
  await rawExecute<unknown>(em, query, params, 'run');
}
