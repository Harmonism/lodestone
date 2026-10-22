// lifebook.js — the practitioner's life book on disk.
//
// The practitioner chooses their vault in Settings → Life book; Lodestone's
// folder is <vault>/Lodestone/. This is the one place Lodestone writes, and it
// writes only a change the practitioner has confirmed in the window (the card
// shows it first). Everything else in the vault stays untouched and unread by
// this module; reading other folders is folders.js, read-only.
//
//   entries()       every note of the folder: .md files, no hidden folders, no
//                   symbolic links, at most 2,000 notes of 512 KB each
//   write(change)   create a note, append to one, or replace one passage that
//                   occurs exactly once. The path must stay inside the folder,
//                   whatever links the disk holds. A note changed since the card
//                   was made (Obsidian, sync) is not overwritten. The note as it
//                   stood is copied to Lodestone/.backups/ first; the result is
//                   read back from disk and compared before success is reported.

const fs = require("fs");
const path = require("path");

const DIR = "Lodestone";
const MAX_NOTES = 2000, MAX_BYTES = 512 * 1024, MAX_WRITE = 64 * 1024;

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-").slice(0, 19);

class LifeBook {
  /** @param {() => string|null} vault  the chosen vault folder, or null */
  constructor(vault) { this.vault = vault; this.cache = null; this.cachedAt = 0; }

  dir() { const v = this.vault(); return v ? path.join(v, DIR) : null; }

  /** The folder's real path, made when missing (the vault must exist). */
  ensure() {
    const v = this.vault();
    if (!v || !fs.existsSync(v) || !fs.statSync(v).isDirectory()) throw new Error("The vault folder is not there any more. Choose it again in Settings → Life book.");
    const d = path.join(v, DIR);
    if (fs.existsSync(d)) {
      if (fs.lstatSync(d).isSymbolicLink()) throw new Error("Lodestone/ in this vault is a link to somewhere else; Lodestone writes only to a real folder.");
    } else fs.mkdirSync(d);
    return fs.realpathSync(d);
  }

  entries() {
    if (this.cache && Date.now() - this.cachedAt < 5000) return this.cache;
    const d = this.dir();
    if (!d || !fs.existsSync(d)) return (this.cache = [], this.cachedAt = Date.now(), []);
    const root = fs.realpathSync(d), out = [], stack = [root];
    while (stack.length && out.length < MAX_NOTES) {
      const cur = stack.pop();
      let ents; try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
        const p = path.join(cur, e.name);
        if (e.isDirectory()) { stack.push(p); continue; }
        if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.size > MAX_BYTES) continue;
        out.push({ rel: path.relative(root, p).split(path.sep).join("/"), mtime: Math.floor(st.mtimeMs), text: fs.readFileSync(p, "utf8") });
      }
    }
    out.sort((a, b) => a.rel.localeCompare(b.rel));
    this.cache = out; this.cachedAt = Date.now();
    return out;
  }

  /** The absolute path for a note path inside the folder, or an error. Parent folders are made. */
  resolve(rel, root) {
    const r = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!r || r.length > 200 || !/\.md$/i.test(r) || r.split("/").some(s => !s || s === "." || s === ".." || s.startsWith(".")) || /[:*?"<>|\u0000-\u001f]/.test(r)) {
      throw new Error(`“${r.slice(0, 80)}” is not a note path Lodestone may write.`);
    }
    const segs = r.split("/");
    // Folders are walked one at a time, so a link inside the folder never leads a new folder elsewhere.
    let cur = root;
    for (const s of segs.slice(0, -1)) {
      cur = path.join(cur, s);
      if (fs.existsSync(cur)) {
        const st = fs.lstatSync(cur);
        if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("That path passes through a link or a file; Lodestone writes only inside its own folder.");
      } else fs.mkdirSync(cur);
    }
    const abs = path.join(root, ...segs);
    const realParent = fs.realpathSync(path.dirname(abs));
    if (realParent !== root && !realParent.startsWith(root + path.sep)) throw new Error("That path leaves Lodestone's folder.");
    const target = path.join(realParent, path.basename(abs));
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("That note is a link; Lodestone does not write through links.");
    return { abs: target, rel: path.relative(root, target).split(path.sep).join("/") };
  }

  /**
   * Applies one confirmed change. { op: "create"|"append"|"replace", path, text, find, replace, mtime }.
   * Returns { rel, backup, before, after } with both texts as now on disk.
   */
  write(change) {
    const root = this.ensure();
    const { abs, rel } = this.resolve(change.path, root);
    const exists = fs.existsSync(abs);
    const before = exists ? fs.readFileSync(abs, "utf8") : null;
    if (exists && change.mtime && Math.floor(fs.statSync(abs).mtimeMs) !== Math.floor(change.mtime)) {
      throw new Error(`${rel} has changed since this was proposed (edited elsewhere?). Nothing was written; the proposal can be made again.`);
    }
    let after;
    if (change.op === "create") {
      if (exists) throw new Error(`${rel} already exists; nothing was written.`);
      after = String(change.text || "");
    } else if (change.op === "append") {
      if (!exists) throw new Error(`${rel} is not there; nothing was written.`);
      after = before.replace(/\s*$/, "\n") + String(change.text || "");
    } else if (change.op === "replace") {
      if (!exists) throw new Error(`${rel} is not there; nothing was written.`);
      const find = String(change.find || "");
      if (!find || before.split(find).length !== 2) throw new Error(`The passage to replace is not in ${rel} exactly once now; nothing was written.`);
      after = before.replace(find, () => String(change.replace ?? ""));
    } else throw new Error("Unknown change.");
    if (Buffer.byteLength(after) > MAX_WRITE + (before ? Buffer.byteLength(before) : 0)) throw new Error("That change is too long for one note.");
    let backup = null;
    if (exists) {
      // Made folder by folder, never through a link someone left where a folder goes.
      let bdir = root;
      for (const part of [".backups", ...path.dirname(rel).split(/[\\/]/).filter(x => x && x !== ".")]) {
        bdir = path.join(bdir, part);
        let st = null; try { st = fs.lstatSync(bdir); } catch {}
        if (st && !st.isDirectory()) throw new Error("Lodestone/.backups holds a link or a file where a folder goes; nothing was written.");
        if (!st) fs.mkdirSync(bdir);
      }
      const base = path.join(bdir, `${path.basename(rel)}.${stamp()}`);
      backup = base;
      for (let n = 2; fs.existsSync(backup); n++) backup = `${base}-${n}`;   // two changes in one second
      fs.copyFileSync(abs, backup, fs.constants.COPYFILE_EXCL);
    }
    // A name of its own each time: a write a crash left behind never blocks the next (1.12).
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}-${Date.now()}.lodestone-tmp`);
    const mode = exists ? fs.statSync(abs).mode & 0o777 : 0o644;
    fs.writeFileSync(tmp, after, { flag: "wx", mode });
    try { fs.renameSync(tmp, abs); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
    const now = fs.readFileSync(abs, "utf8");
    this.cache = null;
    if (now !== after) throw new Error(`${rel} did not read back as written; the copy from before is in Lodestone/.backups/.`);
    return { rel, backup: backup && path.relative(root, backup).split(path.sep).join("/"), before, after: now, mtime: Math.floor(fs.statSync(abs).mtimeMs) };
  }
}

module.exports = { LifeBook, DIR };
