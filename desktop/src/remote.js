// remote.js — Lodestone thinking with a model the practitioner rents, under their own API key.
//
// For the practitioner whose computer cannot hold a model, or who wants a
// frontier model's depth. Everything else stays where it was: the corpus, the
// retrieval, the crisis gate, witness mode, the memory and the practices live
// on this computer and run here, exactly as with the bundled engine. Only the
// assembled context of each turn leaves, to the provider the practitioner
// chose, and comes back as text.
//
// The window's Lodestone and the library's companion both speak OpenAI's
// chat-completions shape to /v1 on the app's own origin. This module answers
// that shape: an OpenAI-compatible provider (OpenRouter, Venice, any other)
// gets the request as is, with the key; Anthropic gets it translated to its
// Messages API, so the doctrinal backbone can be cached and each turn costs a
// fraction of its first.
//
// The key is kept encrypted by the operating system's keychain (main.js). It
// is sent to the provider it belongs to and to nothing else.

// The models hosted Lodestone offers on harmonism.io and Telegram, each passed
// through the doctrinal-fidelity suite on the current backbone. Kept in step by
// hand with the server's llm-models.php: the app checks nothing by itself, so the list ships with it.
//   reasoning "none" asks the provider to answer without deliberating;
//   "low" / "medium" / "high" ask for that much deliberation;
//   ""  leaves reasoning on, for models whose providers make it mandatory,
//       with minTokens as the floor so the reasoning does not eat the answer.
const RECOMMENDED = [
  { id: "deepseek/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash", maker: "DeepSeek", licence: "MIT", reasoning: "medium", minTokens: 16000, note: "The default on harmonism.io" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra", maker: "NVIDIA", licence: "OpenMDW 1.1", reasoning: "none", minTokens: 0, note: "" },
];
// Ids that left the tested list for a successor. A saved choice of one is
// moved at launch (main.js); until then, and for any copy that escaped the move,
// it runs as its successor, so it never loses the reasoning cap and token floor.
const RETIRED = { "deepseek/deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash-1017" };
const current = id => RETIRED[String(id || "").trim()] || id;
const recommendedFor = id => RECOMMENDED.find(m => m.id === current(id)) || null;

// Closed-weight models are never listed (October 26, 2026): they drift from the
// doctrine and their weights are not published. A practitioner may still type one
// under their own key, and assess() labels it "closed weights · not tested
// against the doctrine". Kept empty, and identical to app/js/phone.js.
const OFFERED = [];
const offeredFor = id => OFFERED.find(m => m.id === String(id || "").trim()) || null;
// How a turn is run: a recommended model's settings, else an offered one's.
const profileFor = id => recommendedFor(id) || offeredFor(id);
// A model typed under one's own key has no profile, and may deliberate by default
// (Claude Opus with adaptive thinking): the page's 1,200-token cap then holds the
// reasoning and the answer together, and the reasoning eats it. A cap is a ceiling,
// not a charge: only the tokens written are billed.
const UNTESTED_FLOOR = 16000;
// v107: "More info" in the model window; the same text as app/js/phone.js MODEL_INFO
// (fidelity suite of October 24, 2026: $0.0009 an answer against $0.2092 for Claude Opus 5.5).
const MODEL_INFO = { "deepseek/deepseek-v4.1-flash-1017": "About a tenth of a cent an answer, some forty times less than Claude Opus 5.5 on the same questions (about 4 cents an answer, and 21 to 25 cents for a conversation\u2019s first message), from Lodestone\u2019s own questions on October 24, 2026, at OpenRouter\u2019s prices. Open weights under MIT, and it held the doctrinal backbone in every test. Through OpenRouter, Lodestone sends it only to providers that keep nothing and train on nothing." };
for (const m of RECOMMENDED) if (MODEL_INFO[m.id]) m.info = MODEL_INFO[m.id];
const BUNDLED_RECOMMENDED = RECOMMENDED.map(m => ({ ...m }));
/** A newer list from harmonism.io's model catalog, changed in place. */
function setRecommended(list) { if (Array.isArray(list) && list.length) RECOMMENDED.splice(0, RECOMMENDED.length, ...list.map(m => (MODEL_INFO[m.id] && !m.info ? { ...m, info: MODEL_INFO[m.id] } : m))); }

const PRESETS = {
  // harmonism.io's hosted models under the practitioner's account (hosted.js).
  // Not offered in the provider list: it has its own sign-in box.
  harmonism: {
    label: "harmonism.io account", kind: "hosted", baseUrl: "https://harmonism.io",
    model: "deepseek/deepseek-v4.1-flash-1017", keyHint: "", keyUrl: "", hidden: true,
    note: "Ten messages a day for the first month, then five, in total across harmonism.io, Telegram and this app, on the models hosted Lodestone runs on.",
    recommended: RECOMMENDED,
  },
  anthropic: {
    label: "Anthropic (Claude)", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-5-5", keyHint: "sk-ant-…", keyUrl: "https://console.anthropic.com/settings/keys",
    note: "Commercial API terms: conversations are not used for training and are deleted after 30 days.",
  },
  venice: {
    label: "Venice", kind: "openai", baseUrl: "https://api.venice.ai/api/v1",
    model: "", keyHint: "", keyUrl: "https://venice.ai/settings/api",
    note: "Open-weight models. Some run inside attested confidential hardware, which the provider cannot read.",
  },
  openrouter: {
    label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-v4.1-flash-1017", keyHint: "sk-or-…", keyUrl: "https://openrouter.ai/settings/keys",
    note: "One key for many providers, open-weight and frontier. Each provider keeps its own terms. Any model it lists can be used; the recommended ones are those hosted Lodestone runs on, tested against the doctrine.",
    recommended: RECOMMENDED,
    offered: OFFERED,
  },
  huggingface: {
    label: "Hugging Face", kind: "openai", baseUrl: "https://router.huggingface.co/v1",
    model: "", keyHint: "hf_…", keyUrl: "https://huggingface.co/settings/tokens",
    note: "Open-weight models served by Hugging Face's partner providers (Together, Fireworks, Groq, Novita and others) behind one token. Add :fastest, :cheapest or :preferred to a model id to choose how the provider is picked. Each provider keeps its own terms, and Lodestone cannot ask them to withhold the conversation from training, as it does on OpenRouter.",
  },
  custom: {
    label: "Another OpenAI-compatible provider", kind: "openai", baseUrl: "",
    model: "", keyHint: "", keyUrl: "",
    note: "Any service that speaks the OpenAI chat-completions API.",
  },
};

// The signed-in harmonism.io account (hosted.js), set by main.js.
let hostedClient = null;
function setHosted(h) { hostedClient = h; }

const ANTHROPIC_VERSION = "2023-06-01";
const trimUrl = u => String(u || "").trim().replace(/\/+$/, "");
const hostOf = u => { try { return new URL(u).host; } catch { return u || "the provider"; } };

/** A configuration as saved, made safe to use. `key` is the plain key, held in memory only. */
function normalize(c) {
  if (!c) return null;
  const p = PRESETS[c.preset] || PRESETS.custom;
  return { preset: PRESETS[c.preset] ? c.preset : "custom", kind: p.kind, baseUrl: trimUrl(c.baseUrl || p.baseUrl), model: String(c.model || p.model || "").trim() };
}

function headersFor(c, key) {
  if (c.kind === "anthropic") return { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  if (c.preset === "openrouter") { h["HTTP-Referer"] = "https://harmonism.io/lodestone"; h["X-Title"] = "Lodestone"; }
  return h;
}

async function failure(res) {
  let msg = "";
  try { const j = await res.json(); msg = j.error?.message || j.error || j.message || ""; } catch {}
  if (res.status === 401 || res.status === 403) return new Error("The provider refused the key. Check that it is complete and still active.");
  if (res.status === 402) return new Error("The provider says the account has no credit left.");
  if (res.status === 404) return new Error(`The provider does not know this model${msg ? `: ${msg}` : "."}`);
  if (res.status === 429) return new Error("The provider is limiting requests. Wait a moment and try again.");
  return new Error(`The provider answered ${res.status}${msg ? `: ${String(msg).slice(0, 200)}` : "."}`);
}

/** The models the key can use, for the picker. */
async function listModels(fetchFn, conf, key) {
  const c = normalize(conf);
  if (!c.baseUrl) throw new Error("Give the provider's address first.");
  if (!key) throw new Error("Paste the API key first.");
  const res = await fetchFn(c.baseUrl + "/models" + (c.kind === "anthropic" ? "?limit=100" : ""), { headers: headersFor(c, key) });
  if (!res.ok) throw await failure(res);
  const j = await res.json();
  return (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
}

// ─── OpenAI request → Anthropic Messages ──────────────────────────────────────

/**
 * Lodestone's system message is stable down to its <temporal> line (persona,
 * backbone, what the practitioner wrote about themselves) and changes after it
 * (retrieval, witness, governor). The stable part is marked for caching.
 */
function anthropicBody(o, model) {
  const sys = (o.messages || []).filter(m => m.role === "system").map(m => String(m.content)).join("\n\n");
  // OpenAI content parts → Anthropic blocks: text stays text, an image sent as
  // a data URL becomes a base64 image block (attachments, app/js/attach.js).
  const blocks = c => {
    if (typeof c === "string") return c ? [{ type: "text", text: c }] : [];
    const out = [];
    for (const p of c || []) {
      if (p.type === "text" && p.text) out.push({ type: "text", text: p.text });
      else if (p.type === "image_url") {
        const m = String(p.image_url?.url || "").match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/);
        if (m) out.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      }
    }
    return out;
  };
  const turns = [];
  for (const m of o.messages || []) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const b = blocks(m.content);
    if (!b.length) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.content.push(...b);   // Anthropic requires alternation
    else turns.push({ role: m.role, content: b });
  }
  // A turn of text alone goes as a plain string, as before.
  for (const t of turns) if (t.content.every(x => x.type === "text")) t.content = t.content.map(x => x.text).join("\n\n");
  while (turns.length && turns[0].role !== "user") turns.shift();
  const cut = sys.indexOf("\n\n<temporal>");
  const system = sys
    ? cut > 0
      ? [{ type: "text", text: sys.slice(0, cut), cache_control: { type: "ephemeral" } }, { type: "text", text: sys.slice(cut + 2) }]
      : [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }]
    : undefined;
  const temperature = Math.max(0, Math.min(1, typeof o.temperature === "number" ? o.temperature : 0.7));
  return { model, max_tokens: o.max_tokens || 1200, temperature, stream: true, system, messages: turns };
}

