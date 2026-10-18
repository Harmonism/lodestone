#!/bin/bash
# Build the Lodestone app for Android. Run on a Mac, from Terminal:
#
#     cd lodestone/mobile && ./build-android.sh
#
# Produces release/Lodestone-android-<version>.apk, signed with the key in keys/,
# which post-build.sh publishes as /lodestone-app/download/Lodestone-android.apk.
#
# The app is a shell: it opens https://harmonism.io/lodestone-app/, so a change to
# Lodestone itself needs a deploy of the site, not a new APK. A new APK is needed
# only when the shell changes (capacitor.config.json, android/, the plugins).
# Raise versionCode and versionName in android/app/build.gradle each time, or
# Android refuses the update.
#
# Needs, once:  brew install --cask temurin@21 android-commandlinetools
#               (or Android Studio, whose SDK sits in ~/Library/Android/sdk)
set -euo pipefail
cd "$(dirname "$0")"

command -v npm >/dev/null || { echo "Node.js is needed first: https://nodejs.org"; exit 1; }
command -v java >/dev/null || { echo "A Java 21 runtime is needed: brew install --cask temurin@21"; exit 1; }

# The Android SDK: Android Studio's, or Homebrew's command-line tools.
if [ -z "${ANDROID_HOME:-}" ]; then
  for d in "$HOME/Library/Android/sdk" "/opt/homebrew/share/android-commandlinetools" "/usr/local/share/android-commandlinetools"; do
    [ -d "$d" ] && export ANDROID_HOME="$d" && break
  done
fi
[ -n "${ANDROID_HOME:-}" ] || { echo "No Android SDK found: brew install --cask android-commandlinetools"; exit 1; }
SDKM="$(command -v sdkmanager || ls "$ANDROID_HOME"/cmdline-tools/latest/bin/sdkmanager 2>/dev/null || true)"
if [ ! -d "$ANDROID_HOME/platforms/android-36" ] || [ ! -d "$ANDROID_HOME/build-tools/36.0.0" ]; then
  [ -n "$SDKM" ] || { echo "sdkmanager not found in $ANDROID_HOME"; exit 1; }
  yes | "$SDKM" --sdk_root="$ANDROID_HOME" --licenses >/dev/null || true
  "$SDKM" --sdk_root="$ANDROID_HOME" "platforms;android-36" "build-tools;36.0.0" "platform-tools"
fi
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

# The release key, made once. Keep a copy of keys/ somewhere safe: without it
# installed copies cannot be updated in place, only uninstalled and reinstalled.
if [ ! -f keys/keystore.properties ]; then
  mkdir -p keys
  PW="$(openssl rand -base64 24 | tr -d '/+=')"
  keytool -genkeypair -keystore keys/munai-release.jks -storetype PKCS12 -alias munai -keyalg RSA -keysize 4096 \
    -validity 36500 -storepass "$PW" -keypass "$PW" -dname "CN=Lodestone, O=Harmonia, L=harmonism.io"
  printf 'storeFile=munai-release.jks\nstorePassword=%s\nkeyAlias=munai\nkeyPassword=%s\n' "$PW" "$PW" > keys/keystore.properties
  chmod 600 keys/*
fi

npm install --no-audit --no-fund
npx cap sync android
(cd android && ./gradlew assembleRelease --no-daemon)

VERSION="$(sed -n 's/.*versionName "\(.*\)".*/\1/p' android/app/build.gradle | head -1)"
mkdir -p release
cp android/app/build/outputs/apk/release/app-release.apk "release/Lodestone-android-$VERSION.apk"
ls -t release/Lodestone-android-*.apk | tail -n +2 | xargs -r rm -f    # keep only the newest
echo
echo "release/Lodestone-android-$VERSION.apk — published by the next deploy as /lodestone-app/download/Lodestone-android.apk"
