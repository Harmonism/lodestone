// engine.js — where Lodestone thinks.
//   server: any OpenAI-compatible endpoint the practitioner runs (Lodestone Desktop, Ollama, LM Studio, llama.cpp, vLLM).
//   hosted / openrouter: a rented model tested against the doctrine (phone.js).
//   reader: no model; the passages themselves.
// No telemetry.
//
// Thinking inside the browser (WebLLM, Qwen3-8B and OLMo-2-7B) was withdrawn on
// 25 October 2026: no model a browser can hold carries the full doctrinal
// backbone with room left for the conversation, and the compressed backbone it
// ran on was retired with it. One backbone, everywhere Lodestone speaks.

// The stream reader lives apart so a page that never runs a model on the
// device (website Lodestone, held.js) need not load an engine to read a stream.
import { readSSE, providerError, stripThink, normUsage } from "./sse.js";
export { readSSE, providerError, normUsage };

// No model runs inside the browser any more (see the head of this file). The
// table stays, empty, for the code that still asks it.
export const MODELS = {};

// The window each route gives Lodestone. A rented model tested against the
// doctrine takes 65,536 tokens: the backbone, the turn's passages and a long
// conversation, at a fraction of a cent a turn. A model the practitioner runs
// keeps 32,768 unless they set more: its memory, not its price, is the limit.
// main.js (windowFor) lowers a rented model that was not tested to 32,768.
export const RENTED_CTX = 65536, OWNED_CTX = 32768;

export const TIERS = {
  server: {
    label: "My computer's model server", sub: "Lodestone Desktop, Ollama, LM Studio or llama.cpp on a machine you own. Larger models, the full doctrinal backbone, and nothing leaves your own network.",
    engine: "openai", models: [], ctx: OWNED_CTX,
    backbone: "full", rag: { k: 5, maxChars: 12000 }, maxTokens: 1200,
  },
  // The two routes for a phone with no computer behind it (phone.js).
  // "server" backbone: harmonism.io puts its own doctrinal backbone in place of
  // a placeholder, so the phone does not send 80 KB with every message.
  hosted: {
    label: "My harmonism.io account", sub: "Ten free messages a day in total across harmonism.io, Telegram and Lodestone's apps, with DeepSeek V4.1 Flash or another open-weight model tested against the doctrine. harmonism.io reads each message. For no daily limit, use your own OpenRouter key.",
    engine: "hosted", models: [], ctx: RENTED_CTX,
    backbone: "server", rag: { k: 5, maxChars: 12000 }, maxTokens: 1200,
  },
  openrouter: {
    label: "OpenRouter, with my own key", sub: "No daily limit; you pay OpenRouter for what you use. The same models hosted Lodestone runs on, tested against the doctrine, or any other OpenRouter lists. OpenRouter reads each message.",
    engine: "openrouter", models: [], ctx: RENTED_CTX,
    backbone: "full", rag: { k: 5, maxChars: 12000 }, maxTokens: 1200,
  },
  // No model at all (TODO, corpus-only tier): the crisis gate and retrieval
  // still run, and a question is answered with the passages that bear on it.
  reader: {
    label: "No model: read and search", sub: "The whole corpus on this device, with no network and no model. A question brings back the passages that bear on it, and every article opens offline.",
    engine: "none", models: [], ctx: OWNED_CTX,
    backbone: "full", rag: { k: 6, maxChars: 9000 }, maxTokens: 0,
  },
};

// iPadOS reports itself as MacIntel, hence the touch-point test.
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Phone or tablet. */
export const isHandheld = () => isIOS() || /Android|Mobile/i.test(navigator.userAgent) ||
  Math.min(screen.width, screen.height) < 700;

// A computer rather than a phone or tablet. (The name is older than the
// withdrawal of in-browser thinking; what it tells the setup screen is still
// true: a handheld reaches a computer the practitioner owns, the account, or
// their own key.)
export const localInferenceAvailable = () => !isHandheld();

/** The model a tier should start with on this device. */
export function defaultModelFor(tierKey) {
  const t = TIERS[tierKey];
  if (!t || t.engine !== "webllm") return null;
  return t.models[0];
}

