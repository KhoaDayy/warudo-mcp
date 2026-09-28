import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerDependencies } from "../src/server.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function decode(value: unknown): any {
  const tool = value as CallToolResult;
  return JSON.parse((tool.content[0] as { text: string }).text);
}

async function setup(overrides: Partial<ServerDependencies> = {}) {
  const calls: Array<{ backend: string; action: string; data: unknown }> = [];
  const api: ServerDependencies["api"] = {
    call: async (action, data) => { calls.push({ backend: "native", action, data }); return { action, data: { ok: true } }; },
    isConnected: () => true,
    getLastFrame: () => null,
    getConfirmationPolicy: () => "manual",
    getRecentAutoReplies: () => [],
  };
  const bridge: ServerDependencies["bridge"] = {
    call: async (action, data) => { calls.push({ backend: "bridge", action, data }); return { action, ok: true, data: [] }; },
    isConnected: () => true,
  };
  const server = createServer({ api, bridge, config: { apiWsUrl: "ws://localhost:19053/", wsUrl: "ws://localhost:5678/" }, discoverToken: async () => null, ...overrides });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, calls, api, bridge, close: async () => { await client.close(); await server.close(); } };
}

test("MCP handshake and tool catalog contain only generic tools with annotations", async () => {
  const session = await setup();
  try {
    const { tools } = await session.client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const removed of ["warudo_glow_outfit", "warudo_switch_outfit", "warudo_list_avatars", "warudo_create_blueprint", "warudo_set_confirmation_policy", "warudo_trigger"]) assert(!names.includes(removed), removed);
    for (const present of ["warudo_status", "warudo_list_assets", "warudo_import_graph", "warudo_api", "warudo_set_entity_port_value", "warudo_invoke_flow"]) assert(names.includes(present), present);
    assert.equal(new Set(names).size, names.length);
    assert(tools.every((tool) => typeof tool.annotations?.readOnlyHint === "boolean"));
    assert.equal(session.calls.length, 0, "creating and listing tools must not contact Warudo");
  } finally { await session.close(); }
});

test("invalid typed values return isError and do not send mutations", async () => {
  const session = await setup();
  try {
    for (const [name, args] of [
      ["warudo_set_entity_port_value", { id: "entity", port: "Scale", value: "float:NaN" }],
      ["warudo_set_material_property", { avatar: "avatar", path: "Body", property: "_Color", value: "color:-1,0,0" }],
      ["warudo_set_node_data_input", { blueprint: "graph", node: "node", input: "Value", value: "int:1.5" }],
    ] as const) {
      const response = await session.client.callTool({ name, arguments: args });
      assert.equal(response.isError, true);
      assert.equal(decode(response).error.execution, "NOT_EXECUTED");
    }
    assert.equal(session.calls.length, 0);
  } finally { await session.close(); }
});

test("native entity setter preserves entity ID and sends serialized JSON value", async () => {
  const session = await setup();
  try {
    await session.client.callTool({ name: "warudo_set_entity_port_value", arguments: { id: "entity-id", port: "Value", value: "string:hello", broadcast: true } });
    assert.deepEqual(session.calls, [{ backend: "native", action: "setEntityDataInputPortValue", data: { id: "entity-id", port: "Value", value: '"hello"', broadcast: true } }]);
  } finally { await session.close(); }
});

test("bridge and native failures use MCP isError including unknown mutation outcome", async () => {
  const session = await setup();
  try {
    session.bridge.call = async (action) => ({ action, ok: false, error: "Missing entity" });
    const rejected = await session.client.callTool({ name: "warudo_inspect_entity", arguments: { id: "missing" } });
    assert.equal(rejected.isError, true);
    assert.equal(decode(rejected).error.code, "BRIDGE_ERROR");
    session.api.call = async () => { throw Object.assign(new Error("response timed out"), { code: "TIMEOUT", execution: "UNKNOWN" }); };
    const timedOut = await session.client.callTool({ name: "warudo_set_entity_port_value", arguments: { id: "id", port: "Value", value: "int:5" } });
    assert.equal(timedOut.isError, true);
    assert.equal(decode(timedOut).error.execution, "UNKNOWN");
  } finally { await session.close(); }
});

test("inventory fallback explicitly reports incomplete scene data", async () => {
  const session = await setup();
  try {
    session.bridge.isConnected = () => false;
    const response = decode(await session.client.callTool({ name: "warudo_scene_inventory", arguments: {} }));
    assert.equal(response.partial, true);
    assert.equal(response.source, "native");
    assert.deepEqual(response.missing, ["assets", "graphs"]);
  } finally { await session.close(); }
});

