// speechweb.js — the speech model in the web app and on the phone.
//
// Lodestone Desktop downloads Whisper small once and serves it from its own
// server (desktop/src/speech.js). A browser has no such server, so the same
// files, from the same pinned revision on Hugging Face, are downloaded once
// into this browser's own storage (Cache Storage), each checked against the
// SHA-256 the desktop app checks, and the speech worker reads them from there
// and from nowhere else (asr-worker.js, mode "web": no network at all). The
// recording itself never leaves the device.
//
//   speechReady()        every file is in this browser's storage
//   downloadSpeech(cb)   fetch, verify and store the files; cb(done, total)
//   forgetSpeech()       remove them (Settings)

export const CACHE = "lodestone-asr-v1";
export const PREFIX = "https://lodestone.invalid/asr/";   // keys only: nothing is ever fetched from here
const REPO = "Xenova/whisper-small";
const REV = "2d67713f236afa48a18992566e7647f6ca848e13";
// The desktop app's list (desktop/src/speech.js, computed 8 Oct 2026): the same files, the same hashes.
export const FILES = [
  { path: "config.json", size: 2232, sha256: "5a6429d21d7a3379dd0861b74510f9f7076f32b563bffc9fcb072482d55ab3be" },
  { path: "generation_config.json", size: 3837, sha256: "0b7407a4e53a677f826e03c75d409e6f830663932bf43dda3b08c5efa2223279" },
  { path: "preprocessor_config.json", size: 339, sha256: "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d" },
  { path: "tokenizer.json", size: 2480466, sha256: "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566" },
  { path: "tokenizer_config.json", size: 282683, sha256: "2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce" },
  { path: "onnx/encoder_model_quantized.onnx", size: 92324809, sha256: "969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06" },
  { path: "onnx/decoder_model_merged_quantized.onnx", size: 156780950, sha256: "fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24" },
];
export const TOTAL = FILES.reduce((n, f) => n + f.size, 0);
export const MB = Math.round(TOTAL / 1e6);
const urlFor = p => `https://huggingface.co/${REPO}/resolve/${REV}/${p}`;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

export const speechStorable = () => typeof caches !== "undefined" && !!crypto?.subtle;

export async function speechReady() {
  if (!speechStorable()) return false;
  try {
    const c = await caches.open(CACHE);
    for (const f of FILES) if (!(await c.match(PREFIX + f.path))) return false;
    return true;
  } catch { return false; }
}

/** Downloads what is missing, checks each file, and stores it. Throws with a plain sentence when a file does not match. */
export async function downloadSpeech(onProgress = () => {}, { fetchImpl = fetch } = {}) {
  if (!speechStorable()) throw new Error("This browser cannot keep the speech model (it needs a secure page and storage).");
  try { await navigator.storage?.persist?.(); } catch {}
  const c = await caches.open(CACHE);
  let done = 0;
  for (const f of FILES) {
    if (await c.match(PREFIX + f.path)) { done += f.size; onProgress(done, TOTAL); continue; }
    const res = await fetchImpl(urlFor(f.path));
    if (!res.ok) throw new Error(`The speech model could not be downloaded (${f.path}: ${res.status}).`);
    // One buffer of the expected size, filled as the bytes arrive: a phone holds the
    // largest file (157 MB) once, not three times over (chunks, a blob, a copy to hash).
    const buf = new Uint8Array(f.size); let got = 0, over = false;
    const reader = res.body?.getReader?.();
    if (reader) {
      for (;;) {
        const { done: end, value } = await reader.read(); if (end) break;
        if (got + value.length > f.size) { over = true; try { reader.cancel(); } catch {} break; }
        buf.set(value, got); got += value.length; onProgress(done + got, TOTAL);
      }
    } else { const b = new Uint8Array(await res.arrayBuffer()); if (b.length > f.size) over = true; else { buf.set(b); got = b.length; } }
    const sum = over || got !== f.size ? "" : hex(await crypto.subtle.digest("SHA-256", buf));
    if (sum !== f.sha256) throw new Error(`The speech model did not check out (${f.path} is not the file expected). Nothing was kept; try again later.`);
    await c.put(PREFIX + f.path, new Response(buf, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(f.size) } }));
    done += f.size; onProgress(done, TOTAL);
  }
  return true;
}

export async function forgetSpeech() { try { await caches.delete(CACHE); } catch {} }
