// engine.js — where Lodestone thinks.
//   standard: WebLLM on this computer's GPU (WebGPU). Weights download once, then offline.
//   server: any OpenAI-compatible endpoint the practitioner runs (Ollama, LM Studio, llama.cpp, vLLM).
// No telemetry, no third-party inference.

import * as webllm from "../vendor/web-llm.js";
// The stream reader lives apart so a page that never runs a model on the
// device (website Lodestone, held.js) need not load WebLLM to read a stream.
import { readSSE, providerError, stripThink } from "./sse.js";
export { readSSE, providerError };

// Openness grading follows the openness gradient: closed → open-weight → fully-open
// (weights + training data + training code). Fully-open is the terminus.
// Only models that answer well enough to be trusted with the voice are listed.
// Everything below the 7–8B class was removed on 24 Sep 2026: a 1B model in
// Lodestone's register produces confident answers that misrepresent the system, and
// a wrong answer in that voice is a worse outcome than no answer. There is no
// smaller fallback on purpose — a computer that cannot hold these is told to
// run the model outside the browser instead, where it can hold much more.
export const MODELS = {
  "Qwen3-8B":  { id: "Qwen3-8B-q4f16_1-MLC", f32: "Qwen3-8B-q4f32_1-MLC", gb: 5.7, openness: "open-weight", note: "Multilingual; the strongest that runs inside a browser", thinking: true },
  "OLMo-2-7B": { id: "OLMo-2-1124-7B-Instruct-q4f16_1-MLC", f32: "OLMo-2-1124-7B-Instruct-q4f32_1-MLC", gb: 6.5, openness: "fully-open", note: "Fully open (AI2): weights, data and training code. English-centred" },
};

export const TIERS = {
  standard: {
    label: "This device", sub: "A computer with a real GPU and 8 GB or more to spare. About 6 GB, once. No installation.",
    engine: "webllm", models: ["Qwen3-8B", "OLMo-2-7B"], ctx: 8192,
    backbone: "light", rag: { k: 4, maxChars: 5200 }, maxTokens: 700,
  },
  server: {
    label: "My computer's model server", sub: "Lodestone Desktop, Ollama, LM Studio or llama.cpp on a machine you own. Larger models, the full doctrinal backbone, and nothing leaves your own network.",
    engine: "openai", models: [], ctx: 32768,
    backbone: "full", rag: { k: 5, maxChars: 12000 }, maxTokens: 1200,
  },
  // The two routes for a phone with no computer behind it (phone.js).
  // "server" backbone: harmonism.io puts its own doctrinal backbone in place of
  // a placeholder, so the phone does not send 80 KB with every message.
  hosted: {
    label: "My harmonism.io account", sub: "Ten messages a day in total across harmonism.io, Telegram and Lodestone's apps, on the open-weight models hosted Lodestone runs on. Needs the internet; each message goes to harmonism.io.",
    engine: "hosted", models: [], ctx: 32768,
    backbone: "server", rag: { k: 5, maxChars: 12000 }, maxTokens: 1200,
  },
  openrouter: {
    label: "OpenRouter, with my own key", sub: "No daily limit; you pay OpenRouter for what you use. The recommended models are those hosted Lodestone runs on, tested against the doctrine. Each message goes to OpenRouter.",
    engine: "openrouter", models: [], ctx: 32768,
    backbone: "full", rag: { k: 5, maxChars: 12000 }, maxTokens: 1200,
  },
  // No model at all (TODO, corpus-only tier): the crisis gate and retrieval
  // still run, and a question is answered with the passages that bear on it.
  reader: {
    label: "No model: read and search", sub: "The whole corpus on this device, with no network and no model. A question brings back the passages that bear on it, and every article opens offline.",
    engine: "none", models: [], ctx: 32768,
    backbone: "full", rag: { k: 6, maxChars: 9000 }, maxTokens: 0,
  },
};

