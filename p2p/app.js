import { collectTransferFiles } from './file-drop.js';

const MAX_FILE_SIZE = 250 * 1024 * 1024;
const MAX_RETAINED_FILE_BYTES = 300 * 1024 * 1024;
const MAX_TEXT_SIZE = 64 * 1024;
const MAX_CONTROL_MESSAGE_SIZE = 80 * 1024;
const CHUNK_SIZE = 64 * 1024;
const MAX_FILE_ITEMS = 24;
const TEXT_SYNC_DELAY_MS = 120;
const TEXT_RATE_WINDOW_MS = 10_000;
const MAX_TEXT_UPDATES_PER_WINDOW = 120;
const HEARTBEAT_INTERVAL_MS = 20_000;

const elements = {
  presenceDot: document.querySelector('#presence-dot'),
  presenceLabel: document.querySelector('#presence-label'),
  syncLabel: document.querySelector('#sync-label'),
  text: document.querySelector('#shared-text'),
  fileSpace: document.querySelector('#file-space'),
  fileInput: document.querySelector('#file-input'),
  dropCopy: document.querySelector('#drop-copy'),
  fileList: document.querySelector('#file-list'),
  transfer: document.querySelector('#transfer'),
  transferLabel: document.querySelector('#transfer-label'),
  transferValue: document.querySelector('#transfer-value'),
  transferBar: document.querySelector('#transfer-bar'),
};

let signalSocket = null;
let peer = null;
let channel = null;
let peerId = crypto.randomUUID();
let generation = 0;
let signalSequence = 0;
let reconnectAttempt = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let syncTimer = null;
let disconnectTimer = null;
let closing = false;
let reconnectBlocked = false;
let isInitiator = false;
let incomingFile = null;
let transferBusy = false;
let preparationBusy = false;
let pendingCandidates = [];
let textClock = 0;
let lastTextVersion = { clock: 0, sender: '' };
let textDirty = false;
let incomingTextTimes = [];
let retainedFileBytes = 0;
const objectUrls = new Set();

function setPresence(label, state = 'waiting') {
  elements.presenceLabel.textContent = label;
  elements.presenceDot.dataset.state = state;
}

function setFilesEnabled(enabled) {
  elements.fileInput.disabled = !enabled;
  elements.dropCopy.textContent = enabled ? 'Drop files or folders here' : 'Waiting for the other device';
}

function signalingUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/p2p/ws`;
}

function connectSignaling() {
  clearTimeout(reconnectTimer);
  if (closing || reconnectBlocked) return;

  setPresence(reconnectAttempt === 0 ? 'Connecting' : 'Reconnecting');
  const socket = new WebSocket(signalingUrl());
  signalSocket = socket;

  socket.addEventListener('open', () => {
    reconnectAttempt = 0;
    setPresence('Waiting for another device');
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  });

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string' || byteLength(event.data) > 32 * 1024) {
      socket.close(1008, 'Invalid signaling message');
      return;
    }

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      socket.close(1008, 'Malformed signaling message');
      return;
    }

    handleSignal(message).catch(reportError);
  });

  socket.addEventListener('close', () => {
    if (signalSocket !== socket) return;
    signalSocket = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    closePeer();
    if (closing || reconnectBlocked) return;
    setPresence('Connection interrupted', 'error');
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    if (signalSocket === socket) setPresence('Unable to connect', 'error');
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const base = Math.min(30_000, 500 * (2 ** reconnectAttempt));
  const delay = base + Math.floor(Math.random() * Math.max(100, base * 0.25));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(connectSignaling, delay);
}

async function handleSignal(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;

  if (message.type === 'welcome' && isUuid(message.peerId)) {
    peerId = message.peerId;
    return;
  }

  if (message.type === 'waiting') {
    setPresence('Waiting for another device');
    return;
  }

  if (message.type === 'peer-left') {
    closePeer();
    setPresence('Waiting for another device');
    return;
  }

  if (message.type === 'peer-ready') {
    if (!Number.isSafeInteger(message.generation) || message.generation < 1 || typeof message.initiator !== 'boolean') {
      throw new Error('Invalid room state.');
    }
    generation = message.generation;
    signalSequence = 0;
    isInitiator = message.initiator;
    await createPeer(message.initiator);
    return;
  }

  if (message.version !== 1 || message.generation !== generation || !Number.isSafeInteger(message.seq)) return;

  if (message.type === 'description' && isDescription(message.description)) {
    await receiveDescription(message.description);
    return;
  }

  if (message.type === 'candidate' && isCandidate(message.candidate)) {
    await receiveCandidate(message.candidate);
  }
}

async function createPeer(initiator) {
  closePeer();
  setPresence('Connecting devices');
  const connection = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  peer = connection;
  pendingCandidates = [];

  connection.addEventListener('icecandidate', (event) => {
    sendSignal('candidate', { candidate: event.candidate?.toJSON() ?? null });
  });

  connection.addEventListener('datachannel', (event) => bindChannel(event.channel));

  connection.addEventListener('connectionstatechange', () => {
    clearTimeout(disconnectTimer);
    if (connection.connectionState === 'connected') {
      setPresence('Connected', 'connected');
      return;
    }
    if (connection.connectionState === 'disconnected') {
      setPresence('Reconnecting');
      disconnectTimer = setTimeout(() => {
        if (peer === connection && connection.connectionState === 'disconnected') restartSignaling();
      }, 10_000);
      return;
    }
    if (connection.connectionState === 'failed') {
      setPresence('Peer connection failed', 'error');
      restartSignaling();
    }
  });

  if (!initiator) return;
  bindChannel(connection.createDataChannel('workspace', { ordered: true }));
  await connection.setLocalDescription(await connection.createOffer());
  sendSignal('description', { description: connection.localDescription });
}

async function receiveDescription(description) {
  if (!peer) throw new Error('Peer connection is not ready.');
  await peer.setRemoteDescription(description);
  await flushCandidates();
  if (description.type !== 'offer') return;
  await peer.setLocalDescription(await peer.createAnswer());
  sendSignal('description', { description: peer.localDescription });
}

async function receiveCandidate(candidate) {
  if (!peer) return;
  if (!peer.remoteDescription) {
    if (pendingCandidates.length >= 128) throw new Error('Too many pending network candidates.');
    pendingCandidates.push(candidate);
    return;
  }
  await peer.addIceCandidate(candidate);
}

async function flushCandidates() {
  if (!peer?.remoteDescription) return;
  for (const candidate of pendingCandidates.splice(0)) await peer.addIceCandidate(candidate);
}

function sendSignal(type, payload) {
  if (!signalSocket || signalSocket.readyState !== WebSocket.OPEN || generation < 1) return;
  signalSequence += 1;
  signalSocket.send(JSON.stringify({
    version: 1,
    generation,
    seq: signalSequence,
    type,
    ...payload,
  }));
}

function sendHeartbeat() {
  if (signalSocket?.readyState === WebSocket.OPEN) {
    signalSocket.send(JSON.stringify({ type: 'heartbeat' }));
  }
}

function bindChannel(nextChannel) {
  if (channel && channel !== nextChannel) channel.close();
  channel = nextChannel;
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 1024 * 1024;

  channel.addEventListener('open', () => {
    setPresence('Connected', 'connected');
    setFilesEnabled(true);
    if (isInitiator || textDirty) publishText(true);
  });
  channel.addEventListener('close', () => {
    setFilesEnabled(false);
    if (channel === nextChannel && peer) restartSignaling();
  });
  channel.addEventListener('error', () => reportError(new Error('The private channel failed.')));
  channel.addEventListener('message', handleIncoming);
}

function closePeer() {
  clearTimeout(disconnectTimer);
  disconnectTimer = null;
  incomingFile = null;
  elements.transfer.hidden = true;
  setFilesEnabled(false);
  if (channel) {
    const oldChannel = channel;
    channel = null;
    oldChannel.removeEventListener('message', handleIncoming);
    oldChannel.close();
  }
  if (peer) {
    peer.close();
    peer = null;
  }
  pendingCandidates = [];
}

function restartSignaling(allowReconnect = true) {
  if (!allowReconnect) reconnectBlocked = true;
  closePeer();
  if (signalSocket && signalSocket.readyState < WebSocket.CLOSING) {
    signalSocket.close(4000, 'Restarting peer connection');
    return;
  }
  if (!signalSocket && !closing && !reconnectBlocked) scheduleReconnect();
}

function channelIsOpen() {
  return channel?.readyState === 'open';
}

function queueTextSync() {
  textClock += 1;
  lastTextVersion = { clock: textClock, sender: peerId };
  textDirty = true;
  elements.syncLabel.textContent = channelIsOpen() ? 'Syncing' : 'Ready locally';
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => publishText(false), TEXT_SYNC_DELAY_MS);
}

function publishText(force) {
  if (!channelIsOpen()) return;
  if (force) {
    textClock += 1;
    lastTextVersion = { clock: textClock, sender: peerId };
  }
  const value = elements.text.value;
  if (byteLength(value) > MAX_TEXT_SIZE) {
    reportError(new Error('Shared text is over the 64 KB limit.'));
    return;
  }
  channel.send(JSON.stringify({ type: 'text-sync', value, clock: textClock, sender: peerId }));
  textDirty = false;
  elements.syncLabel.textContent = 'Live';
}

function handleIncoming(event) {
  if (typeof event.data === 'string') {
    if (byteLength(event.data) > MAX_CONTROL_MESSAGE_SIZE) return protocolViolation('Control message too large.');
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return protocolViolation('Malformed control message.');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return protocolViolation('Invalid control message.');
    }
    if (message.type === 'text-sync') return receiveText(message);
    if (message.type === 'file-meta') return receiveFileMeta(message);
    if (message.type === 'file-end') return receiveFileEnd(message);
    if (message.type === 'file-abort') return receiveFileAbort(message);
    return protocolViolation('Unknown control message.');
  }

  if (!incomingFile || !(event.data instanceof ArrayBuffer)) return protocolViolation('Unexpected binary data.');
  if (event.data.byteLength > CHUNK_SIZE) return protocolViolation('File chunk too large.');
  if (incomingFile.received + event.data.byteLength > incomingFile.size
    || incomingFile.received + event.data.byteLength > MAX_FILE_SIZE) {
    return protocolViolation('Incoming file exceeded its declared size.');
  }
  incomingFile.chunks.push(event.data);
  incomingFile.received += event.data.byteLength;
  showProgress(`Receiving ${incomingFile.name}`, incomingFile.received, incomingFile.size);
}

function receiveText(message) {
  const valid = typeof message.value === 'string'
    && byteLength(message.value) <= MAX_TEXT_SIZE
    && Number.isSafeInteger(message.clock)
    && message.clock >= 0
    && message.clock <= Number.MAX_SAFE_INTEGER
    && isUuid(message.sender);
  if (!valid) return protocolViolation('Invalid text update.');

  const now = Date.now();
  incomingTextTimes = incomingTextTimes.filter((time) => now - time < TEXT_RATE_WINDOW_MS);
  if (incomingTextTimes.length >= MAX_TEXT_UPDATES_PER_WINDOW) return protocolViolation('Text update rate exceeded.');
  incomingTextTimes.push(now);

  textClock = Math.max(textClock, message.clock);
  const version = { clock: message.clock, sender: message.sender };
  if (compareVersion(version, lastTextVersion) <= 0) return;
  lastTextVersion = version;
  elements.text.value = message.value;
  textDirty = false;
  elements.syncLabel.textContent = 'Live';
}

function receiveFileMeta(message) {
  const validName = typeof message.name === 'string'
    && message.name.length > 0
    && message.name.length <= 255
    && !/[\u0000-\u001f\u007f/\\]/.test(message.name);
  const valid = isUuid(message.id)
    && validName
    && Number.isSafeInteger(message.size)
    && message.size >= 0
    && message.size <= MAX_FILE_SIZE
    && typeof message.mime === 'string'
    && message.mime.length <= 128;
  if (!valid || incomingFile) return protocolViolation('Invalid file metadata.');
  makeRoomForIncomingFile(message.size);

  incomingFile = {
    id: message.id,
    name: message.name,
    size: message.size,
    mime: message.mime,
    chunks: [],
    received: 0,
  };
  showProgress(`Receiving ${message.name}`, 0, message.size);
}

function receiveFileEnd(message) {
  if (!incomingFile || message.id !== incomingFile.id || incomingFile.received !== incomingFile.size) {
    return protocolViolation('Incomplete file transfer.');
  }

  const file = incomingFile;
  const blob = new Blob(file.chunks, { type: file.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  addFile(file.name, file.size, 'Received', url);
  incomingFile = null;
  elements.transfer.hidden = true;
}

function receiveFileAbort(message) {
  if (!incomingFile || !isUuid(message.id) || message.id !== incomingFile.id) {
    return protocolViolation('Invalid file cancellation.');
  }
  incomingFile = null;
  elements.transfer.hidden = true;
}

async function sendFiles(files) {
  if (!channelIsOpen() || transferBusy || files.length === 0) return;
  transferBusy = true;
  let activeFileId = null;
  try {
    for (const file of files) {
      const validName = file.name.length > 0
        && file.name.length <= 255
        && !/[\u0000-\u001f\u007f/\\]/.test(file.name);
      if (!validName) throw new Error('That filename is not supported.');
      if (!Number.isSafeInteger(file.size) || file.size > MAX_FILE_SIZE) {
        throw new Error(`${file.name} is over the 250 MB limit.`);
      }

      const id = crypto.randomUUID();
      activeFileId = id;
      channel.send(JSON.stringify({
        type: 'file-meta',
        id,
        name: file.name,
        size: file.size,
        mime: file.type.slice(0, 128),
      }));

      let offset = 0;
      showProgress(`Sending ${file.name}`, 0, file.size);
      while (offset < file.size) {
        const buffer = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        await waitForChannelBuffer();
        channel.send(buffer);
        offset += buffer.byteLength;
        showProgress(`Sending ${file.name}`, offset, file.size);
      }
      channel.send(JSON.stringify({ type: 'file-end', id }));
      addFile(file.name, file.size, 'Sent');
      activeFileId = null;
    }
  } catch (error) {
    if (activeFileId && channelIsOpen()) {
      try {
        channel.send(JSON.stringify({ type: 'file-abort', id: activeFileId }));
      } catch {
        restartSignaling();
      }
    }
    reportError(error);
  } finally {
    transferBusy = false;
    elements.transfer.hidden = true;
    elements.fileInput.value = '';
  }
}

function waitForChannelBuffer() {
  if (!channelIsOpen()) return Promise.reject(new Error('The other device disconnected.'));
  if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waitingChannel = channel;
    const cleanup = () => {
      waitingChannel.removeEventListener('bufferedamountlow', onReady);
      waitingChannel.removeEventListener('close', onClose);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('The other device disconnected.'));
    };
    waitingChannel.addEventListener('bufferedamountlow', onReady, { once: true });
    waitingChannel.addEventListener('close', onClose, { once: true });
  });
}

function showProgress(label, complete, total) {
  const percent = total === 0 ? 100 : Math.min(100, Math.round((complete / total) * 100));
  elements.transfer.hidden = false;
  elements.transferLabel.textContent = label;
  elements.transferValue.textContent = `${percent}%`;
  elements.transferBar.style.width = `${percent}%`;
}

function addFile(name, size, direction, url = null) {
  const item = document.createElement('li');
  item.className = 'file-item';
  const copy = document.createElement('div');
  const fileName = document.createElement('div');
  fileName.className = 'file-name';
  fileName.textContent = name;
  const meta = document.createElement('div');
  meta.className = 'file-meta';
  meta.textContent = `${direction} · ${formatBytes(size)}`;
  copy.append(fileName, meta);
  item.append(copy);

  if (url) {
    const link = document.createElement('a');
    link.className = 'file-download';
    link.href = url;
    link.download = name;
    link.textContent = 'Save';
    item.append(link);
    item.dataset.objectUrl = url;
    item.dataset.fileSize = String(size);
    retainedFileBytes += size;
  }

  elements.fileList.prepend(item);
  while (elements.fileList.children.length > MAX_FILE_ITEMS) {
    const oldest = elements.fileList.lastElementChild;
    releaseFileItem(oldest);
    oldest?.remove();
  }
}

function makeRoomForIncomingFile(size) {
  const receivedItems = [...elements.fileList.querySelectorAll('[data-object-url]')].reverse();
  for (const item of receivedItems) {
    if (retainedFileBytes + size <= MAX_RETAINED_FILE_BYTES) break;
    releaseFileItem(item);
    item.remove();
  }
  if (retainedFileBytes + size > MAX_RETAINED_FILE_BYTES) {
    throw new Error('Not enough browser memory for that file.');
  }
}

function releaseFileItem(item) {
  if (!item?.dataset.objectUrl) return;
  URL.revokeObjectURL(item.dataset.objectUrl);
  objectUrls.delete(item.dataset.objectUrl);
  retainedFileBytes = Math.max(0, retainedFileBytes - Number(item.dataset.fileSize || 0));
}

function protocolViolation(reason) {
  reportError(new Error(reason));
  restartSignaling(false);
}

function reportError(error) {
  console.error(error);
  setPresence(error?.message || 'Something went wrong', 'error');
}

function compareVersion(left, right) {
  if (left.clock !== right.clock) return left.clock - right.clock;
  return left.sender.localeCompare(right.sender);
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function isUuid(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function isDescription(value) {
  return value
    && typeof value === 'object'
    && (value.type === 'offer' || value.type === 'answer')
    && typeof value.sdp === 'string'
    && value.sdp.length > 0
    && value.sdp.length <= 24 * 1024;
}

function isCandidate(value) {
  if (value === null) return true;
  return value
    && typeof value === 'object'
    && typeof value.candidate === 'string'
    && value.candidate.length <= 4096;
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

elements.text.addEventListener('input', queueTextSync);
elements.fileInput.addEventListener('change', () => sendFiles([...elements.fileInput.files]));
elements.fileSpace.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (!elements.fileInput.disabled) elements.fileSpace.classList.add('dragging');
});
elements.fileSpace.addEventListener('dragleave', () => elements.fileSpace.classList.remove('dragging'));
elements.fileSpace.addEventListener('drop', async (event) => {
  event.preventDefault();
  elements.fileSpace.classList.remove('dragging');
  if (elements.fileInput.disabled || transferBusy || preparationBusy) return;
  preparationBusy = true;
  try {
    const files = await collectTransferFiles(event.dataTransfer, ({ name, complete, total }) => {
      showProgress(`Preparing ${name}`, complete, total);
    });
    preparationBusy = false;
    await sendFiles(files);
  } catch (error) {
    elements.transfer.hidden = true;
    reportError(error);
  } finally {
    preparationBusy = false;
  }
});

window.addEventListener('beforeunload', () => {
  closing = true;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  signalSocket?.close(1000, 'Page closed');
  closePeer();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
});

setFilesEnabled(false);
connectSignaling();
