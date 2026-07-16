export const MEMORY_DOWNLOAD_LIMIT = 250 * 1024 * 1024;

export async function createDownloadSink(file, runtime = browserRuntime()) {
  if (typeof runtime.window.showSaveFilePicker === 'function') return createNativeSink(file, runtime);
  try {
    return await createServiceWorkerSink(file, runtime);
  } catch (error) {
    if (file.size > MEMORY_DOWNLOAD_LIMIT) throw error;
    return createMemorySink(file, runtime);
  }
}

async function createNativeSink(file, runtime) {
  const handle = await runtime.window.showSaveFilePicker({ suggestedName: file.name });
  const writable = await handle.createWritable();
  return {
    kind: 'disk',
    write: (chunk) => writable.write(chunk),
    close: async () => { await writable.close(); return {}; },
    abort: (reason) => writable.abort(reason),
  };
}

async function createServiceWorkerSink(file, runtime) {
  if (!('serviceWorker' in runtime.navigator)) throw new Error('Streaming downloads are not supported by this browser.');
  const registrations = await runtime.navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations
    .filter((item) => item.scope.endsWith('/p2p/download/'))
    .map((item) => item.unregister()));
  const registration = await runtime.navigator.serviceWorker.register('./download-worker.js', {
    scope: '/p2p/',
    updateViaCache: 'none',
  });
  await registration.update();
  const worker = await activeWorker(registration, runtime);
  const channel = new runtime.MessageChannel();
  const pending = new Map();
  let sequence = 0;
  let failed = null;
  let downloadStarted = null;

  channel.port1.onmessage = ({ data }) => {
    if (data?.type === 'error') {
      failed = new Error(data.message || 'The browser download failed.');
      for (const waiter of pending.values()) waiter.reject(failed);
      pending.clear();
      return;
    }
    if (data?.type === 'download-started') {
      downloadStarted?.resolve();
      downloadStarted = null;
      return;
    }
    const waiter = pending.get(data?.sequence);
    if (!waiter) return;
    pending.delete(data.sequence);
    waiter.resolve();
  };
  channel.port1.start();

  const ready = waitFor(sequence += 1);
  worker.postMessage({
    type: 'create-download',
    id: file.id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    sequence,
  }, [channel.port2]);
  await ready;

  const frame = runtime.document.createElement('iframe');
  frame.src = `/p2p/download/${encodeURIComponent(file.id)}`;
  frame.hidden = true;
  frame.title = '';
  runtime.document.body.append(frame);
  try {
    await waitForDownloadStart();
  } catch (error) {
    channel.port1.postMessage({ type: 'abort', message: 'Download did not start.' });
    channel.port1.close();
    frame.remove();
    throw error;
  }

  function waitFor(nextSequence) {
    if (failed) return Promise.reject(failed);
    return new Promise((resolve, reject) => pending.set(nextSequence, { resolve, reject }));
  }

  function waitForDownloadStart() {
    return new Promise((resolve, reject) => {
      const timeout = runtime.setTimeout(() => {
        downloadStarted = null;
        reject(new Error('The browser download did not start.'));
      }, runtime.downloadStartTimeoutMs ?? 5_000);
      downloadStarted = {
        resolve() {
          runtime.clearTimeout(timeout);
          resolve();
        },
      };
    });
  }

  return {
    kind: 'disk',
    async write(chunk) {
      const nextSequence = sequence += 1;
      const done = waitFor(nextSequence);
      channel.port1.postMessage({ type: 'chunk', sequence: nextSequence, chunk }, [chunk]);
      await done;
    },
    async close() {
      const nextSequence = sequence += 1;
      const done = waitFor(nextSequence);
      channel.port1.postMessage({ type: 'end', sequence: nextSequence });
      await done;
      channel.port1.close();
      return {};
    },
    async abort(reason) {
      channel.port1.postMessage({ type: 'abort', message: String(reason || 'Transfer cancelled') });
      channel.port1.close();
      frame.remove();
    },
  };
}

function createMemorySink(file, runtime) {
  const chunks = [];
  return {
    kind: 'memory',
    async write(chunk) { chunks.push(chunk); },
    async close() {
      return {
        url: runtime.URL.createObjectURL(
          new runtime.Blob(chunks, { type: file.mime || 'application/octet-stream' }),
        ),
      };
    },
    async abort() { chunks.length = 0; },
  };
}

function activeWorker(registration, runtime) {
  const worker = registration.installing || registration.waiting || registration.active;
  if (!worker) return Promise.reject(new Error('The download service could not start.'));
  if (worker.state === 'activated') return Promise.resolve(worker);
  return new Promise((resolve, reject) => {
    const timeout = runtime.setTimeout(
      () => reject(new Error('The download service took too long to start.')),
      runtime.activationTimeoutMs ?? 10_000,
    );
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') {
        runtime.clearTimeout(timeout);
        resolve(worker);
      } else if (worker.state === 'redundant') {
        runtime.clearTimeout(timeout);
        reject(new Error('The download service failed to start.'));
      }
    });
  });
}

function browserRuntime() {
  return {
    Blob,
    MessageChannel,
    URL,
    clearTimeout: (handle) => clearTimeout(handle),
    document,
    navigator,
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    window,
  };
}
