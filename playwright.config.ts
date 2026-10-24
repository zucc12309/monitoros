import { defineConfig } from "@playwright/test";

// E2E against the desktop UI in a browser (no Tauri). Native-only paths
// (mpv, remote server, display/audio) are covered by Rust tests instead.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  // Branded Chrome: Playwright's bundled Chromium ships without H.264/AAC,
  // so real MP4 playback can't be tested with it.
  use: { baseURL: "http://127.0.0.1:1420", viewport: { width: 1920, height: 1080 }, channel: "chrome" },
  webServer: { command: "npm run dev", url: "http://127.0.0.1:1420", reuseExistingServer: true, timeout: 60_000 },
});
