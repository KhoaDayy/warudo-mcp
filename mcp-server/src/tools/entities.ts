import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { result } from "../results.js";
import { parseValue, serializeNativeValue } from "../values.js";
import { apiCall, bridgeCall, nonEmpty, registerTool, type Dependencies } from "./shared.js";

export function registerEntityTools(server: McpServer, { api, bridge }: Dependencies): void {
  registerTool(server, "warudo_api", "Compatibility access to one native Warudo action without a dedicated tool. Prefer typed tools where available. Required keys for graph/node/connection actions must come from verified Warudo API metadata. Native confirmations requiring approval are reported explicitly.", {
    action: nonEmpty.describe("Native action name, for example addNodeOfType or addDataConnection."),
    data: z.record(z.string(), z.unknown()).optional().describe("Native action payload. An entity 'id' is preserved; transport correlation is managed internally."),
  }, false, async ({ action, data }) => result(await apiCall(api, action, data)));

  registerTool(server, "warudo_inspect_entity", "Inspect an asset, node or graph before editing its ports. The bridge returns runtime metadata and values.", {
    id: nonEmpty.describe("Entity ID, or unique graph name."),
  }, true, async ({ id }) => result(await bridgeCall(bridge, "inspect_entity", { id, entityId: id })));
  registerTool(server, "warudo_get_entity_port_value", "Read a data input value from an entity.", {
    id: nonEmpty, port: nonEmpty,
  }, true, async ({ id, port }) => result(await apiCall(api, "getEntityDataInputPortValue", { id, port })));
  registerTool(server, "warudo_set_entity_port_value", "Set an entity data input. Typed values: float:2.5, int:3, bool:true, string:text, vector3:1,2,3, color:#rrggbbaa, json:{...}. Enums and asset references require json: serialized objects copied from runtime metadata. Numeric colors use a uniform 0..1 or 0..255 scale including alpha.", {
    id: nonEmpty, port: nonEmpty, value: z.string(), broadcast: z.boolean().default(false),
  }, false, async ({ id, port, value, broadcast }) => {
    let finalValue = serializeNativeValue(parseValue(value));
    if (value.startsWith("json:")) {
      try {
        const parsed = JSON.parse(finalValue);
        if (parsed && typeof parsed === "object" && "Position" in parsed && "Rotation" in parsed && "Scale" in parsed) {
          const safeTransform: any = { ...parsed };
          if (typeof parsed.Position === "object") safeTransform.Position = JSON.stringify(parsed.Position);
          if (typeof parsed.Rotation === "object") safeTransform.Rotation = JSON.stringify(parsed.Rotation);
          if (typeof parsed.Scale === "object") safeTransform.Scale = JSON.stringify(parsed.Scale);
          finalValue = JSON.stringify(safeTransform);
        }
      } catch (e) {}
    }
    return result(await apiCall(api, "setEntityDataInputPortValue", { id, port, value: finalValue, broadcast }));
  });
  registerTool(server, "warudo_invoke_entity_trigger", "Invoke a trigger port on an entity.", {
    id: nonEmpty, port: nonEmpty,
  }, false, async ({ id, port }) => result(await apiCall(api, "invokeEntityTriggerPort", { id, port })));

  registerTool(server, "warudo_send_plugin_message", "Send a generic message to a plugin. A native acknowledgement confirms dispatch only; it does not prove that plugin business logic succeeded.", {
    pluginId: nonEmpty, action: nonEmpty, payload: z.string().default("{}"),
  }, false, async ({ pluginId, action, payload }) => {
    const nativeResponse = await apiCall(api, "sendPluginMessage", { pluginId, action, payload });
    return result({ dispatched: true, execution: "UNKNOWN", nativeResponse });
  });
}
