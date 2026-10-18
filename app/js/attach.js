// attach.js — files the practitioner attaches to a message (desktop app).
//
// Everything is read on this computer before anything reaches a model:
//   text files    read as they are
//   PDFs          their text, by pdf.js; a scanned PDF (pages that are only
//                 pictures) is shown to a model that can see, four pages at most
//   recordings    transcribed by Whisper small in a worker (asr-worker.js)
//   images        scaled to 1,568 pixels on the long side and passed to a model
//                 that can see; a model that cannot is not sent them
// What a model receives is text in an <attached_files> block of the system
// prompt (prompt.js) and images in the practitioner's own turn.

export const MAX_FILE_CHARS = 60000;    // per file, before the window budget trims further
const MAX_SIDE = 1568;
const SCAN_PAGES = 4;
const MAX_AUDIO_MIN = 30;

const AUDIO = /\.(mp3|m4a|wav|ogg|oga|opus|flac|aac|weba|webm|mp4|m4v|mov)$/i;
const TEXT = /\.(txt|text|md|markdown|csv|tsv|json|html?|xml|srt|vtt|log|ya?ml|tex|org|rst)$/i;
const IMAGE = /\.(jpe?g|png|gif|webp|bmp)$/i;

export function kindOf(file) {
  const n = file.name || "", t = file.type || "";
  if (t === "application/pdf" || /\.pdf$/i.test(n)) return "pdf";
  if (t.startsWith("image/") || IMAGE.test(n)) return /heic|heif/i.test(t + n) ? "unsupported" : "image";
  if (t.startsWith("audio/") || t.startsWith("video/") || AUDIO.test(n)) return "audio";
  if (t.startsWith("text/") || TEXT.test(n) || t === "application/json") return "text";
  return "unsupported";
}

const cap = (s, n = MAX_FILE_CHARS) => s.length > n ? { text: s.slice(0, n), cut: s.length } : { text: s, cut: 0 };

/** Draw a bitmap or canvas source into a JPEG data URL no larger than MAX_SIDE. */
function toJpeg(src, w, h) {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

async function readImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error("This image format cannot be opened here. Save it as JPEG or PNG."); }
  const url = toJpeg(bmp, bmp.width, bmp.height);
  bmp.close?.();
  return { images: [url] };
}

let pdfjs = null;
async function readPdf(file, { canSee, status }) {
  if (!pdfjs) {
    pdfjs = await import("../vendor/pdfjs/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    if (i % 10 === 1) status?.(`Reading ${file.name}: page ${i} of ${doc.numPages}…`);
    const tc = await (await doc.getPage(i)).getTextContent();
    let s = "";
    for (const it of tc.items) { s += it.str || ""; s += it.hasEOL ? "\n" : (it.str ? " " : ""); }
    pages.push(s.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim());
    if (pages.join("").length > MAX_FILE_CHARS * 1.2) { pages.push(`[Stopped reading at page ${i} of ${doc.numPages}.]`); break; }
  }
  const text = pages.map((p, i) => p ? `[Page ${i + 1}]\n${p}` : "").filter(Boolean).join("\n\n");
  const scanned = text.replace(/\[Page \d+\]/g, "").trim().length < 40 * Math.min(doc.numPages, pages.length);
  if (!scanned) return { text, note: `${doc.numPages} page${doc.numPages > 1 ? "s" : ""}` };
  if (!canSee) return { text, note: "pages are pictures, not text: a model that can see is needed to read them", scanned: true };
  const images = [];
  for (let i = 1; i <= Math.min(SCAN_PAGES, doc.numPages); i++) {
    status?.(`Looking at page ${i} of ${file.name}…`);
    const page = await doc.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(2, MAX_SIDE / Math.max(vp0.width, vp0.height)) });
    const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp, canvas: c }).promise;
    images.push(c.toDataURL("image/jpeg", 0.85));
  }
  return { text, images, note: `scanned: ${images.length} of ${doc.numPages} pages shown as images`, scanned: true };
}

let worker = null, seq = 0;
const waiting = new Map();
// Whisper is told the language: left to itself, transformers.js assumes English
// and renders other speech as English approximations.
const LANG_NAMES = { en: "english", fr: "french", es: "spanish", ar: "arabic", pt: "portuguese", de: "german", zh: "chinese", ja: "japanese", hi: "hindi", ru: "russian", it: "italian", nl: "dutch", tr: "turkish", fa: "persian", ur: "urdu" };
export const speechLanguage = code => LANG_NAMES[String(code || "").slice(0, 2).toLowerCase()] || null;

function transcribe(audio, language) {
  if (!worker) {
    worker = new Worker(new URL("./asr-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = e => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); e.data.error ? w.reject(new Error(e.data.error)) : w.resolve(e.data.text); };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ id, audio, language }, [audio.buffer]); });
}

async function readAudio(file, { status, language }) {
  status?.(`Decoding ${file.name}…`);
  const ctx = new AudioContext({ sampleRate: 16000 });
  let buf;
  try { buf = await ctx.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error("This recording's format cannot be decoded here. MP3, M4A, WAV, OGG and FLAC work."); }
  finally { ctx.close?.(); }
  const minutes = buf.duration / 60;
  if (minutes > MAX_AUDIO_MIN) throw new Error(`The recording is ${Math.round(minutes)} minutes long; Lodestone transcribes up to ${MAX_AUDIO_MIN}.`);
  const mono = new Float32Array(buf.length);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels; }
  status?.(`Transcribing ${file.name} (${Math.max(1, Math.round(minutes))} min) on this computer…`);
  const text = await transcribe(mono, language);
  return { text, note: `transcript of a ${Math.max(1, Math.round(minutes))}-minute recording` };
}

/**
 * Read one file. `canSee`: whether the model in use takes images; `language`:
 * Whisper's name for the spoken language (speechLanguage()).
 * Resolves to { name, kind, text?, images?, note?, cut? }.
 */
export async function readAttachment(file, { canSee = false, status, language = null } = {}) {
  const kind = kindOf(file);
  const base = { name: file.name || "file", kind };
  if (kind === "unsupported") throw new Error(`${base.name}: Lodestone reads text, PDF, images and recordings. Save a document as PDF or text.`);
  if (kind === "text") return { ...base, ...cap(await file.text()) };
  if (kind === "image") return { ...base, ...(await readImage(file)) };
  if (kind === "pdf") { const r = await readPdf(file, { canSee, status }); return { ...base, ...r, ...cap(r.text || "") }; }
  const r = await readAudio(file, { status, language });
  return { ...base, ...r, ...cap(r.text) };
}

/** The <attached_files> block; `budget` in characters across all files. */
export function filesBlock(files, budget) {
  const withText = files.filter(f => f.text);
  if (!withText.length) return "";
  const each = Math.max(1500, Math.floor(budget / withText.length));
  const parts = withText.map(f => {
    const t = f.text.length > each ? f.text.slice(0, each) : f.text;
    const shortened = f.text.length > each || f.cut;
    return `<file name="${f.name.replace(/"/g, "'")}" kind="${f.kind}"${f.note ? ` note="${f.note.replace(/"/g, "'")}"` : ""}${f.earlier ? ' attached="earlier in this conversation"' : ""}>\n${t}${shortened ? `\n[… shortened: ${t.length.toLocaleString("en")} of ${(f.cut || f.text.length).toLocaleString("en")} characters fit in the model's window]` : ""}\n</file>`;
  });
  return `<attached_files>\n${parts.join("\n\n")}\n</attached_files>`;
}
