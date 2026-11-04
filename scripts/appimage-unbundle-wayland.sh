#!/usr/bin/env bash
# Strip the bundled Wayland client libraries from a release's Linux AppImage, then re-sign it and
# point the updater manifest at the new signature.
#
# Why: linuxdeploy (via Tauri's AppImage bundler) copies libwayland-* from the build machine
# (Ubuntu 22.04) into the AppImage. On a newer host the system's GPU stack — notably NVIDIA's
# libnvidia-egl-wayland — calls into libwayland-client expecting the host's version, gets the old
# bundled one instead, and the app segfaults in wl_proxy_create_wrapper before a window appears.
# libwayland belongs to the host, like libGL/libEGL/libdrm already are, so we drop the bundled copy.
#
# It also stops the GTK hook from forcing X11. linuxdeploy's hook exports GDK_BACKEND=x11
# unconditionally (a workaround for Wayland crashes that the bundled libwayland itself caused), so on
# a Wayland desktop the window goes to whatever X server $DISPLAY names. When that variable is stale —
# e.g. Chrome Remote Desktop injects DISPLAY=:20 into the user session — the app "opens" on an
# invisible display. The patched hook uses Wayland when a Wayland session is present (falling back to
# X11), keeps X11 inside a Chrome Remote Desktop session, and honours PINPOINT_GDK_BACKEND to override.
#
# Usage: scripts/appimage-unbundle-wayland.sh <tag>
# Needs: gh (GH_TOKEN, GH_REPO), jq, curl, npx; TAURI_SIGNING_PRIVATE_KEY[_PASSWORD] for the updater.

set -euo pipefail

TAG="${1:?usage: $0 <tag>}"
: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY is required to re-sign the AppImage}"
APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage"
TAURI_CLI_VERSION="2.11.3"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

asset="$(gh release view "$TAG" --json assets --jq '.assets[].name | select(endswith(".AppImage"))' | head -n1)"
if [ -z "$asset" ]; then
  echo "✖ No .AppImage asset on release $TAG" >&2
  exit 1
fi
echo "Processing $asset from $TAG"

gh release download "$TAG" --pattern "$asset"
chmod +x "$asset"
# The AppImage runtime can extract itself without FUSE.
"./$asset" --appimage-extract >/dev/null

changed=0
shopt -s nullglob
bundled=(squashfs-root/usr/lib/libwayland-*.so*)
if [ ${#bundled[@]} -gt 0 ]; then
  printf 'Removing %s\n' "${bundled[@]}"
  rm -f "${bundled[@]}"
  changed=1
fi

hook=squashfs-root/apprun-hooks/linuxdeploy-plugin-gtk.sh
if [ -f "$hook" ] && grep -q '^export GDK_BACKEND=x11' "$hook"; then
  # Replace the hook's forced X11 with a session-aware choice (see header).
  python3 - "$hook" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
choice = '''# PINPOINT: pick the GDK backend from the session instead of forcing X11 (see
# scripts/appimage-unbundle-wayland.sh in the PINPOINT repo).
if [ -n "${PINPOINT_GDK_BACKEND:-}" ]; then
    export GDK_BACKEND="$PINPOINT_GDK_BACKEND"
elif [ -z "${CHROME_REMOTE_DESKTOP_SESSION:-}" ] && [ -n "${WAYLAND_DISPLAY:-}" ]; then
    export GDK_BACKEND=wayland,x11
else
    export GDK_BACKEND=x11
fi'''
src = re.sub(r"^export GDK_BACKEND=x11.*$", lambda _m: choice, src, count=1, flags=re.M)
open(path, "w", encoding="utf-8").write(src)
PY
  echo "Patched $hook to choose the GDK backend per session"
  changed=1
fi

if [ "$changed" -eq 0 ]; then
  echo "✔ $asset already has no bundled libwayland and a session-aware GTK hook — nothing to do."
  exit 0
fi

curl -fsSL -o appimagetool "$APPIMAGETOOL_URL"
chmod +x appimagetool
rm -f "$asset"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 ./appimagetool --no-appstream squashfs-root "$asset"

# Repacking changes the bytes, so the bundler's signature no longer verifies — sign again or the
# in-app updater rejects the download.
rm -f "$asset.sig"
npx --yes "@tauri-apps/cli@$TAURI_CLI_VERSION" signer sign \
  --private-key "$TAURI_SIGNING_PRIVATE_KEY" \
  --password "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
  "$asset"
test -s "$asset.sig"

gh release upload "$TAG" "$asset" "$asset.sig" --clobber

# Every manifest entry that serves this AppImage gets the new signature.
gh release download "$TAG" --pattern latest.json
jq --arg sig "$(cat "$asset.sig")" --arg name "$asset" \
  '.platforms |= map_values(if (.url | endswith("/" + $name)) then .signature = $sig else . end)' \
  latest.json > latest.patched.json
mv latest.patched.json latest.json
gh release upload "$TAG" latest.json --clobber

echo "✔ $asset repacked (host libwayland, session-aware GDK backend), re-signed, and latest.json updated."
