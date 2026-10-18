# Lodestone — desktop app

*The code-level reference for Lodestone Desktop.*

Lodestone as an ordinary application on macOS, Windows and Linux, carrying the harmonism.io library with it. The practitioner installs it, double-clicks it, and a Lodestone window opens. Nothing else is installed, no Terminal or browser is involved, and no address is shown.

Everything ships inside the app: the web app from `../app/` (unchanged apart from a desktop mode), the corpus pack, the retrieval model, the model engine, and the English site. The only thing not shipped is the language model, which is several gigabytes. The first launch downloads it once, with a progress bar, and checks every file against the hash Hugging Face publishes.

The app uses a *MunAI Offline* data folder where it finds one (model, conversations, practices, memory), and on macOS offers to move the old `MunAI Offline.app` to the Bin.

## What the practitioner sees

1. **First launch.** A welcome window recommends a model for the computer's memory and offers one button, *Download and begin*. The download shows size, speed and time left; a pause resumes where it stopped, across restarts; busy servers are retried. Below 16 GB of memory the window says Lodestone may be slow or not start.
2. **Every later launch.** "Waking Lodestone" for a few seconds, then the conversation. In a wide window the conversations list stays docked on the left — visible through everything, until it is folded away from the ☰ button or the drawer's × (the choice is remembered).
3. **The library.** The book icon in Lodestone, or *Lodestone → The Library* (⌘2 / Ctrl+2), opens harmonism.io as it is online, served from the app: every English page, the search, the interactive Wheel and the assessment. The companion in the corner of each page is answered by the local model, with the page as context and no seven-message limit. Account and membership pages say they live on harmonism.io and link there; narration audio plays from harmonism.io when online. Links to harmonism.io inside Lodestone's answers open in the library.
4. **Other languages.** A French (or other) page that is not installed offers to download that language (French ≈ 50 MB); *Lodestone → Library Languages and Updates…* lists them all.
5. **Updates.** Same screen: *Check* asks harmonism.io whether a newer corpus and doctrinal backbone, or a newer English library, is published; one button fetches it. Nothing is ever checked by itself. While the site is behind its beta password, the password is asked once and kept encrypted by the operating system's keychain.
6. **Look this up online.** The globe beside the message box, per question, off by default, with a one-time explanation. The question goes to DuckDuckGo (Wikipedia when DuckDuckGo does not answer; Brave Search instead if `"braveKey"` is set in `desktop.json`), the top three pages are read from this computer, and Lodestone answers with them in a `<web_results>` block beneath the corpus, citing each site.
7. **The model menu, under the message box.** Shows the model Lodestone is thinking with; one click lists every model downloaded on this computer and, once an API key is saved, the rented models: the four hosted Lodestone runs on (recommended, tested with Lodestone), the last ones used, and a field for any other model id. The switch happens in place and the conversation continues; a line in the chat marks it (never sent to the model). Switching to a model on this computer keeps the saved key, so switching back asks for nothing.
8. **Lodestone → Model…** Switch, download or remove models; *Advanced* adds any `.gguf` from Hugging Face by pasting its link (split models by their first part; every part hash-checked), or points Lodestone at a model server of the practitioner's own.
9. **Lodestone → Use from Your Phone…** Opens Lodestone to the local Wi-Fi and shows a QR code. Below it, **Telegram**: the practitioner's own bot (from @BotFather), paired by a six-digit code, answered through the same harness.
10. **A model you rent.** *Lodestone → Model… → A model you rent, with your own API key*, also offered on the welcome screen. Anthropic (native Messages API, the system prompt's stable part cached), Venice, OpenRouter, Hugging Face (`router.huggingface.co/v1`, open-weight models, an `hf_` token; no per-request data-retention switch, so its providers' own terms apply) or any OpenAI-compatible provider. The key is tried with one short request, then kept encrypted by the keychain. Retrieval, the crisis gate, witness mode, memory and practices stay local; each turn's assembled context goes to the provider. Lodestone's persona and the settings drawer say so (`whereLine()` in `app/js/prompt.js`).
11. **Attachments.** The paperclip beside the message box, drag and drop, or paste. Read on this computer before any model sees them (`app/js/attach.js`): text files as they are; PDFs by pdf.js 6.3.289 (legacy build, vendored in `app/vendor/pdfjs/`), a scanned PDF's first four pages shown as images to a model that can see; recordings decoded at 16 kHz and transcribed by Whisper small in a worker (`asr-worker.js`), its 250 MB downloaded once on first use from a pinned Hugging Face revision and hash-checked (`src/speech.js`), told the language from the app setting or the system; images scaled to 1,568 px and sent only to a model that can see. Gemma models gain sight with their vision projector (`mmproj` in `models.js`, downloaded on first image, passed to `llama-server --mmproj`); Anthropic always sees; other providers are tried. Document text goes in an `<attached_files>` block and stays available to the next three turns; images are sent once and never stored. A short recording with nothing typed becomes the message, to read over before sending. Pasting a Harmonic Profile code (`HP::…`) fills the Wheel reading and the assessment summary (`app/js/hp.js`, port of the Telegram parser), in the window and in Telegram.
12. **Folders Lodestone may read.** Settings → Advanced lists folders the practitioner adds one by one (never the home folder or a disk root). For each message in Lodestone's own window, `src/folders.js` finds the passages that bear on it in their Markdown, text and Org files; Lodestone cites the file and quotes exactly, and the files used show under the answer. Read-only, no symbolic links followed, never searched for the Telegram bridge; Settings says whether the passages stay on the computer or travel to a rented model's provider.
13. **A harmonism.io account.** *Lodestone → Model…* → *Your harmonism.io account*: email and password of the website's own account (`src/hosted.js`; refresh token in the keychain). Lodestone then thinks with the hosted models, ten messages a day in total across the website, Telegram and the app, counted by the server; the chip shows how many are left. The turn is assembled here as with a rented model and goes to `harmonism.io/lodestone-desktop-api.php`, which puts the server's own doctrinal backbone in place and stores nothing. A closed-weight model chosen under the practitioner's own key is labelled *closed weights · not tested against the doctrine*.

