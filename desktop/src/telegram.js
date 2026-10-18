// telegram.js — Lodestone in the practitioner's own Telegram bot.
//
// The practitioner creates a bot with Telegram's @BotFather and gives its token
// to Lodestone. This module asks Telegram for new messages (long polling: nothing
// listens on the internet, no address is opened), answers only the one chat
// that paired with the code Lodestone showed, and sends each message through the
// same harness as the window: the crisis gate, retrieval, witness mode, the
// memory and the practices, in a hidden page of the app (bridge mode of
// ../app/js/main.js). The conversation appears in Lodestone's own thread list.
//
// Accompaniment: once a day, within waking hours, practices that are due for a
// check-in are offered in the chat with three buttons, as the window offers
// them. Only while this computer is awake and Lodestone is open.
//
// What Telegram sees: bot chats are not end-to-end encrypted, so Telegram's
// servers carry these messages. The window says so before the token is saved.

const API = "https://api.telegram.org";
const POLL_SECONDS = 50;
const OUTREACH_EVERY_MS = 30 * 60 * 1000;
const OUTREACH_GAP_MS = 20 * 3600 * 1000;
const WAKING = [9, 21];   // local hours between which a check-in may be sent

/** Lodestone's markdown, reduced to the HTML Telegram accepts. */
function toTelegramHTML(md) {
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc(md)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (m, t, u) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
}

