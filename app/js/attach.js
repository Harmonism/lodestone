// attach.js — files the practitioner attaches to a message (Lodestone Desktop, the web app, the phone).
//
// Everything is read on this device before anything reaches a model:
//   text and code  read as they are (any file that turns out to be text, whatever
//                  its name); web pages and RTF reduced to their words
//   PDFs           their text, by pdf.js; a scanned PDF (pages that are only
//                  pictures) is shown to a model that can see, four pages at most
//   documents      Word, Excel and PowerPoint (.docx .xlsx .pptx), OpenDocument
//                  (.odt .ods .odp), EPUB, Pages/Numbers/Keynote by their preview,
//                  read from inside the file (zip.js below); old Word (.doc) by its
//                  text runs, or exactly by the desktop's converter where there is one
//   archives       .zip: the readable files inside, up to MAX_ARCHIVE_FILES
//   recordings     audio, and the sound of a video, transcribed by Whisper small
//                  in a worker (asr-worker.js), in parts so the progress shows
//   images         scaled to 1,568 pixels on the long side and passed to a model
//                  that can see; HEIC and TIFF through the desktop's converter
// What a model receives is text in an <attached_files> block of the system
// prompt (prompt.js) and images in the practitioner's own turn.
//
// Limits are on what the device can hold, not on the file's name: each kind has
// a size it is read up to (LIMITS), said plainly when a file is over it.

export const MAX_FILE_CHARS = 60000;    // per file, before the window budget trims further
const MAX_SIDE = 1568;
const SCAN_PAGES = 4;
export const MAX_ARCHIVE_FILES = 25;
const MB = 1e6;      // sizes as people read them: 300 MB is 300,000,000 bytes
// Bytes each kind is read up to. Text is read from its start, so a larger text
// file is not refused: its first part is read and marked shortened.
export const LIMITS = {
  text: 8 * MB,           // read from the start (60,000 characters are kept anyway)
  pdf: 300 * MB,
  office: 300 * MB,       // .docx .xlsx .pptx .odt .epub .zip …: read part by part, never whole
  image: 80 * MB,
  convert: 200 * MB,      // sent to the desktop's converter (.doc .heic .tiff …)
};
// Recordings are decoded whole in memory: a computer holds more than a phone.
const desktopish = () => !!globalThis.lodestoneDesktop;
export const audioLimits = () => desktopish() ? { bytes: 1500 * MB, minutes: 90 } : { bytes: 400 * MB, minutes: 45 };
const PART_MIN = 10;      // transcribed ten minutes at a time, cut where it is quietest

const AUDIO = /\.(mp3|m4a|m4b|wav|wave|aif|aiff|aifc|caf|ogg|oga|opus|flac|aac|amr|3gp|3g2|weba|webm|mp4|m4v|mov|mkv|avi|wma)$/i;
const TEXT = /\.(txt|text|md|markdown|mdx|csv|tsv|json|jsonl|ndjson|xml|srt|vtt|log|ya?ml|toml|ini|cfg|conf|env|tex|bib|org|rst|adoc|asciidoc|textile|wiki|ics|vcf|eml|mbox|sql|py|ipynb|js|mjs|cjs|ts|tsx|jsx|css|scss|less|sh|bash|zsh|fish|ps1|bat|cmd|rb|go|rs|java|kt|kts|swift|m|mm|c|h|cc|cpp|hpp|cs|php|pl|pm|r|jl|lua|dart|scala|clj|ex|exs|erl|hs|ml|fs|vb|vue|svelte|gradle|cmake|make|mk|dockerfile|gitignore|properties|plist|strings|po|pot|gpx|kml|svg|rtf|html?|xhtml|xht|mht|mhtml)$/i;
const IMAGE = /\.(jpe?g|jfif|png|gif|webp|bmp|avif|ico)$/i;
const CONVERT_IMAGE = /\.(heic|heif|tiff?|psd|jp2|dng|cr2|cr3|nef|arw|raf|orf)$/i;
const OFFICE = /\.(docx|docm|dotx|xlsx|xlsm|xltx|pptx|pptm|ppsx|potx|odt|ott|ods|ots|odp|otp|epub|pages|numbers|key)$/i;
const LEGACY = /\.(doc|dot|xls|ppt|pps|wpd|wps|rtfd|webarchive)$/i;
const ARCHIVE = /\.zip$/i;

export function kindOf(file) {
  const n = file.name || "", t = (file.type || "").toLowerCase();
  if (t === "application/pdf" || /\.pdf$/i.test(n)) return "pdf";
  if (OFFICE.test(n) || /officedocument|opendocument|epub/.test(t)) return "document";
  if (ARCHIVE.test(n) || t === "application/zip" || t === "application/x-zip-compressed") return "archive";
  if (CONVERT_IMAGE.test(n) || /heic|heif|tiff/.test(t)) return "image";
  if (t.startsWith("image/") || IMAGE.test(n)) return "image";
  if (t.startsWith("audio/") || t.startsWith("video/") || AUDIO.test(n)) return "audio";
  if (LEGACY.test(n) || t === "application/msword" || t === "application/vnd.ms-excel" || t === "application/vnd.ms-powerpoint") return "legacy";
  if (t.startsWith("text/") || TEXT.test(n) || /json|xml|javascript|x-sh|x-python|rtf|yaml|csv/.test(t)) return "text";
  return "unknown";     // looked at: read as text if it is text
}

const cap = (s, n = MAX_FILE_CHARS) => s.length > n ? { text: s.slice(0, n), cut: s.length } : { text: s, cut: 0 };
export const sizeLabel = b => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
function tooBig(file, limit, what) {
  if ((file.size || 0) > limit) throw new Error(`${file.name || "This file"} is ${sizeLabel(file.size)}; Lodestone reads ${what} up to ${sizeLabel(limit)} here.`);
}

