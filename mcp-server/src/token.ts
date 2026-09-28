import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TOKEN_PATTERN = /^[0-9A-F]{32}$/i;
const MAX_FULL_READ_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_BYTES = 1024 * 1024;
const COMPANION_COOLDOWN_MS = 30_000;
let lastCompanionCheck = 0;
let cachedCompanionToken: string | null = null;

/** Validate and normalize a Warudo API token without ever including it in errors/logs. */
export function validateApiToken(value: string): string {
  const token = value.trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error("WARUDO_API_TOKEN must be a 32-character hexadecimal token.");
  return token.toUpperCase();
}

function playerLogPath(): string {
  return join(homedir(), "AppData", "LocalLow", "HakuyaLabs", "Warudo", "Player.log");
}

function outputLogPath(): string {
  return join(homedir(), "AppData", "LocalLow", "HakuyaLabs", "Warudo", "output_log.txt");
}

function tokenFromLogFile(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (stat.size === 0) return null;
    const readSize = stat.size <= MAX_FULL_READ_BYTES ? stat.size : LOG_TAIL_BYTES;
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, stat.size - readSize);
    const content = buffer.toString("utf8");
    const matches = content.match(/One Time API Auth Token:\s*([0-9A-F]{32})(?![0-9A-F])/gi);
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

function tokenFromLog(): string | null {
  return tokenFromLogFile(playerLogPath()) ?? tokenFromLogFile(outputLogPath());
}

async function tokenFromCompanion(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const now = Date.now();
  if (now - lastCompanionCheck < COMPANION_COOLDOWN_MS) return cachedCompanionToken;
  lastCompanionCheck = now;
  try {
    const { stdout } = await execFileAsync(
      "powershell",
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
  return companion ?? tokenFromLog();
}
