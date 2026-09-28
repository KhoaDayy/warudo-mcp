import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerGraphEditTools } from "../src/tools/graph-edit.js";
import type { Dependencies } from "../src/tools/shared.js";

const GRAPH = "12345678-1234-1234-1234-123456789abc";
const NODE = "abcdefab-cdef-abcd-efab-cdefabcdefab";

function decode(value: unknown): any {
  const response = value as CallToolResult;
  return JSON.parse((response.content[0] as { text: string }).text);
}

async function setup() {
  const calls: Array<{ action: string; data: unknown }> = [];
  const api = {
    call: async (action: string, data: Record<string, unknown>) => {
      calls.push({ action, data });
      return { action, data: { accepted: true } };
    },
    isConnected: () => true,
    getLastFrame: () => null,
    getConfirmationPolicy: () => "manual" as const,
    getRecentAutoReplies: () => [],
  } as Dependencies["api"];
  const bridge = { call: async () => ({ action: "noop", ok: true, data: null }), isConnected: () => true } as Dependencies["bridge"];
  const server = new McpServer({ name: "graph-edit-test", version: "1" });
  registerGraphEditTools(server, { api, bridge, config: { wsUrl: "ws://localhost:5678/", apiWsUrl: "ws://localhost:19053/" } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "graph-edit-test-client", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, calls, close: async () => { await client.close(); await server.close(); } };
}

test("graph management dispatches verified native actions", async () => {
  const s = await setup();
  try {
    await s.client.callTool({ name: "warudo_manage_graph", arguments: { operation: "create" } });
    await s.client.callTool({ name: "warudo_manage_graph", arguments: { operation: "remove", graph: GRAPH } });
    await s.client.callTool({ name: "warudo_manage_graph", arguments: { operation: "rename", graph: GRAPH, name: "Runtime" } });
    await s.client.callTool({ name: "warudo_manage_graph", arguments: { operation: "set_enabled", graph: GRAPH, enabled: false } });
    assert.deepEqual(s.calls, [
      { action: "addGraph", data: {} },
      { action: "removeGraph", data: { graph: GRAPH } },
      { action: "setGraphName", data: { graph: GRAPH, name: "Runtime" } },
      { action: "setGraphEnabled", data: { graph: GRAPH, enabled: false } },
    ]);
  } finally { await s.close(); }
});

test("node and connection tools dispatch exact contracts", async () => {
  const s = await setup();
  try {
    await s.client.callTool({ name: "warudo_manage_node", arguments: { operation: "create", graph: GRAPH, type: "Warudo.TestNode", x: 1.5, y: -2 } });
    await s.client.callTool({ name: "warudo_manage_node", arguments: { operation: "remove", graph: GRAPH, node: NODE } });
    await s.client.callTool({ name: "warudo_manage_connection", arguments: { operation: "add", kind: "data", graph: GRAPH, outputNode: NODE, inputNode: NODE, outputPort: "Value", inputPort: "Input" } });
    await s.client.callTool({ name: "warudo_manage_connection", arguments: { operation: "remove", kind: "data", graph: GRAPH, outputNode: NODE, inputNode: NODE, outputPort: "Value", inputPort: "Input" } });
    await s.client.callTool({ name: "warudo_manage_connection", arguments: { operation: "add", kind: "flow", graph: GRAPH, outputNode: NODE, inputNode: NODE, outputPort: "OnStart", inputPort: "Execute" } });
    await s.client.callTool({ name: "warudo_manage_connection", arguments: { operation: "remove", kind: "flow", graph: GRAPH, outputNode: NODE, inputNode: NODE, outputPort: "OnStart", inputPort: "Execute" } });
    await s.client.callTool({ name: "warudo_invoke_flow", arguments: { graph: GRAPH, node: NODE, inputPort: "Execute" } });
    assert.deepEqual(s.calls.map((call) => call.action), ["addNodeOfType", "removeNode", "addDataConnection", "removeDataConnection", "addFlowConnection", "removeFlowConnection", "invokeFlowAtInput"]);
    assert.deepEqual(s.calls[0].data, { graph: GRAPH, type: "Warudo.TestNode", x: 1.5, y: -2 });
    assert.deepEqual(s.calls[2].data, { graph: GRAPH, outputNode: NODE, inputNode: NODE, outputPort: "Value", inputPort: "Input" });
  } finally { await s.close(); }
});

test("graph edit schemas reject missing, invalid, nonfinite, and mode-inapplicable fields before native dispatch", async () => {
  const s = await setup();
  try {
    const invalid = [
      ["warudo_manage_graph", { operation: "remove" }],
      ["warudo_manage_graph", { operation: "create", graph: GRAPH }],
      ["warudo_manage_graph", { operation: "rename", graph: GRAPH }],
      ["warudo_manage_graph", { operation: "rename", graph: GRAPH, name: "Name", enabled: true }],
      ["warudo_manage_graph", { operation: "set_enabled", graph: GRAPH }],
      ["warudo_manage_node", { operation: "create", graph: GRAPH, type: "Node", x: 0 }],
      ["warudo_manage_node", { operation: "create", graph: GRAPH, type: "Node", x: Number.NaN, y: 0 }],
      ["warudo_manage_node", { operation: "remove", graph: GRAPH, node: NODE, x: 1 }],
      ["warudo_manage_connection", { operation: "add", kind: "data", graph: "bad", outputNode: NODE, inputNode: NODE, outputPort: "A", inputPort: "B" }],
      ["warudo_invoke_flow", { graph: GRAPH, node: NODE, inputPort: "" }],
      ["warudo_invoke_flow", { graph: GRAPH, node: NODE, inputPort: "Execute", unrelated: true }],
    ] as const;
    for (const [name, arguments_] of invalid) {
      const response = await s.client.callTool({ name, arguments: arguments_ });
      assert.equal(response.isError, true, name);
      const content = (response.content as Array<{text:string}>)[0].text;
      if (content.startsWith("{")) assert.equal(decode(response).error.execution, "NOT_EXECUTED");
      else assert.match(content, /Invalid arguments/);
    }
    assert.equal(s.calls.length, 0);
  } finally { await s.close(); }
});
