import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { getPool } from './db';

// Password-based auth for a small internal tool. Passwords are scrypt-hashed
// with per-user salts; sessions are stateless HMAC-signed cookies (30 days)
// rechecked against the users table on every request, so removing a user kills
// their sessions immediately. The gate enforces whenever any user exists; the
// first admin is seeded from ADMIN_EMAIL/ADMIN_INITIAL_PASSWORD at boot and
// must change the password on first sign-in.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'plt_session';

export interface User {
  email: string;
  isAdmin: boolean;
  mustChange: boolean;
}

// ---- password hashing (scrypt, self-describing format) ----

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keyLen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---- users table ----

const normalize = (email: string) => String(email || '').trim().toLowerCase();

export async function getUser(email: string): Promise<(User & { passHash: string }) | null> {
  const r = await getPool().query(
    `SELECT email, pass_hash, is_admin, must_change FROM users WHERE email = $1`,
    [normalize(email)]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { email: row.email, passHash: row.pass_hash, isAdmin: row.is_admin, mustChange: row.must_change };
}

export async function listUsers(): Promise<(User & { createdAt: string })[]> {
  const r = await getPool().query(
    `SELECT email, is_admin, must_change, created_at FROM users ORDER BY created_at`
  );
  return r.rows.map((row) => ({
    email: row.email,
    isAdmin: row.is_admin,
    mustChange: row.must_change,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function upsertUser(
  email: string,
  password: string,
  opts: { isAdmin?: boolean; mustChange?: boolean } = {}
): Promise<void> {
  await getPool().query(
    `INSERT INTO users (email, pass_hash, is_admin, must_change)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET pass_hash = EXCLUDED.pass_hash, must_change = EXCLUDED.must_change`,
    [normalize(email), hashPassword(password), opts.isAdmin === true, opts.mustChange !== false]
  );
  invalidateEnabledCache();
}

export async function setPassword(email: string, password: string): Promise<void> {
  await getPool().query(
    `UPDATE users SET pass_hash = $2, must_change = false WHERE email = $1`,
    [normalize(email), hashPassword(password)]
  );
}

export async function deleteUser(email: string): Promise<void> {
  await getPool().query(`DELETE FROM users WHERE email = $1`, [normalize(email)]);
  invalidateEnabledCache();
}

/** Seeds the first admin from env when the users table is empty. */
export async function bootstrapAdmin(): Promise<void> {
  const r = await getPool().query(`SELECT count(*)::int AS n FROM users`);
  if (r.rows[0].n > 0) return;
  if (!config.adminEmail || !config.adminInitialPassword) {
    console.warn(
      '[auth] no users and no ADMIN_EMAIL/ADMIN_INITIAL_PASSWORD set — dashboard remains open'
    );
    return;
  }
  await upsertUser(config.adminEmail, config.adminInitialPassword, { isAdmin: true, mustChange: true });
  console.log(`[auth] seeded first admin ${normalize(config.adminEmail)} (password change required on first sign-in)`);
}

// Auth enforces whenever any user exists. Cached briefly so every request
// doesn't hit the table; user mutations invalidate it.
let enabledCache: { value: boolean; at: number } | null = null;
const ENABLED_TTL_MS = 30_000;

function invalidateEnabledCache(): void {
  enabledCache = null;
}

export async function authEnabled(): Promise<boolean> {
  if (!config.databaseUrl) return false;
  if (enabledCache && Date.now() - enabledCache.at < ENABLED_TTL_MS) return enabledCache.value;
  try {
    const r = await getPool().query(`SELECT count(*)::int AS n FROM users`);
    enabledCache = { value: r.rows[0].n > 0, at: Date.now() };
    return enabledCache.value;
  } catch {
    return false; // schema not ready yet — stay open rather than lock out
  }
}

// ---- session cookies ----

function hmac(data: string): string {
  return crypto
    .createHmac('sha256', `session:${config.tokenEncryptionKey}`)
    .update(data)
    .digest('base64url');
}

export function signSession(email: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ email, exp: now + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

/** Signature + expiry check only; the caller confirms the user still exists. */
export function verifySession(cookie: string | undefined, now = Date.now()): string | null {
  if (!cookie) return null;
  const [payload, sig] = cookie.split('.');
  if (!payload || !sig) return null;
  const expected = hmac(payload);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.email !== 'string' || typeof data.exp !== 'number') return null;
    if (data.exp < now) return null;
    return data.email;
  } catch {
    return null;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** The signed-in user, verified against the users table. */
export async function sessionUser(req: Request): Promise<User | null> {
  const email = verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (!email) return null;
  const user = await getUser(email);
  if (!user) return null;
  return { email: user.email, isAdmin: user.isAdmin, mustChange: user.mustChange };
}

// ---- login rate limiting: max 10 attempts per address per 15 minutes ----

const recentAttempts = new Map<string, number[]>();

export function loginRateLimited(email: string): boolean {
  const now = Date.now();
  const times = (recentAttempts.get(normalize(email)) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (times.length >= 10) return true;
  times.push(now);
  recentAttempts.set(normalize(email), times);
  return false;
}

/** Verifies credentials. Generic null on any failure — no enumeration. */
export async function verifyLogin(email: string, password: string): Promise<User | null> {
  if (loginRateLimited(email)) {
    console.warn(`[auth] rate-limited login attempts for ${normalize(email)}`);
    return null;
  }
  const user = await getUser(email);
  if (!user || !verifyPassword(String(password || ''), user.passHash)) return null;
  return { email: user.email, isAdmin: user.isAdmin, mustChange: user.mustChange };
}

// ---- route gates ----

const isApi = (req: Request) => req.originalUrl.startsWith('/api/');

/** Gate for data-bearing routes. Open until a first user exists (initial setup);
 * after that every request needs a session for a still-existing user, and a
 * user flagged must_change can only reach the password-change flow. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  (async () => {
    if (!(await authEnabled())) return next();
    const user = await sessionUser(req);
    if (!user) {
      // originalUrl, not path: inside a mounted middleware req.path is mount-relative.
      if (isApi(req)) res.status(401).json({ error: 'Not signed in' });
      else res.redirect('/login');
      return;
    }
    if (user.mustChange && !req.originalUrl.startsWith('/password') && !req.originalUrl.startsWith('/auth/')) {
      if (isApi(req)) res.status(403).json({ error: 'Password change required', mustChange: true });
      else res.redirect('/password');
      return;
    }
    (req as any).user = user;
    next();
  })().catch(next);
}

/** Admin-only gate; run after requireAuth. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  (async () => {
    const user = ((req as any).user as User | undefined) ?? (await sessionUser(req));
    if (!(await authEnabled())) {
      // No users yet — nothing to administer; the boot seed creates the admin.
      res.status(503).json({ error: 'No users exist yet. Set ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD, then redeploy.' });
      return;
    }
    if (!user) return void res.status(401).json({ error: 'Not signed in' });
    if (!user.isAdmin) return void res.status(403).json({ error: 'Admin only' });
    (req as any).user = user;
    next();
  })().catch(next);
}

export function setSessionCookie(res: Response, email: string): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${signSession(email)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
