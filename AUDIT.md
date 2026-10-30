# Auditing Lodestone

Lodestone says it keeps a person's conversations and memory on their own device,
sends them only where they choose (a model they pick, an encrypted sync they turn
on, a guide they share with), and reads their folders without changing them. This
page is for anyone who wants to check that rather than take it on trust: with
their own eyes, with their own AI model, or with tools that watch what the app
does.

There are three checks, each answering a different question. Do them in order.

| Check | Question it answers | What it cannot tell you |
|---|---|---|
| 1. Verify your copy | Is the Lodestone I run exactly the published release? | Whether the release itself is honest |
| 2. Read the release | Does the published code do anything it does not say? | That the code you read is what runs (check 1 does) |
| 3. Watch it run | Where does it actually connect, and when? | What is inside an encrypted request |

## 1. Verify your copy

Every release is tagged in the public repository, on Codeberg
(codeberg.org/harmonism/lodestone) and GitHub (github.com/Harmonism/lodestone):
`web-vN` for the web app (N is the version in its `sw.js`), `desktop-vX.Y.Z` for
Lodestone Desktop. Each tag holds `SHA256SUMS`, the SHA-256 of every file of that
release. A tag names one content for ever: the release tooling refuses to reuse a
version number for different files.

`tools/verify.mjs` compares a copy with its tag, byte for byte. It needs Node 18
or later and nothing else:

```sh
git clone https://codeberg.org/harmonism/lodestone.git && cd lodestone

node tools/verify.mjs web                 # the web app, as lodestone.harmonism.io serves it now
node tools/verify.mjs desktop             # Lodestone Desktop, found in the usual install places
node tools/verify.mjs desktop /path/to/Lodestone.app
```

It fetches `SHA256SUMS` from Codeberg and from GitHub and stops if they disagree.
To trust neither, check out the tag and hash its files yourself:

```sh
git checkout web-v108          # the tag verify names
node tools/verify.mjs web --repo .
```

What it checks. For the web app: every file of the release, fetched as served,
which includes `index.html`, `main.js` and every module they load; a file answered
by a redirect counts as missing. For Desktop: its interface (`web/`), its own code
inside `app.asar`, every third-party package inside it (by name and version against
`desktop/package-lock.json`), and its model engine (`engine/`) against the
published list for your platform.

What it does not check: the library of articles (`corpus/`, data, not code); the
two small models' weights (`vendor/models/*.onnx`, published by their makers on
Hugging Face); Electron, the frame Desktop runs in, whose builds Electron publishes
with its own checksums; the dictation engine. The web app's `.svg` files are not
compared because the host serves `.svg` requests as images of another type; the
app draws its marks inline and uses none of them.

Limits. A web server can serve different files at another hour or to another
person: verify again when it matters, from another network. Lodestone Desktop
changes only when you install an update, so a copy you verified stays verified;
that makes Desktop the form of Lodestone you can audit once and rely on.
Releases from before tagging began (web up to v107, Desktop up to 1.17.1) have no
tag and cannot be checked this way.

## 2. Read the release

Lodestone's own code is plain, unminified JavaScript: `app/js/` (the interface,
shared by the web app, the phone and Desktop) and `desktop/src/` (Desktop's own
side). Together about 1.6 MB, some 400,000 tokens. Beside it, `app/vendor/` holds
about 36 MB of minified third-party code (the in-browser model runtime,
transformers.js, PDF.js, ONNX Runtime, two small libraries). Nobody can audit
minified code by reading it; it is checked by version and hash against the
packages its makers publish (each folder's `SOURCE.txt`, where present, names the
package, version and SHA-256).

### First, mechanically

Two commands find every place the code can reach the network, and every address
written in it. Run them in the repository:

```sh
grep -rnE "fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|new Worker|new Function|eval\(" app/js desktop/src
grep -rhoE "https?://[a-z0-9.-]+\.[a-z]{2,}" app/js desktop/src app/index.html | sort | uniq -c | sort -rn
```

The addresses you should find, and what each is for:

