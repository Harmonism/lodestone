#!/usr/bin/env python3
"""
build-site-packs.py — the harmonism.io library, packed for the Lodestone desktop app.

    python3 tools/build-site-packs.py --dist ../harmonia-astro/dist --out ../harmonia-astro/dist/lodestone-app/site

The built site is static HTML: every page works offline as it is. This packs it
into one archive per language so the desktop app can carry the site:

    en.tar.gz   the English site: every page, the search index, styles, images
    fr.tar.gz   … and one per translation, downloaded by the app only on request
    index.json  what each pack holds, its size and SHA-256, and when it last changed

Left out, because they cannot work offline or are not reading material: PHP
that runs on the server (member area, the online companion's server side; a
.php holding only HTML, like the interactive Wheel, is kept), the member/ pages, the
hosted Lodestone (the app carries its own), audio narration (fetched online by the
app when available), and the .md / .epub / .zip download formats.

The archives are deterministic — sorted entries, zeroed timestamps and owners,
gzip without a date — so an unchanged language produces a byte-identical file,
rsync sends nothing, and the app sees no update. A language whose content did
not change is not repacked at all.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import sys
import tarfile
import time
from pathlib import Path

LANGS = ["en", "fr", "es", "ar", "pt", "de", "zh", "ja", "hi", "ru"]
SKIP_DIRS_ROOT = {"audio", "lodestone-app", "munai-offline", "member", "pagefind-temp"}
SKIP_DIRS_ANY = {"member"}
SKIP_EXT = {".php", ".md", ".epub", ".zip"}
SKIP_NAMES = {".htaccess", ".DS_Store"}


def files_for(dist: Path, lang: str):
    """Sorted (relative path inside the pack, absolute path) pairs."""
    base = dist if lang == "en" else dist / lang
    if not base.is_dir():
        return []
    out = []
    for root, dirs, names in os.walk(base):
        rel_root = Path(root).relative_to(base)
        parts = rel_root.parts
        if lang == "en" and parts and (parts[0] in LANGS or parts[0] in SKIP_DIRS_ROOT):
            dirs[:] = []
            continue
        if any(p in SKIP_DIRS_ANY for p in parts):
            dirs[:] = []
            continue
        dirs.sort()
        for n in sorted(names):
            if n in SKIP_NAMES or n.startswith(".fuse_hidden"):
                continue
            ext = Path(n).suffix.lower()
            if ext == ".php":
                # A .php with no PHP in it is a static page served under that
                # name (the interactive Wheel, the assessment): it works offline.
                body = (Path(root) / n).read_bytes()
                if b"<?php" in body or b"<?=" in body:
                    continue
            elif ext in SKIP_EXT:
                continue
            rel = (Path(lang) / rel_root / n) if lang != "en" else (rel_root / n)
            out.append((rel.as_posix(), Path(root) / n))
    return out


def digest(entries):
    h = hashlib.sha256()
    for rel, p in entries:
        h.update(rel.encode() + b"\0")
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        h.update(b"\0")
    return h.hexdigest()


def pack(entries, dest: Path):
    tmp = dest.with_suffix(".tmp")
    with open(tmp, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0, filename="") as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
            for rel, p in entries:
                info = tarfile.TarInfo(rel)
                info.size = p.stat().st_size
                info.mtime = 0
                info.mode = 0o644
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                with open(p, "rb") as f:
                    tar.addfile(info, f)
    os.replace(tmp, dest)


def sha256_file(p: Path):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--langs", default=",".join(LANGS))
    args = ap.parse_args()
    dist, out = Path(args.dist).resolve(), Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    idx_path = out / "index.json"
    try:
        prev = json.loads(idx_path.read_text())
    except Exception:
        prev = {"packs": {}}

    packs = {}
    for lang in [l.strip() for l in args.langs.split(",") if l.strip()]:
        t0 = time.time()
        entries = files_for(dist, lang)
        if not entries:
            print(f"  site pack {lang}: nothing in {dist}, skipped")
            continue
        d = digest(entries)
        dest = out / f"{lang}.tar.gz"
        old = prev.get("packs", {}).get(lang)
        if old and old.get("content") == d and dest.exists():
            packs[lang] = old
            print(f"  site pack {lang}: unchanged")
            continue
        pack(entries, dest)
        packs[lang] = {
            "file": dest.name,
            "size": dest.stat().st_size,
            "sha256": sha256_file(dest),
            "content": d,
            "files": len(entries),
            "unpacked": sum(p.stat().st_size for _, p in entries),
            "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        print(f"  site pack {lang}: {len(entries)} files, {packs[lang]['unpacked']/1e6:.0f} MB → {packs[lang]['size']/1e6:.0f} MB ({time.time()-t0:.0f} s)")

    idx = {"format": 1, "packs": packs}
    idx_path.write_text(json.dumps(idx, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
