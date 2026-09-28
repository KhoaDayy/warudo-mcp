import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { WarudoApiClient } from "../warudoApi.js";
import type { WarudoBridge } from "../warudoBridge.js";
import { errorResult, RuntimeError } from "../results.js";

export interface Dependencies {
  api: Pick<WarudoApiClient, "call" | "isConnected" | "getLastFrame" | "getConfirmationPolicy" | "getRecentAutoReplies">;
  bridge: Pick<WarudoBridge, "call" | "isConnected">;
  config: Config;
  discoverToken?: () => Promise<string | null>;
}

export const nonEmpty = z.string().trim().min(1);
export const pageSchema = {
  query: z.string().optional().describe("Filter by title, name or id (case insensitive)."),
  category: z.string().optional().describe("Filter by category (case insensitive)."),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
};

export function registerTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  readOnlyHint: boolean,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
): void {
  server.registerTool(name, { description, inputSchema: z.object(inputSchema).strict() as z.ZodObject<z.ZodRawShape>, annotations: {
    readOnlyHint,
    destructiveHint: !readOnlyHint,
    idempotentHint: readOnlyHint,
    openWorldHint: false,
  } }, async (args) => {
    try {
      return await handler(args as z.infer<z.ZodObject<S>>);
    } catch (error) {
      return errorResult(error);
    }
  });
}

export async function apiCall(api: Dependencies["api"], action: string, data: Record<string, unknown> = {}): Promise<unknown> {
  const response = await api.call(action, data);
  if (response.error) throw new RuntimeError(response.error, "API_ERROR");
  return response.data ?? null;
}

export async function bridgeCall(bridge: Dependencies["bridge"], action: string, data: Record<string, unknown> = {}): Promise<unknown> {
  const response = await bridge.call(action, data);
  if (!response.ok) throw new RuntimeError(response.error ?? "Warudo bridge returned an unknown error.", "BRIDGE_ERROR");
  return response.data ?? null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export interface PageFilter { query?: string; category?: string; offset: number; limit: number }

export function page<T extends Record<string, unknown>>(items: T[], filter: PageFilter) {
  const query = filter.query?.trim().toLowerCase();
  const category = filter.category?.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (category && !String(item.category ?? "").toLowerCase().includes(category)) return false;
    if (query && ![item.id, item.typeId, item.title, item.name].some((value) => String(value ?? "").toLowerCase().includes(query))) return false;
    return true;
  });
  const end = filter.offset + filter.limit;
  return {
    total: filtered.length,
    offset: filter.offset,
    count: filtered.slice(filter.offset, end).length,
    nextOffset: end < filtered.length ? end : null,
    items: filtered.slice(filter.offset, end),
  };
}
