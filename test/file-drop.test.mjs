import assert from 'node:assert/strict';
import test from 'node:test';

import { collectTransferFiles } from '../p2p/file-drop.js';

function fileEntry(name, contents) {
  return {
    isDirectory: false,
    isFile: true,
    name,
    file(resolve) {
      resolve(new File([contents], name, { lastModified: Date.UTC(2026, 0, 1) }));
    },
  };
}

function directoryEntry(name, children, batchSize = 2) {
  return {
    isDirectory: true,
    isFile: false,
    name,
    createReader() {
      let offset = 0;
      return {
        readEntries(resolve) {
          const batch = children.slice(offset, offset + batchSize);
          offset += batch.length;
          resolve(batch);
        },
      };
    },
  };
}

function folderDrop(entry) {
  return {
    items: [{ kind: 'file', webkitGetAsEntry: () => entry }],
    files: [new File([], entry.name)],
  };
}

test('turns a dropped folder into a non-empty ZIP with nested paths', async () => {
  const folder = directoryEntry('photos', [
    fileEntry('cover.txt', 'cover'),
    directoryEntry('summer', [fileEntry('beach.txt', 'waves')], 1),
  ], 1);

  const files = await collectTransferFiles(folderDrop(folder));

  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'photos.zip');
  assert.equal(files[0].type, 'application/zip');
  assert.ok(files[0].size > 0);
  const archive = new Uint8Array(await files[0].arrayBuffer());
  assert.equal(new DataView(archive.buffer).getUint32(0, true), 0x04034b50);
  assert.equal(new DataView(archive.buffer).getUint32(archive.length - 22, true), 0x06054b50);
  const archiveText = new TextDecoder().decode(archive);
  assert.match(archiveText, /photos\/cover\.txt/);
  assert.match(archiveText, /photos\/summer\/beach\.txt/);
});

test('keeps a legitimate zero-byte file when no directory entry is available', async () => {
  const empty = new File([], 'empty.txt', { type: 'text/plain' });
  const files = await collectTransferFiles({ items: [], files: [empty] });
  assert.deepEqual(files, [empty]);
});

test('rejects traversal-like folder names', async () => {
  const folder = directoryEntry('..', [fileEntry('secret.txt', 'nope')]);
  await assert.rejects(collectTransferFiles(folderDrop(folder)), /name is not supported/i);
});

test('captures every dropped root synchronously before the browser clears the drop store', async () => {
  let dropStoreOpen = true;
  const first = directoryEntry('first', [fileEntry('a.txt', 'a')]);
  const second = directoryEntry('second', [fileEntry('b.txt', 'b')]);
  const transfer = {
    items: [first, second].map((entry) => ({
      kind: 'file',
      webkitGetAsEntry: () => (dropStoreOpen ? entry : null),
      getAsFile: () => null,
    })),
    files: [new File([], 'first'), new File([], 'second')],
  };

  const pending = collectTransferFiles(transfer);
  dropStoreOpen = false;
  const files = await pending;

  assert.deepEqual(files.map((file) => file.name), ['first.zip', 'second.zip']);
  assert.ok(files.every((file) => file.size > 0));
});

test('reads every browser directory batch and preserves an empty directory', async () => {
  const children = Array.from({ length: 201 }, (_, index) => fileEntry(`file-${index}.txt`, String(index)));
  children.push(directoryEntry('empty', []));
  const folder = directoryEntry('many', children, 100);

  const [archive] = await collectTransferFiles(folderDrop(folder));
  const archiveText = new TextDecoder().decode(await archive.arrayBuffer());

  assert.match(archiveText, /many\/file-200\.txt/);
  assert.match(archiveText, /many\/empty\//);
});

test('rejects paths that collide after normalization and case folding', async () => {
  const folder = directoryEntry('root', [fileEntry('A.txt', 'one'), fileEntry('a.txt', 'two')]);
  await assert.rejects(collectTransferFiles(folderDrop(folder)), /duplicate paths/i);
});
