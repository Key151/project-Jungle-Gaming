/**
 * Hash de idempotência.
 *
 * O hash cobre APENAS o subconjunto de campos de negócio. O header
 * `Idempotency-Key` e metadados de transporte (source HTTP/SQS, timestamps,
 * messageId) NÃO entram no hash — assim a mesma operação enviada pelo
 * HTTP e pela fila produz o mesmo hash.
 *
 * Algoritmo: SHA-256 (hex) sobre o JSON canônico (chaves ordenadas
 * recursivamente, sem espaços). Documentado em ARCHITECTURE.md.
 */
import { createHash } from 'node:crypto';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Serializa um valor JSON de forma canônica (chaves ordenadas). */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Hash canônico de um payload de negócio. */
export function hashPayload(payload: JsonValue): string {
  return sha256(canonicalJson(payload));
}