/** Split at paragraph or sentence boundaries under Telegram's 4,096-character limit. */
function chunks(text, max = 3800) {
  const out = []; let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(". ", max) + 1;
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

class TelegramBridge {
  /**
   * @param {{ fetch: Function, getToken: () => string|null, cfg: () => object, save: (patch: object) => void,
   *           ask: (req: object) => Promise<any>, log?: (s: string) => void }} o
   *   ask: hands a request to the hidden Lodestone page and resolves with its answer.
   */
  constructor(o) { Object.assign(this, o); this.running = false; this.offset = 0; this.ctrl = null; this.timer = null; this.status = "off"; this.lastError = null; this.me = null; }

  async call(method, body, signal) {
    const token = this.getToken();
    if (!token) throw new Error("No bot token.");
    const res = await this.fetch(`${API}/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) {
      const e = new Error(j.description || `Telegram answered ${res.status}`);
      e.code = j.error_code || res.status; throw e;
    }
    return j.result;
  }

  /** Proves a token and returns the bot's username. */
  async check() { this.me = await this.call("getMe"); return this.me.username; }

  start() {
    if (this.running || !this.getToken()) return;
    this.running = true; this.status = "starting"; this.lastError = null;
    this.loop();
    this.timer = setInterval(() => this.outreach().catch(e => this.log?.(`[telegram] outreach: ${e.message}`)), OUTREACH_EVERY_MS);
    setTimeout(() => this.outreach().catch(() => {}), 60 * 1000);
  }

  stop() {
    this.running = false; this.status = "off";
    clearInterval(this.timer); this.timer = null;
    try { this.ctrl?.abort(); } catch {}
  }

  async loop() {
    let backoff = 2000;
    try { await this.check(); } catch (e) { this.lastError = e.message; }
    while (this.running) {
      this.ctrl = new AbortController();
      try {
        const updates = await this.call("getUpdates", { offset: this.offset, timeout: POLL_SECONDS, allowed_updates: ["message", "callback_query"] }, this.ctrl.signal);
        this.status = "listening"; this.lastError = null; backoff = 2000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          this.handle(u).catch(e => this.log?.(`[telegram] ${e.message}`));
        }
      } catch (e) {
        if (!this.running) break;
        this.status = "waiting"; this.lastError = e.message;
        if (e.code === 401 || e.code === 404) { this.lastError = "Telegram refused the token. Paste it again from @BotFather."; this.stop(); break; }
        if (e.code === 409) this.lastError = "Another program is reading this bot's messages. Stop it, or create a separate bot for Lodestone.";
        await new Promise(r => setTimeout(r, backoff)); backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  async send(chatId, text, extra = {}) {
    const parts = chunks(text || "…");
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      try { await this.call("sendMessage", { chat_id: chatId, text: toTelegramHTML(parts[i]), parse_mode: "HTML", disable_web_page_preview: true, ...(last ? extra : {}) }); }
      catch { await this.call("sendMessage", { chat_id: chatId, text: parts[i], disable_web_page_preview: true, ...(last ? extra : {}) }); }
    }
  }

  async handle(u) {
    const c = this.cfg();
    if (u.callback_query) {
      const q = u.callback_query;
      if (String(q.message?.chat?.id) !== String(c.chatId)) return this.call("answerCallbackQuery", { callback_query_id: q.id });
      const [, practiceId, status] = String(q.data || "").split(":");
      let text = "Noted.";
      try { text = (await this.ask({ kind: "checkin", practiceId, status })) || text; } catch (e) { text = "Lodestone could not record that just now."; }
      await this.call("answerCallbackQuery", { callback_query_id: q.id, text: status === "talk" ? "Let us look at it." : text.slice(0, 190) });
      try { await this.call("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch {}
      if (status === "talk") await this.converse(q.message.chat.id, `I want to look at my practice "${text}" with you.`);
      return;
    }
    const m = u.message;
    if (!m || !m.chat || m.chat.type !== "private" || typeof m.text !== "string") return;
    const chatId = m.chat.id, text = m.text.trim();

    // Pairing: the first chat to send /start with the code shown on the computer.
    if (!c.chatId) {
      const code = (text.match(/^\/start\s+(\d{6})$/) || text.match(/^(\d{6})$/) || [])[1];
      if (code && c.pairCode && code === c.pairCode) {
        this.save({ chatId, pairCode: null });
        return this.send(chatId, "Paired. This chat now reaches Lodestone on your computer, with your memory, your practices and the whole corpus. It answers while the computer is awake and Lodestone is open.\n\n/new starts a fresh conversation.");
      }
      return this.send(chatId, "Send the six-digit code Lodestone shows on your computer (Lodestone → Use from Your Phone… → Telegram).");
    }
    if (String(chatId) !== String(c.chatId)) return;   // someone else's chat: no answer at all

    if (/^\/start\b/.test(text)) return this.send(chatId, "Lodestone is here. Write as you would in the app.");
    if (/^\/new\b/.test(text)) { await this.ask({ kind: "new" }); return this.send(chatId, "A new conversation. The earlier one stays in Lodestone on your computer."); }
    if (/^\/stop\b/.test(text)) { this.save({ outreach: false }); return this.send(chatId, "No more check-ins from me. /checkins turns them back on."); }
    if (/^\/checkins\b/.test(text)) { this.save({ outreach: true }); return this.send(chatId, "Check-ins on: once a day at most, when a practice is due."); }
    return this.converse(chatId, text);
  }

  async converse(chatId, text) {
    const typing = () => this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    typing(); const t = setInterval(typing, 4500);
    let reply;
    try { reply = await this.ask({ kind: "message", text }); }
    catch (e) { reply = `Lodestone could not answer: ${e.message}`; }
    finally { clearInterval(t); }
    await this.send(chatId, reply);
  }

  /** Once a day, in waking hours: the practices due for a check-in. */
  async outreach() {
    const c = this.cfg();
    if (!this.running || !c.chatId || c.outreach === false) return;
    const h = new Date().getHours();
    if (h < WAKING[0] || h >= WAKING[1]) return;
    if (Date.now() - (c.lastOutreach || 0) < OUTREACH_GAP_MS) return;
    const due = await this.ask({ kind: "due" });
    if (!Array.isArray(due) || !due.length) return;
    this.save({ lastOutreach: Date.now() });
    for (const p of due.slice(0, 2)) {
      await this.send(c.chatId, `${p.pillar}: “${p.text}”. How has it gone since you last looked?`, {
        reply_markup: { inline_keyboard: [[
          { text: "It held", callback_data: `ci:${p.id}:held` },
          { text: "Partly", callback_data: `ci:${p.id}:partly` },
          { text: "It did not", callback_data: `ci:${p.id}:not` },
        ], [{ text: "Talk it through", callback_data: `ci:${p.id}:talk` }]] },
      });
    }
  }
}

module.exports = { TelegramBridge, toTelegramHTML, chunks };
