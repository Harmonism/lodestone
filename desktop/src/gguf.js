// gguf.js — what a model file needs, read from its head.
//
// Ported unchanged from Lode desktop, now Quarry desktop (quarry-desktop/src/llamaserver.js, ggufInfo, 0.10.1),
// where it told Prism ML's ternary files from standard ones on the first Mac run:
// the standard engine refuses them ("invalid ggml type 143"). Lodestone uses
// `needs`: "prism" runs the file on Prism ML's engine, "unknown" on none.

const fs = require("fs");

// GGUF: "GGUF", version u32, tensor count u64, key-value count u64, then the
// key-values (string key, u32 type, value). Read from the head of the file
// only; the tokenizer's arrays are skipped without being kept.
const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STR: 8, ARR: 9, U64: 10, I64: 11, F64: 12 };
const SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const HEAD = 24 * 1024 * 1024;
// ggml's tensor types: upstream llama.cpp b11243 knows 0–42 ("should be in [0, 43)");
// Prism ML's fork adds its ternary packings (PQ2_0 142, PTQ1_0 143, seen in their files).
const STANDARD_TYPES = 43;
const PRISM_TYPES = new Set([141, 142, 143, 144, 145]);

function ggufInfo(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, HEAD));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.toString("latin1", 0, 4) !== "GGUF") throw new Error("not a GGUF file");
    let o = 4;
    const need = n => { if (o + n > buf.length) throw new RangeError("past the head"); };
    const u32 = () => { need(4); const v = buf.readUInt32LE(o); o += 4; return v; };
    const u64 = () => { need(8); const v = Number(buf.readBigUInt64LE(o)); o += 8; return v; };
    const str = () => { const n = u64(); need(n); const s = buf.toString("utf8", o, o + n); o += n; return s; };
    const val = t => {
      switch (t) {
        case T.U8: need(1); return buf.readUInt8(o++);
        case T.I8: need(1); return buf.readInt8(o++);
        case T.U16: need(2); o += 2; return buf.readUInt16LE(o - 2);
        case T.I16: need(2); o += 2; return buf.readInt16LE(o - 2);
        case T.U32: return u32();
        case T.I32: need(4); o += 4; return buf.readInt32LE(o - 4);
        case T.F32: need(4); o += 4; return buf.readFloatLE(o - 4);
        case T.BOOL: need(1); return !!buf.readUInt8(o++);
        case T.STR: return str();
        case T.U64: return u64();
        case T.I64: need(8); o += 8; return Number(buf.readBigInt64LE(o - 8));
        case T.F64: need(8); o += 8; return buf.readDoubleLE(o - 8);
        case T.ARR: {
          const et = u32(), n = u64();
          if (et === T.STR) { for (let i = 0; i < n; i++) str(); return { array: n }; }
          if (et === T.ARR) throw new Error("nested arrays");
          const w = SIZE[et]; if (!w) throw new Error("bad array type");
          need(w * n); o += w * n; return { array: n };
        }
        default: throw new Error("bad value type " + t);
      }
    };
    const version = u32();
    if (version < 2 || version > 3) throw new Error("GGUF version " + version + " is not supported");
    const tensors = u64(), kvs = u64();
    const kv = {};
    let whole = true;
    for (let i = 0; i < kvs; i++) {
      let k, t;
      try { k = str(); t = u32(); kv[k] = val(t); } catch (e) { if (e instanceof RangeError) { whole = false; break; } throw e; }
    }
    // The tensors' types (name, dimensions, type, offset each), to tell a file
    // no standard llama.cpp can load (Prism ML's ternary types, 141 and up).
    const types = new Set();
    if (whole) {
      try { for (let i = 0; i < tensors; i++) { str(); const nd = u32(); for (let j = 0; j < nd; j++) u64(); types.add(u32()); u64(); } }
      catch (e) { if (!(e instanceof RangeError)) throw e; }
    }
    const arch = typeof kv["general.architecture"] === "string" ? kv["general.architecture"] : null;
    return {
      name: typeof kv["general.name"] === "string" ? kv["general.name"] : null,
      arch,
      sizeLabel: typeof kv["general.size_label"] === "string" ? kv["general.size_label"] : null,
      trained: arch && typeof kv[`${arch}.context_length`] === "number" ? kv[`${arch}.context_length`] : null,
      hasTemplate: typeof kv["tokenizer.chat_template"] === "string",
      bytes: size,
      types: [...types].sort((a, b) => a - b),
      needs: [...types].some(t => PRISM_TYPES.has(t)) ? "prism" : [...types].some(t => t >= STANDARD_TYPES) ? "unknown" : null,
    };
  } finally { fs.closeSync(fd); }
}

module.exports = { ggufInfo, STANDARD_TYPES, PRISM_TYPES };
