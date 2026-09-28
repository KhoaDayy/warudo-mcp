import { VERSION } from "./version.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { WarudoBridge } from "./warudoBridge.js";
import type { WarudoApiClient } from "./warudoApi.js";
import { registerTools } from "./tools/index.js";
import { discoverApiToken } from "./token.js";

export interface ServerDependencies {
  api: Pick<WarudoApiClient, "call" | "isConnected" | "getLastFrame" | "getConfirmationPolicy" | "getRecentAutoReplies">;
  bridge: Pick<WarudoBridge, "call" | "isConnected">;
  config: Config;
  discoverToken?: typeof discoverApiToken;
}

/** Build an MCP server without opening sockets; useful for tests and embedding. */
export function createServer({ api, bridge, config, discoverToken = discoverApiToken }: ServerDependencies): McpServer {
  const server = new McpServer({ name: "warudo-mcp", version: VERSION });
  registerTools(server, { api, bridge, config, discoverToken });
  return server;
}