// ─── Text ────────────────────────────────────────────────────────────────────

/** Whether these bytes are text, and in which encoding: "utf-8", "utf-16le", "utf-16be", "windows-1252", or null. */
export function textEncoding(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const n = Math.min(bytes.length, 65536);
  // UTF-16 without its mark (Windows text): every other byte nought, on one side.
  if (n >= 64) {
    let even = 0, odd = 0;
    for (let i = 0; i + 1 < n; i += 2) { if (!bytes[i]) even++; if (!bytes[i + 1]) odd++; }
    const pairs = n >> 1;
    if (odd > pairs * 0.7 && even < pairs * 0.05) return "utf-16le";
    if (even > pairs * 0.7 && odd < pairs * 0.05) return "utf-16be";
  }
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return null;
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) ctrl++;
  }
  if (ctrl > n * 0.02) return null;
  // A multi-byte character cut at the end of the sample is not a fault.
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n), { stream: n < bytes.length }); return "utf-8"; }
  catch { return "windows-1252"; }
}

async function readText(file) {
  const part = file.size > LIMITS.text ? file.slice(0, LIMITS.text) : file;
  const bytes = new Uint8Array(await part.arrayBuffer());
  const enc = textEncoding(bytes);
  if (!enc) return null;
  let s = new TextDecoder(enc).decode(bytes);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const n = file.name || "";
  let note = null;
  if (/\.rtf$/i.test(n) || /^\{\\rtf/.test(s)) { s = rtfText(s); note = "RTF, its words"; }
  else if (/\.(html?|xhtml|xht)$/i.test(n) || /^\s*<!doctype html|^\s*<html[\s>]/i.test(s)) { s = htmlText(s); note = "web page, its words"; }
  else if (/\.ipynb$/i.test(n)) { try { s = notebookText(JSON.parse(s)); note = "notebook: its cells"; } catch {} }
  const r = cap(s);
  if (file.size > LIMITS.text) { r.cut = Math.max(r.cut, file.size); note = [note, `first ${sizeLabel(LIMITS.text)} of ${sizeLabel(file.size)} read`].filter(Boolean).join("; "); }
  return { ...r, note };
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const unxml = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);

/** The words of a web page: scripts, styles and tags gone, blocks on their own lines. */
export function htmlText(html) {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,noscript,template,svg,head").forEach(x => x.remove());
    doc.querySelectorAll("br").forEach(x => x.replaceWith("\n"));
    doc.querySelectorAll("p,div,li,tr,h1,h2,h3,h4,h5,h6,section,article,blockquote,pre,table,dt,dd").forEach(x => x.append("\n"));
    doc.querySelectorAll("td,th").forEach(x => x.append("\t"));
    return tidy(doc.body?.textContent || "");
  } catch {
    return tidy(unxml(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, "")));
  }
}
const tidy = s => s.replace(/\r\n?/g, "\n").replace(/\t+\n/g, "\n").replace(/[ \t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[  ]{2,}/g, " ").trim();

/** The words of an RTF file: groups that hold no text (fonts, colours, pictures) skipped, escapes decoded. */
export function rtfText(rtf) {
  let out = "", depth = 0;
  const skipAt = [];       // depths at which a skipped group began
  const skip = d => { if (skipAt[skipAt.length - 1] !== d) skipAt.push(d); };
  const cp1252 = new TextDecoder("windows-1252");
  let uc = 1, skipChars = 0;
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i];
    if (c === "{") { depth++; continue; }
    if (c === "}") { if (skipAt.length && skipAt[skipAt.length - 1] === depth) skipAt.pop(); depth--; continue; }
    const skipping = skipAt.length > 0;
    if (c === "\\") {
      const nx = rtf[i + 1];
      if (nx === "'") { const h = rtf.substr(i + 2, 2); i += 3; if (skipChars) { skipChars--; continue; } if (!skipping) out += cp1252.decode(new Uint8Array([parseInt(h, 16) || 32])); continue; }
      if (nx === "\\" || nx === "{" || nx === "}") { i++; if (!skipping) out += nx; continue; }
      if (nx === "*") { i++; skip(depth); continue; }
      if (nx === "~") { i++; if (!skipping) out += " "; continue; }
      if (nx === "\n" || nx === "\r") { i++; if (!skipping) out += "\n"; continue; }
      const m = /^([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i + 1, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      const w = m[1], arg = m[2] != null ? +m[2] : null;
      if (/^(fonttbl|colortbl|stylesheet|info|pict|object|themedata|colorschememapping|latentstyles|datastore|xmlnstbl|listtable|listoverridetable|rsidtbl|generator|header|footer|headerl|headerr|footerl|footerr)$/.test(w)) { skip(depth); continue; }
      if (skipping) continue;
      if (w === "par" || w === "line" || w === "row" || w === "sect" || w === "page") out += "\n";
      else if (w === "tab" || w === "cell") out += "\t";
      else if (w === "uc" && arg != null) uc = arg;
      else if (w === "u" && arg != null) { out += String.fromCharCode(arg < 0 ? arg + 65536 : arg); skipChars = uc; }
      else if (w === "emdash") out += "—"; else if (w === "endash") out += "–";
      else if (w === "lquote") out += "‘"; else if (w === "rquote") out += "’";
      else if (w === "ldblquote") out += "“"; else if (w === "rdblquote") out += "”"; else if (w === "bullet") out += "•";
      continue;   // i is on the control word's last character; the loop steps past it
    }
    if (skipping) continue;
    if (c === "\n" || c === "\r") continue;
    if (skipChars) { skipChars--; continue; }
    out += c;
  }
  return tidy(out);
}

function notebookText(nb) {
  return (nb.cells || []).map(c => {
    const src = Array.isArray(c.source) ? c.source.join("") : String(c.source || "");
    return c.cell_type === "code" ? "```\n" + src + "\n```" : src;
  }).join("\n\n");
}

// ─── Inside zip files (.docx .xlsx .pptx .odt .epub .zip …) ───────────────────
// Read part by part from the file itself (Blob.slice), never loaded whole; each
// part inflated with the browser's own DecompressionStream, and stopped at a size
// so a small file that unpacks into gigabytes reads as what it is.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;
const ENTRY_MAX = 64 * MB;

export async function openZip(blob) {
  const tail = Math.min(blob.size, 65557);
  const end = new Uint8Array(await blob.slice(blob.size - tail).arrayBuffer());
  let p = -1;
  for (let i = end.length - 22; i >= 0; i--) if (end[i] === 0x50 && end[i + 1] === 0x4b && end[i + 2] === 5 && end[i + 3] === 6) { p = i; break; }
  if (p < 0) throw new Error("not a zip file");
  let count = u16(end, p + 10), size = u32(end, p + 12), offset = u32(end, p + 16);
  if (offset === 0xffffffff || count === 0xffff) {
    // ZIP64: the real numbers are in the ZIP64 end record its locator points to.
    const l = p - 20;
    if (l < 0 || u32(end, l) !== 0x07064b50) throw new Error("a ZIP64 file without its locator");
    const at = u32(end, l + 8) + u32(end, l + 12) * 4294967296;
    const z = new Uint8Array(await blob.slice(at, at + 56).arrayBuffer());
    count = u32(z, 32); size = u32(z, 40); offset = u32(z, 48) + u32(z, 52) * 4294967296;
  }
  const cd = new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
  const entries = [];
  const utf8 = new TextDecoder("utf-8"), cp437 = new TextDecoder("windows-1252");
  for (let q = 0, n = 0; n < count && q + 46 <= cd.length; n++) {
    if (u32(cd, q) !== 0x02014b50) break;
    const flags = u16(cd, q + 8), method = u16(cd, q + 10);
    let csize = u32(cd, q + 20), usize = u32(cd, q + 24), local = u32(cd, q + 42);
    const nl = u16(cd, q + 28), xl = u16(cd, q + 30), cl = u16(cd, q + 32);
    const name = (flags & 0x800 ? utf8 : cp437).decode(cd.subarray(q + 46, q + 46 + nl));
    // ZIP64 sizes and offset in the extra field
    let x = q + 46 + nl;
    const xEnd = x + xl;
    while (x + 4 <= xEnd) {
      const id = u16(cd, x), len = u16(cd, x + 2);
      if (id === 1) {
        let r = x + 4;
        if (usize === 0xffffffff) { usize = u32(cd, r) + u32(cd, r + 4) * 4294967296; r += 8; }
        if (csize === 0xffffffff) { csize = u32(cd, r) + u32(cd, r + 4) * 4294967296; r += 8; }
        if (local === 0xffffffff) { local = u32(cd, r) + u32(cd, r + 4) * 4294967296; }
      }
      x += 4 + len;
    }
    entries.push({ name, method, csize, usize, local, encrypted: !!(flags & 1), dir: name.endsWith("/") });
    q = xEnd + cl;
  }
  const byName = new Map(entries.map(e => [e.name, e]));
  async function bytes(e, max = ENTRY_MAX) {
    if (typeof e === "string") e = byName.get(e);
    if (!e) return null;
    if (e.encrypted) throw new Error(`${e.name} is protected by a password`);
    const h = new Uint8Array(await blob.slice(e.local, e.local + 30).arrayBuffer());
    if (u32(h, 0) !== 0x04034b50) throw new Error("a damaged zip file");
    const start = e.local + 30 + u16(h, 26) + u16(h, 28);
    const raw = blob.slice(start, start + e.csize);
    if (e.method === 0) return new Uint8Array(await raw.slice(0, max).arrayBuffer());
    if (e.method !== 8) throw new Error(`${e.name} is packed in a way this reader does not know`);
    const reader = raw.stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const parts = []; let got = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length;
        if (got >= max) { reader.cancel().catch(() => {}); break; }
      }
    } catch (err) { if (!got) throw new Error(`${e.name} could not be unpacked`); }
    const out = new Uint8Array(Math.min(got, max));
    let o = 0; for (const p of parts) { const take = Math.min(p.length, out.length - o); out.set(p.subarray(0, take), o); o += take; if (o >= out.length) break; }
    return out;
  }
  const text = async (e, max) => { const b = await bytes(e, max); return b ? new TextDecoder("utf-8").decode(b) : null; };
  return { entries, has: n => byName.has(n), bytes, text, find: re => entries.filter(e => !e.dir && re.test(e.name)) };
}

