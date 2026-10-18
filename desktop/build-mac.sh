#!/bin/bash
# Build the macOS installers for Lodestone. Run on a Mac, from Terminal:
#
#     cd lodestone/desktop && ./build-mac.sh
#
# Produces a .dmg for Apple silicon (arm64) and for Intel (x64), and copies
# them into release/, which keeps only the newest Mac version (older .dmg files
# are removed; the Windows and Linux installers are left alone), where post-build.sh publishes the disk images as
# /lodestone-app/download/ (and lists them in latest.json for the app's own
# "Check for Updates…"). Needs Node.js 20 or later.
#
# With a "Developer ID Application" certificate in the keychain the app is
# signed with it, and notarized when APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
# APPLE_TEAM_ID are set. Without one it is ad-hoc signed: it runs on this Mac,
# and on other Macs after System Settings → Privacy & Security → Open Anyway.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist   # build output only; nothing in it is kept between builds

command -v npm >/dev/null || { echo "Node.js is needed first: https://nodejs.org"; exit 1; }
[ -f ../app/corpus/corpus.json ] || { echo "No corpus pack in ../app/corpus — run tools/build-corpus.py first."; exit 1; }
[ -f site-en/index.html ] || { echo "No English library in site-en/ — unpack the latest en.tar.gz from ../.site-packs/ into it first."; exit 1; }

npm install --no-audit --no-fund
node pack-library.js   # the English library as one archive (see pack-library.js)

if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    npx electron-builder --mac dmg --arm64 --x64 --publish never -c.mac.hardenedRuntime=true -c.mac.notarize=true
  else
    npx electron-builder --mac dmg --arm64 --x64 --publish never -c.mac.hardenedRuntime=true
  fi
else
  # Ad-hoc signing has no Team ID, so the hardened runtime (which only accepts
  # libraries from the same team) must be off, or the app cannot load its own
  # Electron framework and macOS refuses to open it.
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg --arm64 --x64 --publish never -c.mac.identity=- -c.mac.hardenedRuntime=false
fi

mkdir -p release
rm -f release/Lodestone-*-mac-*.dmg release/Lodestone-*-mac-*.zip
cp -p dist/Lodestone-[0-9]*-mac-*.dmg release/
echo
ls -lh release/
