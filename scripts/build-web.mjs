// Combined web build for a single Vercel deploy:
//   dist-combined/        <- the marketing site (website/), served at /
//   dist-combined/app/    <- the browser app (repo root), served at /app/
//
// Both are separate Vite projects. We build each, then copy their dist output into
// one folder so Vercel can serve the whole thing from a single Output Directory.
// Runs the same on Windows (local) and Linux (Vercel) — pure Node, no shell tricks.

import { execSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-combined");

const run = (cmd, opts = {}) =>
  execSync(cmd, { cwd: root, stdio: "inherit", ...opts });

// Start clean so removed files never linger in the deployed output.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Marketing site -> dist-combined/ (served at /)
console.log("\n[build-web] building marketing site (website/)…");
run("npm run build", { cwd: join(root, "website") });
cpSync(join(root, "website", "dist"), out, { recursive: true });

// 2. Browser app -> dist-combined/app/ (served at /app/)
// VITE_WEB_BASE makes the app's asset URLs absolute from /app/ (see vite.config.ts).
console.log("\n[build-web] building browser app (root) with base /app/ …");
run("npm run build", { env: { ...process.env, VITE_WEB_BASE: "/app/" } });
cpSync(join(root, "dist"), join(out, "app"), { recursive: true });

if (!existsSync(join(out, "index.html")) || !existsSync(join(out, "app", "index.html"))) {
  throw new Error("[build-web] expected index.html in both dist-combined/ and dist-combined/app/");
}
console.log("\n[build-web] done -> dist-combined/ (site at /, app at /app)");
