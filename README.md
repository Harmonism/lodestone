# Lodestone — the web app, Lodestone Desktop and the computer folder

*The web app is **Lodestone** at harmonism.io/lodestone-app/; the installable app is **Lodestone Desktop**. The browser database is named `munai-offline`.*

Lodestone runs on hardware the practitioner owns: a laptop, a desktop, or a model server on their own computer, reached from a phone over their own network. The published corpus is downloaded once and retrieved from locally. Conversations, practices and notes stay in the browser's storage on that device. After the one-time download it makes no network calls and sends no telemetry. On owned hardware, practitioner inference never reaches a third party, which meets the owned-hardware condition of SDIP, the Sovereign Doctrinal Inference Protocol. A phone with no computer behind it may also think on harmonism.io's hosted models under the practitioner's account, or on OpenRouter under their own key (§ Phone mode below); the corpus, retrieval, the safeguards and memory stay on the phone, and only the assembled turn leaves, to the service named. SDIP's seven invariants (`components/sdip/` in the Integral Knowledge Architecture repository) are addressed in § SDIP conformance below.

Why a practitioner would run Lodestone on their own computer is set out in *Lodestone* § Where Lodestone Runs. This folder is that path at practitioner scale: inference on the practitioner's own laptop with no server administration.

It reaches practitioners three ways: the web app at harmonism.io/lodestone-app/; **the installable desktop app** for macOS, Windows and Linux (`desktop/`, see its README), the recommended path on a computer; and the double-click folder (`lodestone-computer.zip`, the `.command` / `.bat` launchers), kept for anyone who would rather not install anything.

**Only the 7–8B class and above is offered anywhere.** The constraint is not memory — Llama-3.2-1B fits inside iOS Safari's ceiling and Qwen3-1.7B runs on any laptop — it is that a model that small, speaking in Lodestone's register, produces confident answers that misrepresent the system it speaks for. A wrong answer in that voice is a worse outcome than no answer; it is the one failure mode the whole architecture exists to prevent. There is deliberately no smaller fallback: a machine that cannot hold these is told to run the model outside the browser, where it can hold far more.

**On-device inference is not offered on phones or tablets at all** (`localInferenceAvailable()` in `app/js/engine.js`, false for any handheld). A handheld reaches a model on a computer the practitioner owns, which also carries the full backbone rather than the compressed one, or one of the phone routes of § Phone mode. An install carrying a tier this build no longer has — the withdrawn `light` tier, or a device tier on a phone — is sent back to the setup screen on next open with nothing pre-selected, keeping its corpus, memory and server address.

## This repository

