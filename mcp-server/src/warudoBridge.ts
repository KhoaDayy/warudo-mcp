import WebSocket from "ws";
import { validateWsUrl } from "./config.js";

export interface WarudoResponse {
  action: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type TransportExecution = "UNKNOWN" | "NOT_EXECUTED";

export class BridgeTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly execution: TransportExecution = "UNKNOWN"
  ) {
    super(message);
    this.name = "BridgeTransportError";
  }
}

type NotificationListener = (action: string, data: unknown) => void;
type PendingCall = {
  id: number;
  action: string;
  resolve: (response: WarudoResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const CALL_TIMEOUT_MS = 20_000;
export interface BridgeOptions { callTimeoutMs?: number; reconnectDelayMs?: number; }
const INITIAL_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 10_000;
const MAX_REQUEST_BYTES = 1024 * 1024;

/** WebSocket client for the MCP Bridge plugin. */
export class WarudoBridge {
  private ws: WebSocket | null = null;
  private connected = false;
  private isConnecting = false;
  private handshaking = false;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private listeners = new Set<NotificationListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentDelay = INITIAL_RECONNECT_DELAY_MS;
  private stopped = false;
  private generation = 0;
  private readonly callTimeoutMs: number;
  private readonly initialDelay: number;
  private metadata: { protocolVersion: number; bridgeVersion: string; capabilities: string[] } | null = null;

  constructor(private url: string, options: BridgeOptions = {}) {
    this.url = validateWsUrl(url, "WARUDO_WS_URL");
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.initialDelay = options.reconnectDelayMs ?? INITIAL_RECONNECT_DELAY_MS;
    this.currentDelay = this.initialDelay;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retire("STOPPED", "Warudo bridge stopped.");
  }

  isConnected(): boolean { return this.connected; }
  getCapabilities(): string[] { return [...(this.metadata?.capabilities ?? [])]; }
  getBridgeInfo(): { protocolVersion: number; bridgeVersion: string; capabilities: string[] } | null {
    return this.metadata ? { ...this.metadata, capabilities: this.getCapabilities() } : null;
  }

  onNotification(cb: NotificationListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async call(action: string, data: Record<string, unknown> = {}): Promise<WarudoResponse> {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new BridgeTransportError("NOT_CONNECTED", `Warudo bridge is not connected (${this.url}).`, "NOT_EXECUTED");
    }
    if (typeof action !== "string" || !action || !data || typeof data !== "object" || Array.isArray(data)) {
      throw new BridgeTransportError("INVALID_INPUT", "Action and object payload are required.", "NOT_EXECUTED");
    }
    if (this.pending.size >= 128) throw new BridgeTransportError("BUSY", "Bridge request queue is full.", "NOT_EXECUTED");
    const id = this.nextId++;
    let wire: string;
    try {
      // _reqId belongs to the transport; preserve data.id when it is an entity ID.
      wire = JSON.stringify({ action, data: { ...data, _reqId: id } });
      if (Buffer.byteLength(wire) > MAX_REQUEST_BYTES) throw new Error();
    } catch {
      throw new BridgeTransportError("INVALID_INPUT", "Request must be JSON and at most 1 MiB.", "NOT_EXECUTED");
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.onTimeout(id), this.callTimeoutMs);
      this.pending.set(id, { id, action, resolve, reject, timeout });
      try {
        this.ws!.send(wire, (error) => {
          if (!error) return;
          const entry = this.pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timeout);
          this.pending.delete(id);
          entry.reject(new BridgeTransportError("SEND_FAILED", `Bridge request "${action}" delivery failed.`, "UNKNOWN"));
          this.retire("SEND_FAILED", "Bridge request delivery failed; execution is unknown.");
        });
      } catch {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(new BridgeTransportError("SEND_FAILED", `Bridge request "${action}" delivery failed.`, "UNKNOWN"));
        this.retire("SEND_FAILED", "Bridge request delivery failed; execution is unknown.");
      }
    });
  }

  private open(): void {
    if (this.stopped || this.connected || this.isConnecting || this.handshaking) return;
    this.isConnecting = true;
    const generation = ++this.generation;
    try {
      const ws = new WebSocket(this.url, { handshakeTimeout: this.callTimeoutMs, maxPayload: 16 * 1024 * 1024 });
      this.ws = ws;
      ws.on("open", () => {
        if (generation !== this.generation) return;
        this.isConnecting = false;
        this.handshaking = true;
        const id = this.nextId++;
        const timeout = setTimeout(() => this.onHandshakeTimeout(id), this.callTimeoutMs);
        this.pending.set(id, {
          id,
          action: "bridge_info",
          resolve: (response) => this.completeHandshake(response),
          reject: () => {},
          timeout,
        });
        try {
          ws.send(JSON.stringify({ action: "bridge_info", data: { _reqId: id } }), (error) => {
            if (error && generation === this.generation) this.retire("HANDSHAKE_FAILED", "Bridge protocol handshake failed.");
          });
        } catch {
          this.retire("HANDSHAKE_FAILED", "Bridge protocol handshake failed.");
        }
      });
      ws.on("message", (raw) => {
        if (generation !== this.generation) return;
        let msg: unknown;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
        this.handleMessage(msg as Record<string, unknown>);
      });
      ws.on("error", () => {
        if (generation === this.generation) this.retire("DISCONNECTED", "Bridge connection failed.");
      });
      ws.on("close", () => {
        if (generation === this.generation) this.retire("DISCONNECTED", "Bridge connection closed.");
      });
    } catch {
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private completeHandshake(response: WarudoResponse): void {
    this.handshaking = false;
    if (!response.ok || !response.data || typeof response.data !== "object") {
      this.retire("HANDSHAKE_FAILED", response.error ?? "Bridge protocol handshake failed.");
      return;
    }
    const metadata = response.data as Record<string, unknown>;
    if (metadata.protocolVersion !== 2 || typeof metadata.bridgeVersion !== "string" || !Array.isArray(metadata.capabilities) || metadata.capabilities.some((item) => typeof item !== "string")) {
      this.retire("PROTOCOL_MISMATCH", "Unsupported MCP Bridge protocol version.");
      return;
    }
    this.metadata = { protocolVersion: 2, bridgeVersion: metadata.bridgeVersion as string, capabilities: [...metadata.capabilities as string[]] };
    this.connected = true;
    this.currentDelay = this.initialDelay;
    this.notify("bridge_info", metadata);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const action = typeof msg.action === "string" ? msg.action : "";
    const payload = msg.data ?? msg.payload;
    // Only explicit response envelopes may resolve a request. Never use entity id.
    if (msg.isResponse === true && payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      const reqId = typeof p._reqId === "number" ? p._reqId : undefined;
      const entry = reqId === undefined ? undefined : this.pending.get(reqId);
      if (entry && action === entry.action) {
        if (typeof p.ok !== "boolean" || (p.error !== undefined && typeof p.error !== "string")) {
          this.retire("PROTOCOL_ERROR", "Bridge returned a malformed response.");
          return;
        }
        this.pending.delete(reqId!);
        clearTimeout(entry.timeout);
        const response: WarudoResponse = {
          action,
          ok: p.ok === true,
          data: p.data,
          error: typeof p.error === "string" ? p.error : undefined,
        };
        entry.resolve(response);
        return;
      }
    }
    this.notify(action, payload);
  }

  private notify(action: string, payload: unknown): void {
    for (const listener of this.listeners) {
      try { listener(action, payload); } catch { console.error("[WarudoBridge] Notification listener failed."); }
    }
  }

  private onHandshakeTimeout(id: number): void {
    if (!this.pending.has(id)) return;
    this.pending.delete(id);
    this.handshaking = false;
    this.retire("HANDSHAKE_TIMEOUT", "Bridge protocol handshake timed out.");
  }

  private onTimeout(id: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.reject(new BridgeTransportError("TIMEOUT", `Bridge action "${entry.action}" timed out; inspect state before retrying.`, "UNKNOWN"));
    this.retire("TIMEOUT", "Bridge request timed out; execution is unknown.");
  }

  private retire(code: string, message: string): void {
    const ws = this.ws;
    this.ws = null;
    this.generation++;
    this.connected = false;
    this.isConnecting = false;
    this.handshaking = false;
    this.metadata = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timeout);
      entry.reject(new BridgeTransportError(code, message, entry.action === "bridge_info" ? "NOT_EXECUTED" : "UNKNOWN"));
    }
    this.pending.clear();
    try { ws?.terminate(); } catch { /* already closed */ }
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.isConnecting) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.currentDelay);
    this.reconnectTimer.unref();
    this.currentDelay = Math.min(this.currentDelay * 1.5, MAX_RECONNECT_DELAY_MS);
  }
}
