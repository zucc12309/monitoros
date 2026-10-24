import { expect, test, type Page } from "@playwright/test";

// Every focusable item on every screen must be reachable with the D-pad
// alone, starting from where focus lands when the screen opens.

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("monitoros:settings", JSON.stringify({ onboarded: true, defaultMode: "desktop", subscriptions: ["netflix"], settingsVersion: 2 }));
    localStorage.setItem("monitoros:watchlist", JSON.stringify([]));
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your Apps" })).toBeVisible();
}

/**
 * BFS over the focus graph using the app's real key handling. Items are
 * tracked by label because some focus moves re-render content (e.g. moving
 * through the Settings menu shows that section).
 */
async function audit(page: Page) {
  return page.evaluate(async () => {
    const current = () =>
      [...document.querySelectorAll<HTMLElement>("[data-nav-row]")].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !e.hasAttribute("disabled") && getComputedStyle(e).visibility !== "hidden";
      });
    const label = (e: HTMLElement) =>
      (e.getAttribute("aria-label") || e.innerText || (e as HTMLInputElement).placeholder || e.tagName).trim().replace(/\s+/g, " ").slice(0, 40) + ` [${e.dataset.navRow}]`;
    const find = (l: string) => current().find((e) => label(e) === l);
    const press = (key: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    const tick = () => new Promise((r) => setTimeout(r, 30));
    const centre = (e: HTMLElement) => {
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    // Pages swap the built-in list for the live catalogue: wait until stable.
    // Require 3 s without changes (slow networks deliver the catalogue late).
    let initial = current().map(label);
    for (let i = 0, still = 0; i < 60 && still < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const now = current().map(label);
      still = now.join("|") === initial.join("|") ? still + 1 : 0;
      initial = now;
    }

    let start = document.activeElement as HTMLElement;
    if (!start?.dataset?.navRow) {
      press("ArrowDown");
      await tick();
      start = document.activeElement as HTMLElement;
    }
    if (!start?.dataset?.navRow) return { total: initial.length, start: "none", unreachable: initial, wrongWay: [] };
    const startLabel = label(start);
    const seen = new Set([startLabel]);
    const queue = [startLabel];
    const wrongWay: string[] = [];
    while (queue.length) {
      const from = queue.shift()!;
      for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
        let el = find(from);
        if (!el) {
          // Focus-driven content (Settings sections): return to the start item
          // so its content is showing again, then look up the item.
          find(startLabel)?.focus();
          await tick();
          el = find(from);
        }
        if (!el) break;
        el.focus({ preventScroll: true });
        await tick(); // let focus-driven re-renders settle
        const again = find(from) ?? el;
        again.focus({ preventScroll: true });
        const a = centre(again);
        press(key);
        await tick();
        const to = document.activeElement as HTMLElement;
        if (!to?.dataset?.navRow || to === again) continue;
        const l = label(to);
        // Every press must move focus the way the arrow points.
        const b = centre(to);
        const ok = key === "ArrowUp" ? b.y < a.y : key === "ArrowDown" ? b.y > a.y : key === "ArrowLeft" ? b.x < a.x : b.x > a.x;
        if (!ok) wrongWay.push(`${from} --${key.replace("Arrow", "")}--> ${l}`);
        if (!seen.has(l)) {
          seen.add(l);
          queue.push(l);
        }
      }
    }
    return { total: initial.length, start: startLabel, unreachable: initial.filter((l) => !seen.has(l)), wrongWay: [...new Set(wrongWay)] };
  });
}

const SCREENS: [string, (p: Page) => Promise<void>][] = [
  ["Home", async () => {}],
  ["Movies", (p) => p.getByRole("button", { name: "Movies", exact: true }).click()],
  ["Series", (p) => p.getByRole("button", { name: "Series", exact: true }).click()],
  ["Anime", (p) => p.getByRole("button", { name: "Anime", exact: true }).click()],
  ["Live TV", (p) => p.getByRole("button", { name: "Live TV", exact: true }).first().click()],
  ["Apps", (p) => p.getByRole("button", { name: "Apps", exact: true }).first().click()],
  ["Free", (p) => p.getByRole("button", { name: "Free", exact: true }).click()],
  ["Search results", async (p) => {
    await p.keyboard.press("/");
    await p.getByRole("textbox", { name: "Search" }).fill("dune");
    await expect(p.getByRole("button", { name: /Dune/ }).first()).toBeVisible({ timeout: 15000 });
    await p.locator("body").click({ position: { x: 5, y: 5 } });
  }],
  ["Detail", (p) => p.getByRole("button", { name: /^Oppenheimer/ }).first().click()],
  ...(["Subscriptions", "Add-ons", "Display & Audio", "iPhone Remote", "Playback", "Startup & Mode", "Diagnostics"].map((s) => [
    `Settings › ${s}`,
    async (p: Page) => {
      await p.getByRole("button", { name: "Settings" }).click();
      await p.getByRole("button", { name: s, exact: true }).click();
    },
  ]) as [string, (p: Page) => Promise<void>][]),
];

for (const [w, h] of [[1920, 1080], [1280, 800]] as const) {
  test.describe(`${w}×${h}`, () => {
    test.use({ viewport: { width: w, height: h } });
    for (const [name, open] of SCREENS) {
      test(`D-pad reaches everything and moves the right way: ${name}`, async ({ page }) => {
        await setup(page);
        await open(page);
        await page.waitForTimeout(1200); // artwork/metadata settle
        const r = await audit(page);
        expect(r.unreachable, `unreachable from start=${r.start}; ${r.total} items`).toEqual([]);
        expect(r.wrongWay, "presses that moved focus the wrong way").toEqual([]);
      });
    }
  });
}
