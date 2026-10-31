#!/bin/bash
# Build whisper.cpp's whisper-cli for this Mac, with Metal, for on-computer
# dictation in Lodestone and in Quarry (one engine for both: Quarry looks for it
# here, as it does for llama-server). Run on a Mac, from Terminal:
#
#     cd lodestone/desktop && ./build-whisper.sh            # this Mac's architecture
#     ./build-whisper.sh arm64 x86_64                       # both (build-mac.sh does this)
#
# Pinned: whisper.cpp v1.9.5, commit d1be6fde (October 6, 2026); the clone is
# checked against it before anything is built. One static binary per
# architecture, the Metal shaders embedded, written to
# engines/whisper-darwin-<arm64|x64>/whisper-cli. Needs git, cmake and the Xcode
# command-line tools (xcode-select --install; cmake: brew install cmake, or
# pip3 install --user cmake). An existing binary of the right version is kept.
set -euo pipefail
cd "$(dirname "$0")"
TAG=v1.9.5
COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
ARCHS=("$@"); [ ${#ARCHS[@]} -eq 0 ] && ARCHS=("$(uname -m)")

[ "$(uname)" = Darwin ] || { echo "build-whisper.sh builds for macOS; run it on a Mac."; exit 1; }
command -v git >/dev/null || { echo "git is needed: xcode-select --install"; exit 1; }
xcrun --find clang >/dev/null 2>&1 || { echo "The Xcode command-line tools are needed: xcode-select --install"; exit 1; }
CMAKE=$(command -v cmake || true)
[ -z "$CMAKE" ] && [ -x "$HOME/Library/Python/3.9/bin/cmake" ] && CMAKE="$HOME/Library/Python/3.9/bin/cmake"
[ -z "$CMAKE" ] && CMAKE=$(ls "$HOME"/Library/Python/*/bin/cmake 2>/dev/null | tail -1 || true)
[ -n "$CMAKE" ] || { echo "cmake is needed: brew install cmake (or pip3 install --user cmake)"; exit 1; }

need=()
for a in "${ARCHS[@]}"; do
  d=engines/whisper-darwin-$([ "$a" = x86_64 ] && echo x64 || echo arm64)
  if [ -x "$d/whisper-cli" ] && [ "$(cat "$d/VERSION" 2>/dev/null)" = "$TAG $COMMIT" ]; then echo "whisper-cli $TAG for $a: already built ($d)"; else need+=("$a"); fi
done
[ ${#need[@]} -eq 0 ] && exit 0

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp "$work/src"
got=$(git -C "$work/src" rev-parse HEAD)
[ "$got" = "$COMMIT" ] || { echo "whisper.cpp $TAG is at $got, not the pinned $COMMIT: not built."; exit 1; }

for a in "${need[@]}"; do
  d=engines/whisper-darwin-$([ "$a" = x86_64 ] && echo x64 || echo arm64)
  echo "Building whisper-cli $TAG for $a, with Metal…"
  "$CMAKE" -S "$work/src" -B "$work/b-$a" -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES="$a" -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
    -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF >"$work/cfg-$a.log" 2>&1 \
    || { tail -20 "$work/cfg-$a.log"; exit 1; }
  "$CMAKE" --build "$work/b-$a" --config Release -j "$(sysctl -n hw.ncpu)" --target whisper-cli >"$work/build-$a.log" 2>&1 \
    || { tail -20 "$work/build-$a.log"; exit 1; }
  mkdir -p "$d"
  cp "$work/b-$a/bin/whisper-cli" "$d/whisper-cli"
  cp "$work/src/LICENSE" "$d/LICENSE"
  echo "$TAG $COMMIT" > "$d/VERSION"
  # Static: nothing but the system's libraries and frameworks.
  if otool -L "$d/whisper-cli" | tail -n +2 | grep -v -E "^\s+/(usr/lib|System/Library)/" ; then echo "whisper-cli links a library outside the system: not kept."; rm -f "$d/whisper-cli"; exit 1; fi
  codesign --force --sign - "$d/whisper-cli" 2>/dev/null || true
  echo "  → $d/whisper-cli ($(du -h "$d/whisper-cli" | cut -f1))"
done
