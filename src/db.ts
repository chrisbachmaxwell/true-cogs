import { Pool } from 'pg';
import { config } from './config';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      // Railway's internal DATABASE_URL needs no TLS; set DATABASE_SSL=true when
      // connecting over the public proxy.
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function initDb(): Promise<void> {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS qbo_tokens (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS login_tokens (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS qbo_txns (
      entity_type TEXT NOT NULL,
      id TEXT NOT NULL,
      txn_date DATE,
      last_updated TIMESTAMPTZ,
      data JSONB NOT NULL,
      PRIMARY KEY (entity_type, id)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS qbo_txns_date_idx ON qbo_txns (entity_type, txn_date);
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS monthly_cache (
      month TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function getConfigValue(key: string): Promise<string | null> {
  const res = await getPool().query('SELECT value FROM app_config WHERE key = $1', [key]);
  return res.rows.length ? res.rows[0].value : null;
}

export async function setConfigValue(key: string, value: string): Promise<void> {
  await getPool().query(
    `INSERT INTO app_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

export async function getCachedMonth(month: string): Promise<{ data: any; computedAt: Date } | null> {
  const res = await getPool().query(
    'SELECT data, computed_at FROM monthly_cache WHERE month = $1',
    [month]
  );
  if (!res.rows.length) return null;
  return { data: res.rows[0].data, computedAt: res.rows[0].computed_at };
}

export async function setCachedMonth(month: string, data: any): Promise<void> {
  await getPool().query(
    `INSERT INTO monthly_cache (month, data, computed_at) VALUES ($1, $2, now())
     ON CONFLICT (month) DO UPDATE SET data = EXCLUDED.data, computed_at = now()`,
    [month, JSON.stringify(data)]
  );
}
