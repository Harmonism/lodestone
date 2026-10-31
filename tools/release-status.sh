#!/usr/bin/env bash
# release-status.sh — what is behind, in one reading, without building anything.
#
#   bash tools/release-status.sh            # the working tree against what is built and tagged
#   bash tools/release-status.sh --online   # also: the live web app, its shells and its latest.json
#
# Answers, for each of Lodestone's four artefacts, whether the code on disk has
# been built, and whether the build has been published:
#
#   web        app/            no build step at all; published by deploy-companion.sh.
#                              A change under app/ needs a raised VERSION in app/sw.js
#                              before any publish, or publish-public.sh refuses.
#   desktop    desktop/        needs build-mac.sh; release/ holds what was built.
#                              *Check for Updates…* offers only a higher number.
#   extension  ../lodestone-extension/
#                              lib/ is a copy of app/js/ made by build.sh; dist/ holds
#                              the zips. Both stores are uploaded by hand.
#   public     ../lodestone-public/
#                              publish-public.sh's copy, tagged web-vN / desktop-vX.Y.Z.
#
# Exit 0 when everything agrees, 1 when something is behind, 2 when a check
# could not be made. Read-only: it builds nothing, writes nothing, pushes nothing.
set -uo pipefail
cd "$(dirname "$0")/.."
LODESTONE="$(pwd)"
EXT="$LODESTONE/../lodestone-extension"
PUB="$LODESTONE/../lodestone-public"
ONLINE=0
[ "${1:-}" = "--online" ] && ONLINE=1

