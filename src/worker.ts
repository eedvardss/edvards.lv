import { DurableObject } from 'cloudflare:workers';

const MAX_SIGNAL_SIZE = 32 * 1024;
const SIGNAL_RATE_WINDOW_MS = 10_000;
const MAX_SIGNALS_PER_WINDOW = 120;
const MAX_PROTOCOL_VIOLATIONS = 3;
const MAX_ADMISSIONS_PER_MINUTE = 20;
const SOCKET_STALE_AFTER_MS = 60_000;

const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

type AppEnv = Env & {
  ACCESS_CONFIG?: string;
};

type AccessConfig = {
  audience: string;
  ownerEmail: string;
  teamDomain: string;
};

type AccessClaims = {
  email: string;
  exp: number;
  sub: string;
};

type SocketAttachment = AccessClaims & {
  generation: number;
  lastSeenAt: number;
  lastSequence: number;
  peerId: string;
  protocolViolations: number;
};

type Signal = {
  version: 1;
  generation: number;
  seq: number;
} & (
  | { type: 'description'; description: { type: 'offer' | 'answer'; sdp: string } }
  | { type: 'candidate'; candidate: IceCandidate | null }
);

type RateWindow = { count: number; startedAt: number };

type IceCandidate = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

type AccessJwk = JsonWebKey & { kid?: string };

type JwtHeader = { alg?: unknown; kid?: unknown; typ?: unknown };
type JwtPayload = {
  aud?: unknown;
  email?: unknown;
  exp?: unknown;
  iss?: unknown;
  nbf?: unknown;
  sub?: unknown;
  type?: unknown;
};

let cachedKeys: { expiresAt: number; issuer: string; keys: AccessJwk[] } | null = null;

export class SignalingRoom extends DurableObject<AppEnv> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket required', { status: 426 });
    }

    const claims = readVerifiedClaims(request);
    if (!claims) return new Response('Verified Access identity required', { status: 401 });

    if (!(await this.consumeAdmissionAllowance())) {
      return new Response('Connection rate limit exceeded', { status: 429 });
    }

    const now = Date.now();
    const peers = this.ctx.getWebSockets().filter((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      const active = attachment
        && attachment.exp > Math.floor(now / 1000)
        && now - attachment.lastSeenAt <= SOCKET_STALE_AFTER_MS;
      if (!active) socket.close(4001, 'Signaling session expired');
      return active;
    });
    if (peers.length >= 2) {
      return new Response('This workspace is already open on two devices', { status: 409 });
    }

    const existingIdentity = peers[0]?.deserializeAttachment() as SocketAttachment | null;
    if (existingIdentity && existingIdentity.sub !== claims.sub) {
      return new Response('Workspace identity mismatch', { status: 403 });
    }

    const currentGeneration = await this.currentGeneration();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: SocketAttachment = {
      ...claims,
      peerId: crypto.randomUUID(),
      generation: currentGeneration,
      lastSeenAt: now,
      lastSequence: 0,
      protocolViolations: 0,
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({ type: 'welcome', peerId: attachment.peerId }));

    if (peers.length === 0) {
      server.send(JSON.stringify({ type: 'waiting' }));
    } else {
      const nextGeneration = currentGeneration + 1;
      await this.ctx.storage.put('generation', nextGeneration);
      const existingAttachment = peers[0].deserializeAttachment() as SocketAttachment;
      existingAttachment.generation = nextGeneration;
      existingAttachment.lastSequence = 0;
      peers[0].serializeAttachment(existingAttachment);
      attachment.generation = nextGeneration;
      server.serializeAttachment(attachment);
      peers[0].send(JSON.stringify({ type: 'peer-ready', generation: nextGeneration, initiator: true }));
      server.send(JSON.stringify({ type: 'peer-ready', generation: nextGeneration, initiator: false }));
    }

    await this.scheduleExpiryAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      this.recordViolation(socket, 'Binary signaling is not allowed');
      return;
    }
    if (new TextEncoder().encode(message).byteLength > MAX_SIGNAL_SIZE) {
      socket.close(1009, 'Signaling message too large');
      return;
    }

    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      socket.close(1008, 'Missing connection identity');
      return;
    }
    if (attachment.exp <= Math.floor(Date.now() / 1000)) {
      socket.close(4001, 'Access session expired');
      return;
    }
    if (!(await this.consumeSignalAllowance(socket))) return;

    let signal: unknown;
    try {
      signal = JSON.parse(message);
    } catch {
      this.recordViolation(socket, 'Malformed signaling message');
      return;
    }

    if (isRecord(signal) && signal.type === 'heartbeat' && hasOnlyKeys(signal, ['type'])) {
      attachment.lastSeenAt = Date.now();
      socket.serializeAttachment(attachment);
      return;
    }

    if (!isValidSignal(signal)
      || signal.generation !== attachment.generation
      || signal.seq <= attachment.lastSequence) {
      this.recordViolation(socket, 'Stale or unsupported signaling message');
      return;
    }

    attachment.lastSequence = signal.seq;
    attachment.lastSeenAt = Date.now();
    socket.serializeAttachment(attachment);
    const now = Math.floor(Date.now() / 1000);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === socket) continue;
      const peerAttachment = peer.deserializeAttachment() as SocketAttachment | null;
      if (!peerAttachment || peerAttachment.exp <= now) {
        peer.close(4001, 'Access session expired');
        continue;
      }
      peer.send(JSON.stringify(signal));
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const nextGeneration = (await this.currentGeneration()) + 1;
    await this.ctx.storage.put('generation', nextGeneration);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === socket) continue;
      const attachment = peer.deserializeAttachment() as SocketAttachment | null;
      if (attachment) {
        attachment.generation = nextGeneration;
        attachment.lastSequence = 0;
        peer.serializeAttachment(attachment);
      }
      peer.send(JSON.stringify({ type: 'peer-left', generation: nextGeneration }));
    }
    await this.scheduleExpiryAlarm();
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, 'Signaling connection failed');
  }

  async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || attachment.exp <= now) socket.close(4001, 'Access session expired');
    }
    await this.scheduleExpiryAlarm();
  }

  private async currentGeneration(): Promise<number> {
    return (await this.ctx.storage.get<number>('generation')) ?? 0;
  }

  private async consumeSignalAllowance(socket: WebSocket): Promise<boolean> {
    const now = Date.now();
    const allowed = await this.ctx.storage.transaction(async (transaction) => {
      let window = await transaction.get<RateWindow>('signalRate');
      if (!window || now - window.startedAt >= SIGNAL_RATE_WINDOW_MS) {
        window = { count: 0, startedAt: now };
      }
      window.count += 1;
      await transaction.put('signalRate', window);
      return window.count <= MAX_SIGNALS_PER_WINDOW;
    });
    if (allowed) return true;

    socket.close(1008, 'Signaling rate limit exceeded');
    return false;
  }

  private async consumeAdmissionAllowance(): Promise<boolean> {
    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      let window = await transaction.get<RateWindow>('admissionRate');
      if (!window || now - window.startedAt >= 60_000) window = { count: 0, startedAt: now };
      window.count += 1;
      await transaction.put('admissionRate', window);
      return window.count <= MAX_ADMISSIONS_PER_MINUTE;
    });
  }

  private recordViolation(socket: WebSocket, reason: string): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      socket.close(1008, reason);
      return;
    }
    attachment.protocolViolations += 1;
    socket.serializeAttachment(attachment);
    if (attachment.protocolViolations >= MAX_PROTOCOL_VIOLATIONS) socket.close(1008, reason);
  }

  private async scheduleExpiryAlarm(): Promise<void> {
    const now = Date.now();
    const expiries: number[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || attachment.exp * 1000 <= now) {
        socket.close(4001, 'Access session expired');
        continue;
      }
      expiries.push(attachment.exp);
    }
    if (expiries.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...expiries) * 1000);
  }
}

