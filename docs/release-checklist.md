# Candor Release Checklist

Use this before publishing a Windows installer on the website or submitting a package to Microsoft Store.

## Release Gate

- [ ] `npm run build` passes.
- [ ] `npm run audit:source` passes.
- [ ] `cargo build` passes in `src-tauri`.
- [ ] `npm run tauri:release` creates website installers.
- [ ] `npm run build:store` creates a Store candidate installer.
- [ ] `npm run audit:release` passes on the executable and installers before anything is shared.
- [ ] Release artifacts contain no `C:\Users\...`, local repo paths, or unapproved `.env` values.
- [ ] `CANDOR_RELEASE_ALLOWED_EMBEDDED_KEYS` is used only for additional public `.env` values intended to ship.
- [ ] PDB files are removed from public release output, or audited and retained privately for debugging only.
- [ ] Installer has been tested on a clean Windows machine.
- [ ] Recording starts and stops from a fresh install.
- [ ] First Whisper model download succeeds and has a useful error state if blocked.
- [ ] Microphone permission denial has a readable recovery message.
- [ ] Calendar connect/disconnect has been tested for Microsoft, Google, and iCloud.
- [ ] Notes save to the expected local folder.
- [ ] Uninstall removes the app without deleting user notes.

## Website Distribution

- [ ] Windows code signing certificate is purchased and configured.
- [ ] Installer and executable are signed.
- [ ] WebView2 is bundled with the offline installer and displayed to the user if it must install.
- [ ] Installer does not silently download WebView2 from a PowerShell custom action.
- [ ] Download page explains that transcription runs locally.
- [ ] Download page links to privacy policy, terms, support, and GitHub source.
- [ ] SHA-256 checksum is published beside the installer.
- [ ] A rollback installer for the previous stable release is retained.

## Microsoft Store Distribution

- [ ] Microsoft Partner Center developer account is active.
- [ ] Store app identity matches `com.candor.app`.
- [ ] Store package is built with `npm run build:store`.
- [ ] Store listing screenshots are current.
- [ ] Store description avoids unsupported claims.
- [ ] Privacy policy URL is live.
- [ ] Support URL or support email is live.
- [ ] Age rating and app category are complete.
- [ ] Release notes are written.

## Rollback Triggers

- Installer fails on a clean supported Windows machine.
- App opens but cannot create the local notes folder.
- Recording starts but cannot stop cleanly.
- Whisper model download fails without a recovery path.
- Calendar auth loops or stores unusable credentials.
- Users report lost transcript or note data.
