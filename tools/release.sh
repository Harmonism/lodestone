#!/usr/bin/env bash
# release.sh — one command for a Lodestone release, whatever it touches.
#
#   bash tools/release.sh --status            what is behind (tools/release-status.sh)
#   bash tools/release.sh --web               publish the web app and deploy it
#   bash tools/release.sh --desktop           build Lodestone Desktop for Mac and deploy it
#   bash tools/release.sh --extension         build the store zips (the upload is by hand)
#   bash tools/release.sh --all               desktop + extension + the deploy that publishes both
#
#   --dry-run     print every step and stop before the first one that changes anything
#   --no-deploy   build and tag, upload nothing
#   -y            do not ask before starting
#
# WHY ONE VERB. Four things ship on four paths, and until now three unrelated
# entry points started them (release-desktop.command, deploy-site.command and a
# bare chained bash line), while the extension had none. The sequence is written
# once here instead of in a doc the reader has to follow in order.
#
# WHAT IT REFUSES, and why refusing early matters: publish-public.sh refuses a
# reused tag, but only after the corpus is built and the vectors embedded. This
# checks the same rule first, plus the two things that silently break a release:
# a stale extension lib/ (calls functions that do not exist) and a store version
# already uploaded (which cannot be replaced at the same number).
#
# ORDER, and it is not arbitrary:
#   1. preflight (versions, tags, stale copies) — refuses here or not at all
#   2. tools/publish-public.sh --push --desktop — tags the tree BEFORE it is built,
#      so the tag holds what the installers were built from
#   3. corpus, vectors, build-mac.sh — only if the desktop is in the release
#   4. extension build — its lib/ copy of app/js/ must be today's
#   5. deploy-companion.sh --quick — one password prompt; publishes installers
#      through latest.json and the web app to /lodestone-app/
#   6. verify.mjs — says plainly whether the live copy is the release
#
# Run it on this Mac. The shell commands that leave the sandbox are the deploy
# (ssh) and the publish (git push); everything else stays in the workspace.
set -uo pipefail
cd "$(dirname "$0")/.."
LODESTONE="$(pwd)"
ASTRO="$LODESTONE/../harmonia-astro"
EXT="$LODESTONE/../lodestone-extension"

DO_WEB=0; DO_DESKTOP=0; DO_EXT=0; DO_STATUS=0
DRY=0; NODEPLOY=0; YES=0
for a in "$@"; do case "$a" in
  --status) DO_STATUS=1 ;;
  --web) DO_WEB=1 ;;
  --desktop) DO_DESKTOP=1 ;;
  --extension) DO_EXT=1 ;;
  --all) DO_DESKTOP=1; DO_EXT=1; DO_WEB=1 ;;
  --dry-run) DRY=1 ;;
  --no-deploy) NODEPLOY=1 ;;
  -y|--yes) YES=1 ;;
  -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
  *) echo "unknown option: $a (see --help)" >&2; exit 2 ;;
esac; done
if [ $((DO_WEB + DO_DESKTOP + DO_EXT + DO_STATUS)) -eq 0 ]; then sed -n '2,40p' "$0"; exit 2; fi

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" -eq 1 ]; then printf '  \033[2m[dry-run]\033[0m %s\n' "$*"; else "$@"; fi; }

[ "$DO_STATUS" -eq 0 ] || { bash "$LODESTONE/tools/release-status.sh" "${STATUS_ARGS:-}"; [ $((DO_WEB + DO_DESKTOP + DO_EXT)) -eq 0 ] && exit $?; }

