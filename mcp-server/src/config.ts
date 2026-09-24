export interface Config {
  /** WebSocket URL của plugin MCP Bridge trong Warudo (kênh fallback cũ). */
  wsUrl: string;
  /** WebSocket URL của control-plane tích hợp sẵn trong Warudo (19053). */
  apiWsUrl: string;
}

/**
 * Đọc cấu hình từ biến môi trường.
 *
 * Legacy bridge (5678):
 *  - WARUDO_WS_URL    (mặc định: ws://localhost:5678/)
 *  - WARUDO_WS_HOST   (mặc định: localhost — Warudo listen trên IPv6 ::1,
 *                     "127.0.0.1" IPv4 sẽ bị ECONNREFUSED)
 *  - WARUDO_WS_PORT   (mặc định: 5678)
 *
 * Control-plane API (19053):
 *  - WARUDO_API_WS_URL    (mặc định: ws://localhost:19053/)
 *  - WARUDO_API_WS_HOST   (mặc định: localhost)
 *  - WARUDO_API_WS_PORT   (mặc định: 19053)
 */
export function loadConfig(): Config {
  // IPv6 literal (::1) phải bọc trong [] cho đúng chuẩn URL (ws://[::1]:port/).
  const fmtHost = (h: string) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);
  const host = process.env.WARUDO_WS_HOST ?? "localhost";
  const port = Number(process.env.WARUDO_WS_PORT ?? "5678");
  const apiHost = process.env.WARUDO_API_WS_HOST ?? "::1";
  const apiPort = Number(process.env.WARUDO_API_WS_PORT ?? "19053");
  return {
    wsUrl: process.env.WARUDO_WS_URL ?? `ws://${fmtHost(host)}:${port}/`,
    apiWsUrl: process.env.WARUDO_API_WS_URL ?? `ws://${fmtHost(apiHost)}:${apiPort}/`,
  };
}
