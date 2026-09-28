import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { result, RuntimeError } from "../results.js";
import { apiCall, asRecord, bridgeCall, page, pageSchema, registerTool, type Dependencies } from "./shared.js";

export function registerSceneTools(server: McpServer, { api, bridge }: Dependencies): void {
  registerTool(server, "warudo_scene_inventory", "Inspect every asset and graph in the open scene through the runtime bridge. Native fallback contains only selection and plugins and is explicitly partial.", {}, true, async () => {
    if (bridge.isConnected()) {
      const [assets, graphs] = await Promise.all([bridgeCall(bridge, "list_assets"), bridgeCall(bridge, "list_graphs")]);
      return result({ source: "bridge", partial: false, assets, graphs });
    }
    if (!api.isConnected()) throw new RuntimeError("Neither the Warudo native API nor the runtime bridge is connected.", "NOT_CONNECTED", "NOT_EXECUTED");
    const selection = await Promise.allSettled([
      apiCall(api, "getSelectedGraph"), apiCall(api, "getSelectedAsset"), apiCall(api, "getPlugins"),
    ]);
    if (selection.every((item) => item.status === "rejected")) throw (selection[0] as PromiseRejectedResult).reason;
    const value = (index: number) => {
      const item = selection[index];
      return item.status === "fulfilled" ? item.value : { unavailable: true, message: String(item.reason?.message ?? item.reason) };
    };
    return result({
      source: "native", partial: true, missing: ["assets", "graphs"],
      selectedGraph: value(0), selectedAsset: value(1), plugins: value(2),
      hint: "Install and enable the MCP Bridge plugin for full inventory; no scene asset is required.",
    });
  });

  registerTool(server, "warudo_list_assets", "List scene assets with stable IDs. Filter by typeId, category or query; use offset/limit for pagination.", {
    ...pageSchema, typeId: z.string().optional(),
  }, true, async (filter) => {
    const groups = await bridgeCall(bridge, "list_assets");
    const assets = (Array.isArray(groups) ? groups : []).flatMap((group) => {
      const record = asRecord(group);
      return (Array.isArray(record.assets) ? record.assets : []).map((asset): Record<string, unknown> => ({ ...asRecord(asset), category: record.category }));
    }).filter((asset) => !filter.typeId || asset.typeId === filter.typeId);
    return result({ source: "bridge", ...page(assets, filter) });
  });

  registerTool(server, "warudo_get_selected_asset", "Read the currently selected asset in the Warudo editor.", {}, true, async () => result(await apiCall(api, "getSelectedAsset")));
  registerTool(server, "warudo_get_plugins", "List loaded plugins, their IDs, versions and port counts.", {}, true, async () => {
    const plugins = asRecord(asRecord(await apiCall(api, "getPlugins")).plugins);
    return result({ plugins: Object.entries(plugins).map(([id, value]) => {
      const plugin = asRecord(value);
      const type = asRecord(plugin.type);
      return { id, name: type.name ?? id, version: type.version ?? plugin.version ?? null, dataInputs: Object.keys(asRecord(plugin.dataInputs)).length, triggers: Object.keys(asRecord(plugin.triggers)).length };
    }) });
  });

  for (const kind of ["asset", "node"] as const) {
    const key = kind === "asset" ? "assetTypes" : "nodeTypes";
    registerTool(server, `warudo_get_${kind}_types`, `Discover ${kind} types from live Warudo metadata. IDs are always included. Full metadata is optional; query/category/offset/limit bound the response.`, {
      ...pageSchema, full: z.boolean().default(false),
    }, true, async (filter) => {
      const data = asRecord(await apiCall(api, kind === "asset" ? "getAssetTypeList" : "getNodeTypeList"));
      const items = (Array.isArray(data.categories) ? data.categories : []).flatMap((category) => {
        const group = asRecord(category);
        return (Array.isArray(group[key]) ? group[key] : []).map((item: unknown) => {
          const type = asRecord(item);
          return filter.full ? { ...type, category: group.name } : { id: type.id, title: type.title, category: group.name };
        });
      });
      return result(page(items, filter));
    });
  }
}
