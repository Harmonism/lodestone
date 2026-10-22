"""Lodestone Desktop's first launch and Model page, in launcher.html with a stand-in for
the app's bridge whose status comes from the real models.js and remote.js (launcher-status.cjs):
  first launch leads with DeepSeek V4.1 Flash on the account or one's own OpenRouter key;
  a model on this computer is offered below, Bonsai 2 27B Heretic recommended on 16–45 GB
  (marked not yet tested), the larger class above it, the mainline model where Prism has no build;
  own key: OpenRouter with DeepSeek V4.1 Flash filled in, connected through setRemote;
  account: the sign-in, then DeepSeek V4.1 Flash chosen;
  the Model page puts the account and the own-key boxes before the models on this computer,
  and names a rented model by its name.

Usage: python3 tools/test-launcher.py      (needs node and playwright)"""
import json, os, subprocess
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); SRC = os.path.join(HERE, "..", "desktop", "src")
status = lambda *a: json.loads(subprocess.check_output(["node", os.path.join(HERE, "launcher-status.cjs"), *map(str, a)]))
BRIDGE = """
window.__calls = [];
const S0 = %s;
let S = JSON.parse(JSON.stringify(S0));
const rec = (n, ...a) => { window.__calls.push([n, ...a]); };
window.desktop = {
  status: async () => JSON.parse(JSON.stringify(S)),
  onProgress: () => () => {}, onLog: () => {},
  openApp: async () => rec("openApp"), goBack: async () => rec("goBack"),
  download: async id => { rec("download", id); throw new Error("abort"); }, cancelDownload: async () => {},
  setRemote: async (conf, key) => { rec("setRemote", conf, key); S.remote = { ...conf, host: "openrouter.ai", hasKey: true, label: "OpenRouter" }; return { persisted: true }; },
  remoteModels: async () => [], clearRemote: async () => {},
  hostedSignIn: async (e, p) => { rec("hostedSignIn", e); S.hosted.account = { email: e }; },
  hostedStatus: async () => ({ cap: 10, remaining: 10 }), hostedUse: async m => { rec("hostedUse", m); S.hosted.active = true; S.hosted.model = m; },
  hostedSignOut: async () => {}, setUpstream: async () => {}, revealLog: () => {},
};
"""
def main():
    res = []
    def check(n, ok, d=""): res.append(bool(ok)); print(("PASS " if ok else "FAIL ") + n + (f" — {d}" if d else ""), flush=True)
    url = "file://" + os.path.abspath(os.path.join(SRC, "launcher.html"))
    with sync_playwright() as p:
        b = p.chromium.launch()
        def open_(st, q=""):
            ctx = b.new_context(viewport={"width": 1100, "height": 1000}); pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("dialog", lambda d: d.accept())
            pg.add_init_script(BRIDGE % json.dumps(st)); pg.goto(url + q); pg.wait_for_timeout(500)
            return ctx, pg, errs
        ctx, pg, errs = open_(status(24, "darwin", "arm64"))
        check("first launch shows the welcome", pg.is_visible("#welcome"))
        route = pg.text_content("#routeCard")
        check("it leads with DeepSeek V4.1 Flash, on the account or one's own OpenRouter key", "DeepSeek V4.1 Flash" in route and pg.text_content("#welcomeHosted").startswith("Use my harmonism.io account") and "OpenRouter" in pg.text_content("#welcomeRemote")
              and "primary" in pg.get_attribute("#welcomeHosted", "class") and "primary" not in pg.get_attribute("#begin", "class"))
        check("it no longer promises that nothing leaves the computer", "never leave" not in pg.text_content("#welcome .lede") and "goes to the service you choose" in route)
        pick = pg.text_content("#pick")
        check("on a 24 GB Mac, Bonsai 2 27B Heretic is the model on this computer recommended, marked not yet tested", "Bonsai 2 27B" in pick and "Recommended for this computer · not yet tested against the doctrine" in pick, pick[:120])
        check("the local download is offered, not pressed on", "Download and begin" in pg.text_content("#begin") and pg.is_visible("text=Or think entirely on this computer"))
        pg.screenshot(path="/tmp/launcher-welcome.png", full_page=True)
        pg.click("#welcomeRemote"); pg.wait_for_timeout(500)
        check("own key: the Model page opens on OpenRouter with DeepSeek V4.1 Flash filled in", pg.is_visible("#manage") and pg.input_value("#rPreset") == "openrouter" and pg.input_value("#rModel") == "deepseek/deepseek-v4.1-flash" and pg.evaluate("document.querySelector('#remoteBox').open"))
        order = pg.evaluate("[...document.querySelectorAll('#manage > details, #manage > h2, #manage > .card')].map(n => n.id || n.className || n.tagName)")
        check("the Model page: the account and own-key boxes before the models on this computer", order.index("hostedBox") < order.index("sub-head") and order.index("remoteBox") < order.index("sub-head"), str(order))
        pg.fill("#rKey", "sk-or-v1-test"); pg.click("#rSave"); pg.wait_for_timeout(500)
        calls = pg.evaluate("window.__calls")
        check("connecting sends OpenRouter, DeepSeek V4.1 Flash and the key, then opens Lodestone", ["setRemote", {"preset": "openrouter", "baseUrl": "https://openrouter.ai/api/v1", "model": "deepseek/deepseek-v4.1-flash"}, "sk-or-v1-test"] in calls and ["openApp"] in calls, str(calls)[:300])
        check("no page errors", not errs, "; ".join(errs)[:300]); ctx.close()

        ctx, pg, errs = open_(status(24, "darwin", "arm64"))
        pg.click("#welcomeHosted"); pg.wait_for_timeout(400)
        check("account: the Model page opens on the sign-in", pg.is_visible("#hEmail") and pg.evaluate("document.querySelector('#hostedBox').open"))
        pg.fill("#hEmail", "t@example.org"); pg.fill("#hPassword", "pw"); pg.click("#hSignIn"); pg.wait_for_timeout(400)
        check("signed in, DeepSeek V4.1 Flash is the account's model chosen", pg.input_value("#hModel") == "deepseek/deepseek-v4.1-flash")
        pg.click("#hUse"); pg.wait_for_timeout(300)
        check("and it is used", ["hostedUse", "deepseek/deepseek-v4.1-flash"] in pg.evaluate("window.__calls"))
        check("no page errors", not errs, "; ".join(errs)[:300]); ctx.close()

        st = status(24, "darwin", "arm64"); st["remote"] = {"preset": "openrouter", "baseUrl": "https://openrouter.ai/api/v1", "model": "qwen/qwen3.5-397b-a17b", "host": "openrouter.ai", "hasKey": True, "label": "OpenRouter"}
        ctx, pg, errs = open_(st, "?screen=models")
        check("the Model page names a rented model, not its id", "Lodestone is thinking with Qwen 3.5 397B, rented from openrouter.ai" in pg.text_content("#manageText"), pg.text_content("#manageText"))
        check("on that page Bonsai is tagged recommended and untested", "Recommended for this computer · not yet tested" in pg.text_content("#manageList"))
        pg.screenshot(path="/tmp/launcher-models.png", full_page=True); ctx.close()

        for mem, plat, arch, want in [(64, "darwin", "arm64", "Qwen 3.5 35B"), (16, "darwin", "arm64", "Bonsai 2 27B"), (15.8, "win32", "x64", "Bonsai 2 27B"), (12, "darwin", "arm64", "Bonsai 2 9B"), (8, "win32", "x64", "Bonsai 2 9B"), (24, "linux", "arm64", "Ministral 3 14B")]:
            ctx, pg, errs = open_(status(mem, plat, arch))
            check(f"{mem} GB {plat}-{arch}: {want} recommended", want in pg.text_content("#pick"), pg.text_content("#pick")[:80]); ctx.close()
        # Under 16 GB: the smaller Bonsai, said to be smaller and weaker, with no memory warning
        ctx, pg, errs = open_(status(8, "darwin", "arm64"))
        pick = pg.text_content("#pick")
        check("8 GB Mac: Bonsai 2 9B, tagged smaller and weaker and untested, saying DeepSeek answers far better", "Recommended for this computer · smaller and weaker · not yet tested against the doctrine" in pick and "far better" in pick and "2.0 GB" in pick, pick[:160])
        check("8 GB Mac: no warning that Lodestone needs more memory", "needs 16 GB" not in pg.text_content("#welcomeText"), pg.text_content("#welcomeText"))
        check("16 GB: Bonsai 2 27B still listed as a choice", "Bonsai 2 27B" in pg.text_content("#list"))
        check("no page errors", not errs, "; ".join(errs)[:300]); ctx.close()
    print(f"{sum(res)} of {len(res)} passed")
main()