/** Anthropic's event stream, re-emitted as OpenAI chat-completion chunks. */
function translateStream(body) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const chunk = text => enc.encode(`data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
  return new ReadableStream({
    async start(ctrl) {
      const reader = body.getReader();
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
            let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) ctrl.enqueue(chunk(ev.delta.text));
            else if (ev.type === "error") ctrl.enqueue(chunk(`\n\n(The provider stopped: ${ev.error?.message || "an error"}.)`));
          }
        }
      } catch { /* the page closed the conversation */ }
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
      ctrl.close();
    },
    cancel() { try { body.cancel(); } catch {} },
  });
}

/**
 * One turn. `o` is the OpenAI-shaped request the page sent. Resolves to a
 * fetch Response whose body is OpenAI-shaped server-sent events.
 */
// v107: OpenRouter's public list of models, read once in the main process: whether a
// model takes a reasoning setting (supported_parameters) and the most it may write, as
// app/js/phone.js reads it in the page. Never awaited longer than three seconds.
let orMetaP = null;
function orMeta(fetchFn) {
  if (!orMetaP) orMetaP = fetchFn("https://openrouter.ai/api/v1/models").then(r => r.ok ? r.json() : null).then(j => {
    const m = new Map();
    for (const x of j?.data || []) if (x.id) m.set(x.id, { thinks: Array.isArray(x.supported_parameters) ? x.supported_parameters.includes("reasoning") : null, maxOut: Number(x.top_provider?.max_completion_tokens) || null });
    return m;
  }).catch(() => { orMetaP = null; return new Map(); });
  return Promise.race([orMetaP, new Promise(r => setTimeout(() => r(new Map()), 3000))]);
}
// Prompt caching for Claude through OpenRouter, cut where anthropicBody cuts it: before <temporal>.
function cacheBreak(model, messages) {
  if (!/^anthropic\//.test(model) || !Array.isArray(messages)) return messages;
  const i = messages.findIndex(m => m.role === "system" && typeof m.content === "string" && m.content.includes("</doctrinal_backbone>"));
  if (i < 0) return messages;
  const s = messages[i].content, t = s.indexOf("\n\n<temporal>");
  const cut = t > 0 ? t : s.indexOf("</doctrinal_backbone>") + "</doctrinal_backbone>".length;
  const content = [{ type: "text", text: s.slice(0, cut), cache_control: { type: "ephemeral" } }];
  if (s.slice(cut).trim()) content.push({ type: "text", text: s.slice(cut) });
  return messages.map((m, k) => (k === i ? { ...m, content } : m));
}

async function chat(fetchFn, conf, key, o, signal) {
  const c = normalize(conf);
  if (c.kind === "hosted") {
    if (!hostedClient) throw new Error("Sign in to your harmonism.io account first.");
    return hostedClient.chat(o, c.model, signal);
  }
  if (!key) throw new Error("No API key is saved. Open the Lodestone menu → Model… to add one.");
  if (!c.model) throw new Error("No model is chosen. Open the Lodestone menu → Model… to choose one.");
  if (c.kind === "anthropic") {
    const res = await fetchFn(c.baseUrl + "/messages", { method: "POST", headers: headersFor(c, key), body: JSON.stringify(anthropicBody(o, c.model)), signal });
    if (!res.ok) throw await failure(res);
    return new Response(translateStream(res.body), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  const { chat_template_kwargs, lodestone: lo = {}, ...rest } = o;   // the bundled engine's switch, unknown elsewhere; Lodestone's turn settings (v107, app/js/engine.js)
  const isOR = c.preset === "openrouter";
  // The hybrid's light turns name their own model; only on OpenRouter, where both live.
  const model = isOR ? current(lo.model || c.model) : c.model;
  const body = { ...rest, model, stream: true };
  const meta = isOR ? (await orMeta(fetchFn)).get(model) || {} : {};
  const exclude = !lo.thinking;
  if (isOR) body.messages = cacheBreak(model, body.messages);
  if (isOR && lo.classify) {   // the hybrid's one-word classifier
    body.max_tokens = 16; body.temperature = 0;
    if (meta.thinks) body.reasoning = { effort: "none", exclude: true };
    body.provider = { data_collection: "deny" };
    const res = await fetchFn(c.baseUrl + "/chat/completions", { method: "POST", headers: headersFor(c, key), body: JSON.stringify(body), signal });
    if (!res.ok) throw await failure(res);
    return res;
  }
  // The page asks for the turn's usage (stream_options); OpenRouter adds its cost
  // in dollars when asked this way, for the conversation's running total.
  if (c.preset === "openrouter") body.usage = { include: true };
  // A recommended model on OpenRouter runs as hosted Lodestone runs it: reasoning off
  // where the provider allows it, a token floor where reasoning is mandatory, and
  // only providers that do not keep the conversation for training.
  const r = isOR ? profileFor(model) : null;
  if (r) {
    if (r.reasoning === "none") body.reasoning = { effort: "none", exclude: true };
    else if (/^(low|medium|high)$/.test(r.reasoning)) body.reasoning = { effort: r.reasoning, exclude };
    else body.reasoning = { exclude };
    if (r.minTokens && (body.max_tokens || 0) < r.minTokens) body.max_tokens = r.minTokens;
  } else if (isOR) {
    if ((body.max_tokens || 0) < UNTESTED_FLOOR) body.max_tokens = UNTESTED_FLOOR;
    // v107: whether the model thinks is read from OpenRouter's list, Anthropic's name the
    // fallback; medium for a turn that needs depth, low for a light turn and background work.
    if (meta.thinks ?? /^anthropic\//.test(model)) body.reasoning = { effort: lo.background || lo.depth === "light" ? "low" : "medium", exclude };
  }
  if (isOR && lo.lighter) {   // the second try of a turn whose thinking spent the cap
    body.reasoning = { effort: "low", exclude };
    const twice = 2 * (body.max_tokens || UNTESTED_FLOOR);
    body.max_tokens = Math.max(body.max_tokens || 0, meta.maxOut ? Math.min(meta.maxOut, twice) : twice);
  }
  // v107: every OpenRouter model, tested or not, only through providers that do not keep
  // the conversation or train on it (before, tested models alone).
  if (isOR) body.provider = { data_collection: "deny" };
  const res = await fetchFn(c.baseUrl + "/chat/completions", { method: "POST", headers: headersFor(c, key), body: JSON.stringify(body), signal });
  if (!res.ok) throw await failure(res);
  return res;
}

/** A short, real request, to prove the key and the model before they are saved. */
async function test(fetchFn, conf, key) {
  const res = await chat(fetchFn, conf, key, { messages: [{ role: "user", content: "Reply with the single word: ready" }], max_tokens: 10, temperature: 0 });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value).split("\n")) {
      const p = line.replace(/^data:\s*/, "").trim();
      if (!p || p === "[DONE]") continue;
      try { out += JSON.parse(p).choices?.[0]?.delta?.content || ""; } catch {}
    }
  }
  if (!out.trim()) throw new Error("The provider answered, but with nothing. Try another model.");
  return out.trim();
}

// Closed-weight models: everything Anthropic serves, and the closed families
// under OpenAI, xAI and Google ids. OpenAI's gpt-oss and Google's Gemma are
// open-weight and stay unmarked. Kept identical to launcher.js's copy.
const CLOSED_ID = /^(anthropic\/|x-ai\/|claude|grok|o\d)|^(openai\/)?(gpt-(?!oss)|chatgpt|o\d)|^(google\/)?gemini/i;
/** How Lodestone regards a rented model: tested with the doctrine, or not; closed weights, or not. */
function assess(preset, id) {
  id = String(id || "").trim();
  const tested = (preset === "openrouter" || preset === "harmonism") && !!recommendedFor(id);
  const closed = preset === "anthropic" || CLOSED_ID.test(id);
  const offered = !tested && preset === "openrouter" && !!offeredFor(id);
  const note = tested ? "tested with Lodestone" : offered ? "not recommended · doctrinal fidelity" : closed ? "closed weights · not tested against the doctrine" : "not tested against the doctrine";
  return { tested, closed, offered, note };
}

module.exports = { cacheBreak, RETIRED, assess, setHosted, PRESETS, RECOMMENDED, OFFERED, BUNDLED_RECOMMENDED, setRecommended, normalize, hostOf, listModels, chat, test, anthropicBody };
