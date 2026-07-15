// Private browser-to-browser transfer. The manual handshake avoids a signaling server.

const MAX_FILE_SIZE = 250 * 1024 * 1024;
const MAX_TEXT_SIZE = 64 * 1024;
const CHUNK_SIZE = 64 * 1024;
document.querySelector('#app').innerHTML = `
  <div class="shell">
    <header class="header">
      <a class="wordmark" href="/">p2p</a>
      <span class="privacy">encrypted · no uploads</span>
    </header>

    <section class="intro">
      <div class="status-row">
        <span class="status-dot" id="status-dot"></span>
        <strong id="connection-status">Not connected</strong>
        <span class="session-label" id="session-label"></span>
      </div>
      <h1>Send it<br />straight there.</h1>
      <p>Text and files move directly between your devices. Nothing is stored here.</p>
    </section>

    <div class="grid">
      <section class="pairing panel">
        <div class="section-heading"><span class="step">01</span><h2>Connect two devices</h2></div>
        <button class="button button-primary" id="create-invite" type="button">Create invitation</button>
        <div class="divider"><span>or</span></div>
        <label class="field-label" for="pair-code">Paste a code from your other device</label>
        <textarea id="pair-code" rows="4" spellcheck="false" autocomplete="off" placeholder="Invitation or response code"></textarea>
        <div class="button-row">
          <button class="button" id="use-code" type="button">Use pasted code</button>
          <button class="button button-quiet" id="copy-code" type="button" disabled>Copy my code</button>
        </div>
        <p class="helper" id="pairing-help">Start on either device. Pairing codes contain connection details, so keep them private.</p>
      </section>

      <section class="transfer panel">
        <div class="section-heading"><span class="step">02</span><h2>Send something</h2></div>
        <label class="field-label" for="message">Text</label>
        <div class="composer">
          <textarea id="message" rows="3" maxlength="65536" placeholder="Paste a link or type a note…"></textarea>
          <button class="button button-primary" id="send-text" type="button" disabled>Send text</button>
        </div>
        <label class="file-drop" id="file-drop" for="file-input">
          <input id="file-input" type="file" multiple disabled />
          <span class="file-icon">＋</span>
          <strong>Choose files</strong>
          <span>or drop them here · up to 250 MB each</span>
        </label>
        <div class="progress" id="progress" hidden>
          <div class="progress-copy"><span id="progress-label">Sending…</span><span id="progress-value">0%</span></div>
          <div class="progress-track"><span id="progress-bar"></span></div>
        </div>
      </section>
    </div>

    <section class="activity">
      <div class="section-heading"><span class="step">03</span><h2>Activity</h2></div>
      <div class="empty-state" id="empty-state">Received text and files will appear here.</div>
      <ol class="activity-list" id="activity-list"></ol>
    </section>
  </div>`;

const elements = {
  status: document.querySelector('#connection-status'),
  statusDot: document.querySelector('#status-dot'),
  session: document.querySelector('#session-label'),
  code: document.querySelector('#pair-code'),
  help: document.querySelector('#pairing-help'),
  createInvite: document.querySelector('#create-invite'),
  useCode: document.querySelector('#use-code'),
  copyCode: document.querySelector('#copy-code'),
  message: document.querySelector('#message'),
  sendText: document.querySelector('#send-text'),
  fileInput: document.querySelector('#file-input'),
  fileDrop: document.querySelector('#file-drop'),
  progress: document.querySelector('#progress'),
  progressLabel: document.querySelector('#progress-label'),
  progressValue: document.querySelector('#progress-value'),
  progressBar: document.querySelector('#progress-bar'),
  list: document.querySelector('#activity-list'),
  empty: document.querySelector('#empty-state'),
};

let peer = null;
let channel = null;
let sessionId = null;
let ownCode = '';
let incomingFile = null;
let transferBusy = false;

function setStatus(label, state = 'idle') {
  elements.status.textContent = label;
  elements.statusDot.dataset.state = state;
}

function setConnected(connected) {
  elements.sendText.disabled = !connected;
  elements.fileInput.disabled = !connected;
  elements.fileDrop.classList.toggle('disabled', !connected);
  if (connected) {
    setStatus('Direct connection ready', 'connected');
    elements.help.textContent = 'Connected. You can clear the pairing codes now.';
    addActivity('system', 'Secure peer-to-peer connection established.');
  }
}

