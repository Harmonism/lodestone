#!/usr/bin/env python3
"""
build-corpus.py — Lodestone corpus pack (the web app and Lodestone Desktop).

Turns the Harmonia vault into the pack that the offline companion downloads
once and then retrieves from with no network:

    app/corpus/corpus.json          articles (cleaned full text) + chunk offsets
    app/corpus/runtime.json         backbones, retrieval config, crisis + witness
                                    libraries, pack manifest
    app/corpus/exclusions.txt       audit list: every file left out, and why

Single source of truth, nothing re-typed:
  - Audience filter    imported from harmonia-astro/scripts/build-sovereignty-bundle.py
                       (which mirrors sync-content.sh): the pack never carries
                       anything the public site does not serve.
  - Cleaning / weight  imported from harmonia-astro/telegram-companion/index-vault.py
  - Synonyms/stopwords parsed from harmonia-astro/companion-rag.php
  - Crisis library     crisis-patterns.json + templates/resources parsed from
                       companion-crisis-detector.php
  - Witness markers    parsed from telegram-companion/companion-classifier.php
  - Full backbone      telegram-companion/doctrinal-backbone.md (live Tier 1)
  - Light backbone     lodestone/doctrine/backbone-light.md (curated extraction;
                       the build warns when the full backbone has moved past the
                       version the light one was derived from)

Holds: any file whose frontmatter carries `publication_hold: true` is excluded
regardless of location. Public titles that touch a held subject
(tools/hold-subject.local, kept out of the repository) are listed in the report, not silently excluded.

Usage (from lodestone/, beside the vault and harmonia-astro):
    python3 tools/build-corpus.py
    python3 tools/build-corpus.py --vault ../Harmonia --astro ../harmonia-astro
Then, optionally, semantic vectors:
    node tools/embed-corpus.mjs
"""
import argparse
import hashlib
import importlib.util
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # lodestone/

CHUNK_MAX = 1400    # chars; sized for a 4k-context light model (2 chunks/turn)
CHUNK_MIN = 60
LEADIN_MAX = 300   # chars; a heading-less opening shorter than this joins the next chunk

# The held subjects are a local list, never published: one regular expression
# in tools/hold-subject.local. Without the file the review is skipped.
_HOLD_FILE = Path(__file__).with_name("hold-subject.local")
HOLD_SUBJECT_RE = (re.compile(_HOLD_FILE.read_text(encoding="utf-8").strip(), re.I)
                   if _HOLD_FILE.exists() else None)


# ─── Imports from the live pipeline (no re-typed logic) ───────────────────────

def load_module(name: str, path: Path):
    if not path.exists():
        sys.exit(f"ERROR: required pipeline file missing: {path}")
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ─── Minimal PHP literal parser (strings, arrays, =>) ─────────────────────────

def _php_tokens(src: str):
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c.isspace():
            i += 1
        elif src.startswith("//", i) or c == "#":
            j = src.find("\n", i)
            i = n if j < 0 else j + 1
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
        elif c == "'":
            j, buf = i + 1, []
            while j < n and src[j] != "'":
                if src[j] == "\\" and j + 1 < n and src[j + 1] in "'\\":
                    buf.append(src[j + 1]); j += 2
                else:
                    buf.append(src[j]); j += 1
            yield ("str", "".join(buf)); i = j + 1
        elif c == '"':
            j, buf = i + 1, []
            esc = {"n": "\n", "t": "\t", '"': '"', "\\": "\\", "$": "$", "r": "\r"}
            while j < n and src[j] != '"':
                if src[j] == "\\" and j + 1 < n and src[j + 1] in esc:
                    buf.append(esc[src[j + 1]]); j += 2
                else:
                    buf.append(src[j]); j += 1
            yield ("str", "".join(buf)); i = j + 1
        elif src.startswith("=>", i):
            yield ("=>", None); i += 2
        elif c in "[],;":
            yield (c, None); i += 1
        else:
            # bare token (variable, number, operator) — consume a word
            m = re.match(r"[\w$.]+|.", src[i:])
            yield ("bare", m.group(0)); i += len(m.group(0))


def php_array(src: str, start_marker: str):
    """Parse the first PHP array literal `[ ... ]` after start_marker."""
    k = src.find(start_marker)
    if k < 0:
        raise ValueError(f"marker not found: {start_marker!r}")
    k = src.find("[", k)
    toks = _php_tokens(src[k:])

    def parse(first):
        assert first[0] == "["
        items, is_map, key = [], False, None
        pending = None
        for t in toks:
            if t[0] == "]":
                if pending is not None:
                    items.append((key, pending))
                break
            if t[0] == ",":
                if pending is not None:
                    items.append((key, pending)); pending = None; key = None
                continue
            if t[0] == "=>":
                is_map, key, pending = True, pending, None
                continue
            if t[0] == "[":
                pending = parse(t)
            elif t[0] == "str":
                pending = t[1]
        return {k2: v for k2, v in items} if is_map else [v for _, v in items]

    return parse(next(toks))


