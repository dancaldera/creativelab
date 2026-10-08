import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Tauri drives the dev server; the webview must be able to reach it on a fixed port.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The webview must resolve core's *isomorphic* entry point: the main barrel
      // re-exports node:fs/node:sqlite modules that cannot be bundled for a browser.
      "@creativelab/core": fileURLToPath(new URL("../../packages/core/src/browser.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 5273,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5274 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "safari15",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    outDir: "dist",
  },
});
