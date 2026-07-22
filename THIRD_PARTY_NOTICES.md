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
- Symphonia 0.6.0, Mozilla Public License 2.0, used as an unmodified pure-Rust
  demuxer and decoder for bounded local MP3, AAC-LC, ALAC, and Vorbis media
  import. WebM Opus is intentionally not enabled. The corresponding source is
  available at https://github.com/pdeljanov/Symphonia/tree/v0.6.0. The full
  license text is bundled at `licenses/MPL-2.0.txt`.
- whisper-rs and whisper.cpp, MIT
- NVIDIA Parakeet TDT 0.6B V3 by NVIDIA, licensed under CC BY 4.0. Candor
  downloads the pinned, unmodified INT8 sherpa-onnx conversion on explicit user
  request from
  https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models. The original
  model card is at https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3. Candor
  does not modify the model weights. The full license text is bundled at
  `licenses/CC-BY-4.0.txt`.
- sherpa-onnx 1.13.4, Apache-2.0, provides Candor's statically linked Windows
  x64 CPU runtime for Parakeet. Source is available at
  https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.4.
- ONNX Runtime, MIT, is included by the pinned sherpa-onnx static runtime.
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

## Local Automation Companions

- `candorctl` and `candor-mcp`, Candor components under the project MIT license
- getrandom, MIT or Apache-2.0
- serde and serde_json, Apache-2.0 or MIT
- time, Apache-2.0 or MIT

## Fonts

- Inter, SIL Open Font License 1.1
- JetBrains Mono, SIL Open Font License 1.1
- Space Grotesk, SIL Open Font License 1.1
- Noto Sans report font, SIL Open Font License 1.1; the bundled license is at
  `crates/candor-core/assets/fonts/OFL.txt`

Review `package-lock.json`, `crates/candor-core/Cargo.lock`,
`crates/candor-tools/Cargo.lock`, bundled license files, imported model
licenses, and generated dependency audit output before every public release.
