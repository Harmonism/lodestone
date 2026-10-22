// Prints what Lodestone Desktop's "status" handler would return on a fresh computer
// of the given memory and platform, from the real models.js and remote.js
// (tools/test-launcher.py serves it to launcher.html in place of the app).
//   node tools/launcher-status.cjs 24 darwin arm64
const path = require("path");
const [mem = "24", platform = "darwin", arch = "arm64"] = process.argv.slice(2);
Object.defineProperty(process, "platform", { value: platform }); Object.defineProperty(process, "arch", { value: arch });
const models = require(path.join(__dirname, "..", "desktop", "src", "models.js"));
const remote = require(path.join(__dirname, "..", "desktop", "src", "remote.js"));
const memGB = Number(mem);
const describe = m => ({ id: m.id, label: m.label, why: m.why, ugi: m.ugi || null, hand: m.hand, minMem: m.minMem, custom: false, repo: m.repo, page: models.page(m),
  untested: !!m.untested, weaker: !!m.weaker, size: models.size(m), parts: m.files.length, downloaded: false, partial: 0 });
process.stdout.write(JSON.stringify({
  platform, memGB, minMem: models.minMemHere(),
  catalog: models.CATALOG.filter(x => !x.retired).map(describe).sort((a, b) => a.size - b.size),
  defaultId: models.defaultFor(memGB), chosen: models.defaultFor(memGB), freeBytes: 200e9, running: false, upstream: null, engineError: null, remote: null,
  presets: Object.fromEntries(Object.entries(remote.PRESETS).filter(([, p]) => !p.hidden)),
  hosted: { account: null, active: false, model: null, recommended: remote.RECOMMENDED }, leftovers: [], returnTo: null,
}));
