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
# APPLE_TEAM_ID are set. Without one it is signed with Lodestone's own
# certificate (keys/lodestone-mac-signing.p12, self-signed): it runs on this Mac,
# and on other Macs after System Settings → Privacy & Security → Open Anyway,
# and keeps one identity from version to version, so the keychain's "Always
# Allow" for "Lodestone Safe Storage" (the saved sign-in and keys) holds across
# updates. Ad-hoc signing, whose identity changes with every build and which the
# keychain therefore asks about again after each update, is the last resort.
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
elif [ -f keys/lodestone-mac-signing.p12 ] && [ -f keys/lodestone-mac-signing.pass ]; then
  # Lodestone's own certificate: no Team ID either, so no hardened runtime.
  # Built unsigned, signed here with codesign, then packed as it is.
  ID="Lodestone Local Signing"
  KC="$HOME/Library/Keychains/login.keychain-db"
  if ! security find-identity -p codesigning "$KC" 2>/dev/null | grep -q "\"$ID\""; then
    security import keys/lodestone-mac-signing.p12 -k "$KC" -P "$(cat keys/lodestone-mac-signing.pass)" -T /usr/bin/codesign
  fi
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --arm64 --x64 --publish never -c.mac.identity=null -c.mac.hardenedRuntime=false
  for pair in arm64:mac-arm64 x64:mac; do
    arch="${pair%%:*}"; app="dist/${pair#*:}/Lodestone.app"
    codesign --force --deep --timestamp=none --sign "$ID" "$app"
    codesign --verify --deep --strict "$app"
    CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg "--$arch" --prepackaged "$app" --publish never -c.mac.identity=null
  done
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
