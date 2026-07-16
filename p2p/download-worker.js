const downloads = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const message = event.data;
  const port = event.ports[0];
  if (!port || message?.type !== 'create-download' || !validId(message.id)) return;
  const transfer = {
    id: message.id,
    name: safeName(message.name),
    size: Number.isSafeInteger(message.size) && message.size >= 0 ? message.size : 0,
    mime: typeof message.mime === 'string' && isMime(message.mime) ? message.mime : 'application/octet-stream',
    port,
    queue: [],
    controller: null,
    ended: false,
    endSequence: 0,
  };
  downloads.set(message.id, transfer);
  port.onmessage = ({ data }) => receive(transfer, data);
  port.start();
  port.postMessage({ type: 'ack', sequence: message.sequence });
  setTimeout(() => {
    if (downloads.get(message.id) === transfer && !transfer.controller) abort(transfer, 'Download was not opened.');
  }, 30_000);
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/p2p/download/')) return;
  let id;
  try {
    id = decodeURIComponent(url.pathname.slice('/p2p/download/'.length));
  } catch {
    event.respondWith(new Response('Invalid download', { status: 400 }));
    return;
  }
  const transfer = downloads.get(id);
  if (!transfer || event.request.method !== 'GET') {
    event.respondWith(new Response('Download expired', { status: 404 }));
    return;
  }
  const stream = new ReadableStream({
    start(controller) {
      transfer.controller = controller;
      transfer.port.postMessage({ type: 'download-started' });
      flush(transfer);
    },
    pull() { flush(transfer); },
    cancel() { abort(transfer, 'Download cancelled.'); },
  });
  event.respondWith(new Response(stream, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'",
      'Content-Disposition': contentDisposition(transfer.name),
      'Content-Length': String(transfer.size),
      'Content-Type': transfer.mime || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    },
  }));
});

function receive(transfer, message) {
  if (message?.type === 'chunk' && message.chunk instanceof ArrayBuffer && message.chunk.byteLength <= 64 * 1024) {
    transfer.queue.push({ chunk: message.chunk, sequence: message.sequence });
    flush(transfer);
    return;
  }
  if (message?.type === 'end') {
    transfer.ended = true;
    transfer.endSequence = message.sequence;
    flush(transfer);
    return;
  }
  if (message?.type === 'abort') abort(transfer, message.message || 'Transfer cancelled.');
}

function flush(transfer) {
  if (!transfer.controller) return;
  while (transfer.queue.length > 0) {
    const item = transfer.queue.shift();
    try {
      transfer.controller.enqueue(new Uint8Array(item.chunk));
      transfer.port.postMessage({ type: 'ack', sequence: item.sequence });
    } catch {
      abort(transfer, 'The browser stopped the download.');
      return;
    }
  }
  if (transfer.ended && transfer.queue.length === 0) {
    transfer.controller.close();
    transfer.port.postMessage({ type: 'ack', sequence: transfer.endSequence });
    transfer.port.close();
    downloads.delete(transfer.id);
  }
}

function abort(transfer, message) {
  try { transfer.controller?.error(new Error(message)); } catch {}
  try { transfer.port.postMessage({ type: 'error', message }); } catch {}
  transfer.port.close();
  downloads.delete(transfer.id);
}

function validId(value) {
  return typeof value === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function safeName(value) {
  const name = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/g, '_').slice(0, 255)
    : 'download';
  return name || 'download';
}

function isMime(value) {
  return value.length <= 128
    && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value);
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
