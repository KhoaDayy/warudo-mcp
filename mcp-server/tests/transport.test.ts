import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { WarudoApiClient } from "../src/warudoApi.js";
import { WarudoBridge } from "../src/warudoBridge.js";

const TOKEN = "0123456789ABCDEF0123456789ABCDEF";
const UUID = "12345678-1234-1234-1234-123456789abc";
type Message = { action: string; data: Record<string, unknown> };

async function eventually(predicate: () => boolean, message = "condition", timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${message}`);
    await delay(2);
  }
}

async function fixture(t: TestContext, handler?: (ws: WebSocket, message: Message) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const sockets: WebSocket[] = [];
  const messages: Array<{ ws: WebSocket; message: Message }> = [];
  server.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Message;
      messages.push({ ws, message });
      handler?.(ws, message);
    });
  });
  const stop: Array<() => void> = [];
  t.after(async () => {
    for (const fn of stop) fn();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return { url: `ws://127.0.0.1:${address.port}/`, sockets, messages, stop };
}

function reply(ws: WebSocket, action: string, data: unknown) {
  ws.send(JSON.stringify({ action, data, error: null }));
}

function bridgeReply(ws: WebSocket, message: Message, data: unknown) {
  ws.send(JSON.stringify({ action: message.action, isResponse: true, data: { _reqId: message.data._reqId, ok: true, data } }));
}

function handshake(ws: WebSocket, message: Message) {
  if (message.action === "bridge_info") bridgeReply(ws, message, { protocolVersion: 2, bridgeVersion: "0.3.0", capabilities: ["ping", "inspect_entity"] });
}

async function native(t: TestContext, handler?: (ws: WebSocket, message: Message) => void, options: { callTimeoutMs?: number; reconnectDelayMs?: number } = {}) {
  const f = await fixture(t, handler);
  const client = new WarudoApiClient(f.url, async () => TOKEN, { callTimeoutMs: 500, reconnectDelayMs: 30, frameThrottleMs: 0, ...options });
  f.stop.push(() => client.stop());
  client.connect();
  await eventually(() => client.isConnected());
  return { ...f, client };
}

async function bridge(t: TestContext, handler?: (ws: WebSocket, message: Message) => void, options: { callTimeoutMs?: number; reconnectDelayMs?: number } = {}) {
  const f = await fixture(t, (ws, message) => { handshake(ws, message); handler?.(ws, message); });
  const client = new WarudoBridge(f.url, { callTimeoutMs: 500, reconnectDelayMs: 30, ...options });
  f.stop.push(() => client.stop());
  client.connect();
  await eventually(() => client.isConnected());
  return { ...f, client };
}

test("native serializes duplicate actions and preserves entity IDs", async (t) => {
  const f = await native(t);
  const first = f.client.call("getEntity", { id: UUID });
  const second = f.client.call("getEntity", { id: "other-entity" });
  await eventually(() => f.messages.some(({ message }) => message.action === "getEntity"));
  const calls = () => f.messages.filter(({ message }) => message.action === "getEntity");
  assert.equal(calls().length, 1);
  assert.equal(calls()[0].message.data.id, UUID);
  reply(f.sockets[0], "getEntity", { value: "first" });
  assert.deepEqual((await first).data, { value: "first" });
  await eventually(() => calls().length === 2);
  reply(f.sockets[0], "getEntity", { value: "second" });
  assert.deepEqual((await second).data, { value: "second" });
});

test("native notification IDs cannot resolve pending requests and stale frames clear on stop", async (t) => {
  const f = await native(t);
  let settled = false;
  const request = f.client.call("getPlugins").then((result) => { settled = true; return result; });
  await eventually(() => f.messages.some(({ message }) => message.action === "getPlugins"));
  reply(f.sockets[0], "frameUpdate", { id: 1, value: "frame" });
  reply(f.sockets[0], "otherAction", { id: 1, value: "wrong" });
  await eventually(() => f.client.getLastFrame() !== null);
  assert.equal(settled, false);
  reply(f.sockets[0], "getPlugins", { value: "right" });
  assert.deepEqual((await request).data, { value: "right" });
  f.client.stop();
  assert.equal(f.client.getLastFrame(), null);
});

