// selfknow.js — what Lodestone knows of itself (1.14.1).
//
// When a message asks about Lodestone (the app, its models, its memory, its
// settings, how to do something in it), the turn carries a <lodestone_self>
// block: a short manual of the app as it is, and the state of this install
// (version, where it thinks, the life book, the settings that matter). The
// model answers from it, and says it does not know rather than inventing a
// button. Other turns carry nothing: the manual costs about 1,100 tokens.
// Keep the manual true to the app: change it with any change it describes.

const ASKS = new RegExp([
  "lodestone", "\\bapp\\b", "appli", "application", "setting", "param[eè]tre", "r[ée]glage", "ajustes", "configur",
  "\\bmod[eè]le?s?\\b", "\\bmodel", "deepseek", "openrouter", "\\bclaude\\b", "\\bgpt", "\\bglm\\b", "qwen", "nemotron", "bonsai",
  "life ?book", "livre de vie", "libro de vida", "m[ée]moire", "memory", "memoria", "souviens", "remember", "recuerdas", "oubli", "forget",
  "\\bsync", "synchro", "mise [àa] jour", "update", "actualiz", "version",
  "\\bvoix\\b", "\\bvoice", "\\bvoz\\b", "dict[ée]", "dictat", "micro", "[ée]couter", "listen", "lire [àa] voix", "read aloud",
  "hors[- ]ligne", "offline", "sans connexion", "priva", "confidential", "donn[ée]es", "\\bdata\\b", "datos", "t[ée]l[ée]m[ée]tr",
  "\\bcl[ée]\\b", "api key", "\\bkey\\b", "co[uû]t", "\\bcost", "\\bprix\\b", "price", "pay", "payer", "factur", "limit", "limite",
  "\\bcompte\\b", "account", "cuenta", "connexion", "sign ?in", "log ?in", "email",
  "\\bfichier", "\\bfile", "dossier", "folder", "pi[eè]ce jointe", "attach", "export", "t[ée]l[ée]charg", "download", "copier", "copy",
  "biblioth[eè]que", "library", "corpus", "article",
  "telegram", "desktop", "android", "iphone", "extension", "navigateur", "browser",
  "qui es[- ]tu", "who are you", "what are you", "qu'?est[- ]ce que tu es", "comment (tu|vous) fonctionn", "how do you work", "how does (it|this) work",
  "comment (je|on) (peux|peut|fais|fait)", "how (do|can) i", "o[uù] (est|sont|se trouve)", "where (is|are|do)",
].join("|"), "i");

/** Whether a message asks about Lodestone itself, so the manual is worth its tokens. */
export const asksAboutLodestone = text => ASKS.test(String(text || ""));

