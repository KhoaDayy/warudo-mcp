import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeStdio } from './smoke-stdio.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run via npm run test:install');
const tempRoot = await mkdtemp(path.join(tmpdir(), 'warudo-mcp-install-'));
const npm = args => execFileSync(process.execPath, [npmCli, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true });
try {
  // Caller builds and prepares files first. No publishing or global installation.
  const [tarball] = JSON.parse(npm(['pack', packageRoot, '--pack-destination', tempRoot, '--ignore-scripts', '--json']));
  await writeFile(path.join(tempRoot, 'package.json'), '{"private":true}\n');
  npm(['install', '--prefix', tempRoot, path.join(tempRoot, tarball.filename), '--ignore-scripts', '--no-audit', '--no-fund']);
  const installed = path.join(tempRoot, 'node_modules', 'warudo-mcp-server');
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'warudo-mcp-server');
  const result = await smokeStdio(path.join(installed, 'dist', 'index.js'));
  console.log(`Clean package installation passed: ${manifest.version}, ${result.toolCount} tools.`);
} finally {
  const resolved = path.resolve(tempRoot);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith('warudo-mcp-install-'));
  await rm(resolved, { recursive: true, force: true });
}
