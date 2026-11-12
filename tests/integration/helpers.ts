/**
 * Helpers dos testes de integração.
 *
 * Os testes de integração rodam contra a aplicação REAL (docker compose up)
 * e contra o PostgreSQL REAL — nada é mockado.
 *
 * Variáveis de ambiente:
 *   BASE_URL       (default http://localhost:3000)
 *   POSTGRES_HOST  (default localhost)
 *   POSTGRES_PORT  (default 5432)
 *   POSTGRES_USER  (default jungle)
 *   POSTGRES_PASSWORD (default jungle)
 *   POSTGRES_DB    (default jungle)
 *   SQS_ENDPOINT   (default http://localhost:4566)
 */
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

export const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:3000';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = any>(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* resposta não-JSON */
  }

  return { status: response.status, body: body as T, headers: response.headers };
}

export function dbConfig() {
  return {
    host: process.env['POSTGRES_HOST'] ?? 'localhost',
    port: Number(process.env['POSTGRES_PORT'] ?? 5432),
    user: process.env['POSTGRES_USER'] ?? 'jungle',
    password: process.env['POSTGRES_PASSWORD'] ?? 'jungle',
    database: process.env['POSTGRES_DB'] ?? 'jungle',
  };
}

export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(dbConfig());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Espera a aplicação estar pronta (health/ready). */
export async function waitForReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timeout';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health/ready`);
      if (response.ok) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `aplicação não ficou pronta em ${BASE_URL} (${lastError}). ` +
      'Suba com: docker compose up -d && bun run migrate',
  );
}

/** Cria uma wallet via API e devolve o resultado. */
export async function createWallet(initialBalance = '1000.00') {
  const playerId = randomUUID();
  const response = await api('POST', '/wallets', {
    body: { playerId, initialBalance: { amount: initialBalance, currency: 'BRL' } },
  });

  if (response.status !== 201) {
    throw new Error(`falha ao criar wallet: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return { ...response.body, playerId };
}

export function betPayload(options: {
  providerId?: string;
  externalTransactionId?: string;
  playerId: string;
  walletId: string;
  roundId?: string;
  kind?: string;
  amount?: string;
  referenceExternalTransactionId?: string;
}) {
  const providerId = options.providerId ?? 'provider-a';
  const externalTransactionId = options.externalTransactionId ?? randomUUID();

  return {
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    body: {
      providerId,
      externalTransactionId,
      playerId: options.playerId,
      walletId: options.walletId,
      roundId: options.roundId ?? randomUUID(),
      gameId: 'fortune-chimp',
      kind: options.kind ?? 'BET',
      money: { amount: options.amount ?? '25.00', currency: 'BRL' },
      ...(options.referenceExternalTransactionId
        ? { referenceExternalTransactionId: options.referenceExternalTransactionId }
        : {}),
    },
  };
}

/** Soma do ledger (débitos negativos, créditos positivos). */
export async function ledgerSum(client: Client, walletId: string): Promise<string> {
  const result = await client.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN -amount ELSE amount END), 0) AS total
     FROM wallet_ledger_entries WHERE wallet_id = $1`,
    [walletId],
  );
  return (result.rows[0]?.total ?? '0').toString();
}

export async function ledgerCount(client: Client, walletId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM wallet_ledger_entries WHERE wallet_id = $1',
    [walletId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function walletBalance(client: Client, walletId: string): Promise<string> {
  const result = await client.query<{ balance_amount: string }>(
    'SELECT balance_amount FROM wallets WHERE id = $1',
    [walletId],
  );
  return (result.rows[0]?.balance_amount ?? '0').toString();
}
