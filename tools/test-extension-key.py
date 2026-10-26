"""The extension and the practitioner's own OpenRouter key (October 24, 2026).

Usage: python3 tools/test-extension-key.py [path/to/lodestone-extension] [path/to/lodestone/app/js]
(needs playwright with Chromium.) Two copies of the extension, with the app's
modules copied into lib/ as build.sh does: the manifest as shipped (OpenRouter
an optional permission, not granted), and a test-only copy where the permission
is held, as if the practitioner had granted it in the options page.
"""
import os, json, tempfile, sys, shutil
HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "lodestone-extension"))
APPJS = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "app", "js"))
ROOT = tempfile.mkdtemp(prefix="lodestone-extkey-")
def copy(name, grant):
    d = os.path.join(ROOT, name)
    shutil.copytree(EXT, d, ignore=shutil.ignore_patterns("dist", ".build", "*.bak*"))
    for m in ["store.js", "sync.js", "unlock.js", "syncwire.js", "phone.js", "sse.js", "native.js", "hp.js", "held.js"]: shutil.copy(os.path.join(APPJS, m), os.path.join(d, "lib", m))
    if grant:
        p = os.path.join(d, "manifest.json"); m = json.load(open(p)); m["host_permissions"] += ["https://openrouter.ai/*"]; json.dump(m, open(p, "w"))
    return d
from playwright.sync_api import sync_playwright
res=[]
def check(n, ok, d=""): res.append(ok); print(("PASS " if ok else "FAIL ")+n+(f" — {d}" if d else ""))
def run(ext, granted):
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), headless=True, channel="chromium",
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"])
        for _ in range(50):
            if ctx.service_workers: break
            ctx.wait_for_event("serviceworker", timeout=10000)
        sw = ctx.service_workers[0]; ext_id = sw.url.split("/")[2]
        errs=[]; pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"chrome-extension://{ext_id}/options.html"); pg.wait_for_timeout(1200)
        label = "granted" if granted else "optional, not granted"
        st0 = pg.text_content("#byok-status")
        check(f"[{label}] the options page shows the key section", pg.is_visible("#byok-key") and len(st0) > 5, st0)
        pg.fill("#byok-key", "nonsense"); pg.click("#byok-save"); pg.wait_for_timeout(300)
        check(f"[{label}] a string that is not a key is refused", "does not look like" in pg.text_content("#byok-msg"))
        pg.fill("#byok-key", "sk-or-v1-EXTKEY-TEST-12345"); pg.click("#byok-save"); pg.wait_for_timeout(600)
        st = pg.evaluate("new Promise(r => chrome.runtime.sendMessage({ type: 'lodestone-status' }, r))")
        txt = pg.text_content("#byok-status")
        if granted:
            check("[granted] with the permission and a key, the worker answers under it", st.get("byok") is True and "answers here under your OpenRouter key" in txt and pg.is_visible("#byok-stop"), str(st)+" "+txt)
        else:
            check("[optional] without the permission, the key is kept and unused", st.get("byok") is False and "Let Lodestone reach OpenRouter" in txt and pg.is_visible("#byok-allow"), str(st)+" "+txt)
        kept = pg.evaluate("(async () => { const P = await import('./lib/phone.js'); return await P.secrets.get('openrouter'); })()")
        check(f"[{label}] the key is kept encrypted in the extension's storage", kept == "sk-or-v1-EXTKEY-TEST-12345" and "EXTKEY" not in json.dumps(pg.evaluate("chrome.storage.local.get(null)")))
        check(f"[{label}] no page errors", not errs, "; ".join(errs[:3]))
        ctx.close()
run(copy("shipped", False), False)
run(copy("granted", True), True)
m=json.load(open(os.path.join(EXT, "manifest.json")))
check("the shipped manifest asks for OpenRouter only as optional", m.get("optional_host_permissions")==["https://openrouter.ai/*"] and "openrouter" not in json.dumps(m["host_permissions"]) and m["version"]=="2.2.6")
mf=json.load(open(os.path.join(EXT, "manifest.firefox.json")))
check("the Firefox manifest too", mf.get("optional_host_permissions")==["https://openrouter.ai/*"] and mf["version"]=="2.2.6")
print(f"{sum(res)}/{len(res)} passed"); sys.exit(0 if all(res) else 1)
