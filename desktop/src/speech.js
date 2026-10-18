// speech.js — the model that turns an attached recording into text.
//
// Whisper small (multilingual, 8-bit, about 250 MB), run by transformers.js inside Lodestone's own
// page, the same way the retrieval model runs: on this computer, with nothing
// sent anywhere. It is downloaded once, the first time the practitioner attaches
// a recording, from a pinned revision on Hugging Face, and every file is checked
// against the SHA-256 written here (computed on 8 Oct 2026). Whisper base was
// tried first and rejected: on French speech it guessed words that were not said. The page loads it from
// /lodestone-app/asr/, served from the data folder (server.js).

const path = require("path");
const fs = require("fs");

const REPO = "Xenova/whisper-small";
const REV = "2d67713f236afa48a18992566e7647f6ca848e13";
const ROOT = [
  { path: "config.json", size: 2232, sha256: "5a6429d21d7a3379dd0861b74510f9f7076f32b563bffc9fcb072482d55ab3be" },
  { path: "generation_config.json", size: 3837, sha256: "0b7407a4e53a677f826e03c75d409e6f830663932bf43dda3b08c5efa2223279" },
  { path: "preprocessor_config.json", size: 339, sha256: "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d" },
  { path: "tokenizer.json", size: 2480466, sha256: "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566" },
  { path: "tokenizer_config.json", size: 282683, sha256: "2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce" },
];
const ONNX = [
  { path: "onnx/encoder_model_quantized.onnx", size: 92324809, sha256: "969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06" },
  { path: "onnx/decoder_model_merged_quantized.onnx", size: 156780950, sha256: "fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24" },
];
const SIZE = [...ROOT, ...ONNX].reduce((n, f) => n + f.size, 0);
const urlFor = p => `https://huggingface.co/${REPO}/resolve/${REV}/${p}`;

/** Where the page finds it: <asrRoot>/Xenova/whisper-base/… */
const modelDir = asrRoot => path.join(asrRoot, ...REPO.split("/"));

function ready(asrRoot) {
  const d = modelDir(asrRoot);
  return [...ROOT, ...ONNX].every(f => { try { return fs.statSync(path.join(d, f.path)).size === f.size; } catch { return false; } });
}

async function download(asrRoot, { fetch, downloadModel, signal, onProgress = () => {} }) {
  const d = modelDir(asrRoot);
  let before = 0;
  const wrap = n => p => onProgress({ ...p, done: before + (p.done || 0), total: SIZE, phase: p.phase === "done" ? "download" : p.phase });
  await downloadModel({ fetch, files: ROOT, urlFor, dir: d, signal, onProgress: wrap() });
  before = ROOT.reduce((n, f) => n + f.size, 0);
  await downloadModel({ fetch, files: ONNX, urlFor, dir: path.join(d, "onnx"), signal, onProgress: wrap() });
  onProgress({ phase: "done", done: SIZE, total: SIZE });
}

module.exports = { REPO, SIZE, ready, download, modelDir };
