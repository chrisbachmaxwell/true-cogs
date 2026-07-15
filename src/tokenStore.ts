import { getPool } from './db';
import { encrypt, decrypt } from './crypto';
import { config } from './config';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  realmId: string;
  /** Epoch ms when the access token expires. */
  accessTokenExpiresAt: number;
  /** Epoch ms when the refresh token expires (~100 days from last refresh). */
  refreshTokenExpiresAt: number;
  /** Epoch ms of the last successful token exchange/refresh. */
  lastRefreshedAt: number;
  /** Epoch ms when the company was first connected (5-year reauth horizon). */
  connectedAt: number;
}

function key(): string {
  if (!config.tokenEncryptionKey) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  return config.tokenEncryptionKey;
}

export async function saveTokens(tokens: TokenSet): Promise<void> {
  const payload = encrypt(JSON.stringify(tokens), key());
  await getPool().query(
    `INSERT INTO qbo_tokens (id, data, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [payload]
  );
}

export async function loadTokens(): Promise<TokenSet | null> {
  const res = await getPool().query('SELECT data FROM qbo_tokens WHERE id = 1');
  if (!res.rows.length) return null;
  return JSON.parse(decrypt(res.rows[0].data, key())) as TokenSet;
}

export async function deleteTokens(): Promise<void> {
  await getPool().query('DELETE FROM qbo_tokens WHERE id = 1');
}
