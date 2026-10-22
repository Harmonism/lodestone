// engine.js — the model engine that ships inside the app.
//
// It is llama.cpp's llama-server (build b11243, MIT), one build per platform:
// Metal on Apple silicon, Vulkan on Windows and Linux with automatic fallback to
// the CPU where no GPU driver is present. It runs as a hidden child process on a
// private port, is never shown to the practitioner, and stops with the app.

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const NUM_CTX = 32768;
// The engine answers only Lodestone's own server, which runs in the app's main
// process and sends this key (as Lode desktop 0.10.1 does with its engine):
// a key made at each start and never written down, no /slots (which serves the
// prompt back), and CORS to an origin that does not exist, so no web page in a
// browser on this computer can read its answers.
const NO_ORIGIN = "https://lodestone.invalid";
const EXE = process.platform === "win32" ? "llama-server.exe" : "llama-server";

function engineDir(packaged, resourcesPath) {
  if (packaged) return path.join(resourcesPath, "engine");
  const name = process.platform === "darwin" ? `darwin-${process.arch}` : `${process.platform}-x64-vulkan`;
  return path.join(__dirname, "..", "engines", name);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * An engine left running by a previous session that ended abruptly (a crash,
 * a forced quit) would keep gigabytes of memory. Its pid is remembered in a
 * file and it is stopped before a new one starts — after checking that the
 * pid still belongs to llama-server, so an unrelated process is never touched.
 */
function killStale(pidFile) {
  let pid;
  try { pid = Number(fs.readFileSync(pidFile, "utf8")); } catch { return; }
  if (!pid) return;
  try {
    const name = process.platform === "win32"
      ? execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true })
      : execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    if (/llama-server/i.test(name)) process.kill(pid);
  } catch {}
  try { fs.rmSync(pidFile, { force: true }); } catch {}
}

class Engine {
  constructor({ dir, logFile, pidFile }) {
    this.dir = dir; this.logFile = logFile; this.pidFile = pidFile;
    this.proc = null; this.port = null; this.model = null; this.tail = [];
  }

  get url() { return this.port ? `http://127.0.0.1:${this.port}` : null; }
  get running() { return !!(this.proc && this.proc.exitCode === null && this.port); }

