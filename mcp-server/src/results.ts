import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ExecutionState = "NOT_EXECUTED" | "EXECUTED" | "UNKNOWN";

/** A validation failure is raised before a command is sent to Warudo. */
export class InputError extends Error {
  readonly code = "INVALID_INPUT";
  readonly execution = "NOT_EXECUTED" as const;
}

export class RuntimeError extends Error {
  constructor(message: string, public readonly code: string, public readonly execution: ExecutionState = "UNKNOWN") {
    super(message);
  }
}

export function result(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data ?? null, null, 2) }] };
}

export function errorResult(error: unknown): CallToolResult {
  const detail = error as { code?: unknown; execution?: unknown; message?: unknown } | null;
  const execution = detail?.execution;
  const body = {
    code: typeof detail?.code === "string" ? detail.code : "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    execution: execution === "NOT_EXECUTED" || execution === "EXECUTED" || execution === "UNKNOWN" ? execution : "UNKNOWN",
  };
  return { ...result({ error: body }), isError: true };
}
