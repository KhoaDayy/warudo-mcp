#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { WarudoBridge } from "./warudoBridge.js";
import { WarudoApiClient } from "./warudoApi.js";
import { discoverApiToken } from "./token.js";
import { createServer } from "./server.js";

const config = loadConfig();
const api = new WarudoApiClient(config.apiWsUrl, discoverApiToken);
const bridge = new WarudoBridge(config.wsUrl);
const server = createServer({ api, bridge, config });
let stopped = false;

function cleanup(): void {
  if (stopped) return;
  stopped = true;
  api.stop();
  bridge.stop();
}

function exit(code: number): void {
  cleanup();
  process.exit(code);
}

process.stdout.on("error", (error: unknown) => {
  if ((error as { code?: string })?.code === "EPIPE") exit(0);
  else { console.error("[warudo-mcp] stdout error:", error); exit(1); }
});
process.on("uncaughtException", (error) => {
  console.error("[warudo-mcp] Uncaught exception:", error);
  exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[warudo-mcp] Unhandled rejection:", reason);
  exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => exit(0));
for (const event of ["end", "close"] as const) process.stdin.on(event, () => exit(0));
process.stdin.on("error", (error) => { console.error("[warudo-mcp] stdin error:", error); exit(1); });

api.connect();
bridge.connect();
await server.connect(new StdioServerTransport());
console.error(`[warudo-mcp] ready — native ${config.apiWsUrl} · bridge ${config.wsUrl}`);