  /**
   * Start on `modelPath`; resolves once the model is loaded and answering.
   * `dir` names another engine build for this one model (the Prism engine a
   * ternary model needs); without it the bundled engine runs.
   */
  async start(modelPath, { onStatus = () => {}, mmproj = null, dir = null, keyOnCommandLine = false } = {}) {
    await this.stop();
    if (this.pidFile) killStale(this.pidFile);
    dir = dir || this.dir;
    const bin = path.join(dir, EXE);
    if (!fs.existsSync(bin)) throw new Error(`The engine is missing from this installation (${bin}).`);
    if (process.platform !== "win32") { try { fs.chmodSync(bin, 0o755); } catch {} }
    // macOS marks everything in a downloaded app as quarantined; the app itself
    // was approved when it was first opened, and its own engine needs no second
    // approval. Fails harmlessly where the app sits on a read-only volume.
    if (process.platform === "darwin") { try { execFileSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", dir]); } catch {} }
    const port = await freePort();
    this.apiKey = require("crypto").randomBytes(18).toString("base64url");
    const args = [
      "-m", modelPath, "--host", "127.0.0.1", "--port", String(port),
      "-c", String(NUM_CTX),            // the whole backbone, retrieval and history
      "-np", "1",                       // one conversation, so one slot holds the full window
      "--alias", "lodestone",
      "--jinja",
      // Lodestone never shows reasoning; a thinking model would spend the reply's
      // budget on it and answer with nothing.
      "--reasoning-budget", "0",
      "--chat-template-kwargs", '{"enable_thinking":false}',
      "--no-webui",
      "--no-slots",
      "--cors-origins", NO_ORIGIN,
      // The key goes in the environment, where another user of this computer cannot
      // read it from the process list (1.13.1); on the command line only if an
      // engine turns out not to read it there (checked below).
      ...(keyOnCommandLine ? ["--api-key", this.apiKey] : []),
    ];
    // The vision projector, when it has been downloaded: images in the chat request are then seen.
    if (mmproj && fs.existsSync(mmproj)) args.push("--mmproj", mmproj);
    // The engine is given no one's secrets, nor settings that would change it behind these flags (1.12, after Lode).
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!/(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$|^LLAMA_ARG_|^OPENROUTER|^ANTHROPIC|^OPENAI/i.test(k)) env[k] = v;
    if (!keyOnCommandLine) env.LLAMA_API_KEY = this.apiKey;
    if (process.platform === "linux") env.LD_LIBRARY_PATH = [dir, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    this.tail = [];
    let log = null;
    try { log = fs.createWriteStream(this.logFile, { flags: "w" }); } catch {}
    const proc = spawn(bin, args, { cwd: dir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc; this.model = modelPath; this.mmproj = mmproj && fs.existsSync(mmproj) ? mmproj : null;
    if (this.pidFile && proc.pid) { try { fs.writeFileSync(this.pidFile, String(proc.pid)); } catch {} }
    const onData = d => {
      log?.write(d);
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) { this.tail.push(line); if (this.tail.length > 40) this.tail.shift(); }
    };
    proc.stdout.on("data", onData); proc.stderr.on("data", onData);
    let exited = null;
    proc.on("exit", (code, sig) => { exited = { code, sig }; log?.end(); if (this.proc === proc) { this.port = null; } });
    proc.on("error", e => { exited = { code: -1, sig: String(e.message) }; });

    onStatus("Waking Lodestone…");
    const started = Date.now();
    for (;;) {
      // A newer start took over (1.13.1): this one ends without touching the newer process.
      if (this.proc !== proc) { try { proc.kill(); } catch {} throw new EngineError("Replaced by another start.", ""); }
      if (exited) {
        if (this.proc === proc) this.proc = null;
        throw new EngineError(explain(this.tail), this.tail.slice(-12).join("\n"));
      }
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(2000) });
        if (r.ok && this.proc === proc) {
          // An engine that answers without the key did not take it from the environment: start again with it on the command line.
          if (!keyOnCommandLine) {
            // A request the server would refuse anyway (an empty body), sent without the key: 401 means the key holds.
            const open = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(3000) }).catch(() => null);
            if (open && open.status !== 401) return this.start(modelPath, { onStatus, mmproj, dir, keyOnCommandLine: true });
          }
          this.port = port; return port;
        }
      } catch {}
      if (Date.now() - started > 15 * 60 * 1000) { await this.stop(); throw new EngineError("The model took too long to load.", this.tail.slice(-12).join("\n")); }
      await new Promise(r => setTimeout(r, 400));
    }
  }

  /** Immediate, synchronous stop — for a process that is being torn down. */
  killNow() { try { this.proc?.kill(); } catch {} }

  async stop() {
    const p = this.proc; this.proc = null; this.port = null;
    if (!p) return;
    if (this.pidFile) { try { fs.rmSync(this.pidFile, { force: true }); } catch {} }
    if (p.exitCode !== null) return;
    await new Promise(resolve => {
      const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} resolve(); }, 4000);
      p.once("exit", () => { clearTimeout(t); resolve(); });
      try { p.kill(); } catch { clearTimeout(t); resolve(); }
    });
  }
}

class EngineError extends Error {
  constructor(message, detail) { super(message); this.detail = detail; }
}

/** Turn the engine's last words into a sentence a practitioner can act on. */
function explain(tail) {
  const t = tail.join("\n");
  if (/out of memory|failed to allocate|ErrorOutOfDeviceMemory|cudaMalloc|unable to allocate/i.test(t))
    return "This computer does not have enough free memory for this model.";
  if (/unknown model architecture|unsupported model/i.test(t))
    return "Lodestone's engine does not support this kind of model.";
  if (/failed to load GGUF split|No such file/i.test(t))
    return "Part of the model is missing. Downloading it again fixes this; the parts already here are kept.";
  if (/failed to load model/i.test(t))
    return "The model file could not be loaded. It may be damaged; downloading it again usually fixes this.";
  if (/cannot execute|Bad CPU type|image not found|Library not loaded|dll/i.test(t))
    return "The engine could not start on this computer.";
  return "The model stopped while loading.";
}

module.exports = { Engine, EngineError, engineDir, NUM_CTX, EXE };