behind=0; unknown=0
ok()      { printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()     { printf '  \033[31m✘\033[0m %s\n' "$*"; behind=$((behind + 1)); }
warn()    { printf '  \033[33m·\033[0m %s\n' "$*"; }
unknown() { printf '  \033[33m?\033[0m %s\n' "$*"; unknown=$((unknown + 1)); }
head_()   { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---- versions ---------------------------------------------------------------
SHELL_N="$(sed -nE 's/^const VERSION = "[^"]*-v([0-9]+)".*/\1/p' app/sw.js | head -1 | sed -E 's/^v//')"
SHELL_S="$(sed -nE 's/^const VERSION = "([^"]+)".*/\1/p' app/sw.js | head -1)"
DESK_V="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' desktop/package.json 2>/dev/null || echo "?")"
EXT_V="$(grep -m1 '"version"' "$EXT/manifest.json" 2>/dev/null | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
EXT_VF="$(grep -m1 '"version"' "$EXT/manifest.firefox.json" 2>/dev/null | sed -E 's/.*"version": *"([^"]+)".*/\1/')"

head_ "Versions on disk"
printf '  web shell     %s  (web-v%s)\n' "${SHELL_S:-?}" "${SHELL_N:-?}"
printf '  desktop       %s  (desktop-v%s)\n' "$DESK_V" "$DESK_V"
printf '  extension     chromium %s · firefox %s\n' "${EXT_V:-?}" "${EXT_VF:-?}"

# ---- 1. web: a change under app/ with no raised shell version ----------------
head_ "Web app — app/"
TAGGED_N="$(git -C "$PUB" tag -l 'web-v*' 2>/dev/null | sed 's/web-v//' | sort -n | tail -1)"
if [ -d "$PUB/.git" ] && [ -n "$TAGGED_N" ]; then
  # The published tag's sw.js says which shell it was. Anything changed under app/
  # since needs a higher VERSION or publish-public.sh refuses.
  PUB_N="$(git -C "$PUB" show "web-v$TAGGED_N:app/sw.js" 2>/dev/null | sed -nE 's/^const VERSION = "[^"]*-v([0-9]+)".*/\1/p' | head -1)"
  printf '  last published tag  web-v%s (shell v%s)\n' "$TAGGED_N" "${PUB_N:-?}"
  if [ -f "$PUB/app/sw.js" ]; then
    CHANGED="$(rsync -ain --delete --exclude='corpus/' --exclude='vendor/models/' --exclude='*.bak-*' --exclude='.DS_Store' app/ "$PUB/app/" 2>/dev/null | grep -v '^\.d' | wc -l | tr -d ' ')"
    # A copy left uncommitted by a refused publish matches app/ but not the tag.
    UNTAGGED="$(git -C "$PUB" diff --name-only "web-v$TAGGED_N" -- app ':!app/corpus' ':!app/vendor/models' 2>/dev/null | wc -l | tr -d ' ')"
    CHANGED=$((CHANGED + UNTAGGED))
    if [ "$CHANGED" -eq 0 ]; then ok "app/ matches the published tree"; else
      if [ "${SHELL_N:-0}" -gt "${PUB_N:-0}" ]; then
        ok "app/ changed since web-v$TAGGED_N, and the shell is v$SHELL_N: a publish would tag it"
      else
        bad "app/ changed since web-v$TAGGED_N ($CHANGED file(s)) but VERSION is still v$SHELL_N — publish-public.sh will refuse. Raise it in app/sw.js."
      fi
    fi
  else warn "the published tree holds no app/sw.js"; fi
else
  unknown "no publication-tag reading: $PUB/.git or the web-v* tags are missing (see Deploy Commands § Lodestone public repository)"
fi

# ---- 2. desktop: package.json against release/ ------------------------------
head_ "Desktop — desktop/"
BUILT_V="$(ls -1t desktop/release/Lodestone-*-mac-arm64.dmg 2>/dev/null | head -1 | sed -E 's#.*/Lodestone-([0-9.]+)-mac-arm64.dmg#\1#')"
if [ -n "$BUILT_V" ]; then
  if [ "$BUILT_V" = "$DESK_V" ]; then ok "a Mac build of $DESK_V is in release/"; else
    bad "desktop/package.json is $DESK_V, release/ holds a Mac build of $BUILT_V — needs: ./build-mac.sh"
  fi
else unknown "no Mac .dmg in desktop/release/"; fi

# Every platform the deploy publishes, from release/. post-build.sh copies the
# newest of each, so a platform left behind is a version the site serves.
head_ "Installers published by the next deploy"
printf '  %-15s %-9s %s\n' "platform" "version" "file"
for entry in "mac-arm64:mac-arm64.dmg" "mac-x64:mac-x64.dmg" "win-x64:windows-setup.exe" \
             "linux-appimage:linux-x86_64.AppImage" "linux-deb:linux-amd64.deb"; do
  kind="${entry%%:*}"; suf="${entry#*:}"
  src="$(ls -1t desktop/release/Lodestone-[0-9]*-"$suf" 2>/dev/null | head -1)"
  if [ -n "$src" ]; then
    v="$(basename "$src")"; v="${v#Lodestone-}"; v="${v%-$suf}"
    printf '  %-15s %-9s %s\n' "$kind" "$v" "$(basename "$src")"
    case "$v" in
      "$DESK_V") ;;
      *) [ "$kind" = mac-arm64 ] || [ "$kind" = mac-x64 ] || warn "$kind stays at $v while the desktop is $DESK_V (build it on Linux, if this release should carry it)" ;;
    esac
  else printf '  %-15s %-9s %s\n' "$kind" "—" "none: this platform's download goes 404 after the next deploy"; behind=$((behind + 1)); fi
done

# ---- 3. extension: copied modules and built zips ---------------------------
head_ "Extension — ../lodestone-extension/"
TAGGED_EXT="$(git -C "$PUB" tag -l 'extension-v*' 2>/dev/null | sed 's/extension-v//' | sort -V | tail -1)"
if [ ! -d "$EXT" ]; then unknown "not found at $EXT"; else
  STALE=""; MODS="store.js sync.js unlock.js syncwire.js phone.js sse.js native.js hp.js held.js route.js"
  for m in $MODS; do
    if [ ! -f "$EXT/lib/$m" ]; then STALE="$STALE $m(missing)";
    elif ! cmp -s "app/js/$m" "$EXT/lib/$m"; then STALE="$STALE $m"; fi
  done
  if [ -z "$STALE" ]; then ok "lib/ matches app/js/ (all ten modules)"
  else bad "lib/ is not today's app/js/:$STALE — needs: ./build.sh (a stale copy calls functions that do not exist)"; fi
  APP_N="$(grep -oE 'munai-offline-shell-v[0-9]+' "$EXT/lib/FROM-APP.txt" 2>/dev/null | sed 's/.*-v//')"
  [ -n "$APP_N" ] && printf '  lib/ says it carries shell v%s; app/sw.js is v%s\n' "$APP_N" "${SHELL_N:-?}"
  if [ "$EXT_V" != "$EXT_VF" ]; then bad "the two manifests disagree: chromium $EXT_V, firefox $EXT_VF"; else
    for fam in chromium firefox; do
      z="$(ls -1t "$EXT/dist/lodestone-$fam-$EXT_V.zip" 2>/dev/null | head -1)"
      if [ -n "$z" ]; then ok "$fam zip of $EXT_V is built"; else bad "no $fam zip of $EXT_V in dist/ — needs: ./build.sh"; fi
    done
    # The zips against the tagged tree: a comment edited after a build leaves a zip
    # that is not the source, which is how a store gets yesterday's code.
    if [ -n "$TAGGED_EXT" ] && [ -f "$EXT/dist/lodestone-chromium-$EXT_V.zip" ]; then
      if node "$LODESTONE/tools/verify.mjs" extension "$EXT/dist/lodestone-chromium-$EXT_V.zip" --tag "extension-v$TAGGED_EXT" >/dev/null 2>&1; then
        ok "the chromium zip is identical to extension-v$TAGGED_EXT"
      else warn "the chromium zip differs from extension-v$TAGGED_EXT (a rebuild, or a source edit after the build)"; fi
    fi
  fi
  NEWEST_ZIP="$(ls -1t "$EXT/dist"/*.zip 2>/dev/null | head -1)"
  [ -n "$NEWEST_ZIP" ] && printf '  newest zip: %s\n' "$(basename "$NEWEST_ZIP")"
  warn "both stores are uploaded by hand; a version already uploaded cannot be replaced at the same number"
fi

# ---- 4. public tree --------------------------------------------------------
head_ "Public tree — ../lodestone-public/"
if [ -d "$PUB/.git" ]; then
  printf '  last commit: %s\n' "$(git -C "$PUB" log -1 --format='%h %s (%ar)' 2>/dev/null)"
  printf '  tags: %s\n' "$(git -C "$PUB" tag -l | sort -V | tail -5 | tr '\n' ' ')"
  git -C "$PUB" tag -l 'desktop-v*' | sed 's/desktop-v//' | sort -V | tail -1 | \
    { read -r t; [ "$t" = "$DESK_V" ] && ok "desktop-v$DESK_V is tagged" || bad "desktop $DESK_V is not tagged (desktop builds tagged: ${t:-none})"; }
  DIRTY="$(git -C "$PUB" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$DIRTY" = "0" ]; then ok "no uncommitted changes in the public tree"; else bad "$DIRTY change(s) in the public tree were copied but never committed — the tag does not hold them"; fi
else unknown "no .git: the script prints no changes list and refuses to commit (see Deploy Commands)"; fi

# ---- 5. live, when asked ---------------------------------------------------
if [ "$ONLINE" -eq 1 ]; then
  head_ "Live — harmonism.io"
  LIVE="$(curl -sf --max-time 15 https://harmonism.io/lodestone-app/sw.js 2>/dev/null | sed -nE 's/^const VERSION = "[^"]*-v([0-9]+)".*/\1/p' | head -1)"
  if [ -z "$LIVE" ]; then unknown "could not read /lodestone-app/sw.js"; else
    if [ "$LIVE" = "$SHELL_N" ]; then ok "the live web app is shell v$LIVE"; else
      bad "the live web app is shell v$LIVE, the tree is v$SHELL_N — a deploy is owed"
    fi
  fi
  LJ="$(curl -sf --max-time 15 https://harmonism.io/lodestone-app/download/latest.json 2>/dev/null)"
  if [ -n "$LJ" ]; then
    printf '  latest.json: %s\n' "$(printf '%s' "$LJ" | python3 -c 'import json,sys
d=json.load(sys.stdin).get("files",{})
print(" · ".join(f"{k} {v.get(chr(118)+chr(101)+chr(114)+chr(115)+chr(105)+chr(111)+chr(110))}" for k,v in sorted(d.items())) or "no files listed")' 2>/dev/null)"
    MAC="$(printf '%s' "$LJ" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("files",{}).get("mac-arm64",{}).get("version",""))' 2>/dev/null)"
    [ "$MAC" = "$DESK_V" ] && ok "latest.json offers $DESK_V for Apple silicon" || bad "latest.json offers ${MAC:-nothing} for Apple silicon, the tree is $DESK_V — a deploy is owed"
  else warning=""; unknown "could not read latest.json"; fi
fi

# ---- the one line ----------------------------------------------------------
head_ "Result"
if [ "$behind" -eq 0 ] && [ "$unknown" -eq 0 ]; then echo "  Everything on disk is built, tagged and published."; exit 0; fi
if [ "$behind" -eq 0 ]; then echo "  Nothing is behind; $unknown check(s) could not be made (marked ?)."; exit 2; fi
echo "  $behind thing(s) behind. Run: bash tools/release.sh --all      (or the flags for what is behind)"
exit 1
