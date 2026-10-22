#!/usr/bin/env bash
# fetch-assets.sh — the large files this repository does not carry, fetched and checked.
#
#   tools/fetch-assets.sh [all|model|corpus|library|engines]     (default: all)
#
#   model    the retrieval model's weights (multilingual-e5-small, ONNX, 113 MB) and
#            the voice detector dictation uses (Silero VAD v5, ONNX, 2.2 MB, MIT),
#            from Hugging Face, checked against the hashes below
#   corpus   the current corpus pack (app/corpus/), from harmonism.io
#   library  the English library for Lodestone Desktop (desktop/site-en/), from
#            harmonism.io, checked against the published index
#   engines  llama.cpp's llama-server for each desktop platform, from the
#            llama.cpp release named below, checked against desktop/engines/*.sha256
#
# The web app needs model and corpus; Lodestone Desktop needs all four.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="https://harmonism.io/lodestone-app"
LLAMA="b11243"
E5_URL="https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/onnx/model_quantized.onnx"
E5_SHA="f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193"
VAD_URL="https://huggingface.co/onnx-community/silero-vad/resolve/e71cae966052b992a7eca6b17738916ce0eca4ec/onnx/model.onnx"
VAD_SHA="a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808"

TMP_ROOT="$(mktemp -d)"; trap 'rm -rf "$TMP_ROOT"' EXIT

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
get() { echo "  ↓ $1"; curl -fL --retry 3 --progress-bar -o "$2" "$1"; }

model() {
  fetch_checked "retrieval model" "$E5_URL" "$E5_SHA" "$ROOT/app/vendor/models/Xenova/multilingual-e5-small/onnx/model_quantized.onnx"
  fetch_checked "voice detector" "$VAD_URL" "$VAD_SHA" "$ROOT/app/vendor/models/onnx-community/silero-vad/onnx/model.onnx"
}

fetch_checked() {   # label, url, sha256, destination
  echo "==> $1"
  mkdir -p "$(dirname "$4")"
  if [ -f "$4" ] && [ "$(sha "$4" | cut -c1-64)" = "$3" ]; then echo "  present"; return; fi
  get "$2" "$4.part"
  [ "$(sha "$4.part" | cut -c1-64)" = "$3" ] || { echo "  hash mismatch"; rm -f "$4.part"; exit 1; }
  mv "$4.part" "$4"
}

corpus() {
  echo "==> corpus pack"
  mkdir -p "$ROOT/app/corpus"
  for f in runtime.json corpus.json embeddings.json embeddings.bin; do
    get "$SITE/corpus/$f" "$ROOT/app/corpus/$f.part" && mv "$ROOT/app/corpus/$f.part" "$ROOT/app/corpus/$f"
  done
}

library() {
  echo "==> English library"
  local tmp; tmp="$(mktemp -d "$TMP_ROOT/x.XXXXXX")"
  get "$SITE/site/index.json" "$tmp/index.json"
  get "$SITE/site/en.tar.gz" "$tmp/en.tar.gz"
  local want; want="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['packs']['en']['sha256'])" "$tmp/index.json")"
  [ "$(sha "$tmp/en.tar.gz" | cut -c1-64)" = "$want" ] || { echo "  hash mismatch"; exit 1; }
  rm -rf "$ROOT/desktop/site-en" && mkdir -p "$ROOT/desktop/site-en"
  tar xzf "$tmp/en.tar.gz" -C "$ROOT/desktop/site-en"
  python3 -c "import json,sys;p=json.load(open(sys.argv[1]))['packs']['en'];json.dump({'lang':'en','sha256':p['sha256'],'built_at':p['built_at'],'files':p['files'],'size':p['size']},open(sys.argv[2],'w'))" \
    "$tmp/index.json" "$ROOT/desktop/site-en/.pack.json"
}

engine() {   # platform, release asset
  local plat="$1" asset="$2" sums="$ROOT/desktop/engines/$1.sha256" dest="$ROOT/desktop/engines/$1"
  echo "==> engine $plat"
  local tmp; tmp="$(mktemp -d "$TMP_ROOT/x.XXXXXX")"
  get "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA/$asset" "$tmp/a"
  mkdir -p "$tmp/x"
  case "$asset" in *.zip) unzip -q "$tmp/a" -d "$tmp/x" ;; *) tar xzf "$tmp/a" -C "$tmp/x" ;; esac
  local src; src="$(dirname "$(find "$tmp/x" -name 'llama-server*' -type f | head -1)")"
  mkdir -p "$dest"
  local missing=() name
  while read -r _ name; do
    name="${name#\*}"
    if [ -e "$src/$name" ] || [ -L "$src/$name" ]; then cp -P "$src/$name" "$dest/"
    elif [ ! -e "$dest/$name" ]; then missing+=("$name"); fi
  done < "$sums"
  if [ ${#missing[@]} -gt 0 ]; then
    echo "  not in the llama.cpp release, to copy into desktop/engines/$plat/ by hand:"
    printf '    %s\n' "${missing[@]}"
    echo "  (on Windows these are the Microsoft Visual C++ Redistributable's x64 DLLs, in C:\\Windows\\System32)"
  fi
  (cd "$dest" && grep -v -F -f <(printf '%s\n' "${missing[@]:-__none__}") "../$plat.sha256" | sha -c --quiet -) \
    && echo "  checked" || { echo "  hash mismatch in $plat"; exit 1; }
}

engines() {
  engine darwin-arm64     "llama-$LLAMA-bin-macos-arm64.tar.gz"
  engine darwin-x64       "llama-$LLAMA-bin-macos-x64.tar.gz"
  engine linux-x64-vulkan "llama-$LLAMA-bin-ubuntu-vulkan-x64.tar.gz"
  engine win32-x64-vulkan "llama-$LLAMA-bin-win-vulkan-x64.zip"
}

case "${1:-all}" in
  model) model ;; corpus) corpus ;; library) library ;; engines) engines ;;
  all) model; corpus; library; engines ;;
  *) echo "usage: $0 [all|model|corpus|library|engines]"; exit 2 ;;
esac
