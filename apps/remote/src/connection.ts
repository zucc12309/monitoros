/**
 * Authenticated WebSocket client for the MonitorOS remote server.
 * Protocol: first message {auth: token}; then RemoteEnvelope {seq, sentAt, command}.
 * The server acks every envelope and pushes {type:"status"} updates.
 */
import type { RemoteCommand, RemoteStatus } from "@monitoros/contracts";
import { validateCommand } from "@monitoros/contracts";

export type ConnState = "connecting" | "online" | "offline" | "unauthorized";

/** A socket that hasn't authenticated by then is treated as dead (iOS can
 * leave one "connecting" for a minute after Wi-Fi changes or sleep). */
export const CONNECT_TIMEOUT_MS = 4000;
/** Retries are cheap on the home network, so keep the wait short. */
export const RETRY_BASE_MS = 250;
export const RETRY_MAX_MS = 2000;

const TOKEN_KEY = "monitoros-remote-token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: stays in memory for this session */
  }
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T | string }> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) as T };
  } catch {
    return { status: res.status, data: text };
  }
}

export async function requestPairing(deviceName: string): Promise<string> {
  const r = await post<{ requestId: string }>("api/pair/request", { deviceName });
  if (r.status !== 200 || typeof r.data === "string") throw new Error(typeof r.data === "string" ? r.data : `HTTP ${r.status}`);
  return r.data.requestId;
}

/** 202 = still waiting for approval on the TV. */
export async function completePairing(requestId: string, code: string): Promise<{ waiting: true } | { token: string }> {
  const r = await post<{ token: string }>("api/pair/complete", { requestId, code });
  if (r.status === 202) return { waiting: true };
  if (r.status !== 200 || typeof r.data === "string") throw new Error(typeof r.data === "string" ? r.data : `HTTP ${r.status}`);
  return { token: r.data.token };
}

export class RemoteConnection {
  private ws: WebSocket | null = null;
  private seq = 0;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private closedByUser = false;
  private pending = new Map<number, number>(); // seq -> sentAt (for latency)
  latencyMs: number | null = null;
  state: ConnState = "connecting";
  /** This phone's paired device ID (from the server's auth reply). */
  deviceId: string | null = null;

  constructor(
    private token: string,
    private onState: (s: ConnState) => void,
    private onStatus: (s: RemoteStatus) => void,
  ) {}

  connect() {
    this.closedByUser = false;
    clearTimeout(this.timer);
    this.setState("connecting");
    const url = new URL("ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    this.ws = ws;
    this.seq = 0;
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && this.state !== "online") ws.close(); // onclose retries
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify({ auth: this.token }));
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let msg: { type?: string; ok?: boolean; seq?: number; status?: RemoteStatus; deviceId?: string };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === "auth") {
        clearTimeout(this.connectTimer);
        if (msg.ok) {
          this.retry = 0;
          if (typeof msg.deviceId === "string") this.deviceId = msg.deviceId;
          this.setState("online");
        } else {
          this.closedByUser = true;
          this.setState("unauthorized");
        }
      } else if (msg.type === "ack" && typeof msg.seq === "number") {
        const sent = this.pending.get(msg.seq);
        if (sent) this.latencyMs = Date.now() - sent;
        this.pending.delete(msg.seq);
      } else if (msg.type === "status" && msg.status) {
        this.onStatus(msg.status);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // replaced by reconnectNow()
      this.ws = null;
      clearTimeout(this.connectTimer);
      if (this.closedByUser) return;
      this.setState("offline");
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  private setState(s: ConnState) {
    this.state = s;
    this.onState(s);
  }

  /** Back in front, or the network returned: don't wait for the retry timer.
   * `stale` forces a fresh socket even if the old one still looks open
   * (after a long background stretch iOS often leaves a dead one). */
  reconnectNow(stale = false) {
    if (this.closedByUser && this.state === "unauthorized") return;
    const open = this.ws?.readyState === WebSocket.OPEN && this.state === "online";
    if (open && !stale) return;
    if (this.ws?.readyState === WebSocket.CONNECTING && !stale) return; // already trying
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.retry = 0;
    this.connect();
  }

  send(command: RemoteCommand): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const cmd = validateCommand(command);
    const seq = ++this.seq;
    const sentAt = Date.now();
    this.pending.set(seq, sentAt);
    if (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value!);
    this.ws.send(JSON.stringify({ seq, sentAt, command: cmd }));
    return true;
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.timer);
    clearTimeout(this.connectTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
