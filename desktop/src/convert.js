// convert.js — formats a browser cannot open, converted on this computer for an
// attachment (app/js/attach.js asks through the "convert-file" handler).
//
//   macOS     textutil (old Word, RTF, RTFD, web archives, OpenDocument text,
//             WordML) to text; sips (HEIC, TIFF, PSD, camera RAW, JPEG 2000)
//             to a JPEG of 1,568 pixels at most
//   anywhere  LibreOffice, when installed (soffice): old Word, WordPerfect and
//             Works files to text, old Excel to CSV, old PowerPoint to PDF
//
// The bytes are written to a folder of their own in the temporary folder, under
// a plain name, converted by the tool with no shell between, read back, and the
// folder removed. Nothing leaves the computer. A format with no tool here gives
// null, and the page says how to save the file instead.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const MAX_BYTES = 200 * 1024 * 1024;
const TEXTUTIL = /\.(doc|dot|rtf|rtfd|webarchive|odt|wordml|docx|html?)$/i;
const SIPS = /\.(heic|heif|tiff?|psd|jp2|j2k|dng|cr2|cr3|nef|arw|raf|orf|rw2|bmp|gif|png|jpe?g|webp|avif)$/i;
const OFFICE_TEXT = /\.(doc|dot|wpd|wps|rtf|odt)$/i;
const OFFICE_CSV = /\.(xls|xlt|ods)$/i;
const OFFICE_PDF = /\.(ppt|pps|pot|odp)$/i;

function run(cmd, args, ms) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve(stdout));
  });
}

function soffice() {
  const c = process.platform === "darwin" ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
    : process.platform === "win32" ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "LibreOffice", "program", "soffice.exe"), path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "LibreOffice", "program", "soffice.exe")]
    : ["/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/local/bin/soffice", "/snap/bin/libreoffice"];
  return c.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** What this computer can convert, for the page to say so. */
function tools() {
  return { textutil: process.platform === "darwin", sips: process.platform === "darwin", soffice: !!soffice() };
}

/**
 * name: the file's own name (only its extension is used); bytes: an ArrayBuffer
 * or Uint8Array. Resolves to { text, note } | { image, note } | { pdf, note } | null.
 */
async function convert(name, bytes) {
  const buf = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
  if (!buf.length || buf.length > MAX_BYTES) return null;
  const ext = (/\.([a-z0-9]{1,10})$/i.exec(String(name || "")) || [])[1]?.toLowerCase();
  if (!ext) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lodestone-convert-"));
  const src = path.join(dir, "in." + ext);
  try {
    fs.writeFileSync(src, buf, { mode: 0o600 });
    const mac = process.platform === "darwin";
    if (mac && SIPS.test(src)) {
      const out = path.join(dir, "out.jpg");
      await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", "1568", src, "--out", out], 60000);
      return { image: "data:image/jpeg;base64," + fs.readFileSync(out).toString("base64"), note: "converted to JPEG on this computer" };
    }
    if (mac && TEXTUTIL.test(src) && ext !== "rtfd") {
      const out = path.join(dir, "out.txt");
      await run("/usr/bin/textutil", ["-convert", "txt", "-encoding", "UTF-8", "-output", out, src], 60000);
      return { text: fs.readFileSync(out, "utf8"), note: "converted on this computer" };
    }
    const so = soffice();
    if (so && (OFFICE_TEXT.test(src) || OFFICE_CSV.test(src) || OFFICE_PDF.test(src))) {
      const to = OFFICE_TEXT.test(src) ? "txt:Text (encoded):UTF8" : OFFICE_CSV.test(src) ? "csv:Text - txt - csv (StarCalc):44,34,76,1" : "pdf";
      // Its own profile folder, so a LibreOffice the practitioner has open is not disturbed.
      const profile = "file://" + path.join(dir, "profile").split(path.sep).join("/").replace(/^([A-Za-z]):/, "/$1:");
      await run(so, [`-env:UserInstallation=${profile}`, "--headless", "--norestore", "--convert-to", to, "--outdir", dir, src], 120000);
      const outExt = to.split(":")[0];
      const out = path.join(dir, "in." + outExt);
      if (outExt === "pdf") return { pdf: new Uint8Array(fs.readFileSync(out)), note: "converted by LibreOffice on this computer" };
      return { text: fs.readFileSync(out, "utf8"), note: `converted by LibreOffice on this computer${outExt === "csv" ? " (the first sheet, comma-separated)" : ""}` };
    }
    return null;
  } catch (e) {
    return { error: e.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { convert, tools, MAX_BYTES };