# ─── Frontmatter / text helpers ───────────────────────────────────────────────

def first_h1(body: str):
    m = re.search(r"^#\s+(.+)$", body, re.M)
    return m.group(1).strip() if m else None


def clean_for_reader(body: str, clean_markdown) -> str:
    """index-vault's cleaner plus removal of leftover iframe/embed lines and the
    leading H1 (the reader renders the title separately)."""
    text = clean_markdown(body)
    text = re.sub(r"^#\s+.+\n?", "", text, count=1, flags=re.M)
    text = re.sub(r"^\s*>\s*$", "", text, flags=re.M)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def chunk_offsets(text: str):
    """Heading-bounded chunks, split on paragraph boundaries to CHUNK_MAX.
    Returns [(heading, start, end)] as offsets into `text`."""
    out = []
    heads = [(m.start(), m.end(), m.group(2).strip())
             for m in re.finditer(r"^(#{1,4})\s+(.+)$", text, re.M)]
    sections = []
    prev_end, prev_head = 0, ""
    for s, e, h in heads:
        sections.append((prev_head, prev_end, s))
        prev_end, prev_head = e, h
    sections.append((prev_head, prev_end, len(text)))

    for head, s, e in sections:
        # paragraph boundaries inside the section
        paras, pos = [], s
        for m in re.finditer(r"\n\s*\n", text[s:e]):
            paras.append((pos, s + m.start()))
            pos = s + m.end()
        paras.append((pos, e))
        cur_s = cur_e = None
        for ps, pe in paras:
            if pe - ps <= 0:
                continue
            if cur_s is None:
                cur_s, cur_e = ps, pe
            elif pe - cur_s <= CHUNK_MAX:
                cur_e = pe
            else:
                out.append((head, cur_s, cur_e)); cur_s, cur_e = ps, pe
            # hard-split a single overlong paragraph
            while cur_e - cur_s > CHUNK_MAX * 1.6:
                cut = text.rfind(". ", cur_s, cur_s + CHUNK_MAX)
                cut = cut + 1 if cut > cur_s + CHUNK_MIN else cur_s + CHUNK_MAX
                out.append((head, cur_s, cut)); cur_s = cut
        if cur_s is not None:
            out.append((head, cur_s, cur_e))

    out = [(h, s, e) for h, s, e in out if len(text[s:e].strip()) >= CHUNK_MIN]
    # A short heading-less lead-in (the italic orientation line under the title)
    # rides with the passage after it: alone it outranked the article's body on
    # a search for the title and reached the model as 63 characters of nothing.
    if len(out) > 1 and not out[0][0] and len(text[out[0][1]:out[0][2]].strip()) < LEADIN_MAX:
        out[1] = (out[1][0], out[0][1], out[1][2])
        out = out[1:]
    return out


