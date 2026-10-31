# Lodestone — Safari build

Safari can't load web extensions directly; Apple requires wrapping them in a macOS/iOS app via Xcode. The codebase is already compatible (MV3, service-worker background, `chrome.*` APIs — Safari 16.4+ supports all of it; the server already allows `safari-web-extension://` origins for CORS).

## Requirements

- Xcode 15+ on macOS
- Apple Developer Program membership ($99/year) for App Store distribution

## Convert

```bash
xcrun safari-web-extension-converter /path/to/lodestone-extension \
  --project-location ~/Desktop/Lodestone-Safari \
  --app-name "Lodestone" \
  --bundle-identifier io.harmonism.munai \
  --macos-only
```

Drop `--macos-only` to also generate the iOS target (Safari on iPhone/iPad supports web extensions — potentially worth it, Lodestone on mobile browsing).

## After conversion

1. Open the generated `.xcodeproj`, set your signing team.
2. Build & run once — the wrapper app appears; enable the extension in Safari → Settings → Extensions.
3. Safari treats host permissions as per-site grants the user confirms on first use; the consent flow is Safari-native, nothing to code.
4. For distribution: archive → App Store Connect → review. Safari extensions ship through the Mac App Store, not a separate gallery.

## Known deltas vs. Chromium

- `chrome.storage.sync` maps to iCloud-less local storage on Safari — settings won't roam across devices. Functionally identical otherwise.
- Cookie reads (`chrome.cookies`) require the harmonism.io host permission to be granted in Safari's per-site permission UI before memory linking works. The options page's permission request triggers the Safari prompt.

## Priority

Defer until Chrome Web Store + AMO listings are live and pulling. Safari desktop share is small; the interesting Safari surface is iOS, which is a deliberate second wave.
