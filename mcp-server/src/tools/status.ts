import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { result } from "../results.js";
import { asRecord, registerTool, type Dependencies } from "./shared.js";

export function registerStatusTools(server: McpServer, deps: Dependencies): void {
  const { api, bridge, config } = deps;
  registerTool(server, "warudo_status", "Report native API and runtime bridge connectivity without exposing API tokens.", {}, true, async () => {
    const nativeConnected = api.isConnected();
    const tokenAvailable = nativeConnected || (deps.discoverToken ? Boolean(await deps.discoverToken().catch(() => null)) : null);
    return result({
      native: { url: config.apiWsUrl, connected: nativeConnected, tokenAvailable },
      bridge: { url: config.wsUrl, connected: bridge.isConnected() },
      confirmationPolicy: api.getConfirmationPolicy(),
      recentConfirmations: api.getRecentAutoReplies().slice(-3),
      frameEntityCount: Object.keys(asRecord(asRecord(api.getLastFrame()).entityData)).length,
    });
  });
  registerTool(server, "warudo_frame_state", "Read the latest native frameUpdate snapshot for the current connection. It is not a full scene inventory.", {}, true, async () => {
    const frame = api.getLastFrame();
    return result({ source: "native", available: frame !== null, frame });
  });
}
