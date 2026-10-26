#!/usr/bin/env bash
# publish-public.sh — build the public tree of Lodestone from this working folder.
#
#   tools/publish-public.sh [DEST]        default DEST: ../lodestone-public
#
# The working folder is never modified. This copies it into DEST without the
# fetched and built files (see .gitignore), the Android signing key, the local
# held-subject list and the .bak copies, then refuses to finish if anything
# internal or secret survives. DEST keeps its own .git; commit and push there.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$SRC/../lodestone-public}"
mkdir -p "$DEST"

# DEST's .git is moved aside for the copy and restored after: macOS's own rsync
# ignores the protect filter, and --delete-excluded would otherwise remove it.
GITKEEP=""
if [ -d "$DEST/.git" ]; then
  GITKEEP="$(mktemp -d "${TMPDIR:-/tmp}/lodestone-public-git.XXXXXX")"
  mv "$DEST/.git" "$GITKEEP/.git"
  trap 'if [ -n "$GITKEEP" ] && [ -d "$GITKEEP/.git" ]; then rm -rf "$DEST/.git"; mv "$GITKEEP/.git" "$DEST/.git"; rmdir "$GITKEEP"; fi' EXIT
fi

echo "==> copying $SRC → $DEST"
rsync -a --delete --delete-excluded \
  --filter='P /.git/' \
  --exclude='/app/corpus/' \
  --exclude='/app/vendor/models/**/*.onnx' \
  --include='/desktop/engines/*.sha256' --exclude='/desktop/engines/*' \
  --exclude='/desktop/site-en/' --exclude='/desktop/build-res/' \
  --exclude='/desktop/dist/' --exclude='/desktop/release/' --exclude='/desktop/release-old/' \
  --exclude='/.computer-zip/' \
  --exclude='/.site-packs/' --exclude='node_modules/' --exclude='__pycache__/' --exclude='*.pyc' \
  --exclude='/mobile/keys/' --exclude='/mobile/release/' --exclude='/desktop/keys/' \
  --exclude='/mobile/android/.gradle/' --exclude='/mobile/android/build/' --exclude='/mobile/android/**/build/' \
  --exclude='/mobile/android/local.properties' \
  --exclude='*.local' --exclude='*.bak-*' --exclude='*.retired-*' --exclude='.DS_Store' \
  "$SRC/" "$DEST/"
if [ -n "$GITKEEP" ]; then rm -rf "$DEST/.git"; mv "$GITKEEP/.git" "$DEST/.git"; rmdir "$GITKEEP"; GITKEEP=""; fi

echo "==> checking for internal or secret material"
fail=0
check() {   # label, extended regex, extra grep flags
  local hits
  hits="$(grep -rInE $3 --exclude-dir=.git --exclude=publish-public.sh -- "$2" "$DEST" | cut -c1-200 || true)"
  if [ -n "$hits" ]; then echo "  ✘ $1:"; echo "$hits" | sed 's/^/    /' | head -20; fail=1; fi
}
check "decision references"   '(^|[^[:alnum:]&/])#1[0-9]{3}\b|Decisions? #[0-9]{3}|Decision Log|Standing Canon' ''
check "internal vault paths"  'Internal/|Documents/Vault|/Users/[a-z]|/home/u[0-9]+' ''
check "secrets"               'sk-or-v1-[0-9a-f]{64}|sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20}|-----BEGIN [A-Z ]*PRIVATE KEY|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|(store|key)Password *= *[^%$ ]' ''
if [ -f "$SRC/tools/hold-subject.local" ]; then
  check "held subjects" "$(tr -d '\n' < "$SRC/tools/hold-subject.local")" '-i --exclude=tokenizer.json'
fi
bad_files="$(find "$DEST" -path "$DEST/.git" -prune -o -type f \( -name '*.jks' -o -name '*.keystore' -o -name '*.p12' -o -name 'lodestone-mac-signing.*' -o -name 'keystore.properties' -o -name '*.local' -o -size +50M \) -print)"
if [ -n "$bad_files" ]; then echo "  ✘ files that must not be published:"; echo "$bad_files" | sed 's/^/    /'; fail=1; fi

if [ "$fail" -ne 0 ]; then echo "==> refused: fix the source, then run again"; exit 1; fi
echo "  ✔ clean ($(find "$DEST" -path "$DEST/.git" -prune -o -type f -print | wc -l | tr -d ' ') files, $(du -sh --exclude=.git "$DEST" 2>/dev/null | cut -f1 || du -sh "$DEST" | cut -f1))"
if [ -d "$DEST/.git" ]; then echo "==> changes:"; git -C "$DEST" status --short | head -40; fi