test("native export errors use the base action while wrong base successes are ignored", async (t) => {
  const f = await native(t);
  const request = f.client.call("exportGraph", { graph: UUID });
  await eventually(() => f.messages.some(({ message }) => message.action === "exportGraph"));
  f.sockets[0].send(JSON.stringify({ action: "exportGraph", error: "Graph does not exist", data: null }));
  const response = await request;
  assert.equal(response.error, "Graph does not exist");
});
test("native export accepts only the requested export suffix", async (t) => {
  const f = await native(t);
  let settled = false;
  const request = f.client.call("exportGraph", { graph: UUID }).then((result) => { settled = true; return result; });
  await eventually(() => f.messages.some(({ message }) => message.action === "exportGraph"));
  reply(f.sockets[0], "exportGraph", "wrong base action");
  reply(f.sockets[0], "exportGraph:00000000-0000-0000-0000-000000000000", "wrong suffix");
  await delay(10);
  assert.equal(settled, false);
  reply(f.sockets[0], `exportGraph:${UUID}`, "correct");
  assert.equal((await request).data, "correct");
});

test("native timeout retires socket, rejects unsent queue, and never replays a mutation", async (t) => {
  const f = await native(t, undefined, { callTimeoutMs: 45, reconnectDelayMs: 15 });
  const first = assert.rejects(f.client.call("mutate"), { code: "TIMEOUT", execution: "UNKNOWN" });
  const second = assert.rejects(f.client.call("mutate"), { code: "TIMEOUT", execution: "NOT_EXECUTED" });
  await Promise.all([first, second]);
  await eventually(() => f.sockets.length === 2 && f.client.isConnected());
  assert.equal(f.messages.filter(({ message }) => message.action === "mutate").length, 1);
  assert.notEqual(f.sockets[0].readyState, WebSocket.OPEN);
  const next = f.client.call("mutate");
  await eventually(() => f.messages.filter(({ message }) => message.action === "mutate").length === 2);
  reply(f.sockets[1], "mutate", "fresh response");
  assert.equal((await next).data, "fresh response");
});

test("native queued requests receive a fresh timeout when actually sent", async (t) => {
  const f = await native(t, (ws, message) => {
    if (message.action === "read") setTimeout(() => reply(ws, "read", message.data.value), 45);
  }, { callTimeoutMs: 80 });
  const results = await Promise.all([f.client.call("read", { value: 1 }), f.client.call("read", { value: 2 })]);
  assert.deepEqual(results.map((result) => result.data), [1, 2]);
});

test("native manual dialogs are not answered and cannot report mutation success", async (t) => {
  const f = await native(t);
  const failure = assert.rejects(f.client.call("removeAsset"), { code: "CONFIRMATION_REQUIRED", execution: "UNKNOWN" });
  await eventually(() => f.messages.some(({ message }) => message.action === "removeAsset"));
  reply(f.sockets[0], "confirmation", { id: 1 });
  await failure;
  assert.equal(f.client.getConfirmationPolicy(), "manual");
  assert.equal(f.messages.filter(({ message }) => message.action === "confirmation").length, 0);
  assert.equal(f.client.getRecentAutoReplies().length, 1);
});

test("native stop rejects active and queued requests and cancels reconnect", async (t) => {
  const f = await native(t, undefined, { reconnectDelayMs: 10 });
  const active = assert.rejects(f.client.call("mutate"), { code: "STOPPED", execution: "UNKNOWN" });
  const queued = assert.rejects(f.client.call("mutate"), { code: "STOPPED", execution: "NOT_EXECUTED" });
  f.client.stop();
  await Promise.all([active, queued]);
  await delay(30);
  assert.equal(f.sockets.length, 1);
  await assert.rejects(f.client.call("mutate"), { execution: "NOT_EXECUTED" });
});

test("native stop during asynchronous token discovery cannot open a socket", async (t) => {
  const f = await fixture(t);
  let resolveToken!: (token: string) => void;
  const client = new WarudoApiClient(f.url, () => new Promise((resolve) => { resolveToken = resolve; }));
  f.stop.push(() => client.stop());
  client.connect();
  client.stop();
  resolveToken(TOKEN);
  await delay(20);
  assert.equal(f.sockets.length, 0);
  assert.equal(client.isConnected(), false);
});

