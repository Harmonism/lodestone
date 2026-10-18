// retrieval.js — hybrid retrieval over the on-device corpus.
//   1. BM25 keyword search with production's synonym expansion (companion-rag.php)
//   2. Semantic search over precomputed multilingual-e5-small vectors (optional)
//   3. Rank fusion weighted 0.7 semantic / 0.3 keyword, as in production.
// Nothing here touches the network.

const K1 = 1.2, B = 0.75;
const SEM_W = 0.7, KW_W = 0.3, RRF_K = 60;

const norm = s => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const words = s => norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");

function stem(w) {
  // Conservative English suffix folding, applied identically to query and corpus.
  if (w.length <= 4) return w;
  if (w.endsWith("ies") && w.length > 5) return w.slice(0, -3) + "y";
  if (w.endsWith("ing") && w.length > 6) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 5) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 5 && /(ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

/** Does the message ask to read an article in full ("read the whole article", "the full text of …", "in full")? */
export const wantsWhole = text =>
  /\b(whole|entire|full|complete)\s+(text|article|paper|piece|essay|thing)\b|\b(read|show|give|bring|pull)\b[^.?!]{0,40}\b(in full|in its entirety|end to end|from start to finish|all of it)\b|\bin full\b|\bend to end\b/i.test(text || "");

/** Does the message point back at the conversation rather than name a topic ("your last message", "that article", "review it")? */
export const isFollowUp = text =>
  /\b(your|the)\s+(last|previous|earlier|above)\s+(message|reply|answer|response)\b|\b(that|this|the)\s+(article|piece|paper|passage|section)\b|\b(review|revise|redo|rewrite|continue|elaborate|expand)\s+(on\s+)?(that|it|this|your|the)\b/i.test(text || "") || wantsWhole(text);

export class Retriever {
  constructor({ corpus, runtime, embeddings }) {
    this.articles = corpus.articles;
    this.chunks = corpus.chunks;
    this.stop = new Set(runtime.retrieval.stop_words);
    this.syn = runtime.retrieval.synonyms;
    this.emb = embeddings;
    this.embedQuery = null; // async (text) => Float32Array, set when semantic is ready
    this._build();
  }

  tokens(text) {
    const out = [];
    for (const raw of norm(text).split(/[^\p{L}\p{N}]+/u)) {
      if (raw.length < 3 || this.stop.has(raw)) continue;
      out.push(stem(raw));
    }
    return out;
  }

  _build() {
    const t0 = performance.now();
    const N = this.chunks.length;
    this.len = new Float32Array(N);
    const post = new Map(); // term -> [chunkIdx, tf, chunkIdx, tf, ...]
    let total = 0;
    const titleTok = this.articles.map(a => this.tokens(a.t));
    for (let i = 0; i < N; i++) {
      const [a, h, s, e] = this.chunks[i];
      const toks = this.tokens(h + " " + this.articles[a].x.slice(s, e));
      // title terms count double: an article's title is its strongest claim of topic
      for (const t of titleTok[a]) toks.push(t, t);
      this.len[i] = toks.length; total += toks.length;
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, f] of tf) {
        let p = post.get(t);
        if (!p) post.set(t, (p = []));
        p.push(i, f);
      }
    }
    this.post = post;
    this.avg = total / Math.max(1, N);
    // Titles a practitioner can ask for by name: the part before " — ", as
    // whole words, and only with two topic words or more, so that "Water" or
    // "Love" never takes over an ordinary question.
    this.first = new Map(); // article -> its first chunk with content
    for (let i = N - 1; i >= 0; i--) if (!this._stub(i)) this.first.set(this.chunks[i][0], i);
    this.named = [];
    this.articles.forEach((a, i) => {
      const t = a.t.split(" — ")[0];
      if (this.tokens(t).length >= 2 && this.first.has(i)) this.named.push([" " + words(t) + " ", i]);
    });
    this.buildMs = Math.round(performance.now() - t0);
  }

  _expand(query) {
    const base = this.tokens(query);
    const terms = new Map();
    for (const t of base) terms.set(t, Math.max(terms.get(t) || 0, 1));
    for (const w of norm(query).split(/[^\p{L}\p{N}]+/u)) {
      const s = this.syn[w];
      if (!s) continue;
      for (const x of s.split(" ")) {
        const st = stem(x);
        if (!terms.has(st)) terms.set(st, 0.5);
      }
    }
    return terms;
  }

  bm25(query, limit = 60) {
    const terms = this._expand(query);
    const N = this.chunks.length;
    const scores = new Map();
    for (const [t, qw] of terms) {
      const p = this.post.get(t);
      if (!p) continue;
      const df = p.length / 2;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let j = 0; j < p.length; j += 2) {
        const i = p[j], f = p[j + 1];
        const s = idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * this.len[i] / this.avg));
        scores.set(i, (scores.get(i) || 0) + qw * s);
      }
    }
    // gentle priority prior from index-vault's compute_weight (canon > bridge > applied)
    const out = [];
    for (const [i, s] of scores) out.push([i, s * (1 + 0.02 * (this.articles[this.chunks[i][0]].w || 0))]);
    out.sort((x, y) => y[1] - x[1]);
    return out.slice(0, limit);
  }

  /** Articles whose title the text names, longest title first (indexes into `articles`). */
  asked(text) {
    const nq = " " + words(text) + " ";
    return this.named.filter(([t]) => nq.includes(t)).sort((x, y) => y[0].length - x[0].length).map(([, a]) => a);
  }

  /** An orientation line on its own ("*Sub-article of …*"): no heading, short, italic. It carries no content. */
  _stub(i) {
    const [a, h, s, e] = this.chunks[i];
    if (h) return false;
    const t = this.articles[a].x.slice(s, e).trim();
    return t.length < 300 && /^\*[^*]/.test(t);   // 300: build-corpus.py's LEADIN_MAX
  }

  /** Does the query contain a term rare enough to stand on its own? */
  _isSpecific(query) {
    const N = this.chunks.length;
    for (const t of this.tokens(query)) {
      const p = this.post.get(t);
      if (p && p.length / 2 <= N * 0.02) return true;
    }
    return false;
  }

  async semantic(query, limit = 60) {
    if (!this.emb || !this.embedQuery) return [];
    const qv = await this.embedQuery(query);
    const { q, scales, meta } = this.emb;
    const D = meta.dims, N = meta.count;
    const out = new Array(N);
    for (let i = 0; i < N; i++) {
      let dot = 0; const o = i * D;
      for (let d = 0; d < D; d++) dot += q[o + d] * qv[d];
      out[i] = [i, dot * scales[i]];
    }
    out.sort((x, y) => y[1] - x[1]);
    return out.slice(0, limit);
  }

  /**
   * Retrieve for a practitioner turn.
   * @param {string} query current message
   * @param {object} opt { k, maxChars, perArticle, context } context = previous user message, used when the
   *   current one is a short follow-up with no topic words (production's conversation-continuity gap).
   */
  async retrieve(query, { k = 3, maxChars = 4200, perArticle = 2, context = "", follow = false } = {}) {
    // A short question is usually a follow-up ("why?", "and then?") that only
    // makes sense with the previous turn attached. But a short question can also
    // be completely specific — "Explain Tawhid." is two tokens — and attaching
    // the previous turn then hands the whole query to the previous topic: asked
    // after a question about hydration, "Explain Tawhid." retrieved five
    // hydration passages and nothing about Tawhid. So context is attached only
    // when the query carries no distinctive term of its own.
    let q = query;
    if (context && (follow || (this.tokens(query).length < 3 && !this._isSpecific(query)))) q = context + " " + query;
    const [kw, sem] = await Promise.all([
      this.bm25(q),
      this.semantic(q).catch(e => { this.semanticError = String(e && e.message || e); return []; }),
    ]);
    const fused = new Map();
    kw.forEach(([i], r) => fused.set(i, (fused.get(i) || 0) + KW_W / (RRF_K + r)));
    sem.forEach(([i], r) => fused.set(i, (fused.get(i) || 0) + SEM_W / (RRF_K + r)));
    // keyword-only mode: fall back to raw BM25 order
    let ranked = [...fused].sort((a, b) => b[1] - a[1]).map(([i]) => i);

    // An article asked for by name opens the list with its own opening passage;
    // the longest title named wins, at most two articles.
    const asked = this.asked(query).slice(0, 2);
    if (asked.length) ranked = [...asked.map(a => this.first.get(a)), ...ranked];

    const perArt = new Map(); const seen = new Set(); const picked = []; let chars = 0;
    for (const i of ranked) {
      if (seen.has(i)) continue;
      seen.add(i);
      const [a, h, s, e] = this.chunks[i];
      if ((perArt.get(a) || 0) >= perArticle) continue;
      if (this._stub(i)) continue;
      const text = this.articles[a].x.slice(s, e).trim();
      if (chars + text.length > maxChars && picked.length) continue;
      perArt.set(a, (perArt.get(a) || 0) + 1);
      picked.push({ chunk: i, article: a, heading: h, text });
      chars += text.length;
      if (picked.length >= k) break;
    }
    return { hits: picked, mode: sem.length ? "hybrid" : "keyword" };
  }

  /** Format hits as the <vault_knowledge> block. */
  format(hits) {
    if (!hits.length) return "";
    const parts = hits.map((h, n) => {
      const a = this.articles[h.article];
      return `[${n + 1}] "${a.t}"${h.heading ? ` — ${h.heading}` : ""}${a.l === "canon" ? " (canonical)" : ""}\nURL: ${a.u}\n${h.text.replace(/^#{1,6}\s+/gm, "")}`;
    });
    return `<vault_knowledge>\nExcerpts from Harmonism articles stored on this device, retrieved for the practitioner's latest message. These articles exist; cite them by title.\n\n${parts.join("\n\n")}\n</vault_knowledge>`;
  }

  /** Title search for the library. */
  searchArticles(query, limit = 40) {
    if (!query.trim()) return [];
    const hits = this.bm25(query, 200);
    const seen = new Map();
    for (const [i, s] of hits) {
      const a = this.chunks[i][0];
      seen.set(a, Math.max(seen.get(a) || 0, s));
    }
    const nq = norm(query);
    for (let a = 0; a < this.articles.length; a++) {
      if (norm(this.articles[a].t).includes(nq)) seen.set(a, (seen.get(a) || 0) + 100);
    }
    return [...seen].sort((x, y) => y[1] - x[1]).slice(0, limit).map(([a]) => a);
  }
}
