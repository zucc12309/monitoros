import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (n: string) => fileURLToPath(new URL(`./packages/${n}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(["contracts", "provider-sdk", "metadata", "player"].map((n) => [`@monitoros/${n}`, pkg(n)])),
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}", "tests/{integration,security}/**/*.test.ts"],
    environment: "node",
    environmentMatchGlobs: [["apps/desktop/src/**", "jsdom"]],
  },
});