def url_for(relpath: str) -> str:
    # Mirrors companion-rag.php::filepathToUrl (EN).
    slug = re.sub(r"\.md$", "", relpath, flags=re.I).lower().replace(" ", "-")
    return "https://harmonism.io/" + slug


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", default=str(ROOT.parent / "Harmonia"))
    ap.add_argument("--astro", default=str(ROOT.parent / "harmonia-astro"))
    ap.add_argument("--out", default=str(ROOT / "app" / "corpus"))
    args = ap.parse_args()

    vault, astro, out = Path(args.vault), Path(args.astro), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    bundle = load_module("sov_bundle", astro / "scripts" / "build-sovereignty-bundle.py")
    indexer = load_module("index_vault", astro / "telegram-companion" / "index-vault.py")

    articles, chunks, excluded, hold_subject = [], [], [], []

    for path in sorted(vault.rglob("*.md")):
        rel = str(path.relative_to(vault))
        if bundle.should_exclude(rel):
            excluded.append((rel, "audience filter (sync-content / Sovereignty Bundle)")); continue
        if bundle.has_developer_audience(path):
            excluded.append((rel, "audience: developer")); continue
        try:
            raw = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            excluded.append((rel, "unreadable")); continue
        meta, body = indexer.parse_frontmatter(raw)
        if meta.get("publication_hold") is True:
            excluded.append((rel, "publication_hold: true")); continue
        if str(meta.get("draft", "")).lower() == "true":
            excluded.append((rel, "draft: true")); continue

        title = first_h1(body) or path.stem
        text = clean_for_reader(body, indexer.clean_markdown)
        if len(text) < CHUNK_MIN:
            excluded.append((rel, "empty after cleaning")); continue
        if HOLD_SUBJECT_RE and (HOLD_SUBJECT_RE.search(title) or HOLD_SUBJECT_RE.search(rel)):
            hold_subject.append(rel)

        tags = meta.get("tags") or []
        if isinstance(tags, str):
            tags = [tags]
        a_idx = len(articles)
        articles.append({
            "p": rel,
            "t": title,
            "u": url_for(rel),
            "d": str(meta.get("domain") or ""),
            "l": str(meta.get("content_layer") or ""),
            "s": str(meta.get("doctrinal_status") or ""),
            "w": indexer.compute_weight(meta),
            "g": [str(t) for t in tags][:12],
            "x": text,
        })
        for head, s, e in chunk_offsets(text):
            chunks.append([a_idx, head, s, e])

    # ── runtime libraries parsed from the live PHP ──
    rag_php = (astro / "companion-rag.php").read_text(encoding="utf-8")
    stop_words = php_array(rag_php, "$stopWords =")
    synonyms = php_array(rag_php, "$synonymMap =")

    crisis_patterns = json.loads(
        (astro / "telegram-companion" / "crisis-patterns.json").read_text(encoding="utf-8"))
    crisis_php = (astro / "telegram-companion" / "companion-crisis-detector.php").read_text(encoding="utf-8")
    crisis_templates = php_array(crisis_php, "$templates =")
    crisis_resources = php_array(crisis_php, "function crisisRegionalResources")

    cls_php = (astro / "telegram-companion" / "companion-classifier.php").read_text(encoding="utf-8")
    wstart = cls_php.find("function detectWitnessMode")
    witness_patterns = php_array(cls_php[wstart:], "$patterns =")

    backbone_full = (astro / "telegram-companion" / "doctrinal-backbone.md").read_text(encoding="utf-8")
    m = re.search(r"Document version:\s*([\d.]+)", backbone_full)
    full_version = m.group(1) if m else "unknown"
    light_path = ROOT / "doctrine" / "backbone-light.md"
    backbone_light = light_path.read_text(encoding="utf-8")
    m = re.search(r"derived_from_version:\s*([\d.]+)", backbone_light)
    light_from = m.group(1) if m else "unknown"
    light_body = re.sub(r"^---\n.*?\n---\n", "", backbone_light, flags=re.S).strip()

    corpus = {"articles": articles, "chunks": chunks}
    corpus_bytes = json.dumps(corpus, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    corpus_hash = hashlib.sha256(corpus_bytes).hexdigest()[:16]
    prev = out / "corpus.json"
    if prev.exists():
        # kept so embed-corpus.mjs can reuse vectors for unchanged passages
        prev.replace(out / "corpus.prev.json")
    (out / "corpus.json").write_bytes(corpus_bytes)

    built = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    runtime = {
        "pack": {
            "built_at": built,
            "corpus_hash": corpus_hash,
            "articles": len(articles),
            "chunks": len(chunks),
            "corpus_bytes": len(corpus_bytes),
            "backbone_full_version": full_version,
            "backbone_light_derived_from": light_from,
        },
        "backbone": {"full": backbone_full, "light": light_body},
        "retrieval": {"stop_words": stop_words, "synonyms": synonyms},
        "crisis": {"patterns": crisis_patterns, "templates": crisis_templates,
                   "resources": crisis_resources},
        "witness": witness_patterns,
    }
    (out / "runtime.json").write_text(json.dumps(runtime, ensure_ascii=False), encoding="utf-8")

    with (out / "exclusions.txt").open("w", encoding="utf-8") as fh:
        fh.write(f"# Lodestone pack {built} — {len(excluded)} files excluded\n")
        for rel, why in excluded:
            fh.write(f"{why}\t{rel}\n")
        if hold_subject:
            fh.write("\n# INCLUDED but touching a held subject — review:\n")
            for rel in hold_subject:
                fh.write(f"REVIEW\t{rel}\n")

    print(f"Pack built {built}")
    print(f"  articles {len(articles)}  chunks {len(chunks)}  corpus {len(corpus_bytes)/1e6:.1f} MB  hash {corpus_hash}")
    print(f"  excluded {len(excluded)}  (see app/corpus/exclusions.txt)")
    print(f"  retrieval: {len(stop_words)} stop words, {len(synonyms)} synonyms")
    print(f"  crisis: {len(crisis_patterns.get('categories', {}))} categories, "
          f"{len(crisis_templates)} templates, {len(crisis_resources)} regions; "
          f"witness: {sum(len(v) for v in witness_patterns.values())} markers")
    if hold_subject:
        print(f"  REVIEW: {len(hold_subject)} included file(s) touch a held subject")
    if light_from != full_version:
        print(f"  WARNING: backbone-light derived from v{light_from}; live backbone is v{full_version}. "
              f"Re-derive doctrine/backbone-light.md before shipping.")
    stale = out / "embeddings.bin"
    if stale.exists():
        meta_p = out / "embeddings.json"
        try:
            em = json.loads(meta_p.read_text())
            if em.get("corpus_hash") != corpus_hash:
                print("  NOTE: embeddings are from an older pack — run `node tools/embed-corpus.mjs`.")
        except Exception:
            print("  NOTE: embeddings metadata unreadable — run `node tools/embed-corpus.mjs`.")


if __name__ == "__main__":
    main()
