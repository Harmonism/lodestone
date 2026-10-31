#!/bin/bash
#
# Lodestone Extension — build store-ready packages for each browser family.
#
#   ./build.sh          → dist/lodestone-chromium-<version>.zip  (Chrome, Brave, Edge, Opera)
#                         dist/lodestone-firefox-<version>.zip   (Firefox 121+, AMO upload)
#
# The two variants share every file except the manifest: Firefox needs an
# event-page background (background.scripts), a gecko id, and options_ui.
# Safari is not zipped here — see SAFARI.md (Xcode converter flow).
#
# 2.0: the extension carries Lodestone's memory modules, copied
# here from lodestone/app/js at every build (MV3 allows no remote code). They are
# never edited in this folder; change them in lodestone/app/js and build again.

set -e
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")

# Lodestone's memory modules, from the app (one source of truth).
APPJS="../lodestone/app/js"
[ -d "$APPJS" ] || { echo "lodestone/app/js not found next to this folder"; exit 1; }
mkdir -p lib
for m in store.js sync.js unlock.js syncwire.js phone.js sse.js native.js hp.js held.js route.js; do cp "$APPJS/$m" lib/; done
python3 - <<'PY'
import hashlib, pathlib, re
sw = pathlib.Path("../lodestone/app/sw.js").read_text()
v = re.search(r'VERSION = "([^"]+)"', sw).group(1)
h = hashlib.sha256(b"".join(pathlib.Path("lib", m).read_bytes() for m in sorted(["store.js","sync.js","unlock.js","syncwire.js","phone.js","sse.js","native.js","hp.js","held.js","route.js"]))).hexdigest()[:12]
pathlib.Path("lib/FROM-APP.txt").write_text(f"Copied from lodestone/app/js by build.sh. Do not edit here.\napp shell: {v}\nmodules sha256: {h}\n")
# Every relative import of a copied module must resolve inside lib/: one that
# does not (October 18, 2026: sync.js briefly imported canon.js) stops the
# service worker from loading, and the toolbar button silently does nothing.
missing = []
for f in sorted(pathlib.Path("lib").glob("*.js")):
    for m in re.findall(r'^\s*(?:import|export)\b[^;]*?from\s+["\'](\./[^"\']+)["\']', f.read_text(), re.M):
        if not (pathlib.Path("lib") / m[2:]).exists(): missing.append(f"{f.name} imports {m}")
if missing:
    raise SystemExit("build.sh: a copied module imports a file the extension does not carry:\n  " + "\n  ".join(missing) + "\nAdd it to the copy list or keep the import out of the shared module.")
PY

SHARED="background.js session-store.js content.js options.html options.js readings.html readings.js icons lib"

rm -rf dist .build
mkdir -p dist

# Build in a scratch folder, not in this one (October 22, 2026): zip writes a
# temporary file and renames it over the target, which needs deletion, and this
# folder does not allow it. The zips are copied in at the end instead (cp
# overwrites in place; it does not delete), so the old ones in dist/ are left
# where they are and a build never needs a _to_delete/ step.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/lodestone-ext.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/.build" "$SCRATCH/dist"

# Chromium family — manifest.json as-is
mkdir -p "$SCRATCH/.build/chromium"
cp -r $SHARED manifest.json "$SCRATCH/.build/chromium/"
(cd "$SCRATCH/.build/chromium" && zip -qr "$SCRATCH/dist/lodestone-chromium-${VERSION}.zip" .)

# Firefox — swap in the gecko manifest
mkdir -p "$SCRATCH/.build/firefox"
cp -r $SHARED "$SCRATCH/.build/firefox/"
cp manifest.firefox.json "$SCRATCH/.build/firefox/manifest.json"
(cd "$SCRATCH/.build/firefox" && zip -qr "$SCRATCH/dist/lodestone-firefox-${VERSION}.zip" .)

cp -p "$SCRATCH/dist/"*.zip dist/
echo "Built:"
ls -la dist/