test("bridge requires a versioned handshake before exposing calls", async (t) => {
  const f = await fixture(t);
  const client = new WarudoBridge(f.url, { callTimeoutMs: 200 });
  f.stop.push(() => client.stop());
  client.connect();
  await eventually(() => f.messages.length === 1);
  assert.equal(client.isConnected(), false);
  assert.equal(f.messages[0].message.action, "bridge_info");
  await assert.rejects(client.call("ping"), { execution: "NOT_EXECUTED" });
  handshake(f.sockets[0], f.messages[0].message);
  await eventually(() => client.isConnected());
  assert.deepEqual(client.getCapabilities(), ["ping", "inspect_entity"]);
  client.stop();
  assert.equal(client.getBridgeInfo(), null);
});

test("bridge correlation uses _reqId plus action, independently of entity id", async (t) => {
  const f = await bridge(t);
  let settled = false;
  const request = f.client.call("inspect_entity", { id: UUID, _reqId: -999 }).then((response) => { settled = true; return response; });
  await eventually(() => f.messages.some(({ message }) => message.action === "inspect_entity"));
  const call = f.messages.find(({ message }) => message.action === "inspect_entity")!.message;
  assert.equal(call.data.id, UUID);
  assert.notEqual(call.data._reqId, -999);
  f.sockets[0].send(JSON.stringify({ action: call.action, isResponse: false, data: { _reqId: call.data._reqId, ok: true, data: "notification" } }));
  f.sockets[0].send(JSON.stringify({ action: "wrong_action", isResponse: true, data: { _reqId: call.data._reqId, ok: true, data: "wrong" } }));
  f.sockets[0].send(JSON.stringify({ action: call.action, isResponse: true, data: { id: call.data._reqId, ok: true, data: "old protocol" } }));
  await delay(10);
  assert.equal(settled, false);
  bridgeReply(f.sockets[0], call, "correct");
  assert.equal((await request).data, "correct");
});

test("bridge handles out-of-order concurrent responses", async (t) => {
  const f = await bridge(t);
  const one = f.client.call("inspect_entity", { id: "one" });
  const two = f.client.call("inspect_entity", { id: "two" });
  await eventually(() => f.messages.filter(({ message }) => message.action === "inspect_entity").length === 2);
  const calls = f.messages.filter(({ message }) => message.action === "inspect_entity");
  bridgeReply(f.sockets[0], calls[1].message, "two");
  bridgeReply(f.sockets[0], calls[0].message, "one");
  assert.deepEqual((await Promise.all([one, two])).map((result) => result.data), ["one", "two"]);
});

test("bridge malformed response fails safely instead of implying success", async (t) => {
  const f = await bridge(t);
  const failure = assert.rejects(f.client.call("ping"), { code: "PROTOCOL_ERROR", execution: "UNKNOWN" });
  await eventually(() => f.messages.some(({ message }) => message.action === "ping"));
  const call = f.messages.find(({ message }) => message.action === "ping")!.message;
  f.sockets[0].send(JSON.stringify({ action: "ping", isResponse: true, data: { _reqId: call.data._reqId, data: "missing ok" } }));
  await failure;
  assert.equal(f.client.isConnected(), false);
});

test("bridge timeout retires socket and never replays pending writes", async (t) => {
  const f = await bridge(t, undefined, { callTimeoutMs: 45, reconnectDelayMs: 15 });
  const failure = assert.rejects(f.client.call("mutate"), { code: "TIMEOUT", execution: "UNKNOWN" });
  await failure;
  await eventually(() => f.sockets.length === 2 && f.client.isConnected());
  assert.equal(f.messages.filter(({ message }) => message.action === "mutate").length, 1);
});

test("bridge rejects mismatched protocol versions and stop cleans handshake timers", async (t) => {
  const f = await fixture(t, (ws, message) => {
    if (message.action === "bridge_info") bridgeReply(ws, message, { protocolVersion: 1, bridgeVersion: "0.1.0", capabilities: [] });
  });
  const client = new WarudoBridge(f.url, { callTimeoutMs: 100, reconnectDelayMs: 10 });
  f.stop.push(() => client.stop());
  client.connect();
  await eventually(() => f.sockets.length === 1 && f.sockets[0].readyState === WebSocket.CLOSED);
  client.stop();
  await delay(30);
  assert.equal(client.isConnected(), false);
  assert.equal(f.sockets.length, 1);
});