| Address | Used for | When |
|---|---|---|
| openrouter.ai | the model, when you choose OpenRouter under your own key | each message, sent from your device straight there |
| api.anthropic.com, api.venice.ai, router.huggingface.co | the model, when you choose that provider under your own key | each message |
| api.openai.com, api.x.ai | spoken replies, when you choose that voice under your own key | each reply read aloud |
| harmonism.io, lodestone.harmonism.io | the free account's model (the messages pass through Harmonia's server, held in trust: see the privacy policy); sign-in; sync, encrypted on your device before it leaves; updates you ask for; a link you make for a guide (sealed on your device); a conversation you choose to share for review | only for what you turned on or asked for |
| harmonism.io (lodestone-learn.php) | keeping what Lodestone has learned of you up to date from the conversations harmonism.io itself answered (the free account's model), when you are signed in and Settings → Memory → "Let harmonism.io keep what Lodestone has learned of you up to date" is on: your memory and those messages, readable by the server for that request and not stored. A conversation answered by a model you chose, on your computer or under your own key, is never sent, and no such call is made after its turns | after turns harmonism.io answered |
| *.supabase.co | signing in to a harmonism.io account | at sign-in and when a sign-in renews |
| huggingface.co, github.com | downloading a model, a speech model or the model engine | when you ask for one |
| duckduckgo.com, api.search.brave.com, en.wikipedia.org | a web lookup in Desktop | only when you turn web lookup on and a message asks for it |
| api.telegram.org | your own Telegram bot through Desktop | only if you set one up |
| befrienders.org, t.me, scripts.sil.org, w3.org | links shown on screen, a licence link, an XML namespace | never fetched by the code |

On a model that runs on your own computer, no conversation answered there leaves
it; under your own key, a conversation goes to the provider you chose and nowhere
else. Lodestone learns from both on your device. Sync, if you turn it on, carries
your memory encrypted on your device first.

### Then, with your own model

A model on your computer can read the code with you, file by file. A model that
holds 32,000 tokens takes one of the smaller files whole, or a section of a large
one: `app/js/main.js` (about 150,000 tokens) is divided by its section headings,
the lines that begin `// ───`. Give it one piece at a time with these questions:

```text
You are auditing one file of Lodestone, an open-source app that says it keeps the
user's conversations and memory on their device. Answer from the code only, citing
line numbers. If you are unsure, say so.

1. List every network request this code makes or can make (fetch, XMLHttpRequest,
   WebSocket, EventSource, sendBeacon, a worker or script loaded from an address,
   a form posted, a page opened). For each: the address, when it happens, and what
   data it sends.
2. Does any request carry the user's messages, memory, life book, files, keys or
   passwords? Is the data encrypted before it leaves, and with a key the server
   holds or one only the device holds?
3. Does anything happen without the user acting: timers, background sends,
   requests on start-up? What do they send?
4. Is any code built or loaded at run time (eval, new Function, import() of a
   computed address, strings decoded and run)? Any long encoded strings
   (base64, hex) that are decoded and used?
5. Does this file read files or folders? What does it do with what it reads?
6. Is there anything that contradicts what the comments say the code does?
```

How to weigh the answers. A model can miss what is there and describe what is
not. Open every line it cites and read it yourself; treat "found nothing" as "this
model found nothing in this piece", never as proof. The mechanical inventory above
is the check on the model: every request it lists should appear in the model's
answers for the file it sits in.

## 3. Watch it run

The strongest test watches what Lodestone does instead of reading what it says.

- **Lodestone Desktop.** Run a connection monitor: LuLu (free and open source) or
  Little Snitch on a Mac; the firewall's log, or a tool such as GlassWire, on
  Windows; OpenSnitch on Linux. Each connection is shown with its address as it
  happens.
- **The web app.** Open the browser's developer tools, the Network tab, before
  you start, and keep it open while you use it.

Then use Lodestone as you would. Every connection should be to an address in the
table above, at a moment you can explain by something you did or turned on. With
a model on your own computer and sync off, a conversation should open no
connection at all.

## Reporting

If a check fails, or the code or its behaviour contradicts this page, write to
harmonia@harmonism.io, or open an issue on Codeberg. Say which release (the
version and tag), which check, and what you saw.
