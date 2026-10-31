// readings.js — the Readings page (2.1): every page Lodestone was asked about.
// Signed in, the memory's page conversations (synced); anonymous, the turns
// kept on this browser alone. All data comes from the background worker.

const $ = (s) => document.querySelector(s);
const KINDS = { harmonist: "Harmonist reading", passage: "Passage", absorb: "Absorbed", summary: "Summary", question: "Question" };
let data = { signedIn: false, items: [], anonymous: [], keepAnonymous: true };
const open = new Set();

const ask = (msg) => new Promise((res) => {
  try { chrome.runtime.sendMessage({ type: "lodestone-readings", ...msg }, (r) => { void chrome.runtime.lastError; res(r || { ok: false }); }); }
  catch (e) { res({ ok: false, error: String(e) }); }
});

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Markdown-lite: escaped first, then links (http/https only), bold, italic, paragraphs. */
function md(text) {
  let s = esc(text);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = url.charAt(0) === "/" ? "https://harmonism.io" + url : url;
    return /^https?:\/\//i.test(href) ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return s.split(/\n{2,}/).map((p) => "<p>" + p.replace(/\n/g, "<br>") + "</p>").join("");
}
// AMO forbids assigning built strings to innerHTML (October 26, 2026): every
// string here is already escaped, and goes in through DOMParser instead.
function setHtml(el, html) {
  const doc = new DOMParser().parseFromString("<!doctype html><body>" + html, "text/html");
  el.replaceChildren(...doc.body.childNodes);
}
const domain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };
const safeUrl = (u) => /^https?:\/\//i.test(u || "") ? u : "";
const when = (ts) => ts ? new Date(ts).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

/** Both stores as one shape: { id, title, url, ts, kinds, turns, where }. */
function rows() {
  const mem = data.items.map((r) => ({ id: r.id, title: r.title, url: r.url, ts: r.updated || r.created, kinds: r.kinds && r.kinds.length ? r.kinds : [r.kind], turns: r.turns, where: "memory" }));
  const anon = (data.anonymous || []).map((r) => ({ id: r.id, title: r.title, url: r.url, ts: r.ts, kinds: [r.kind], turns: [{ role: "user", content: r.q, ts: r.ts }, { role: "assistant", content: r.a, ts: r.ts }], where: "browser" })).sort((a, b) => b.ts - a.ts);
  return { mem, anon };
}

function matches(r) {
  const q = $("#q").value.trim().toLowerCase(), k = $("#kind").value;
  if (k && !r.kinds.includes(k)) return false;
  if (!q) return true;
  return (r.title + " " + r.url).toLowerCase().includes(q) || r.turns.some((t) => t.content.toLowerCase().includes(q));
}

function item(r) {
  const li = document.createElement("li");
  li.className = "reading";
  const exchanges = r.turns.filter((t) => t.role === "user").length;
  const url = safeUrl(r.url);
  setHtml(li,
    `<div class="head"><button class="title">${esc(r.title || domain(r.url) || "A page")}</button><span class="meta">${esc(when(r.ts))}</span></div>` +
    (url ? `<div class="url"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a></div>` : "") +
    `<div class="meta">${r.kinds.map((k) => `<span class="kind ${esc(k)}">${esc(KINDS[k] || k)}</span>`).join("")} ${exchanges} exchange${exchanges === 1 ? "" : "s"}</div>`);
  if (open.has(r.id)) {
    const box = document.createElement("div");
    box.className = "turns";
    setHtml(box, r.turns.map((t) => `<div class="turn ${t.role === "user" ? "user" : "lode"}"><div class="who">${t.role === "user" ? "You" : "Lodestone"}</div><div class="body">${md(t.content)}</div></div>`).join(""));
    const act = document.createElement("div");
    act.className = "actions";
    const mk = (a, label) => { const b = document.createElement("button"); b.className = "ghost"; b.dataset.a = a; b.textContent = label; return b; };
    act.append(mk("copy", "Copy as Markdown"), mk("forget", "Forget"));
    box.appendChild(act);
    li.appendChild(box);
    act.addEventListener("click", async (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (a === "copy") { await navigator.clipboard.writeText(toMd([r])).catch(() => {}); e.target.textContent = "Copied"; }
      if (a === "forget") {
        const where = r.where === "memory" ? "from your memory, on every synced device" : "from this browser";
        if (!confirm(`Forget this reading ${where}?`)) return;
        const res = await ask({ op: "forget", id: r.id });
        if (!res.ok) return alert(res.error || "It could not be forgotten.");
        load();
      }
    });
  }
  li.querySelector(".title").addEventListener("click", () => { open.has(r.id) ? open.delete(r.id) : open.add(r.id); render(); });
  return li;
}

function render() {
  const { mem, anon } = rows();
  const m = mem.filter(matches), a = anon.filter(matches);
  $("#mem").replaceChildren(...(m.length ? m.map(item) : [Object.assign(document.createElement("li"), { className: "empty", textContent: data.signedIn ? (mem.length ? "No reading matches." : "No page has been read in your memory yet.") : "Sign in to your harmonism.io account (Settings) to keep readings in your memory, on all your devices." })]));
  $("#anon").replaceChildren(...(a.length ? a.map(item) : [Object.assign(document.createElement("li"), { className: "empty", textContent: anon.length ? "No reading matches." : "None kept." })]));
  $("#forget-anon").hidden = !anon.length;
  $("#mem-hint").textContent = data.signedIn ? "Kept in your Lodestone memory and carried to your other devices by sync. Each page is one conversation." : "";
  const total = mem.length + anon.length, shown = m.length + a.length;
  $("#count").textContent = total ? (shown === total ? `${total} page${total === 1 ? "" : "s"}` : `${shown} of ${total} pages`) : "";
}

function toMd(list) {
  const out = ["# Lodestone readings", "", `Exported ${new Date().toLocaleString()}.`, ""];
  for (const r of list) {
    out.push(`## ${r.title || domain(r.url) || "A page"}`, "");
    if (r.url) out.push(`<${r.url}>`, "");
    out.push(`*${when(r.ts)} · ${r.kinds.map((k) => KINDS[k] || k).join(", ")} · ${r.where === "memory" ? "in your memory" : "this browser only"}*`, "");
    for (const t of r.turns) out.push(`**${t.role === "user" ? "You" : "Lodestone"}:** ${t.content}`, "");
  }
  return out.join("\n");
}

async function load() {
  const r = await ask({ op: "list" });
  if (r && Array.isArray(r.items)) data = r;
  $("#keep").checked = data.keepAnonymous !== false;
  render();
}

let qt;
$("#q").addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(render, 120); });
$("#kind").addEventListener("change", render);
$("#keep").addEventListener("change", (e) => ask({ op: "keep-anonymous", on: e.target.checked }));
$("#forget-anon").addEventListener("click", async () => { if (confirm("Forget every anonymous reading kept on this browser?")) { await ask({ op: "forget-anonymous" }); load(); } });
$("#export").addEventListener("click", () => {
  const { mem, anon } = rows();
  const list = [...mem, ...anon].filter(matches);
  const blob = new Blob([toMd(list)], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lodestone-readings-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
load();
