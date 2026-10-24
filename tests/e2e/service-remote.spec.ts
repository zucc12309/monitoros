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

// Netflix-like home page: an autoplaying hero trailer above rows of title
// cards that are focusable links inside a transformed, overflow-hidden slider.
const NETFLIX_LIKE = `<!doctype html><html><body style="margin:0;background:#141414;color:#fff;font:16px sans-serif">
<div class="billboard" style="position:relative;height:56vh;overflow:hidden">
  <video id="trailer" muted autoplay loop style="width:100%;height:100%;object-fit:cover"></video>
  <button id="play" style="position:absolute;left:40px;bottom:40px">Play</button>
</div>
<div class="row" style="overflow:hidden;padding:20px 0"><div class="slider" style="display:flex;gap:8px;transform:translateX(40px)">
  ${Array.from({ length: 6 }, (_, i) => `<div class="title-card"><a href="/watch/${i}" id="card${i}" role="link" tabindex="0" aria-label="Movie ${i}" style="display:block;width:240px;height:135px;background:#444"></a></div>`).join("")}
</div></div>
<script>
  window.log = [];
  document.querySelectorAll('.title-card a').forEach(a => a.addEventListener('click', e => { e.preventDefault(); window.log.push('open:' + a.id); }));
  document.addEventListener('keydown', e => window.log.push('key:' + e.key));
  const t = document.getElementById('trailer');
  Object.defineProperty(t, 'currentTime', { get: () => 12, configurable: true });
  Object.defineProperty(t, 'paused', { get: () => false, configurable: true });
</script></body></html>`;

test("a hero trailer on the browse page doesn't steal the D-pad (Netflix home)", async ({ page }) => {
  await page.addInitScript(SCRIPT);
  await page.route("https://netflix.test/**", (r) => r.fulfill({ contentType: "text/html", body: NETFLIX_LIKE }));
  await page.goto("https://netflix.test/browse");
  await remote(page, { type: "nav", key: "down" });
  expect(await focusedId(page)).toBe("play");
  await remote(page, { type: "nav", key: "down" });
  expect(await focusedId(page)).toMatch(/^card/);
  await remote(page, { type: "nav", key: "right" });
  const id = await focusedId(page);
  await remote(page, { type: "nav", key: "ok" });
  expect(await log(page)).toEqual([`open:${id}`]); // selected a title; no stray key events
});

test("Down reaches the next row even when it's just off-screen; Left/Right stay in the row", async ({ page }) => {
  const rows = `<!doctype html><html><body style="margin:0;background:#141414">
    ${[0, 1, 2].map((r) => `<div style="display:flex;gap:10px;padding:10px;margin-bottom:${r === 0 ? 700 : 40}px">${[0, 1, 2].map((c) => `<a href="#" id="r${r}c${c}" style="display:block;width:200px;height:120px;background:#333"></a>`).join("")}</div>`).join("")}
    <p style="padding:10px"><button id="faq">FAQ</button></p></body></html>`;
  await page.addInitScript(SCRIPT);
  await page.route("https://rows.test/**", (r) => r.fulfill({ contentType: "text/html", body: rows }));
  await page.goto("https://rows.test/");
  await remote(page, { type: "nav", key: "down" });
  expect(await focusedId(page)).toBe("r0c0");
  await remote(page, { type: "nav", key: "down" }); // row 1 starts ~830px down, below a 720px viewport
  expect(await focusedId(page)).toBe("r1c0");
  await remote(page, { type: "nav", key: "right" });
  expect(await focusedId(page)).toBe("r1c1");
  await page.waitForTimeout(400); // let smooth scrolling settle
  await remote(page, { type: "nav", key: "down" });
  await remote(page, { type: "nav", key: "down" });
  expect(await focusedId(page)).toBe("faq");
  await remote(page, { type: "nav", key: "left" }); // nothing left of FAQ in its row: must not jump up
  expect(await focusedId(page)).toBe("faq");
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

// YouTube-like: search input inside a form, nothing focused on the page.
const YT_LIKE = `<!doctype html><html><body>
<form id="f" action="/results"><input id="search" name="search_query" placeholder="Search"><button id="sb" aria-label="Search">🔍</button></form>
<a href="#v1" id="v1">Video 1</a>
<script>
  window.log = [];
  document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); window.log.push('search:' + document.getElementById('search').value); });
  document.getElementById('search').addEventListener('input', e => window.log.push('input:' + e.target.value));
</script></body></html>`;

// Netflix-like: the input only exists after the magnifier is clicked; Enter searches.
const NF_LIKE = `<!doctype html><html><body>
<div id="bar"><button data-uia="search-box-launcher" id="launch" aria-label="Search">🔍</button></div>
<script>
  window.log = [];
  document.getElementById('launch').addEventListener('click', () => setTimeout(() => {
    const i = document.createElement('input');
    i.setAttribute('data-uia', 'search-box-input'); i.id = 'q';
    i.addEventListener('keydown', e => e.key === 'Enter' && window.log.push('search:' + i.value));
    document.getElementById('bar').appendChild(i);
  }, 150));
</script></body></html>`;

async function openFixture(page: Page, host: string, html: string) {
  await page.addInitScript(SCRIPT);
  await page.route(`https://${host}/**`, (r) => r.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`https://${host}/`);
}

test("typing finds the site's search box, mirrors the phone, and Send searches (YouTube-like)", async ({ page }) => {
  await openFixture(page, "yt.test", YT_LIKE);
  await remote(page, { type: "text", value: "kal" }); // nothing focused on the page yet
  await remote(page, { type: "text", value: "kalki" }); // replaces, doesn't append
  await expect(page.locator("#search")).toHaveValue("kalki");
  await remote(page, { type: "text", value: "kalki 2898", submit: true });
  await expect.poll(() => log(page)).toContain("search:kalki 2898");
  expect(await log(page)).toContain("input:kal");
});

test("typing opens a collapsed search box first (Netflix-like) and Enter searches", async ({ page }) => {
  await openFixture(page, "nf.test", NF_LIKE);
  await remote(page, { type: "nav", key: "search" });
  await expect(page.locator("#q")).toBeFocused();
  await remote(page, { type: "text", value: "stranger things", submit: true });
  await expect(page.locator("#q")).toHaveValue("stranger things");
  await expect.poll(() => log(page)).toContain("search:stranger things");
});

test("Back while browsing closes the app (even after moving between pages)", async ({ page }) => {
  await open(page);
  await page.route("https://monitoros.invalid/**", (r) => r.fulfill({ body: "closed" }));
  await page.goto("https://service.test/results?search_query=kalki");
  const closed = page.waitForRequest((r) => r.url().startsWith("https://monitoros.invalid/close"));
  await remote(page, { type: "nav", key: "back" }).catch(() => {});
  await closed;
});

test("Back on a video page returns to browsing first, then closes the app", async ({ page }) => {
  await open(page);
  await page.route("https://monitoros.invalid/**", (r) => r.fulfill({ body: "closed" }));
  await page.goto("https://service.test/watch?v=abc");
  await remote(page, { type: "nav", key: "back" }).catch(() => {}); // navigation tears down the context
  await expect(page).toHaveURL("https://service.test/");
  const closed = page.waitForRequest((r) => r.url().startsWith("https://monitoros.invalid/close"));
  await remote(page, { type: "nav", key: "back" }).catch(() => {});
  await closed;
});
