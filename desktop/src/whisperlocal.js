// whisperlocal.js — dictation on this computer, one engine for Lodestone and
// Lode. This file is the same in lodestone/desktop/src/ and lode-desktop/src/
// (each app's selftest fails when the two differ); change it in one, copy it to
// the other.
//
// The engine is whisper.cpp's whisper-cli, built for this Mac with Metal by
// lodestone/desktop/build-whisper.sh (v1.9.5, pinned to its commit), so the
// work runs on the GPU. The model is Whisper large v3 turbo, the model OpenRouter
// rents, in whisper.cpp's 5-bit form (574 MB), with Silero's voice detector (0.9
// MB) so silence never reaches Whisper; both are downloaded once from Hugging
// Face at a pinned revision, each checked against its SHA-256 before it is kept,
// into one folder both apps read: ~/Library/Application Support/Harmonia Speech/.
//
// One clip at a time: the WAV is written to a private temporary folder, read by
// whisper-cli, and the folder removed when it answers. Nothing is kept. With no
// language set, Whisper names it; when what it wrote looks like a misheard term
// of the corpus and the language has a vocabulary sentence, the clip is heard
// once more, primed with it (whisper.cpp's --prompt), as Lode's provider path does.

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const FILES = [
  { name: "ggml-large-v3-turbo-q5_0.bin", size: 574041195, sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin" },
  { name: "ggml-silero-v6.2.0.bin", size: 885098, sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin" },
];
const MODEL = FILES[0].name, VAD = FILES[1].name;
const SIZE = FILES.reduce((n, f) => n + f.size, 0);
const MB = Math.round(SIZE / 1e6);
const LABEL = "Whisper large v3 turbo";
const RATE = 16000;

/** The folder both apps keep the model in, under the system's application-data folder. */
const modelDir = appData => path.join(appData, "Harmonia Speech");

/** Whether every file is there at its size. */
function ready(dir) {
  return FILES.every(f => { try { return fs.statSync(path.join(dir, f.name)).size === f.size; } catch { return false; } });
}

/** The first whisper-cli among `candidates` that exists and can run, or null. */
function findEngine(candidates) {
  for (const c of candidates.filter(Boolean)) { try { fs.accessSync(c, fs.constants.X_OK); if (fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}
/** Where an app looks for it: inside the app, then beside Lodestone desktop's sources. */
const engineCandidates = ({ resources, roots = [] }) => {
  const arch = process.arch === "x64" ? "x64" : "arm64";
  return [resources && path.join(resources, "whisper", "whisper-cli"), ...roots.map(r => path.join(r, "engines", `whisper-darwin-${arch}`, "whisper-cli"))];
};

/** Downloads what is missing into `dir`, each file checked against its SHA-256 before it is kept. */
async function download(dir, { fetch: doFetch = fetch, signal, onProgress = () => {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let before = 0;
  for (const f of FILES) {
    const dest = path.join(dir, f.name);
    let have = false;
    try { have = fs.statSync(dest).size === f.size; } catch {}
    if (!have) {
      const part = dest + ".part";
      const res = await doFetch(f.url, { signal, redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`Hugging Face answered ${res.status} for ${f.name}.`);
      const hash = crypto.createHash("sha256"), out = fs.createWriteStream(part);
      let got = 0;
      try {
        for await (const chunk of res.body) {
          hash.update(chunk); got += chunk.length;
          if (!out.write(chunk)) await new Promise(r => out.once("drain", r));
          onProgress({ done: before + got, total: SIZE });
        }
        await new Promise((r, j) => out.end(e => (e ? j(e) : r())));
      } catch (e) { out.destroy(); try { fs.unlinkSync(part); } catch {} throw e; }
      if (got !== f.size || hash.digest("hex") !== f.sha256) { try { fs.unlinkSync(part); } catch {} throw new Error(`${f.name} did not match its checksum; nothing was kept. Try again.`); }
      fs.renameSync(part, dest);
    }
    before += f.size;
    onProgress({ done: before, total: SIZE });
  }
}

/** 16-bit mono WAV at 16 kHz from samples in [-1, 1]. */
function wav(x) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) { const s = Math.max(-1, Math.min(1, x[i])); b.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2); }
  return b;
}
/** Whether `buf` is a 16-bit PCM WAV, the one format whisper-cli is given here. */
function isWav(buf) {
  buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}

// The languages Whisper is told by name in the apps' settings, as codes.
const CODES = { english: "en", french: "fr", spanish: "es", arabic: "ar", portuguese: "pt", german: "de", italian: "it", chinese: "zh", japanese: "ja", hindi: "hi", russian: "ru", dutch: "nl", turkish: "tr", persian: "fa", urdu: "ur" };
const code = l => { l = String(l || "").toLowerCase(); if (!l || l === "auto") return null; if (CODES[l]) return CODES[l]; const c = l.slice(0, 2); return /^[a-z]{2}$/.test(c) ? c : null; };

// What the vocabulary prompt exists for, as Whisper mishears it unprimed (Lode's speech.js).
const SPELLED = /\b(?:Lodestone|Lode|Harmonism|Harmonist|Harmonia|Harmonic Realism|Logos|Ṛta|Dharma|Sushumna|OpenCode|Obsidian|Codeberg)\b/gu;
const LIKELY_TERMS = /\b(?:lo[ad]{1,2}e?stones?|load ?st(?:one|ar)s?|lowdstones?|harmonis[mt]\w*|armonis\w*|harmonic realism|armand\s+et|r[iy]t+a|sushum\w*|sashamna|sushma|open ?co(?:de|at)|code ?b[ue]rg|obsidian|dh?arma)\b/iu;
const likelyMisheard = text => LIKELY_TERMS.test(String(text).replace(SPELLED, " "));

function run(engine, args, { signal, timeout }) {
  return new Promise((resolve, reject) => {
    const p = execFile(engine, args, { timeout, maxBuffer: 16 * 1024 * 1024, signal, env: { PATH: "/usr/bin:/bin" } }, (err, stdout, stderr) => {
      if (err) { const why = String(stderr || "").trim().split("\n").filter(l => /error|fail/i.test(l)).slice(-1)[0]; reject(new Error(err.name === "AbortError" ? "aborted" : err.killed ? "The transcription took too long and was stopped." : `whisper-cli failed${why ? `: ${why}` : ` (${err.code})`}`)); }
      else resolve(stdout);
    });
    p.stdin?.end();
  });
}

/**
 * Text for one clip. `audio` is a WAV (Buffer) or samples (Float32Array, 16 kHz
 * mono). `language`: a code or a name, or "" / "auto" for Whisper to name it.
 * Resolves to { text, language, provider: "device", model }.
 */
async function transcribe({ engine, dir, model, audio, language = "", vocabulary = {}, signal, threads = Math.min(8, os.cpus().length || 4) }) {
  if (!engine) throw new Error("The speech engine for this computer is not built (lodestone/desktop/build-whisper.sh).");
  const modelPath = model || path.join(dir, MODEL), vadPath = path.join(dir, VAD);
  if (!fs.existsSync(modelPath)) throw new Error(`The speech model is not downloaded yet (${LABEL}, about ${MB} MB).`);
  const bytes = audio instanceof Float32Array ? wav(audio) : Buffer.from(audio);
  if (!isWav(bytes)) throw new Error("Only a WAV recording can be transcribed on this computer.");
  const seconds = (bytes.length - 44) / (RATE * 2);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harmonia-speech-"));
  try {
    fs.chmodSync(tmp, 0o700);
    const input = path.join(tmp, "clip.wav");
    fs.writeFileSync(input, bytes, { mode: 0o600 });
    const timeout = 60000 + Math.ceil(seconds) * 2000;
    const hear = async (lang, prompt, n) => {
      const out = path.join(tmp, "out" + n);
      const args = ["-m", modelPath, "-f", input, "-l", lang || "auto", "-t", String(threads), "-np", "-oj", "-of", out, "-sns"];
      if (fs.existsSync(vadPath)) args.push("--vad", "-vm", vadPath);
      if (prompt) args.push("--prompt", prompt);
      await run(engine, args, { signal, timeout });
      const j = JSON.parse(fs.readFileSync(out + ".json", "utf8"));
      return { text: (j.transcription || []).map(s => s.text).join("").replace(/\s+/g, " ").trim(), language: code(j.result?.language) || lang || null };
    };
    const want = code(language);
    let r;
    if (want) r = await hear(want, vocabulary[want] || null, 1);
    else {
      r = await hear(null, null, 1);
      if (r.text && r.language && vocabulary[r.language] && likelyMisheard(r.text)) {
        try { const again = await hear(r.language, vocabulary[r.language], 2); if (again.text) r = again; } catch (e) { if (signal?.aborted) throw e; }
      }
    }
    return { ...r, provider: "device", model: LABEL, noSpeech: 0, dropped: 0 };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { FILES, MODEL, VAD, SIZE, MB, LABEL, modelDir, ready, findEngine, engineCandidates, download, wav, isWav, code, likelyMisheard, transcribe };
