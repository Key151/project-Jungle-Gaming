/**
 * Diagnóstico: 50 requisições paralelas com a MESMA idempotency key.
 * Mostra a distribuição de status e os erros.
 *
 *   bun scripts/diag-parallel.ts
 */
export {}; // transforma em módulo (permite await no topo no typecheck)

const BASE = 'http://localhost:3000';

const playerId = `diag-${Math.random().toString(36).slice(2)}`;

const created: any = await (
  await fetch(`${BASE}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
  })
).json();

const wallet = created;
console.log('wallet:', wallet.id, wallet.balance);

const externalTransactionId = `ext-${Math.random().toString(36).slice(2)}`;
const body = {
  providerId: 'provider-a',
  externalTransactionId,
  playerId,
  walletId: wallet.id,
  roundId: 'round-diag',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '30.00', currency: 'BRL' },
};

const responses = await Promise.all(
  Array.from({ length: 50 }, () =>
    fetch(`${BASE}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `provider-a:${externalTransactionId}` },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any })),
  ),
);

const byStatus: Record<number, number> = {};
for (const r of responses) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
console.log('status:', byStatus);

const replays = responses.filter((r) => r.body.idempotentReplay === true).length;
console.log('idempotentReplay=true:', replays);

const ids = new Set(responses.map((r) => r.body.transactionId));
console.log('transactionIds distintos:', ids.size);

const errors = responses.filter((r) => r.status >= 400);
for (const e of errors.slice(0, 3)) console.log('ERRO:', e.status, JSON.stringify(e.body).slice(0, 300));

const after = await (await fetch(`${BASE}/wallets/${wallet.id}`)).json();
console.log('saldo final:', after.balance);

const ledger = await (await fetch(`${BASE}/wallets/${wallet.id}/ledger?limit=50`)).json();
console.log('lançamentos:', ledger.entries?.length);
