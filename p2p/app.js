import { createDownloadSink } from './download-sink.js';
import { collectTransferFiles } from './file-drop.js';
import { deriveSafetyCode, validateIceServers } from './security.js';

const MAX_FILE_SIZE = 8 * 1024 * 1024 * 1024;
const MAX_RETAINED_FILE_BYTES = 300 * 1024 * 1024;
const MAX_TEXT_SIZE = 64 * 1024;
const MAX_CONTROL_MESSAGE_SIZE = 80 * 1024;
const CHUNK_SIZE = 64 * 1024;
const RECEIVER_WINDOW = CHUNK_SIZE;
const MAX_FILE_ITEMS = 24;
const TEXT_SYNC_DELAY_MS = 120;
const TEXT_RATE_WINDOW_MS = 10_000;
const MAX_TEXT_UPDATES_PER_WINDOW = 120;
const HEARTBEAT_INTERVAL_MS = 20_000;
const FILE_READY_TIMEOUT_MS = 2 * 60_000;
const FILE_ACK_TIMEOUT_MS = 30_000;

const elements = {
  presenceDot: document.querySelector('#presence-dot'),
  presenceLabel: document.querySelector('#presence-label'),
  syncLabel: document.querySelector('#sync-label'),
  pairing: document.querySelector('#pairing'),
  safetyCode: document.querySelector('#safety-code'),
  pairingCopy: document.querySelector('#pairing-copy'),
  approveDevice: document.querySelector('#approve-device'),
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
let isApprover = false;
let workspaceApproved = false;
let safetyCode = null;
let incomingFile = null;
let outgoingFile = null;
let transferBusy = false;
let preparationBusy = false;
let pendingCandidates = [];
let textClock = 0;
let lastTextVersion = { clock: 0, sender: '' };
let textDirty = false;
let incomingTextTimes = [];
let retainedFileBytes = 0;
const objectUrls = new Set();
const retainedDownloads = [];

function setPresence(label, state = 'waiting') {
  elements.presenceLabel.textContent = label;
  elements.presenceDot.dataset.state = state;
}

function setWorkspaceEnabled(enabled) {
  elements.text.disabled = !enabled;
  elements.fileInput.disabled = !enabled;
  elements.dropCopy.textContent = enabled ? 'Click or drop files or folders here' : 'Waiting for an approved device';
  if (!enabled) elements.syncLabel.textContent = textDirty ? 'Ready locally' : 'Waiting';
}

function resetPairing() {
  workspaceApproved = false;
  isApprover = false;
  safetyCode = null;
  elements.pairing.hidden = true;
  elements.safetyCode.textContent = 'Generating…';
  elements.approveDevice.hidden = true;
  elements.approveDevice.disabled = true;
  setWorkspaceEnabled(false);
}

function showPairing() {
  elements.pairing.hidden = false;
  elements.approveDevice.hidden = !isApprover;
  elements.approveDevice.disabled = !isApprover || !safetyCode;
  elements.pairingCopy.textContent = isApprover
    ? 'Compare this on the other device, then approve it.'
    : 'Compare this code on the first device.';
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

  socket.addEventListener('close', (event) => {
    if (signalSocket !== socket) return;
    signalSocket = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    closePeer();
    if (closing || reconnectBlocked) return;
    setPresence(event.code === 4003 ? 'Device was rejected' : 'Connection interrupted', 'error');
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
  if (message.type === 'workspace-approved' && message.generation === generation) {
    workspaceApproved = true;
    elements.pairing.hidden = true;
    activateWorkspace();
    return;
  }
  if (message.type === 'workspace-rejected' && message.generation === generation) {
    setPresence('Device rejected', 'error');
    restartSignaling();
    return;
  }
  if (message.type === 'peer-ready') {
    if (!Number.isSafeInteger(message.generation) || message.generation < 1
      || typeof message.initiator !== 'boolean' || typeof message.approver !== 'boolean') {
      throw new Error('Invalid room state.');
    }
    generation = message.generation;
    signalSequence = 0;
    isInitiator = message.initiator;
    isApprover = message.approver;
    workspaceApproved = false;
    safetyCode = null;
    showPairing();
    await createPeer(message.initiator);
    return;
  }
  if (message.version !== 1 || message.generation !== generation || !Number.isSafeInteger(message.seq)) return;
  if (message.type === 'description' && isDescription(message.description)) {
    await receiveDescription(message.description);
    return;
  }
  if (message.type === 'candidate' && isCandidate(message.candidate)) await receiveCandidate(message.candidate);
}

async function createPeer(initiator) {
  closePeer(false);
  isApprover = initiator;
  showPairing();
  setPresence('Connecting devices');
  const connection = new RTCPeerConnection({ iceServers: await fetchIceServers() });
  peer = connection;
  pendingCandidates = [];

  connection.addEventListener('icecandidate', (event) => {
    sendSignal('candidate', { candidate: event.candidate?.toJSON() ?? null });
  });
  connection.addEventListener('datachannel', (event) => bindChannel(event.channel));
  connection.addEventListener('connectionstatechange', () => {
    clearTimeout(disconnectTimer);
    if (connection.connectionState === 'connected') {
      if (workspaceApproved) activateWorkspace();
      else setPresence('Verify the safety code');
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
  await updateSafetyCode();
}

async function fetchIceServers() {
  const fallback = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
  try {
    const response = await fetch('/p2p/ice', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return fallback;
    return validateIceServers(await response.json()) || fallback;
  } catch {
    return fallback;
  }
}

async function receiveDescription(description) {
  if (!peer) throw new Error('Peer connection is not ready.');
  await peer.setRemoteDescription(description);
  await flushCandidates();
  if (description.type === 'offer') {
    await peer.setLocalDescription(await peer.createAnswer());
    sendSignal('description', { description: peer.localDescription });
  }
  await updateSafetyCode();
}

async function updateSafetyCode() {
  if (!peer?.localDescription?.sdp || !peer.remoteDescription?.sdp) return;
  const code = await deriveSafetyCode(peer.localDescription.sdp, peer.remoteDescription.sdp, generation);
  if (!code || peer?.localDescription?.sdp === undefined) return;
  safetyCode = code;
  elements.safetyCode.textContent = code;
  showPairing();
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
  signalSocket.send(JSON.stringify({ version: 1, generation, seq: signalSequence, type, ...payload }));
}

function sendHeartbeat() {
  if (signalSocket?.readyState === WebSocket.OPEN) signalSocket.send(JSON.stringify({ type: 'heartbeat' }));
}

function bindChannel(nextChannel) {
  if (channel && channel !== nextChannel) channel.close();
  channel = nextChannel;
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 1024 * 1024;
  channel.addEventListener('open', () => {
    if (workspaceApproved) activateWorkspace();
    else setPresence('Verify the safety code');
  });
  channel.addEventListener('close', () => {
    setWorkspaceEnabled(false);
    if (channel === nextChannel && peer) restartSignaling();
  });
  channel.addEventListener('error', () => reportError(new Error('The private channel failed.')));
  channel.addEventListener('message', (event) => { handleIncoming(event).catch(reportError); });
}

function activateWorkspace() {
  if (!workspaceApproved || !channelIsOpen()) return;
  setPresence('Connected', 'connected');
  setWorkspaceEnabled(true);
  if (isInitiator || textDirty) publishText(true);
}

function closePeer(reset = true) {
  clearTimeout(disconnectTimer);
  disconnectTimer = null;
  if (incomingFile?.sink) incomingFile.sink.abort('Connection closed').catch(() => {});
  incomingFile = null;
  rejectOutgoing(new Error('The other device disconnected.'));
  elements.transfer.hidden = true;
  setWorkspaceEnabled(false);
  if (channel) {
    const oldChannel = channel;
    channel = null;
    oldChannel.close();
  }
  if (peer) {
    peer.close();
    peer = null;
  }
  pendingCandidates = [];
  if (reset) resetPairing();
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
  elements.syncLabel.textContent = workspaceApproved && channelIsOpen() ? 'Syncing' : 'Ready locally';
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => publishText(false), TEXT_SYNC_DELAY_MS);
}

function publishText(force) {
  if (!workspaceApproved || !channelIsOpen()) return;
  if (force) {
    textClock += 1;
    lastTextVersion = { clock: textClock, sender: peerId };
  }
  const value = elements.text.value;
  if (byteLength(value) > MAX_TEXT_SIZE) return reportError(new Error('Shared text is over the 64 KB limit.'));
  sendControl({ type: 'text-sync', value, clock: textClock, sender: peerId });
  textDirty = false;
  elements.syncLabel.textContent = 'Live';
}

async function handleIncoming(event) {
  if (!workspaceApproved) return protocolViolation('Data arrived before device approval.');
  if (typeof event.data === 'string') {
    if (byteLength(event.data) > MAX_CONTROL_MESSAGE_SIZE) return protocolViolation('Control message too large.');
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return protocolViolation('Malformed control message.');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return protocolViolation('Invalid control message.');
    if (message.type === 'text-sync') return receiveText(message);
    if (message.type === 'file-meta') return receiveFileMeta(message);
    if (message.type === 'file-ready') return receiveFileReady(message);
    if (message.type === 'file-ack') return receiveFileAck(message);
    if (message.type === 'file-complete') return receiveFileComplete(message);
    if (message.type === 'file-decline') return receiveFileDecline(message);
    if (message.type === 'file-end') return receiveFileEnd(message);
    if (message.type === 'file-abort') return receiveFileAbort(message);
    return protocolViolation('Unknown control message.');
  }

  if (!incomingFile?.accepted || !(event.data instanceof ArrayBuffer)) return protocolViolation('Unexpected binary data.');
  if (event.data.byteLength > CHUNK_SIZE) return protocolViolation('File chunk too large.');
  if (incomingFile.received + event.data.byteLength > incomingFile.size) {
    return protocolViolation('Incoming file exceeded its declared size.');
  }
  const file = incomingFile;
  const chunk = event.data;
  file.received += chunk.byteLength;
  file.writeChain = file.writeChain.then(async () => {
    await file.sink.write(chunk);
    file.persisted += chunk.byteLength;
    sendControl({ type: 'file-ack', id: file.id, received: file.persisted });
    showProgress(`Receiving ${file.name}`, file.persisted, file.size);
  });
  file.writeChain.catch((error) => failIncoming(file, error));
}

function receiveText(message) {
  const valid = typeof message.value === 'string' && byteLength(message.value) <= MAX_TEXT_SIZE
    && Number.isSafeInteger(message.clock) && message.clock >= 0 && isUuid(message.sender);
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
  const validName = typeof message.name === 'string' && message.name.length > 0 && message.name.length <= 255
    && !/[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/.test(message.name);
  const valid = isUuid(message.id) && validName && Number.isSafeInteger(message.size)
    && message.size >= 0 && message.size <= MAX_FILE_SIZE
    && typeof message.mime === 'string' && message.mime.length <= 128
    && (message.mime === '' || isMime(message.mime));
  if (!valid || incomingFile) return protocolViolation('Invalid file metadata.');
  const file = {
    id: message.id,
    name: message.name,
    size: message.size,
    mime: message.mime,
    accepted: false,
    received: 0,
    persisted: 0,
    sink: null,
    writeChain: Promise.resolve(),
    item: null,
  };
  incomingFile = file;
  file.item = addIncomingPrompt(file);
  showProgress(`Waiting to save ${file.name}`, 0, file.size);
}

function addIncomingPrompt(file) {
  const item = document.createElement('li');
  item.className = 'file-item';
  const copy = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = file.name;
  const meta = document.createElement('div');
  meta.className = 'file-meta';
  meta.textContent = `Incoming · ${formatBytes(file.size)}`;
  copy.append(name, meta);
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'file-action';
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    if (incomingFile !== file || file.accepted) return;
    save.disabled = true;
    try {
      file.sink = await createDownloadSink(file);
      if (file.sink.kind === 'memory') makeRoomForIncomingFile(file.size);
      file.accepted = true;
      meta.textContent = `Receiving · ${formatBytes(file.size)}`;
      save.remove();
      sendControl({ type: 'file-ready', id: file.id });
      showProgress(`Receiving ${file.name}`, 0, file.size);
    } catch (error) {
      save.disabled = false;
      if (error?.name !== 'AbortError') reportError(error);
    }
  });
  item.append(copy, save);
  elements.fileList.prepend(item);
  trimFileList();
  return item;
}

function receiveFileReady(message) {
  if (!outgoingFile || message.id !== outgoingFile.id || outgoingFile.ready) return protocolViolation('Invalid file readiness.');
  outgoingFile.ready = true;
  outgoingFile.notify();
}

function receiveFileAck(message) {
  if (!outgoingFile || message.id !== outgoingFile.id || !Number.isSafeInteger(message.received)
    || message.received < outgoingFile.acked || message.received > outgoingFile.size) {
    return protocolViolation('Invalid file acknowledgement.');
  }
  outgoingFile.acked = message.received;
  outgoingFile.notify();
}

function receiveFileComplete(message) {
  if (!outgoingFile || message.id !== outgoingFile.id) return protocolViolation('Invalid file completion.');
  outgoingFile.complete = true;
  outgoingFile.notify();
}

function receiveFileDecline(message) {
  if (!outgoingFile || message.id !== outgoingFile.id) return protocolViolation('Invalid file cancellation.');
  outgoingFile.error = new Error('The other device declined the file.');
  outgoingFile.notify();
}

async function receiveFileEnd(message) {
  const file = incomingFile;
  if (!file?.accepted || message.id !== file.id || file.received !== file.size) {
    return protocolViolation('Incomplete file transfer.');
  }
  try {
    await file.writeChain;
    if (file.persisted !== file.size) return protocolViolation('The file was not fully saved.');
    const result = await file.sink.close();
    finishIncomingRow(file, result.url || null);
    sendControl({ type: 'file-complete', id: file.id });
    incomingFile = null;
    elements.transfer.hidden = true;
  } catch (error) {
    await failIncoming(file, error);
  }
}

async function receiveFileAbort(message) {
  if (!incomingFile || !isUuid(message.id) || message.id !== incomingFile.id) {
    return protocolViolation('Invalid file cancellation.');
  }
  await incomingFile.sink?.abort('Sender cancelled').catch(() => {});
  incomingFile.item?.remove();
  incomingFile = null;
  elements.transfer.hidden = true;
}

async function failIncoming(file, error) {
  if (incomingFile !== file) return;
  await file.sink?.abort(error).catch(() => {});
  sendControl({ type: 'file-abort', id: file.id });
  file.item?.remove();
  incomingFile = null;
  reportError(error);
}

function finishIncomingRow(file, url) {
  const meta = file.item?.querySelector('.file-meta');
  if (meta) meta.textContent = `Downloaded · ${formatBytes(file.size)}`;
  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.hidden = true;
    file.item?.append(link);
    objectUrls.add(url);
    retainedDownloads.push({ size: file.size, url });
    retainedFileBytes += file.size;
    link.click();
    setTimeout(() => releaseRetainedDownload(url), 60_000);
  }
  if (file.item) {
    file.item.classList.add('complete');
    setTimeout(() => file.item?.remove(), 900);
  }
}

async function sendFiles(files) {
  if (!workspaceApproved || !channelIsOpen() || transferBusy || files.length === 0) return;
  transferBusy = true;
  try {
    for (const file of files) await sendFile(file);
  } catch (error) {
    if (outgoingFile && channelIsOpen()) sendControl({ type: 'file-abort', id: outgoingFile.id });
    reportError(error);
  } finally {
    rejectOutgoing(new Error('Transfer finished.'));
    transferBusy = false;
    elements.transfer.hidden = true;
    elements.fileInput.value = '';
  }
}

async function sendFile(file) {
  const validName = file.name.length > 0 && file.name.length <= 255
    && !/[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/.test(file.name);
  if (!validName) throw new Error('That filename is not supported.');
  if (!Number.isSafeInteger(file.size) || file.size > MAX_FILE_SIZE) throw new Error(`${file.name} is over the 8 GB limit.`);
  const state = makeOutgoing(file);
  outgoingFile = state;
  sendControl({ type: 'file-meta', id: state.id, name: file.name, size: file.size, mime: file.type.slice(0, 128) });
  showProgress(`Waiting for ${file.name}`, 0, file.size);
  await waitForOutgoing((value) => value.ready, FILE_READY_TIMEOUT_MS, 'The other device did not choose where to save the file.');

  let offset = 0;
  showProgress(`Sending ${file.name}`, 0, file.size);
  while (offset < file.size) {
    const buffer = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    await waitForChannelBuffer();
    channel.send(buffer);
    offset += buffer.byteLength;
    showProgress(`Sending ${file.name}`, offset, file.size);
    if (offset - state.acked >= RECEIVER_WINDOW) {
      await waitForOutgoing((value) => value.acked >= offset - RECEIVER_WINDOW / 2, FILE_ACK_TIMEOUT_MS, 'The other device stopped saving the file.');
    }
  }
  await waitForOutgoing((value) => value.acked === file.size, FILE_ACK_TIMEOUT_MS, 'The other device did not finish writing the file.');
  sendControl({ type: 'file-end', id: state.id });
  await waitForOutgoing((value) => value.complete, FILE_ACK_TIMEOUT_MS, 'The other device did not finish the download.');
  outgoingFile = null;
}

function makeOutgoing(file) {
  const state = {
    id: crypto.randomUUID(),
    size: file.size,
    ready: false,
    acked: 0,
    complete: false,
    error: null,
    waiter: null,
    notify() {
      const notify = state.waiter;
      state.waiter = null;
      notify?.();
    },
  };
  return state;
}

async function waitForOutgoing(predicate, timeoutMs, timeoutMessage) {
  const state = outgoingFile;
  const deadline = Date.now() + timeoutMs;
  while (state === outgoingFile && !predicate(state)) {
    if (state.error) throw state.error;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(timeoutMessage);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, remaining);
      state.waiter = () => { clearTimeout(timer); resolve(); };
    });
  }
  if (state !== outgoingFile) throw new Error('The file transfer ended.');
  if (state.error) throw state.error;
}

function rejectOutgoing(error) {
  if (!outgoingFile) return;
  outgoingFile.error = error;
  outgoingFile.notify();
  outgoingFile = null;
}

function sendControl(message) {
  if (!channelIsOpen()) throw new Error('The other device disconnected.');
  channel.send(JSON.stringify(message));
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
    const onReady = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('The other device disconnected.')); };
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

function trimFileList() {
  while (elements.fileList.children.length > MAX_FILE_ITEMS) {
    const oldest = elements.fileList.lastElementChild;
    oldest?.remove();
  }
}

function makeRoomForIncomingFile(size) {
  while (retainedFileBytes + size > MAX_RETAINED_FILE_BYTES && retainedDownloads.length > 0) {
    releaseRetainedDownload(retainedDownloads[0].url);
  }
  if (retainedFileBytes + size > MAX_RETAINED_FILE_BYTES) throw new Error('Not enough browser memory for that file.');
}

function releaseRetainedDownload(url) {
  const index = retainedDownloads.findIndex((download) => download.url === url);
  if (index === -1) return;
  const [download] = retainedDownloads.splice(index, 1);
  URL.revokeObjectURL(download.url);
  objectUrls.delete(download.url);
  retainedFileBytes = Math.max(0, retainedFileBytes - download.size);
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
  return value && typeof value === 'object' && (value.type === 'offer' || value.type === 'answer')
    && typeof value.sdp === 'string' && value.sdp.length > 0 && value.sdp.length <= 24 * 1024;
}

function isCandidate(value) {
  if (value === null) return true;
  return value && typeof value === 'object' && typeof value.candidate === 'string' && value.candidate.length <= 4096;
}

function isMime(value) {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value);
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

elements.approveDevice.addEventListener('click', () => {
  if (!isApprover || !safetyCode) return;
  elements.approveDevice.disabled = true;
  elements.pairingCopy.textContent = 'Approving…';
  sendSignal('approval', { decision: 'approve' });
});
elements.text.addEventListener('input', queueTextSync);
elements.fileInput.addEventListener('change', () => sendFiles([...elements.fileInput.files]));
elements.fileSpace.addEventListener('click', (event) => {
  if (elements.fileInput.disabled || transferBusy || preparationBusy) return;
  if (event.target.closest('button, a')) return;
  elements.fileInput.click();
});
elements.fileSpace.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  if (!elements.fileInput.disabled && !transferBusy && !preparationBusy) elements.fileInput.click();
});
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
  retainedDownloads.length = 0;
  retainedFileBytes = 0;
});

resetPairing();
connectSignaling();
