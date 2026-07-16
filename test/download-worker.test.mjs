import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('writes and acknowledges the first chunk even when Safari reports zero desired stream capacity', async () => {
  const listeners = new Map();
  const replies = [];
  const writes = [];
  const port = {
    onmessage: null,
    close() {},
    postMessage(message) { replies.push(message); },
    start() {},
  };
  class SafariReadableStream {
    constructor(source) {
      source.start({
        desiredSize: 0,
        close() {},
        enqueue(chunk) { writes.push(chunk); },
        error() {},
      });
    }
  }
  const context = vm.createContext({
    ArrayBuffer,
    Error,
    URL,
    Response,
    TextEncoder,
    Uint8Array,
    ReadableStream: SafariReadableStream,
    console,
    setTimeout() { return 0; },
    self: {
      addEventListener(type, listener) { listeners.set(type, listener); },
      clients: { claim: async () => {} },
      skipWaiting() {},
    },
  });
  const source = await readFile(new URL('../p2p/download-worker.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);

  const id = crypto.randomUUID();
  listeners.get('message')({
    data: { type: 'create-download', id, name: 'test.txt', size: 5, mime: 'text/plain', sequence: 1 },
    ports: [port],
  });
  listeners.get('fetch')({
    request: { method: 'GET', url: `https://example.test/p2p/download/${id}` },
    respondWith(response) { this.response = response; },
  });
  port.onmessage({ data: { type: 'chunk', sequence: 2, chunk: new TextEncoder().encode('hello').buffer } });

  assert.equal(writes.length, 1);
  assert.equal(new TextDecoder().decode(writes[0]), 'hello');
  assert.ok(replies.some((message) => message.type === 'download-started'));
  assert.ok(replies.some((message) => message.sequence === 2));
});
