/**
 * Runner de migrations (versionadas e reversíveis).
 *
 *   bun run migrate            -> aplica as migrations pendentes
 *   bun run migrate:down       -> reverte a última migration aplicada
 *   bun run migrate:status     -> lista o estado
 *
 * Cada migration é um par de arquivos .up.sql / .down.sql em /migrations.
 * O controle de versão fica na tabela `schema_migrations`.
 */
import { Client } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = process.env['MIGRATIONS_DIR'] ?? join(process.cwd(), 'migrations');

function dbConfig() {
  return {
    host: process.env['POSTGRES_HOST'] ?? 'localhost',
    port: Number(process.env['POSTGRES_PORT'] ?? 5432),
    user: process.env['POSTGRES_USER'] ?? 'jungle',
    password: process.env['POSTGRES_PASSWORD'] ?? 'jungle',
    database: process.env['POSTGRES_DB'] ?? 'jungle',
  };
}

async function ensureSchemaMigrations(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    varchar(255) PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.up.sql'))
    .sort();
}

async function up(client: Client): Promise<void> {
  const applied = new Set(
    (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
      (row) => row.version,
    ),
  );

  for (const file of listMigrations()) {
    const version = file.replace(/\.up\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrate] applying ${version}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log('[migrate] done');
}

async function down(client: Client): Promise<void> {
  const { rows } = await client.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1',
  );
  if (rows.length === 0) {
    console.log('[migrate] nothing to revert');
    return;
  }

  const version = rows[0].version;
  const file = join(MIGRATIONS_DIR, `${version}.down.sql`);
  console.log(`[migrate] reverting ${version}`);
  await client.query('BEGIN');
  try {
    await client.query(readFileSync(file, 'utf8'));
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  console.log('[migrate] reverted');
}

async function status(client: Client): Promise<void> {
  const applied = new Set(
    (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
      (row) => row.version,
    ),
  );
  for (const file of listMigrations()) {
    const version = file.replace(/\.up\.sql$/, '');
    console.log(`${applied.has(version) ? '[x]' : '[ ]'} ${version}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const client = new Client(dbConfig());
  await client.connect();
  try {
    await ensureSchemaMigrations(client);
    if (command === 'up') await up(client);
    else if (command === 'down') await down(client);
    else if (command === 'status') await status(client);
    else throw new Error(`unknown command: ${command}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[migrate] failed:', error);
  process.exit(1);
});
