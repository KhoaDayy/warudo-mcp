import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InputError, result } from "../results.js";
import { apiCall, nonEmpty, registerTool, type Dependencies } from "./shared.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i, "Expected a UUID.");
const coordinate = z.number().finite();
const graphModes = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create") }).strict(),
  z.object({ operation: z.literal("remove"), graph: uuid }).strict(),
  z.object({ operation: z.literal("rename"), graph: uuid, name: nonEmpty }).strict(),
  z.object({ operation: z.literal("set_enabled"), graph: uuid, enabled: z.boolean() }).strict(),
]);
const nodeModes = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), graph: uuid, type: nonEmpty, x: coordinate, y: coordinate }).strict(),
  z.object({ operation: z.literal("remove"), graph: uuid, node: uuid }).strict(),
]);

function validateMode<S extends z.ZodTypeAny>(schema: S, args: unknown): z.infer<S> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new InputError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; "));
  }
  return parsed.data;
}

export function registerGraphEditTools(server: McpServer, { api }: Dependencies): void {
  registerTool(server, "warudo_manage_graph", "Manage a generic Warudo graph. create takes no extra fields; remove requires graph; rename requires graph and name; set_enabled requires graph and enabled.", {
    operation: z.enum(["create", "remove", "rename", "set_enabled"]),
    graph: uuid.optional().describe("Graph UUID, required except when creating a graph."),
    name: nonEmpty.optional().describe("New name, used only for rename."),
    enabled: z.boolean().optional().describe("Enabled state, used only for set_enabled."),
  }, false, async (args) => {
    const input = validateMode(graphModes, args);
    switch (input.operation) {
      case "create":
        return result(await apiCall(api, "addGraph", {}));
      case "remove":
        return result(await apiCall(api, "removeGraph", { graph: input.graph }));
      case "rename":
        return result(await apiCall(api, "setGraphName", { graph: input.graph, name: input.name }));
      case "set_enabled":
        return result(await apiCall(api, "setGraphEnabled", { graph: input.graph, enabled: input.enabled }));
    }
  });

  registerTool(server, "warudo_manage_node", "Manage a generic Warudo node. create requires graph, runtime type ID, x and y; remove requires graph and node. Discover runtime type IDs before creating nodes.", {
    operation: z.enum(["create", "remove"]),
    graph: uuid,
    node: uuid.optional().describe("Node UUID, required only for remove."),
    type: nonEmpty.optional().describe("Node type ID from runtime metadata, required only for create."),
    x: coordinate.optional().describe("Horizontal graph position, required only for create."),
    y: coordinate.optional().describe("Vertical graph position, required only for create."),
  }, false, async (args) => {
    const input = validateMode(nodeModes, args);
    if (input.operation === "create") {
      return result(await apiCall(api, "addNodeOfType", { graph: input.graph, type: input.type, x: input.x, y: input.y }));
    }
    return result(await apiCall(api, "removeNode", { graph: input.graph, node: input.node }));
  });

  registerTool(server, "warudo_manage_connection", "Add or remove a data or flow connection using graph/node UUIDs and exact runtime port names.", {
    operation: z.enum(["add", "remove"]),
    kind: z.enum(["data", "flow"]),
    graph: uuid,
    outputNode: uuid,
    inputNode: uuid,
    outputPort: nonEmpty,
    inputPort: nonEmpty,
  }, false, async ({ operation, kind, graph, outputNode, inputNode, outputPort, inputPort }) => {
    const action = `${operation}${kind === "data" ? "Data" : "Flow"}Connection`;
    return result(await apiCall(api, action, { graph, outputNode, inputNode, outputPort, inputPort }));
  });

  registerTool(server, "warudo_invoke_flow", "Invoke a flow input on a Warudo graph node using its exact runtime input port name.", {
    graph: uuid,
    node: uuid,
    inputPort: nonEmpty,
  }, false, async ({ graph, node, inputPort }) => result(await apiCall(api, "invokeFlowAtInput", { graph, node, inputPort })));
}
