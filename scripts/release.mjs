// One-command release: bump the version everywhere, commit, tag, and push.
// CI (.github/workflows/release.yml) then builds the signed installer + latest.json
// and creates the GitHub release.
//
//   npm run release            # patch: 0.1.0 -> 0.1.1
//   npm run release minor      # 0.1.0 -> 0.2.0
//   npm run release major      # 0.1.0 -> 1.0.0
//   npm run release 1.4.2      # set an exact version
//
// Keeps package.json, src-tauri/tauri.conf.json, and src-tauri/Cargo.toml in lockstep
// so the release tag and the installer filename always match.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "pipe" }).toString().trim();

// --- Refuse to release from a dirty tree (the bump must be the only change). ---
if (run("git status --porcelain")) {
  console.error("✖ Working tree has uncommitted changes. Commit or stash them first.");
  process.exit(1);
}

// --- Work out the next version from the current package.json. ---
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);

const bump = (process.argv[2] || "patch").toLowerCase();
let next;
if (bump === "patch") next = `${maj}.${min}.${pat + 1}`;
else if (bump === "minor") next = `${maj}.${min + 1}.0`;
else if (bump === "major") next = `${maj + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
else {
  console.error(`✖ Unknown bump "${bump}". Use patch | minor | major | X.Y.Z`);
  process.exit(1);
}

console.log(`Releasing ${pkg.version} → ${next}`);

// --- Patch the three version sources. ---
// package.json
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// src-tauri/tauri.conf.json
const confPath = join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = next;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

// src-tauri/Cargo.toml — only the [package] version on line `version = "..."`.
const cargoPath = join(root, "src-tauri", "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8").replace(
  /^version = "\d+\.\d+\.\d+"/m,
  `version = "${next}"`
);
writeFileSync(cargoPath, cargo);

// --- Commit, tag, push (commit + tag so the tag carries the version bump). ---
const tag = `v${next}`;
run(`git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml`);
run(`git commit -m "release: ${tag}"`);
run(`git tag ${tag}`);
run(`git push origin HEAD`);
run(`git push origin ${tag}`);

console.log(`✔ Pushed ${tag}. CI is building the release now:`);
console.log(`  https://github.com/joaorobra/Pinpoint/actions`);
