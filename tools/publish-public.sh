#!/usr/bin/env bash
# publish-public.sh — build the public tree of Lodestone from this working folder.
#
#   tools/publish-public.sh [--commit|--push] [--desktop] [-m MESSAGE] [DEST]
#                                          default DEST: ../lodestone-public
#
# The working folder is never modified. This copies it into DEST without the
# fetched and built files (see .gitignore), the Android signing key, the local
# held-subject list and the .bak copies, then refuses to finish if anything
# internal or secret survives, and writes SHA256SUMS: the SHA-256 of every
# file of the tree, which tools/verify.mjs compares a copy of Lodestone with.
#
# --commit  commits DEST and tags the release: web-vN, N the shell VERSION in
#           app/sw.js. A tag names one content for ever: when web-vN already
#           names other files under app/, it refuses until VERSION is raised.
# --desktop also tags desktop-vX.Y.Z (desktop/package.json), under the same rule
#           for app/ and desktop/; run it with the build of a Desktop release, so
#           the tag holds what the installers were built from.
# --push    --commit, then pushes the branch and the new tags to origin
#           (Codeberg, with GitHub as a second push address).
# Without --commit or --push it only builds and checks DEST, as before.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMIT=0; PUSH=0; DESKTOP=0; MSG=""; DEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT=1 ;;
    --push) COMMIT=1; PUSH=1 ;;
    --desktop) DESKTOP=1 ;;
    -m) MSG="${2:-}"; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) DEST="$1" ;;
  esac
  shift
done
DEST="${DEST:-$SRC/../lodestone-public}"
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
# The extension lives beside lodestone/, not inside it (#1618): copied to
# extension/ so its store zips are published, hashed and tagged like the rest.
# Only what a build needs and what ships: no dist/ (built), no .build/ (scratch),
# no icon backups (icons.bak-* would otherwise ship, #1469).
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
if [ -d "$SRC/../lodestone-extension" ]; then
  rsync -a --delete --delete-excluded \
    --exclude='/dist/' --exclude='/.build/' --exclude='/icons.bak-*' --exclude='/store-icon*.bak-*' \
    --exclude='*.local' --exclude='.DS_Store' \
    "$SRC/../lodestone-extension/" "$DEST/extension/"
  echo "    extension/ copied beside the app (its zips are built, not published)"
fi
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

echo "==> SHA256SUMS"
python3 - "$DEST" <<'PY'
import hashlib, os, sys
root = sys.argv[1]; lines = []
for d, dirs, files in os.walk(root):
    dirs[:] = sorted(x for x in dirs if not (d == root and x == ".git"))
    for f in files:
        p = os.path.join(d, f); rel = os.path.relpath(p, root).replace(os.sep, "/")
        if rel == "SHA256SUMS" or os.path.islink(p): continue
        with open(p, "rb") as fh: lines.append(f"{hashlib.sha256(fh.read()).hexdigest()}  {rel}")
lines.sort(key=lambda l: l[66:])
open(os.path.join(root, "SHA256SUMS"), "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
print(f"  ✔ {len(lines)} files")
PY

if [ -d "$DEST/.git" ]; then echo "==> changes:"; git -C "$DEST" status --short | head -40; fi
[ "$COMMIT" -eq 1 ] || exit 0
[ -d "$DEST/.git" ] || { echo "==> refused: $DEST has no .git (see Deploy Commands § Lodestone public repository)"; exit 1; }

# ---- the release: one tag, one content -----------------------------------------
SHELL_N="$(sed -nE 's/^const VERSION = "[^"]*-v([0-9]+)".*/\1/p' "$DEST/app/sw.js" | head -1)"
DESK_V="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$DEST/desktop/package.json")"
EXT_V=""
[ -f "$DEST/extension/manifest.json" ] && EXT_V="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$DEST/extension/manifest.json")"
[ -n "$SHELL_N" ] || { echo "==> refused: no VERSION in app/sw.js"; exit 1; }
G() { git -C "$DEST" "$@"; }
G add -A
TAGS=()
want_tag() {   # tag, paths it covers
  local tag="$1"; shift
  if G rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    if G diff --cached --quiet "$tag" -- "$@"; then echo "  ✔ $tag already names these files"; return 0; fi
    echo "==> refused: $tag already names other files under $*:"
    G diff --cached --stat "$tag" -- "$@" | tail -8 | sed 's/^/    /'
    case "$tag" in web-v*) echo "    Raise VERSION in app/sw.js (shell v$SHELL_N), then publish again." ;; *) echo "    Raise the version in desktop/package.json ($DESK_V), then build and publish again." ;; esac
    exit 1
  fi
  TAGS+=("$tag")
}
want_tag "web-v$SHELL_N" app
[ "$DESKTOP" -eq 0 ] || want_tag "desktop-v$DESK_V" app desktop
# The extension's own tag (October 31, 2026): its zips go to strangers by hand,
# and until now nothing named what was uploaded. Tagged only when extension/
# changed since the last extension tag, so an unrelated publish needs no new
# extension version.
if [ -n "$EXT_V" ]; then
  LAST_EXT="$(G tag -l 'extension-v*' | sed 's/extension-v//' | sort -V | tail -1)"
  if [ -z "$LAST_EXT" ] || ! G diff --cached --quiet "extension-v$LAST_EXT" -- extension; then EXT_TAG="extension-v$EXT_V"; fi
  if [ -n "${EXT_TAG:-}" ] && G rev-parse -q --verify "refs/tags/extension-v$EXT_V" >/dev/null 2>&1; then
    echo "==> refused: extension-v$EXT_V already names other files under extension/."
    echo "    Bump the version in lodestone-extension/manifest.json and manifest.firefox.json, then run again."
    exit 1
  fi
fi
[ -n "${EXT_TAG:-}" ] && TAGS+=("$EXT_TAG")
if G diff --cached --quiet; then echo "==> nothing new to commit"; else
  G -c user.name="Harmonia" -c user.email="harmonia@harmonism.io" commit -q -m "${MSG:-Lodestone: web shell v$SHELL_N, desktop $DESK_V}"
  echo "==> committed $(G rev-parse --short HEAD)"
fi
for t in "${TAGS[@]+"${TAGS[@]}"}"; do G tag -a "$t" -m "Lodestone $t" && echo "==> tagged $t"; done
[ "$PUSH" -eq 1 ] || { echo "==> not pushed (--commit): push with git -C \"$DEST\" push origin HEAD --follow-tags"; exit 0; }
G push origin HEAD --follow-tags
echo "==> pushed to $(G remote get-url --push --all origin | tr '\n' ' ')"
