// test-server-guard.cjs — who may use Lodestone Desktop's own server (1.12):
// a page on another site cannot spend the model or the rented key (Origin), a
// name pointed at this computer by DNS rebinding is refused (Host); Lodestone's
// own page, the Android app's origin and a request with no origin pass. Also the
// settings and the sync store: an unreadable file is kept aside, not overwritten.
//   node tools/test-server-guard.cjs
const assert = require("assert"), http = require("http"), path = require("path"), fs = require("fs"), os = require("os");
const { createServer, hostOk } = require("../desktop/src/server.js");
const { SyncStore } = require("../desktop/src/syncstore.js");
let fails = 0;
const ok = async (name, fn) => { try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "  " + e.message); } };
const req = (port, method, p, headers = {}, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
  r.on("error", reject); if (body) r.write(body); r.end();
});
const model = http.createServer((q, s) => { s.writeHead(200, { "Content-Type": "application/json" }); s.end(JSON.stringify({ choices: [{ message: { content: "spent" } }] })); });
model.listen(0, "127.0.0.1", async () => {
  const up = `http://127.0.0.1:${model.address().port}/v1`;
  const app = path.join(__dirname, "..", "app");
  const server = createServer({ webRoot: app, corpusRoot: () => path.join(app, "corpus"), site: { resolve: () => null }, companion: { handle: (b, q, s) => { s.writeHead(200); s.end("{}"); } },
    getConfig: () => ({ upstream: up, isEngine: false }), nativeOrigins: new Set(["https://harmonism.io"]) });
  const port = await server.listen(0, false);
  const H = { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" };
  const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  await ok("another site's page cannot use the model", async () => {
    const r = await req(port, "POST", "/v1/chat/completions", { ...H, Origin: "https://evil.example" }, body);
    assert.strictEqual(r.status, 403); assert(!r.body.includes("spent"));
  });
  await ok("nor the site's companion route", async () => {
    const r = await req(port, "POST", "/companion-api.php", { ...H, Origin: "http://evil.example" }, "{}");
    assert.strictEqual(r.status, 403);
  });
  await ok("a name rebound to this computer is refused", async () => {
    const r = await req(port, "POST", "/v1/chat/completions", { ...H, Host: `evil.example:${port}` }, body);
    assert.strictEqual(r.status, 421); assert(!r.body.includes("spent"));
  });
  await ok("Lodestone's own page passes", async () => {
    const r = await req(port, "POST", "/v1/chat/completions", { ...H, Origin: `http://127.0.0.1:${port}` }, body);
    assert.strictEqual(r.status, 200); assert(r.body.includes("spent"));
  });
  await ok("the Android app's origin passes; a request with no origin passes", async () => {
    assert.strictEqual((await req(port, "POST", "/v1/chat/completions", { ...H, Origin: "https://harmonism.io" }, body)).status, 200);
    assert.strictEqual((await req(port, "POST", "/v1/chat/completions", H, body)).status, 200);
  });
  await ok("a phone on the Wi-Fi by address or .local name passes the Host check", async () => {
    for (const h of ["192.168.1.20:47863", "localhost:47863", "tahirs-mac.local:47863", "[::1]:47863"]) assert(hostOk(h), h);
    for (const h of ["evil.example", "127.0.0.1.nip.io", "localhost.evil.example"]) assert(!hostOk(h), h);
  });
  await ok("an unreadable sync store is kept aside, not overwritten", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ls-sync-")), f = path.join(d, "records.json");
    fs.writeFileSync(f, "{ broken");
    const st = new SyncStore(f); st.load(); st.d.rec.x = 1; st.save();
    assert(fs.readdirSync(d).some(n => /^records\.json\.corrupt-\d+$/.test(n)), "not kept aside");
    assert.strictEqual(fs.readFileSync(path.join(d, fs.readdirSync(d).find(n => n.includes("corrupt"))), "utf8"), "{ broken");
  });
  // 1.13.1: from the network, the model answers a paired phone only (its token, or the cookie a phone's browser keeps).
  const os2 = require("os");
  const lanIp = Object.values(os2.networkInterfaces()).flat().find(i => i && i.family === "IPv4" && !i.internal)?.address;
  if (lanIp) {
    const { createPhoneAccess } = require("../desktop/src/pairing.js");
    let list = [];
    const phone = createPhoneAccess({ sync: new SyncStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ls-ph-")), "r.json")), hello: () => ({ app: "lodestone-desktop", name: "Test" }), load: () => list, save: l => { list = l; } });
    const lan = createServer({ webRoot: app, corpusRoot: () => path.join(app, "corpus"), site: { resolve: () => null }, companion: { handle: (b, q, s) => { s.writeHead(200); s.end("{}"); } },
      getConfig: () => ({ upstream: up, isEngine: false }), phone, nativeOrigins: new Set(["https://harmonism.io"]) });
    const lp = await lan.listen(0, true);
    const reqAt = (method, p, headers = {}, body) => new Promise((resolve, reject) => {
      const r = http.request({ host: lanIp, port: lp, method, path: p, headers: { Host: `${lanIp}:${lp}`, "Content-Type": "application/json", ...headers } }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
      r.on("error", reject); if (body) r.write(body); r.end();
    });
    await ok("from the Wi-Fi, an unpaired device cannot use the model or the companion", async () => {
      assert.strictEqual((await reqAt("POST", "/v1/chat/completions", {}, body)).status, 401);
      assert.strictEqual((await reqAt("POST", "/companion-api.php", {}, "{}")).status, 401);
    });
    await ok("a phone's browser pairs with the code and is answered by its cookie; this computer always is", async () => {
      const code = phone.code().code;
      const pr = await reqAt("POST", "/munai-pair", {}, JSON.stringify({ code, name: "Phone browser" }));
      const tok = JSON.parse(pr.body).token;
      assert(tok, pr.body);
      assert.strictEqual((await reqAt("POST", "/v1/chat/completions", { Cookie: `lodestone_pair=${tok}` }, body)).status, 200);
      assert.strictEqual((await reqAt("POST", "/v1/chat/completions", { Authorization: `Bearer ${tok}` }, body)).status, 200);
      const r = await new Promise((resolve, reject) => { const q = http.request({ host: "127.0.0.1", port: lp, method: "POST", path: "/v1/chat/completions", headers: { Host: `127.0.0.1:${lp}`, "Content-Type": "application/json" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); }); q.on("error", reject); q.write(body); q.end(); });
      assert.strictEqual(r, 200);
    });
    await lan.close();
  } else console.log("     (no network address here: the Wi-Fi checks are skipped)");
  await server.close(); model.close();
  console.log(fails ? `\n${fails} failed` : "\nall server checks passed");
  process.exit(fails ? 1 : 0);
});
