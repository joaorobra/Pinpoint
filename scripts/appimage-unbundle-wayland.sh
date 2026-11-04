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

shopt -s nullglob
bundled=(squashfs-root/usr/lib/libwayland-*.so*)
if [ ${#bundled[@]} -eq 0 ]; then
  echo "✔ No bundled libwayland in $asset — nothing to do."
  exit 0
fi
printf 'Removing %s\n' "${bundled[@]}"
rm -f "${bundled[@]}"

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

echo "✔ $asset repacked without bundled libwayland, re-signed, and latest.json updated."
