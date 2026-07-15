const MAX_ARCHIVE_SIZE = 250 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_PATH_BYTES = 4096;
const ZIP_UTF8_FLAG = 0x0800;

const encoder = new TextEncoder();
const crcTable = makeCrcTable();

export async function collectTransferFiles(dataTransfer, onProgress = () => {}) {
  const items = [...(dataTransfer.items || [])].filter((item) => item.kind === 'file');
  if (items.length === 0) return [...(dataTransfer.files || [])];
  const sources = items.map((item) => {
    const getEntry = item.getAsEntry || item.webkitGetAsEntry;
    const entry = typeof getEntry === 'function' ? getEntry.call(item) : null;
    const file = !entry && typeof item.getAsFile === 'function' ? item.getAsFile() : null;
    return { entry, file };
  });

  const files = [];
  let handledItem = false;
  for (const { entry, file } of sources) {
    if (entry?.isDirectory) {
      handledItem = true;
      const entries = [];
      await collectEntry(entry, [], entries, { count: 0, paths: new Set() });
      files.push(await createStoredZip(entry.name, entries, onProgress));
      continue;
    }
    if (entry?.isFile) {
      handledItem = true;
      files.push(await fileFromEntry(entry));
      continue;
    }
    if (file) {
      handledItem = true;
      files.push(file);
    }
  }

  return handledItem ? files : [...(dataTransfer.files || [])];
}

async function collectEntry(entry, parents, entries, state) {
  const name = validateSegment(entry.name);
  const segments = [...parents, name];
  if (segments.length > 16) throw new Error('That folder is nested too deeply.');
  const path = segments.join('/').normalize('NFC');
  if (encoder.encode(path).byteLength > MAX_PATH_BYTES) throw new Error('A folder path is too long.');
  const collisionKey = path.toLowerCase();
  if (state.paths.has(collisionKey)) throw new Error('That folder contains duplicate paths.');
  state.paths.add(collisionKey);
  state.count += 1;
  if (state.count > MAX_ARCHIVE_ENTRIES) throw new Error('That folder contains too many items.');

  if (entry.isDirectory) {
    entries.push({ path: `${path}/`, directory: true, file: null });
    const reader = entry.createReader();
    while (true) {
      const batch = await readEntries(reader);
      if (batch.length === 0) break;
      for (const child of batch) await collectEntry(child, segments, entries, state);
    }
    return;
  }

  if (!entry.isFile) throw new Error('That folder item is not supported.');
  const file = await fileFromEntry(entry);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_ARCHIVE_SIZE) {
    throw new Error(`${name} is over the 250 MB limit.`);
  }
  entries.push({ path, directory: false, file });
}

function validateSegment(value) {
  const name = typeof value === 'string' ? value.normalize('NFC') : '';
  if (!name || name === '.' || name === '..' || encoder.encode(name).byteLength > 255
    || /[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/.test(name)) {
    throw new Error('A folder or file name is not supported.');
  }
  return name;
}

function fileFromEntry(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function createStoredZip(rootName, entries, onProgress) {
  let archiveBase = validateSegment(rootName);
  while (`${archiveBase}.zip`.length > 255) archiveBase = archiveBase.slice(0, -1);
  const archiveName = `${archiveBase}.zip`;
  const prepared = entries.map((entry) => ({
    ...entry,
    nameBytes: encoder.encode(entry.path),
    size: entry.directory ? 0 : entry.file.size,
  }));
  const estimatedSize = 22 + prepared.reduce(
    (total, entry) => total + 30 + entry.nameBytes.byteLength + entry.size + 46 + entry.nameBytes.byteLength,
    0,
  );
  if (!Number.isSafeInteger(estimatedSize) || estimatedSize > MAX_ARCHIVE_SIZE) {
    throw new Error(`${archiveName} is over the 250 MB limit.`);
  }

  const totalBytes = prepared.reduce((total, entry) => total + entry.size, 0);
  let completedBytes = 0;
  let offset = 0;
  const localParts = [];
  const centralParts = [];

  for (const entry of prepared) {
    const { date, time } = dosDateTime(entry.file?.lastModified);
    const crc = entry.directory ? 0 : await crc32File(entry.file, (size) => {
      completedBytes += size;
      onProgress({ name: archiveName, complete: completedBytes, total: totalBytes });
    });
    const localHeader = bytes(30);
    const local = new DataView(localHeader.buffer);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, ZIP_UTF8_FLAG, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.size, true);
    local.setUint32(22, entry.size, true);
    local.setUint16(26, entry.nameBytes.byteLength, true);
    local.setUint16(28, 0, true);

    const centralHeader = bytes(46);
    const central = new DataView(centralHeader.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, ZIP_UTF8_FLAG, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, entry.size, true);
    central.setUint32(24, entry.size, true);
    central.setUint16(28, entry.nameBytes.byteLength, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, entry.directory ? 0x10 : 0, true);
    central.setUint32(42, offset, true);

    localParts.push(localHeader, entry.nameBytes);
    if (!entry.directory) localParts.push(entry.file);
    centralParts.push(centralHeader, entry.nameBytes);
    offset += localHeader.byteLength + entry.nameBytes.byteLength + entry.size;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  const end = bytes(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, prepared.length, true);
  endView.setUint16(10, prepared.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  onProgress({ name: archiveName, complete: totalBytes, total: totalBytes });
  return new File([...localParts, ...centralParts, end], archiveName, {
    type: 'application/zip',
    lastModified: Date.now(),
  });
}

async function crc32File(file, onChunk) {
  let crc = 0xffffffff;
  if (typeof file.stream === 'function') {
    const reader = file.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      crc = updateCrc(crc, value);
      onChunk(value.byteLength);
    }
  } else {
    const value = new Uint8Array(await file.arrayBuffer());
    crc = updateCrc(crc, value);
    onChunk(value.byteLength);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function updateCrc(crc, value) {
  let next = crc;
  for (const byte of value) next = crcTable[(next ^ byte) & 0xff] ^ (next >>> 8);
  return next;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

function dosDateTime(value) {
  const dateValue = new Date(Number.isFinite(value) ? value : Date.now());
  const year = Math.min(2107, Math.max(1980, dateValue.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((dateValue.getMonth() + 1) << 5) | dateValue.getDate(),
    time: (dateValue.getHours() << 11) | (dateValue.getMinutes() << 5) | Math.floor(dateValue.getSeconds() / 2),
  };
}

function bytes(length) {
  return new Uint8Array(length);
}
