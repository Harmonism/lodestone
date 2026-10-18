// desktop-phone-server.cjs — Lodestone Desktop's phone server without Electron, for
// tools/test-android.py: the real server.js, pairing.js and
// syncstore.js, a mock model that answers "Answer from the computer.", and a
// control port the test reads the pairing code from.
//
//   node tools/desktop-phone-server.cjs <desktop/src> <app> <port> <control-port> <data-dir> <native-origin>
const path = require("path");
const http = require("http");
const [src, app, port, ctl, dataDir, origin] = process.argv.slice(2);
const { createServer } = require(path.resolve(src, "server.js"));
const { createPhoneAccess } = require(path.resolve(src, "pairing.js"));
const { SyncStore } = require(path.resolve(src, "syncstore.js"));

let paired = [];
let where = null;   // the provider the computer rents its model from; set through the control port
const phone = createPhoneAccess({
  sync: new SyncStore(path.join(dataDir, "records.json")),
  hello: () => ({ app: "lodestone-desktop", name: "Test Mac", version: "1.8.0", where }),
  load: () => paired, save: l => { paired = l; },
});

// The model: OpenAI-shaped, streamed.
const model = http.createServer((req, res) => {
  if (req.url.startsWith("/v1/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "lodestone" }] })); }
  let body = ""; req.on("data", c => body += c); req.on("end", () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const w of ["Answer ", "from ", "the computer."]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}).listen(0, "127.0.0.1", async () => {
  const up = `http://127.0.0.1:${model.address().port}/v1`;
  const server = createServer({
    webRoot: app, corpusRoot: () => path.join(app, "corpus"), site: { resolve: () => null }, companion: { handle: () => {} },
    getConfig: () => ({ upstream: up, isEngine: false }), phone, nativeOrigins: new Set([origin]),
  });
  await server.listen(Number(port), false);
  http.createServer((req, res) => {
    const out = req.url === "/code" ? phone.code() : req.url === "/paired" ? phone.paired() : req.url.startsWith("/forget/") ? (phone.forget(req.url.slice(8)), phone.paired())
      : req.url.startsWith("/where/") ? { where: (where = decodeURIComponent(req.url.slice(7)) || null) } : null;
    res.writeHead(out ? 200 : 404, { "Content-Type": "application/json" }); res.end(JSON.stringify(out));
  }).listen(Number(ctl), "127.0.0.1", () => console.log("ready"));
});
