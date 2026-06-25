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
    // Split the heavy, independently-cacheable vendors into their own chunks so the browser can
    // parse/compile them in parallel and cache them across releases instead of re-downloading one
    // giant bundle. TipTap + ProseMirror (the editor) and framer-motion are the largest.
    rollupOptions: {
      output: {
        manualChunks: {
          editor: ["@tiptap/react", "@tiptap/starter-kit"],
          motion: ["framer-motion"],
          recurrence: ["rrule"],
        },
      },
    },
  },
});
