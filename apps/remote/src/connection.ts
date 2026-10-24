/**
 * Authenticated WebSocket client for the MonitorOS remote server.
 * Protocol: first message {auth: token}; then RemoteEnvelope {seq, sentAt, command}.
 * The server acks every envelope and pushes {type:"status"} updates.
 */
import type { RemoteCommand, RemoteStatus } from "@monitoros/contracts";
import { validateCommand } from "@monitoros/contracts";

export type ConnState = "connecting" | "online" | "offline" | "unauthorized";

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
  private closedByUser = false;
  private pending = new Map<number, number>(); // seq -> sentAt (for latency)
  latencyMs: number | null = null;

  constructor(
    private token: string,
    private onState: (s: ConnState) => void,
    private onStatus: (s: RemoteStatus) => void,
  ) {}

  connect() {
    this.closedByUser = false;
    this.onState("connecting");
    const url = new URL("ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    this.ws = ws;
    this.seq = 0;
    ws.onopen = () => ws.send(JSON.stringify({ auth: this.token }));
    ws.onmessage = (e) => {
      let msg: { type?: string; ok?: boolean; seq?: number; status?: RemoteStatus };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === "auth") {
        if (msg.ok) {
          this.retry = 0;
          this.onState("online");
        } else {
          this.closedByUser = true;
          this.onState("unauthorized");
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
      this.ws = null;
      if (this.closedByUser) return;
      this.onState("offline");
      // Exponential backoff, capped at 10 s.
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
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
    this.ws?.close();
  }
}
