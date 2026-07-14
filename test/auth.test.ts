import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TOKEN_ENCRYPTION_KEY = 'test-secret';
process.env.AUTH_ALLOWED_EMAILS = 'chrism@pictureline.com';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { signSession, verifySession } = require('../src/auth');

test('session round-trips for an allowlisted email', () => {
  const cookie = signSession('chrism@pictureline.com');
  assert.equal(verifySession(cookie), 'chrism@pictureline.com');
});

test('session is case-insensitive on the allowlist', () => {
  const cookie = signSession('ChrisM@Pictureline.com');
  assert.equal(verifySession(cookie), 'ChrisM@Pictureline.com');
});

test('tampered payload is rejected', () => {
  const cookie = signSession('chrism@pictureline.com');
  const [payload, sig] = cookie.split('.');
  const forged = Buffer.from(JSON.stringify({ email: 'evil@example.com', exp: Date.now() + 9e9 })).toString('base64url');
  assert.equal(verifySession(`${forged}.${sig}`), null);
  assert.equal(verifySession(`${payload}.AAAA`), null);
  assert.equal(verifySession('garbage'), null);
  assert.equal(verifySession(undefined), null);
});

test('expired session is rejected', () => {
  const cookie = signSession('chrism@pictureline.com', Date.now() - 40 * 24 * 60 * 60 * 1000);
  assert.equal(verifySession(cookie), null);
});

test('validly-signed session for a non-allowlisted email is rejected', () => {
  const cookie = signSession('someoneelse@pictureline.com');
  assert.equal(verifySession(cookie), null);
});
