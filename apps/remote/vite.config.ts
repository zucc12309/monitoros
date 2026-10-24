import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@monitoros/contracts": fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)) } },
  base: "./",
  build: { target: "safari15", outDir: "dist", emptyOutDir: true },
});
