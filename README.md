# Warudo MCP Server

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-1.0.0+-green.svg)](https://modelcontextprotocol.io/)
[![Warudo](https://img.shields.io/badge/Warudo-VTubing-orange.svg)](https://warudo.app/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An open-source **Model Context Protocol (MCP)** server that connects AI assistants (Claude, Cursor, etc.) directly to **[Warudo](https://warudo.app/)**, the flexible 3D VTubing software.

Control your virtual avatar, inspect scene hierarchies, switch outfits with glowing match-cut transitions, modify material properties, and inspect or edit blueprints using natural language.

[**English**](README.md) | [**Tiếng Việt**](README.vi.md)

---

## 🌟 Highlights

- **Dual-Channel Architecture**:
  - **Native Control-Plane (Port 19053)**: Interacts directly with Warudo's built-in WebSocket API (60+ actions) with automated token discovery.
  - **Unity Scene Bridge (Port 5678)**: Fast runtime scene manipulation via a lightweight C# script running in Warudo Playground or as a plugin.
- **26 Specialized MCP Tools**: High-level tools for outfit switching, procedural glow, node inspection, material tweaking, and low-level escape hatches (`warudo_api`).
- **Dynamic Glow Transitions**: Procedural additive mesh glow effect that sweeps from bottom to top and match-cuts seamlessly between outfits without altering original avatar materials.
- **Zero Configuration Token Discovery**: Automatically extracts session tokens from `Player.log`, CLI processes, or environment variables.
- **Automatic Reconnection & Resilience**: Handles Warudo restarts gracefully with token refresh and reconnection loops.

---

## 🏛️ Architecture

```
Claude / Cursor / Any MCP Host (stdio)
                │
                ▼
      ┌─────────────────────────┐
      │    warudo-mcp-server    │
      │   (Node.js / TypeScript) │
      └────────────┬────────────┘
                   │
      ┌────────────┴──────────────────────────┐
      │                                       │
      ▼ (Channel 1)                           ▼ (Channel 2)
Warudo Control-Plane                    Unity Scene Bridge
ws://localhost:19053                    ws://localhost:5678
(Subprotocol Token Auth)                (Playground / Mod Plugin)
- Entity / Port inspection              - Outfit toggling & hierarchy
- Blueprint & Node CRUD                 - Procedural emission glow
- Flow invocation                       - Material property edits
- Engine event broadcasting             - OnMcpCommand triggers
```

---

## 📁 Repository Structure

```
warudo-mcp/
├── mcp-server/                 # MCP Server (TypeScript / Node.js)
│   ├── src/
│   │   ├── index.ts            # MCP server setup & 26 tool declarations
│   │   ├── warudoApi.ts        # Control-plane WebSocket client (Port 19053)
│   │   ├── token.ts            # Automated token discovery (Player.log / CLI / Env)
│   │   ├── warudoBridge.ts     # Unity bridge WebSocket client (Port 5678)
│   │   └── config.ts           # Environment variable configuration
│   ├── package.json
│   └── tsconfig.json
├── warudo-plugin/              # Unity / Warudo C# scripts
│   ├── McpBridgeAsset.cs       # Scene asset providing WebSocket server (Port 5678)
│   ├── McpBridgeService.cs     # Action dispatcher (outfits, glow, materials)
│   ├── McpBridgePlugin.cs      # Plugin mod class for compiled distribution
│   └── Nodes/
│       ├── GlowOutfitNode.cs   # Procedural additive overlay glow transition
│       ├── OnMcpCommandNode.cs # Blueprint event trigger node
│       └── VmcHandTrackingNode.cs # VMC tracking separator node
├── README.md                   # English documentation
├── README.vi.md                # Vietnamese documentation
└── LICENSE                     # MIT License
```

---

## 🚀 Quick Start

### Step 1: Install the Bridge in Warudo

The fastest method is using Warudo's **Playground** (no Unity build required):

1. Locate your Warudo Playground folder (typically on Steam):
   ```
   <Warudo>\Warudo_Data\StreamingAssets\Playground\
   ```
   *(e.g., `C:\Program Files (x86)\Steam\steamapps\common\Warudo\Warudo_Data\StreamingAssets\Playground\`)*

2. Copy the following files from `warudo-plugin/` into that `Playground/` directory:
   - `McpBridgeAsset.cs`
   - `McpBridgeService.cs`
   - `Nodes/OnMcpCommandNode.cs`
   - `Nodes/GlowOutfitNode.cs`

3. Launch **Warudo** → Open your Scene → Click **Add Asset** → Search for **"MCP Bridge"** and add it.
4. Confirm in the Warudo log or console that the server started:
   ```
   [McpBridge] WebSocket server started at port 5678
   ```

*(Optional: For building as a compiled `.warudo` mod using the official Warudo Mod Tool, see [Plugin Mod Details](#building-as-a-plugin-mod).)*

---

### Step 2: Build the MCP Server

Ensure you have **Node.js 18+** installed.

```bash
# Clone the repository
git clone https://github.com/KhoaDayy/warudo-mcp.git
cd warudo-mcp/mcp-server

# Install dependencies and build TypeScript
npm install
npm run build
```

---

### Step 3: Register with Your MCP Client

#### Option A: Claude Code CLI

Add globally to your user scope:

```powershell
claude mcp add warudo -s user -- node <PATH_TO_REPO>\warudo-mcp\mcp-server\dist\index.js
```

Or for development (using `tsx` directly):

```powershell
claude mcp add warudo -s user -- npx tsx <PATH_TO_REPO>\warudo-mcp\mcp-server\src\index.ts
```

#### Option B: Claude Desktop

Add the server to your `claude_desktop_config.json`:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "warudo": {
      "command": "node",
      "args": [
        "C:\\Users\\<YourUsername>\\path\\to\\warudo-mcp\\mcp-server\\dist\\index.js"
      ]
    }
  }
}
```

#### Option C: Cursor IDE

Add under **Cursor Settings** → **Features** → **MCP Servers**:
- **Name**: `warudo`
- **Type**: `command`
- **Command**: `node <PATH_TO_REPO>/mcp-server/dist/index.js`

Restart your MCP client after configuration.

---

## 🛠️ Available MCP Tools (26 Tools)

### 1. Control-Plane Tools (Native Engine API: Port 19053)

| Tool | Description |
|---|---|
| `warudo_status` | Returns connectivity status for both channels, API token status, connected plugins, and confirmation policies. |
| `warudo_set_confirmation_policy` | Configures how Warudo confirmation prompts are handled (`decline` default / `accept`). |
| `warudo_api` | Raw caller for any of the 60+ actions in Warudo's native control plane. |
| `warudo_get_plugins` | Lists all plugins loaded in Warudo (ID, name, version). |
| `warudo_get_selected_graph` | Retrieves the active/selected blueprint graph in the editor. |
| `warudo_get_selected_asset` | Retrieves the currently selected asset in the editor. |
| `warudo_get_asset_types` | Lists all creatable asset types categorized by type. |
| `warudo_get_node_types` | Lists all blueprint node types categorized with IDs. |
| `warudo_get_entity_port_value` | Reads the current value of an entity data input port (`{ id, port }`). |
| `warudo_set_entity_port_value` | Sets a typed value on an entity data input port. |
| `warudo_invoke_entity_trigger` | Triggers an execution port on an entity or node. |
| `warudo_import_graph` | Imports a blueprint graph from exported JSON (`dryRun` supported). |
| `warudo_send_plugin_message` | Dispatches custom plugin messages to C# plugins. |
| `warudo_frame_state` | Retrieves the latest broadcasted entity state frame. |

### 2. Scene Bridge Tools (Direct Unity Manipulation: Port 5678)

| Tool | Description |
|---|---|
| `warudo_scene_inventory` | Full scene summary: all assets grouped by category and graphs with node counts. |
| `warudo_inspect_entity` | Inspects all data input ports of an entity (names, types, enum options, current values). |
| `warudo_list_avatars` | Lists all character/avatar assets present in the active scene. |
| `warudo_list_hierarchy` | Traverses GameObject hierarchy paths of an avatar (useful for finding outfit paths). |
| `warudo_switch_outfit` | Toggles child meshes/outfits on or off by path. |
| `warudo_glow_outfit` | Triggers a sweeping additive glow pulse on an outfit or avatar mesh. |
| `warudo_set_gameobject_active` | Enables or disables any GameObject by path. |
| `warudo_set_material_property` | Edits shader properties (color, emission, float, texture keyword) live. |
| `warudo_trigger` | Fires the `On MCP Command` trigger node inside blueprints. |
| `warudo_list_blueprints` | Lists all blueprints and their nodes with ports and current values. |
| `warudo_set_node_data_input` | Updates a data input port on a blueprint node. |
| `warudo_create_blueprint` | Creates a new blueprint from JSON format (`dryRun` supported). |

---

## 💡 Usage Examples

### Example 1: Outfit Switching with Smooth Glow

Ask Claude:
> *"Switch my avatar 'Hiyori' into the dress outfit with a soft pink glow transition."*

Under the hood, Claude orchestrates:
1. `warudo_list_hierarchy(avatar="Hiyori")` → Discovers paths: `"Clothes/Body"`, `"Clothes/Casual"`, `"Clothes/Dress"`.
2. `warudo_glow_outfit(avatar="Hiyori", path="Clothes/Casual", color="#ff66cc", durationMs=500)` → Sweeps glow overlay.
3. `warudo_switch_outfit(avatar="Hiyori", on=["Clothes/Body", "Clothes/Dress"], off=["*"])` → Swaps meshes at peak intensity.

> [!TIP]
> Always include body meshes in the `on` list when using `off=["*"]`, otherwise the base character body might be hidden.

---

### Example 2: Adjusting Material Emission

> *"Increase the emission on the necklace material to make it glow cyan."*

Claude invokes:
```json
{
  "avatar": "Hiyori",
  "path": "Accessories/Necklace",
  "property": "_EmissionColor",
  "value": { "type": "color", "value": [0.0, 1.0, 1.0, 1.0] }
}
```

---

### Example 3: Modifying Blueprint Node Values

> *"Set the smooth time on my face tracking node to 0.15."*

Claude queries `warudo_list_blueprints`, identifies the target node ID, and executes:
```json
{
  "nodeId": "a2f5c8e9-2c4c-4d8b-9c1f-5f99aab2e201",
  "portName": "OSCmSmoothingTime",
  "value": "float:0.15"
}
```

---

## ⚙️ Configuration & Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WARUDO_WS_HOST` | `localhost` | Host for the scene bridge server (Port 5678). |
| `WARUDO_WS_PORT` | `5678` | Port for the scene bridge WebSocket server. |
| `WARUDO_WS_URL` | `ws://localhost:5678/` | Explicit override for the scene bridge URL. |
| `WARUDO_API_WS_HOST` | `::1` *(IPv6)* | Host for Warudo control-plane API. |
| `WARUDO_API_WS_PORT` | `19053` | Port for Warudo control-plane API. |
| `WARUDO_API_WS_URL` | `ws://[::1]:19053/` | Explicit override for control-plane URL. |
| `WARUDO_API_TOKEN` | *(auto-discovered)* | Override for the 32-character hex auth token. |

---

## 🧯 Troubleshooting

### `ECONNREFUSED` when Warudo is running
Warudo binds its control-plane and internal servers to **IPv6 `::1`**. Connecting to `127.0.0.1` will be refused. Ensure `localhost` resolves to `::1` or leave `WARUDO_API_WS_HOST` at its default.

### `warudo_status` shows API disconnected
- Check if Warudo is running.
- The server searches for `One Time API Auth Token` in `%USERPROFILE%\AppData\LocalLow\HakuyaLabs\Warudo\Player.log`. If "Launch Client On Start" is disabled in Warudo, token generation might be delayed.
- You can manually inspect the token with PowerShell:
  ```powershell
  Select-String "One Time API Auth Token" "$env:USERPROFILE\AppData\LocalLow\HakuyaLabs\Warudo\Player.log"
  ```
  Set `WARUDO_API_TOKEN` if you wish to override manual testing.

### Glow effect does not illuminate
- The procedural glow uses the `Particles/Additive` shader built into Unity's Built-in Render Pipeline (BiRP). It renders over existing meshes regardless of original shaders.
- Ensure the GameObject path passed to `warudo_glow_outfit` contains active `Renderer` or `SkinnedMeshRenderer` components.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
