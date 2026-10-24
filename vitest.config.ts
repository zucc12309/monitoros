import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (n: string) => fileURLToPath(new URL(`./packages/${n}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(["contracts", "provider-sdk", "metadata", "player"].map((n) => [`@monitoros/${n}`, pkg(n)])),
  },
  test: {
    projects: [
      { extends: true, test: { name: "node", environment: "node", include: ["packages/*/src/**/*.test.ts", "apps/remote/src/**/*.test.{ts,tsx}", "tests/{integration,security}/**/*.test.ts"] } },
      { extends: true, test: { name: "desktop", environment: "jsdom", include: ["apps/desktop/src/**/*.test.{ts,tsx}"] } },
    ],
  },
});
