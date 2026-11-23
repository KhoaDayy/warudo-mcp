# Warudo MCP

[![CI](https://github.com/KhoaDayy/warudo-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/KhoaDayy/warudo-mcp/actions/workflows/ci.yml)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Protocol Version](https://img.shields.io/badge/Bridge%20Protocol-v2-blue.svg)](docs/MIGRATION.md)
[![NPM Version](https://img.shields.io/npm/v/warudo-mcp-server.svg?logo=npm)](https://www.npmjs.com/package/warudo-mcp-server)
[![Steam Workshop](https://img.shields.io/badge/Steam%20Workshop-MCP%20Bridge-1b2838.svg?logo=steam)](https://steamcommunity.com/sharedfiles/filedetails/?id=3809919307)

[English](README.md) · [Tiếng Việt](README.vi.md)

A Model Context Protocol (MCP) server providing standard, model-agnostic control over [Warudo](https://warudo.app/) 3D virtual production and VTubing scenes via stdio.

<p align="center">
  <img src="docs/mcp_bridge_workshop.jpg" alt="Warudo MCP Bridge Banner" width="480">
</p>

---

## Overview

Controlling 3D virtual production software from Large Language Models usually requires proprietary scripts or brittle, model-specific bindings. 

**Warudo MCP** exposes Warudo's native capabilities directly to AI assistants (Claude Desktop, Cursor, Cline, Roo Code, Windsurf) through 26 strongly-typed MCP tools. The bridge operates purely on generic primitives—controlling cameras, lighting, avatar transforms, material properties, and blueprint node networks—without coupling to specific avatars or proprietary tracking setups.

### Transport Architecture

```text
MCP Host (Claude / Cursor / Cline)
       │ (JSON-RPC 2.0 over stdio)
       ▼
TypeScript MCP Server (warudo-mcp-server)
       ├── Native WebSocket API (ws://[::1]:19053) ──► Data ports, Blueprint graphs, Flow execution
       └── Bridge Plugin (ws://localhost:5678)     ──► Scene inventory, Hierarchy query, Material overrides
```

* **Native Control Plane (`:19053`)**: Interacts directly with Warudo Core for entity data ports, triggers, and full blueprint graph manipulation.
* **Bridge Plugin (`:5678`)**: A compiled, auto-starting Unity mod (`[PluginType]`) that provides deep scene inventory traversal and transient Material PropertyBlock overrides without using prohibited `System.Reflection` APIs.

---

## Features

* **Complete Scene Discovery**: Inspect all active assets, character entities, directional lights, and plugins with paginated type catalogs (`warudo_scene_inventory`, `warudo_list_assets`).
* **Autonomous Camera & Staging**: Adjust orbit offsets, rotation, field of view, and trigger screenshots dynamically.
* **Transform Protection**: Built-in serialization guard automatically double-stringifies nested `TransformData` properties (`Position`, `Rotation`, `Scale`) to prevent native deserializer corruption and late-update crash loops.
* **Blueprint Node Graph Editing**: Create, delete, rename, and enable blueprints; add and wire node pins; and invoke flow execution paths programmatically (`warudo_manage_graph`, `warudo_manage_node`, `warudo_manage_connection`, `warudo_invoke_flow`).
* **Transient Material Overrides**: Modify shader properties and material keywords at runtime using non-destructive MaterialPropertyBlocks that reset cleanly when scenes unload.
* **Explicit Execution Semantics**: Mutations that fail validation return `NOT_EXECUTED`. Unacknowledged network timeouts return `UNKNOWN` and retire the underlying socket before retrying.

---

## Requirements

* **Operating System**: Windows 10/11 (required by Warudo)
* **Node.js**: `v22.0.0` or higher
* **Warudo**: Version `0.15.0` or higher installed

---

## Quick Start (Zero Git Clone Required)

### 1. Install Warudo Plugin
Subscribe to the official mod on Steam Workshop (no Unity compilation required):
👉 [**MCP Bridge on Steam Workshop**](https://steamcommunity.com/sharedfiles/filedetails/?id=3809919307)

*Alternatively, download `Warudo-MCP.warudo` from the [latest GitHub Release](https://github.com/KhoaDayy/warudo-mcp/releases/latest) (or `warudo-plugin/Warudo-MCP.warudo` in this repo) and place it into `%APPDATA%\..\LocalLow\HakuyaLabs\Warudo\Plugins\`. Restart Warudo afterwards. To build it yourself, see [Building the Plugin](#building-the-plugin).*

### 2. Configure Your AI Client

#### Option A: One-Line PowerShell Installer
Open PowerShell and run:
```powershell
irm https://raw.githubusercontent.com/KhoaDayy/warudo-mcp/main/install.ps1 | iex
```
*Verifies Node.js, purges legacy Playground scripts, and configures Claude Desktop, Cursor, Cline, Roo Code, and Windsurf automatically. Existing configs are backed up to `~/.warudo-mcp/backups`; a config that is not valid JSON is skipped rather than overwritten.*

> Piping a script into `iex` runs whatever is on the branch at that moment. If you prefer, download `install.ps1`, review it, then run it locally.

#### Option B: AI Agent Self-Setup Prompt
Copy and paste this prompt directly into your AI chat (Cursor, Claude, or Cline):
<!-- x-release-please-start-version -->
```text
Please connect to my Warudo instance via MCP:
1. Register the "warudo" MCP server in your config using command "npx" with args ["-y", "warudo-mcp-server@0.3.0"].
2. Remind me to subscribe to the "MCP Bridge" plugin on Steam Workshop (https://steamcommunity.com/sharedfiles/filedetails/?id=3809919307) if I haven't already.
3. Once Warudo is running with a scene open, call warudo_status to verify our live connection.
```
<!-- x-release-please-end -->

#### Option C: Manual Client Configuration
Add the server entry to your MCP client configuration file:

**Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json`) or **Cursor** (`~/.cursor/mcp.json`):
<!-- x-release-please-start-version -->
```json
{
  "mcpServers": {
    "warudo": {
      "command": "npx",
      "args": ["-y", "warudo-mcp-server@0.3.0"]
    }
  }
}
```
<!-- x-release-please-end -->

---

## Tool Surface

The server exposes 29 strongly-typed tools categorized into 8 functional domains:

| Domain | Tools | Description |
|---|---|---|
| **Health** | `warudo_status`, `warudo_frame_state` | Inspect host PID, active scene, FPS, and frame counter. |
| **Scene Discovery** | `warudo_scene_inventory`, `warudo_list_assets`, `warudo_get_selected_asset`, `warudo_get_plugins`, `warudo_get_asset_types`, `warudo_get_node_types` | Enumerate scene objects, plugins, asset types, and blueprint node catalogs. `warudo_list_assets` filters (`query`, `category`, `typeId`) and paginates (`offset`, `limit`) on the Unity side when the plugin advertises `list_assets_page`; older plugins fall back to client-side filtering. |
| **Entity** | `warudo_inspect_entity`, `warudo_get_entity_port_value`, `warudo_set_entity_port_value`, `warudo_invoke_entity_trigger`, `warudo_send_plugin_message` | Read/write data ports, fire trigger buttons, and dispatch plugin messages. |
| **Blueprints** | `warudo_get_selected_graph`, `warudo_list_graphs`, `warudo_list_blueprints`, `warudo_import_graph`, `warudo_export_graph`, `warudo_set_node_data_input` | List graphs compactly (`warudo_list_graphs`: id, name, enabled, node count, filter + pagination) or with full node metadata; serialize and import with `dryRun` validation. |
| **Graph Editing** | `warudo_manage_graph`, `warudo_manage_node`, `warudo_manage_connection`, `warudo_invoke_flow` | Create/remove/rename graphs, manage nodes, wire pins, and trigger flow inputs. |
| **Bones & Posing** | `warudo_list_bones`, `warudo_get_bone_offsets`, `warudo_set_bone_offsets`, `warudo_clear_bone_offsets` | Pose a character with per-bone rotation offsets (Warudo 0.15.2+). See [docs/BONES.md](docs/BONES.md). |
| **Unity Runtime** | `warudo_list_hierarchy`, `warudo_set_gameobject_active`, `warudo_set_material_property` | Traverse GameObject hierarchy, toggle objects, and apply material properties. |
| **Vision & Editor** | `warudo_capture_viewport`, `warudo_sync_scene` | Capture a JPEG from the active scene camera as an inline image (works while Warudo is minimized), and refresh the editor UI after changes made through MCP. Both need the updated bridge plugin (`capture_viewport` / `sync_scene` capabilities). |
| **Compatibility** | `warudo_api` | Raw passthrough for native Warudo actions not covered by typed tools. |

### Value Formatting & Validation

Port setters support explicit typed prefixes:
* Primitives: `float:0.5`, `int:42`, `bool:true`, `string:hello`
* Vectors: `vector3:0,1.5,-2`
* Colors: `color:#ff00ffff` or `color:1,0,1,1` (uniform 0–1 or 0–255 scale)
* JSON / Structured: `json:{"value": 2}`

---

## Configuration

| Environment Variable | Default Value | Description |
|---|---|---|
| `WARUDO_API_WS_URL` | `ws://[::1]:19053/` | Full WebSocket URL for Warudo Native API (overrides host/port). |
| `WARUDO_API_WS_HOST` / `WARUDO_API_WS_PORT` | `::1` / `19053` | Host and port for Warudo Native API. |
| `WARUDO_WS_URL` | `ws://localhost:5678/` | Full WebSocket URL for compiled C# MCP Bridge plugin. |
| `WARUDO_WS_HOST` / `WARUDO_WS_PORT` | `localhost` / `5678` | Host and port for C# MCP Bridge plugin. |
| `WARUDO_API_TOKEN` | *(Auto-discovered)* | 32-character hexadecimal auth token. Discovered automatically from `Player.log`. |
| `WARUDO_BRIDGE_TOKEN` | *(Auto-discovered)* | 32-character hexadecimal MCP Bridge token. The plugin generates a new one on start and logs it as `[McpBridge] MCP Bridge Auth Token: …` in `Player.log`. |

### Security Notes

* **Bridge authentication.** The bridge plugin rejects WebSocket handshakes that carry an `Origin` header (that is, connections opened by web pages) and requires its per-start token on every request. Tokens are never echoed or logged by the MCP server.
* **Loopback only by default.** Auto-discovered tokens are sent only to `localhost`, `127.0.0.0/8` or `::1`. To use a remote endpoint, set `WARUDO_API_TOKEN` / `WARUDO_BRIDGE_TOKEN` explicitly, and prefer `wss://`.
* **Prompt injection.** Asset names, node titles and imported blueprints (for example from Steam Workshop) are returned to the AI model verbatim. Treat them as untrusted, keep your client's tool-approval prompts enabled for mutating tools (`destructiveHint`), especially the raw `warudo_api` passthrough.

---

## Project Structure

```txt
warudo-mcp/
├── .github/
│   ├── workflows/ci.yml           # Multi-platform CI (Ubuntu & Windows)
│   ├── workflows/release.yml      # Tag-driven GitHub Release (+ optional npm publish)
│   └── dependabot.yml             # Weekly npm and Actions updates
├── docs/
│   ├── MIGRATION.md               # Upgrading from v0.1/v0.2 to v0.3 protocol v2
│   └── VERIFICATION.md            # Automated testing & live acceptance matrix
├── install.ps1                    # One-line automated PowerShell installer
├── mcp-server/                    # TypeScript MCP Server package
│   ├── src/
│   │   ├── tools/                 # Modular tool schemas (entities, graphs, runtime)
│   │   ├── server.ts              # MCP server factory with dependency injection
│   │   ├── values.ts              # Value validation & TransformData safety wrapper
│   │   ├── warudoApi.ts           # Native WebSocket client (:19053)
│   │   └── warudoBridge.ts        # Protocol v2 Bridge client (:5678)
│   └── tests/                     # Automated test suite (48 tests)
└── warudo-plugin/                 # C# Unity Plugin sources (UMod / .NET Framework)
    ├── Warudo-MCP.warudo          # Prebuilt mod (Warudo Mod Tools, Unity 2021.3.45f2)
    ├── McpBridgePlugin.cs         # Auto-starting [PluginType] lifecycle
    ├── McpBridgeService.cs        # WebSocketSharp RPC service
    ├── GameObjectPathResolver.cs  # Reflection-free hierarchy resolver
    └── MaterialKeywordOverrideStore.cs # Transient material PropertyBlock manager
```

---

## Development

Clone the repository and install dependencies:

```powershell
git clone https://github.com/KhoaDayy/warudo-mcp.git
cd warudo-mcp/mcp-server
npm ci
npm run build
```

### Local Commands

```powershell
npm run dev             # Run development server with tsx
npm run typecheck       # Verify TypeScript types without emitting
npm test                # Execute Node.js automated test runner (48 tests)
npm run check           # Run typecheck, tests, and npm pack allowlist verification
```

### Plugin Verification

To compile the C# plugin sources against your local Warudo installation:

```powershell
powershell -NoProfile -File scripts/check-bridge.ps1
```

### Building the Plugin

The `.warudo` mod is packaged by **Warudo Mod Tools** inside a Unity 2021.3 project; CI cannot build it.

1. Copy the four `warudo-plugin/*.cs` files into a folder inside your Mod Tools project (for example `Assets/McpBridge/`).
2. In **Warudo → Mod Settings**, create an export profile pointing at that folder.
3. Make sure Unity has generated `.csproj` files (**Edit → Preferences → External Tools → Regenerate project files**). Without them the export succeeds but contains no code (about 275 bytes).
4. Run **Warudo → Build Mod**. Copy the result to `warudo-plugin/Warudo-MCP.warudo` (it is git-ignored, so use `git add -f`).

> Mod code must not reference `System.Reflection`. UMod's security verifier rejects it, and `Type.Name` counts (it is `MemberInfo.get_Name`). Use `ShortTypeName(Type)` in `McpBridgeService.cs` instead.

### CI/CD

* **CI** (`.github/workflows/ci.yml`): typecheck, tests, build, package check and install check on Ubuntu and Windows for pushes to `main` and every pull request.
* **Release** ([Release Please](https://github.com/googleapis/release-please), `.github/workflows/release-please.yml`): every push to `main` updates a release PR that bumps `mcp-server/package.json`, the `warudo-mcp-server@x.y.z` pins in `install.ps1` and this README, and `CHANGELOG.md`. Merging that PR tags `vX.Y.Z`, creates the GitHub Release, attaches the npm tarball and `Warudo-MCP.warudo` (if committed), and publishes to npm when `NPM_TOKEN` is set.
* **Commit format.** Versions come from [Conventional Commits](https://www.conventionalcommits.org/): `feat:` bumps minor, `fix:` bumps patch, `feat!:` / `BREAKING CHANGE:` also bumps minor while below 1.0. Squash merges use the PR title, which `pr-title.yml` checks.
* **Manual fallback** (`.github/workflows/release.yml`): run it against an existing tag to retry a failed publish. It skips creating a release that already exists.
* **Dependabot** opens weekly updates for npm and GitHub Actions.

---

## Documentation

* [Migration Guide](docs/MIGRATION.md): Breaking changes from earlier versions and node retirement records.
* [Verification Record](docs/VERIFICATION.md): Test harness details, limits, response budgets, and live acceptance checklist.
* [Refactor Plan](REFACTOR_PLAN.md): Architectural decisions and scope audit history.

---

## License

This project is licensed under the [MIT License](LICENSE).

### Acknowledgements

* [Warudo](https://warudo.app/) by Hakuya Labs.
* [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic.
* Upstream architectural insights from `StudioRaming/warudo-agent-bridge` and `esprite-VTOKU/WarudoMCP`.
