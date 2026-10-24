import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

// Serves the built PWA (apps/remote/dist) and replaces WebSocket with a fake
// server that records every command the phone sends.
const DIST = new URL("../../apps/remote/dist/", import.meta.url).pathname;
let server: Server;
let base = "";

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = join(DIST, req.url === "/" ? "index.html" : req.url!.split("?")[0]!);
    if (!path.startsWith(DIST) || !existsSync(path)) return res.writeHead(404).end();
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(path)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type }).end(readFileSync(path));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
test.afterAll(() => server.close());

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openRemote(page: Page, status: Record<string, unknown> = { mode: "tv" }) {
  await page.addInitScript((status) => {
    localStorage.setItem("monitoros-remote-token", "test-token");
    (window as any).sent = [];
    class FakeWS {
      static OPEN = 1;
      readyState = 0;
      onopen?: () => void;
      onmessage?: (e: { data: string }) => void;
      onclose?: () => void;
      constructor() {
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
        });
      }
      send(raw: string) {
        const msg = JSON.parse(raw);
        if (msg.auth) {
          this.onmessage?.({ data: JSON.stringify({ type: "auth", ok: true }) });
          this.onmessage?.({ data: JSON.stringify({ type: "status", status }) });
          return;
        }
        (window as any).sent.push(msg.command);
        this.onmessage?.({ data: JSON.stringify({ type: "ack", seq: msg.seq, ok: true }) });
      }
      close() {}
    }
    (window as any).WebSocket = FakeWS;
  }, status);
  await page.goto(base);
  await expect(page.getByText("Connected")).toBeVisible();
}

/** Drives real TouchEvents through the pad: fingers is a list of [x,y] paths. */
async function gesture(page: Page, paths: [number, number][][]) {
  await page.evaluate(async (paths) => {
    const pad = document.getElementById("pad")!;
    const r = pad.getBoundingClientRect();
    const mk = (step: number) =>
      paths.map((p, id) => new Touch({ identifier: id, target: pad, clientX: r.left + p[Math.min(step, p.length - 1)]![0], clientY: r.top + p[Math.min(step, p.length - 1)]![1] }));
    const fire = (type: string, touches: Touch[]) => pad.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : touches, changedTouches: touches, bubbles: true, cancelable: true }));
    fire("touchstart", mk(0));
    const steps = Math.max(...paths.map((p) => p.length));
    for (let s = 1; s < steps; s++) {
      fire("touchmove", mk(s));
      await new Promise((r) => setTimeout(r, 16));
    }
    fire("touchend", mk(steps - 1));
    await new Promise((r) => setTimeout(r, 120));
  }, paths);
}

const sent = (page: Page) => page.evaluate(() => (window as any).sent as { type: string; [k: string]: unknown }[]);

test("streaming app open → touchpad becomes a mouse: move, tap-click, two-finger scroll", async ({ page }) => {
  await openRemote(page, { mode: "tv", service: { open: true, control: "page" } });
  await expect(page.getByRole("button", { name: "Mouse ✓" })).toBeVisible();

  await gesture(page, [[[100, 80], [120, 90], [140, 100], [160, 110]]]);
  let cmds = await sent(page);
  const moves = cmds.filter((c) => c.type === "pointer" && !c.click);
  expect(moves.reduce((a, c) => a + (c.dx as number), 0)).toBe(60);
  expect(moves.reduce((a, c) => a + (c.dy as number), 0)).toBe(30);
  expect(cmds.some((c) => c.click)).toBe(false); // a drag is not a click

  await gesture(page, [[[150, 80]]]); // tap
  cmds = await sent(page);
  expect(cmds.at(-1)).toEqual({ type: "pointer", dx: 0, dy: 0, click: true });

  await gesture(page, [
    [[100, 120], [100, 100], [100, 80]],
    [[160, 120], [160, 100], [160, 80]],
  ]); // two fingers up
  cmds = await sent(page);
  const scrolls = cmds.filter((c) => c.type === "scroll");
  expect(scrolls.reduce((a, c) => a + (c.dy as number), 0)).toBe(-40);
  expect(cmds.filter((c) => c.click)).toHaveLength(1); // two-finger gesture didn't click
});

test("in MonitorOS the touchpad swipes like a TV remote, and the Mouse toggle switches it", async ({ page }) => {
  await openRemote(page);
  await gesture(page, [[[100, 80], [160, 80]]]); // swipe right
  await gesture(page, [[[150, 80]]]); // tap
  expect((await sent(page)).slice(-2)).toEqual([{ type: "nav", key: "right" }, { type: "nav", key: "ok" }]);

  await page.getByRole("button", { name: "Swipe ✓" }).click();
  await expect(page.getByRole("button", { name: "Mouse ✓" })).toBeVisible();
  await gesture(page, [[[100, 80], [110, 85]]]);
  expect((await sent(page)).at(-1)).toMatchObject({ type: "pointer", dx: 10, dy: 5 });
});

test("tells the user how to allow mouse control when macOS permission is missing", async ({ page }) => {
  await openRemote(page, { mode: "tv", service: { open: true }, mouse: "needs-permission" });
  await expect(page.getByText(/Privacy & Security › Accessibility/)).toBeVisible();
});

test("any other app in front → touchpad is the mouse and the phone says what it controls", async ({ page }) => {
  await openRemote(page, { mode: "desktop", control: "system" });
  await expect(page.getByRole("button", { name: "Mouse ✓" })).toBeVisible();
  await expect(page.getByText("Controlling the app in front · Home returns to MonitorOS")).toBeVisible();
});

test("MonitorOS in front → swipe mode", async ({ page }) => {
  await openRemote(page, { mode: "tv", control: "monitoros", service: { open: false } });
  await expect(page.getByRole("button", { name: "Swipe ✓" })).toBeVisible();
});

test("Full screen button sends the fullscreen command", async ({ page }) => {
  await openRemote(page);
  await page.getByRole("button", { name: "Full screen" }).click();
  expect((await sent(page)).at(-1)).toEqual({ type: "fullscreen" });
});