SHELL_N="$(sed -nE 's/^const VERSION = "[^"]*-v([0-9]+)".*/\1/p' app/sw.js | head -1 | sed -E 's/^v//')"
DESK_V="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' desktop/package.json)"
EXT_V="$(grep -m1 '"version"' "$EXT/manifest.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
EXT_VF="$(grep -m1 '"version"' "$EXT/manifest.firefox.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')"

say "Release: web shell v$SHELL_N · desktop $DESK_V · extension $EXT_V"
[ "$DRY" -eq 1 ] && echo "  (dry run: nothing will be built, tagged, pushed or uploaded)"

# ── 1. preflight ─────────────────────────────────────────────────────────────
# Everything that can refuse, refuses here, before the corpus takes minutes.
step "1. Preflight"
PUB="$LODESTONE/../lodestone-public"
if [ ! -d "$PUB/.git" ]; then
  echo "  · no .git in lodestone-public — publish will build and check but cannot tag (see Deploy Commands § Lodestone public repository)"
elif [ "$DO_WEB" -eq 1 ]; then
  if git -C "$PUB" rev-parse -q --verify "refs/tags/web-v$SHELL_N" >/dev/null 2>&1; then
    # The tag already names some content under app/. That is fine when today's
    # app/ is the same content (nothing to publish) and fatal when it is not —
    # and the two cannot be told apart by git alone, because the public tree is
    # a copy and a bare checkout of the tag is the only reference. So: if the
    # working tree differs from the published copy at the same shell version,
    # a publish would be refused. That is the case this catches.
    if [ -f "$PUB/app/sw.js" ] && [ -z "$(rsync -ain --delete --exclude='corpus/' --exclude='vendor/models/' --exclude='*.bak-*' --exclude='.DS_Store' app/ "$PUB/app/" 2>/dev/null | grep -v '^\.d')" ] \
       && git -C "$PUB" diff --quiet "web-v$SHELL_N" -- app ':!app/corpus' ':!app/vendor/models' 2>/dev/null; then
      # Both: app/ is the public copy, and the public copy is the tag. A copy left
      # uncommitted by a refused publish matches app/ but not the tag.
      echo "  ✔ web-v$SHELL_N already names today's app/ — nothing to publish"
    elif git -C "$PUB" rev-parse -q --verify "refs/tags/web-v$((SHELL_N - 1))" >/dev/null 2>&1; then
      die "app/ differs from the published tree, and web-v$SHELL_N is already taken. Raise VERSION in lodestone/app/sw.js, then run again."
    else
      echo "  ! web-v$SHELL_N is taken and app/ may differ; publish-public.sh will decide (it compares against the tag)"
    fi
  fi
  if [ "$DO_DESKTOP" -eq 1 ] && git -C "$PUB" rev-parse -q --verify "refs/tags/desktop-v$DESK_V" >/dev/null 2>&1; then
    if ! git -C "$PUB" diff --quiet "desktop-v$DESK_V" -- app desktop 2>/dev/null; then
      die "desktop-v$DESK_V already names other files. Bump it: (cd lodestone/desktop && npm version patch --no-git-tag-version), then run again."
    fi
  fi
elif [ "$DO_DESKTOP" -eq 1 ]; then
  # A desktop release needs the desktop tag too, whatever else is in the release.
  if git -C "$PUB" rev-parse -q --verify "refs/tags/desktop-v$DESK_V" >/dev/null 2>&1; then
    echo "  · desktop-v$DESK_V is already tagged; publish-public.sh will confirm it names today's tree"
  fi
fi
if [ "$DO_EXT" -eq 1 ]; then
  [ "$EXT_V" = "$EXT_VF" ] || die "the two extension manifests disagree: chromium $EXT_V, firefox $EXT_VF."
  # A store version already uploaded cannot be replaced at the same number.
  if [ -f "$EXT/dist/lodestone-chromium-$EXT_V.zip" ] || [ -f "$EXT/dist/lodestone-firefox-$EXT_V.zip" ]; then
    echo "  ! a zip of extension $EXT_V already exists in dist/ — if that version is already on a store, bump the manifests first"
    echo "    (both stores refuse a replaced number; the existing zip would also be overwritten)"
    [ "$YES" -eq 1 ] || { read -r -p "  continue and rebuild $EXT_V? [y/N] " a; [ "$a" = y ] || die "stopped."; }
  fi
  # stale copied modules: the failure that costs a day (Trap Catalog, October 26)
  for m in store.js sync.js unlock.js syncwire.js phone.js sse.js native.js hp.js held.js route.js; do
    cmp -s "app/js/$m" "$EXT/lib/$m" 2>/dev/null || echo "  · lib/$m is not today's app/js/ (build.sh will refresh it)"
  done
fi

if [ "$DO_DESKTOP" -eq 1 ]; then
  [ -f app/corpus/corpus.json ] || echo "  · no corpus pack yet — build-corpus.py will make one"
  [ -f desktop/site-en/index.html ] || die "no English library in desktop/site-en/ — see Deploy Commands § build-mac.sh (unpack ../.site-packs/en.tar.gz)."
fi

for entry in "win-x64:windows-setup.exe" "linux-appimage:linux-x86_64.AppImage" "linux-deb:linux-amd64.deb"; do
  [ "$DO_DESKTOP" -eq 1 ] || break
  kind="${entry%%:*}"; suf="${entry#*:}"
  if [ -n "$(ls -1t desktop/release/Lodestone-[0-9]*-"$suf" 2>/dev/null | head -1)" ]; then :; else
    echo "  ! no $kind installer in desktop/release/: its download goes 404 after the next deploy (build it on Linux)"
  fi
done
echo "  ✔ preflight passed"

[ "$DRY" -eq 0 ] && [ "$YES" -eq 0 ] && ! [ "$NODEPLOY" -eq 0 -a "$DO_WEB" -eq 0 -a "$DO_DESKTOP" -eq 0 ] && {
  read -r -p "Proceed with the release? [y/N] " a; [ "$a" = y ] || die "stopped."
}

# ── 2. extension, before the publish ─────────────────────────────────────────
# build.sh refreshes lib/ from app/js and writes FROM-APP.txt naming the current
# shell version — both are source-level inputs that the publish copies and tags.
# Built after the publish (as the desktop correctly is), the tag kept a lib/
# naming the previous shell version and the zips could never verify against it
# (October 31, 2026: extension-v2.2.11 tagged at v111, zipped at v112).
if [ "$DO_EXT" -eq 1 ]; then
  step "2. Build the extension $EXT_V (its lib/ must be current before it is tagged)"
  ( cd "$EXT" && run bash ./build.sh ) || die "build.sh failed"
  [ "$DRY" -eq 1 ] || { echo "  ✔ dist/lodestone-{chromium,firefox}-$EXT_V.zip"; echo "  → upload both by hand: Chrome Web Store, addons.mozilla.org"; }
fi

# ── 3. publish the public tree, and tag it before the desktop is built ───────
if [ "$DRY" -eq 0 ]; then
  step "3. Publish the public tree (tag before build)"
  if [ "$DO_DESKTOP" -eq 1 ]; then run bash tools/publish-public.sh --push --desktop
  else run bash tools/publish-public.sh --push; fi
  [ $? -eq 0 ] || die "publish-public.sh refused (see its message above). Nothing was built."
else
  step "3. Publish the public tree"
  [ "$DO_DESKTOP" -eq 1 ] && run bash tools/publish-public.sh --push --desktop || run bash tools/publish-public.sh --push
fi

# ── 4. desktop ───────────────────────────────────────────────────────────────
if [ "$DO_DESKTOP" -eq 1 ]; then
  step "4. Build Lodestone Desktop $DESK_V for Mac (Apple silicon and Intel)"
  run python3 tools/build-corpus.py || die "build-corpus.py failed"
  run node tools/embed-corpus.mjs   || die "embed-corpus.mjs failed"
  ( cd desktop && run bash ./build-mac.sh ) || die "build-mac.sh failed"
  [ "$DRY" -eq 1 ] || { [ -f "desktop/release/Lodestone-$DESK_V-mac-arm64.dmg" ] || die "no Lodestone-$DESK_V-mac-arm64.dmg in desktop/release/ after the build."; echo "  ✔ desktop $DESK_V built"; }
fi

# ── 5. deploy ────────────────────────────────────────────────────────────────
if [ "$NODEPLOY" -eq 1 ]; then
  step "5. Deploy — skipped (--no-deploy)"
elif [ "$DO_WEB" -eq 0 ] && [ "$DO_DESKTOP" -eq 0 ]; then
  step "5. Deploy — not needed (nothing the website serves changed)"
else
  step "5. Deploy to harmonism.io (one password prompt)"
  ( cd "$ASTRO" && run bash ./deploy-companion.sh --quick ) || die "deploy-companion.sh failed"
fi

# ── 6. verify ────────────────────────────────────────────────────────────────
if [ "$DRY" -eq 0 ] && [ "$NODEPLOY" -eq 0 ] && [ "$DO_WEB" -eq 1 ]; then
  step "6. Verify the live web app against its tag"
  node tools/verify.mjs web || echo "  (verify.mjs reported a difference — read it before trusting the deploy)"
fi

# ── after ────────────────────────────────────────────────────────────────────
step "Done"
echo "  web shell v$SHELL_N · desktop $DESK_V · extension $EXT_V"
[ "$DRY" -eq 1 ] && echo "  (dry run: nothing was done)"
echo
echo "  Still owed by hand, if this release touched them:"
echo "    · the extension zips, to both stores (a number cannot be replaced once uploaded)"
echo "    · install the new .dmg on this Mac and run: node tools/verify.mjs desktop"
echo "    · Windows/Linux installers, on a Linux machine, for the next deploy that carries them"