test("runtime catalogs return IDs and bounded filtered pages", async () => {
  const session = await setup();
  try {
    session.api.call = async (action) => ({ action, data: { categories: [{ name: "Test", nodeTypes: [{ id: "b", title: "Beta" }, { id: "a", title: "Alpha" }] }] } });
    const response = decode(await session.client.callTool({ name: "warudo_get_node_types", arguments: { limit: 1 } }));
    assert.equal(response.total, 2);
    assert.equal(response.nextOffset, 1);
    assert.equal(response.items[0].id, "b");
    const filtered = decode(await session.client.callTool({ name: "warudo_get_node_types", arguments: { query: "Alpha" } }));
    assert.deepEqual(filtered.items, [{ id: "a", title: "Alpha", category: "Test" }]);
  } finally { await session.close(); }
});

test("blueprint dry-run accepts exported node dictionaries and validates connections", async () => {
  const session = await setup();
  try {
    const nodeId = "11111111-1111-4111-8111-111111111111";
    const blueprint = JSON.stringify({ name: "Graph", nodes: { [nodeId]: { typeId: "type" } }, dataConnections: [], flowConnections: [] });
    const response = decode(await session.client.callTool({ name: "warudo_import_graph", arguments: { json: blueprint, dryRun: true } }));
    assert.deepEqual(response, { dryRun: true, name: "Graph", nodeCount: 1, connectionCount: 0, checks: { shape: "passed", nodeIds: "passed", connectionEndpoints: "passed", runtimeTypes: "not_checked", runtimePorts: "not_checked" }, executable: "unverified", note: "Offline checks do not verify that node types or ports exist in the running Warudo instance." });
    for (const invalidJson of [
      { nodes: [], dataConnections: [], flowConnections: [] },
      { nodes: { bad: { typeId: "type" } }, dataConnections: [], flowConnections: [] },
      { nodes: { [nodeId]: { typeId: "" } }, dataConnections: [], flowConnections: [] },
      { nodes: { [nodeId]: { typeId: "type", id: "22222222-2222-4222-8222-222222222222" } }, dataConnections: [], flowConnections: [] },
      { nodes: { [nodeId]: { typeId: "type" } }, dataConnections: [{ outputNode: nodeId, inputNode: nodeId, outputPort: " ", inputPort: "y" }], flowConnections: [] },
      { nodes: { [nodeId]: { typeId: "type" } }, dataConnections: [{ outputNode: nodeId, inputNode: "22222222-2222-4222-8222-222222222222", outputPort: "x", inputPort: "y" }], flowConnections: [] },
    ]) {
      const invalid = await session.client.callTool({ name: "warudo_import_graph", arguments: { json: JSON.stringify(invalidJson), dryRun: true } });
      assert.equal(invalid.isError, true);
      assert.equal(decode(invalid).error.execution, "NOT_EXECUTED");
    }
    const tooLarge = await session.client.callTool({ name: "warudo_import_graph", arguments: { json: JSON.stringify({ name: "x".repeat(900 * 1024), nodes: {}, dataConnections: [], flowConnections: [] }), dryRun: true } });
    assert.equal(tooLarge.isError, true);
    assert.equal(decode(tooLarge).error.execution, "NOT_EXECUTED");
    assert.equal(session.calls.length, 0);
  } finally { await session.close(); }
});

test("strict schemas reject unknown request properties and plugin payload stays opaque", async () => {
  const session = await setup();
  try {
    const invalid = await session.client.callTool({ name: "warudo_get_selected_asset", arguments: { extra: true } });
    assert.equal(invalid.isError, true);
    assert.equal(session.calls.length, 0);
    await session.client.callTool({ name: "warudo_api", arguments: { action: "runtimeAction", data: { arbitraryPort: { nestedKey: true } } } });
    assert.deepEqual(session.calls.at(-1), { backend: "native", action: "runtimeAction", data: { arbitraryPort: { nestedKey: true } } });
    await session.client.callTool({ name: "warudo_send_plugin_message", arguments: { pluginId: "plugin", action: "raw", payload: "opaque non-JSON payload" } });
    assert.deepEqual(session.calls.at(-1), { backend: "native", action: "sendPluginMessage", data: { pluginId: "plugin", action: "raw", payload: "opaque non-JSON payload" } });
  } finally { await session.close(); }
});

test("tool schema rejects wrong types before any native operation", async () => {
  const session = await setup();
  try {
    const response = await session.client.callTool({ name: "warudo_set_entity_port_value", arguments: { id: "id", port: "Value", value: 4 } });
    assert.equal(response.isError, true);
    assert.equal(session.calls.length, 0);
  } finally { await session.close(); }
});
