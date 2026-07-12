# M4 Instruct Asset Manager Proof

Status: **implemented managed local import boundary; real production model proof pending**

## Purpose

Candor imports a user-selected llama.cpp runner and GGUF model into a
core-managed local asset directory. The renderer never supplies or receives a
raw filesystem path.

## Command

```powershell
npm run m4:instruct-asset-manager-smoke
```

## Verified Contract

- imports are manual and use an Electron-owned native file picker
- every import requires an expected SHA-256 hash
- the Rust core verifies the hash before committing the managed asset
- runner and model formats are validated separately
- status reports byte size, verification state, and hash without a managed path
- background downloads, network attempts, and cloud AI remain disabled
- malformed, wrong-hash, and wrong-format inputs fail closed
- the renderer bridge exposes only status and the high-level picker action

## Evidence

```text
release-v3/proofs/m4-instruct-asset-manager-win32-x64.json
```

This proof does not claim successful inference from a production GGUF model.
That remains gated by the strict real-model proof and a user-supplied,
hash-verified llama.cpp runner and model.
