import WebSocket from "ws";

/** Phản hồi chuẩn từ plugin MCP Bridge trong Warudo. */
export interface WarudoResponse {
  action: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

type NotificationListener = (action: string, data: unknown) => void;

const CALL_TIMEOUT_MS = 20_000;
const INITIAL_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 10_000;

/**
 * WebSocket client kết nối tới plugin MCP Bridge chạy bên trong Warudo.
 * Tự động reconnect khi mất kết nối.
 *
 * Giao thức (JSON):
 *  →  { "action": "<tên lệnh>", "id": <số>, "data": { ... } }
 *  ←  { "action": "<tên lệnh>", "isResponse": true, "data": { "id": <số>, "ok": true|false, "data"?|"error"? } }
 */
export class WarudoBridge {
  private ws: WebSocket | null = null;
  private connected = false;
  private isConnecting = false;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (r: WarudoResponse) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >();
  private listeners = new Set<NotificationListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentDelay = INITIAL_RECONNECT_DELAY_MS;
  private stopped = false;

  constructor(private url: string) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.isConnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.failAll(new Error("WarudoBridge stopped."));
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Đăng ký nhận thông báo từ Warudo (broadcast/notification). Trả về hàm hủy đăng ký. */
  onNotification(cb: NotificationListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Gửi lệnh tới Warudo và chờ phản hồi. */
  async call(action: string, data: Record<string, unknown> = {}): Promise<WarudoResponse> {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const port = safePort(this.url);
      throw new Error(
        `Chưa kết nối tới Warudo (${this.url}). Hãy đảm bảo Warudo đang chạy và plugin/asset "MCP Bridge" đã được thêm vào scene (port ${port}).`
      );
    }
    const id = this.nextId++;
    return new Promise<WarudoResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hết thời gian chờ cho lệnh "${action}".`));
      }, CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timeout);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
        timeout,
      });

      // Warudo's WebSocketService passes msg["data"] to HandleAction(action, data),
      // so the correlation id must live INSIDE data.
      // Luôn đặt correlation id vào _reqId và chỉ gán sendData.id = id nếu data chưa có "id",
      // tránh ghi đè entity GUID id.
      const sendData: Record<string, unknown> = { _reqId: id, ...data };
      if (!("id" in data)) {
        sendData.id = id;
      }
      this.ws!.send(JSON.stringify({ action, data: sendData }), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  private open(): void {
    if (this.stopped || this.connected || this.isConnecting) return;
    this.isConnecting = true;

    try {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.on("open", () => {
        this.connected = true;
        this.isConnecting = false;
        this.currentDelay = INITIAL_RECONNECT_DELAY_MS;
        console.error(`[WarudoBridge] Đã kết nối tới ${this.url}`);
      });

      ws.on("message", (raw) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this.handleMessage(msg as Record<string, unknown>);
      });

      ws.on("close", () => {
        this.connected = false;
        this.isConnecting = false;
        this.failAll(new Error("Mất kết nối tới Warudo."));
        this.scheduleReconnect();
      });

      ws.on("error", (err) => {
        this.isConnecting = false;
        console.error(`[WarudoBridge] Lỗi WebSocket: ${(err as Error).message}`);
      });
    } catch (e) {
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.currentDelay);
    this.currentDelay = Math.min(this.currentDelay * 1.5, MAX_RECONNECT_DELAY_MS);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const action = typeof msg.action === "string" ? msg.action : "";
    // Tolerant: Warudo có thể bọc payload trong "data" hoặc "payload".
    const payload = msg.data ?? msg.payload;
    if (payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      const reqId = typeof p._reqId === "number" ? p._reqId : (typeof p.id === "number" ? p.id : undefined);
      if (reqId !== undefined && this.pending.has(reqId)) {
        const entry = this.pending.get(reqId)!;
        this.pending.delete(reqId);
        entry.resolve({
          action,
          ok: p.ok !== false,
          data: p.data,
          error: typeof p.error === "string" ? p.error : undefined,
        });
        return;
      }
    }
    // Thông báo / broadcast → không khớp id chờ nào.
    for (const l of this.listeners) {
      try {
        l(action, payload);
      } catch (err) {
        console.error(`[WarudoBridge] Lỗi listener: ${(err as Error).message}`);
      }
    }
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(e);
    }
    this.pending.clear();
  }
}

function safePort(url: string): string {
  try {
    return new URL(url).port || "5678";
  } catch {
    return "5678";
  }
}