function createPeer() {
  if (peer) peer.close();
  peer = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;
    if (state === 'connected') setConnected(true);
    if (['failed', 'disconnected', 'closed'].includes(state)) {
      setConnected(false);
      setStatus(state === 'failed' ? 'Connection failed' : 'Disconnected', 'error');
    }
  };
  peer.ondatachannel = (event) => bindChannel(event.channel);
  return peer;
}

function bindChannel(nextChannel) {
  channel = nextChannel;
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 1024 * 1024;
  channel.onopen = () => setConnected(true);
  channel.onclose = () => setConnected(false);
  channel.onerror = () => setStatus('Transfer channel error', 'error');
  channel.onmessage = handleIncoming;
}

function waitForIce(candidatePeer) {
  if (candidatePeer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, 8000);
    candidatePeer.addEventListener('icegatheringstatechange', onChange);
    function onChange() {
      if (candidatePeer.iceGatheringState === 'complete') done();
    }
    function done() {
      clearTimeout(timeout);
      candidatePeer.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }
  });
}

function encodeHandshake(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decodeHandshake(value) {
  const normalized = value.trim().replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  if (payload.v !== 1 || !['offer', 'answer'].includes(payload.type) || !payload.sdp) {
    throw new Error('This is not a Drop pairing code.');
  }
  return payload;
}

async function showOwnCode(payload, instruction) {
  ownCode = encodeHandshake(payload);
  elements.code.value = ownCode;
  elements.copyCode.disabled = false;
  elements.help.textContent = instruction;
  await copyText(ownCode, false);
}

async function createInvitation() {
  try {
    setStatus('Building invitation…', 'working');
    sessionId = crypto.randomUUID().slice(0, 8);
    elements.session.textContent = `#${sessionId}`;
    const connection = createPeer();
    bindChannel(connection.createDataChannel('drop', { ordered: true }));
    await connection.setLocalDescription(await connection.createOffer());
    await waitForIce(connection);
    await showOwnCode(
      { v: 1, type: 'offer', sessionId, sdp: connection.localDescription },
      'Invitation copied. Send it to the other device, paste it there, then bring its response back here.',
    );
    setStatus('Waiting for other device', 'working');
  } catch (error) {
    reportError(error);
  }
}

async function usePastedCode() {
  try {
    const payload = decodeHandshake(elements.code.value);
    if (payload.type === 'offer') {
      setStatus('Joining invitation…', 'working');
      sessionId = payload.sessionId;
      elements.session.textContent = `#${sessionId}`;
      const connection = createPeer();
      await connection.setRemoteDescription(payload.sdp);
      await connection.setLocalDescription(await connection.createAnswer());
      await waitForIce(connection);
      await showOwnCode(
        { v: 1, type: 'answer', sessionId, sdp: connection.localDescription },
        'Response copied. Paste it back on the device that created the invitation.',
      );
      setStatus('Response ready', 'working');
      return;
    }

    if (!peer || !peer.localDescription || peer.localDescription.type !== 'offer') {
      throw new Error('Create an invitation on this device before using a response code.');
    }
    if (payload.sessionId !== sessionId) throw new Error('That response belongs to a different invitation.');
    await peer.setRemoteDescription(payload.sdp);
    setStatus('Connecting…', 'working');
    elements.code.value = '';
  } catch (error) {
    reportError(error);
  }
}

async function copyText(value, notify = true) {
  try {
    await navigator.clipboard.writeText(value);
    if (notify) elements.help.textContent = 'Code copied.';
  } catch {
    elements.code.focus();
    elements.code.select();
    if (notify) elements.help.textContent = 'Select the code and copy it manually.';
  }
}

function reportError(error) {
  console.error(error);
  setStatus('Needs attention', 'error');
  elements.help.textContent = error?.message || 'Something went wrong.';
}

function assertOpenChannel() {
  if (!channel || channel.readyState !== 'open') throw new Error('Connect the other device first.');
}

function sendTextMessage() {
  try {
    assertOpenChannel();
    const text = elements.message.value.trim();
    if (!text) return;
    if (new Blob([text]).size > MAX_TEXT_SIZE) throw new Error('Text is over the 64 KB limit.');
    channel.send(JSON.stringify({ type: 'text', value: text, sentAt: Date.now() }));
    addActivity('sent-text', text);
    elements.message.value = '';
  } catch (error) {
    reportError(error);
  }
}

async function sendFiles(files) {
  if (transferBusy || !files.length) return;
  try {
    assertOpenChannel();
    transferBusy = true;
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) throw new Error(`${file.name} is over the 250 MB limit.`);
      const id = crypto.randomUUID();
      channel.send(JSON.stringify({ type: 'file-meta', id, name: file.name, size: file.size, mime: file.type }));
      elements.progress.hidden = false;
      elements.progressLabel.textContent = `Sending ${file.name}`;
      let offset = 0;
      while (offset < file.size) {
        const buffer = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        await waitForChannelBuffer();
        channel.send(buffer);
        offset += buffer.byteLength;
        showProgress(offset, file.size);
      }
      channel.send(JSON.stringify({ type: 'file-end', id }));
      addActivity('sent-file', file.name, file.size);
    }
  } catch (error) {
    reportError(error);
  } finally {
    transferBusy = false;
    elements.progress.hidden = true;
    elements.fileInput.value = '';
  }
}