const natural = (a, b) => a.name.localeCompare(b.name, "en", { numeric: true });
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : null; };

/** Word (.docx): paragraphs, tabs, line breaks and table cells, footnotes and comments after. */
/**
 * Each <name …>…</name> (or <name …/>) in order, found with indexOf (1.13.1):
 * the lazy regexes it replaces went quadratic on unclosed tags (a crafted
 * spreadsheet of 400 KB took 19 seconds). An element left unclosed ends the walk.
 */
export function* elements(xml, name) {
  const open = "<" + name, close = "</" + name + ">";
  let pos = 0;
  for (;;) {
    const i = xml.indexOf(open, pos);
    if (i < 0) return;
    const ch = xml[i + open.length];
    if (ch !== ">" && ch !== " " && ch !== "/" && ch !== "\t" && ch !== "\n" && ch !== "\r") { pos = i + open.length; continue; }
    const j = xml.indexOf(">", i);
    if (j < 0) return;
    const attrs = xml.slice(i + open.length, j);
    if (attrs.endsWith("/")) { yield { attrs: attrs.slice(0, -1), body: "" }; pos = j + 1; continue; }
    const k = xml.indexOf(close, j);
    if (k < 0) return;
    yield { attrs, body: xml.slice(j + 1, k) };
    pos = k + close.length;
  }
}

