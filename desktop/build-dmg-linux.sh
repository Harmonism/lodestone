#!/bin/bash
# Mac disk images built on Linux, from the ad-hoc-signed Lodestone.app bundles in
# dist/mac-arm64/ and dist/mac/ (electron-builder --mac dir, then rcodesign sign).
# The image is ISO 9660 with Rock Ridge (symlinks and permissions kept, which
# the app's frameworks need) wrapped as a compressed UDIF .dmg; macOS mounts it
# like any disk image. Beside the app sits a link to /Applications to drag onto.
#
# Needs xorriso and the `dmg` tool from https://github.com/fanquake/libdmg-hfsplus
# (cmake -B build && cmake --build build; the binary is build/dmg/dmg).
set -euo pipefail
cd "$(dirname "$0")/dist"
DMG_TOOL="${DMG_TOOL:-dmg}"
VERSION="$(node -p "require('../package.json').version")"
for pair in arm64:mac-arm64 x64:mac; do
  arch="${pair%%:*}"; src="${pair#*:}"
  stage="$(mktemp -d)"
  cp -a "$src/Lodestone.app" "$stage/"
  ln -s /Applications "$stage/Applications"
  xorrisofs -D -l -V "Lodestone" -no-pad -r -dir-mode 0755 -o "$stage.iso" "$stage"
  "$DMG_TOOL" "$stage.iso" "Lodestone-$VERSION-mac-$arch.dmg"
  rm -rf "$stage" "$stage.iso"
done
ls -lh Lodestone-"$VERSION"-mac-*.dmg
