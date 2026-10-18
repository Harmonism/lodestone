// asr-worker.js — turns an attached recording into text, on this computer.
// Whisper small (multilingual, 8-bit) through transformers.js, off the UI thread.
// The model is downloaded once by the desktop app (desktop/src/speech.js) and
// served from /lodestone-app/asr/ (Lodestone Desktop's own server); nothing here reaches the network.
import { pipeline, env } from "../vendor/transformers.min.js";

env.allowLocalModels = true;
env.allowRemoteModels = false;
// A path, not a URL: an absolute http(s) localModelPath is treated as remote
// (see embed-worker.js for the failure that taught this).
env.localModelPath = new URL("../asr/", import.meta.url).pathname;
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;

let asr = null;

self.onmessage = async e => {
  const { id, audio, language = null } = e.data;
  try {
    if (!asr) asr = await pipeline("automatic-speech-recognition", "Xenova/whisper-small", { dtype: "q8", device: "wasm" });
    const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, task: "transcribe", ...(language ? { language } : {}) });
    self.postMessage({ id, text: String(out?.text || "").trim() });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