/** The text with every <name …>…</name> removed, linearly; an unclosed one is left as it is. */
function without(xml, name) {
  const open = "<" + name, close = "</" + name + ">";
  let out = "", pos = 0;
  for (;;) {
    const i = xml.indexOf(open, pos);
    if (i < 0) break;
    const k = xml.indexOf(close, i);
    if (k < 0) break;
    out += xml.slice(pos, i); pos = k + close.length;
  }
  return out + xml.slice(pos);
}

export function docxText(xml) {
  xml = without(without(xml, "w:delText"), "w:instrText");   // deleted in tracked changes; field codes
  return tidy(unxml(xml
    .replace(/<w:tab\/>|<w:tab [^>]*\/>/g, "\t")
    .replace(/<w:(br|cr)(\s[^>]*)?\/>/g, "\n")
    .replace(/<w:noBreakHyphen\/>/g, "-")
    .replace(/<\/w:p>\s*<\/w:tc>/g, "</w:tc>")              // a cell's last paragraph ends with the cell
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")));
}

async function readDocx(z) {
  const parts = [];
  const main = await z.text("word/document.xml");
  if (main == null) return null;
  parts.push(docxText(main));
  for (const [file, label] of [["word/footnotes.xml", "Footnotes"], ["word/endnotes.xml", "Endnotes"], ["word/comments.xml", "Comments"]]) {
    const x = await z.text(file);
    const t = x && docxText(x).trim();
    if (t) parts.push(`[${label}]\n${t}`);
  }
  return { text: parts.join("\n\n"), note: "Word document" };
}

async function readPptx(z) {
  const slides = z.find(/^ppt\/slides\/slide\d+\.xml$/).sort(natural);
  if (!slides.length) return null;
  const words = x => tidy(unxml(x.replace(/<a:br\/>/g, "\n").replace(/<\/a:p>/g, "\n").replace(/<a:tab\/>/g, "\t").replace(/<[^>]+>/g, "")));
  const out = [];
  for (const s of slides) {
    const n = /(\d+)\.xml$/.exec(s.name)[1];
    let t = words(await z.text(s));
    const notes = await z.text(`ppt/notesSlides/notesSlide${n}.xml`);
    const nt = notes && words(notes).replace(/^\d+$/m, "").trim();
    if (nt) t += `\n(Speaker notes: ${nt})`;
    out.push(`[Slide ${n}]\n${t}`);
    if (out.join("").length > MAX_FILE_CHARS * 1.2) { out.push(`[Stopped reading at slide ${n} of ${slides.length}.]`); break; }
  }
  return { text: out.join("\n\n"), note: `presentation, ${slides.length} slide${slides.length > 1 ? "s" : ""}` };
}

const colIndex = ref => { let n = 0; for (const ch of String(ref).replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

async function readXlsx(z) {
  const wb = await z.text("xl/workbook.xml");
  if (wb == null) return null;
  const shared = [];
  const ss = await z.text("xl/sharedStrings.xml");
  if (ss) for (const m of elements(ss, "si")) shared.push(unxml(without(m.body, "rPh").replace(/<[^>]+>/g, "")));
  const rels = new Map();
  for (const m of ((await z.text("xl/_rels/workbook.xml.rels")) || "").matchAll(/<Relationship\b[^>]*>/g)) rels.set(attr(m[0], "Id"), attr(m[0], "Target"));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => {
    const tgt = rels.get(attr(m[0], "r:id")) || "";
    return { name: attr(m[0], "name") || "Sheet", path: tgt.startsWith("/") ? tgt.slice(1) : "xl/" + tgt.replace(/^\.\//, ""), hidden: attr(m[0], "state") === "hidden" };
  });
  const out = [];
  let total = 0, stopped = false;
  for (const sh of sheets) {
    const x = await z.text(sh.path);
    if (x == null) continue;
    const rows = [];
    for (const r of elements(x, "row")) {
      const cells = [];
      for (const c of elements(r.body, "c")) {
        const head = c.attrs, body = c.body;
        const t = attr(" " + head, "t"), i = colIndex(attr(" " + head, "r") || "A");
        const vs = body.indexOf("<v>"), ve = vs < 0 ? -1 : body.indexOf("</v>", vs);
        const v = vs < 0 || ve < 0 ? undefined : body.slice(vs + 3, ve);
        let val = t === "s" ? shared[+v] ?? "" : t === "inlineStr" ? unxml(body.replace(/<[^>]+>/g, "")) : t === "b" ? (v === "1" ? "TRUE" : "FALSE") : unxml(v ?? "");
        if (i >= 0 && i < 16384) cells[i] = String(val).replace(/[\t\n]+/g, " ");
      }
      if (cells.some(Boolean)) rows.push(Array.from(cells, c => c ?? "").join("\t"));
      total += rows[rows.length - 1]?.length || 0;
      if (total > MAX_FILE_CHARS * 1.2) { stopped = true; break; }
    }
    out.push(`[Sheet: ${sh.name}${sh.hidden ? " (hidden)" : ""}]\n${rows.join("\n")}`);
    if (stopped) { out.push("[Stopped reading here: the rest does not fit.]"); break; }
  }
  return { text: out.join("\n\n"), note: `spreadsheet, ${sheets.length} sheet${sheets.length > 1 ? "s" : ""}, cells separated by tabs` };
}

/** OpenDocument (.odt .ods .odp): content.xml's paragraphs, headings, cells and rows. */
export function odfText(xml) {
  return tidy(unxml(xml
    .replace(/<office:annotation\b[\s\S]*?<\/office:annotation>/g, "")
    .replace(/<text:s(\s+text:c="(\d+)")?\s*\/>/g, (m, a, n) => " ".repeat(+n || 1))
    .replace(/<text:tab\s*\/>/g, "\t").replace(/<text:line-break\s*\/>/g, "\n")
    .replace(/<\/text:p>\s*<\/table:table-cell>/g, "</table:table-cell>")
    .replace(/<table:covered-table-cell\s*\/>/g, "")
    .replace(/<table:table-cell\b[^>]*table:number-columns-repeated="(\d+)"[^>]*\/>/g, (m, n) => +n > 50 ? "\t" : "\t".repeat(+n))
    .replace(/<table:table-cell\b[^>]*\/>/g, "\t")
    .replace(/<\/table:table-cell>/g, "\t").replace(/<\/table:table-row>/g, "\n")
    .replace(/<draw:page\b[^>]*draw:name="([^"]*)"[^>]*>/g, "\n[$1]\n")
    .replace(/<table:table\b[^>]*table:name="([^"]*)"[^>]*>/g, "\n[$1]\n")
    .replace(/<\/text:(p|h)>/g, "\n")
    .replace(/<[^>]+>/g, "")));
}

async function readOdf(z, name) {
  const x = await z.text("content.xml");
  if (x == null) return null;
  const kind = /\.od[st]$|\.ots$/i.test(name) ? "spreadsheet" : /\.od[p]|\.otp$/i.test(name) ? "presentation" : "document";
  return { text: odfText(x), note: `OpenDocument ${kind}` };
}

async function readEpub(z) {
  const container = await z.text("META-INF/container.xml");
  const opfPath = container && attr(/<rootfile\b[^>]*>/.exec(container)?.[0] || "", "full-path");
  if (!opfPath) return null;
  const opf = await z.text(opfPath);
  const base = opfPath.includes("/") ? opfPath.replace(/[^/]+$/, "") : "";
  const manifest = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) manifest.set(attr(m[0], "id"), attr(m[0], "href"));
  const order = [...opf.matchAll(/<itemref\b[^>]*>/g)].map(m => manifest.get(attr(m[0], "idref"))).filter(Boolean);
  const title = unxml(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1] || "").trim();
  const out = [];
  let i = 0;
  for (const href of order) {
    i++;
    const path = decodeURIComponent((base + href).replace(/[^/]+\/\.\.\//g, ""));
    const h = await z.text(path);
    if (h) out.push(htmlText(h));
    if (out.join("").length > MAX_FILE_CHARS * 1.2) { out.push(`[Stopped reading at section ${i} of ${order.length}.]`); break; }
  }
  return { text: out.filter(Boolean).join("\n\n"), note: `book${title ? `: ${title}` : ""}, ${order.length} sections` };
}

/** Pages, Numbers and Keynote keep a preview inside: a PDF in older files, a picture in newer ones. */
async function readIWork(z, name, opts) {
  const pdf = z.find(/(^|\/)(QuickLook\/)?Preview\.pdf$/i)[0];
  if (pdf) {
    const b = await z.bytes(pdf, LIMITS.pdf);
    const r = await readPdf(new Blob([b]), { ...opts, name });
    return { ...r, note: `${r.note}, from the file's preview` };
  }
  const jpg = z.find(/(^|\/)preview(-web)?\.jpg$/i)[0];
  if (jpg && opts.canSee) {
    const b = await z.bytes(jpg, LIMITS.image);
    const r = await readImage(new Blob([b], { type: "image/jpeg" }));
    return { ...r, note: "the first page, as a picture (export it as PDF to give all of it)" };
  }
  throw new Error(`${name}: export it from ${/\.pages$/i.test(name) ? "Pages" : /\.numbers$/i.test(name) ? "Numbers" : "Keynote"} as PDF (File → Export To → PDF), then attach that.`);
}

async function readDocument(file, opts) {
  tooBig(file, LIMITS.office, "documents");
  const name = file.name || "";
  let z;
  try { z = await openZip(file); }
  catch {
    // Not a zip: a .key that is a key file, say, or a document saved under another name.
    const t = await readText(file);
    if (t) return t;
    throw new Error(`${name} could not be opened: it may be damaged, protected by a password, or an older format. Save it as PDF and attach that.`);
  }
  let r = null;
  if (/\.(pages|numbers|key)$/i.test(name)) return readIWork(z, name, opts);
  if (z.has("word/document.xml")) r = await readDocx(z);
  else if (z.has("xl/workbook.xml")) r = await readXlsx(z);
  else if (z.has("ppt/presentation.xml")) r = await readPptx(z);
  else if (z.has("META-INF/container.xml") && /\.epub$/i.test(name)) r = await readEpub(z);
  else if (z.has("content.xml")) r = await readOdf(z, name);
  if (!r) throw new Error(`${name}: nothing readable inside. Save it as PDF and attach that.`);
  if (/encrypt/i.test(z.entries.map(e => e.name).join(" ")) && !r.text.trim()) throw new Error(`${name} is protected by a password. Open it, save a copy without one, and attach that.`);
  return r;
}

async function readArchive(file, opts) {
  tooBig(file, LIMITS.office, "archives");
  let z;
  try { z = await openZip(file); }
  catch { throw new Error(`${file.name} could not be opened as a zip archive.`); }
  const files = z.entries.filter(e => !e.dir && !e.encrypted && !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|\.git)(\/|$)/.test(e.name) && !/(^|\/)\._/.test(e.name));
  const out = [], images = [], skipped = [];
  let n = 0;
  for (const e of files.sort(natural)) {
    const base = e.name.split("/").pop();
    const k = kindOf({ name: base, type: "" });
    if (k === "archive" || k === "audio" || (k === "image" && !opts.canSee) || (k === "image" && CONVERT_IMAGE.test(base))) { skipped.push(e.name); continue; }
    if (n >= MAX_ARCHIVE_FILES) { skipped.push(e.name); continue; }
    if (e.usize > ENTRY_MAX) { skipped.push(e.name); continue; }   // each part 64 MB at most, as documents' parts
    try {
      const b = await z.bytes(e, Math.min(e.usize || ENTRY_MAX, ENTRY_MAX));
      const inner = new File([b], base, { type: k === "image" ? "image/jpeg" : "" });
      opts.status?.(`Reading ${file.name}: ${e.name}…`);
      const r = await readAttachment(inner, { ...opts, inArchive: true });
      if (r.text) out.push(`--- ${e.name}${r.note ? ` (${r.note})` : ""} ---\n${r.text}`);
      if (r.images?.length && images.length < SCAN_PAGES) images.push(...r.images.slice(0, SCAN_PAGES - images.length));
      n++;
    } catch { skipped.push(e.name); }
  }
  if (!out.length && !images.length) throw new Error(`${file.name}: nothing readable inside${skipped.length ? ` (${skipped.length} file${skipped.length > 1 ? "s" : ""} of kinds Lodestone does not read from an archive)` : ""}.`);
  const note = `archive: ${n} of ${files.length} files read${skipped.length ? `; not read: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}` : ""}`;
  return { text: out.join("\n\n"), images, note };
}

// ─── Old binary formats ──────────────────────────────────────────────────────

/**
 * The text of an old Word file (.doc), without a converter: Word 97–2003 keeps
 * the body as runs of plain or UTF-16 characters inside its binary. The longest
 * runs are the text; a few stray fragments may come with it.
 */
export function binaryText(bytes) {
  // The body of an old Word file comes early, and 60,000 characters are kept:
  // its first 24 MB are read, and the runs stop once there is plenty (1.13.1).
  bytes = bytes.subarray(0, 24e6);
  const ENOUGH = 300000;
  let got = 0;
  const runs = [];
  const keep = r => { runs.push(r); got += r.length; };
  // UTF-16LE runs
  let cur = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8);
    if ((c >= 32 && c < 0xd800 && c !== 0xfffd) || c === 13 || c === 10 || c === 9) {
      cur += c === 13 ? "\n" : String.fromCharCode(c);
      if (cur.length >= 50000) { keep(cur); cur = ""; if (got > ENOUGH) break; }   // runs kept short: one long run is not one long regex
    }
    else { if (cur.replace(/\s/g, "").length >= 12) keep(cur); cur = ""; if (got > ENOUGH) break; }
  }
  if (cur.replace(/\s/g, "").length >= 12) keep(cur);
  // 8-bit runs (Word's "compressed" text)
  const cp = new TextDecoder("windows-1252");
  let s = -1;
  for (let i = 0; i <= bytes.length && got <= ENOUGH * 2; i++) {
    const b = i < bytes.length ? bytes[i] : 0;
    const ok = (b >= 32 && b < 127) || b === 13 || b === 10 || b === 9 || (b >= 0xa0);
    if (ok && s < 0) s = i;
    if (ok && i - s >= 50000) { keep(cp.decode(bytes.subarray(s, i)).replace(/\r/g, "\n")); s = i; }
    if (!ok && s >= 0) { if (i - s >= 40) keep(cp.decode(bytes.subarray(s, i)).replace(/\r/g, "\n")); s = -1; }
  }
  // Words, not table names or fonts: keep runs that read as language.
  // (Words counted by splitting, not by a regex over the run: "[\p{L}]{2,}\s" went quadratic on a long run with no space.)
  const words = r => { let n = 0; for (const w of r.split(/\s+/, 2000)) if (w.length >= 2 && /^\p{L}{2}/u.test(w) && ++n >= 3) return n; return n; };
  const good = runs.filter(r => words(r) >= 3 && !/^(Times New Roman|Arial|Calibri|Normal|Default Paragraph Font|Microsoft)/.test(r.trim()));
  return tidy(good.join("\n"));
}