/** The next smaller model in the tier, or null if this is already the smallest. */
export function smallerModelThan(tierKey, modelKey) {
  const t = TIERS[tierKey];
  if (!t || !MODELS[modelKey]) return null;
  const smaller = t.models.filter(k => MODELS[k].gb < MODELS[modelKey].gb)
    .sort((a, b) => MODELS[b].gb - MODELS[a].gb);
  return smaller[0] || null;
}

export async function probeWebGPU() {
  if (!("gpu" in navigator)) return { ok: false, reason: "This browser has no WebGPU." };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { ok: false, reason: "No usable GPU adapter." };
    const f16 = adapter.features.has("shader-f16");
    const maxBuf = adapter.limits.maxBufferSize;
    let info = {};
    try { info = adapter.info || (await adapter.requestAdapterInfo?.()) || {}; } catch {}
    return { ok: true, f16, maxBuf, vendor: info.vendor || "", arch: info.architecture || "" };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

export function resolveModelId(key, f16) {
  const m = MODELS[key];
  return f16 ? m.id : m.f32;
}


/** An OpenAI-shaped event stream, yielded as the answer so far (thinking stripped). */
// ─── No model (the reading tier) ──────────────────────────────────────────────

export class ReaderEngine {
  constructor(tier) { this.tier = tier; this.kind = "reader"; }
  async isCached() { return true; }
  async load() {}
  async *stream() { throw new Error("No model is in use."); }
  interrupt() {}
  describe() { return "no model · reading the corpus"; }
}

// ─── In-browser thinking: withdrawn ──────────────────────────────────────────

/** Kept so an old setting fails with a sentence, not a crash. */
export class DeviceEngine {
  constructor(tier) { this.tier = tier; this.kind = "device"; }
  async isCached() { return false; }
  async load() { throw new Error("Lodestone no longer thinks inside the browser. Settings → Change where Lodestone thinks."); }
  async *stream() { throw new Error("Lodestone no longer thinks inside the browser."); }
  interrupt() {}
  describe() { return "withdrawn"; }
}

// ─── OpenAI-compatible server (owned hardware) ────────────────────────────────

export class ServerEngine {
  /** headers: async () => extra headers (a paired computer's token); fetchImpl: the home-network fetch of the Android app. */
  constructor(tier, { baseUrl, model, ctx, headers = null, fetchImpl = null, name = null }) {
    this.tier = { ...tier, ctx: ctx || tier.ctx };
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.model = model; this.kind = "server"; this.ctrl = null;
    this.headers = headers; this.fetchImpl = fetchImpl; this.name = name;
  }
  static async test(baseUrl) {
    const url = (baseUrl || "").replace(/\/+$/, "") + "/models";
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`Server answered ${res.status}`);
    const j = await res.json();
    return (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
  }
  async isCached() { return true; }
  async load() {}
  async *stream(messages, { maxTokens, temperature = 0.7, background = false } = {}) {
    const ctrl = new AbortController(); if (background) this.bgUsage = null; else { this.ctrl = ctrl; this.lastUsage = null; }   // a background call (learning, a summary) is not what Stop stops (1.13.1)
    // include_usage: the server reports the turn's tokens in a last chunk
    // (llama.cpp, Ollama, LM Studio, vLLM; one that does not know it ignores it).
    // Lodestone Desktop passes it on to a rented model, with OpenRouter's cost.
    const res = await (this.fetchImpl || fetch)(this.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.headers ? await this.headers() : {}) },
      body: JSON.stringify({ model: this.model, messages, stream: true, temperature, top_p: 0.8, presence_penalty: 1.0, max_tokens: maxTokens, stream_options: { include_usage: true } }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // The desktop's own server says plainly what went wrong (a spent daily
      // allowance, a refused key); show that sentence, not the JSON around it.
      const t = await res.text();
      let msg = ""; try { const j = JSON.parse(t); msg = typeof j.error === "string" ? j.error : (j.error?.message || ""); } catch {}
      throw new Error(msg || `Model server answered ${res.status}: ${t.slice(0, 200)}`);
    }
    yield* readSSE(res, u => { if (background) this.bgUsage = u; else this.lastUsage = u; });
  }
  interrupt() { try { this.ctrl?.abort(); } catch {} }
  describe() { if (this.name) return `Lodestone Desktop · ${this.name}`; return `${this.model} · ${this.baseUrl.includes(location.host) || !this.baseUrl.startsWith("http") ? "your computer" : new URL(this.baseUrl).host}`; }
}
