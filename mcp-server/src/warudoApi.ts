import WebSocket from "ws";

/**
 * Client kết nối tới control-plane tích hợp sẵn của Warudo
 * (ws://localhost:19053/ — Warudo.Core.Server.Service).
 *
 * Giao thức (đã xác minh live):
 *   →  { "action": "<action>", "data": { "id": <số>, ...payload } }
 *   ←  { "action": "<action>", "error": null | "<chuỗi>", "data": <payload> }
 *
 * Lưu ý quan trọng:
 *  - Server KHÔNG echo "id" trong phản hồi → đối chiếu theo action.
 *  - Server chủ động đẩy "frameUpdate" liên tục (trạng thái entity hiện tại, 30-60 FPS),
 *    và "confirmation" / "structuredDataInput" khi cần xác nhận.
 *  - Bắt tay cần subprotocol bằng API token (mỗi lần khởi động Warudo đổi token).
 */

export interface ApiMessage {
  action: string;
  error?: string | null;
  data?: unknown;
}

type Listener = (action: string, data: unknown) => void;

const CALL_TIMEOUT_MS = 20_000;
const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 15_000;
const FRAME_UPDATE_THROTTLE_MS = 1_000; // Tối đa 1 frame/giây để chống bão CPU & memory churn

export class WarudoApiClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private isConnecting = false;
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (m: ApiMessage) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >();
  private listeners = new Set<Listener>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private currentRetryDelay = INITIAL_RETRY_DELAY_MS;
  private stopped = false;
  private lastFrame: unknown = null;
  private lastFrameUpdateMs = 0;
  private lastLog = "";

  /** Cách phản hồi khi Warudo hỏi xác nhận. Mặc định decline (an toàn). */
  private confirmationPolicy: "decline" | "accept" = "decline";
  private recentAutoReplies: Array<{ ts: string; action: string; reply: string }> = [];

  constructor(
    private url: string,
    /** Hàm lấy token API (async — mỗi lần kết nối lại sẽ gọi lại để bắt token mới sau khi Warudo khởi động lại). */
    private getToken: () => Promise<string | null>
  ) {}

  connect(): void {
    this.stopped = false;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    this.isConnecting = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.failAll(new Error("WarudoApiClient stopped."));
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Snapshot mới nhất từ thông báo "frameUpdate" (giá trị port hiện tại của các entity). */
  getLastFrame(): unknown {
    return this.lastFrame;
  }

  /**
   * Đổi cách phản hồi confirmation/structuredDataInput của Warudo:
   *  - "decline": tự từ chối/hủy (mặc định) — an toàn, nhưng lệnh phá hoại có thể no-op.
   *  - "accept":  tự đồng ý — dùng khi bạn thực sự muốn chạy thao tác phá hoại.
   */
  setConfirmationPolicy(mode: "decline" | "accept"): void {
    this.confirmationPolicy = mode;
    console.error(`[WarudoApi] Confirmation policy → ${mode}`);
  }

  getConfirmationPolicy(): "decline" | "accept" {
    return this.confirmationPolicy;
  }

  /** Các lần auto-reply gần đây (để Claude biết lệnh nào bị từ chối/đồng ý). */
  getRecentAutoReplies(): Array<{ ts: string; action: string; reply: string }> {
    return this.recentAutoReplies;
  }

  /** Đăng ký nhận thông báo/broadcast từ Warudo. Trả về hàm hủy đăng ký. */
  onNotification(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Gọi một action bất kỳ của control-plane. Payload đi kèm data (KHÔNG gồm "id" —
   * client tự gắn id để đối chiếu).
   */
  call(action: string, data: Record<string, unknown> = {}): Promise<ApiMessage> {
    if (
      action === "exportGraph" &&
      (typeof data.graph !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(data.graph))
    ) {
      throw new Error("exportGraph requires a valid graph UUID.");
    }
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `Chưa kết nối tới control-plane Warudo (${this.url}). Kiểm tra Warudo đang chạy và token API đã lấy được.`
      );
    }
    const id = this.nextId++;
    const responseAction =
      action === "exportGraph" || action === "exportAsset"
        ? `${action}:${String(action === "exportGraph" ? data.graph : data.asset).toLowerCase()}`
        : action;
    const key = `${responseAction}:${id}`;

    return new Promise<ApiMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Hết thời gian chờ cho action "${action}".`));
      }, CALL_TIMEOUT_MS);

      this.pending.set(key, {
        resolve: (m) => {
          clearTimeout(timeout);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
        timeout,
      });

      // Server đọc data["id"] nên id phải nằm trong data (khớp pattern đã xác minh).
      this.ws!.send(JSON.stringify({ action, data: { id, ...data } }), (err) => {
        if (err) {
          this.pending.delete(key);
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  private async open(): Promise<void> {
    if (this.stopped || this.connected || this.isConnecting) return;
    this.isConnecting = true;

    try {
      const token = await this.getToken();
      if (!token) {
        this.logOnce("[WarudoApi] Chưa có API token (Warudo chưa chạy?) — thử lại sau.");
        this.isConnecting = false;
        this.scheduleRetry();
        return;
      }

      if (this.stopped) {
        this.isConnecting = false;
        return;
      }

      const ws = new WebSocket(this.url, [token]);
      this.ws = ws;

      ws.on("open", () => {
        this.connected = true;
        this.isConnecting = false;
        this.currentRetryDelay = INITIAL_RETRY_DELAY_MS; // reset retry delay khi kết nối thành công
        try {
          ws.send(JSON.stringify({ action: "onConnected" }));
        } catch {}
        console.error(`[WarudoApi] Đã kết nối control-plane ${this.url}`);
      });

      ws.on("message", (raw) => {
        // Tối ưu hóa hiệu năng: Warudo gửi frameUpdate ở 30-60 FPS với payload rất lớn.
        // Tránh decode toàn bộ buffer thành chuỗi nếu đây là frameUpdate bị throttle.
        if (Buffer.isBuffer(raw)) {
          const head = raw.subarray(0, 100).toString("utf-8");
          if (head.includes('"frameUpdate"')) {
            const now = Date.now();
            if (now - this.lastFrameUpdateMs < FRAME_UPDATE_THROTTLE_MS) {
              return;
            }
            this.lastFrameUpdateMs = now;
          }
        }

        const rawStr = typeof raw === "string" ? raw : raw.toString();
        if (!Buffer.isBuffer(raw)) {
          if (rawStr.includes('"action":"frameUpdate"') || rawStr.includes('"action": "frameUpdate"')) {
            const now = Date.now();
            if (now - this.lastFrameUpdateMs < FRAME_UPDATE_THROTTLE_MS) {
              return;
            }
            this.lastFrameUpdateMs = now;
          }
        }

        let msg: unknown;
        try {
          msg = JSON.parse(rawStr);
        } catch {
          return;
        }
        this.handleMessage(msg as Record<string, unknown>);
      });

      ws.on("unexpected-response", (_req, res) => {
        this.logOnce(
          `[WarudoApi] Bắt tay bị từ chối (HTTP ${res.statusCode}) — token API sai/hết hạn, thử lại.`
        );
        this.connected = false;
        this.isConnecting = false;
        try {
          ws.terminate();
        } catch {
          /* bỏ qua */
        }
        this.scheduleRetry();
      });

      ws.on("error", (err) => {
        this.isConnecting = false;
        console.error(`[WarudoApi] Lỗi WebSocket: ${(err as Error).message}`);
      });

      ws.on("close", () => {
        this.connected = false;
        this.isConnecting = false;
        this.failAll(new Error("Mất kết nối control-plane Warudo."));
        if (!this.stopped) this.scheduleRetry();
      });
    } catch (e) {
      this.isConnecting = false;
      this.scheduleRetry();
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const action = typeof msg.action === "string" ? msg.action : "";
    const d = msg.data;

    // 1) Khớp theo id nếu payload có id.
    if (d && typeof d === "object" && typeof (d as Record<string, unknown>).id === "number") {
      const respId = (d as Record<string, unknown>).id;
      // Khớp chính xác hoặc khớp prefix action:id
      for (const [key, hit] of this.pending) {
        if (key.endsWith(`:${respId}`)) {
          this.pending.delete(key);
          hit.resolve(msg as unknown as ApiMessage);
          return;
        }
      }
    }

    // 2) Server không echo id → khớp theo action (xử lý cả exportGraph/exportAsset).
    const matches = [...this.pending.keys()].filter((key) => {
      const prefix = key.slice(0, key.lastIndexOf(":"));
      return prefix === action || prefix.startsWith(action + ":");
    });
    if (matches.length > 0) {
      const key = matches[0];
      const hit = this.pending.get(key)!;
      this.pending.delete(key);
      hit.resolve(msg as unknown as ApiMessage);
      return;
    }

    // 3) Thông báo / broadcast.
    if (action === "frameUpdate") {
      this.lastFrame = d;
    }
    if (action === "confirmation") {
      const p = (d ?? {}) as Record<string, unknown>;
      const confirm = this.confirmationPolicy === "accept";
      this.reply("confirmation", { id: p.id, confirm });
      this.recordAutoReply(action, confirm ? "confirm:true" : "confirm:false");
    } else if (action === "structuredDataInput") {
      const p = (d ?? {}) as Record<string, unknown>;
      const cancel = this.confirmationPolicy !== "accept";
      this.reply("structuredDataInput", { id: p.id, cancel });
      this.recordAutoReply(action, cancel ? "cancel:true" : "cancel:false");
    }
    for (const l of this.listeners) {
      try {
        l(action, d);
      } catch (err) {
        console.error(`[WarudoApi] Lỗi listener: ${(err as Error).message}`);
      }
    }
  }

  private recordAutoReply(action: string, reply: string): void {
    this.recentAutoReplies.push({ ts: new Date().toISOString(), action, reply });
    if (this.recentAutoReplies.length > 10) this.recentAutoReplies.shift();
    console.error(
      `[WarudoApi] Auto-reply "${action}" → ${reply} (policy: ${this.confirmationPolicy}). ` +
        `Đổi bằng warudo_set_confirmation_policy.`
    );
  }

  private reply(action: string, data: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify({ action, data }));
    } catch {
      /* bỏ qua */
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || this.isConnecting) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, this.currentRetryDelay);

    // Tăng thời gian chờ (exponential backoff)
    this.currentRetryDelay = Math.min(this.currentRetryDelay * 1.5, MAX_RETRY_DELAY_MS);
  }

  private logOnce(msg: string): void {
    if (msg !== this.lastLog) {
      this.lastLog = msg;
      console.error(msg);
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