async function readLegacy(file, opts) {
  const name = file.name || "";
  if (opts.convert) {
    tooBig(file, LIMITS.convert, "this kind of file");
    opts.status?.(`Converting ${name} on this computer…`);
    const r = await opts.convert(file);
    if (r?.text != null) return { ...cap(r.text), note: r.note || "converted on this computer" };
    if (r?.pdf) { const p = await readPdf(new Blob([r.pdf]), { ...opts, name }); return { ...cap(p.text || ""), images: p.images, note: `${r.note || "converted on this computer"}, ${p.note}` }; }
  }
  if (/\.(doc|dot)$/i.test(name)) {
    tooBig(file, LIMITS.convert, "old Word files");
    const t = binaryText(new Uint8Array(await file.slice(0, 24e6).arrayBuffer()));
    if (t.length > 40) return { ...cap(t), note: "text recovered from an old Word file: formatting gone, a few stray fragments possible (save it as .docx or PDF for an exact reading)" };
  }
  throw new Error(`${name}: an older ${/\.xls$/i.test(name) ? "Excel" : /\.(ppt|pps)$/i.test(name) ? "PowerPoint" : "document"} format. Save it as ${/\.xls$/i.test(name) ? ".xlsx" : /\.(ppt|pps)$/i.test(name) ? ".pptx" : ".docx"} or PDF and attach that.`);
}

