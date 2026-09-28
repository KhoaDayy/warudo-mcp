import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Exercise the real process boundary without touching the user's running Warudo. */
export async function smokeStdio(entry, typescript = false) {
  const child = spawn(process.execPath, [...(typescript ? ['--import', 'tsx'] : []), entry], {
    env: { ...process.env, WARUDO_API_TOKEN: 'A'.repeat(32), WARUDO_API_WS_URL: 'ws://127.0.0.1:1/', WARUDO_WS_URL: 'ws://127.0.0.1:1/' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  let buffer = '';
  let violation;
  const replies = new Map();
  child.stderr.on('data', data => { stderr += data.toString(); });
  child.stdout.on('data', data => {
    buffer += data.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, '2.0');
        assert.ok('id' in message, 'unexpected stdout notification');
        replies.set(message.id, message);
      } catch (error) { violation = error; }
    }
  });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const watchdog = setTimeout(() => child.kill(), 12000);
  const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const receive = async id => {
    const deadline = Date.now() + 7000;
    while (!replies.has(id)) {
      if (violation) throw violation;
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`MCP process did not answer ${id}: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return replies.get(id);
  };
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stdio-smoke', version: '1' } } });
    assert.equal((await receive(1)).result.serverInfo.name, 'warudo-mcp');
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    const tools = (await receive(2)).result.tools;
    assert.ok(tools.some(tool => tool.name === 'warudo_manage_graph'));
    assert.ok(tools.some(tool => tool.name === 'warudo_invoke_flow'));
    assert.ok(!tools.some(tool => tool.name === 'warudo_trigger'));
    assert.ok(!tools.some(tool => /glow_outfit|switch_outfit|list_avatars|create_blueprint/.test(tool.name)));
    send({ id: 3, method: 'tools/call', params: { name: 'warudo_status', arguments: {} } });
    const status = (await receive(3)).result;
    assert.notEqual(status.isError, true);
    assert.equal(JSON.parse(status.content[0].text).native.connected, false);
    child.stdin.end();
    const stopped = await exit;
    assert.deepEqual(stopped, { code: 0, signal: null });
    assert.equal(buffer.trim(), '');
    assert.equal(violation, undefined);
    assert.equal(replies.size, 3, 'notifications must not produce responses');
    assert.ok(!stderr.includes('A'.repeat(32)), 'token leaked to stderr');
    return { toolCount: tools.length };
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await smokeStdio(process.argv[2] ?? fileURLToPath(new URL('../dist/index.js', import.meta.url)));
  console.log(`Stdio smoke passed: ${result.toolCount} tools; clean JSON-RPC, offline startup and stdin shutdown.`);
}