function isValidSignal(value: unknown): value is Signal {
  if (!isRecord(value)
    || value.version !== 1
    || !Number.isSafeInteger(value.generation)
    || Number(value.generation) < 1
    || !Number.isSafeInteger(value.seq)
    || Number(value.seq) < 1) return false;

  if (value.type === 'description') {
    if (!hasOnlyKeys(value, ['version', 'generation', 'seq', 'type', 'description'])
      || !isRecord(value.description)
      || !hasOnlyKeys(value.description, ['type', 'sdp'])) return false;
    const { type, sdp } = value.description;
    return (type === 'offer' || type === 'answer')
      && typeof sdp === 'string'
      && sdp.length > 0
      && sdp.length <= 24 * 1024;
  }

  if (value.type === 'candidate') {
    if (!hasOnlyKeys(value, ['version', 'generation', 'seq', 'type', 'candidate'])) return false;
    if (value.candidate === null) return true;
    if (!isRecord(value.candidate)
      || !hasOnlyKeys(value.candidate, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'])) return false;
    const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = value.candidate;
    return typeof candidate === 'string'
      && candidate.length <= 4096
      && (sdpMid === null || sdpMid === undefined || (typeof sdpMid === 'string' && sdpMid.length <= 256))
      && (sdpMLineIndex === null || sdpMLineIndex === undefined
        || (Number.isInteger(sdpMLineIndex) && Number(sdpMLineIndex) >= 0 && Number(sdpMLineIndex) <= 65_535))
      && (usernameFragment === null || usernameFragment === undefined
        || (typeof usernameFragment === 'string' && usernameFragment.length <= 256));
  }

  return false;
}

function readVerifiedClaims(request: Request): AccessClaims | null {
  const sub = request.headers.get('X-Verified-Access-Subject');
  const email = request.headers.get('X-Verified-Access-Email');
  const exp = Number(request.headers.get('X-Verified-Access-Expires'));
  if (!sub || sub.length > 255 || !email || email.length > 254 || !Number.isSafeInteger(exp)) return null;
  if (exp <= Math.floor(Date.now() / 1000)) return null;
  return { sub, email, exp };
}

async function verifyAccessRequest(request: Request, env: AppEnv): Promise<AccessClaims | null> {
  if (!env.ACCESS_CONFIG) return null;
  let config: AccessConfig;
  try {
    config = JSON.parse(env.ACCESS_CONFIG) as AccessConfig;
  } catch {
    return null;
  }
  if (!isValidAccessConfig(config)) return null;

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16 * 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let decodedHeader: unknown;
  let decodedPayload: unknown;
  try {
    decodedHeader = decodeJwtPart(parts[0]);
    decodedPayload = decodeJwtPart(parts[1]);
  } catch {
    return null;
  }
  if (!isRecord(decodedHeader) || !isRecord(decodedPayload)) return null;
  const header = decodedHeader as JwtHeader;
  const payload = decodedPayload as JwtPayload;

  const issuer = `https://${config.teamDomain}.cloudflareaccess.com`;
  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  const expiration = typeof payload.exp === 'number' ? payload.exp : Number.NaN;
  if (header.alg !== 'RS256'
    || (header.typ !== undefined && header.typ !== 'JWT')
    || typeof header.kid !== 'string'
    || header.kid.length > 256
    || payload.iss !== issuer
    || payload.type !== 'app'
    || !audience.includes(config.audience)
    || payload.email !== config.ownerEmail
    || subject.length === 0
    || subject.length > 255
    || !Number.isSafeInteger(expiration)
    || expiration <= now
    || (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || Number(payload.nbf) > now + 30))) {
    return null;
  }

  let keys: AccessJwk[];
  try {
    keys = await accessKeys(issuer);
  } catch {
    return null;
  }
  let keyData = keys.find((key) => key.kid === header.kid);
  if (!keyData) {
    try {
      keys = await accessKeys(issuer, true);
    } catch {
      return null;
    }
    keyData = keys.find((key) => key.kid === header.kid);
  }
  if (!keyData) return null;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      keyData,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;
  } catch {
    return null;
  }

  return { sub: subject, email: config.ownerEmail, exp: expiration };
}

