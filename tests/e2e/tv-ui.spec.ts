import { expect, test, type Page } from "@playwright/test";

async function skipOnboarding(page: Page, extra: Record<string, unknown> = {}) {
  await page.addInitScript((extra) => {
    localStorage.setItem(
      "monitoros:settings",
      JSON.stringify({ onboarded: true, defaultMode: "desktop", subscriptions: ["netflix", "prime"], serviceOpenMode: "browser", ...extra }),
    );
  }, extra);
}

const focusedText = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");

test("first run shows onboarding and it can be completed by keyboard only", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to MonitorOS" })).toBeVisible();
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press("Enter");
  }
  await expect(page.getByRole("button", { name: "Watch Now" })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("monitoros:settings")!));
  expect(saved.onboarded).toBe(true);
});

test("home screen rows render and arrow keys move focus deterministically", async ({ page }) => {
  await skipOnboarding(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your Apps" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Trending Movies in India" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Netflix" })).toBeVisible();
  // All apps are on the home row, subscribed ones first (netflix, prime here).
  const tiles = await page.locator('[data-nav-row="row-apps"][aria-label^="Open "]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(tiles.length).toBe(10);
  expect(tiles.slice(0, 2)).toEqual(["Open Netflix", "Open Prime Video"]);

  const navRow = () => page.evaluate(() => (document.activeElement as HTMLElement).dataset.navRow);
  await expect.poll(() => focusedText(page)).toContain("Watch Now"); // default focus
  await page.keyboard.press("ArrowDown");
  expect(await navRow()).toBe("row-apps");
  await page.keyboard.press("ArrowUp");
  expect(await focusedText(page)).toContain("Watch Now"); // column memory per row
  await page.keyboard.press("ArrowDown");
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowLeft"); // row start → side rail
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.navRow)).toBe("rail");
});

test("opening a subscription service hands off to the official site", async ({ page, context }) => {
  await skipOnboarding(page);
  await page.goto("/");
  const popup = context.waitForEvent("page");
  await page.getByRole("button", { name: "Open Netflix" }).click();
  const p = await popup;
  // Only check where it went; don't wait for netflix.com to load.
  await expect.poll(() => p.url()).toMatch(/^https:\/\/www\.netflix\.com\//);
  await p.close();
});

test("search finds a title and opens its detail page", async ({ page }) => {
  await skipOnboarding(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your Apps" })).toBeVisible();
  await page.keyboard.press("/");
  await page.getByRole("textbox", { name: "Search" }).fill("RRR");
  await expect(page.getByRole("button", { name: "RRR" }).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "RRR" }).first().click();
  await expect(page.getByRole("heading", { name: "Where to watch" })).toBeVisible();
  await expect(page.getByText("Availability unknown")).toBeVisible();
});

test("an authorised public-domain film plays in the in-app player and saves progress", async ({ page }) => {
  await skipOnboarding(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Free", exact: true }).click();
  const film = page.getByRole("button", { name: "His Girl Friday" }).first();
  await film.click();
  await page.getByRole("button", { name: "Play" }).click();
  // (waitForFunction uses eval, which the app's CSP correctly forbids.)
  await expect
    .poll(() => page.evaluate(() => document.querySelector("video")?.currentTime ?? 0), { timeout: 30_000 })
    .toBeGreaterThan(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("video")).toHaveCount(0);
  const progress = await page.evaluate(() => JSON.parse(localStorage.getItem("monitoros:progress") ?? "[]"));
  expect(progress[0]?.title).toBe("His Girl Friday");
  expect(progress[0]?.durationSec).toBeGreaterThan(3000);
});
