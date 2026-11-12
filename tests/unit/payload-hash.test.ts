/**
 * Testes unitários do hash de idempotência (JSON canônico + SHA-256).
 */
import { describe, expect, test } from 'bun:test';
import { canonicalJson, hashPayload, sha256 } from '../../src/shared/payload-hash';

describe('payload hash', () => {
  test('JSON canônico ordena as chaves recursivamente', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } });
    const b = canonicalJson({ a: { c: [{ e: 4, f: 3 }], d: 2 }, b: 1 });

    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}');
  });

  test('mesmo payload em ordens diferentes gera o mesmo hash', () => {
    const h1 = hashPayload({ providerId: 'p', kind: 'BET', amount: '25.00' });
    const h2 = hashPayload({ amount: '25.00', kind: 'BET', providerId: 'p' });

    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  test('payload diferente gera hash diferente', () => {
    const h1 = hashPayload({ providerId: 'p', amount: '25.00' });
    const h2 = hashPayload({ providerId: 'p', amount: '26.00' });

    expect(h1).not.toBe(h2);
  });

  test('sha256 é determinístico', () => {
    expect(sha256('jungle')).toBe(sha256('jungle'));
    expect(sha256('jungle')).toHaveLength(64);
  });
});