If the model will not load, the window says why in plain words: a damaged file offers *Download it again*, a missing part *Download the missing part*, too little memory a smaller model, an unsupported custom model says so. The engine's log sits behind *Details*.

## How it works

The window's pages come from a private server in the app at `127.0.0.1:47863` (fixed, because browser storage is bound to it):

| Path | Served from |
|---|---|
| `/` | the library (`src/site.js`): `resources/site/en` shipped, `<userData>/site/<lang>` downloaded or updated |
| `/lodestone-app/` | the web app; `corpus/` from `<userData>/updates/corpus` when updated |
| `/v1`, `/lodestone-app/v1` | the engine, OpenAI-compatible |
| `POST /companion-api.php` | `src/companion.js`: the site's companion answered locally, streamed in the Anthropic event shape the site's script reads |
| other `*.php`, `/member/…` | a page linking to harmonism.io; a `.php` holding only HTML (Wheel, assessment) is served from the library |

Every library page gets a small script: the anonymous message counter reads 0, and the account links are hidden.

| File | Role |
|---|---|
| `src/main.js` | Window, menu, config, IPC, links to harmonism.io rewritten to the library. |
| `src/engine.js` | llama.cpp `llama-server` as a hidden child process: 32,768-token window, one slot, thinking off. Stale engines from a crash are stopped at next launch. |
| `src/models.js` | Catalog (repo, every file's size and SHA-256), memory tiers, and `fromHuggingFace()` for pasted links. |
| `src/download.js` | Resumable, hash-verified downloads through Electron's network stack; `downloadModel()` for multi-part models. |
| `src/companion.js` | Crisis gate, keyword retrieval, witness and governor blocks and the full backbone, imported from `../app/js/` so the two companions cannot drift. |
| `src/site.js`, `src/updates.js` | Library packs and the update check. |
| `src/weblookup.js` | Search and page reading for *Look this up online*. |
| `src/remote.js` | A rented model under the practitioner's key: presets, model list, the test request, and the OpenAI → Anthropic Messages translation behind `/v1`. |
| `src/telegram.js` | The practitioner's own Telegram bot: long polling, pairing, HTML formatting, daily practice check-ins. Answers come from a hidden page of the app in bridge mode (`?bridge=telegram`, `app/js/main.js`), so they share the window's memory and harness. |
| `src/launcher.*`, `setup.css`, `src/phone.*` | Setup, model, library and phone screens. |
| `engines/` | llama.cpp **b11243** builds: `darwin-arm64` (Metal), `darwin-x64`, `win32-x64-vulkan`, `linux-x64-vulkan` (Vulkan loaded dynamically, CPU fallback; Windows carries the MSVC runtime app-locally). |
| `site-en/` | The English library, unpacked from `en.tar.gz` (see below). `pack-library.js` packs it into `build-res/site-en.tar.gz`, which ships as `resources/site/` and is unpacked into the data folder on first launch: loose files with accented names (…žižek, …maté) broke the Mac signature, since a Mac stores those names in another Unicode form than the one signed on Linux. |

## Models

One model per family, one per common memory size, chosen on the doctrinal-fidelity suite; `BUNDLED_DEFAULTS` in `src/models.js`, replaceable by the published model list:

| Memory | Default | Download |
|---|---|---|
| 240 GB + | DeepSeek V4 Flash, unmodified, UD-Q4_K_XL (unsloth, 5 parts) | 155.1 GB |
| 46 GB + | Qwen 3.5 35B-A3B, unmodified, Q4_K_M | 22.0 GB |
| 30 GB + | Gemma 4 26B-A4B uncensored Heretic, Q4_K_M | 16.8 GB |
| below | Ministral 3 14B, unmodified, Q4_K_M (the minimum; 16 GB) | 8.2 GB |

Retired models stay usable for anyone who has one downloaded or chosen, never a default (`retired: true`): Gemma 3 12B, Gemma 4 26B Q8_0, Gemma 4 26B SOMPOA-heresy, GLM-4.5-Air Derestricted, Qwen 3.5 27B. *Any other model, from Hugging Face* stays. `MUNAI_TEST_MODEL=tiny` adds a test entry.

Verified for the large tiers: every part's size and SHA-256 from the Hugging Face API; the architectures (`deepseek4`, `glm4moe`) are present in all four engine builds; the first part of DeepSeek V4 Flash was downloaded and its header read (5 parts, 1,048,576-token native context). Neither large model has been loaded end to end: no machine with the memory was available.

## Tested (15–16 Oct 2026, 1.4–1.5, Node only)

1.4 model menu: `node --check` on `main.js`, `preload.js` and the page module. Model list as data, against a stubbed server: the exported hash equals the bundled one; a published list with a model added, one removed and new defaults applies, the removed one kept while downloaded; a tampered hash and a `../` path refused. Defaults: 16 and 24 GB → Ministral, 31.5 and 36 → Gemma 4 26B, 48 to 128 → Qwen 3.5 35B-A3B, 255 → DeepSeek V4 Flash. Folders: `folders.js` on `Harmonia/World`, 126 files and 5,213 passages built in 0.3 s, a search in 2–4 ms. Hosted mode: `hosted.js` and the hosted path of `remote.js` against a mock Supabase and a mock provider, 11 checks; the server's quota functions 11 of 11. **Not yet run in Electron:** the menu, the folders section, hosted sign-in against the live project and endpoint.

## Tested (8 Oct 2026, 1.3, Node only)

`remote.js` against a mock provider: Anthropic translation (system split at `<temporal>` with the first block cached, leading assistant turn dropped, consecutive user turns merged, `top_p` not sent, temperature clamped), the event stream re-emitted as OpenAI chunks through `server.js`, `/v1/models` answered as `lodestone`, an OpenAI-compatible provider with the bearer key and `chat_template_kwargs` stripped, a refused key reported in plain words. `telegram.js` against a mock Bot API: unpaired chat asked for the code, pairing by `/start <code>`, another chat ignored, markdown to Telegram HTML, a check-in button recorded, the daily check-in sent with buttons, long replies split under 4,096 characters. Attachments in headless Chromium (Playwright): a text PDF read to text; a scanned PDF rendered to one image; a 3,000-pixel PNG scaled to 1,568; an English and a French recording transcribed by Whisper small with the language given (Whisper base, tried first, misheard the French badly, and without a language transformers.js assumes English); the pdf.js modern build failed on that Chromium (`Map.getOrInsertComputed`), hence the legacy build. `hp.js` parsed a v2 code. **Not yet run in Electron**: attachments end to end, the vision projector, the Model screen's rented-model section, the phone window's Telegram section, the hidden bridge page, and a real key or bot.

## Tested (29 Sep 2026, Linux, dev run)

From a 1.1-style profile (single-file model in `models/`): the old data folder was used in place, the model moved into its own folder, the setup re-ran by itself under `/lodestone-app/`, and Lodestone answered from the corpus. Library: home page, interactive Wheel, article pages, Pagefind search (299 results for "dharma"), PHP and member notices, missing-language page. Companion endpoint: streamed answer with page context, crisis template without the model. Updates against a password-protected mock origin: password refused then accepted, newer corpus detected, downloaded, hash-checked, picked up by Lodestone on next open; French pack downloaded, unpacked and served, *Back* returned to the French page. Custom Hugging Face model: link parsed, entry added, download started and paused; a bad link refused. *Look this up online*: consent, arming, and the offline error (this sandbox has no direct internet, so live search was not exercised).

Windows and macOS builds carry the same code and the matching engines.

## Build

```bash
npm install
# the English library: the latest pack, unpacked
rm -rf site-en && mkdir site-en && tar xzf ../.site-packs/en.tar.gz -C site-en
python3 -c "import json;p=json.load(open('../.site-packs/index.json'))['packs']['en'];json.dump({'lang':'en','sha256':p['sha256'],'built_at':p['built_at'],'files':p['files'],'size':p['size']},open('site-en/.pack.json','w'))"
npm start                                   # dev run
npm run dist:linux && npm run dist:win      # on Linux (Windows needs 32- and 64-bit Wine)
./build-mac.sh                              # on a Mac (or ./build-dmg-linux.sh on Linux)
npm run release                             # copies installers into release/
```

The installers carry what is in `../app/corpus/` and `site-en/` at build time; the app updates both later on request. Run `node pack-library.js` after changing `site-en/` (the `dist:*` scripts and `build-mac.sh` do it).

## Publishing on harmonism.io

`harmonia-astro/deploy-companion.sh` builds the site packs after Pagefind (`tools/build-site-packs.py` into `../.site-packs/`, kept between deploys so unchanged languages are not re-sent) and copies them to `/lodestone-app/site/`. `post-build.sh` copies the installers from `desktop/release/` to `/lodestone-app/download/`:

```
Lodestone-mac-apple-silicon.dmg   Lodestone-mac-intel.dmg   Lodestone-windows-setup.exe
Lodestone-linux.AppImage          Lodestone-linux.deb       SHA256SUMS.txt   latest.json
```

The 1.1 names (`MunAI-Offline-…`), the earlier Mac zips and the 1.2.1 Mac installers (`.pkg`) redirect to these. On the site the app is **Lodestone Desktop**: the download page is `harmonia-astro/src/pages/lodestone-desktop.astro`, and the Lodestone menu carries a Mac / Windows / Linux row linking straight to the installers. The Mac download is a disk image: drag Lodestone into Applications. Opened from anywhere else, the app offers to move itself there, and offers to put the 1.1 *MunAI Offline* in the Bin. Build it on a Mac (`build-mac.sh`) or on Linux (`build-dmg-linux.sh`, after `electron-builder --mac dir` and `rcodesign sign`).

`latest.json` names the newest installer for each computer, with its version, size and SHA-256; `post-build.sh` writes it from the files in `desktop/release/`. *Lodestone → Check for Updates…* reads it only when asked, downloads the installer into Downloads, checks it, and hands it to the system: a Mac opens the disk image (drag onto Applications, *Replace*), Windows runs the setup, an AppImage replaces itself. The app writes the download itself and does not mark it as quarantined, so a Mac update should not ask for *Open Anyway* again.

## Signing

Without paid certificates each system asks once: macOS → System Settings → Privacy & Security → *Open Anyway*; Windows → SmartScreen → *More info* → *Run anyway*. `build-mac.sh` signs ad hoc without the hardened runtime (required: ad-hoc signatures have no Team ID); with a Developer ID in the keychain it signs with the hardened runtime and notarizes when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set.
