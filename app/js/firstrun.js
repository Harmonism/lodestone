// firstrun.js — the first-run setup (November 20, 2026).
//
// Shown once, on a device that holds no Lodestone data: never after an update or a
// reinstall, which leave the data where it is. Six short screens, each with
// Use recommended / Previous / Next, the same window size on every step. What a
// person chooses here is ordinary settings, editable later in Settings; what they
// are (their temperament, their Wheel) is the Harmonic Profile's, never asked here.
// Spec: Lodestone First Run and Navigation Spec, 2026-11-20 (internal).
//
// Where Lodestone thinks is not asked here: the screen that asks it follows this one,
// with the own-key route first. In a browser or on a phone, main.js showSetup; in
// Lodestone Desktop, the shell's welcome page (desktop/src/launcher.html), which then
// opens the app again.

import { AWAKEN_SVG } from "./awaken.js";

export const FIRST_RUN_VERSION = 1;

/** The behaviour the app is built to work best with. */
export const RECOMMENDED = {
  uiLang: "auto", theme: "auto", fontSize: "default", simple: false,
  tone: { formality: 2, directness: 2, structure: 2 },
  wants: ["teach"], outreach: true, recall: true, learn: true, hpAsk: true,
};

/** What each "do more of" choice changes, said on screen and to the model. */
export const WANTS = [
  { id: "listen", label: "Listen more, advise less", sub: "Reflects back what you said and asks before offering advice.",
    prompt: "Listen more than you advise: reflect back what they said, and ask before offering advice." },
  { id: "teach", label: "Teach me practices", sub: "Suggests a concrete practice when one fits what you are going through.",
    prompt: "When a practice fits what they are going through, teach it concretely: what to do, when, for how long." },
  { id: "challenge", label: "Challenge my beliefs", sub: "Says where your reasoning looks weak instead of agreeing.",
    prompt: "Where their reasoning looks weak, say so plainly and why, instead of agreeing." },
  { id: "task", label: "Give me something to do", sub: "Ends with one thing to try before you next talk.",
    prompt: "End with one thing for them to try before they next talk with you." },
  { id: "goals", label: "Help me set goals", sub: "Turns what you want into goals with dates, and asks about them later.",
    prompt: "Help them turn what they want into goals with dates, and ask about those goals in later conversations." },
];

/** The three tone scales: 0 and 1 lean to the first pole, 3 and 4 to the second, 2 is no preference. */
export const TONES = [
  { key: "formality", a: "Casual", b: "Formal", pa: "Speak casually, as a friend would.", pb: "Speak formally, with restraint." },
  { key: "directness", a: "Gentle", b: "Direct", pa: "Be gentle: lead with what is understood before what has to change.", pb: "Be direct: say plainly what you see, without cushioning." },
  { key: "structure", a: "Flexible", b: "Structured", pa: "Follow where they go rather than imposing a structure.", pb: "Give structure: the point, the steps, the next action." },
];

/** Their choices as a block of the system prompt; "" when nothing departs from the default. */
export function prefsBlock(settings, { hasProfile = false } = {}) {
  const lines = [];
  const tone = settings?.tone || {};
  for (const t of TONES) {
    const v = Number.isFinite(tone[t.key]) ? tone[t.key] : 2;
    if (v === 2) continue;
    const s = v < 2 ? t.pa : t.pb;
    lines.push(v === 0 || v === 4 ? s : "A little, without overdoing it. " + s);
  }
  for (const w of WANTS) if ((settings?.wants || []).includes(w.id)) lines.push(w.prompt);
  if (settings?.hpAsk && !hasProfile) lines.push("They chose to let their Harmonic Profile be drawn out in conversation rather than by a questionnaire. When it fits naturally, and never in a hard moment, ask one question that helps place them on a pillar of the Wheel; never more than one such question in a reply.");
  if (!lines.length) return "";
  return `<their_preferences>\nHow this practitioner asked to be spoken with (chosen in setup, changeable in Settings). These shape the manner only: safety, truthfulness and the substance of what you say come first.\n${lines.map(l => "- " + l).join("\n")}\n</their_preferences>`;
}

