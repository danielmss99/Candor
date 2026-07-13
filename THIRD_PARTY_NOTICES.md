# Third-Party Notices

Candor uses the following major third-party components. Their transitive
dependencies and license files remain authoritative.

## Desktop And Interface

- Electron, MIT
- React and React DOM, MIT
- Vite, MIT
- Three.js, MIT
- React Three Fiber and Drei, MIT

## Audio And Local Models

- CPAL, Apache-2.0 or MIT
- whisper-rs and whisper.cpp, MIT
- ScreenCaptureKit Rust bindings, MIT or Apache-2.0
- User-imported Whisper and GGUF model files retain their original licenses and
  are not bundled merely by building Candor

## Storage, Cryptography, And Export

- SQLCipher, BSD-style license
- SQLite and rusqlite, public domain and MIT
- OpenSSL, Apache License 2.0
- chacha20poly1305, Apache-2.0 or MIT
- Krilla, MIT or Apache-2.0
- quick-xml, MIT
- rustybuzz, MIT
- zip, MIT
- pulldown-cmark, MIT
- base64, MIT or Apache-2.0
- serde and serde_json, Apache-2.0 or MIT
- sha2, Apache-2.0 or MIT
- time, Apache-2.0 or MIT
- lopdf, MIT, used for test validation

## Key Storage

- Windows Data Protection API, operating-system component
- macOS Keychain, operating-system component
- keyring and libsecret integrations, MIT or Apache-2.0 as applicable

## Fonts

- Inter, SIL Open Font License 1.1
- JetBrains Mono, SIL Open Font License 1.1
- Space Grotesk, SIL Open Font License 1.1
- Noto Sans report font, SIL Open Font License 1.1; the bundled license is at
  `crates/candor-core/assets/fonts/OFL.txt`

Review `package-lock.json`, `crates/candor-core/Cargo.lock`, bundled license
files, imported model licenses, and generated dependency audit output before
every public release.
