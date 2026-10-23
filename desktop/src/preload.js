// preload.js — the bridge between the window and the app.
//   Setup pages (file://): models, library languages and updates, phone access.
//   Lodestone and the library (the app's own origin): which model is running, the
//   screens to change it, and "Look this up online".
const { contextBridge, ipcRenderer } = require("electron");
const on = (ch, fn) => { const h = (_e, p) => fn(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

if (location.protocol === "file:" && /\/(launcher|phone)\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld("desktop", {
    status: () => call("status"),
    download: id => call("download", id),
    cancelDownload: () => call("cancel-download"),
    start: id => call("start", id),
    deleteModel: id => call("delete-model", id),
    addCustom: input => call("add-custom", input),
    removeCustom: id => call("remove-custom", id),
    removeLeftovers: () => call("remove-leftovers"),
    openApp: () => call("open-app"),
    goBack: () => call("go-back"),
    setUpstream: url => call("set-upstream", url),
    remoteModels: (conf, key) => call("remote-models", conf, key),
    setRemote: (conf, key) => call("set-remote", conf, key),
    clearRemote: () => call("clear-remote"),
    hostedSignIn: (email, password) => call("hosted-sign-in", email, password),
    hostedStatus: () => call("hosted-status"),
    hostedUse: model => call("hosted-use", model),
    hostedSignOut: () => call("hosted-sign-out"),
    // The account's page on harmonism.io, in the app: consent, plan, the bundle.
    accountCall: (method, path, body) => call("account-call", method, path, body),
    accountOpenBundle: () => call("account-open-bundle"),
    revealLog: () => call("reveal-log"),
    library: () => call("library"),
    checkUpdates: () => call("updates-check"),
    login: (user, pass) => call("updates-login", user, pass),
    forgetPassword: () => call("updates-forget"),
    updateCorpus: () => call("update-corpus"),
    updateModels: () => call("update-models"),
    installLanguage: lang => call("install-language", lang),
    removeLanguage: lang => call("remove-language", lang),
    downloadApp: () => call("download-app"),
    installApp: () => call("install-app"),
    phoneStatus: () => call("phone-status"),
    unpair: id => call("unpair", id),
    setLan: v => call("set-lan", v),
    qr: text => call("qr", text),
    tgStatus: () => call("tg-status"),
    tgSetToken: token => call("tg-set-token", token),
    tgOutreach: on => call("tg-outreach", on),
    tgForget: () => call("tg-forget"),
    onProgress: fn => on("progress", fn),
    onLog: fn => on("log", fn),
  });
} else if (location.hostname === "127.0.0.1") {
  contextBridge.exposeInMainWorld("lodestoneDesktop", {
    info: () => call("info"),
    openModels: () => call("open-models"),
    quickModels: () => call("quick-models"),
    hostedStatus: () => call("hosted-status"),
    // Folders Lodestone may read (Settings → Advanced)
    foldersList: () => call("folders-list"),
    foldersAdd: () => call("folders-add"),
    foldersRemove: p => call("folders-remove", p),
    foldersReread: () => call("folders-reread"),
    searchFolders: q => call("folders-search", q),
    // The life book: Lodestone's own folder in the practitioner's vault
    lifebookStatus: () => call("lifebook-status"),
    lifebookChoose: () => call("lifebook-choose"),
    lifebookForget: () => call("lifebook-forget"),
    lifebookOpen: () => call("lifebook-open"),
    lifebookEntries: () => call("lifebook-entries"),
    lifebookWrite: change => call("lifebook-write", change),
    switchModel: choice => call("switch-model", choice),
    openUpdates: () => call("open-updates"),
    openLibrary: lang => call("open-library", lang),
    openPhone: () => call("open-phone"),
    // Sync: encrypted in the window, carried under the account by the app
    syncAccount: () => call("sync-account"),
    syncSignIn: (email, password) => call("sync-sign-in", email, password),
    syncUnlockTake: () => call("sync-unlock-take"),
    syncCall: (method, query, body) => call("sync-call", method, query, body),
    syncLocal: (method, query, body) => call("sync-local", method, query, body),
    heldCall: (path, body) => call("held-call", path, body),
    voiceSpeak: (text, gender, lang) => call("voice-speak", text, gender, lang),
    syncKeyGet: () => call("sync-key-get"),
    syncKeySet: key => call("sync-key-set", key),
    webLookup: question => call("web-lookup", question),
    // Attachments: the speech model and the current model's vision, downloaded on first use
    asrDownload: () => call("asr-download"),
    asrNative: (samples, language) => call("asr-native", samples, language),
    convertFile: (name, bytes) => call("convert-file", name, bytes),
    visionDownload: () => call("vision-download"),
    onProgress: fn => on("progress", fn),
    // Bridge mode only (the hidden page that answers the practitioner's Telegram bot)
    bridgeReady: () => call("bridge-ready"),
    onBridgeRequest: fn => on("bridge-request", fn),
    bridgeReply: (id, ok, payload) => call("bridge-reply", id, ok, payload),
  });
}
