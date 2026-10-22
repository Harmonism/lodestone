// electrontest-guard.cjs — Lodestone Desktop in Electron (1.12): the welcome page
// gets its bridge; another local page the window is sent to does not, and the
// window stays where it was; the app's own page may record sound but not use
// the camera; an unreadable desktop.json is kept aside and said so.
//
//   npm i --no-save playwright-core
//   ELECTRON=<path to electron> xvfb-run -a node tools/electrontest-guard.cjs
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const { _electron } = require(require.resolve("playwright-core", { paths: [path.join(__dirname, "..", "desktop")] }));
let fails = 0;
const ok = async (name, fn) => { try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "  " + e.message); } };
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ls-etest-"));
  const ud = path.join(home, ".config", "Lodestone");
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, "desktop.json"), "{ \"model\": \"x\", broken");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  const app = await _electron.launch({ executablePath: process.env.ELECTRON || require("electron"), args: [path.join(__dirname, "..", "desktop"), "--no-sandbox", "--use-fake-device-for-media-stream"], env, timeout: 60000 });
  try {
    const w = await app.firstWindow();
    await w.waitForLoadState("domcontentloaded");
    const until = async (f, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await f()) return true; } catch {} await new Promise(r => setTimeout(r, 250)); } return false; };
    let page = null;
    await until(async () => (page = app.windows().find(p => p.url().endsWith("launcher.html") || p.url().includes("launcher.html?"))) && await page.evaluate(() => !!window.desktop));
    await ok("the welcome page has its bridge", async () => { assert(page, "no welcome page: " + app.windows().map(p => p.url()).join(", ")); assert(await page.evaluate(() => typeof window.desktop.status === "function")); });
    await ok("an unreadable desktop.json is kept aside, not overwritten", async () => {
      const names = fs.readdirSync(ud);
      assert(names.some(n => /^desktop\.json\.corrupt-\d+$/.test(n)), names.join(", "));
      assert.strictEqual(fs.readFileSync(path.join(ud, names.find(n => n.includes("corrupt"))), "utf8"), "{ \"model\": \"x\", broken");
    });
    const other = path.join(home, "other.html"); fs.writeFileSync(other, "<title>other</title><p>x</p>");
    await ok("another local page: the window does not go there", async () => {
      const before = page.url();
      await page.evaluate(u => { location.href = u; }, "file://" + other).catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
      assert.strictEqual(page.url(), before);
    });
    await ok("a local page loaded anyway gets no bridge", async () => {
      await app.evaluate(async ({ BrowserWindow }, [f, pre]) => { const b = new BrowserWindow({ show: false, webPreferences: { preload: pre, contextIsolation: true, sandbox: true } }); await b.loadFile(f); }, [other, path.join(__dirname, "..", "desktop", "src", "preload.js")]);
      let pg = null; await until(() => (pg = app.windows().find(p => p.url().endsWith("other.html"))));
      assert(pg, "no page");
      assert.strictEqual(await pg.evaluate(() => typeof window.desktop), "undefined");
    });
    await ok("Lodestone's own origin may record sound, not film", async () => {
      const port = 47863;
      await until(async () => (await fetch(`http://127.0.0.1:${port}/lodestone-app/`).catch(() => null))?.ok);
      await app.evaluate(async ({ BrowserWindow }, port) => { const b = new BrowserWindow({ show: false }); await b.loadURL(`http://127.0.0.1:${port}/lodestone-app/manifest.webmanifest`); }, port);
      let pg = null; await until(() => (pg = app.windows().find(p => p.url().includes("manifest.webmanifest"))));
      const gum = c => pg.evaluate(c => navigator.mediaDevices.getUserMedia(c).then(s => { s.getTracks().forEach(t => t.stop()); return "granted"; }, e => e.name), c);
      const audio = await gum({ audio: true }), video = await gum({ video: true });
      assert.strictEqual(audio, "granted", "audio: " + audio);
      assert.strictEqual(video, "NotAllowedError", "video: " + video);
      const other = await pg.evaluate(() => Notification.permission);
      assert.notStrictEqual(other, "denied", "the app's own page lost notifications");
    });
  } finally { await app.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); }
  console.log(fails ? `\n${fails} failed` : "\nall Electron checks passed");
  process.exit(fails ? 1 : 0);
})();
