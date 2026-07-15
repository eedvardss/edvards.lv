import { copyFile, mkdir, rm } from 'node:fs/promises';

const output = new URL('../dist/', import.meta.url);
const p2pOutput = new URL('./p2p/', output);

await rm(output, { recursive: true, force: true });
await mkdir(p2pOutput, { recursive: true });

await Promise.all([
  copyFile(new URL('../index.html', import.meta.url), new URL('./index.html', output)),
  copyFile(new URL('../root.css', import.meta.url), new URL('./root.css', output)),
  copyFile(new URL('../p2p/index.html', import.meta.url), new URL('./index.html', p2pOutput)),
  copyFile(new URL('../p2p/app.js', import.meta.url), new URL('./app.js', p2pOutput)),
  copyFile(new URL('../p2p/styles.css', import.meta.url), new URL('./styles.css', p2pOutput)),
]);
