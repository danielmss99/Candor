# Candor Bundled AI Asset Inventory

Updated: 2026-07-13

This inventory records candidates and release blockers. It is not a legal
approval. The machine-readable decisions live in `runtime-lock.json`,
`model-lock.json`, and `build/ai-bundle/manifest.json`.

## Current packaged state

The source package contains the manifest interface and notices directory only.
It does not contain a Whisper model, a llama.cpp executable, or an instruction
model. `releaseReady` remains false and the strict release verifier must fail.

## Speech runtime

Candor currently links Whisper through the Cargo-locked `whisper-rs 0.16.0` and
`whisper-rs-sys 0.15.0` crates. This means there is no renderer-selected or
separately spawned Whisper executable.

| Layer | Pin | License record | Release state |
| --- | --- | --- | --- |
| `whisper-rs` | 0.16.0 plus Cargo checksum | Unlicense | Locked in current build |
| `whisper-rs-sys` | 0.15.0 plus Cargo checksum | Unlicense | Locked in current build |
| Embedded `whisper.cpp` | 1.8.3 reported by the sys crate | MIT | Locked through the sys crate |

The complete runtime expression is `Unlicense AND MIT`. Release notices must
include both license texts.

## Speech models

`small.en`, multilingual `small`, `large-v3-turbo`, and `large-v3` are the
source-pinned benchmark candidates. The intended product mapping is Fast,
Balanced, and Maximum accuracy respectively. Their official artifact size and
SHA-256 values are recorded in `model-lock.json`, but no model is selected for
the release bundle. Selection still requires:

- authoritative source and model-card capture;
- redistribution review and complete notice text;
- 8 GB, 16 GB, and 32 GB performance measurements;
- meeting audio quality and word-error-rate evidence;
- installer-size approval.

## Language runtime

The llama.cpp candidate is pinned to tag `b9637`, commit
`aedb2a5e9ca3d4064148bbb919e0ddc0c1b70ab3`, under MIT. It is not packaged or
marked release-selected. A reproducible Windows x64 build and runtime tests are
still required.

## Instruction model

Qwen3-4B-Instruct-2507 is the primary source candidate. Its exact Q4_K_M
artifact remains intentionally undigested because no matching official GGUF was
available during inspection and the reproducible conversion has not run. The
official Qwen3-4B Q4_K_M artifact is pinned as a fallback candidate only. No
default instruction model is selected. Candor will not package either until all
of the following are documented:

- exact upstream revision and original model license;
- redistribution and commercial-use review;
- quantization source, tool, command, and output digest;
- context length and RAM budget;
- recap factuality, action-item precision, and citation results;
- owner and due-date hallucination results.

## Release rule

Only assets with an HTTPS source, immutable revision, non-zero SHA-256, exact
byte count, license file, model card where applicable, and explicit
`redistributionApproved: true` may enter a release-ready manifest. The strict
verifier also requires selected runtime revisions, model IDs, and model digests
to match these lock files. Fixtures and placeholder files can never satisfy the
release gate.
