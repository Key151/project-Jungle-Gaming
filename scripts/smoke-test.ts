/**
 * Smoke test: exercita a API inteira e imprime PASS/FAIL de cada cenário.
 *
 *   bun run smoke
 *
 * Precisa da aplicação no ar (docker compose up -d --build).
 * Não precisa de acesso direto ao banco: só usa a API HTTP.
 */
const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:3000';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

async function api(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* não-JSON */
  }
  return { status: response.status, body };
}

async function waitForApp(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health/live`);
      if (response.ok) return true;
    } catch {
      /* ainda não subiu */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function bet(
  wallet: { id: string; playerId: string },
  options: {
    kind?: string;
    amount?: string;
    externalTransactionId?: string;
    roundId?: string;
    referenceExternalTransactionId?: string;
  } = {},
) {
  const externalTransactionId =
    options.externalTransactionId ?? `ext-${Math.random().toString(36).slice(2)}`;

  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: options.roundId ?? `round-${Math.random().toString(36).slice(2)}`,
      gameId: 'fortune-chimp',
      kind: options.kind ?? 'BET',
      money: { amount: options.amount ?? '25.00', currency: 'BRL' },
      ...(options.referenceExternalTransactionId
        ? { referenceExternalTransactionId: options.referenceExternalTransactionId }
        : {}),
    },
  };
}

async function main(): Promise<void> {
  console.log(`\n== Smoke test em ${BASE_URL} ==\n`);

  if (!(await waitForApp())) {
    console.error(
      'A aplicação não respondeu em /health/live.\n' +
        'Suba com: docker compose up -d --build\n',
    );
    process.exit(1);
  }

  // ------------------------------------------------------------------
  console.log('health');
  const live = await api('GET', '/health/live');
  check('GET /health/live = 200', live.status === 200, live.body);

  const ready = await api('GET', '/health/ready');
  check('Postgres alcançável', ready.body?.checks?.postgres?.ok === true, ready.body);
  if (!ready.body?.checks?.sqs?.ok) {
    console.log(
      '  --   SQS não está no ar (ok se você está rodando sem Docker/LocalStack)',
    );
  }

  // ------------------------------------------------------------------
  console.log('\nwallet');
  const playerId = `player-${Math.random().toString(36).slice(2)}`;
  const created = await api('POST', '/wallets', {
    body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
  });
  check('POST /wallets = 201', created.status === 201, created.body);
  check(
    'saldo inicial 1000.00 e version 1',
    created.body?.balance?.amount === '1000.00' && created.body?.version === 1,
    created.body,
  );

  const wallet = created.body;
  const duplicate = await api('POST', '/wallets', {
    body: { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } },
  });
  check('wallet duplicada = 409', duplicate.status === 409, duplicate.body);

  const invalid = await api('POST', '/wallets', {
    body: { playerId: 'x', initialBalance: { amount: '10.000', currency: 'BRL' } },
  });
  check('payload inválido = 400', invalid.status === 400, invalid.body);

  // ------------------------------------------------------------------
  console.log('\nidempotência');
  const first = bet(wallet, { amount: '25.00' });
  const betResponse = await api('POST', '/wagering/transactions', {
    body: first.body,
    headers: { 'idempotency-key': first.idempotencyKey },
  });
  check('BET = 201 PROCESSED', betResponse.status === 201, betResponse.body);
  check(
    'saldo após BET = 975.00',
    betResponse.body?.balance?.amount === '975.00',
    betResponse.body,
  );

  const replay = await api('POST', '/wagering/transactions', {
    body: first.body,
    headers: { 'idempotency-key': first.idempotencyKey },
  });
  check('replay = 200 com idempotentReplay=true', replay.status === 200 && replay.body?.idempotentReplay === true, replay.body);
  check('replay devolve a mesma transação', replay.body?.transactionId === betResponse.body?.transactionId, replay.body);

  const conflict = await api('POST', '/wagering/transactions', {
    body: { ...first.body, money: { amount: '30.00', currency: 'BRL' } },
    headers: { 'idempotency-key': first.idempotencyKey },
  });
  check('mesma key + payload diferente = 409', conflict.status === 409, conflict.body);

  const noKey = await api('POST', '/wagering/transactions', { body: first.body });
  check('sem Idempotency-Key = 400', noKey.status === 400, noKey.body);

  // ------------------------------------------------------------------
  console.log('\nregras de negócio');
  const loss = bet(wallet, { kind: 'LOSS', amount: '25.00' });
  const lossResponse = await api('POST', '/wagering/transactions', {
    body: loss.body,
    headers: { 'idempotency-key': loss.idempotencyKey },
  });
  check('LOSS = 201 PROCESSED', lossResponse.body?.status === 'PROCESSED', lossResponse.body);
  check('LOSS não mexe no saldo', lossResponse.body?.balance?.amount === '975.00', lossResponse.body);

  const win = bet(wallet, { kind: 'WIN', amount: '50.00' });
  const winResponse = await api('POST', '/wagering/transactions', {
    body: win.body,
    headers: { 'idempotency-key': win.idempotencyKey },
  });
  check('WIN credita = 1025.00', winResponse.body?.balance?.amount === '1025.00', winResponse.body);

  const refunded = bet(wallet, { kind: 'REFUND', amount: '25.00', referenceExternalTransactionId: first.body.externalTransactionId });
  const refundResponse = await api('POST', '/wagering/transactions', {
    body: refunded.body,
    headers: { 'idempotency-key': refunded.idempotencyKey },
  });
  check('REFUND da BET credita de volta = 1050.00', refundResponse.body?.balance?.amount === '1050.00', refundResponse.body);

  const refundTwice = bet(wallet, { kind: 'REFUND', amount: '25.00', referenceExternalTransactionId: first.body.externalTransactionId });
  const refundTwiceResponse = await api('POST', '/wagering/transactions', {
    body: refundTwice.body,
    headers: { 'idempotency-key': refundTwice.idempotencyKey },
  });
  check(
    'segundo REFUND = 422 REFERENCE_ALREADY_REVERSED',
    refundTwiceResponse.status === 422 && refundTwiceResponse.body?.failureCode === 'REFERENCE_ALREADY_REVERSED',
    refundTwiceResponse.body,
  );

  const pending = bet(wallet, { kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: 'bet-que-nao-existe' });
  const pendingResponse = await api('POST', '/wagering/transactions', {
    body: pending.body,
    headers: { 'idempotency-key': pending.idempotencyKey },
  });
  check(
    'referência fora de ordem = 202 PENDING_REFERENCE',
    pendingResponse.status === 202 && pendingResponse.body?.status === 'PENDING_REFERENCE',
    pendingResponse.body,
  );

  // ------------------------------------------------------------------
  console.log('\ncenário da seção 8 (duas apostas de 80 disputando saldo 100)');
  const small = await api('POST', '/wallets', {
    body: {
      playerId: `player-${Math.random().toString(36).slice(2)}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    },
  });
  const hotWallet = small.body;

  const bet1 = bet(hotWallet, { amount: '80.00' });
  const bet2 = bet(hotWallet, { amount: '80.00' });

  const [r1, r2] = await Promise.all([
    api('POST', '/wagering/transactions', {
      body: bet1.body,
      headers: { 'idempotency-key': bet1.idempotencyKey },
    }),
    api('POST', '/wagering/transactions', {
      body: bet2.body,
      headers: { 'idempotency-key': bet2.idempotencyKey },
    }),
  ]);

  const processed = [r1, r2].filter((r) => r.body?.status === 'PROCESSED').length;
  const rejected = [r1, r2].filter((r) => r.body?.status === 'REJECTED').length;
  check('exatamente 1 PROCESSED', processed === 1, { r1: r1.body, r2: r2.body });
  check('exatamente 1 REJECTED', rejected === 1, { r1: r1.body, r2: r2.body });

  const walletAfter = await api('GET', `/wallets/${hotWallet.id}`);
  check('saldo final = 20.00', walletAfter.body?.balance?.amount === '20.00', walletAfter.body);

  // ------------------------------------------------------------------
  console.log('\nledger e reconciliação');
  const ledger = await api('GET', `/wallets/${wallet.id}/ledger?limit=10`);
  check('GET /wallets/:id/ledger = 200', ledger.status === 200, ledger.body);
  check('ledger tem lançamentos', (ledger.body?.entries?.length ?? 0) >= 4, ledger.body);

  const reconciliation = await api('POST', `/wallets/${wallet.id}/reconciliation`);
  check('reconciliação = 200', reconciliation.status === 200, reconciliation.body);
  check('reconciliação consistente', reconciliation.body?.consistent === true, reconciliation.body);
  check(
    'saldo materializado == soma do ledger',
    reconciliation.body?.difference?.amount === '0.00',
    reconciliation.body,
  );

  // ------------------------------------------------------------------
  console.log('\nconsultas e observabilidade');
  const byId = await api('GET', `/wagering/transactions/${betResponse.body.transactionId}`);
  check('GET /wagering/transactions/:id = 200', byId.status === 200, byId.body);

  const byProvider = await api(
    'GET',
    `/providers/provider-a/wagering/transactions/${first.body.externalTransactionId}`,
  );
  check('GET por provedor = 200', byProvider.status === 200, byProvider.body);

  const missing = await api('GET', '/wallets/nao-existe');
  check('wallet inexistente = 404', missing.status === 404, missing.body);

  const metrics = await fetch(`${BASE_URL}/metrics`);
  const metricsText = await metrics.text();
  check('GET /metrics = 200', metrics.status === 200);
  check('métricas têm transações', metricsText.includes('wagering_transactions_total'), metricsText.slice(0, 200));

  // ------------------------------------------------------------------
  console.log(`\n== ${passed} passaram, ${failed} falharam ==\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('erro no smoke test:', error);
  process.exit(1);
});
