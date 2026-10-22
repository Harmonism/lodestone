// test-telegram-files.cjs — a file sent to the practitioner's own bot (1.12):
// fetched from Telegram and handed to the page with its bytes; over 20 MB
// refused with the reason; a sticker answered, not ignored; someone else's chat
// still unanswered. Node only: Telegram and the page are stand-ins.
//   node tools/test-telegram-files.cjs
const assert = require("assert");
const { TelegramBridge, mediaOf } = require("../desktop/src/telegram.js");
let fails = 0;
const ok = async (name, fn) => { try { await fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "  " + e.message); } };
function bridge() {
  const sent = [], asked = [], calls = [];
  const fetch = async (url, init) => {
    if (url.includes("/file/bot")) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("hello from a file").buffer };
    const method = url.split("/").pop(), body = JSON.parse(init.body || "{}");
    calls.push(method);
    if (method === "sendMessage") sent.push(body.text);
    const result = method === "getFile" ? { file_path: "documents/file_1.txt" } : true;
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  const b = new TelegramBridge({ fetch, getToken: () => "123:abc", cfg: () => ({ chatId: 42 }), save() {}, ask: async r => { asked.push(r); return "An answer."; } });
  return { b, sent, asked, calls };
}
const chat = { id: 42, type: "private" };
(async () => {
  await ok("a document: fetched, its bytes and name handed to the page with the caption", async () => {
    const { b, sent, asked } = bridge();
    await b.handle({ message: { chat, caption: "What does it say?", document: { file_id: "f1", file_name: "labs.txt", mime_type: "text/plain", file_size: 17 } } });
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].text, "What does it say?");
    assert.strictEqual(asked[0].file.name, "labs.txt");
    assert.strictEqual(new TextDecoder().decode(asked[0].file.bytes), "hello from a file");
    assert.deepStrictEqual(sent, ["An answer."]);
  });
  await ok("a voice message is marked as such; a photo takes its largest size", async () => {
    assert.strictEqual(mediaOf({ voice: { file_id: "v", mime_type: "audio/ogg", file_size: 5 } }).voice, true);
    assert.strictEqual(mediaOf({ photo: [{ file_id: "small" }, { file_id: "large" }] }).id, "large");
  });
  await ok("over 20 MB: refused with the reason, nothing fetched", async () => {
    const { b, sent, asked, calls } = bridge();
    await b.handle({ message: { chat, video: { file_id: "big", file_size: 48e6 } } });
    assert.strictEqual(asked.length, 0); assert(!calls.includes("getFile"));
    assert.match(sent[0], /48 MB.*up to 20 MB/);
  });
  await ok("a sticker is answered, not met with silence", async () => {
    const { b, sent } = bridge();
    await b.handle({ message: { chat, sticker: { file_id: "s" } } });
    assert.match(sent[0], /cannot/);
  });
  await ok("a file from someone else's chat: no answer, nothing fetched", async () => {
    const { b, sent, calls } = bridge();
    await b.handle({ message: { chat: { id: 7, type: "private" }, document: { file_id: "x", file_name: "a.txt" } } });
    assert.strictEqual(sent.length, 0); assert(!calls.includes("getFile"));
  });
  await ok("pairing: five wrong codes end the code; an expired code pairs no one (1.13.1)", async () => {
    let cfg = { pairCode: "123456", pairExp: Date.now() + 60000, pairTries: 0 };
    const sent = [];
    const fetch = async (url, init) => { const body = JSON.parse(init.body || "{}"); if (url.endsWith("sendMessage")) sent.push(body.text); return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) }; };
    const b = new TelegramBridge({ fetch, getToken: () => "1:a", cfg: () => cfg, save: p => { cfg = { ...cfg, ...p }; }, ask: async () => "x" });
    for (let i = 0; i < 5; i++) await b.handle({ message: { chat: { id: 9, type: "private" }, text: "/start 00000" + i } });
    await b.handle({ message: { chat: { id: 9, type: "private" }, text: "/start 123456" } });
    assert(!cfg.chatId, "paired after five wrong codes");
    cfg = { pairCode: "654321", pairExp: Date.now() - 1, pairTries: 0 };
    await b.handle({ message: { chat: { id: 9, type: "private" }, text: "654321" } });
    assert(!cfg.chatId, "paired with an expired code");
    cfg = { pairCode: "111111", pairExp: Date.now() + 60000, pairTries: 0 };
    await b.handle({ message: { chat: { id: 9, type: "private" }, text: "111111" } });
    assert.strictEqual(cfg.chatId, 9);
  });
  console.log(fails ? `\n${fails} failed` : "\nall Telegram file checks passed");
  process.exit(fails ? 1 : 0);
})();
