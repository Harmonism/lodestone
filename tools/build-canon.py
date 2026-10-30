#!/usr/bin/env python3
"""
build-canon.py — the Canon statements (Doctrinal Fidelity Architecture, layer 0).

Cuts the ruled texts into short statements, word for word, so that nothing in them is written
anew: the doctrinal backbone (each bullet, each paragraph, a long paragraph in runs of sentences)
and the Glossary of Terms (each entry's opening). Each statement keeps its address: the backbone
section or the glossary term it came from, which travels with it into retrieval and into the
<canon> block, as contextual retrieval prepends a chunk's place to the chunk.

    python3 tools/build-canon.py [--backbone FILE]   → canon/statements.json

The output has the corpus pack's shape ({articles, chunks}, one chunk per statement), so
retrieval.js retrieves from it unchanged. Not shipped in the app yet: canon/ is read by
tools/fidelity-context.mjs for the fidelity suite.
"""
import json, os, re, sys, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VAULT = os.path.dirname(ROOT)
BB = os.path.join(VAULT, "harmonia-astro", "telegram-companion", "doctrinal-backbone.md")
GL = os.path.join(VAULT, "Harmonia", "Glossary of Terms.md")
MAX = 650   # characters a statement may run to before it is cut at a sentence


def plain(t):
    t = re.sub(r"\[\[[^\]|]*\|([^\]]+)\]\]", r"\1", t)          # [[x|label]] → label
    t = re.sub(r"\[\[(?:[^\]#]*#)?([^\]]+)\]\]", r"\1", t)       # [[x#y]] → y
    t = re.sub(r"\[([^\]]+)\]\((?:https?:)?[^)]+\)", r"\1", t)   # [label](url) → label
    return re.sub(r"\s+", " ", t).strip()


def cut(text):
    """A paragraph whole if short, else runs of sentences up to MAX characters."""
    if len(text) <= MAX: return [text]
    sents = re.split(r"(?<=[.;:!?])\s+(?=[A-Z*\"“(])", text)
    out, cur = [], ""
    for s in sents:
        if cur and len(cur) + 1 + len(s) > MAX: out.append(cur); cur = s
        else: cur = (cur + " " + s).strip()
    if cur: out.append(cur)
    return out


def backbone_units(path):
    s = open(path, encoding="utf-8").read()
    s = s.split("\n---\n", 1)[1] if "\n---\n" in s else s          # the preamble above the first rule
    units, h2, h3 = [], "", ""
    for block in re.split(r"\n\s*\n", s):
        b = block.strip()
        if not b or b == "---" or b.startswith("*Document version"): continue
        if b.startswith("## "): h2, h3 = b[3:].strip(), ""; continue
        if b.startswith("### "):
            first, _, rest = b.partition("\n"); h3 = first[4:].strip(); b = rest.strip()
            if not b: continue
        place = " › ".join(x for x in (h2, h3) if x)
        lines = b.split("\n")
        if all(l.lstrip().startswith(("- ", "1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9.")) or l.startswith("  ") for l in lines):
            items, cur = [], ""
            for l in lines:
                if re.match(r"\s*(- |\d+\.)", l) and not l.startswith("  "):
                    if cur: items.append(cur)
                    cur = re.sub(r"^\s*(- |\d+\.\s*)", "", l)
                else: cur += " " + l.strip()
            if cur: items.append(cur)
        else:
            items = [b]
        for it in items:
            for piece in cut(plain(it)):
                units.append(("Backbone · " + place, piece))
    return units


def glossary_units(path):
    s = open(path, encoding="utf-8").read()
    units = []
    for m in re.finditer(r"^## (.+?)\n(.*?)(?=^## |\Z)", s, re.S | re.M):
        term, body = m.group(1).strip(), m.group(2)
        paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip() and p.strip() != "---" and not p.strip().startswith("#")]
        if not paras: continue
        text = plain(paras[0])
        if len(text) < 200 and len(paras) > 1: text = text + " " + plain(paras[1])
        for piece in cut(text)[:2]:
            units.append(("Glossary · " + term, piece))
    return units


def main():
    bb = sys.argv[sys.argv.index("--backbone") + 1] if "--backbone" in sys.argv else BB
    units = backbone_units(bb) + glossary_units(GL)
    articles, chunks = [], []
    for i, (place, text) in enumerate(units):
        sid = ("bb" if place.startswith("Backbone") else "gl") + "-" + hashlib.sha1(text.encode()).hexdigest()[:8]
        x = text
        articles.append({"p": sid, "t": place, "u": "", "l": "canon", "x": x})
        chunks.append([i, "", 0, len(x)])
    v = re.search(r"Document version:\s*([^\s—]+)", open(bb, encoding="utf-8").read())
    out = {"backbone": v.group(1) if v else None, "articles": articles, "chunks": chunks}
    os.makedirs(os.path.join(ROOT, "canon"), exist_ok=True)
    json.dump(out, open(os.path.join(ROOT, "canon", "statements.json"), "w"), ensure_ascii=False, indent=0)
    nb = sum(1 for p, _ in units if p.startswith("Backbone"))
    print(f"{len(units)} statements: {nb} from backbone {out['backbone']}, {len(units) - nb} from the Glossary; "
          f"median {sorted(len(t) for _, t in units)[len(units) // 2]} characters")


if __name__ == "__main__":
    main()
