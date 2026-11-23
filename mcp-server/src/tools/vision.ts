import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RuntimeError } from "../results.js";
import { asRecord, bridgeCall, registerTool, type Dependencies } from "./shared.js";

function requireCapability(bridge: Dependencies["bridge"], capability: string): void {
  const caps = bridge.getCapabilities?.();
  // Unknown (test doubles, very old bridges) falls through to the bridge's own "Unknown action" error.
  if (caps && caps.length > 0 && !caps.includes(capability)) {
    throw new RuntimeError(`The installed Warudo MCP Bridge plugin does not support ${capability}. Update Warudo-MCP.warudo.`, "UNSUPPORTED");
  }
}

export function registerVisionTools(server: McpServer, { bridge }: Dependencies): void {
  registerTool(server, "warudo_capture_viewport", "Capture a JPEG screenshot from the active Warudo camera and return it as an inline image for visual inspection. Works while the Warudo window is minimized. Use it to verify camera angles, lighting, expressions, outfits and scene composition. Transparent backgrounds render black.", {
    width: z.number().int().min(64).max(3840).default(960).describe("Capture width in pixels (default 960)."),
    height: z.number().int().min(64).max(2160).default(540).describe("Capture height in pixels (default 540)."),
    quality: z.number().int().min(1).max(100).default(75).describe("JPEG quality 1-100 (default 75)."),
  }, true, async ({ width, height, quality }): Promise<CallToolResult> => {
    requireCapability(bridge, "capture_viewport");
    const data = asRecord(await bridgeCall(bridge, "capture_viewport", { width, height, quality }));
    const { base64, mimeType } = data;
    if (typeof base64 !== "string" || !base64) throw new RuntimeError("Warudo bridge returned no image data.", "NO_IMAGE_DATA");
    return {
      content: [
        { type: "image" as const, data: base64, mimeType: typeof mimeType === "string" && mimeType.startsWith("image/") ? mimeType : "image/jpeg" },
        { type: "text" as const, text: JSON.stringify({ width: data.width, height: data.height, byteLength: data.byteLength, camera: data.camera }) },
      ],
    };
  });

  registerTool(server, "warudo_sync_scene", "Ask the Warudo editor UI to refresh the opened scene and blueprints after changes made through MCP, without closing and reopening the editor. An optional graph (ID or name) is validated before the refresh.", {
    graph: z.string().min(1).optional().describe("Optional graph UUID or name to validate before refreshing."),
  }, false, async ({ graph }): Promise<CallToolResult> => {
    requireCapability(bridge, "sync_scene");
    const data = await bridgeCall(bridge, "sync_scene", graph ? { graph } : {});
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  });
}
