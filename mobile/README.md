# Lodestone for Android — the native shell

A Capacitor 8 app that opens **https://harmonism.io/lodestone-app/**: the same web app, at the same origin, so the website's sign-in, the Harmonic Profile handoff and every deploy reach it unchanged. One shell around `lodestone/app/`, never a second harness. A change to Lodestone is a site deploy; a new APK is needed only when the shell itself changes.

What the shell adds, because a web page may not do it:

- **The home network.** The page may reach Lodestone Desktop at `http://<computer>:47863`: `usesCleartextTraffic` and `android.allowMixedContent` are on for that, and nothing else uses them (harmonism.io is https). The desktop answers the origin `https://harmonism.io` with CORS, `Access-Control-Allow-Private-Network` included, on its model, pairing and sync routes only. Should the WebView still refuse, `app/js/native.js` retries through Capacitor's native HTTP (answers then arrive whole rather than word by word).
- **Pairing.** Lodestone Desktop → *Use from Your Phone…* shows a six-digit code and a QR code of `lodestone://pair?u=<computer>&c=<code>&n=<name>`. The phone's camera opens the app with it, or the code is typed under *My computer*. The code works once, for ten minutes and five tries; five wrong tries end it, and only the desktop's window makes a new one (`desktop/src/pairing.js`). The phone keeps the token it is given, encrypted like the OpenRouter key; the desktop keeps only its hash and lists the phone by name, with *Forget*.
- **Sync through the computer.** Settings → *Sync* offers the account or the paired computer. The computer keeps the same records, the same ciphertext under the practitioner's passphrase, in `<userData>/sync/records.json` (`desktop/src/syncstore.js`, the JavaScript twin of `lodestone-sync-api.php`), so nothing leaves the home network. Lodestone Desktop's own window can sync with that copy too (*Through this computer only*).
- **App storage.** Android does not evict an app's storage as Safari evicts a website's; `allowBackup` is off, so the memory and keys stay out of Google's cloud backup.

## Layout

- `capacitor.config.json` — `server.url` is the live app; `allowNavigation` keeps the WebView on harmonism.io (other sites open in the browser); `errorPath` shows `www/offline.html` when the first opening finds no connection; `SystemBars` handles the edge-to-edge insets (the app's viewport is `viewport-fit=cover`).
- `www/` — the offline page, and an `index.html` that is never shown.
- `android/` — the Gradle project made by `npx cap add android`, then: the `lodestone://pair` intent filter and cleartext in `AndroidManifest.xml`; Lodestone's icons and splash; release signing from `../keys/` in `app/build.gradle`.
- `keys/` — `munai-release.jks` and `keystore.properties` (its passwords). **Keep a copy somewhere safe.** Without it the installed apps cannot be updated in place, only uninstalled (memory lost unless synced) and reinstalled. Not in git.
- `release/` — the newest signed APK, published by `harmonia-astro/post-build.sh` as `/lodestone-app/download/Lodestone-android.apk`, and linked from `/lodestone-mobile` (which reads the version from the file names here at build time) and the Lodestone dropdown's *Lodestone Mobile* row.
- `build-android.sh` — the build, on a Mac.

## Build

```bash
brew install --cask temurin@21 android-commandlinetools    # once
cd lodestone/mobile && ./build-android.sh
```

Raise `versionCode` and `versionName` in `android/app/build.gradle` before each new APK.

**1.0.0** (October 18, 2026) was built in the cloud workspace with JDK 21, Gradle 8.14.3, Android Gradle Plugin 8.13, compile and target SDK 36, minimum SDK 24 (Android 7.0): `release/Lodestone-android-1.0.0.apk`, 3.6 MB, signed v2 with the key in `keys/` (certificate SHA-256 `7c8398ec542677e9086ccc5e8057e870eced1ad1b33ae860fcc940622ceef5be`).

## How the bridge reaches the page

Capacitor injects its bridge (`window.Capacitor`) into the HTML it loads from `server.url`, and only into what is requested as HTML. The service worker therefore asks for the page with `Accept: text/html` when it stores it (`app/sw.js`), so the copy opened offline carries the bridge too; and a page that opens in the app without it (the user agent says `Lodestone-Android`) drops the stored copy and loads once more while online (`reloadForBridge()` in `app/js/main.js`).

## Tested

`python3 tools/test-android.py app desktop/src` (October 18, 2026): 26 of 26. The Android shell itself cannot run in the workspace; what it adds to the page is stood in for (`window.Capacitor`, the App plugin's launch URL and `appUrlOpen`, the user agent), and Lodestone Desktop's phone server runs without Electron (`tools/desktop-phone-server.cjs`: the real `server.js`, `pairing.js` and `syncstore.js`). Checked: CORS for the app's origin only, on the three routes only; sync refused without a token; no code, no pairing; five wrong codes end the code and nothing is paired by guessing; the pairing form, a wrong and a right code; the token stored encrypted; the computer lists the phone by name; a turn answered by the computer's model; the model menu; sync through the computer on, with only ciphertext on the computer; a second phone paired from the QR link, the computer route preselected, joining the copy and receiving the first phone's conversation; a link opened while the app runs; a forgotten phone told to pair again; a page without the bridge reloaded once, not in a loop.

**Not yet run:** the APK on a real phone (install, the camera opening `lodestone://pair`, the WebView reaching the computer or falling back to native HTTP, offline reopening, the insets), and Lodestone Desktop 1.8.0's pairing window and *Through this computer only* in Electron.

## iPhone

No iOS shell: Harmonia does not enrol in the Apple Developer Program. On an iPhone, Lodestone is the web app added to the Home Screen from Safari. That app cannot call Lodestone Desktop, because WebKit blocks an https page from calling `http://<computer>:47863`, so pairing, sync through the computer and the pairing link are Android's alone; the Home Screen app thinks on a harmonism.io account, OpenRouter under the practitioner's key, or no model, and keeps its backup through account sync or *Export memory*. The computer's model still reaches an iPhone by the other door: with *Use from Your Phone…* switched on, Lodestone Desktop serves its own copy of the app at `http://<computer>:<port>/lodestone-app/`, and Safari opens that plain-http page with no mixed-content block. The Home Screen app's *My computer* route already points there (`app/js/main.js`, `phoneComputer`). That copy is not a secure context, so it has no service worker, no sync and no hosted or OpenRouter route, and its memory is separate from the Home Screen app's; *Export memory* and *Import memory* move it across. Not yet run on a real iPhone. The shell would build for iOS with `npx cap add ios` if the ruling is ever reversed.