// ─── Images ──────────────────────────────────────────────────────────────────

/** Draw a bitmap or canvas source into a JPEG data URL no larger than MAX_SIDE. */
function toJpeg(src, w, h) {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

async function readImage(file, opts = {}) {
  tooBig(file, LIMITS.image, "images");
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    if (opts.convert) {
      opts.status?.(`Converting ${file.name} on this computer…`);
      const r = await opts.convert(file);
      if (r?.image) return { images: [r.image], note: "converted to JPEG on this computer" };
    }
    throw new Error(`${file.name || "This image"}: this format cannot be opened here. Save it as JPEG or PNG.`);
  }
  const url = toJpeg(bmp, bmp.width, bmp.height);
  bmp.close?.();
  return { images: [url] };
}

// ─── PDFs ────────────────────────────────────────────────────────────────────

let pdfjs = null;
async function readPdf(file, { canSee, status, name = file.name }) {
  tooBig(file, LIMITS.pdf, "PDFs");
  if (!pdfjs) {
    pdfjs = await import("../vendor/pdfjs/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
  }
  let doc;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise; }
  catch (e) {
    if (e?.name === "PasswordException") throw new Error(`${name} is protected by a password. Open it, save a copy without one, and attach that.`);
    throw new Error(`${name} could not be read as a PDF: it may be damaged.`);
  }
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    if (i % 10 === 1) status?.(`Reading ${name}: page ${i} of ${doc.numPages}…`);
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
    status?.(`Looking at page ${i} of ${name}…`);
    const page = await doc.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(2, MAX_SIDE / Math.max(vp0.width, vp0.height)) });
    const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp, canvas: c }).promise;
    images.push(c.toDataURL("image/jpeg", 0.85));
  }
  return { text, images, note: `scanned: ${images.length} of ${doc.numPages} pages shown as images`, scanned: true };
}

