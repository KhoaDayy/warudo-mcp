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

test("asset discovery delegates filtered pagination to a capable bridge", async () => {
  const session = await setup();
  try {
    const requestedPage = { total: 9, offset: 2, count: 1, nextOffset: 3,
      items: [{ id: "tree-3", name: "Oak", typeId: "tree", title: "Tree", category: "Environment", active: true }] };
    session.bridge.getCapabilities = () => ["list_assets_page"];
    session.bridge.call = async (action, data) => {
      session.calls.push({ backend: "bridge", action, data });
      return { action, ok: true, data: requestedPage };
    };
    const response = decode(await session.client.callTool({
      name: "warudo_list_assets",
      arguments: { query: "oak", category: "environment", typeId: "tree", offset: 2, limit: 1 },
    }));
    assert.deepEqual(response, { source: "bridge", ...requestedPage });
    assert.deepEqual(session.calls, [{ backend: "bridge", action: "list_assets_page",
      data: { query: "oak", category: "environment", typeId: "tree", offset: 2, limit: 1 } }]);
  } finally { await session.close(); }
});

test("asset discovery keeps the legacy path for bridges without server-side pagination", async () => {
  const session = await setup();
  try {
    session.bridge.getCapabilities = () => ["list_assets"];
    session.bridge.call = async (action, data) => {
      session.calls.push({ backend: "bridge", action, data });
      return { action, ok: true, data: [{ category: "Environment", assets: [
        { id: "a", name: "Oak", typeId: "tree" }, { id: "b", name: "Pine", typeId: "tree" },
      ] }] };
    };
    const response = decode(await session.client.callTool({
      name: "warudo_list_assets", arguments: { query: "oak", limit: 1 },
    }));
    assert.equal(response.total, 1);
    assert.equal(response.items[0].id, "a");
    assert.equal(session.calls[0].action, "list_assets");
  } finally { await session.close(); }
});

test("compact graph listing avoids fetching full blueprint nodes", async () => {
  const session = await setup();
  try {
    session.bridge.call = async (action, data) => {
      session.calls.push({ backend: "bridge", action, data });
      return { action, ok: true, data: [
        { id: "one", name: "Face Tracking", enabled: true, nodeCount: 200 },
        { id: "two", name: "Lighting", enabled: true, nodeCount: 8 },
      ] };
    };
    const response = decode(await session.client.callTool({
      name: "warudo_list_graphs", arguments: { query: "light", limit: 1 },
    }));
    assert.equal(response.total, 1);
    assert.deepEqual(response.items, [{ id: "two", name: "Lighting", enabled: true, nodeCount: 8 }]);
    assert.deepEqual(session.calls, [{ backend: "bridge", action: "list_graphs", data: {} }]);
  } finally { await session.close(); }
});

test("capture_viewport returns an inline image and rejects an outdated bridge", async () => {
  const session = await setup();
  try {
    session.bridge.getCapabilities = () => ["list_assets"];
    const outdated = await session.client.callTool({ name: "warudo_capture_viewport", arguments: {} });
    assert.equal(outdated.isError, true);
    assert.match(String((outdated.content as Array<{ text?: string }>)[0].text), /UNSUPPORTED/);
    assert.deepEqual(session.calls, []);

    session.bridge.getCapabilities = () => ["capture_viewport"];
    session.bridge.call = async (action, data) => {
      session.calls.push({ backend: "bridge", action, data });
      return { action, ok: true, data: { mimeType: "image/jpeg", width: 64, height: 64, byteLength: 3, camera: "Main", base64: "AQID" } };
    };
    const response = await session.client.callTool({ name: "warudo_capture_viewport", arguments: { width: 64, height: 64, quality: 50 } });
    const content = response.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    assert.equal(content[0].type, "image");
    assert.equal(content[0].data, "AQID");
    assert.equal(content[0].mimeType, "image/jpeg");
    assert.equal(JSON.parse(content[1].text!).camera, "Main");
    assert.deepEqual(session.calls, [{ backend: "bridge", action: "capture_viewport", data: { width: 64, height: 64, quality: 50 } }]);

    const tooBig = await session.client.callTool({ name: "warudo_capture_viewport", arguments: { width: 5000 } }).catch((e) => e);
    assert.ok(tooBig instanceof Error || (tooBig as { isError?: boolean }).isError);
  } finally { await session.close(); }
});

