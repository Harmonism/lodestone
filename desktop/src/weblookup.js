// weblookup.js — "Look this up online", for one question at a time.
//
// Off unless the practitioner presses the button for a particular question. The
// question goes to a search engine (DuckDuckGo, no account and no key; Brave
// Search instead when a key is set in desktop.json as "braveKey"; Wikipedia
// when neither answers), and the top pages are opened from this computer and
// reduced to their text. Nothing else leaves: no conversation, no notes, no memory.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Lodestone";
const MAX_PAGES = 3, PER_PAGE = 3000, MAX_BYTES = 2_000_000, TIMEOUT = 9000;

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };
const decode = s => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const strip = html => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

async function withTimeout(fetch, url, init = {}, ms = TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal, headers: { "User-Agent": UA, "Accept-Language": "en;q=0.9, *;q=0.5", ...(init.headers || {}) } }); }
  finally { clearTimeout(t); }
}

// DuckDuckGo sometimes answers a program with a "are you a person?" page
// instead of results (status 202, an "anomaly" form). The lite page is tried
// next; failing both, Wikipedia, which always answers and is often enough.
const challenged = (res, html) => res.status === 202 || /anomaly|challenge-form/.test(html);

function ddgTarget(href) {
  href = decode(href);
  if (href.startsWith("//")) href = "https:" + href;
  try {
    const u = new URL(href, "https://duckduckgo.com/");
    if (u.hostname.endsWith("duckduckgo.com")) return u.searchParams.get("uddg") || null; // ads carry none
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}

async function searchDuckDuckGo(fetch, query) {
  const res = await withTimeout(fetch, "https://html.duckduckgo.com/html/", {
    method: "POST", body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const html = await res.text();
  if (!res.ok || challenged(res, html)) return null;
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    const url = ddgTarget(m[1]);
    if (url) out.push({ url, title: strip(m[2]), snippet: strip(m[3] || "") });
  }
  return out;
}

async function searchDuckDuckGoLite(fetch, query) {
  const res = await withTimeout(fetch, "https://lite.duckduckgo.com/lite/?kl=wt-wt&q=" + encodeURIComponent(query));
  const html = await res.text();
  if (!res.ok || challenged(res, html)) return null;
  const out = [];
  const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)].map(m => strip(m[1]));
  links.forEach((m, i) => { const url = ddgTarget(m[1]); if (url && out.length < 8) out.push({ url, title: strip(m[2]), snippet: snippets[i] || "" }); });
  return out;
}

/** Wikipedia's own search, with the articles' opening text. */
async function searchWikipedia(fetch, query) {
  const api = "https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=3&prop=extracts|info&inprop=url&explaintext=1&exchars=" + PER_PAGE + "&gsrsearch=" + encodeURIComponent(query);
  const res = await withTimeout(fetch, api, { headers: { Accept: "application/json" } });
  if (!res.ok) return [];
  const pages = Object.values((await res.json()).query?.pages || {}).sort((a, b) => a.index - b.index);
  return pages.filter(p => p.extract).map(p => ({ title: p.title + " — Wikipedia", url: p.fullurl, text: p.extract.slice(0, PER_PAGE) }));
}

async function searchBrave(fetch, query, key) {
  const res = await withTimeout(fetch, "https://api.search.brave.com/res/v1/web/search?count=8&q=" + encodeURIComponent(query), {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  if (!res.ok) throw new Error(`Brave Search answered ${res.status}`);
  const j = await res.json();
  return (j.web?.results || []).map(r => ({ url: r.url, title: strip(r.title || ""), snippet: strip(r.description || "") }));
}

/** The readable text of a page, without navigation, scripts or boilerplate. */
function pageText(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|button|select)\b[\s\S]*?<\/\1>/gi, " ");
  const main = html.match(/<(article|main)\b[\s\S]*?<\/\1>/i);
  const body = main ? main[0] : (html.match(/<body\b[\s\S]*<\/body>/i)?.[0] || html);
  const paras = [...body.matchAll(/<(p|h[1-4]|li|td|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map(m => strip(m[2])).filter(t => t.length > 40);
  const text = (paras.length >= 3 ? paras.join("\n") : strip(body));
  return text.slice(0, PER_PAGE);
}

async function readPage(fetch, r) {
  try {
    const res = await withTimeout(fetch, r.url, { headers: { Accept: "text/html,application/xhtml+xml" } });
    if (!res.ok || !/html|text\/plain/i.test(res.headers.get("content-type") || "")) return null;
    const reader = res.body.getReader(); const chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); n += value.length;
      if (n > MAX_BYTES) { try { reader.cancel(); } catch {} break; }
    }
    const html = Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8");
    const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "") || r.title;
    const text = pageText(html);
    if (text.length < 300) return null;
    return { title: title.slice(0, 160), url: res.url || r.url, text };
  } catch { return null; }
}

/**
 * Search, open the best pages, and return up to three as { title, url, text }.
 * Falls back to the search engine's own snippets when no page could be read.
 */
async function lookUp(fetch, question, { braveKey } = {}) {
  const query = question.replace(/\s+/g, " ").trim().slice(0, 300);
  let results = null;
  if (braveKey) { try { results = await searchBrave(fetch, query, braveKey); } catch {} }
  if (!results?.length) { try { results = await searchDuckDuckGo(fetch, query); } catch {} }
  if (!results?.length) { try { results = await searchDuckDuckGoLite(fetch, query); } catch {} }
  if (!results?.length) {
    // No search engine answered; Wikipedia's articles are the last resort.
    let wiki = [];
    try { wiki = await searchWikipedia(fetch, query); } catch {}
    if (wiki.length) return wiki;
    if (results === null) throw new Error("the search engine did not answer; this computer may be offline");
    return [];
  }
  const seen = new Set(); const candidates = [];
  for (const r of results) {
    let host = ""; try { host = new URL(r.url).hostname; } catch {}
    if (seen.has(host)) continue;             // one page per site, for breadth
    seen.add(host); candidates.push(r);
  }
  const pages = (await Promise.all(candidates.slice(0, 5).map(r => readPage(fetch, r)))).filter(Boolean).slice(0, MAX_PAGES);
  if (pages.length) return pages;
  return candidates.slice(0, MAX_PAGES).filter(r => r.snippet).map(r => ({ title: r.title, url: r.url, text: r.snippet }));
}

module.exports = { lookUp, pageText };
