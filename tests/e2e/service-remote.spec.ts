import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// The exact script MonitorOS injects into in-app service windows.
const SCRIPT = readFileSync(new URL("../../apps/desktop/src-tauri/src/service_remote.js", import.meta.url), "utf8");

// A stand-in for a streaming site: a grid of title cards and a player whose
// controls respond to keydown (like Netflix/YouTube web players).
const FIXTURE = `<!doctype html><html><body style="margin:0;background:#111;color:#fff;font:16px sans-serif">
<input id="search" type="search" placeholder="Search" style="margin:20px">
<div id="grid" style="display:grid;grid-template-columns:repeat(4,200px);gap:20px;padding:20px">
  ${Array.from({ length: 8 }, (_, i) => `<a href="#t${i}" id="t${i}" style="display:block;height:110px;background:#333">Title ${i}</a>`).join("")}
</div>
<div id="player" style="display:none;position:fixed;inset:0">
  <video id="v" muted style="width:100%;height:100%" src="data:video/mp4;base64,"></video>
</div>
<script>
  window.log = [];
  document.querySelectorAll('#grid a').forEach(a => a.addEventListener('click', e => { e.preventDefault(); window.log.push('open:' + a.id); }));
  document.addEventListener('keydown', e => window.log.push('key:' + e.key + ':' + e.keyCode));
  // Simulate an active player without needing a decodable file.
  window.startPlayer = () => {
    document.getElementById('player').style.display = 'block';
    const v = document.getElementById('v');
    Object.defineProperty(v, 'currentTime', { get: () => 42, configurable: true });
  };
</script></body></html>`;

async function open(page: Page) {
  await page.addInitScript(SCRIPT);
  await page.route("https://service.test/**", (r) => r.fulfill({ contentType: "text/html", body: FIXTURE }));
  await page.goto("https://service.test/");
}

const remote = (page: Page, cmd: unknown) => page.evaluate((c) => (window as any).__monitorosRemote(c), cmd);
const focusedId = (page: Page) => page.evaluate(() => document.querySelector(".__mo-focus")?.id ?? null);
const log = (page: Page) => page.evaluate(() => (window as any).log as string[]);

test.use({ viewport: { width: 1280, height: 720 } });

test("D-pad moves a visible focus across the site's own tiles and OK opens one", async ({ page }) => {
  await open(page);
  await remote(page, { type: "nav", key: "down" }); // first focus: top-left item
  expect(await focusedId(page)).toBe("search");
  await remote(page, { type: "nav", key: "down" });
  expect(await focusedId(page)).toBe("t0");
  await remote(page, { type: "nav", key: "right" });
  await remote(page, { type: "nav", key: "right" });
  expect(await focusedId(page)).toBe("t2");
  await remote(page, { type: "nav", key: "down" });
  expect(await focusedId(page)).toBe("t6");
  await remote(page, { type: "nav", key: "ok" });
  expect(await log(page)).toContain("open:t6");
});

test("during playback, arrows/OK/play-pause/seek go to the player as keys", async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as any).startPlayer());
  await remote(page, { type: "nav", key: "right" });
  await remote(page, { type: "media", action: "play-pause" });
  await remote(page, { type: "seek", deltaSec: -30 });
  const keys = (await log(page)).filter((l) => l.startsWith("key:"));
  expect(keys).toEqual(["key:ArrowRight:39", "key: :32", "key:ArrowLeft:37", "key:ArrowLeft:37", "key:ArrowLeft:37"]);
});

test("touchpad cursor moves and clicks whatever is under it", async ({ page }) => {
  await open(page);
  // Cursor starts at the centre (640,360); move it onto Title 1 (~330,190 incl. search row).
  await remote(page, { type: "pointer", dx: -190, dy: -110 });
  await expect(page.locator("#__mo_cursor")).toBeVisible();
  const box = await page.locator("#__mo_cursor").boundingBox();
  const target = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.id, [box!.x + 13, box!.y + 13]);
  await remote(page, { type: "pointer", dx: 0, dy: 0, click: true });
  expect(await log(page)).toContain(`open:${target}`);
});

test("typed text from the phone lands in the focused search box", async ({ page }) => {
  await open(page);
  await remote(page, { type: "nav", key: "down" }); // focus search
  await remote(page, { type: "text", value: "Kalki" });
  await expect(page.locator("#search")).toHaveValue("Kalki");
});

test("Back goes back inside the service, and from its first page returns to MonitorOS", async ({ page }) => {
  await open(page);
  await page.route("https://monitoros.invalid/**", (r) => r.fulfill({ body: "closed" }));
  await page.goto("https://service.test/title/42");
  await remote(page, { type: "nav", key: "back" }).catch(() => {}); // navigation tears down the context
  await expect(page).toHaveURL("https://service.test/");
  const closed = page.waitForRequest((r) => r.url().startsWith("https://monitoros.invalid/close"));
  await remote(page, { type: "nav", key: "back" }).catch(() => {});
  await closed;
});
