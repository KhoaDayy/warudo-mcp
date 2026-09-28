import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Dependencies } from "./shared.js";
import { registerStatusTools } from "./status.js";
import { registerSceneTools } from "./scene.js";
import { registerEntityTools } from "./entities.js";
import { registerGraphTools } from "./graphs.js";
import { registerGraphEditTools } from "./graph-edit.js";
import { registerRuntimeTools } from "./runtime.js";

export function registerTools(server: McpServer, deps: Dependencies): void {
  registerStatusTools(server, deps);
  registerSceneTools(server, deps);
  registerEntityTools(server, deps);
  registerGraphTools(server, deps);
  registerRuntimeTools(server, deps);
  registerGraphEditTools(server, deps);

}
