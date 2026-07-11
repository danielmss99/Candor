# M5 V2 Import Proof

## Purpose

This proof covers the first local import lane for Candor v3. It imports Candor
v2 Markdown notes with simple frontmatter, transcript blocks, and PCM WAV audio
referenced by `audio_path`.

The renderer never supplies or receives raw source paths. Electron main owns the
native folder picker and passes the selected folder to the Rust core. The Rust
core parses and copies supported content into the v3 durable local store. Source
Markdown and audio files are read only and left untouched.

## Command

```powershell
npm run m5:v2-import-smoke
```

The full M5 proof runs it too:

```powershell
npm run m5:verify
```

## Expected Result

The smoke script starts `candor-core` over stdio JSON-RPC with isolated source
and destination folders, then verifies:

- `import.v2.status` reports native picker import, local-only behavior, and no
  renderer raw path access
- `import.v2.fromFolder` imports a synthetic v2 Markdown file and its PCM WAV
  audio into the durable store
- `import.v2.proofSynthetic` exercises the same importer from a core-created
  fixture
- each imported recording reports `vaultIndex` facts from the Rust vault layer
- source Markdown remains byte-for-byte unchanged
- imported recordings appear in the local library
- no response leaks the source folder, data root, raw paths, or key material

Passing output:

```text
M5 v2 import smoke passed.
```

## Boundary

Implemented:

- `import.v2.status`
- main-private `import.v2.fromFolder`
- core-only `import.v2.proofSynthetic`
- renderer-safe `v2ImportFromFolder()` through a native Electron folder picker
- Markdown frontmatter title import
- transcript segment import from `# Transcript`
- notes import from `# My notes`
- PCM WAV audio import from relative `audio_path`
- SQLCipher recording index handoff through the existing vault boundary

Still pending:

- richer v2 metadata mapping into SQLCipher tables
- non-PCM audio transcode
- duplicate detection and merge UI
- importer progress events for large folders