// ─── Recordings ──────────────────────────────────────────────────────────────

let worker = null, seq = 0, speechMode = "local";
const waiting = new Map();
/** "local": Lodestone Desktop serves the speech model; "web": it is in this browser's storage (speechweb.js). */
export function setSpeechMode(m) { speechMode = m === "web" ? "web" : "local"; }
// Whisper is told the language: left to itself, transformers.js assumes English
// and renders other speech as English approximations.
const LANG_NAMES = { en: "english", fr: "french", es: "spanish", ar: "arabic", pt: "portuguese", de: "german", zh: "chinese", ja: "japanese", hi: "hindi", ru: "russian", it: "italian", nl: "dutch", tr: "turkish", fa: "persian", ur: "urdu" };
export const speechLanguage = code => LANG_NAMES[String(code || "").slice(0, 2).toLowerCase()] || null;

function transcribe(audio, language) {
  if (!worker) {
    worker = new Worker(new URL("./asr-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = e => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); e.data.error ? w.reject(new Error(e.data.error)) : w.resolve(e.data.text); };
    worker.onerror = e => { for (const w of waiting.values()) w.reject(new Error(e.message || "The speech model stopped.")); waiting.clear(); worker = null; };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ id, audio, language, mode: speechMode }, [audio.buffer]); });
}

/** Mixed to one channel at 16 kHz; each channel let go as soon as it is added. */
async function decodeMono(blob, what) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  let buf;
  try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()); }
  catch { throw new Error(what); }
  finally { ctx.close?.(); }
  const mono = new Float32Array(buf.length);
  const k = 1 / buf.numberOfChannels;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) mono[i] += d[i] * k; }
  return { mono, duration: buf.duration };
}

/** Where to cut near `at`: the quietest half-second within ten seconds of it. */
export function quietCut(mono, at, rate = 16000) {
  const win = rate / 2, span = rate * 10;
  let best = at, low = Infinity;
  for (let s = Math.max(0, at - span); s + win < Math.min(mono.length, at + span); s += win / 2) {
    let e = 0; for (let i = s; i < s + win; i += 8) e += mono[i] * mono[i];
    if (e < low) { low = e; best = s + (win >> 1); }
  }
  return best;
}

/** Ten-minute parts, cut where it is quiet, so a long recording shows its progress and no word is split. */
export function partsOf(mono, rate = 16000, partMin = PART_MIN) {
  const len = rate * 60 * partMin, cuts = [0];
  while (mono.length - cuts[cuts.length - 1] > len * 1.25) cuts.push(quietCut(mono, cuts[cuts.length - 1] + len, rate));
  cuts.push(mono.length);
  return cuts.slice(0, -1).map((c, i) => [c, cuts[i + 1]]);
}

/**
 * Dictation: a clip recorded from the microphone, turned into text by the same
 * Whisper, on this computer. Resolves to the text ("" when nothing was heard).
 */
export async function transcribeClip(blob, language = null) {
  const { mono, duration } = await decodeMono(blob, "The recording could not be decoded.");
  if (duration < 0.3) return "";
  // Whisper fills silence with stock phrases; a clip with no voice in it is nothing.
  let peak = 0; for (let i = 0; i < mono.length; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; }
  if (peak < 0.01) return "";
  const text = String(await transcribe(mono, language) || "").trim();
  return /^[\[(]?\s*(blank_audio|silence|music|inaudible)\s*[\])]?$/i.test(text) ? "" : text;
}

