// test-whisperlocal.cjs — speech on this computer (desktop/src/whisperlocal.js),
// without the engine or the model: a stand-in whisper-cli answers. Checks that
// the file is the same as Lode's copy, the WAV written, the language and the
// vocabulary prompt passed, the second hearing, and nothing left on disk.
//   node tools/test-whisperlocal.cjs
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const W = require("../desktop/src/whisperlocal");
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log("PASS " + name); };
(async () => {
  await ok("the same file as Lode's (lode-desktop/src/whisperlocal.js), when Lode is beside", () => {
    const lode = path.join(__dirname, "..", "..", "lode-desktop", "src", "whisperlocal.js");
    if (!fs.existsSync(lode)) return console.log("     (Lode is not beside Lodestone: not compared)");
    assert.strictEqual(fs.readFileSync(lode, "utf8"), fs.readFileSync(path.join(__dirname, "..", "desktop", "src", "whisperlocal.js"), "utf8"));
  });
  await ok("samples become a 16 kHz WAV; names and tags become codes", () => {
    const w = W.wav(new Float32Array([0, 1, -1]));
    assert(W.isWav(w)); assert.strictEqual(w.readUInt32LE(24), 16000); assert.strictEqual(w.readInt16LE(46), 32767); assert.strictEqual(w.readInt16LE(48), -32768);
    assert.deepStrictEqual(["french", "en-GB", "auto", null].map(W.code), ["fr", "en", null, null]);
  });
  await ok("told the language and primed in it; with none, named by Whisper and heard again primed for a misheard term; nothing left", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ls-hs-"));
    fs.writeFileSync(path.join(tmp, W.MODEL), "m");
    const log = path.join(tmp, "calls.log"), engine = path.join(tmp, "whisper-cli");
    fs.writeFileSync(engine, `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nout=""; lang=auto; prompt=""\nwhile [ $# -gt 0 ]; do case "$1" in -of) out="$2"; shift;; -l) lang="$2"; shift;; --prompt) prompt="$2"; shift;; esac; shift; done\n[ "$lang" = auto ] && lang=en\nif [ -n "$prompt" ]; then t=" I read Lodestone."; else t=" I read load stone."; fi\nprintf '{"result":{"language":"%s"},"transcription":[{"text":"%s"}]}' "$lang" "$t" > "$out.json"\n`, { mode: 0o755 });
    const vocab = { en: "I was reading Lodestone on Harmonism." };
    const before = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("harmonia-speech-")).length;
    const r = await W.transcribe({ engine, dir: tmp, audio: new Float32Array(16000), language: null, vocabulary: vocab, threads: 2 });
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.deepStrictEqual([r.text, r.language, calls.length], ["I read Lodestone.", "en", 2]);
    assert.match(calls[0], /-l auto/); assert.match(calls[1], /-l en .*--prompt I was reading Lodestone/);
    fs.unlinkSync(log);
    await W.transcribe({ engine, dir: tmp, audio: new Float32Array(16000), language: "english", vocabulary: vocab, threads: 2 });
    assert.strictEqual(fs.readFileSync(log, "utf8").trim().split("\n").length, 1);
    assert.strictEqual(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("harmonia-speech-")).length, before);
    await assert.rejects(W.transcribe({ engine: null, dir: tmp, audio: new Float32Array(10) }), /not built/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await ok("a download that fails its checksum keeps nothing", async () => {
    const dl = fs.mkdtempSync(path.join(os.tmpdir(), "ls-hs-"));
    await assert.rejects(W.download(dl, { fetch: async () => ({ ok: true, body: (async function* () { yield Buffer.alloc(10); })() }) }), /checksum/);
    assert.deepStrictEqual(fs.readdirSync(dl), []);
    fs.rmSync(dl, { recursive: true, force: true });
  });
  console.log(`${n} passed`);
})().catch(e => { console.log("FAIL", e.message); process.exit(1); });
