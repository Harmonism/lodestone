// asr-worker.js — turns an attached recording or a dictated clip into text, on this device.
// Whisper small (multilingual, 8-bit) through transformers.js, off the UI thread.
// Two places the model is read from, and the network is never one of them:
//   "local" (Lodestone Desktop): downloaded once by the desktop app
//           (desktop/src/speech.js) and served from /lodestone-app/asr/ by its own server;
//   "web"   (the web app, the phone): downloaded once into this browser's Cache
//           Storage and checked by speechweb.js; read here from that cache only.
//
// Before Whisper hears anything, Silero VAD (MIT, 2.2 MB, shipped in vendor/models)
// keeps only the stretches where someone speaks: Whisper writes stock phrases into
// silence and noise ("you", "Thank you for watching"), so a clip with no voice in it
// never reaches it, and long pauses are shortened. The sound itself is not "cleaned":
// denoising makes Whisper less accurate, not more. Whisper is then primed with
// Lodestone's vocabulary, so the words of the corpus are spelled as the corpus spells them.
import { pipeline, env, AutoModel, Tensor } from "../vendor/transformers.min.js";
import { CACHE, PREFIX } from "./speechweb.js";

env.allowLocalModels = true;
env.allowRemoteModels = false;
// A path, not a URL: an absolute http(s) localModelPath is treated as remote
// (see embed-worker.js for the failure that taught this).
env.localModelPath = new URL("../asr/", import.meta.url).pathname;
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;

const RATE = 16000;
const VAD_FILE = new URL("../vendor/models/onnx-community/silero-vad/onnx/model.onnx", import.meta.url).href;
let asr = null, mode = null, vad = null, vadBroken = false;

// Every file transformers.js asks for passes through here first. The voice detector
// always comes from the app's own folder; in the browser, Whisper's files come from
// this browser's storage and nowhere else.
env.useCustomCache = true;
env.customCache = {
  async match(key) {
    const k = String(key?.url || key);
    if (/silero-vad\/onnx\/model\.onnx$/.test(k)) { const r = await fetch(VAD_FILE); return r.ok ? r : undefined; }
    if (mode !== "web") return undefined;
    const m = k.match(/whisper-small\/(?:resolve\/[^/]+\/)?(.+)$/);
    if (!m) return undefined;
    return (await caches.open(CACHE)).match(PREFIX + m[1]);
  },
  async put() {},
};

function useWebCache() {
  // transformers.js will not start with both its paths off, so "remote" is on, but
  // its address cannot resolve and its fetch always refuses: the files come from
  // the cache above or not at all.
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = "https://lodestone.invalid/";
  env.fetch = () => Promise.reject(new Error("The speech model is not in this browser's storage. Download it again from Settings → Dictation."));
}

// ─── Layer 1: where someone speaks ───────────────────────────────────────────
// Silero VAD v5: 512 new samples at 16 kHz with the previous 64 as context, a
// recurrent state of [2, 1, 128]. Thresholds are Silero's own (0.5 on, 0.35 off).
const WIN = 512, CTX = 64;
async function speechProbs(audio) {
  vad ??= await AutoModel.from_pretrained("onnx-community/silero-vad", { config: { model_type: "custom" }, dtype: "fp32" });
  const sr = new Tensor("int64", BigInt64Array.from([BigInt(RATE)]), []);
  let state = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  const x = new Float32Array(CTX + WIN), probs = new Float32Array(Math.floor(audio.length / WIN));
  for (let w = 0; w < probs.length; w++) {
    x.copyWithin(0, WIN);                       // the last 64 samples become the context
    x.set(audio.subarray(w * WIN, w * WIN + WIN), CTX);
    const out = await vad({ input: new Tensor("float32", x.slice(), [1, CTX + WIN]), sr, state });
    probs[w] = out.output.data[0];
    state = out.stateN;
  }
  return probs;
}

/** [start, end) sample ranges with speech, padded, close ones joined. */
export function speechSpans(probs, { on = 0.5, off = 0.35, minSpeechMs = 200, minSilenceMs = 350, padMs = 250, total } = {}) {
  const ms = WIN / RATE * 1000, spans = [];
  let start = -1, lastOn = -1;
  for (let w = 0; w < probs.length; w++) {
    if (probs[w] >= on) { if (start < 0) start = w; lastOn = w; }
    else if (start >= 0 && probs[w] < off && (w - lastOn) * ms >= minSilenceMs) {
      if ((lastOn - start + 1) * ms >= minSpeechMs) spans.push([start, lastOn + 1]);
      start = -1;
    }
  }
  if (start >= 0 && (lastOn - start + 1) * ms >= minSpeechMs) spans.push([start, lastOn + 1]);
  const pad = Math.round(padMs / 1000 * RATE), end = total ?? probs.length * WIN, out = [];
  for (const [a, b] of spans) {
    const s = Math.max(0, a * WIN - pad), e = Math.min(end, b * WIN + pad);
    if (out.length && s <= out[out.length - 1][1]) out[out.length - 1][1] = e; else out.push([s, e]);
  }
  return out;
}

