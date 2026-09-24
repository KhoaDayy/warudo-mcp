import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Token API của Warudo được sinh lại mỗi lần khởi động và chỉ hiển thị trong:
 *   1. Log:   "One Time API Auth Token: <32 ký tự HEX hoa>"
 *   2. CLI:   warudo-client-electron.exe --token="<32 ký tự HEX hoa>"
 *   3. Môi trường WARUDO_API_TOKEN (do người dùng đặt để ghi đè).
 *
 * Đường dẫn log (Windows, thử lần lượt):
 *   %USERPROFILE%\AppData\LocalLow\HakuyaLabs\Warudo\Player.log
 *   %USERPROFILE%\AppData\LocalLow\HakuyaLabs\Warudo\output_log.txt
 *
 * Player.log tích lũy qua nhiều lần chạy → luôn lấy token MỚI NHẤT (cuối file).
 * Tối ưu: Chỉ đọc 128KB cuối của file log để tránh nghẽn Event Loop và OOM khi log lớn.
 */

const MAX_FULL_READ_BYTES = 2 * 1024 * 1024; // 2 MB: nếu file nhỏ hơn 2MB, đọc toàn bộ
const LOG_TAIL_BYTES = 1024 * 1024; // 1 MB: nếu file > 2MB, chỉ đọc 1MB cuối
const COMPANION_COOLDOWN_MS = 30_000; // Tối đa 1 lần gọi PowerShell mỗi 30s
let lastCompanionCheck = 0;
let cachedCompanionToken: string | null = null;

/** Player.log (chính) — Unity build. */
function playerLogPath(): string {
  return join(homedir(), "AppData", "LocalLow", "HakuyaLabs", "Warudo", "Player.log");
}

/** output_log.txt (fallback) — một số bản Unity standalone ghi thêm file này. */
function outputLogPath(): string {
  return join(homedir(), "AppData", "LocalLow", "HakuyaLabs", "Warudo", "output_log.txt");
}

/** Đọc phần đuôi (tail) của file log một cách an toàn và nhẹ nhàng. */
function tokenFromLogFile(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (stat.size === 0) return null;

    const readSize = stat.size <= MAX_FULL_READ_BYTES ? stat.size : LOG_TAIL_BYTES;
    const buffer = Buffer.alloc(readSize);
    const position = stat.size - readSize;

    readSync(fd, buffer, 0, readSize, position);
    const content = buffer.toString("utf8");

    const matches = content.match(/One Time API Auth Token:\s*([0-9A-F]{32})/gi);
    if (!matches || matches.length === 0) return null;
    const m = matches[matches.length - 1].match(/[0-9A-F]{32}/i);
    return m ? m[0].toUpperCase() : null;
  } catch {
    return null; // Chưa có log / file đang bị khóa
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* bỏ qua */
      }
    }
  }
}

function tokenFromLog(): string | null {
  return tokenFromLogFile(playerLogPath()) ?? tokenFromLogFile(outputLogPath());
}

async function tokenFromCompanion(): Promise<string | null> {
  const now = Date.now();
  if (now - lastCompanionCheck < COMPANION_COOLDOWN_MS) {
    return cachedCompanionToken;
  }
  lastCompanionCheck = now;

  try {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'warudo-client-electron*' -and $_.CommandLine -match '--token=' } | Select-Object -First 1 -ExpandProperty CommandLine",
      ],
      { timeout: 5000, windowsHide: true }
    );
    const m = stdout.match(/--token=["']?([0-9A-F]{32})["']?/i);
    cachedCompanionToken = m ? m[1].toUpperCase() : null;
    return cachedCompanionToken;
  } catch {
    cachedCompanionToken = null;
    return null;
  }
}

/**
 * Tìm token API của Warudo đang chạy. Trả về null nếu chưa tìm thấy.
 */
export async function discoverApiToken(): Promise<string | null> {
  const fromEnv = process.env.WARUDO_API_TOKEN?.trim();
  if (fromEnv) return fromEnv.toUpperCase();
  const fromCompanion = await tokenFromCompanion();
  if (fromCompanion) return fromCompanion;
  return tokenFromLog();
}
