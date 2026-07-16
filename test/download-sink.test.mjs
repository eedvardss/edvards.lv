import assert from 'node:assert/strict';
import test from 'node:test';

import { createDownloadSink } from '../p2p/download-sink.js';

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
    register: async () => ({ active: worker, update: async () => {} }),
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
    navigator: { serviceWorker },
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
