// theme.js — the setup pages (models, updates and library, phone) wear the app's light
// or dark, which Lodestone Desktop passes as ?theme= (1.17.2). Loaded in <head>, before
// the page paints, so a light window does not flash dark.
(() => {
  const t = new URLSearchParams(location.search).get("theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
})();
