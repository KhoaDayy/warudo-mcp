import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TOKEN_PATTERN = /^[0-9A-F]{32}$/i;
const MAX_FULL_READ_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_BYTES = 1024 * 1024;
const COMPANION_COOLDOWN_MS = 30_000;
const NATIVE_TOKEN_LINE = /One Time API Auth Token:\s*([0-9A-F]{32})(?![0-9A-F])/gi;
const BRIDGE_TOKEN_LINE = /MCP Bridge Auth Token:\s*([0-9A-F]{32})(?![0-9A-F])/gi;
let lastCompanionCheck = 0;
let cachedCompanionToken: string | null = null;

/** Validate and normalize a Warudo API token without ever including it in errors/logs. */
export function validateApiToken(value: string, name = "WARUDO_API_TOKEN"): string {
  const token = value.trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error(`${name} must be a 32-character hexadecimal token.`);
  return token.toUpperCase();
}

function playerLogPath(): string {
  return join(homedir(), "AppData", "LocalLow", "HakuyaLabs", "Warudo", "Player.log");
}

function outputLogPath(): string {
  return join(homedir(), "AppData", "LocalLow", "HakuyaLabs", "Warudo", "output_log.txt");
}

function tokenFromLogFile(path: string, pattern: RegExp): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (stat.size === 0) return null;
    const readSize = stat.size <= MAX_FULL_READ_BYTES ? stat.size : LOG_TAIL_BYTES;
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, stat.size - readSize);
    const content = buffer.toString("utf8");
    const matches = content.match(pattern);
    if (!matches?.length) return null;
    const match = matches[matches.length - 1].match(/[0-9A-F]{32}/i)?.[0];
    return match ? validateApiToken(match) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignored */ }
    }
  }
}

function tokenFromLog(pattern: RegExp): string | null {
  return tokenFromLogFile(playerLogPath(), pattern) ?? tokenFromLogFile(outputLogPath(), pattern);
}

/**
 * Absolute path to Windows PowerShell. A bare "powershell" is resolved by
 * libuv from the current working directory before PATH, so a planted
 * powershell.exe in the MCP client's workspace would otherwise be executed.
 */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function tokenFromCompanion(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const now = Date.now();
  if (now - lastCompanionCheck < COMPANION_COOLDOWN_MS) return cachedCompanionToken;
  lastCompanionCheck = now;
  try {
    const { stdout } = await execFileAsync(
      powershellPath(),
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'warudo-client-electron*' -and $_.CommandLine -match '--token=' } | Select-Object -First 1 -ExpandProperty CommandLine",
      ],
      { timeout: 5000, windowsHide: true, maxBuffer: 128 * 1024 }
    );
    const match = stdout.match(/--token=["']?([0-9A-F]{32})(?![0-9A-F])["']?/i)?.[1];
    cachedCompanionToken = match ? validateApiToken(match) : null;
    return cachedCompanionToken;
  } catch {
    cachedCompanionToken = null;
    return null;
  }
}

/** Find the current Warudo API token. Returns null when Warudo is not running. */
export async function discoverApiToken(): Promise<string | null> {
  const envToken = process.env.WARUDO_API_TOKEN;
  if (envToken !== undefined) {
    return validateApiToken(envToken);
  }
  const companion = await tokenFromCompanion();
  return companion ?? tokenFromLog(NATIVE_TOKEN_LINE);
}

/** Find the MCP Bridge plugin token logged by the plugin on each server start. */
export async function discoverBridgeToken(): Promise<string | null> {
  const envToken = process.env.WARUDO_BRIDGE_TOKEN;
  if (envToken !== undefined) return validateApiToken(envToken, "WARUDO_BRIDGE_TOKEN");
  return tokenFromLog(BRIDGE_TOKEN_LINE);
}

/** True only for loopback WebSocket endpoints (localhost, 127.0.0.0/8, ::1). */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Tokens auto-discovered from local logs/processes are sent only to loopback
 * endpoints. A remote endpoint requires an explicit token in the environment,
 * so a misconfigured URL can never exfiltrate the local Warudo credential.
 */
export function restrictAutoTokenToLoopback(
  url: string,
  envName: string,
  discover: () => Promise<string | null>,
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<string | null> {
  if (env[envName] !== undefined || isLoopbackUrl(url)) return discover;
  let warned = false;
  return async () => {
    if (!warned) {
      warned = true;
      console.error(`[warudo-mcp] ${envName} is not set; auto-discovered tokens are only sent to loopback endpoints.`);
    }
    return null;
  };
}
