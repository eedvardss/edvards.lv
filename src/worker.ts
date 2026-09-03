import { DurableObject } from 'cloudflare:workers';

const MAX_SIGNAL_SIZE = 32 * 1024;
const SIGNAL_RATE_WINDOW_MS = 10_000;
const MAX_SIGNALS_PER_WINDOW = 120;
const MAX_PROTOCOL_VIOLATIONS = 3;
const MAX_ADMISSIONS_PER_MINUTE = 20;
const SOCKET_STALE_AFTER_MS = 60_000;
const MAX_STATUS_BODY_SIZE = 2 * 1024;
const MAX_STATUS_LENGTH = 64;
const DEFAULT_STATUS = 'darbs';
const BEER_MAP_PREFIX = '/alus';
const BEER_MAP_ORIGIN = 'https://rigas-alus-karte.micux21.chatgpt.site';

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
  BEER_MAP_ORIGIN_TOKEN?: string;
  STATUS_UPDATE_TOKEN?: string;
  TURN_KEY_API_TOKEN?: string;
  TURN_KEY_ID?: string;
};

type StatusRecord = {
  text: string;
  updatedAt: string | null;
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
  approved: boolean;
  canApprove: boolean;
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
  | { type: 'approval'; decision: 'approve' | 'reject' }
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
      approved: false,
      canApprove: peers.length === 0,
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
      existingAttachment.approved = false;
      existingAttachment.canApprove = true;
      existingAttachment.generation = nextGeneration;
      existingAttachment.lastSequence = 0;
      peers[0].serializeAttachment(existingAttachment);
      attachment.generation = nextGeneration;
      attachment.approved = false;
      attachment.canApprove = false;
      server.serializeAttachment(attachment);
      peers[0].send(JSON.stringify({
        type: 'peer-ready', generation: nextGeneration, initiator: true, approver: true,
      }));
      server.send(JSON.stringify({
        type: 'peer-ready', generation: nextGeneration, initiator: false, approver: false,
      }));
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

    if (signal.type === 'approval') {
      await this.handleApproval(socket, attachment, signal.decision);
      return;
    }

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
        attachment.approved = false;
        attachment.canApprove = true;
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

  private async handleApproval(
    socket: WebSocket,
    attachment: SocketAttachment,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    if (!attachment.canApprove) {
      this.recordViolation(socket, 'Only the first device may approve this connection');
      return;
    }

    const peers = this.ctx.getWebSockets();
    if (peers.length !== 2) {
      this.recordViolation(socket, 'There is no second device to approve');
      return;
    }

    if (decision === 'reject') {
      for (const peer of peers) {
        if (peer !== socket) peer.close(4003, 'Connection rejected by the first device');
      }
      socket.send(JSON.stringify({ type: 'workspace-rejected', generation: attachment.generation }));
      return;
    }

    for (const peer of peers) {
      const peerAttachment = peer.deserializeAttachment() as SocketAttachment | null;
      if (!peerAttachment || peerAttachment.generation !== attachment.generation) continue;
      peerAttachment.approved = true;
      peer.serializeAttachment(peerAttachment);
      peer.send(JSON.stringify({ type: 'workspace-approved', generation: attachment.generation }));
    }
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

export class StatusStore extends DurableObject<AppEnv> {
  async getStatus(): Promise<StatusRecord> {
    return (await this.ctx.storage.get<StatusRecord>('status')) ?? {
      text: DEFAULT_STATUS,
      updatedAt: null,
    };
  }

  async setStatus(text: string): Promise<StatusRecord> {
    const status = {
      text,
      updatedAt: new Date().toISOString(),
    } satisfies StatusRecord;
    await this.ctx.storage.put('status', status);
    return status;
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

  if (value.type === 'approval') {
    return hasOnlyKeys(value, ['version', 'generation', 'seq', 'type', 'decision'])
      && (value.decision === 'approve' || value.decision === 'reject');
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

    if (url.pathname === '/api/status') {
      if (request.method !== 'GET') {
        return statusJson({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
      }

      const status = await env.STATUS_STORE.getByName('site-status').getStatus();
      return statusJson(status);
    }

    if (url.pathname === '/api/update') {
      if (request.method !== 'POST') {
        return statusJson({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
      }
      if (!env.STATUS_UPDATE_TOKEN) {
        return statusJson({ error: 'Status updates are not configured' }, 503);
      }

      const fetchSite = request.headers.get('Sec-Fetch-Site');
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        return statusJson({ error: 'Cross-site updates are not allowed' }, 403);
      }

      const providedToken = readBearerToken(request);
      if (!providedToken || !(await timingSafeTokenMatches(providedToken, env.STATUS_UPDATE_TOKEN))) {
        return statusJson(
          { error: 'Unauthorized' },
          401,
          { 'WWW-Authenticate': 'Bearer realm="manbesi-status"' },
        );
      }

      const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        return statusJson({ error: 'Content-Type must be application/json' }, 415);
      }

      const contentLength = Number(request.headers.get('Content-Length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_STATUS_BODY_SIZE) {
        return statusJson({ error: 'Request body is too large' }, 413);
      }

      let rawBody: string;
      try {
        rawBody = await readBoundedBody(request, MAX_STATUS_BODY_SIZE);
      } catch (error) {
        return error instanceof RangeError
          ? statusJson({ error: 'Request body is too large' }, 413)
          : statusJson({ error: 'Request body could not be read as UTF-8 text' }, 400);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return statusJson({ error: 'Request body must contain valid JSON' }, 400);
      }
      if (!isRecord(payload) || !hasOnlyKeys(payload, ['text']) || typeof payload.text !== 'string') {
        return statusJson({ error: 'Request body must be an object containing only a text string' }, 400);
      }

      const text = payload.text.trim().normalize('NFC');
      if (!isValidStatusText(text)) {
        return statusJson({ error: 'Text must be 1 to 64 characters with no line breaks or control characters' }, 422);
      }

      const status = await env.STATUS_STORE.getByName('site-status').setStatus(text);
      console.log(JSON.stringify({ event: 'status_updated', textLength: Array.from(text).length, updatedAt: status.updatedAt }));
      return statusJson(status);
    }

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

    if (url.pathname === '/p2p/ice') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const origin = request.headers.get('Origin');
      const fetchSite = request.headers.get('Sec-Fetch-Site');
      if ((origin && origin !== url.origin) || (fetchSite && fetchSite !== 'same-origin')) {
        return new Response('Origin rejected', { status: 403 });
      }
      if (!env.ACCESS_CONFIG) return new Response('Access is not configured', { status: 503 });
      const claims = await verifyAccessRequest(request, env);
      if (!claims) return new Response('Cloudflare Access authentication required', { status: 401 });

      const iceServers = await createIceServers(env);
      return Response.json({ iceServers }, {
        headers: {
          'Cache-Control': 'no-store',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    if (url.pathname.startsWith('/p2p/')) {
      const assetResponse = await env.ASSETS.fetch(request);
      const headers = new Headers(assetResponse.headers);

      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        headers.set(name, value);
      }

      headers.set('Cache-Control', 'no-store');
      if (headers.get('Content-Type')?.includes('text/html')) {
        headers.set(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'none'; connect-src 'self' wss://manbesi.lv; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'self'; worker-src 'self'",
        );
      }

      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
    }

    const mountPrefix = url.pathname === BEER_MAP_PREFIX || url.pathname.startsWith(`${BEER_MAP_PREFIX}/`)
      ? BEER_MAP_PREFIX
      : '';
    return proxyBeerMap(request, env, url, mountPrefix);
  },
} satisfies ExportedHandler<AppEnv>;

async function proxyBeerMap(request: Request, env: AppEnv, requestUrl: URL, mountPrefix: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (!env.BEER_MAP_ORIGIN_TOKEN) {
    return new Response('Beer map origin is not configured', { status: 503 });
  }

  const upstreamUrl = new URL(BEER_MAP_ORIGIN);
  upstreamUrl.pathname = mountPrefix ? requestUrl.pathname.slice(mountPrefix.length) || '/' : requestUrl.pathname;
  upstreamUrl.search = requestUrl.search;

  const upstreamHeaders = new Headers(request.headers);
  upstreamHeaders.delete('Authorization');
  upstreamHeaders.delete('Cookie');
  upstreamHeaders.delete('Host');
  upstreamHeaders.set('OAI-Sites-Authorization', `Bearer ${env.BEER_MAP_ORIGIN_TOKEN}`);

  const upstream = await fetch(new Request(upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders,
    redirect: 'manual',
  }));
  const headers = new Headers(upstream.headers);
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.delete('Set-Cookie');

  const location = headers.get('Location');
  if (location) {
    const target = new URL(location, upstreamUrl);
    if (target.origin === BEER_MAP_ORIGIN) {
      headers.set('Location', `${requestUrl.origin}${mountPrefix}${target.pathname}${target.search}${target.hash}`);
    }
  }

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  if (request.method === 'HEAD' || !headers.get('Content-Type')?.includes('text/html')) {
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  const upstreamHtml = await upstream.text();
  const html = mountPrefix
    ? upstreamHtml
      .replaceAll('="/_next/', `="${mountPrefix}/_next/`)
      .replaceAll('"pathname":"/"', `"pathname":"${mountPrefix}/"`)
    : upstreamHtml;
  headers.set('Cache-Control', 'no-store');
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://tiles.openfreemap.org; font-src https://tiles.openfreemap.org; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );

  return new Response(html, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function statusJson(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(value, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...extraHeaders,
    },
  });
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (!authorization
    || authorization.length > 1024
    || authorization.slice(0, 'Bearer '.length).toLowerCase() !== 'bearer ') return null;
  const token = authorization.slice('Bearer '.length);
  return token.length > 0 ? token : null;
}

async function timingSafeTokenMatches(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<string> {
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new RangeError('Body too large');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

function isValidStatusText(value: string): boolean {
  const length = Array.from(value).length;
  return length >= 1
    && length <= MAX_STATUS_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function createIceServers(env: AppEnv): Promise<unknown[]> {
  const fallback = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return fallback;

  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 3600 }),
      },
    );
    if (!response.ok) return fallback;
    const payload = await response.json() as { iceServers?: unknown };
    if (!Array.isArray(payload.iceServers)) return fallback;
    const sanitized = sanitizeIceServers(payload.iceServers);
    return sanitized.length > 0 ? sanitized : fallback;
  } catch {
    return fallback;
  }
}

function sanitizeIceServers(values: unknown[]): unknown[] {
  const output: unknown[] = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const urls = (Array.isArray(value.urls) ? value.urls : [value.urls]).filter(
      (url): url is string => typeof url === 'string'
        && url.length <= 2048
        && /^(stun|turn|turns):/i.test(url)
        && !/:53(?:\?|$)/.test(url),
    );
    if (urls.length === 0) continue;
    const entry: Record<string, unknown> = { urls };
    if (typeof value.username === 'string' && value.username.length <= 1024) entry.username = value.username;
    if (typeof value.credential === 'string' && value.credential.length <= 2048) entry.credential = value.credential;
    output.push(entry);
  }
  return output;
}
