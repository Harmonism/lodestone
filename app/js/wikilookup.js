// wikilookup.js — "Look this up online" in the web app and on the phone.
//
// Lodestone Desktop searches the web and opens the pages it finds from the
// computer (desktop/src/weblookup.js). A browser cannot: other sites refuse
// to be read by a page that is not theirs. Wikipedia is the exception, since it
// answers any page, so the web app looks a question up there: the question goes
// to Wikipedia's search in the conversation's language (and in English when
// that finds nothing), and the introductions of the best three articles come
// back as text. Nothing else leaves: no conversation, no notes, no memory.

export async function wikiLookup(question, lang = "en", { fetchImpl = fetch, max = 3 } = {}) {
  const q = String(question || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!q) return [];
  const get = url => fetchImpl(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
  for (const l of [...new Set([String(lang || "en").slice(0, 2).toLowerCase(), "en"])]) {
    if (!/^[a-z]{2}$/.test(l)) continue;
    const base = `https://${l}.wikipedia.org/w/api.php`;
    const s = await get(`${base}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=${max}&format=json&origin=*`);
    const titles = (s?.query?.search || []).map(x => x.title);
    if (!titles.length) continue;
    const e = await get(`${base}?action=query&prop=extracts|info&inprop=url&exintro=1&explaintext=1&exlimit=${max}&titles=${encodeURIComponent(titles.join("|"))}&format=json&origin=*`);
    const pages = Object.values(e?.query?.pages || {}).filter(p => p.extract && p.extract.trim());
    pages.sort((a, b) => titles.indexOf(a.title) - titles.indexOf(b.title));
    if (pages.length) return pages.map(p => ({
      title: `${p.title} (Wikipedia)`,
      url: p.fullurl || `https://${l}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
      text: p.extract.trim().slice(0, 3000),
    }));
  }
  return [];
}
