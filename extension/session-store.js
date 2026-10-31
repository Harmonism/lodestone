// session-store.js — the harmonism.io sign-in, kept in the extension's own
// storage. A service worker has no localStorage; phone.js reads the
// session through this instead. A cache, filled from chrome.storage.local
// before first use, written back on every change.

const KEY = "munai-session";
let cache = {};
let loaded = null;

export function ready() {
  if (!loaded) loaded = chrome.storage.local.get({ [KEY]: {} }).then(v => { cache = v[KEY] || {}; });
  return loaded;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[KEY]) cache = changes[KEY].newValue || {};
});

const save = () => chrome.storage.local.set({ [KEY]: cache });

export const store = {
  keys: () => Object.keys(cache),
  get: k => (k in cache ? cache[k] : null),
  set: (k, v) => { cache = { ...cache, [k]: String(v) }; save(); },
  del: k => { const { [k]: _, ...rest } = cache; cache = rest; save(); },
};