Lodestone is the Harmonist companion of [harmonism.io](https://harmonism.io): the web app, Lodestone Desktop (macOS, Windows, Linux) and the Android shell, from one source. Dedicated to the public domain under CC0 1.0 (`LICENSE`), like the framework it serves, the [Integral Knowledge Architecture](https://github.com/Harmonism/integral-knowledge-architecture). This tree is published from Harmonia's working folder by `tools/publish-public.sh`.

Large files are not carried; `tools/fetch-assets.sh` fetches and checks them: the retrieval model's weights (Hugging Face), the current corpus pack and the English library (harmonism.io), and llama.cpp's `llama-server` for each desktop platform (release b11243, checked against `desktop/engines/*.sha256`). Then the web app runs with `python3 tools/serve.py`, and Lodestone Desktop with `cd desktop && npm install && npm start`.

The corpus pack is built from the Harmonism vault and the site's own pipeline (`tools/build-corpus.py`, `--vault` and `--astro`), which are not part of this tree; the pack the fetch script downloads is the one harmonism.io serves.

## Layout

```
lodestone/
├── app/                      the installable web app (PWA): static files, no build step
│   ├── index.html · styles.css · manifest.webmanifest · sw.js
│   ├── js/                   controller, retrieval, safety gates, prompt assembly, engines
│   ├── vendor/               web-llm 0.2.85, transformers.js 4.3.0, onnxruntime-web wasm
│   ├── icons/                the Obsidian Sprite, extracted from ObsidianSprite.astro
│   └── corpus/               BUILD OUTPUT: corpus.json, runtime.json, embeddings.*, exclusions.txt
├── doctrine/
│   └── backbone-light.md     compressed Tier-1 backbone for 4–8k-context models (see Doctrine)
├── tools/
│   ├── build-corpus.py       vault → corpus pack
│   ├── embed-corpus.mjs      optional multilingual vectors for hybrid retrieval
│   └── serve.py              run from your own computer; lends its model server to your phone
├── desktop/                  the installable app (Electron): app/ + llama.cpp engine, corpus, library, the same proxy
│   └── release/              built installers, published by post-build.sh to /lodestone-app/download/
├── Lodestone.command     double-click launcher, Mac (the zip folder)
└── Lodestone.bat         double-click launcher, Windows (the zip folder)
```

## Build the corpus pack

```bash
cd lodestone                               # beside the vault and harmonia-astro
python3 tools/build-corpus.py          # ~10 s, needs PyYAML
npm install                            # once, for the embedding step
node tools/embed-corpus.mjs            # a few minutes on Apple Silicon; optional
```

`embed-corpus.mjs` reuses the previous pack's vectors for unchanged passages (`build-corpus.py` keeps `corpus.prev.json` for it), so a routine re-embed after an article edit takes seconds rather than the full run.

`build-corpus.py` reuses the live pipeline instead of copying it. The audience filter is imported from `harmonia-astro/scripts/build-sovereignty-bundle.py`, which mirrors `sync-content.sh`, so the pack never carries anything the public site does not serve. Cleaning and priority weights come from `telegram-companion/index-vault.py`. Synonyms and stop words are parsed out of `companion-rag.php`. Crisis patterns, templates and regional lines come from `crisis-patterns.json` and `companion-crisis-detector.php`, and witness-mode markers from `companion-classifier.php`. The full backbone is `telegram-companion/doctrinal-backbone.md`. Changing any of those files changes the next pack; nothing is re-typed.

Any file with `publication_hold: true` in its frontmatter is excluded wherever it sits. The build lists every exclusion and its reason in `app/corpus/exclusions.txt`. It also flags, without excluding, any included title that touches a held subject (`tools/hold-subject.local`, a local list never published). The first build (23 Sep 2026) included 408 articles and 11,374 passages (11.8 MB) and flagged none.

Rebuild after any deploy that changes articles. Practitioners are not pushed updates. Their app shows a newer pack only when they ask, and downloads it only when they confirm (SDIP invariant: practitioner-initiated update).

## Ways to run it

| Mode | Where inference happens | Model (default · alternative) | Context | Backbone | Download |
|---|---|---|---|---|---|
| This device | the computer's GPU via WebGPU | Qwen3-8B (5.7 GB VRAM) · OLMo-2-7B (fully open, 6.5 GB) | 8k | light | ~6 GB |
| Model server | Ollama / LM Studio / llama.cpp on a computer you own | chosen by installed memory (below); `model.txt` or the desktop app's model list for anything else | 32k (set by serve.py / the app for Ollama) | **full** | 6–27 GB, once |
| harmonism.io account | harmonism.io's hosted models (`lodestone-desktop-api.php`, same origin) | the hosted list (`llm-models.php`) | 32k | the server's own, in place of a placeholder | none |
| OpenRouter | OpenRouter, under the practitioner's own key | the hosted list as recommendations, or any OpenRouter id | 32k | **full** | none |
| No model | none: a question returns the passages that bear on it | — | — | — | none |

**Server-tier defaults of the double-click folder.** Drawn from the open-weight ranking (*Open-Weight AI Models Ranked — Censorship, Capability and Bias*) and the UGI leaderboard, read in Lodestone's own mode, thinking off and a 32k window. Figures are willingness /10 · NatInt · political lean, thinking off. The two launchers use this table. The desktop app does not: it offers one model per family per memory size, chosen on the doctrinal-fidelity suite (`desktop/README.md` § Models).

| Memory | Model (all `hf.co/mradermacher/…` GGUFs) | Download | UGI |
|---|---|---|---|
| 64 GB + | Gemma 4 26B-A4B uncensored Heretic, Q8_0 | 26.9 GB | 9.2 · 34.1 · −22.2 |
| 32 GB + | Gemma 4 26B-A4B uncensored Heretic, Q4_K_M | 16.8 GB | 9.2 · 34.1 · −22.2 |
| 16 GB + | Gemma 3 12B norm-preserved biprojected abliterated, Q4_K_M | 7.3 GB | 9.2 · 21.3 · −6.4 |
| under 16 GB | Qwen3.5 9B Heretic v2, Q4_K_M | 5.6 GB | 9.2 · 16.1 · −7.3 |

A `model.txt` naming `qwen3:32b`, `14b` or `8b` (vendor weights, refusals intact) is treated as an automatic pick and replaced. Mistral Small 3.2 24B, the article's laptop pick, needs ~14 GB of weights plus ~5 GB of cache at 32k, so it fits nothing below 32 GB, where Gemma 4 26B leads on every column. The doctrinal-fidelity suite has been run on the desktop app's models, not on these.

**The retrieval model runs from local files only.** `app/vendor/models/Xenova/multilingual-e5-small/` holds the tokenizer and the ONNX weights (113 MB, fetched by `tools/fetch-assets.sh`), and `embed-worker.js` sets `allowLocalModels = true` with `allowRemoteModels = false`. `allowRemoteModels = false` makes the dependency impossible rather than unlikely: missing local files fail loudly instead of reaching out. Verified with every route to huggingface.co and hf.co aborted at the network layer — setup reports deep retrieval *done*, the badge and Settings both report hybrid retrieval, zero requests are attempted, and hybrid retrieval survives a reload with the network fully offline.

GLM is not an option on the device tier: MLC publishes no GLM build, so WebLLM cannot run one. DeepSeek exists there only as R1 distills, which are reasoning models whose chain-of-thought is stripped before display — wasted compute for a companion register. Both are available on the server tier, where `model.txt` selects them.

WebGPU is available in Chrome and Edge on desktop and Android, and in Safari on iOS/macOS 26 and later. When a browser lacks it, the setup screen offers only Server mode.

The default is chosen on the openness gradient: open-weight Qwen3 for multilingual strength on small hardware, with OLMo-2 (weights, data and code all open) one tap away in every device tier. Browser mode cannot yet meet SDIP's refusal-direction-stripped invariant, because WebLLM ships only the vendors' own weights. Server mode can meet it with any abliterated GGUF.

### Phone mode

On a phone or tablet the setup screen offers four routes: the practitioner's own computer (below), their harmonism.io account, OpenRouter under their own key, and no model. Both internet routes live in `app/js/phone.js`, ported from the desktop's `hosted.js` and `remote.js`, and are offered only on a secure page (https, or localhost), because they need WebCrypto.

- **harmonism.io account.** Supabase sign-in (email and password, the website's own project); the refresh token is stored encrypted, the access token held in memory. Each turn goes to `lodestone-desktop-api.php` on the same origin, so no CORS is involved, with a placeholder between the `<doctrinal_backbone>` tags that the server replaces with its own backbone (80 KB not sent per message). Ten messages a day in total across every surface; Settings shows the count and the server's model list.
- **OpenRouter.** The key is tested with one short request before Begin is allowed, then stored encrypted. Recommended models (the hosted list, read from `/lodestone-app/models/catalog.json` when the setup opens, bundled otherwise) run as hosted Lodestone runs them: reasoning off or a token floor, `provider.data_collection: deny`. Any other id is allowed and labelled by `assess()` (closed weights marked). OpenRouter's CORS answers `*` for every header this sends (checked October 16, 2026). Venice and Anthropic are not offered on the phone.
- **No model.** The crisis gate and retrieval run as always; the reply is the retrieved passages under their titles, with the articles listed to open offline.

**Secrets.** A browser has no keychain: the key and the refresh token sit in IndexedDB (`kv` keys `secret:openrouter`, `secret:hosted`), AES-GCM-encrypted under a non-extractable WebCrypto key held in the same store. That keeps them out of an exported memory file and out of plain sight; it does not protect them from someone holding the unlocked phone. The native shell (Phase 2) moves them to the system keychain.

**iOS storage.** Safari deletes what a website stores after seven days of Safari use without a visit to it; a web app opened from the Home Screen is exempt. The app says so once on an iPhone or iPad opened in Safari (`showHomeNote()`).

**Where a turn goes is said** (`whereLine()` in `prompt.js`): `harmonism.io` reads as hosted, any other host as rented under the practitioner's key, and on a handheld *their device* replaces *their computer*.

**Tested** (October 16, 2026, `python3 tools/test-phone.py` (Playwright): headless Chromium as an iPhone 13 against mock endpoints, Supabase and OpenRouter intercepted in the browser): 33 of 33 checks — the four routes offered and on-device withheld, sign-in with a wrong and a right password, the bearer token and the backbone placeholder on a hosted turn, the server's model list and switching in place, the crisis gate answering without any call on the hosted and the no-model routes, the key refused then accepted, an OpenRouter turn carrying the full backbone with reasoning off and `data_collection: deny`, both secrets stored as ciphertext and absent from the export, conversations kept across route changes, and a computer-width browser still offering *This device* first. **Not yet run:** a real iPhone and a real Android phone against the live site, a live harmonism.io sign-in and hosted turn, a real OpenRouter key.

**A phone needs no computer.** Setup offers its routes in the order OpenRouter (preselected; a pasted `sk-or-…` key is tested at once, and a good one enables *Begin*), the harmonism.io account, the computer, no model. The account is a step of its own above them, and it is the website's own sign-in: `phone.js` reads the supabase-js session the site keeps in this origin's `localStorage` (`sb-<project>-auth-token`), renews an expired access token against Supabase itself and writes the renewed session back for the site. *Sign in* and *Create an account* go to `/member/login.php?return=lodestone` and `register.php?return=lodestone`, which return to `/lodestone-app/`. The manifest's `scope` is `/` so that on an iPhone those pages, and the assessment, stay inside the Home Screen app's own storage (to verify on a real iPhone). The computer route on a phone is a short pointer to Lodestone Desktop's *Use from Your Phone*, because an https page may not fetch a plain-http server on the home network; when the page is itself served by the computer, the route works directly. A model menu under the message box lists the OpenRouter models, the account's models with the day's count, the computer when it served the page, and no model, and switches in place.

**The Harmonic Profile.** *Your path* opens with it: *Take the assessment* (`/assessment.php?return=lodestone`), or, signed out on a phone, *Sign in* and *Create an account* first, so the twenty minutes of answers are never lost to a sign-in page. Opened from Lodestone, the assessment remembers it (`sessionStorage munai-return`) and adds *Bring it to Lodestone on this device* to its results, behind the same consent box; the button leaves the HP:: code in `localStorage munai-hp-pending` and opens `/lodestone-app/`, where `takeAssessment()` takes it in once (on load and whenever the page is shown again), asks before replacing an earlier profile, and records it in the conversation. In Lodestone Desktop's own copy of the site (127.0.0.1:47863, the same origin as the app) the button shows without a website sign-in and the server *Share* is hidden, so it works offline. The desktop's library pack must carry the new `assessment.php` for that: a deploy, then *Check* under *Library Languages and Updates…*, or `site-en/` refreshed before the next build.

### Sync

On by itself once the practitioner is signed in to harmonism.io: the first device starts the synced copy with nothing to press, a later device offers above the conversation to be let in, and a synced device shows a waiting request there. Turned off in Settings → *Sync*, it stays off on that device. While on, the conversations, the notes (`profile`), the Wheel, the practices and the Harmonic Profile (`assessment`) are kept on harmonism.io under their account, so every device let into it shares one memory. There is no passphrase (since October 19, 2026): turning sync on is one step. Since October 20 a device signed in with the account password opens the copy by itself; one that cannot is let in by a tap on a device already synced. Settings, the corpus and models stay on each device; the OpenRouter key travels only when ticked.

**Encrypted on the device** (`app/js/sync.js`). The first device makes a random 256-bit key; HKDF-SHA-256 splits it into an AES-256-GCM key and an HMAC key, both held as non-extractable WebCrypto keys in IndexedDB (`kv` `sync:keys`). The key itself is kept in each memory wrapped under a non-extractable key (`sync:root`, `sync:wrap`, never synced), so the device can hand it on; it is never sent in the clear. Until October 20 it was kept under `secret:` names, which `store.js` keeps once per browser, so another memory in the same browser could overwrite or erase it; a key stored that way is taken over only where it opens the account's copy (`Sync#root`), and a synced device without the key offers to take it over (`takeOver`: sync first, start the copy again, let the waiting device in). A copy made before October 19 with a passphrase (meta `v` 1: PBKDF2-SHA-256, 600,000 iterations) still opens with it, and *Switch to linked devices* starts it again without one. Each record (one conversation, or one `kv` value) is gzipped, encrypted with a fresh IV and bound to its name as additional data; its name is an HMAC of the local id. A check value encrypted under the key lets a device know the key it received is the right one. The server sees the account id, the number and size of records, and when they change.

**The endpoint** (`harmonia-astro/lodestone-sync-api.php`, copied to the site root by `post-build.sh`). Supabase sign-in token as for `lodestone-desktop-api.php`; records in SQLite beside the companion config, outside the web root, keyed by the token's `sub`. `GET ?meta=1`, `PUT` (create, or with `replace` start again: a new *epoch*), `GET ?since=N`, `POST {epoch, put, del}`, `DELETE` (erase). The server numbers every write; a write is accepted only when its `base` is the number the server holds, else the current record comes back as a conflict. Limits: 3 MB a record, 64 MB and 20,000 records an account, 8 MB a request.

**Merging.** Each device keeps, per record, the number and a hash of what it last saw (`kv` `sync:state`); a record whose local hash differs has changed here. Pulled first, then pushed; a conflict is merged and sent again. A conversation merges message by message (a message is known by `uid`, else by its time and role; the same message changed on both keeps the longer text); the practices merge by id; the notes, the Wheel and the profile keep this device's version when both changed. Deleting a conversation deletes it everywhere; nothing else is deleted by sync. Unticking the key takes it off the server and stops it travelling from the other devices too, each keeping its own copy. Starting the copy again on one device (*Start the synced copy here*) makes the others stop and say so, until they are let in again; *Delete the synced copy* erases it from the server and the others stop, memory kept.

**The password** (`app/js/unlock.js`). At a sign-in with the password the device stretches it into a key (PBKDF2-SHA-256, 600,000 rounds, salt `lodestone-unlock-v1:` + the account email) and keeps it as a non-extractable WebCrypto key in its own small database (`lodestone-unlock`); the password itself is not kept. Where: harmonism.io's `member/login.php` and `member/update-password.php` import `unlock.js` from `/lodestone-app/js/` (same origin as the app), the app's own password field (Settings → *Sync*, *Use my password*; on a waiting device, *Open my memory*) checks the password with the sign-in service first, the extension's options page stashes it at sign-in, and Lodestone Desktop stretches it in the main process (`stretchForUnlock` on `sync-sign-in` and `hosted-sign-in`) and hands the 32 bytes to the window once (`sync-unlock-take`). A synced device holding the key leaves it with the copy, AES-GCM under the password's key and bound to the epoch (`PUT ?unlock=1 {epoch, box}`), and locks again whenever the password's key here is newer than the one it last used or the copy was started again (`keepLock`, run by `ensure()`). A new device signed in with the password opens it (`unlockWithPassword`), checks it against the check value and is in. Starting the copy again or erasing it removes the lock. The password goes only to the sign-in service (Supabase); the lock is useless without it.

**Letting a device in by a tap** (`requestLink`, `answerLink`; October 20, 2026). For a device the password cannot open (it changed since, or the device signed in without typing it). The new device makes an ECDH P-256 key pair and a 16-byte nonce and leaves its public key and a commitment to the nonce (`POST ?link=1 {pub, commit}`). A synced device lists the request (`GET ?link=1`); *Let it in* sends its own public key and nonce (`POST ?link=1&id= {apub, anonce}`, one device only); the new device then reveals its nonce (`{nonce}`), which the synced device checks against the commitment. Both show a six-digit number drawn from the two keys and the two nonces; when the person sees they match and taps *Yes, let it in*, the synced device seals the key with AES-256-GCM under HKDF(ECDH secret, salt the request id, info bound to the number's transcript) and leaves the box (`{apub, box}`). A server that put its own keys between them could make the numbers agree once in a million tries, since each side's nonce was fixed before it saw the other's. *No* deletes the request and the new device is told. Older clients keep the typed ten-character code (`approveLink`; HKDF(ECDH ‖ PBKDF2(code))): a new device still shows a code for them, and a synced device answers a request without a commitment with the code field. Requests expire after ten minutes, five at most per account. The same mailbox, with the same steps, runs in Lodestone Desktop's own store for phones that sync through the computer (`desktop/src/syncstore.js`, in memory; no password there).

**First sync and starting again.** On a device's first sync after joining, the synced notes (`profile`), `assessment` and `hp_code` are taken over its own (`fresh` in `sync:state`), so a thinner copy on a new device never replaces what was built elsewhere; afterwards the latest edit wins. *Start the synced copy here* compares the device's count of records with the copy's (`localCount` against `?meta`) and, when it holds less, warns before replacing anything.

**The recovery code.** Settings → *Recovery code* shows the key itself in Crockford base 32 (52 characters), only when asked, for the day no synced device is left; *No device already synced?* on a new device takes it. Without it, losing every synced device loses the synced copy (each device keeps its own memory while it lasts).

**When it syncs.** On opening, when the page is hidden or shown again, five seconds after each answer, every five minutes while visible, and on *Sync now*; never while an answer is being written. On the website and in the extension, after each answer, and before each turn when the last sync is more than half a minute old (waiting five seconds at most), so a conversation just had on another device is part of the next answer here. In Lodestone Desktop the window does the encryption and the merging, and the main process carries the ciphertext to harmonism.io under its own sign-in (`sync-call`, `sync-account`, `sync-sign-in`), so the window never holds the account's token; `sync-key-get`/`sync-key-set` give and take the OpenRouter key, which is taken in only where no other provider's key is saved. The copy Lodestone Desktop serves to a phone over Wi-Fi is plain http, has no WebCrypto, and does not offer sync.

**What may be said**. Not "Harmonia cannot read it": with the key left locked under the password, what can be said of synced memory is that what harmonism.io keeps it cannot read, and that the password goes only to the sign-in service. On the website this rests on the served code being as published, and the notice there says so; Lodestone Desktop carries its own copy of the code. Never said of the website's turns, which the server reads during each request.

**Tested, the password and the tap** (October 20, 2026, `python3 tools/test-sync.py app ../harmonia-astro/lodestone-sync-api.php`; the sign-in service stood in for by `page.route`): 41 of 41, three runs, four devices — sync on by itself; the second device joined by a tap, both showing the same number and nothing sent before *Yes*; the password typed once on a synced device locks the key (nothing readable on the server); a laptop signed in with the password is in by itself; a tablet refused with a wrong password and let in with the right one; merging, deletion, the key withdrawn, a sync on opening; the copy started again and the phone let back in by a tap, relocking under its password; the recovery code; erasing. Also, in Node against the real endpoint: the desktop's stretch equals the browser's; a password change moves the lock; *No* refuses; a reveal that breaks its commitment is refused; older clients both ways; a device that lost its key takes it over; the computer's store.

**Tested, linked devices** (October 19, 2026, the same script): 29 of 29 — sync on in one step with no passphrase; a v2 copy on the server and nothing readable there; the second device shows a code; the phone sees it waiting; a code typed wrong does not let it in, the right one does (typed in lower case) and leaves no handover row; conversations, the OpenRouter key ticked while waiting, practices, a merged conversation, a deletion, the key withdrawn, a sync on opening; starting the copy again on one device stops the other, which the first lets back in; the recovery code shown on asking (52 characters); erasing. Also in a page of its own against the endpoint: a third device joined with the recovery code, a wrong recovery code refused, a change on it reached the first.

**Tested, passphrase** (October 17, 2026, `python3 tools/test-sync.py app ../harmonia-astro/lodestone-sync-api.php`: two headless Chromium devices, a phone and a computer, against the real endpoint under `php -S` with the sign-in stubbed): 27 of 27 checks — off by default and the notice; a short passphrase refused; nothing readable on the server (text, key, record names); a second device finds the copy, a wrong passphrase refused; both conversations, the key and the practices on both; one conversation changed on both devices merged message by message and shown; a deletion carried; the key withdrawn from both; a sync on opening; turning off keeps the copy; a new passphrase stops the other device, which rejoins; erasing clears the server and the other device stops with its memory kept. **Not yet run:** the live endpoint after deploy, Lodestone Desktop 1.8.0's main-process path, a real phone.

### The Android app and pairing

`mobile/` is a Capacitor shell that opens `https://harmonism.io/lodestone-app/`; its design, build and tests are in `mobile/README.md`. In this folder it touches four things. `app/js/native.js` is active only inside the app (`window.Capacitor`): the home-network fetch with a native-HTTP fallback, pairing, `lodestone://pair` links. In `app/js/main.js`, the setup's *My computer* becomes a pairing form in the app (address and code, or the QR link), the model menu lists the paired computer, and Settings → *Sync* offers *Through your harmonism.io account* or *Through <computer> only* wherever a computer is at hand (Lodestone Desktop's own window, or the app paired). In Lodestone Desktop, *Use from Your Phone…* shows the pairing code and its QR (`desktop/src/phone.html`), `desktop/src/pairing.js` trades the code for a token (ten minutes, five tries, only the window makes a new code; only the token's hash is kept), and the phone server answers `/munai-pair` and `/munai-sync` (token required) with CORS for `https://harmonism.io` on those routes and the model only (`desktop/src/server.js`). `desktop/src/syncstore.js` is the JavaScript twin of `lodestone-sync-api.php`, keeping the synced copy in `<userData>/sync/records.json`; the window reaches it through `sync-local`. Tested with `python3 tools/test-android.py app desktop/src` (26 of 26; the desktop server runs under node via `tools/desktop-phone-server.cjs`).

### One memory per person on a device

Several people can use Lodestone on one browser, phone or computer, each signed in to their own harmonism.io account. `app/js/store.js` keeps a database per account and one for the device; `app/js/held.js` `bind()` opens the signed-in account's (or the device's, signed out) before anything is read, and the app reloads when the account changes. Settings, the downloaded library and the saved OpenRouter key are the device's. Sign-out asks whether to keep the memory on the device (the default) or remove it; a device marked as shared defaults to removal. Memory the device held before an account signed in is offered to that account once. Tested in `../harmonia-astro/tools/test-held.py`.

### Website Lodestone and the extension on this memory

**Page readings** (October 19, 2026). The extension keeps each page it reads as a conversation of its own (`ext-…`, `source: "extension"`, each message carrying the page's title and address), and sync brings them to the app and Lodestone Desktop. *⧉ Page readings*, under the conversation search, opens a panel listing them with the page's address (opening in the browser), date, number of exchanges and kind (*Harmonist reading*, passage, absorbed, summary, question, from the extension's own prompts), searchable over titles, addresses and text, filtered by kind, exported as one Markdown file; a click opens the conversation, which then shows the page and its address above the first message. In the conversation list such rows carry *⧉* and the page's domain. Tested in Chromium October 19 with two seeded page readings and an ordinary conversation: both listed with their addresses, search and kind filter, export carrying both addresses, opening with the strip, the sidebar marks; no error.

The chat on harmonism.io's pages (the Sprite, `LodestoneChat`, the member dashboard) and the browser extension use this memory instead of the server's. `app/js/held.js` is the one module for it: `heldFetch(url, init, ctx)` sends a turn with the memory (`held: { state, recent, hp_code }`) and keeps both the turn (in the conversation `web-harmonism`, or the extension's `ext-<hash>` per page) and the state the server hands back at the end of the stream (`munai_state`); `heldCall(path, body)` does the same for `lodestone-learn.php` and `member/reading-api.php` (in Lodestone Desktop through the main process, `held-call`); `migrate()` takes a member's old server memory once and confirms its deletion only after it has synced. The memory is `kv` `companion` = `{ state, blocks, at }`, synced like the rest: `state` is the server's own rows for this practitioner, which the server opens in memory for one request and returns; `blocks` are the profile and reading blocks the app adds to its own prompt (`prompt.js` `heldBlock`). After its own turns the app asks `lodestone-learn.php` to update the understanding (`main.js` `maybeLearn`), and *Your path* shows the reading begun on the website (`#readingBox`). The pages load `held.js` from `/lodestone-app/js/` without the model library (`sse.js` carries the stream reader). Tested with `python3 ../harmonia-astro/tools/test-held.py ../harmonia-astro app ../lodestone-extension` (65 checks).

### Phone using the computer's model

In the desktop app: Lodestone menu → *Use from your phone…*, which opens the server to the network and shows a QR code. From the folder:

```bash
ollama serve                                   # or LM Studio's server
python3 tools/serve.py --lan --model <name> --check   # prints http://<your-computer>.local:8765/
```

Open the printed address on the phone (same Wi-Fi). The setup screen detects the computer's model server by itself. `serve.py` serves the app and forwards `/v1/*` to the model server on one origin, so there is no CORS setup and no mixed-content block. It uses only the Python standard library and logs nothing. `--model` points an Ollama model named `lodestone` at the one given, with the 32k window baked in, and `--check` asks it one question before serving (exit status 3 if it cannot answer, which the launchers turn into "update Ollama").

**Ollama.** Its OpenAI-compatible `/v1` endpoint ignores `num_ctx` and runs at its default window (4,096 tokens on any machine with under 24 GB of VRAM), which would cut the full backbone (~17,500 tokens); the Ollama desktop app does not read `OLLAMA_CONTEXT_LENGTH` from a Terminal's environment. Reasoning models think by default on `/v1`, which with the app's `max_tokens` can return an empty reply. `serve.py` and the desktop app therefore send chat to Ollama's native `/api/chat` with `num_ctx: 32768` and `think: false` where the model thinks. Measured through `serve.py`: 17,497 prompt tokens reached the model, none truncated. A non-Ollama upstream is passed through untouched, and needs its own window set to 24k or more.

### Hosting on harmonism.io

Wired into `harmonia-astro/post-build.sh` (block *Lodestone web app*). Every full deploy copies `app/` to `dist/lodestone-app/`, rebuilds the corpus pack from the vault being deployed, and includes the semantic vectors only when their hash matches that pack (otherwise the app uses keyword retrieval and the build prints a warning to rerun `node tools/embed-corpus.mjs`). The site links it from the *Lodestone Mobile* row of the Lodestone dropdown (Android, iPhone and Web tiles, `src/layouts/BaseLayout.astro`) and from `/lodestone-mobile` (`src/pages/lodestone-mobile.astro`), which The Living System → Downloads lists (`src/lib/mega-menu.ts`). The folder's own `.htaccess` serves `.wasm` and the manifest with the right types and makes the app files revalidate, so updates reach installed copies; the vendored runtimes cache for a year.

**Two host constraints the app is built around, both found by deploying into them:**

1. **No `.svg` is served.** The root `.htaccess` carries `RewriteRule ^(.*)\.svg$ $1.png [L]` — "Hostinger blocks SVG via ModSecurity" — so every `.svg` request is rewritten to `.png`. The Obsidian Sprite is therefore **inlined into `index.html`** as a `<symbol>` rather than fetched, and the app ships no `.svg` at all. Do not add one; it will 404 in production while working perfectly in local testing. (The same rewrite is why `/favicon.svg` 404s site-wide — unrelated to this app, but worth fixing separately.)
2. **`.mjs` must be typed as JavaScript.** LiteSpeed serves `.mjs` as `text/plain`, and a browser refuses to execute a module with that type. onnxruntime's loader is an `.mjs`, so the entire semantic-retrieval layer fails on that alone — the app falls back to keyword retrieval and reports it. The folder's `.htaccess` sets `AddType text/javascript .mjs`.

**The service worker caches each file independently.** `cache.addAll()` is atomic, so one missing file would reject the whole install and leave the app without offline support while it looks healthy online. Files are cached one at a time, failures are logged and skipped, and only `index.html` failing aborts the install. Settings shows whether the app is actually offline-ready rather than leaving it to be discovered in airplane mode.

The live site's beta Basic Auth covers `/lodestone-app/` like every other path. The browser attaches the credentials to the app's own fetches and to the service worker, so the app works behind the gate; a practitioner without the credentials cannot reach it until the gate opens.

Deploy is the ordinary full chain, since `mega-menu.ts` is rebuild-gated:

```bash
cd ../harmonia-astro && ./deploy-companion.sh
```

Then check that the pack landed: `https://harmonism.io/lodestone-app/corpus/runtime.json` should show today's `built_at`.

## Doctrine

- **Full backbone** (server mode): `doctrinal-backbone.md`, verbatim, the same Tier-1 text production runs.
- **Light backbone** (device modes): `doctrine/backbone-light.md`, about 1,300 words. It is compressed by extraction: sentences carried from the full backbone and shortened by omission, with no new claim. It carries `derived_from_version`, and the build warns when the live backbone moves past that version; re-validate whenever the build warns that the live backbone has moved past `derived_from_version`. The app's Help drawer (Settings → Using Lodestone offline) carries the plain-language instructions for installing it on a phone; the technical paths live in this file.
- **Persona** (`app/js/prompt.js`) is condensed from `companion-api.php`.

## Safety

The crisis gate is the production library, run in the browser before any model sees the message. A matched pattern gets the deterministic template with the regional line, and the model is never called. Offline language detection is heuristic, so every language's patterns are checked, not only the detected language plus English. The template follows the language of the pattern that matched.

Witness mode and the soft governor are ported. Tiers do not exist offline, so there are no caps.

Small models invent specifics. The persona forbids doses, schedules and protocols not written in the retrieved excerpts, and points to the article instead.

## Accompaniment, not retention

Practices the practitioner commits to get a check-in when due (daily, every 3 days, or weekly), and the recent record goes into `<person_context>`. The Wheel reading is self-assessed on the Wheel's seven-level scale; Lodestone reads it and never rewrites it. "What Lodestone knows about you" holds only what the practitioner writes or explicitly asks it to remember. There are no streaks, no notifications and no inferred profile. Memory export and import move it all between phone and computer as one JSON file.

## SDIP conformance

| Invariant | Status |
|---|---|
| Sovereign substrate | ✔ device GPU or owned server · ✘ by the practitioner's choice on a phone's harmonism.io and OpenRouter routes, said in every turn's persona |
| Always-in-context backbone | ✔ light on device, full on server |
| Corpus-grounded retrieval | ✔ hybrid, on device |
| Refusal-direction stripped | ✔ server mode: every default is abliterated · ✘ browser mode (vendor weights only) |
| No telemetry | ✔ |
| Practitioner-initiated update | ✔ |
| Open-source harness | ✔ plain files, CC0 like the framework repository |
