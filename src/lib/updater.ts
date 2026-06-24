// In-app auto-update for the Tauri desktop build.
//
// Flow: ask the updater endpoint (latest.json on the GitHub release) for the newest
// signed version, compare it to the running version, and — if newer — ask the user
// before downloading, installing, and relaunching. Web build: no-op (browsers can't
// self-update). See .github/workflows/release.yml for how latest.json gets published.

import { isTauri } from "../api";

/**
 * Check for an update and, if one exists, prompt the user to install it.
 *
 * @param opts.silent  When true (the on-launch check), stay quiet if already up to
 *                     date or the network check fails. When false (a user-triggered
 *                     "Check for updates"), always report the outcome.
 */
export async function checkForUpdates(opts: { silent?: boolean } = {}): Promise<void> {
  const silent = opts.silent ?? false;
  if (!isTauri()) {
    if (!silent) {
      window.alert("Auto-update is only available in the desktop app.");
    }
    return;
  }

  // Loaded lazily so the web bundle never pulls in the Tauri-only plugins.
  const { check } = await import("@tauri-apps/plugin-updater");
  const { relaunch } = await import("@tauri-apps/plugin-process");
  const { ask, message } = await import("@tauri-apps/plugin-dialog");

  try {
    const update = await check();

    if (!update) {
      if (!silent) {
        await message("You’re on the latest version of PINPOINT.", {
          title: "No updates",
          kind: "info",
        });
      }
      return;
    }

    const notes = update.body?.trim() ? `\n\nWhat’s new:\n${update.body.trim()}` : "";
    const wantsIt = await ask(
      `PINPOINT ${update.version} is available — you have ${update.currentVersion}.` +
        notes +
        `\n\nDownload and install it now? The app will restart when it’s done.`,
      {
        title: "Update available",
        kind: "info",
        okLabel: "Update now",
        cancelLabel: "Later",
      }
    );
    if (!wantsIt) return;

    // Download + install the signed package, then relaunch into the new version.
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    if (!silent) {
      await message(`Couldn’t check for updates.\n\n${String(e)}`, {
        title: "Update failed",
        kind: "error",
      });
    } else {
      console.warn("[updater] check failed:", e);
    }
  }
}
