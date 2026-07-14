# Candor Bundled AI Asset Inventory

Updated: 2026-07-14

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
source-pinned benchmark candidates. The Standard profile contains multilingual
`small` for the low-resource tier and `large-v3-turbo` for Balanced. The
Maximum Accuracy profile adds `large-v3`. `small.en` remains a benchmark
candidate and is not assigned to either shipping profile. Their official
artifact sizes and SHA-256 values are recorded in `model-lock.json`, but no
model is selected for release. Selection still requires:

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

The official `Qwen3-4B-GGUF` Q4_K_M artifact is the primary release candidate.
Its upstream revision, exact byte count, and SHA-256 are pinned. The
`Qwen3-4B-Instruct-2507` Q4_K_M conversion remains a research candidate until a
reproducible conversion produces an exact artifact. No default instruction
model is selected. Candor will not package either until all of the following
are documented:

- exact upstream revision and original model license;
- redistribution and commercial-use review;
- quantization source, tool, command, and output digest;
- context length and RAM budget;
- recap factuality, action-item precision, and citation results;
- owner and due-date hallucination results.

The pinned official Qwen artifact is larger than GitHub's 2 GiB per-release
asset limit before it is combined with the Whisper models and application.
GitHub publication therefore remains blocked. A distribution format and host
for the offline installer is an explicit release-infrastructure decision.

## Standard and Maximum profiles

The Standard profile requires:

- Whisper multilingual `small`;
- Whisper `large-v3-turbo`;
- one release-selected official Qwen Q4_K_M artifact;
- the pinned llama.cpp runtime;
- one verified general dictionary;
- the Candor Ed25519 dictionary publisher public key.

The Maximum Accuracy profile contains the Standard profile plus Whisper
`large-v3`. Both profiles must remain fully offline after installation. No
runtime model downloader, Ollama dependency, localhost inference server, or
renderer-selected executable path is permitted.

## Dictionary trust assets

The general dictionary and Candor publisher public key are mandatory release
assets. The public key is not a private signing key. Private signing keys must
never enter Git or an application package. The strict bundle verifier rejects a
release profile that omits either the dictionary or its publisher key.

## Release rule

Only assets with an HTTPS source, immutable revision, non-zero SHA-256, exact
byte count, license file, model card where applicable, and explicit
`redistributionApproved: true` may enter a release-ready manifest. The strict
verifier also requires selected runtime revisions, model IDs, and model digests
to match these lock files. Fixtures and placeholder files can never satisfy the
release gate. Signing, clean-machine installation and upgrade, hardware
capture, long-duration recording, benchmark, license, and elevated
network-denial receipts remain external fail-closed gates.
