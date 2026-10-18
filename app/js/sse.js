// sse.js — reading an OpenAI-shaped stream, and a provider's refusal in plain words.
// Apart from engine.js, which loads WebLLM, so phone.js and held.js stay light.

const THINK_RE = /<think>[\s\S]*?(<\/think>|$)/g;
export const stripThink = s => s.replace(THINK_RE, "").replace(/^\s+/, "");

export async function* readSSE(res) {
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = "", raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { reader.cancel().catch(() => {}); return; }
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.error) throw new Error(j.error.message || "The provider stopped.");
      const d = j.choices?.[0]?.delta?.content;
      if (d) { raw += d; yield stripThink(raw); }
    }
  }
}

/** A provider's refusal, in plain words (the same wording as the desktop's remote.js). */
export async function providerError(res, who = "The provider") {
  let msg = "";
  try { const j = await res.json(); msg = j.error?.message || j.error || j.message || ""; } catch {}
  if (res.status === 401 || res.status === 403) return new Error(`${who} refused the key. Check that it is complete and still active.`);
  if (res.status === 402) return new Error(`${who} says the account has no credit left.`);
  if (res.status === 404) return new Error(`${who} does not know this model${msg ? `: ${msg}` : "."}`);
  if (res.status === 429) return new Error(`${who} is limiting requests. Wait a moment and try again.`);
  return new Error(`${who} answered ${res.status}${msg ? `: ${String(msg).slice(0, 200)}` : "."}`);
}

