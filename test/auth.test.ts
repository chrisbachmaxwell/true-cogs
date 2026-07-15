import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TOKEN_ENCRYPTION_KEY = 'test-secret';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { signSession, verifySession, hashPassword, verifyPassword } = require('../src/auth');

test('session round-trips', () => {
  const cookie = signSession('chrism@pictureline.com');
  assert.equal(verifySession(cookie), 'chrism@pictureline.com');
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

test('password hash verifies the right password and rejects the wrong one', () => {
  const stored = hashPassword('correct horse battery');
  assert.equal(verifyPassword('correct horse battery', stored), true);
  assert.equal(verifyPassword('correct horse batterY', stored), false);
  assert.equal(verifyPassword('', stored), false);
});

test('same password hashes differently per user (random salt)', () => {
  const a = hashPassword('hunter22222');
  const b = hashPassword('hunter22222');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('hunter22222', a), true);
  assert.equal(verifyPassword('hunter22222', b), true);
});

test('malformed stored hashes never verify', () => {
  assert.equal(verifyPassword('anything', ''), false);
  assert.equal(verifyPassword('anything', 'plaintext'), false);
  assert.equal(verifyPassword('anything', 'scrypt$bad$values$$$'), false);
});