function waitForChannelBuffer() {
  if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return Promise.resolve();
  return new Promise((resolve) => channel.addEventListener('bufferedamountlow', resolve, { once: true }));
}

function handleIncoming(event) {
  if (typeof event.data === 'string') {
    const message = JSON.parse(event.data);
    if (message.type === 'text') addActivity('received-text', message.value);
    if (message.type === 'file-meta') {
      incomingFile = { ...message, chunks: [], received: 0 };
      elements.progress.hidden = false;
      elements.progressLabel.textContent = `Receiving ${message.name}`;
      showProgress(0, message.size);
    }
    if (message.type === 'file-end' && incomingFile?.id === message.id) finishIncomingFile();
    return;
  }
  if (!incomingFile) return;
  incomingFile.chunks.push(event.data);
  incomingFile.received += event.data.byteLength;
  showProgress(incomingFile.received, incomingFile.size);
}

function finishIncomingFile() {
  const file = incomingFile;
  const blob = new Blob(file.chunks, { type: file.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  addActivity('received-file', file.name, file.size, url);
  incomingFile = null;
  elements.progress.hidden = true;
}

function showProgress(done, total) {
  const percent = total === 0 ? 100 : Math.min(100, Math.round((done / total) * 100));
  elements.progressValue.textContent = `${percent}%`;
  elements.progressBar.style.width = `${percent}%`;
}

function addActivity(type, value, size = null, url = null) {
  elements.empty.hidden = true;
  const item = document.createElement('li');
  item.className = `activity-item ${type}`;
  const direction = type.startsWith('received') ? 'Received' : type.startsWith('sent') ? 'Sent' : 'Status';
  const safeValue = document.createElement('div');
  safeValue.className = 'activity-value';
  safeValue.textContent = value;
  const meta = document.createElement('div');
  meta.className = 'activity-meta';
  meta.textContent = `${direction}${size === null ? '' : ` · ${formatBytes(size)}`} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  item.append(meta, safeValue);
  if (url) {
    const link = document.createElement('a');
    link.className = 'download-link';
    link.href = url;
    link.download = value;
    link.textContent = 'Save file ↓';
    item.append(link);
  }
  elements.list.prepend(item);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

elements.createInvite.addEventListener('click', createInvitation);
elements.useCode.addEventListener('click', usePastedCode);
elements.copyCode.addEventListener('click', () => copyText(ownCode));
elements.sendText.addEventListener('click', sendTextMessage);
elements.message.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') sendTextMessage();
});
elements.fileInput.addEventListener('change', () => sendFiles([...elements.fileInput.files]));
elements.fileDrop.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (!elements.fileInput.disabled) elements.fileDrop.classList.add('dragging');
});
elements.fileDrop.addEventListener('dragleave', () => elements.fileDrop.classList.remove('dragging'));
elements.fileDrop.addEventListener('drop', (event) => {
  event.preventDefault();
  elements.fileDrop.classList.remove('dragging');
  if (!elements.fileInput.disabled) sendFiles([...event.dataTransfer.files]);
});
setConnected(false);
