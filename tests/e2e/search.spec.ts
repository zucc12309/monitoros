import { expect, test } from "@playwright/test";

// Fake Cinemeta search responses so the test is deterministic.
const meta = (id: string, name: string, year: string) => ({ id, imdb_id: id, type: "series", name, releaseInfo: year });
const RESULTS: Record<string, unknown[]> = {
  big: [meta("tt0898266", "The Big Bang Theory", "2007"), meta("tt6524350", "Big Mouth", "2017"), meta("tt10731256", "Big Sky", "2020")],
  "big boss": [meta("tt1062187", "Big Boss", "2000-2020"), meta("tt6524350", "Big Mouth", "2017")],
  "bigg boss": [meta("tt1281973", "Bigg Boss", "2006-"), meta("tt7805494", "Bigg Boss Telugu", "2017-")],
};

test("results always match the latest text, and spelling variants are found", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("monitoros:settings", JSON.stringify({ onboarded: true, defaultMode: "desktop", settingsVersion: 2 })));
  await page.route("https://v3-cinemeta.strem.io/catalog/**", async (route) => {
    const url = decodeURIComponent(route.request().url());
    const q = /search=([^/.]+)\.json/.exec(url)?.[1]?.toLowerCase() ?? "";
    const type = url.includes("/catalog/movie/") ? "movie" : "series";
    // The partial query is slow, so it would finish last without the fix.
    if (q === "big") await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ json: { metas: type === "series" ? (RESULTS[q] ?? []) : [] } });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your Apps" })).toBeVisible();
  await page.keyboard.press("/");
  const box = page.getByRole("textbox", { name: "Search" });
  await box.fill("big");
  await page.waitForTimeout(450); // let the "big" search start
  await box.fill("big boss");
  await page.waitForTimeout(3500); // past the slow "big" response
  const titles = await page.locator('[data-nav-row^="search-results"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(titles.slice(0, 3).sort()).toEqual(["Big Boss", "Bigg Boss", "Bigg Boss Telugu"]);
  expect(titles).not.toContain("The Big Bang Theory"); // stale "big" results never replaced these
});