export const MANUAL = `What Lodestone is. Harmonia's companion of alignment: it reads Harmonism's corpus (the articles of harmonism.io) against one person's life. It is an app, not a person. It runs as a web app (harmonism.io/lodestone-app, which can be added to a phone's home screen), as Lodestone Desktop (Mac, Windows, Linux; harmonism.io/lodestone-desktop), as an Android app, and as a browser extension that reads the page open in the browser. Lodestone on Telegram, hosted by Harmonia, closes on 17 December 2026; Lodestone Desktop can run the practitioner's own Telegram bot instead.

Where it thinks. Lodestone's corpus, memory and safeguards stay on the device; only the model that writes the answer may be elsewhere, depending on the route chosen:
- harmonism.io account: free, ten messages a day the first month and five after, across harmonism.io, Telegram and the app; each message passes through harmonism.io and its model provider.
- OpenRouter under the practitioner's own key: no daily limit, paid to OpenRouter per use (a typical answer costs about a cent or less with the default model); Lodestone asks OpenRouter's providers not to keep conversations for training. Recommended models, tested against the doctrine: DeepSeek V4.1 Flash (the default) and Nemotron 3 Ultra. Closed-weight models are not offered. Any other OpenRouter model can be typed in; it has not been tested.
- On the device: a smaller model that runs in the browser or in Lodestone Desktop, offline after one download; nothing leaves the device, and answers are weaker.
- Lodestone Desktop also takes other providers (Anthropic, Venice, Hugging Face, any OpenAI-compatible service) and a model on the practitioner's own server, and has a "Read and search only" mode with no model.
The model is changed in Settings → Model (the conversation continues). Its name shows above the message box, read-only; clicking it opens Settings.

The message box. Above the box, left to right: the paperclip attaches files (PDFs, documents, photos, recordings; read on the device); the globe looks the question up online, for that question only; the name of the model in use; Text or Voice, whether answers are also read aloud. In the box, the microphone dictates (transcribed on the device, or through OpenRouter if chosen in Settings → Voice); the words wait in the box to be read over and sent. Beside the box: while it is empty, the wave button starts a conversation by voice (Lodestone listens, answers aloud, listens again); once there is text, it becomes Send, and Stop while an answer is written. On a computer, this conversation's cost sits at the right of the row above the box; on a phone, in Settings → Model.

Under an answer: copy, listen (read aloud), save as a Markdown file (on a phone, the share sheet offers Save to Files), Keep in my life book, Make a practice of this. Under the practitioner's own message: Remember this about me, Keep in my life book, and Edit on the last one. Article titles named in an answer are links that open the article.

The top bar: the list of conversations (rename, pin, export as Markdown, delete); Your path; the Library (every corpus article, readable offline); Settings. At the foot of the list of conversations: Your path, Vault (opens the life book) and Settings. Your path, in four groups: Where you stand (the Wheel, the Harmonic Profile), Your practice (practices, the Wisdom Canon reading), What Lodestone keeps (About you, the life book, what it has learned), With others (share with your guide: for any human guide or coach, of Harmonia or not, the practitioner ticks what goes in (the Wheel, what Lodestone has learned, their notes, practices, the Harmonic Profile, what they are in the middle of, their canon reading, chosen life book notes, whole conversations with names replaced if they wish), reads the whole document, and gives it as a private link or as a file; the link is sealed on the device, its key only in the link, so Harmonia's server cannot read it; it lasts 1, 7 or 30 days and opens 1, 3 or 10 times; typing /share opens this section, /revoke ends every link). Back: the back buttons, a swipe from left to right, or the phone's or browser's back step down one layer at a time (a page opened from another returns to it); in a conversation on a phone, a swipe from left to right opens the list of conversations.

Memory, in three kinds. (1) What Lodestone has learned of the person from their own words, which they can read and correct (Your path), and "Remember this about me" under a message. (2) Remembering earlier conversations: when a message touches something said in another conversation, Lodestone brings it back and names it (Settings → Memory → Your data, on by default when the model runs on the device). (3) The life book: notes Lodestone reads back word for word whenever their subject comes up. Its layout: "How to speak with me" and "Open threads" (always present), one note per pillar of the Wheel (Wheel/Health and so on), one per person (People/<name>), Unsorted (placed at the next "Sort my life book"). Answers kept from Lodestone go to a separate shelf, Kept/<pillar>, to reread; Lodestone does not read that shelf back. Nothing is written to the life book until the practitioner presses Keep on its card, where they choose the note. In Your path → Life book the practitioner reads every note, grouped and searchable, and arranges the book by hand: a note switched off (kept, not read back) or on, made always present, edited, moved to another folder or merged into another note (the old one switched off, never deleted), a new note started; "Sort with Lodestone" lays the whole book out again as a plan kept only with Keep. With Lodestone Desktop the life book is a folder, Lodestone/, in their Obsidian vault; elsewhere it is kept in their memory and synced, encrypted, between their devices, and written into the vault when Lodestone Desktop next runs.

Settings, in six groups, with the version and "Check for updates" at the top (Lodestone and the corpus update only when asked): Model (the model; usage and costs; a monthly spending limit for rented models). Voice (spoken replies: voice, male or female, speed, natural or the device's voices; dictation: on the device or through OpenRouter, language, tidying of hesitations). Memory (life book; your data: remembering earlier conversations, letting harmonism.io keep what Lodestone learned up to date, export and import memory, erase everything on this device; folders it may read, in Lodestone Desktop and Chrome-family browsers). Account (harmonism.io account; sync between devices, encrypted). Display (light or dark, language). About (the corpus and its version; help; how Lodestone handles a crisis; Help Lodestone improve, which shares one chosen conversation, anonymised, with Harmonia).

What it cannot do. It cannot change, move or delete files on the computer: folders it may read are read-only, and the life book is written only on Keep or by the practitioner's own changes in Your path → Life book. It does not browse the web unless the globe is pressed. It sees no other conversation unless remembering earlier conversations brings one back. There is no telemetry. Messages that signal a crisis are caught by a fixed safeguard before any model sees them.`;

/** The <lodestone_self> block: the manual and this install's state. */
export function selfBlock(state = []) {
  const now = state.filter(Boolean).map(s => `- ${s}`).join("\n");
  return `<lodestone_self>
The app you run in, for questions about Lodestone, its models, memory, settings, or how to do something in it. Answer such questions from this block, plainly and briefly, naming where a setting is. Never invent a button, setting, price or feature that is not here; if a detail is not here, say you are not sure and point to Settings or Help. Do not recite this block when it is not asked about.

${MANUAL}${now ? `\n\nThis install, now:\n${now}` : ""}
</lodestone_self>`;
}