// iPadOS reports itself as MacIntel, hence the touch-point test.
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Phone or tablet. */
export const isHandheld = () => isIOS() || /Android|Mobile/i.test(navigator.userAgent) ||
  Math.min(screen.width, screen.height) < 700;

// On-device inference is not offered on phones and tablets. It is not a memory
// question — Llama-3.2-1B does fit — it is that a model that small answers as
// Lodestone badly enough to misrepresent the system it is speaking for, which is
// worse than not answering. A handheld reaches a model the practitioner owns on
// a computer instead (tools/serve.py --lan), which also carries the full
// backbone rather than the compressed one.
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

// ─── WebLLM (on-device) ───────────────────────────────────────────────────────

export class DeviceEngine {
  constructor(tier, modelKey, f16) {
    let ctx = tier.ctx;
    const maxCtx = MODELS[modelKey].maxCtx;
    if (maxCtx) ctx = Math.min(ctx, maxCtx);
    this.tier = ctx === tier.ctx ? tier : { ...tier, ctx }; this.modelKey = modelKey; this.modelId = resolveModelId(modelKey, f16);
    this.engine = null; this.kind = "device";
  }
  async isCached() {
    try { return await webllm.hasModelInCache(this.modelId); } catch { return false; }
  }
  async load(onProgress) {
    const appConfig = {
      ...webllm.prebuiltAppConfig,
      useIndexedDBCache: false,
      model_list: webllm.prebuiltAppConfig.model_list.map(m =>
        m.model_id === this.modelId ? { ...m, overrides: { ...(m.overrides || {}), context_window_size: this.tier.ctx } } : m),
    };
    this.engine = await webllm.CreateWebWorkerMLCEngine(
      new Worker(new URL("./llm-worker.js", import.meta.url), { type: "module" }),
      this.modelId,
      { appConfig, initProgressCallback: r => onProgress && onProgress(r.progress, r.text) },
    );
  }
  async *stream(messages, { maxTokens, temperature = 0.7 } = {}) {
    // Qwen3's published non-thinking settings, plus a repetition guard: small quantized models loop.
    const req = {
      messages, stream: true, temperature, top_p: 0.8, max_tokens: maxTokens,
      presence_penalty: 1.0, repetition_penalty: 1.1,
      stream_options: { include_usage: true },
    };
    if (MODELS[this.modelKey].thinking) req.extra_body = { enable_thinking: false };
    const chunks = await this.engine.chat.completions.create(req);
    let raw = "";
    for await (const ch of chunks) {
      const d = ch.choices?.[0]?.delta?.content;
      if (d) { raw += d; yield stripThink(raw); }
      if (ch.usage) this.lastUsage = ch.usage;
    }
  }
  interrupt() { try { this.engine?.interruptGenerate(); } catch {} }
  describe() { return `${this.modelKey} · on this device`; }
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
  async *stream(messages, { maxTokens, temperature = 0.7 } = {}) {
    this.ctrl = new AbortController();
    const res = await (this.fetchImpl || fetch)(this.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.headers ? await this.headers() : {}) },
      body: JSON.stringify({ model: this.model, messages, stream: true, temperature, top_p: 0.8, presence_penalty: 1.0, max_tokens: maxTokens }),
      signal: this.ctrl.signal,
    });
    if (!res.ok) {
      // The desktop's own server says plainly what went wrong (a spent daily
      // allowance, a refused key); show that sentence, not the JSON around it.
      const t = await res.text();
      let msg = ""; try { const j = JSON.parse(t); msg = typeof j.error === "string" ? j.error : (j.error?.message || ""); } catch {}
      throw new Error(msg || `Model server answered ${res.status}: ${t.slice(0, 200)}`);
    }
    yield* readSSE(res);
  }
  interrupt() { try { this.ctrl?.abort(); } catch {} }
  describe() { if (this.name) return `Lodestone Desktop · ${this.name}`; return `${this.model} · ${this.baseUrl.includes(location.host) || !this.baseUrl.startsWith("http") ? "your computer" : new URL(this.baseUrl).host}`; }
}