/** The voiced stretches, joined with a short pause, cut into pieces Whisper can take whole (< 28 s). */
function voiced(audio, spans) {
  const gap = new Float32Array(Math.round(0.3 * RATE)), pieces = [], MAX = 28 * RATE;
  let cur = [], len = 0;
  const flush = () => { if (!cur.length) return; const a = new Float32Array(len); let o = 0; for (const c of cur) { a.set(c, o); o += c.length; } pieces.push(a); cur = []; len = 0; };
  for (const [s, e] of spans) {
    for (let p = s; p < e; p += MAX) {           // a single stretch longer than a piece is cut as it falls
      const seg = audio.subarray(p, Math.min(e, p + MAX));
      if (len && len + gap.length + seg.length > MAX) flush();
      if (len) { cur.push(gap); len += gap.length; }
      cur.push(seg); len += seg.length;
    }
  }
  flush();
  return pieces;
}

// ─── Layer 2: Whisper, primed with the corpus's words ────────────────────────
// Whisper takes the spelling of names from a previous-text prompt (OpenAI's
// prompting guide); transformers.js has no prompt option, but its generate takes
// the decoder's opening tokens as given: <|startofprev|> prompt <|startoftranscript|>
// <|lang|> <|transcribe|> <|notimestamps|>. The prompt is written without
// hesitations, since Whisper copies a prompt's style.
// In the speaker's own language, and as a sentence, not a list: in tests an English
// prompt made Whisper hear French hesitations as English words ("euh" became
// "Hedge"), and a bare list of terms made it write them as letters ("H"). Written
// as a sentence, the prompt spelled Lodestone, Harmonism, Ṛta, Sushumna, Qi and the
// Wisdom Canon right where unprimed Whisper wrote "Loadstone", "Rita", "Sashamna",
// "Kai", and left other speech as it was. Languages without one are not primed.
const VOCAB = {
  en: "I was reading Lodestone on Harmonism, a Harmonist reading of Ṛta, the Logos and Dharma, the Sushumna, Jing and Qi, and the Wisdom Canon.",
  fr: "J'ai lu Lodestone sur l'harmonisme, une lecture harmoniste du Ṛta, du Logos et du Dharma, de la Sushumna, du Jing et du Qi, et du Canon de la sagesse.",
  es: "Leía Lodestone sobre el harmonismo, una lectura harmonista del Ṛta, del Logos y del Dharma, de la Sushumna, del Jing y del Qi, y del Canon de la sabiduría.",
  pt: "Eu lia Lodestone sobre o harmonismo, uma leitura harmonista do Ṛta, do Logos e do Dharma, da Sushumna, do Jing e do Qi, e do Cânone da sabedoria.",
  de: "Ich las Lodestone über den Harmonismus, eine harmonistische Lesart von Ṛta, Logos und Dharma, der Sushumna, von Jing und Qi und dem Kanon der Weisheit.",
};
const CODES = { english: "en", french: "fr", spanish: "es", arabic: "ar", portuguese: "pt", german: "de", chinese: "zh", japanese: "ja", hindi: "hi", russian: "ru", italian: "it", dutch: "nl", turkish: "tr", persian: "fa", urdu: "ur" };
const promptIds = {};

async function whisperPiece(audio, language) {
  const code = CODES[language] || (language && language.length === 2 ? language : null);
  const gc = asr.model.generation_config, tok = asr.tokenizer;
  const langId = code ? gc.lang_to_id?.[`<|${code}|>`] : null;
  const sp = tok.encode("<|startofprev|>", { add_special_tokens: false }), prev = sp.length === 1 ? sp[0] : null;
  if (!langId || prev == null || !VOCAB[code] || audio.length > 29 * RATE) {   // no language to name, or a long stretch: Whisper as before
    const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, task: "transcribe", ...(language ? { language } : {}) });
    return String(out?.text || "").trim();
  }
  promptIds[code] ??= tok.encode(" " + VOCAB[code], { add_special_tokens: false });
  const start = [prev, ...promptIds[code], gc.decoder_start_token_id, langId, gc.task_to_id.transcribe, gc.no_timestamps_token_id];
  const { input_features } = await asr.processor(audio);
  const seq = await asr.model.generate({ inputs: input_features, decoder_input_ids: [start], max_new_tokens: 440 - start.length });
  const ids = (seq.tolist?.() ?? seq)[0].slice(start.length).map(Number);
  return tok.decode(ids, { skip_special_tokens: true }).trim();
}

self.onmessage = async e => {
  const { id, audio, language = null, trim = true } = e.data;
  try {
    if (e.data.mode && e.data.mode !== mode) { mode = e.data.mode; asr = null; if (mode === "web") useWebCache(); }
    let pieces = [audio];
    if (trim && !vadBroken) {
      try {
        const spans = speechSpans(await speechProbs(audio), { total: audio.length });
        if (!spans.length) { self.postMessage({ id, text: "", voiced: 0 }); return; }   // no voice: nothing for Whisper to invent
        pieces = voiced(audio, spans);
      } catch (err) { vadBroken = true; console.warn("[asr] voice detection unavailable; Whisper hears the whole clip:", err); }
    }
    if (!asr) asr = await pipeline("automatic-speech-recognition", "Xenova/whisper-small", { dtype: "q8", device: "wasm" });
    const texts = [];
    for (const p of pieces) { const t = await whisperPiece(p, language); if (t) texts.push(t); }
    self.postMessage({ id, text: texts.join(" ").trim(), voiced: pieces.reduce((n, p) => n + p.length, 0) / RATE });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
