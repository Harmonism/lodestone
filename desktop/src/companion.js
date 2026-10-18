// companion.js — the Lodestone on the library's pages, answered by this computer.
//
// On harmonism.io, the small companion in the corner of every page posts to
// /companion-api.php and reads back a stream. In the app the same pages are
// served from here, so the same request reaches this module instead, and the
// local model answers it with the same safeguards and the same corpus as the
// Lodestone window: the crisis gate first (no model sees a crisis message), then
// retrieval, the witness and governor blocks, and the full doctrinal backbone.
// The page the practitioner is reading goes in as context.
//
// The reply is streamed in the shape the page already understands (Anthropic
// content_block_delta events), so the site's own script needs no change.
//
// The logic lives in the web app's modules (app/js/*.js) and is imported from
// there, so the two companions cannot drift apart.

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const TIER = { backbone: "full", ctx: 32768, maxTokens: 1200, rag: { k: 5, maxChars: 12000 } };

class Companion {
  /** @param {{ webRoot: string, corpusRoot: () => string, upstream: () => { url: string|null, isEngine: boolean, remote?: boolean, where?: string|null } }} o */
  constructor({ webRoot, corpusRoot, upstream }) {
    this.webRoot = webRoot; this.corpusRoot = corpusRoot; this.upstream = upstream;
    this.mods = null; this.pack = null; this.recent = []; this.modelName = null;
  }

  async modules() {
    if (this.mods) return this.mods;
    const imp = f => import(pathToFileURL(path.join(this.webRoot, "js", f)).href);
    const [safety, retrieval, prompt] = await Promise.all([imp("safety.js"), imp("retrieval.js"), imp("prompt.js")]);
    return (this.mods = { ...safety, ...retrieval, ...prompt });
  }

  /** The corpus, read once and read again only when an update changed it. */
  async load() {
    const root = this.corpusRoot();
    const runtime = JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8"));
    const key = root + ":" + runtime.pack.corpus_hash;
    if (this.pack?.key === key) return this.pack;
    const { Retriever } = await this.modules();
    const corpus = JSON.parse(fs.readFileSync(path.join(root, "corpus.json"), "utf8"));
    // Keyword retrieval with production's synonyms. The window's Lodestone adds
    // semantic search in its own page; here there is no page to run it in.
    const retriever = new Retriever({ corpus, runtime, embeddings: null });
    return (this.pack = { key, runtime, corpus, retriever });
  }

  /** The model name to ask for: the bundled engine is "lodestone"; a server of the practitioner's own names its models. */
  async model(up) {
    if (up.isEngine || up.remote) return "lodestone";   // the bundled engine, or a rented model behind /v1
    if (this.modelName) return this.modelName;
    try {
      const j = await (await fetch(up.url + "/models")).json();
      this.modelName = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean)[0] || "lodestone";
    } catch { this.modelName = "lodestone"; }
    return this.modelName;
  }

  /**
   * Answer one request from the page. `body` is what the site's script posts:
   * { messages, lang, pageContext, pageDomain, pageTitle, pageUrl, anonymous }.
   */
  async handle(body, req, res) {
    const sse = () => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    };
    const emit = text => res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`);
    const json = (status, o) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };

    const msgs = (Array.isArray(body?.messages) ? body.messages : [])
      .filter(m => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
      .slice(-20).map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "user" || !last.content.trim()) return json(400, { error: "Nothing to answer." });
    const text = last.content.trim();
    const history = msgs.slice(0, -1);

    const up = this.upstream();
    if (!up.url) return json(503, { error: "Lodestone's model is not running. Open the Lodestone menu → Model… to start it." });

    let m, pack;
    try { m = await this.modules(); pack = await this.load(); }
    catch (e) { return json(500, { error: "The corpus could not be read: " + e.message }); }
    const { runtime, retriever } = pack;

    const pageLang = String(body.lang || "").slice(0, 2);
    const lang = m.detectLang(text, ["en", "fr", "es", "ar"].includes(pageLang) && pageLang !== "en" ? pageLang : "auto");

    // 1 — the crisis gate. A template, never the model.
    const crisis = m.detectCrisis(text, lang, runtime.crisis);
    if (crisis) {
      sse();
      emit(m.buildCrisisResponse(crisis.category, null, crisis.lang || lang, runtime.crisis));
      res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      return res.end();
    }

    // 2 — retrieval, with the previous question as context for a bare follow-up
    const prevUser = [...history].reverse().find(h => h.role === "user")?.content || "";
    let { hits } = await retriever.retrieve(text, { ...TIER.rag, context: prevUser });

    // 3 — the page being read, witness, governor
    const now = Date.now();
    this.recent = this.recent.filter(t => now - t < 864e5); this.recent.push(now);
    const w = m.detectWitness(text, lang, runtime.witness);
    const title = String(body.pageTitle || "").slice(0, 200);
    const pageCtx = String(body.pageContext || "").slice(0, 2600);
    const page = title || pageCtx
      ? `<page_context>\nThe practitioner is reading a page of the Harmonism library on this computer${title ? `: "${title}"` : ""}${body.pageUrl ? ` (${String(body.pageUrl).slice(0, 200)})` : ""}. Their question may be about it.\n${pageCtx}\n</page_context>`
      : "";
    let system, fitted;
    for (;;) {
      system = m.buildSystem({ tier: TIER, runtime, person: {}, where: up.where || null, turn: {
        page, vault: retriever.format(hits),
        witness: w ? m.witnessBlock(w.strength) : "",
        governor: m.governorBlock(this.recent.length),
      } });
      fitted = m.fitMessages({ system, history, current: text, tier: TIER });
      const over = m.estTokens(system) + m.estTokens(text) > TIER.ctx - TIER.maxTokens - 64;
      if (!over || !hits.length) break;
      hits = hits.slice(0, -1);
    }

    // 4 — the model, streamed back in the page's format
    const ctrl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });
    let upRes;
    try {
      const payload = { model: await this.model(up), messages: fitted.messages, stream: true, temperature: 0.7, top_p: 0.8, presence_penalty: 1.0, max_tokens: TIER.maxTokens };
      if (up.isEngine) payload.chat_template_kwargs = { enable_thinking: false };
      upRes = await fetch(up.url + "/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctrl.signal,
      });
    } catch (e) {
      return json(502, { error: "Lodestone's model could not be reached. It may still be waking; try again in a moment." });
    }
    if (!upRes.ok) return json(502, { error: `Lodestone's model answered ${upRes.status}.` });

    sse();
    const reader = upRes.body.getReader(); const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const p = line.slice(5).trim();
          if (p === "[DONE]") continue;
          try { const d = JSON.parse(p).choices?.[0]?.delta?.content; if (d) emit(d); } catch {}
        }
      }
    } catch { /* the page closed the conversation */ }
    if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`); res.end(); }
  }
}

module.exports = { Companion };
