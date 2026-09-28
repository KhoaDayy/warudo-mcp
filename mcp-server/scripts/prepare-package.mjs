import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(root, '..');
const runtime = path.join(root, 'runtime');
// Exact generated child of the package root, never the user's Warudo installation.
if (path.dirname(path.resolve(runtime)) !== path.resolve(root) || path.basename(runtime) !== 'runtime') throw new Error('Invalid package runtime path');
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
for (const file of ['README.md', 'README.vi.md', 'LICENSE']) {
  await copyFile(path.join(repo, file), path.join(root, file));
}
for (const file of await readdir(path.join(repo, 'warudo-plugin'), { recursive: true })) {
  if (!file.endsWith('.cs')) continue;
  const target = path.join(runtime, file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(repo, 'warudo-plugin', file), target);
}
await mkdir(path.join(root, 'docs'), { recursive: true });
for (const file of ['MIGRATION.md', 'VERIFICATION.md']) await copyFile(path.join(repo, 'docs', file), path.join(root, 'docs', file));
console.error('Prepared package documentation and Warudo plugin sources.');