test("sync_scene forwards the optional graph and requires bridge support", async () => {
  const session = await setup();
  try {
    session.bridge.getCapabilities = () => ["sync_scene"];
    session.bridge.call = async (action, data) => {
      session.calls.push({ backend: "bridge", action, data });
      return { action, ok: true, data: { synced: true, graph: "Lighting" } };
    };
    const withGraph = decode(await session.client.callTool({ name: "warudo_sync_scene", arguments: { graph: "Lighting" } }));
    assert.deepEqual(withGraph, { synced: true, graph: "Lighting" });
    await session.client.callTool({ name: "warudo_sync_scene", arguments: {} });
    assert.deepEqual(session.calls.map((c) => c.data), [{ graph: "Lighting" }, {}]);

    session.bridge.getCapabilities = () => ["list_assets"];
    const outdated = await session.client.callTool({ name: "warudo_sync_scene", arguments: {} });
    assert.equal(outdated.isError, true);
  } finally { await session.close(); }
});

test("graph listing does not expose a category filter that can never match", async () => {
  const session = await setup();
  try {
    const tool = (await session.client.listTools()).tools.find((t) => t.name === "warudo_list_graphs");
    assert.ok(tool);
    const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    assert.deepEqual(props.sort(), ["limit", "offset", "query"]);
    const assets = (await session.client.listTools()).tools.find((t) => t.name === "warudo_list_assets");
    assert.ok(Object.keys((assets!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).includes("category"));
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

function boneApi() {
  let stored: string = "[]";
  const sets: unknown[] = [];
  const api: ServerDependencies["api"] = {
    call: async (action, data) => {
      const d = data as { id?: string; port?: string; value?: string };
      if (action === "getEntityDataInputPortValue") return { action, data: stored };
      if (action === "setEntityDataInputPortValue") { stored = String(d.value); sets.push(d); return { action, data: true }; }
      return { action, data: null };
    },
    isConnected: () => true, getLastFrame: () => null, getConfirmationPolicy: () => "manual", getRecentAutoReplies: () => [],
  };
  return { api, sets };
}

const CHARACTER = "29399e49-1c26-41bb-b40f-294dc0590f68";

test("bone catalog lists humanoid bones with stable ids and groups", async () => {
  const session = await setup();
  try {
    const all = decode(await session.client.callTool({ name: "warudo_list_bones", arguments: {} }));
    assert.equal(all.count, 55);
    assert.deepEqual(all.bones.filter((b: { id: number }) => b.id === 10 || b.id === 14).map((b: { name: string }) => b.name), ["Head", "RightUpperArm"]);
    const rightArm = decode(await session.client.callTool({ name: "warudo_list_bones", arguments: { group: "right arm" } }));
    assert.deepEqual(rightArm.bones.map((b: { name: string }) => b.name), ["RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand"]);
    assert.equal(session.calls.length, 0);
  } finally { await session.close(); }
});

test("bone offsets merge, toggle, replace and clear against the character port", async () => {
  const { api, sets } = boneApi();
  const session = await setup({ api });
  try {
    const call = async (name: string, args: Record<string, unknown>) => session.client.callTool({ name, arguments: args });

    const first = decode(await call("warudo_set_bone_offsets", { character: CHARACTER, offsets: [{ bone: "right upper arm", rotation: [0, 0, 60] }] }));
    assert.deepEqual(first.offsets, [{ bone: "RightUpperArm", boneId: 14, enabled: true, rotation: { x: 0, y: 0, z: 60 }, applyWhileTracked: true }]);
    const sent = JSON.parse((sets[0] as { value: string }).value);
    assert.equal(sent.length, 1);
    assert.equal(JSON.parse(sent[0].dataInputs.Bone.value).value, 14);
    assert.deepEqual(JSON.parse(sent[0].dataInputs.RotationOffset.value), { x: 0, y: 0, z: 60 });

    const second = decode(await call("warudo_set_bone_offsets", { character: CHARACTER, offsets: [{ bone: 13, rotation: [10, 0, -20] }] }));
    assert.deepEqual(second.offsets.map((o: { bone: string }) => o.bone).sort(), ["LeftUpperArm", "RightUpperArm"]);

    const toggled = decode(await call("warudo_set_bone_offsets", { character: CHARACTER, offsets: [{ bone: "RightUpperArm", enabled: false }] }));
    const arm = toggled.offsets.find((o: { bone: string }) => o.bone === "RightUpperArm");
    assert.equal(arm.enabled, false);
    assert.equal(arm.rotation.z, 60, "toggling keeps the stored rotation");

    const replaced = decode(await call("warudo_set_bone_offsets", { character: CHARACTER, mode: "replace", offsets: [{ bone: "Head", rotation: [5, 0, 0] }] }));
    assert.deepEqual(replaced.offsets.map((o: { bone: string }) => o.bone), ["Head"]);

    await call("warudo_set_bone_offsets", { character: CHARACTER, offsets: [{ bone: "Hips", rotation: [0, 15, 0] }] });
    const partial = decode(await call("warudo_clear_bone_offsets", { character: CHARACTER, bones: ["head"] }));
    assert.equal(partial.removed, 1);
    assert.deepEqual(partial.offsets.map((o: { bone: string }) => o.bone), ["Hips"]);
    const cleared = decode(await call("warudo_clear_bone_offsets", { character: CHARACTER }));
    assert.equal(cleared.count, 0);
    assert.equal(decode(await call("warudo_get_bone_offsets", { character: CHARACTER })).count, 0);
  } finally { await session.close(); }
});

test("bone offset input errors never reach Warudo", async () => {
  const { api, sets } = boneApi();
  const session = await setup({ api });
  try {
    const bad: Array<Record<string, unknown>> = [
      { character: CHARACTER, offsets: [{ bone: "Tail", rotation: [0, 0, 0] }] },
      { character: CHARACTER, offsets: [{ bone: 99, rotation: [0, 0, 0] }] },
      { character: CHARACTER, offsets: [{ bone: "Head", rotation: [0, 0, 0] }, { bone: "head", rotation: [1, 1, 1] }] },
      { character: CHARACTER, offsets: [{ bone: "Head" }] },
      { character: CHARACTER, offsets: [{ bone: "Head", rotation: [0, 0, 999] }] },
      { character: CHARACTER, offsets: [{ bone: "Head", rotation: [0, 0, 0], extra: true }] },
      { character: CHARACTER, offsets: [] },
    ];
    for (const args of bad) {
      const response = await session.client.callTool({ name: "warudo_set_bone_offsets", arguments: args });
      assert.equal(response.isError, true, JSON.stringify(args));
    }
    assert.equal(sets.length, 0);
  } finally { await session.close(); }
});

test("bone tools resolve a character by name and report ambiguity", async () => {
  const { api } = boneApi();
  const groups = [{ category: "CATEGORY_CHARACTERS", assets: [
    { id: CHARACTER, name: "Character 1", typeId: "726ab674-a550-474e-8b92-66526a5ad55e" },
    { id: "bc77a8de-5252-4bb9-bbfa-ec65adb66c66", name: "Camera 1", typeId: "6a05ecf3-1501-4cab-b9d7-84131b881a29" },
  ] }];
  const bridge: ServerDependencies["bridge"] = { call: async (action) => ({ action, ok: true, data: groups }), isConnected: () => true };
  const session = await setup({ api, bridge });
  try {
    assert.equal(decode(await session.client.callTool({ name: "warudo_get_bone_offsets", arguments: {} })).character, CHARACTER);
    assert.equal(decode(await session.client.callTool({ name: "warudo_get_bone_offsets", arguments: { character: "character 1" } })).character, CHARACTER);
    const missing = await session.client.callTool({ name: "warudo_get_bone_offsets", arguments: { character: "Nobody" } });
    assert.equal(missing.isError, true);
    groups[0].assets.push({ id: "99999999-9999-4999-8999-999999999999", name: "Character 2", typeId: "726ab674-a550-474e-8b92-66526a5ad55e" });
    const ambiguous = await session.client.callTool({ name: "warudo_get_bone_offsets", arguments: {} });
    assert.equal(ambiguous.isError, true);
  } finally { await session.close(); }
});

import { mkdtemp, readFile as readFileFs, writeFile as writeFileFs, readdir as readdirFs, rm as rmFs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

async function withPoseDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(joinPath(tmpdir(), "warudo-poses-"));
  const previous = process.env.WARUDO_MCP_POSES_DIR;
  process.env.WARUDO_MCP_POSES_DIR = dir;
  try { return await run(dir); }
  finally {
    if (previous === undefined) delete process.env.WARUDO_MCP_POSES_DIR; else process.env.WARUDO_MCP_POSES_DIR = previous;
    await rmFs(dir, { recursive: true, force: true });
  }
}

test("pose library saves, lists, applies, protects and deletes poses", async () => {
  await withPoseDir(async (dir) => {
    const { api, sets } = boneApi();
    const session = await setup({ api });
    try {
      const call = (name: string, args: Record<string, unknown>) => session.client.callTool({ name, arguments: args });

      const empty = await call("warudo_save_pose", { name: "wave", character: CHARACTER });
      assert.equal(empty.isError, true, "nothing to save yet");

      await call("warudo_set_bone_offsets", { character: CHARACTER, offsets: [{ bone: "RightUpperArm", rotation: [0, 0, 70] }, { bone: "Head", rotation: [0, 0, 12], enabled: false }] });
      const saved = decode(await call("warudo_save_pose", { name: "Wave", description: "Right hand wave", character: CHARACTER }));
      assert.equal(saved.saved, "wave");
      assert.equal(saved.bones, 2);

      const dup = await call("warudo_save_pose", { name: "wave", character: CHARACTER });
      assert.equal(dup.isError, true);
      assert.equal(decode(await call("warudo_save_pose", { name: "wave", character: CHARACTER, overwrite: true })).saved, "wave");

      const listed = decode(await call("warudo_list_poses", {}));
      assert.deepEqual(listed.poses.map((p: { name: string; bones: number }) => [p.name, p.bones]), [["wave", 2]]);

      await call("warudo_clear_bone_offsets", { character: CHARACTER });
      const applied = decode(await call("warudo_apply_pose", { name: "wave", character: CHARACTER }));
      assert.deepEqual(applied.offsets.map((o: { bone: string; enabled: boolean }) => [o.bone, o.enabled]), [["RightUpperArm", true], ["Head", false]]);
      assert.ok(sets.length > 0);

      assert.equal((await call("warudo_apply_pose", { name: "nope", character: CHARACTER })).isError, true);
      assert.equal(decode(await call("warudo_delete_pose", { name: "wave" })).deleted, "wave");
      assert.equal((await call("warudo_delete_pose", { name: "wave" })).isError, true);
      assert.deepEqual(await readdirFs(dir), []);
    } finally { await session.close(); }
  });
});

test("pose names cannot escape the library and corrupt files are reported", async () => {
  await withPoseDir(async (dir) => {
    const { api } = boneApi();
    const session = await setup({ api });
    try {
      const call = (name: string, args: Record<string, unknown>) => session.client.callTool({ name, arguments: args });
      for (const name of ["../evil", "a/b", "..", "con", "", " ", "x".repeat(65), ".hidden"]) {
        const response = await call("warudo_apply_pose", { name });
        assert.equal(response.isError, true, JSON.stringify(name));
        assert.equal((await call("warudo_delete_pose", { name })).isError, true, JSON.stringify(name));
      }
      await writeFileFs(joinPath(dir, "broken.json"), "{not json");
      await writeFileFs(joinPath(dir, "badshape.json"), JSON.stringify({ version: 1, name: "badshape", savedAt: "x", offsets: [{ bone: "Head" }] }));
      assert.equal((await call("warudo_apply_pose", { name: "broken" })).isError, true);
      const listed = decode(await call("warudo_list_poses", {}));
      assert.equal(listed.count, 0);
      assert.deepEqual(listed.skipped.sort(), ["badshape.json", "broken.json"]);
      assert.equal(await readFileFs(joinPath(dir, "broken.json"), "utf8"), "{not json");
    } finally { await session.close(); }
  });
});

test("pose_and_capture poses then returns the photo, and needs exactly one pose source", async () => {
  await withPoseDir(async () => {
    const { api, sets } = boneApi();
    const order: string[] = [];
    const bridge: ServerDependencies["bridge"] & { getCapabilities?: () => string[] } = {
      call: async (action) => {
        order.push(action);
        return { action, ok: true, data: action === "capture_viewport"
          ? { mimeType: "image/jpeg", width: 640, height: 360, byteLength: 3, camera: "Main", base64: "AQID" } : [] };
      },
      isConnected: () => true,
      getCapabilities: () => ["capture_viewport"],
    };
    const session = await setup({ api, bridge });
    try {
      const call = (args: Record<string, unknown>) => session.client.callTool({ name: "warudo_pose_and_capture", arguments: args });
      const shot = await call({ character: CHARACTER, offsets: [{ bone: "Head", rotation: [0, 0, 10] }], settleMs: 0, width: 640, height: 360 });
      const content = shot.content as Array<{ type: string; data?: string; text?: string }>;
      assert.equal(content[0].type, "image");
      assert.equal(content[0].data, "AQID");
      assert.equal(JSON.parse(content[2].text!).bones, 1);
      assert.equal(sets.length, 1, "posed before the capture");
      assert.deepEqual(order, ["capture_viewport"]);

      assert.equal((await call({ character: CHARACTER })).isError, true, "neither pose nor offsets");
      assert.equal((await call({ character: CHARACTER, pose: "wave", offsets: [{ bone: "Head", rotation: [0, 0, 0] }] })).isError, true, "both");
      assert.equal((await call({ character: CHARACTER, pose: "missing", settleMs: 0 })).isError, true, "unknown pose");
      assert.equal(sets.length, 1, "failed requests do not change the pose");
    } finally { await session.close(); }
  });
});
