import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { result } from "../results.js";
import { parseValue } from "../values.js";
import { bridgeCall, nonEmpty, registerTool, type Dependencies } from "./shared.js";

export function registerRuntimeTools(server: McpServer, { bridge }: Dependencies): void {
  registerTool(server, "warudo_list_hierarchy", "Inspect a character's GameObject hierarchy for generic runtime paths. The tool does not assume outfits or a specific model.", {
    avatar: nonEmpty, onlyMeshes: z.boolean().default(false), maxDepth: z.number().int().min(1).max(64).optional(),
  }, true, async ({ avatar, onlyMeshes, maxDepth }) => result(await bridgeCall(bridge, "list_hierarchy", { avatar, onlyMeshes, maxDepth })));
  registerTool(server, "warudo_set_gameobject_active", "Set a generic GameObject active state by avatar ID/name and hierarchy path.", {
    avatar: nonEmpty, path: z.string(), active: z.boolean(),
  }, false, async ({ avatar, path, active }) => result(await bridgeCall(bridge, "set_active", { avatar, path, active })));
  registerTool(server, "warudo_set_material_property", "Set a shader material property on a mesh at a hierarchy path.", {
    avatar: nonEmpty, path: z.string(), property: nonEmpty, value: z.string(), materialIndex: z.number().int().min(0).default(0),
  }, false, async ({ avatar, path, property, value, materialIndex }) => result(await bridgeCall(bridge, "set_material_property", { avatar, path, property, materialIndex, value: parseValue(value) })));
}
