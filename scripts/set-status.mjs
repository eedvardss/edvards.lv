import { execFileSync } from 'node:child_process';

const keychainService = 'manbesi-status-api';
const endpoint = process.env.MANBESI_STATUS_ENDPOINT ?? 'https://manbesi.lv/api/update';
const text = process.argv.slice(2).join(' ').trim().normalize('NFC');

if (!isValidStatusText(text)) {
  console.error('Provide one status between 1 and 64 characters, without line breaks or control characters.');
  process.exit(1);
}

const token = readToken();
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ text }),
});

const payload = await response.json().catch(() => null);
if (!response.ok) {
  console.error(payload?.error ?? `Update failed with HTTP ${response.status}.`);
  process.exit(1);
}

console.log(`manbesi.lv → ${payload.text}`);

function readToken() {
  if (process.env.MANBESI_STATUS_TOKEN) return process.env.MANBESI_STATUS_TOKEN.trim();

  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-s', keychainService, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    console.error(
      `Missing API token. Set MANBESI_STATUS_TOKEN or add it to macOS Keychain service "${keychainService}".`,
    );
    process.exit(1);
  }
}

function isValidStatusText(value) {
  const length = Array.from(value).length;
  return length >= 1 && length <= 64 && !/[\u0000-\u001f\u007f]/u.test(value);
}
