# Third-Party Notices

Candor includes or downloads the following third-party components.

## Runtime and application framework

- Tauri, MIT or Apache-2.0
- Electron, MIT
- React, MIT
- Three.js, MIT
- Vite, MIT

## Audio and transcription

- whisper.cpp and whisper-rs, MIT
- OpenAI Whisper model weights converted for whisper.cpp, MIT
- CPAL, Apache-2.0 or MIT
- ScreenCaptureKit-rs, MIT or Apache-2.0
- apple-cf, MIT or Apache-2.0
- Hound, Apache-2.0 or MIT
- Symphonia, MPL-2.0

## Fonts

- Space Grotesk, SIL Open Font License 1.1
- JetBrains Mono, SIL Open Font License 1.1
- Inter, SIL Open Font License 1.1
- Noto Sans, SIL Open Font License 1.1. The bundled report-font license is at
  `crates/candor-core/assets/fonts/OFL.txt`.

## Local storage and document export

- SQLCipher, BSD-style license
- rusqlite, MIT
- Krilla, MIT or Apache-2.0
- quick-xml, MIT
- rustybuzz, MIT
- zip, MIT
- lopdf, MIT (test-only validation of generated PDF files)
- pulldown-cmark, MIT
- chacha20poly1305, Apache-2.0 or MIT
- time, Apache-2.0 or MIT

## Calendar and utility libraries

- chrono and chrono-tz, Apache-2.0 or MIT
- ureq, Apache-2.0 or MIT
- roxmltree, MIT or Apache-2.0
- base64, MIT or Apache-2.0
- uuid, Apache-2.0 or MIT
- sha2, MIT or Apache-2.0

Review `package-lock.json`, `src-tauri/Cargo.lock`, and
`crates/candor-core/Cargo.lock` before each public release for the complete
transitive dependency list.