const mins = m => m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.max(1, Math.round(m))} min`;

async function readAudio(file, { status, language }) {
  const lim = audioLimits();
  tooBig(file, lim.bytes, "recordings and videos");
  const video = /^video\//.test(file.type || "") || /\.(mp4|m4v|mov|mkv|avi|webm)$/i.test(file.name || "");
  status?.(`Decoding ${file.name}${(file.size || 0) > 50 * MB ? ` (${sizeLabel(file.size)})` : ""}…`);
  const { mono, duration } = await decodeMono(file, video
    ? `The sound of ${file.name} cannot be decoded here. MP4 and MOV with AAC sound work; otherwise save its sound as M4A or MP3.`
    : `${file.name}: this recording's format cannot be decoded here. MP3, M4A, WAV, AIFF, OGG and FLAC work.`);
  const minutes = duration / 60;
  if (minutes > lim.minutes) throw new Error(`${file.name} lasts ${mins(minutes)}; Lodestone transcribes up to ${mins(lim.minutes)} here. Cut it in parts and attach each.`);
  let peak = 0; for (let i = 0; i < mono.length; i += 4) { const a = Math.abs(mono[i]); if (a > peak) peak = a; }
  if (peak < 0.01) throw new Error(`${file.name}: no voice could be heard in it.`);
  const parts = partsOf(mono);
  const texts = [];
  for (let i = 0; i < parts.length; i++) {
    const [a, b] = parts[i];
    status?.(parts.length > 1
      ? `Transcribing ${file.name} on this ${desktopish() ? "computer" : "device"}: part ${i + 1} of ${parts.length} (${mins(minutes)} in all)…`
      : `Transcribing ${file.name} (${mins(minutes)}) on this ${desktopish() ? "computer" : "device"}…`);
    texts.push(String(await transcribe(mono.slice(a, b), language) || "").trim());
  }
  const text = texts.filter(Boolean).join("\n\n");
  return { text, note: `transcript of a ${mins(minutes)} ${video ? "video" : "recording"}` };
}

// ─── One file ────────────────────────────────────────────────────────────────

/**
 * Read one file. `canSee`: whether the model in use takes images; `language`:
 * Whisper's name for the spoken language (speechLanguage()); `convert`: the
 * desktop's converter for formats a browser cannot open (file → { text } or
 * { image }), absent elsewhere.
 * Resolves to { name, kind, text?, images?, note?, cut? }.
 */
export async function readAttachment(file, { canSee = false, status, language = null, convert = null, inArchive = false } = {}) {
  let kind = kindOf(file);
  const base = { name: file.name || "file", kind };
  const opts = { canSee, status, language, convert, inArchive };
  if (!file.size && kind !== "image") throw new Error(`${base.name} is empty.`);
  if (kind === "image") return { ...base, ...(await readImage(file, opts)) };
  if (kind === "pdf") { const r = await readPdf(file, opts); return { ...base, ...r, ...cap(r.text || "") }; }
  if (kind === "document") { const r = await readDocument(file, opts); return { ...base, ...r, ...cap(r.text || "") }; }
  if (kind === "archive") { if (inArchive) throw new Error("an archive inside an archive"); const r = await readArchive(file, opts); return { ...base, ...r, ...cap(r.text || "") }; }
  if (kind === "legacy") { const r = await readLegacy(file, opts); return { ...base, kind: "document", ...r }; }
  if (kind === "audio") { const r = await readAudio(file, opts); return { ...base, ...r, ...cap(r.text) }; }
  // Text by its name, or a file of no known kind: read as text when it is text.
  const r = await readText(file);
  if (r) return { ...base, kind: "text", ...r };
  if (kind === "text") throw new Error(`${base.name} is not text after all: its bytes are binary.`);
  if (convert) {
    const c = await convert(file).catch(() => null);
    if (c?.text) return { ...base, kind: "document", ...cap(c.text), note: c.note || "converted on this computer" };
  }
  throw new Error(`${base.name}: Lodestone cannot read this kind of file${/\.\w+$/.test(base.name) ? ` (.${base.name.split(".").pop()})` : ""}. Documents, spreadsheets, presentations, PDFs, text and code, images, recordings, videos and zip archives can be read; save it as one of those.`);
}

// What a file says cannot close the block it is read in, nor open one of the
// app's own (1.13.1): "</file></attached_files><instructions>" in a file, or in
// a name inside a zip, would otherwise stand outside it in the prompt.
const OWN_TAGS = /<(\/?)\s*(file|attached_files|earlier_conversations|your_folders|life_book|lifebook|care_check|person_context|doctrinal_backbone|web_results|witness_mode_active|engagement_band|temporal|instructions?|system)\b/gi;
export const neutral = t => String(t ?? "").replace(OWN_TAGS, "‹$1$2");
const attrSafe = t => neutral(t).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/["<>]/g, "'").slice(0, 300);

/** The <attached_files> block; `budget` in characters across all files. */
export function filesBlock(files, budget) {
  const withText = files.filter(f => f.text);
  if (!withText.length) return "";
  const each = Math.max(1500, Math.floor(budget / withText.length));
  const parts = withText.map(f => {
    const t = f.text.length > each ? f.text.slice(0, each) : f.text;
    const shortened = f.text.length > each || f.cut;
    return `<file name="${attrSafe(f.name)}" kind="${attrSafe(f.kind)}"${f.note ? ` note="${attrSafe(f.note)}"` : ""}${f.earlier ? ' attached="earlier in this conversation"' : ""}>\n${neutral(t)}${shortened ? `\n[… shortened: ${t.length.toLocaleString("en")} of ${(f.cut || f.text.length).toLocaleString("en")} characters fit in the model's window]` : ""}\n</file>`;
  });
  return `<attached_files>\n${parts.join("\n\n")}\n</attached_files>`;
}
