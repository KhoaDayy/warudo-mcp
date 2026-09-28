# Migration to 0.3

The MCP source is now separated from personal model features. No file in the actual Warudo installation was changed by this refactor.

## Server and bridge

Update the Node server and compiled MCP Bridge plugin together. Protocol 2 uses a `bridge_info` handshake and an explicit response envelope:

```json
{"action":"inspect_entity","isResponse":true,"data":{"_reqId":1,"ok":true,"data":{}}}
```

`data.id` continues to mean an entity ID. It is not a request ID. An older runtime cannot complete the v2 handshake. Native API operations remain independent of the bridge.

The supported runtime is the auto-starting `[PluginType]` plugin built from `McpBridgePlugin.cs`, `McpBridgeService.cs`, `GameObjectPathResolver.cs` and `MaterialKeywordOverrideStore.cs`. Configure its loopback port in the MCP Bridge plugin settings. The plugin registers no scene asset and no Blueprint node.

Before installing it, remove the old bridge files `McpBridgeAsset.cs`, `McpBridgeService.cs`, `GameObjectPathResolver.cs`, `MaterialKeywordOverrideStore.cs` and `Nodes/OnMcpCommandNode.cs` from Warudo's Playground directory. Do not remove the whole Playground directory or unrelated personal scripts. Do not install the old sources and compiled plugin together.

## Tool changes

| Removed tool | Replacement |
|---|---|
| `warudo_list_avatars` | `warudo_list_assets`, filtered by character type ID or query |
| `warudo_create_blueprint` | `warudo_import_graph` with Warudo Export Blueprint JSON |
| `warudo_glow_outfit` | Personal model plugin/blueprint; no MCP replacement |
| `warudo_switch_outfit` | Explicit `warudo_set_gameobject_active` calls or a user-authored blueprint |
| `warudo_set_confirmation_policy` | Manual Warudo UI confirmation; outcome reported explicitly |
| `warudo_trigger` | `warudo_invoke_flow` with the target graph, node and exact flow input port |

The legacy command node `7e002040-a27f-4f26-b293-a423eb0295a0` and bridge asset `20d17238-0341-46d3-b6f5-fede75284315` are not registered by the plugin. Remove or replace existing scene/blueprint references to them before deleting the old Playground sources. The old free-form command string does not map automatically to a flow input.

## Personal model node recovery

The following sources were removed from the MCP repository, not from the installed Playground. Recover tracked originals from Git commit `4de7da2` if needed, then maintain them outside this repo. Preserve the exact NodeType UUID when moving existing scene dependencies.

| Source at baseline | NodeType UUID |
|---|---|
| `warudo-plugin/EkuHashFaceTrackingNode.cs` | `a2f5c8e9-2c4c-4d8b-9c1f-5f99aab2e201` |
| `warudo-plugin/EkuHashAnimatorParameterBridgeNode.cs` | `c74e4c6b-7edb-43c7-9a5d-7e0e7ec6d8b2` |
| `warudo-plugin/Nodes/VmcHandTrackingNode.cs` | `a1b2c3d4-0001-4a5b-9c6d-7e8f9a0b1c2d` |
| `warudo-plugin/Nodes/GlowOutfitNode.cs` | `3f8c1a2e-6d5b-4f7a-9c2e-8b1a4d6f9c3e` |

Before moving or uninstalling a personal node from Warudo, export/back up affected scenes and locate references by type ID. Do not duplicate the same NodeType UUID in two installed sources.

## Behavior changes

- Tool failures set `isError`, with explicit execution uncertainty.
- Type catalogs always include IDs and use bounded pages.
- Native setters send serialized JSON strings; native enum names alone are rejected. Use actual serialized metadata.
- A material operation requires the exact GameObject containing one Renderer, and a valid material slot/property.
- Runtime material values use property blocks; keyword clones are owned by the plugin and cleaned when a scene unloads or the plugin is disabled/reloaded. These changes are transient.
- The bridge starts with the plugin, persists across scene changes and restarts its listener when the configured port changes.
- Blueprint dry-run validates document structure but does not claim offline knowledge of runtime node types or ports.
- Raw `warudo_api` remains for compatibility where typed actions are not yet implemented. It has conservative write annotations and never retries a mutation.
