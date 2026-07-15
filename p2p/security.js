const FINGERPRINT_PATTERN = /^a=fingerprint:sha-256\s+([a-f0-9:]+)\s*$/im;

export async function deriveSafetyCode(localSdp, remoteSdp, generation) {
  const local = extractFingerprint(localSdp);
  const remote = extractFingerprint(remoteSdp);
  if (!local || !remote || !Number.isSafeInteger(generation) || generation < 1) return null;
  const fingerprints = [local, remote].sort();
  const input = `manbesi-p2p-safety-v1\0${generation}\0${fingerprints[0]}\0${fingerprints[1]}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const code = [...new Uint8Array(digest).slice(0, 6)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return code.match(/.{4}/g).join(' ');
}

export function extractFingerprint(sdp) {
  if (typeof sdp !== 'string') return null;
  const match = sdp.match(FINGERPRINT_PATTERN);
  if (!match) return null;
  const normalized = match[1].replaceAll(':', '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

export function validateIceServers(value) {
  if (!value || !Array.isArray(value.iceServers)) return null;
  const servers = [];
  for (const item of value.iceServers.slice(0, 16)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const urls = (Array.isArray(item.urls) ? item.urls : [item.urls]).filter(
      (url) => typeof url === 'string' && url.length <= 2048 && /^(stun|turn|turns):/i.test(url),
    );
    if (urls.length === 0) continue;
    const server = { urls };
    if (typeof item.username === 'string' && item.username.length <= 1024) server.username = item.username;
    if (typeof item.credential === 'string' && item.credential.length <= 2048) server.credential = item.credential;
    servers.push(server);
  }
  return servers.length > 0 ? servers : null;
}
