import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { getPool } from './db';

// Email magic-link auth for a single-user internal tool. Login tokens are
// random 256-bit values stored hashed in Postgres with a 15-minute expiry;
// sessions are stateless HMAC-signed cookies (30 days).

const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'plt_session';

export function authConfigured(): boolean {
  return Boolean(config.resendApiKey && config.tokenEncryptionKey && config.databaseUrl);
}

function allowedEmails(): string[] {
  return config.authAllowedEmails.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
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
    if (!allowedEmails().includes(data.email.toLowerCase())) return null;
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

export function sessionEmail(req: Request): string | null {
  return verifySession(parseCookies(req)[SESSION_COOKIE]);
}

/** Gate for data-bearing routes. When auth isn't configured (no RESEND_API_KEY)
 * the app stays open, preserving the pre-auth behavior for initial setup. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authConfigured() || sessionEmail(req)) return next();
  // originalUrl, not path: inside a mounted middleware req.path is mount-relative.
  if (req.originalUrl.startsWith('/api/')) {
    res.status(401).json({ error: 'Not signed in' });
  } else {
    res.redirect('/login');
  }
}

// ---- magic links ----

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// Basic abuse guard: max 3 link requests per address per 15 minutes.
const recentRequests = new Map<string, number[]>();

function rateLimited(email: string): boolean {
  const now = Date.now();
  const times = (recentRequests.get(email) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (times.length >= 3) return true;
  times.push(now);
  recentRequests.set(email, times);
  return false;
}

async function sendLoginEmail(to: string, link: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.authFromEmail,
      to: [to],
      subject: 'Sign in to the Pictureline inventory tracker',
      html:
        `<p>Click to sign in (link is valid for 15 minutes and can be used once):</p>` +
        `<p><a href="${link}">Sign in to the inventory tracker</a></p>` +
        `<p style="color:#888;font-size:12px">If you didn't request this, you can ignore it.</p>`,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

/** Issues a login link if the email is on the allowlist. Always resolves without
 * revealing whether the address was accepted. */
export async function requestLoginLink(rawEmail: string, baseUrl: string): Promise<void> {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!allowedEmails().includes(email)) {
    console.warn(`[auth] login requested for non-allowlisted address`);
    return;
  }
  if (rateLimited(email)) {
    console.warn(`[auth] rate-limited login request for ${email}`);
    return;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await getPool().query(
    `INSERT INTO login_tokens (token_hash, email, expires_at) VALUES ($1, $2, $3)`,
    [sha256(token), email, new Date(Date.now() + LOGIN_TOKEN_TTL_MS)]
  );
  await sendLoginEmail(email, `${baseUrl}/auth/verify?token=${token}`);
  console.log(`[auth] login link sent to ${email}`);
}

/** Consumes a login token; returns the email on success, null otherwise. */
export async function consumeLoginToken(token: string): Promise<string | null> {
  if (!token) return null;
  const res = await getPool().query(
    `UPDATE login_tokens SET used = true
     WHERE token_hash = $1 AND used = false AND expires_at > now()
     RETURNING email`,
    [sha256(token)]
  );
  return res.rows.length ? res.rows[0].email : null;
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
