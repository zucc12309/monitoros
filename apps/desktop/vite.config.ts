import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const pkg = (n: string) => fileURLToPath(new URL(`../../packages/${n}/src/index.ts`, import.meta.url));

// Tauri expects a fixed port and no clearing of its output.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: Object.fromEntries(["contracts", "provider-sdk", "metadata", "player"].map((n) => [`@monitoros/${n}`, pkg(n)])),
  },
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "safari15", sourcemap: false, chunkSizeWarningLimit: 900 },
});