async function accessKeys(issuer: string, forceRefresh = false): Promise<AccessJwk[]> {
  if (!forceRefresh && cachedKeys && cachedKeys.issuer === issuer && cachedKeys.expiresAt > Date.now()) return cachedKeys.keys;
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Unable to load Cloudflare Access signing keys.');
  const body = await response.json() as { keys?: AccessJwk[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('Cloudflare Access signing keys were empty.');
  cachedKeys = { issuer, keys: body.keys, expiresAt: Date.now() + 60 * 60 * 1000 };
  return body.keys;
}

function isValidAccessConfig(value: AccessConfig): boolean {
  return typeof value.audience === 'string'
    && /^[A-Za-z0-9_-]{16,256}$/.test(value.audience)
    && typeof value.ownerEmail === 'string'
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.ownerEmail)
    && value.ownerEmail.length <= 254
    && typeof value.teamDomain === 'string'
    && /^[a-z0-9-]{1,63}$/.test(value.teamDomain);
}

function decodeJwtPart(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value.');
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/p2p') {
      return Response.redirect(`${url.origin}/p2p/`, 308);
    }

    if (url.pathname === '/p2p/ws') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      if (request.headers.get('Origin') !== url.origin) return new Response('Origin rejected', { status: 403 });
      if (!env.ACCESS_CONFIG) return new Response('Access is not configured', { status: 503 });
      const claims = await verifyAccessRequest(request, env);
      if (!claims) return new Response('Cloudflare Access authentication required', { status: 401 });

      const roomId = env.SIGNALING_ROOM.idFromName(`owner:${await sha256Hex(claims.sub)}`);
      const headers = new Headers(request.headers);
      headers.delete('Cookie');
      headers.delete('Cf-Access-Authenticated-User-Email');
      headers.delete('Cf-Access-Jwt-Assertion');
      headers.set('X-Verified-Access-Subject', claims.sub);
      headers.set('X-Verified-Access-Email', claims.email);
      headers.set('X-Verified-Access-Expires', String(claims.exp));
      return env.SIGNALING_ROOM.get(roomId).fetch(new Request(request, { headers }));
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(name, value);
    }

    if (url.pathname.startsWith('/p2p/')) headers.set('Cache-Control', 'no-store');
    if (headers.get('Content-Type')?.includes('text/html')) {
      headers.set('Cache-Control', 'no-store');
      headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'none'; connect-src 'self' wss://manbesi.lv; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; worker-src 'none'",
      );
    }

    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<AppEnv>;
