import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @tauri-apps/cli sets TAURI_DEV_HOST when running `tauri dev`.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port and fails if it is not available.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Tell Vite to ignore watching `src-tauri`.
      ignored: ["**/src-tauri/**"],
    },
  },
  // Produce a relative-path build so it also works opened from file:// in browser builds.
  base: "./",
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