const h = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) n[k] = v; else if (k === "html") n.innerHTML = v; else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
};
const sprite = cls => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "fr-sprite " + cls); s.setAttribute("aria-hidden", "true"); s.setAttribute("viewBox", "0 0 48 56");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#lodestone-sprite");
  s.append(u); return s;
};
const tag = () => h("span", { class: "fr-rec" }, "Recommended");
// The welcome's Sprite: the mark wakes as the window opens, as on harmonism.io; once only.
let awoke = false;
const awakening = () => {
  const box = h("div", { class: "fr-awaken", "aria-hidden": "true", html: AWAKEN_SVG });
  const svg = box.firstElementChild;
  if (awoke) svg.classList.add("play", "done");
  else { awoke = true; requestAnimationFrame(() => setTimeout(() => svg.classList.add("play"), 250)); }
  return box;
};

/**
 * Runs the first-run setup. Resolves when the person finishes, with
 * { hp: "now" | "talk" | "later" }; every choice is already in `settings` and saved.
 * opts: { settings, save, desktop, applyTheme, applyDisplay, setLanguage, resolveUiLang,
 *         lifebookChoose?, needsModel, aiNotice }
 */
export function run(opts) {
  const { settings, save, desktop, needsModel, carried } = opts;
  const st = {
    path: "rec",
    uiLang: settings.uiLang || RECOMMENDED.uiLang,
    theme: settings.theme && settings.theme !== "dark" ? settings.theme : RECOMMENDED.theme,
    fontSize: settings.fontSize || RECOMMENDED.fontSize,
    simple: settings.simple ?? RECOMMENDED.simple,
    tone: { ...RECOMMENDED.tone, ...(settings.tone || {}) },
    wants: settings.wants ? [...settings.wants] : [...RECOMMENDED.wants],
    outreach: settings.outreach ?? RECOMMENDED.outreach,
    recall: settings.recall ?? RECOMMENDED.recall,
    learn: settings.learn ?? RECOMMENDED.learn,
    hp: settings.hpAsk === false ? "later" : "talk",
    lifebook: null,
    first: "",
  };
  // The recommended values for the screens from `from` on; what was chosen before stays.
  const recommend = (from = 1) => {
    if (from <= 1) Object.assign(st, { theme: RECOMMENDED.theme, fontSize: RECOMMENDED.fontSize });
    if (from <= 2) Object.assign(st, { simple: RECOMMENDED.simple, tone: { ...RECOMMENDED.tone }, wants: [...RECOMMENDED.wants], outreach: RECOMMENDED.outreach });
    if (from <= 3) Object.assign(st, { recall: RECOMMENDED.recall, learn: RECOMMENDED.learn });
    look();
  };
  const look = () => {
    settings.theme = st.theme; settings.fontSize = st.fontSize;
    opts.applyTheme(st.theme); opts.applyDisplay();
  };
  const lang = v => {
    st.uiLang = v; settings.uiLang = v;
    try { opts.setLanguage(opts.resolveUiLang(v, settings.lang)); } catch {}
  };

  const seg = (key, options, onPick) => h("div", { class: "fr-seg", role: "radiogroup" },
    options.map(([v, label, rec]) => h("button", { type: "button", role: "radio", "aria-checked": String(st[key] === v),
      onclick: () => { onPick ? onPick(v) : (st[key] = v); draw(); } }, label, rec ? tag() : null)));
  const card = (key, v, title, sub, rec) => h("button", { type: "button", class: "fr-card", "aria-pressed": String(st[key] === v),
    onclick: () => { st[key] = v; draw(); } }, h("span", { class: "fr-card-t" }, title, rec ? tag() : null), h("span", { class: "fr-card-d" }, sub));
  const toggle = (title, sub, get, set, rec) => {
    const box = h("input", { type: "checkbox" }); box.checked = get(); box.onchange = () => set(box.checked);
    return h("label", { class: "fr-toggle" }, box, h("span", {}, h("span", { class: "fr-card-t" }, title, rec ? tag() : null), h("span", { class: "fr-card-d" }, sub)));
  };
  const field = (label, ...kids) => h("div", { class: "fr-field" }, h("div", { class: "fr-label" }, label), ...kids);

  const SCREENS = [
    () => [awakening(), h("h1", {}, "Welcome to Lodestone"),
      h("p", { class: "fr-lead" }, "A guide to living in harmony, in conversation. What you answer here stays on this device."),
      h("div", { class: "fr-field fr-inline" }, h("div", { class: "fr-label" }, "Language"), seg("uiLang", [["auto", "Auto"], ["en", "English"], ["fr", "Français"]], lang)),
      h("div", { class: "fr-field" },
        card("path", "rec", "Recommended settings", "Lodestone as it is built to work best; only the Harmonic Profile is asked."),
        card("path", "own", "Choose each setting", "Look, tone and what Lodestone keeps, in a few short steps.")),
      h("p", { class: "fr-fine", html: opts.aiNotice || "" })],
    () => [h("h1", {}, "How should it look?"), h("p", { class: "fr-lead" }, "You see the change as you choose."),
      field("Theme", seg("theme", [["dark", "Dark"], ["light", "Light"], ["auto", "Follow the system", true]], v => { st.theme = v; look(); })),
      field("Text size", seg("fontSize", [["small", "Small"], ["default", "Default", true], ["large", "Large"], ["larger", "Very large"]], v => { st.fontSize = v; look(); }))],
    () => [h("h1", {}, "How should Lodestone speak?"),
      field("Mode",
        h("div", { class: "fr-cards" },
          card("simple", true, "Simple", "Just the conversation. The Wheel, Your path and the Library are hidden; Lodestone keeps learning in the background."),
          card("simple", false, "Full", "The conversation, with your Wheel, your practices and the Library beside it.", true))),
      field("Tone (leave in the middle for no preference)",
        ...TONES.map(t => {
          const r = h("input", { type: "range", min: "0", max: "4", step: "1", value: String(st.tone[t.key]), "aria-label": `${t.a} to ${t.b}` });
          r.oninput = () => { st.tone[t.key] = +r.value; };
          return h("div", { class: "fr-scale" }, h("span", {}, t.a), r, h("span", {}, t.b));
        })),
      field("What should Lodestone do more of?",
        h("p", { class: "fr-note" }, "Each one changes how it answers. Leave them all off for a balanced guide."),
        ...WANTS.map(w => toggle(w.label, w.sub, () => st.wants.includes(w.id),
          on => { st.wants = on ? [...new Set([...st.wants, w.id])] : st.wants.filter(x => x !== w.id); }, RECOMMENDED.wants.includes(w.id))),
        toggle("Check in on me", "Writes to you first when a practice is due. Off: it only answers.", () => st.outreach, on => { st.outreach = on; }, true))],
    () => [h("h1", {}, "What should Lodestone keep?"), h("p", { class: "fr-lead" }, "So that it knows you from one conversation to the next. All of it stays on this device, and you can read, correct or erase it at any time."),
      toggle("Remember earlier conversations", "Recalls what you said in another conversation when it matters, and shows you which.", () => st.recall, on => { st.recall = on; }, true),
      toggle("Learn from our conversations", "Keeps notes on what matters in your life, and updates your Wheel's evidence, as you talk.", () => st.learn, on => { st.learn = on; }, true),
      desktop && opts.lifebookChoose ? h("div", { class: "fr-field fr-lb" },
        h("div", { class: "fr-label" }, "Life book"),
        h("p", { class: "fr-note" }, "Notes on your life, kept as files you can read and edit: your health and medications, the people close to you, your work and home, your commitments and practices. A note comes back when its subject comes up."),
        h("button", { type: "button", class: "btn ghost", onclick: async e => {
          try { const r = await opts.lifebookChoose(); if (r) { st.lifebook = r; e.target.textContent = "Folder chosen"; e.target.disabled = true; } } catch {}
        } }, st.lifebook ? "Folder chosen" : "Choose where to keep it…"),
        h("p", { class: "fr-note" }, "Optional; it can be chosen later in Settings.")) : null],
    () => [sprite("fr-blink"), h("h1", {}, "Your Harmonic Profile"),
      h("p", { class: "fr-lead" }, "A portrait of where you stand across the eight pillars, your temperament and your constitution, so Lodestone meets you where you are."),
      h("div", { class: "fr-cards" },
        card("hp", "now", "Take the assessment", "On harmonism.io: 10 to 15 minutes for the Wheel, 30 to 40 for the whole profile. It opens in Your path when setup is done."),
        card("hp", "talk", "Let Lodestone ask as we talk", "A question now and then, when it fits.", true),
        card("hp", "later", "Later", "It waits in Your path."))],
    // The last screen. Someone who already spoke with Lodestone on harmonism.io continues
    // that conversation; anyone else is asked what brings them, and that is their first message.
    () => carried
      ? (!needsModel
        ? [sprite("fr-roll"), h("h1", {}, "All set"), h("p", { class: "fr-lead" }, "Your conversation from harmonism.io is here; it continues where you left it. Everything you chose is in Settings.")]
        : [sprite("fr-roll"), h("h1", {}, "One step left"), h("p", { class: "fr-lead" }, "Choose where Lodestone thinks; your conversation from harmonism.io waits here. With your own key, your conversations stay between you and the model you chose.")])
      : [sprite("fr-roll"), h("h1", {}, "What brings you here today?"),
        h("p", { class: "fr-lead" }, "Write it as it comes. It becomes your first message, and Lodestone begins there."),
        (() => { const ta = h("textarea", { class: "fr-first", rows: "5", "aria-label": "What brings you here today?", placeholder: "A question, something you are going through, something you want to change…" });
          ta.value = st.first; ta.oninput = () => { st.first = ta.value; }; setTimeout(() => ta.focus(), 50); return ta; })(),
        h("p", { class: "fr-note" }, !needsModel ? "You can also leave it empty and begin." : "Next, choose where Lodestone thinks; your message waits until then. You can also leave it empty.")],
  ];
  const LAST = SCREENS.length - 1, HP = 4;

  const root = h("section", { id: "firstrun", class: "screen", role: "dialog", "aria-modal": "true", "aria-labelledby": "frTitle" });
  const body = h("div", { class: "fr-body" });
  const dots = h("div", { class: "fr-dots", "aria-hidden": "true" });
  const skip = h("button", { type: "button", class: "fr-skip" }, "Use recommended");
  const prev = h("button", { type: "button", class: "btn ghost" }, "Previous");
  const next = h("button", { type: "button", class: "btn primary" }, "Next");
  root.append(h("div", { class: "fr-wrap" }, h("div", { class: "fr-win" }, body, h("div", { class: "fr-foot" }, skip, dots, h("div", { class: "fr-nav" }, prev, next)))));
  let i = 0;
  const draw = () => {
    body.replaceChildren(...SCREENS[i]().filter(Boolean));
    body.querySelector("h1")?.setAttribute("id", "frTitle");
    body.scrollTop = 0;
    dots.replaceChildren(...SCREENS.map((_, k) => h("i", { class: k <= i ? "on" : "" })));
    prev.hidden = i === 0;
    skip.hidden = i === 0 || i >= HP;
    next.textContent = i === LAST ? (!needsModel ? "Begin" : "Continue") : "Next";
  };
  look();
  document.getElementById("app")?.append(root);
  draw();

  return new Promise(resolve => {
    const finish = async () => {
      Object.assign(settings, {
        uiLang: st.uiLang, theme: st.theme, fontSize: st.fontSize, simple: st.simple,
        tone: { ...st.tone }, wants: [...st.wants], outreach: st.outreach, recall: st.recall, learn: st.learn,
        hpAsk: st.hp === "talk",
        firstRun: { v: FIRST_RUN_VERSION, at: Date.now(), path: st.path },
      });
      try { await save(); } catch {}
      root.remove();
      resolve({ hp: st.hp, first: carried ? "" : st.first.trim() });
    };
    next.onclick = () => {
      if (i === 0 && st.path === "rec") { recommend(); i = HP; draw(); return; }
      if (i < LAST) { i++; draw(); return; }
      finish();
    };
    prev.onclick = () => { if (i === HP && st.path === "rec") i = 0; else if (i > 0) i--; draw(); };
    skip.onclick = () => { recommend(i); i = HP; draw(); };
  });
}
