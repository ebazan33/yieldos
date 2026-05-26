// Shared HMAC token helper used by /api/weekly-digest.js (to mint unsub links)
// and /api/unsubscribe.js (to verify them).
//
// Token format:  base64url(user_id) + "." + base64url(hmac_sha256(user_id, secret))
//
// The user_id half is reversible (so we know whose row to flip) but the HMAC
// half makes the token unforgeable without UNSUB_SECRET. Stable per user so
// every email can include the same link without database state.

import crypto from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

export function mintUnsubToken(userId, secret) {
  if (!userId || !secret) throw new Error('mintUnsubToken: missing userId or secret');
  const sig = crypto.createHmac('sha256', secret).update(userId).digest();
  return `${b64url(userId)}.${b64url(sig)}`;
}

export function verifyUnsubToken(token, secret) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let userId;
  try {
    userId = b64urlDecode(parts[0]).toString('utf8');
  } catch {
    return null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;

  const expected = crypto.createHmac('sha256', secret).update(userId).digest();
  let received;
  try {
    received = b64urlDecode(parts[1]);
  } catch {
    return null;
  }
  if (received.length !== expected.length) return null;
  return crypto.timingSafeEqual(received, expected) ? userId : null;
}
