import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveSafetyCode, extractFingerprint, validateIceServers } from '../p2p/security.js';

const LEFT = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
const RIGHT = 'FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00';

test('derives the same 48-bit safety code on both devices', async () => {
  const leftSdp = `v=0\r\na=fingerprint:sha-256 ${LEFT}\r\n`;
  const rightSdp = `v=0\r\na=fingerprint:sha-256 ${RIGHT}\r\n`;
  const forward = await deriveSafetyCode(leftSdp, rightSdp, 7);
  const reverse = await deriveSafetyCode(rightSdp, leftSdp, 7);
  assert.equal(forward, reverse);
  assert.match(forward, /^[A-F0-9]{4} [A-F0-9]{4} [A-F0-9]{4}$/);
});

test('rejects malformed or non-SHA-256 fingerprints', () => {
  assert.equal(extractFingerprint('a=fingerprint:sha-1 11:22'), null);
  assert.equal(extractFingerprint('a=fingerprint:sha-256 11:22'), null);
  assert.equal(extractFingerprint(`a=fingerprint:sha-256 ${LEFT}`), LEFT.replaceAll(':', '').toLowerCase());
});

test('accepts only bounded STUN and TURN configuration', () => {
  const result = validateIceServers({
    iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478', 'https://evil.test'], username: 'u', credential: 'c' },
      { urls: 'turns:turn.cloudflare.com:5349?transport=tcp', username: 'u2', credential: 'c2' },
      { urls: 'javascript:alert(1)' },
    ],
  });
  assert.deepEqual(result, [
    { urls: ['stun:stun.cloudflare.com:3478'], username: 'u', credential: 'c' },
    { urls: ['turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u2', credential: 'c2' },
  ]);
  assert.equal(validateIceServers({ iceServers: [{ urls: 'https://example.com' }] }), null);
});
