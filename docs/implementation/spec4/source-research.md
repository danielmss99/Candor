# SPEC-4 Primary Source Research

Recorded on 2026-07-13. These records pin source metadata, not release approval.

## Whisper

Source repository: `https://huggingface.co/ggerganov/whisper.cpp`

- Repository revision: `5359861c739e955e79d9a303bcbc70fb988958b1`
- License metadata: MIT
- `ggml-small.en.bin`: 487,614,201 bytes, SHA-256 `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d`
- `ggml-small.bin`: 487,601,967 bytes, SHA-256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`
- `ggml-large-v3-turbo.bin`: 1,624,555,275 bytes, SHA-256 `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69`
- `ggml-large-v3.bin`: 3,095,033,483 bytes, SHA-256 `64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2`

The digests match the existing Candor compile-time trust anchors.

## Qwen primary source

Source repository: `https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507`

- Repository revision: `cdbee75f17c01a7cc42f958dc650907174af0554`
- License metadata: Apache-2.0
- Public and not gated at inspection time
- Official model card describes this variant as non-thinking
- No official Qwen Q4_K_M GGUF matching this exact Instruct-2507 source was supplied in the handoff

The reproducible conversion output digest remains unknown until the conversion is executed and reviewed. It is not selected for release.

## Qwen official fallback

Source repository: `https://huggingface.co/Qwen/Qwen3-4B-GGUF`

- Repository revision: `bc640142c66e1fdd12af0bd68f40445458f3869b`
- License metadata: Apache-2.0
- Public and not gated at inspection time
- `Qwen3-4B-Q4_K_M.gguf`: 2,497,280,256 bytes
- Artifact SHA-256: `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`

This is a candidate fallback only. Release selection remains blocked on Candor-specific quality, safety, and performance evaluation.

## llama.cpp

Source repository: `https://github.com/ggml-org/llama.cpp`

- Tag: `b9637`
- Commit: `aedb2a5e9ca3d4064148bbb919e0ddc0c1b70ab3`
- Release published: 2026-06-14
- Official release assets include CPU packages for Windows x64, macOS arm64/x64, and Ubuntu x64/arm64 with GitHub-provided SHA-256 digests

Runtime archives and their unpacked executable hashes must be verified before release packaging. No runtime executable was supplied in the handoff.

## Claim ceiling

Primary-source metadata proves identity and candidate provenance. It does not prove redistribution approval, Candor compatibility, model quality, packaged operation, signing, or clean offline installation.
