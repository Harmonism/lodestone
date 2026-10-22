// asr-worker.js — turns an attached recording or a dictated clip into text, on this device.
// Whisper small (multilingual, 8-bit) through transformers.js, off the UI thread.
// Two places the model is read from, and the network is never one of them:
//   "local" (Lodestone Desktop): downloaded once by the desktop app
//           (desktop/src/speech.js) and served from /lodestone-app/asr/ by its own server;
//   "web"   (the web app, the phone): downloaded once into this browser's Cache
//           Storage and checked by speechweb.js; read here from that cache only.
import { pipeline, env } from "../vendor/transformers.min.js";
import { CACHE, PREFIX } from "./speechweb.js";

env.allowLocalModels = true;
env.allowRemoteModels = false;
// A path, not a URL: an absolute http(s) localModelPath is treated as remote
// (see embed-worker.js for the failure that taught this).
env.localModelPath = new URL("../asr/", import.meta.url).pathname;
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;

let asr = null, mode = null;

function useWebCache() {
  // transformers.js will not start with both its paths off, so "remote" is on, but
  // its address cannot resolve and its fetch always refuses: the files come from
  // the cache below or not at all.
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = "https://lodestone.invalid/";
  env.fetch = () => Promise.reject(new Error("The speech model is not in this browser's storage. Download it again from Settings → Dictation."));
  env.useBrowserCache = false;
  env.useCustomCache = true;
  // transformers.js asks for a file by a local path or a Hugging Face address; either way the
  // file is the part after the model's name (and its revision), looked up in our own cache.
  env.customCache = {
    async match(key) {
      const k = String(key?.url || key);
      const m = k.match(/whisper-small\/(?:resolve\/[^/]+\/)?(.+)$/);
      if (!m) return undefined;
      return (await caches.open(CACHE)).match(PREFIX + m[1]);
    },
    async put() {},
  };
}

self.onmessage = async e => {
  const { id, audio, language = null } = e.data;
  try {
    if (e.data.mode && e.data.mode !== mode) { mode = e.data.mode; asr = null; if (mode === "web") useWebCache(); }
    if (!asr) asr = await pipeline("automatic-speech-recognition", "Xenova/whisper-small", { dtype: "q8", device: "wasm" });
    const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, task: "transcribe", ...(language ? { language } : {}) });
    self.postMessage({ id, text: String(out?.text || "").trim() });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
