# M2 Model Manager Proof

## Purpose

This proof covers the pathless local model manager and user-initiated model import path needed before real local Whisper can be a release claim.

The Rust core now owns `models.*` commands. Renderer input is limited to allowlisted model ids. The renderer cannot pass raw model paths, URLs, arbitrary file handles, network endpoints, vault keys, or passphrases. Electron main owns the native file picker and streams the selected file to the core in bounded chunks.

## Command

```powershell
npm run m2:model-manager-smoke
```

The full M2 proof runs it too:

```powershell
npm run m2:verify
```

The real local Whisper proof also consumes this same import path:

```powershell
$env:CANDOR_M2_REAL_WHISPER_CONSENT="1"
npm run m2:real-whisper-proof
```

Input readiness can be checked first:

```powershell
npm run m2:real-whisper-inputs
```

## Expected Result

The smoke script starts `candor-core` over stdio JSON-RPC with an isolated `CANDOR_V3_DATA_DIR`, then verifies:

- `models.status` reports local-only custody, no cloud AI, no renderer model paths, manual install policy, and no background downloads
- `models.listLocal` starts empty in the isolated model store
- `models.verifyLocal` returns `MODEL_NOT_INSTALLED` for a missing allowlisted model
- invalid model ids are denied with `MODEL_ID_INVALID`
- `models.importStart`, `models.importChunk`, and `models.importFinish` create a pathless import session and reject fake model bytes before installation with `MODEL_HASH_MISMATCH`
- rejected imports do not leave an installed model behind
- `models.importAbort` cleans up a partial import
- `models.proofSynthetic` creates a fake local model file in the isolated model store and proves hash verification blocks it with `MODEL_HASH_MISMATCH`
- follow-up `models.listLocal` shows the fake model as installed but not verified
- no response leaks the data root, raw model path, or key material

Passing output:

```text
M2 model manager smoke passed.
```

## Runtime Boundary

Model files are resolved only under the core-owned local model store and use the `ggml-<model-id>.bin` naming convention. Verification uses SHA-256 pins copied from the v2 Whisper model allowlist, with compile-time environment overrides supported for release builds. Import staging files use core-generated import ids and are committed only after the staged file hash matches the trusted pin.

This does not implement user-initiated network model download yet. Downloads remain excluded from M2 and must later be explicit, manual, hash-verified, and represented in the network audit log. Local file import is available without background network traffic.

`npm run m2:real-whisper-proof` uses an operator-supplied local model path only
as the test harness input after explicit operator consent. The model still enters
Candor through `models.importStart`, bounded `models.importChunk` calls, and
`models.importFinish`. The resulting proof artifact records verified model id,
SHA-256, and bytes, but not the source path.

`npm run m2:real-whisper-inputs` reads the same allowlist and trusted hash pins
from `model_manager.rs` before the heavier proof runs. It records readiness or
missing-input failures without downloading anything.
