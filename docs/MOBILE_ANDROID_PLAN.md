# PINPOINT — Android Mobile Version Plan

> Goal: ship a working Android **APK** (and later AAB for Play Store) of PINPOINT, reusing the existing Tauri 2 + React + Rust codebase. Single shared frontend, single shared Rust core, with mobile-specific storage + touch UI added.

Status of repo at planning time: `v0.4.0`, Tauri 2, React 18 + TipTap, Rust backend with 43 `#[tauri::command]`s, SQLite index, encryption-at-rest. **The backend is already mobile-aware**: `#[cfg_attr(mobile, tauri::mobile_entry_point)]` is present on `run()` ([lib.rs](../src-tauri/src/lib.rs)), the updater is `cfg`-gated off for android/ios ([Cargo.toml](../src-tauri/Cargo.toml#L23)), `crate-type` includes `cdylib`, and crypto is pure Rust (argon2 / chacha20poly1305 / zeroize / getrandom) — all cross-compile to `aarch64-linux-android` cleanly.

---

## 1. The two real problems (everything else is plumbing)

### Problem A — Storage (the hard architectural decision)
Android apps are sandboxed. There is **no arbitrary `PathBuf` filesystem**. Two facts from research:
- Tauri's built-in `fs` plugin on Android can only reach **app-private dirs** (`AppData`, `AppLocalData`, `AppCache`, …). `std::fs` + `walkdir` work *only inside those dirs*.
- The only OS folder picker (`ACTION_OPEN_DOCUMENT_TREE`) returns an **opaque SAF content URI**, not a path. You cannot `std::fs::read_dir` a content URI. ([tracking issue](https://github.com/tauri-apps/tauri/issues/14587))

Current code assumes an absolute vault root everywhere: `vault.rs build_tree()` (`read_dir`), `iter_markdown()` (`WalkDir`), `index.rs open()` (`Connection::open(dir.join("index.sqlite"))`), settings/recents/lock/themes all do path-based I/O.

**Decision — two-tier rollout (recommended):**
- **MVP (Tier 1): app-owned vault.** The vault lives in the app's private external dir (`AppLocalData`, e.g. `/Android/data/com.pinpoint.app/files/vaults/<name>`). Then **`std::fs`, `walkdir`, `rusqlite`, the whole existing Rust core works UNCHANGED** — we only change *how the root path is obtained* (from the OS-provided app-data dir, not a desktop folder dialog). This is the 80/20: full feature parity, zero rewrite of vault/index/query/lock logic. Trade-off: the vault is reachable by the user only via OS file managers / USB / the app's own export; on uninstall, Android wipes app-private data (so we add explicit export + onboarding warning).
- **Tier 2 (post-MVP): user-chosen folder via SAF**, so a vault on the SD card or synced (e.g. a Drive/Dropbox folder) can be opened — matches desktop's "point at your own synced folder" model. Implemented with [`tauri-plugin-android-fs`](https://github.com/aiueo13/tauri-plugin-android-fs) (v8+, handles the dual-URI SAF model). This requires a **`PathBuf`→URI abstraction** in the Rust core (see §5).

> Recommendation: **build Tier 1 first, ship an APK, then layer Tier 2.** Do not block the first APK on SAF.

### Problem B — Touch UI (the bulk of the visible work)
Mobile-readiness today is ~40–50%. **Already present** (good foundation): `useViewport` (breakpoints 639/959, `isTouch`), `useSwipeNav` (pane swiping, scroll-aware, modal-aware), `MobileNavbar.tsx`, drawer overlays + scrim, breadcrumb, safe-area insets, whole-UI CSS `zoom`, 19 `@media` queries, haptics.

**Gaps** (desktop-only interactions): right-click context menus (no long-press), hover-revealed affordances (format toolbar, line-drag grip — 160+ hover rules), HTML5 drag-and-drop (file tree reparent, line reorder, image move), command-palette trigger (Cmd+K has no touch entry), inline DB cell editing.

---

## 2. Prerequisites / toolchain (one-time)
User reports Android dev tools are installed — verify:
- Android Studio + SDK, **NDK r28+** (r28 auto-satisfies Google's 16 KB page-alignment mandate for new submissions).
- Env vars: `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME`.
- Rust targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`.
- Remember the project's PATH gotcha: prepend `~/.cargo/bin` (see memory `cargo-path-fix`).
- `npm run tauri android init` (scaffolds `src-tauri/gen/android/` Gradle project).

Build loop: `tauri android dev` (emulator/device) → `tauri android build --apk` (testing APK) → later `tauri android build` (AAB for Play). Outputs under `src-tauri/gen/android/app/build/outputs/`.

---

## 3. Phased implementation plan

### Phase 0 — Project bootstrap & "hello APK" (smallest end-to-end loop)
1. `tauri android init`; commit the generated `gen/android/` (review `.gitignore` — keep source, ignore build outputs).
2. Set Android bits in [tauri.conf.json](../src-tauri/tauri.conf.json): app `identifier` is already `com.pinpoint.app` ✓. Add a `bundle.android` block, `minSdkVersion` (24+), and Android icons (generate from existing logo — reuse the icon pipeline noted in memory `icon-system`).
3. Confirm the Rust core compiles for `aarch64-linux-android` (no source change yet — just `cargo build --target`). Fix any crate that fails to cross-compile (none expected; crypto + rusqlite-bundled are known-good).
4. Get the **existing desktop UI** to launch in the Android webview unmodified and prove IPC works (e.g. `get_settings`). **Do not fix storage yet** — just confirm the bridge is alive.
**Exit:** an APK installs and boots to the app shell on a device/emulator.

### Phase 1 — Storage Tier 1 (app-owned vaults) → first *useful* APK
Make vaults real without touching vault/index/query/lock internals.
1. **Resolve vault root from app-data dir on mobile.** Add a small platform shim: on mobile, vaults live under `app_handle.path().app_local_data_dir()? / "vaults" / <name>`. Desktop path-picking flow is untouched.
2. **Frontend `api.ts` mobile branch.** Today selection is `isTauri() ? tauriApi : webApi`. On Android `isTauri()` is **true** (it's a Tauri webview), so it already routes to `tauriApi`/`invoke` — good. The only divergences:
   - `pickVaultFolder()` / `canOpenVault()`: on mobile, replace the desktop directory dialog with a **"create / pick from app vaults" UI** (list existing app-owned vaults + "New vault" name prompt). Add `isMobile` detection (reuse `useViewport` or a platform check).
   - `listRecentVaults()` / `resolveRecentVault()`: keep using the Rust `recents` store (it writes to app-config dir, which is valid on Android).
3. **New/adjusted Rust commands** for the app-owned model: `list_app_vaults()`, `create_app_vault(name)`, `open_app_vault(name)` (thin wrappers that compute the app-data path then call existing `open_vault` logic). Keep `open_vault(path)` for desktop.
4. **File watcher:** `notify` does not work reliably on Android. `#[cfg(not(target_os = "android"))]`-gate the watcher setup in `lib.rs`; on mobile rely on (a) explicit save→refresh and (b) re-scan on app `resume`. Add a manual "refresh" affordance.
5. **Onboarding + export safety:** first-run screen explaining app-owned storage and the uninstall-wipes-data caveat; wire an "Export vault (zip)" action. (Tier 2/SAF later removes this limitation.)
**Exit:** create a vault, make pages/databases, search, query, tasks, tags, lock/unlock — all working on-device, persisted across app restarts.

### Phase 2 — Touch UX pass (make it feel native)
Priority order by effort-vs-impact (from the UI audit):
1. **Command palette trigger (Low):** FAB or `MobileNavbar` button opens the existing Cmd+K palette. Highest leverage — palette is the keyboard-free escape hatch for every action.
2. **Long-press context menus (Med):** add a touch long-press (pointer + timer) that fires the existing `onContextMenu(node,x,y)` path for file tree, editor blocks, DB rows. One shared `useLongPress` hook.
3. **Hover → always-visible / tap (High):** format toolbar shown persistently (or on selection) on touch; line-drag grip becomes an explicit tap-target or moves into the long-press menu. Audit the 160+ hover rules; gate hover-only styling behind `@media (hover: hover)`.
4. **Drag-and-drop → pointer/modal (High):** replace HTML5 DnD in FileTree (reparent), Editor (line reorder), ImageNode (move) with Pointer-events drag *or* a "Move to…" modal picker. Modal is cheaper and often better on touch — recommend modal-first.
5. **Tab management:** close/switch via `MobileNavbar` + swipe-to-close (swipe infra already exists).
6. **DB inline edit → popover sheets:** card layout already exists on mobile; make cell edits open a bottom-sheet editor instead of inline.
7. **Keyboard niceties:** virtual-keyboard-aware insets (`env(keyboard-inset-height)` / visualViewport), ensure caret stays visible in TipTap.
Keep `ShortcutsPopup.tsx` in sync if any binding changes (memory `shortcuts-popup`).

### Phase 3 — Storage Tier 2 (SAF, user-chosen folders) — *optional, post first release*
1. Add `tauri-plugin-android-fs`; introduce a `VaultLocation` enum in Rust (`AppOwned(PathBuf)` | `Saf(UriPair)`).
2. Abstract the file layer behind a trait (`read`, `write`, `read_dir`, `create_dir`, `remove`, `rename`) with two impls (std::fs vs SAF). Refactor `vault.rs`, trash, themes, settings, lock to call the trait, **not** `std::fs` directly. This is the big internal refactor — isolate it.
3. SQLite caveat: rusqlite needs a real FD/path. Keep the **index.sqlite in app-cache** even for SAF vaults (it's a rebuildable cache — memory `sqlite-index-migrations` / architecture says index is never source of truth), and only the `.md`/assets live behind SAF. This sidesteps "no SQLite over content URI."
4. Persist SAF permission grants (`takePersistableUriPermission`) and the dual-URI pair per vault in recents.
5. Enables the desktop parity story: point PINPOINT at a Drive/OneDrive/Dropbox-synced Android folder → cross-device sync with the desktop app.

### Phase 4 — Release engineering
1. **Signing:** generate an Android upload keystore; wire `tauri.conf.json` / Gradle signing config. (Separate from the desktop minisign updater key — memory `updater-signing`.) Store keystore creds outside the repo.
2. **No in-app updater on mobile** (already gated). Updates via Play Store / sideloaded APK.
3. Build **`--apk`** for direct distribution/testing; build **AAB** (`tauri android build`) for Play. Ensure NDK r28+ for 16 KB pages.
4. Versioning: keep `version` in `tauri.conf.json` as the source; map to Android `versionCode`/`versionName`.
5. Test matrix: phone + tablet (layout already has a tablet breakpoint), light/dark, a large vault (perf of in-process SQLite on mobile), encryption lock/unlock round-trip on-device.

---

## 4. What we explicitly are NOT changing
- The hybrid data model (`.md` + frontmatter, DB-folder + `.pinpoint-db.json`) — portable as-is.
- Query DSL / recurrence / periodic / templates / smart-replace — pure logic, run unchanged.
- Crypto design — pure Rust, cross-compiles; lock/unlock works on-device in Tier 1.
- The desktop build — all desktop flows stay behind `#[cfg(desktop)]` / `isMobile` guards; **zero regressions** is a hard requirement.

## 5. Key risks & mitigations
| Risk | Mitigation |
|---|---|
| SAF complexity blocks release | Tier-1 app-owned storage ships first; SAF is post-MVP. |
| Uninstall wipes app-owned vault | Loud onboarding + one-tap export (zip); Tier 2 SAF removes the limitation. |
| `notify` watcher unusable on Android | `cfg`-gate off; refresh on resume + manual refresh. |
| Large-vault SQLite perf on mobile | Tune pragmas (smaller cache, WAL already on); index stays in app-cache. |
| 160+ hover rules degrade touch UX | Gate hover styling behind `@media (hover: hover)`; persistent affordances on touch. |
| Google 16 KB page mandate | NDK r28+. |
| Encryption UX on mobile keyboards | Password sheet with reveal toggle; reuse existing `dialogs.password`. |

## 6. Rough sequencing / effort
- Phase 0: ~0.5–1 day (toolchain + hello APK).
- Phase 1: ~3–5 days (app-owned storage end-to-end). **← first useful APK here.**
- Phase 2: ~1.5–2 weeks (touch UX; the visible bulk).
- Phase 3 (SAF): ~1–1.5 weeks (optional, the internal file-layer refactor).
- Phase 4: ~2–3 days (signing + release).

**Fastest path to "an APK in my hand that actually works": Phase 0 → Phase 1.** Touch polish (Phase 2) makes it pleasant; SAF (Phase 3) makes it match desktop's bring-your-own-folder sync.

---

### Sources
- [Tauri File System plugin (Android scope)](https://v2.tauri.app/plugin/file-system/)
- [Tauri Android folder-picker tracking issue](https://github.com/tauri-apps/tauri/issues/14587)
- [tauri-plugin-android-fs (SAF)](https://github.com/aiueo13/tauri-plugin-android-fs)
- [Tauri prerequisites (NDK/targets/env)](https://v2.tauri.app/start/prerequisites/)
- [Tauri Google Play / AAB distribution](https://v2.tauri.app/distribute/google-play/)
