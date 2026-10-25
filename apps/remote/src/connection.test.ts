import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_TIMEOUT_MS, RETRY_MAX_MS, RemoteConnection, type ConnState } from "./connection";

/** Minimal stand-in for the browser WebSocket the remote uses. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: URL) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  /** Server accepts the token. */
  accept() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "auth", ok: true, deviceId: "dev-1" }) });
  }
}

const latest = () => FakeSocket.all[FakeSocket.all.length - 1]!;

describe("RemoteConnection", () => {
  let states: ConnState[];
  let conn: RemoteConnection;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", new URL("http://192.168.1.20:47815/remote/"));
    states = [];
    conn = new RemoteConnection("tok", (s) => states.push(s), () => {});
  });
  afterEach(() => {
    conn.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects to the same host and authenticates", () => {
    conn.connect();
    expect(latest().url.href).toBe("ws://192.168.1.20:47815/remote/ws");
    latest().accept();
    expect(latest().sent[0]).toBe(JSON.stringify({ auth: "tok" }));
    expect(conn.state).toBe("online");
    expect(conn.deviceId).toBe("dev-1");
  });

  it("gives up on a socket stuck connecting and retries quickly", () => {
    conn.connect();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);
    expect(conn.state).toBe("offline");
    vi.advanceTimersByTime(300);
    expect(FakeSocket.all).toHaveLength(2);
    latest().accept();
    expect(conn.state).toBe("online");
  });

  it("caps the retry wait at a couple of seconds", () => {
    conn.connect();
    for (let i = 0; i < 10; i++) latest().close(); // server keeps refusing
    const before = FakeSocket.all.length;
    vi.advanceTimersByTime(RETRY_MAX_MS);
    expect(FakeSocket.all.length).toBe(before + 1);
  });

  it("reconnects at once when asked, without waiting for the timer", () => {
    conn.connect();
    for (let i = 0; i < 6; i++) {
      latest().close();
      vi.advanceTimersByTime(RETRY_MAX_MS);
    }
    latest().close(); // now waiting on a retry timer
    const before = FakeSocket.all.length;
    conn.reconnectNow();
    expect(FakeSocket.all.length).toBe(before + 1);
    latest().accept();
    expect(conn.state).toBe("online");
  });

  it("keeps a healthy socket, but replaces a stale one", () => {
    conn.connect();
    latest().accept();
    conn.reconnectNow();
    expect(FakeSocket.all).toHaveLength(1);
    conn.reconnectNow(true);
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[0]!.readyState).toBe(FakeSocket.CLOSED);
    // The old socket closing must not schedule a second reconnect.
    vi.advanceTimersByTime(RETRY_MAX_MS * 2);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("stops after the TV rejects the token", () => {
    conn.connect();
    latest().readyState = FakeSocket.OPEN;
    latest().onmessage?.({ data: JSON.stringify({ type: "auth", ok: false }) });
    latest().close();
    vi.advanceTimersByTime(RETRY_MAX_MS * 4);
    conn.reconnectNow(true);
    expect(FakeSocket.all).toHaveLength(1);
    expect(states.at(-1)).toBe("unauthorized");
  });
});
