import WebSocket from "ws";
import { validateWsUrl } from "./config.js";
import { validateApiToken } from "./token.js";

export interface ApiMessage {
  action: string;
  error?: string | null;
  data?: unknown;
}

export class TransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly execution: "UNKNOWN" | "NOT_EXECUTED" = "UNKNOWN"
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface TransportOptions {
  callTimeoutMs?: number;
  reconnectDelayMs?: number;
  frameThrottleMs?: number;
}

type Listener = (action: string, data: unknown) => void;
type PendingCall = {
  action: string;
  expectedAction: string;
  wire: string;
  resolve: (message: ApiMessage) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_QUEUED_CALLS = 128;

/** Native Warudo wire protocol. No echoed request IDs: at most one call is sent at a time. */
export class WarudoApiClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private isConnecting = false;
  private nextId = 1;
  private active: PendingCall | null = null;
  private queue: PendingCall[] = [];
  private listeners = new Set<Listener>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private currentRetryDelay: number;
  private stopped = false;
  private lastFrame: unknown = null;
  private lastFrameUpdateMs = 0;
  private generation = 0;
  private readonly callTimeoutMs: number;
  private readonly initialRetryDelay: number;
  private readonly frameThrottleMs: number;
  private dialogHistory: Array<{ ts: string; action: string; reply: string }> = [];

  constructor(
    private url: string,
    private getToken: () => Promise<string | null>,
    options: TransportOptions = {}
  ) {
    this.url = validateWsUrl(url);
    this.callTimeoutMs = options.callTimeoutMs ?? 20_000;
    this.initialRetryDelay = options.reconnectDelayMs ?? 2_000;
    this.currentRetryDelay = this.initialRetryDelay;
    this.frameThrottleMs = options.frameThrottleMs ?? 1_000;
  }

  connect(): void {
    this.stopped = false;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retire("STOPPED", "Warudo API client stopped.");
  }

  isConnected(): boolean { return this.connected; }
  getLastFrame(): unknown { return this.lastFrame; }
  getConfirmationPolicy(): "manual" { return "manual"; }
  /** Compatibility accessor: manual dialogs are recorded, never automatically accepted. */
  getRecentAutoReplies(): Array<{ ts: string; action: string; reply: string }> {
    return this.dialogHistory.map((item) => ({ ...item }));
  }
  onNotification(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  call(action: string, data: Record<string, unknown> = {}): Promise<ApiMessage> {
    if (typeof action !== "string" || !action || !data || typeof data !== "object" || Array.isArray(data)) {
      return Promise.reject(new TransportError("INVALID_INPUT", "Action and object payload are required.", "NOT_EXECUTED"));
    }
    if (action === "exportGraph" && (typeof data.graph !== "string" || !isUuid(data.graph))) {
      return Promise.reject(new TransportError("INVALID_INPUT", "exportGraph requires a valid graph UUID.", "NOT_EXECUTED"));
    }
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new TransportError("NOT_CONNECTED", "Warudo control-plane is not connected.", "NOT_EXECUTED"));
    }
    if (this.queue.length >= MAX_QUEUED_CALLS) {
      return Promise.reject(new TransportError("BUSY", "Warudo request queue is full.", "NOT_EXECUTED"));
    }
    let wire: string;
    try {
      // Preserve the native data.id meaning (entity ID for entity actions).
      wire = JSON.stringify({ action, data: { id: this.nextId++, ...data } });
      if (Buffer.byteLength(wire) > MAX_REQUEST_BYTES) throw new Error();
    } catch {
      return Promise.reject(new TransportError("INVALID_INPUT", "Request must be JSON and at most 1 MiB.", "NOT_EXECUTED"));
    }
    const target = action === "exportGraph" ? data.graph : data.asset;
    const expectedAction = (action === "exportGraph" || action === "exportAsset") && typeof target === "string"
      ? `${action}:${target.toLowerCase()}` : action;
    return new Promise((resolve, reject) => {
      this.queue.push({ action, expectedAction, wire, resolve, reject });
      this.pump();
    });
  }

  private async open(): Promise<void> {
    if (this.stopped || this.connected || this.isConnecting) return;
    this.isConnecting = true;
    const generation = ++this.generation;
    try {
      const discovered = await this.getToken();
      if (this.stopped || generation !== this.generation) return;
      if (!discovered) {
        this.isConnecting = false;
        this.scheduleRetry();
        return;
      }
      const token = validateApiToken(discovered);
      const ws = new WebSocket(this.url, [token], { handshakeTimeout: this.callTimeoutMs, maxPayload: 16 * 1024 * 1024 });
      this.ws = ws;
      ws.on("open", () => {
        if (generation !== this.generation) return;
        this.connected = true;
        this.isConnecting = false;
        this.currentRetryDelay = this.initialRetryDelay;
        try {
          ws.send(JSON.stringify({ action: "onConnected" }), (error) => {
            if (error && generation === this.generation) this.retire("SEND_FAILED", "Warudo initialization failed.");
          });
        } catch {
          this.retire("SEND_FAILED", "Warudo initialization failed.");
        }
      });
      ws.on("message", (raw) => {
        if (generation !== this.generation) return;
        if (this.shouldDropThrottledFrame(raw)) return;
        let message: unknown;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) return;
        this.handleMessage(message as Record<string, unknown>);
      });
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        if (generation === this.generation) this.retire("AUTH_FAILED", "Warudo API handshake was rejected.");
      });
      // Never log raw websocket errors: they can contain connection credentials.
      ws.on("error", () => {
        if (generation === this.generation) this.retire("DISCONNECTED", "Warudo API connection failed.");
      });
      ws.on("close", () => {
        if (generation === this.generation) this.retire("DISCONNECTED", "Warudo API connection closed.");
      });
    } catch {
      if (generation !== this.generation) return;
      this.isConnecting = false;
      this.scheduleRetry();
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    const action = typeof message.action === "string" ? message.action : "";
    if (!action) return;
    if (action === "frameUpdate") {
      if (Date.now() - this.lastFrameUpdateMs < this.frameThrottleMs) return;
      this.lastFrameUpdateMs = Date.now();
      this.lastFrame = message.data;
      this.notify(action, message.data);
      return;
    }
    if (action === "confirmation" || action === "structuredDataInput") {
      this.dialogHistory.push({ ts: new Date().toISOString(), action, reply: "manual: Warudo UI input required" });
      if (this.dialogHistory.length > 10) this.dialogHistory.shift();
      this.notify(action, message.data);
      // Dialog IDs identify dialogs, not requests. Never auto-answer an unrelated UI dialog.
      if (this.active) this.retire("CONFIRMATION_REQUIRED", "Warudo requires input in its UI; execution is not confirmed.");
      return;
    }
    const active = this.active;
    const baseExportError = active && (active.action === "exportGraph" || active.action === "exportAsset") && action === active.action && typeof message.error === "string" && message.error.length > 0;
    const matches = active && (action === active.expectedAction || baseExportError);
    if (matches && message.isResponse !== false && ("data" in message || "error" in message)) {
      if (message.error !== undefined && message.error !== null && typeof message.error !== "string") {
        this.retire("PROTOCOL_ERROR", "Warudo returned a malformed response.");
        return;
      }
      this.active = null;
      clearTimeout(active.timeout);
      active.resolve({ action, data: message.data, error: message.error as string | null | undefined });
      this.pump();
      return;
    }
    this.notify(action, message.data);
  }

  private shouldDropThrottledFrame(raw: WebSocket.RawData): boolean {
    if (this.frameThrottleMs <= 0 || Date.now() - this.lastFrameUpdateMs >= this.frameThrottleMs) return false;
    if (!Buffer.isBuffer(raw)) return false;
    // Warudo puts action near the beginning of JSON frameUpdate messages.
    // Inspect a bounded prefix so a 30–60 FPS payload is not fully decoded when throttled.
    return /^\s*\{\s*"action"\s*:\s*"frameUpdate"\s*[,}]/.test(raw.subarray(0, 256).toString("utf8"));
  }

  private notify(action: string, data: unknown): void {
    for (const listener of this.listeners) {
      try { listener(action, data); } catch { console.error("[WarudoApi] Notification listener failed."); }
    }
  }

  private pump(): void {
    if (this.active || !this.connected || this.ws?.readyState !== WebSocket.OPEN) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.active = entry;
    // Start the response deadline only when sent, not while the request is queued.
    entry.timeout = setTimeout(() => {
      if (this.active === entry) this.retire("TIMEOUT", `Warudo action "${entry.action}" timed out; inspect state before retrying.`);
    }, this.callTimeoutMs);
    try {
      this.ws.send(entry.wire, (error) => {
        if (error && this.active === entry) this.retire("SEND_FAILED", "Warudo request delivery failed; execution is unknown.");
      });
    } catch {
      this.retire("SEND_FAILED", "Warudo request delivery failed; execution is unknown.");
    }
  }

  /** Retire before releasing pending calls: late frames cannot match a newer request. */
  private retire(code: string, message: string): void {
    const ws = this.ws;
    this.ws = null;
    this.generation++;
    this.connected = false;
    this.isConnecting = false;
    this.lastFrame = null;
    this.lastFrameUpdateMs = 0;
    const active = this.active;
    this.active = null;
    if (active) {
      clearTimeout(active.timeout);
      active.reject(new TransportError(code, message, "UNKNOWN"));
    }
    for (const entry of this.queue.splice(0)) {
      entry.reject(new TransportError(code, "Queued request was not sent to Warudo.", "NOT_EXECUTED"));
    }
    try { ws?.terminate(); } catch { /* already closed */ }
    if (!this.stopped) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || this.isConnecting) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, this.currentRetryDelay);
    this.retryTimer.unref();
    this.currentRetryDelay = Math.min(this.currentRetryDelay * 1.5, 15_000);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}
