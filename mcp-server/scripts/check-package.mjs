import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run via npm run pack:check');
const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))[0];
const paths = packed.files.map(file => file.path);
for (const file of paths) {
  assert.match(file, /^(dist\/.+\.js|runtime\/.+\.cs|docs\/(MIGRATION|VERIFICATION)\.md|package\.json|README(?:\.vi)?\.md|LICENSE)$/, `Unexpected packaged file: ${file}`);
  assert.doesNotMatch(file, /EkuHash|GlowOutfit|VmcHand|McpBridgeAsset|OnMcpCommandNode|test_anim|debug_ws/);
}
for (const required of ['dist/index.js', 'README.md', 'README.vi.md', 'LICENSE', 'runtime/McpBridgePlugin.cs', 'runtime/McpBridgeService.cs', 'runtime/GameObjectPathResolver.cs', 'runtime/MaterialKeywordOverrideStore.cs', 'docs/MIGRATION.md', 'docs/VERIFICATION.md']) {
  assert.ok(paths.includes(required), `Missing package file: ${required}`);
}
assert.match(await readFile(new URL('../dist/index.js', import.meta.url), 'utf8'), /^#!\/usr\/bin\/env node/);
console.log(`Package verified: ${paths.length} files, ${packed.unpackedSize} bytes; only runtime, built JavaScript and documentation.`);



