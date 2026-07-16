import assert from 'node:assert/strict';
import test from 'node:test';

import { createDownloadSink, isWebKit } from '../p2p/download-sink.js';

test('uses the reliable memory route for ordinary Safari downloads', async () => {
  let registrations = 0;
  const runtime = fakeRuntime({
    userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15',
    onRegister() { registrations += 1; },
  });

  const sink = await createDownloadSink(
    { id: crypto.randomUUID(), name: 'secret.env', size: 5, mime: 'text/plain' },
    runtime,
  );

  assert.equal(sink.kind, 'memory');
  assert.equal(registrations, 0);
});

test('recognizes Safari/WebKit without classifying Chromium as WebKit download mode', () => {
  assert.equal(isWebKit('Mozilla/5.0 AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15'), true);
  assert.equal(isWebKit('Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'), false);
});

test('falls back to memory when a service-worker download never starts consuming bytes', async () => {
  const runtime = fakeRuntime({
    onCreate(port, message) {
      port.postMessage({ type: 'ack', sequence: message.sequence });
    },
  });
  const file = { id: crypto.randomUUID(), name: 'secret.env', size: 5, mime: 'text/plain' };

  const sink = await createDownloadSink(file, runtime);

  assert.equal(sink.kind, 'memory');
});

function fakeRuntime(workerBehavior) {
  const workerUrl = 'https://example.test/p2p/download-worker.js';
  const worker = {
    state: 'activated',
    scriptURL: workerUrl,
    postMessage(message, ports) {
      workerBehavior.onCreate(ports[0], message);
    },
  };
  const serviceWorker = {
    controller: worker,
    getRegistrations: async () => [],
    register: async () => {
      workerBehavior.onRegister?.();
      return { active: worker, update: async () => {} };
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return {
    Blob,
    MessageChannel: FakeMessageChannel,
    URL: { createObjectURL: () => 'blob:test' },
    activationTimeoutMs: 5,
    clearTimeout,
    controlTimeoutMs: 5,
    downloadStartTimeoutMs: 5,
    document: {
      body: { append() {} },
      createElement: () => ({ hidden: false, remove() {} }),
    },
    navigator: { serviceWorker, userAgent: workerBehavior.userAgent || 'TestBrowser/1.0' },
    setTimeout,
    window: {},
  };
}

class FakeMessageChannel {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

class FakePort {
  onmessage = null;
  peer = null;

  close() {}
  start() {}

  postMessage(data) {
    queueMicrotask(() => this.peer?.onmessage?.({ data }));
  }
}
