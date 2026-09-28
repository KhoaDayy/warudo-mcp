import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InputError, result } from "../results.js";
import { parseValue } from "../values.js";
import { apiCall, bridgeCall, nonEmpty, registerTool, type Dependencies } from "./shared.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_BLUEPRINT_BYTES = 900 * 1024;
const MAX_BLUEPRINT_NODES = 10_000;
const MAX_BLUEPRINT_CONNECTIONS = 50_000;

export function registerGraphTools(server: McpServer, { api, bridge }: Dependencies): void {
  registerTool(server, "warudo_get_selected_graph", "Read the graph currently selected in the Warudo editor.", {}, true, async () => result(await apiCall(api, "getSelectedGraph")));
  registerTool(server, "warudo_list_blueprints", "List scene graphs with their IDs and node metadata from the runtime bridge.", {}, true, async () => result(await bridgeCall(bridge, "list_blueprints")));
  registerTool(server, "warudo_set_node_data_input", "Set a blueprint node data input after resolving the graph and node by ID or unique title.", {
    blueprint: nonEmpty, node: nonEmpty, input: nonEmpty, value: z.string(),
  }, false, async ({ blueprint, node, input, value }) => result(await bridgeCall(bridge, "set_node_data_input", { blueprint, node, input, value: parseValue(value) })));
  registerTool(server, "warudo_import_graph", "Validate or import a Warudo Export Blueprint JSON document. dryRun checks shape, node IDs and connection endpoints without mutation; runtime type/port compatibility still requires Warudo metadata.", {
    json: z.string(), dryRun: z.boolean().default(false),
  }, false, async ({ json, dryRun }) => {
    if (Buffer.byteLength(json, "utf8") > MAX_BLUEPRINT_BYTES) throw new InputError("Blueprint JSON exceeds the 900 KiB size limit.");
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch (error) { throw new InputError(`JSON không hợp lệ: ${(error as Error).message}`); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new InputError("Blueprint JSON phải là một object.");
    const blueprint = parsed as Record<string, unknown>;
    const nodes = blueprint.nodes;
    if (nodes === undefined || nodes === null || typeof nodes !== "object") throw new InputError("Blueprint 'nodes' phải là dictionary node theo ID.");
    if (Array.isArray(nodes)) throw new InputError("Blueprint 'nodes' phải là dictionary {nodeId: serializedNode}; export array không phải định dạng Warudo.");
    const nodeEntries = Object.entries(nodes as Record<string, unknown>);
    if (nodeEntries.length > MAX_BLUEPRINT_NODES) throw new InputError(`Blueprint exceeds the ${MAX_BLUEPRINT_NODES} node limit.`);
    const nodeIds = new Set<string>();
    for (const [id, value] of nodeEntries) {
      if (!UUID.test(id)) throw new InputError(`Blueprint node key must be a UUID: ${id}`);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InputError(`Blueprint node '${id}' must be an object.`);
      const node = value as Record<string, unknown>;
      if (nodeIds.has(id.toLowerCase())) throw new InputError(`Blueprint has duplicate node UUID: ${id}`);
      nodeIds.add(id.toLowerCase());
      if (node.id !== undefined && (typeof node.id !== "string" || node.id.toLowerCase() !== id.toLowerCase())) throw new InputError(`Blueprint node.id must match its dictionary key: ${id}`);
      if (typeof node.typeId !== "string" || node.typeId.trim() === "") throw new InputError(`Blueprint node '${id}' requires a nonempty typeId.`);
    }
    let connectionCount = 0;
    for (const field of ["dataConnections", "flowConnections"] as const) {
      const value = blueprint[field];
      if (!Array.isArray(value)) throw new InputError(`Blueprint '${field}' phải là array.`);
      connectionCount += value.length;
      if (connectionCount > MAX_BLUEPRINT_CONNECTIONS) throw new InputError(`Blueprint exceeds the ${MAX_BLUEPRINT_CONNECTIONS} connection limit.`);
      for (const connection of value) {
        if (connection === null || typeof connection !== "object" || Array.isArray(connection)) throw new InputError(`Blueprint '${field}' chứa connection không hợp lệ.`);
        const item = connection as Record<string, unknown>;
        for (const key of ["outputNode", "inputNode", "outputPort", "inputPort"] as const) {
          if (typeof item[key] !== "string" || item[key].trim() === "") throw new InputError(`Blueprint '${field}' thiếu ${key}.`);
        }
        for (const key of ["outputNode", "inputNode"] as const) {
          if (!nodeIds.has((item[key] as string).toLowerCase())) throw new InputError(`Blueprint '${field}' references a missing ${key}: ${item[key]}`);
        }
      }
    }
    const nodeCount = nodeEntries.length;
    if (dryRun) return result({
      dryRun: true, name: blueprint.name ?? null, nodeCount, connectionCount,
      checks: { shape: "passed", nodeIds: "passed", connectionEndpoints: "passed", runtimeTypes: "not_checked", runtimePorts: "not_checked" },
      executable: "unverified",
      note: "Offline checks do not verify that node types or ports exist in the running Warudo instance.",
    });
    return result(await apiCall(api, "importGraph", { json }));
  });

  // Retain the generic action as the escape hatch until every native graph CRUD action has a typed contract.
  registerTool(server, "warudo_export_graph", "Export one graph by UUID as a Warudo blueprint JSON document.", {
    graph: nonEmpty,
  }, true, async ({ graph }) => result(await apiCall(api, "exportGraph", { graph })));
}
