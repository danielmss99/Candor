# SPEC-4 Implementation Status

## Implemented in source

- Fast maps to Whisper `small.en` or multilingual `small`.
- Balanced maps to `large-v3-turbo`.
- Maximum accuracy maps to `large-v3`.
- Tier and language preferences persist in core-owned settings.
- A first passing automatic benchmark selects the measured recommendation only when the user has not made an explicit quality choice. Later benchmarks never override that choice.
- Balanced and Maximum remain unavailable until measured local benchmark evidence passes their guards.
- A cancellable, core-owned performance job measures a deterministic 30-second local Whisper workload and a fixed no-user-content Llama task. The renderer can select only Balanced or Maximum and cannot submit prompts, paths, hashes, or measurements.
- The first Balanced check starts automatically only after both bundled AI capabilities verify, no capture is active, and no prior benchmark job exists. Maximum accuracy can be checked from Settings after the memory guard passes.
- Benchmark evidence is written atomically and contains tier-specific verified model fingerprints internally. A model trust-anchor change invalidates the old pass and schedules a fresh check. Normal UI and job results expose no raw model names, hashes, or metrics. Settings receive only a rounded minutes-per-hour estimate for the active measured tier.
- No renderer field can supply a Whisper prompt or language override.
- Domain dictionaries import from TXT, CSV, or JSON through a native picker.
- Dictionary content and correction decisions are encrypted with the operating-system-backed Candor key.
- Relevant terms are selected automatically for Whisper context and local LLM glossary context.
- Pharmaceutical, dosage, numeric, owner, and date changes require exact transcript evidence and explicit user approval.
- Recap and Ask require strict versioned JSON, valid transcript source IDs, bounded output, and trusted-core rendering.
- Claims backed by multiple transcript sources preserve all contributing speakers and channels, while summary rendering cites only the sources used by the summary.
- Long transcripts are processed in bounded batches instead of silently truncating late evidence.
- Whisper jobs use the native abort callback, and llama.cpp jobs terminate through the bounded process watchdog when cancellation is requested.
- llama.cpp work uses a bounded, output-size-aware timeout so normal 4B-model jobs are not cut off after 45 seconds on average CPU hardware.
- llama.cpp prompt files use restrictive creation-time permissions; Windows grants access only to the creating owner and LocalSystem.
- The Rust core rejects hardware benchmark jobs while capture is active, independently of renderer controls.
- Electron exposes typed quality and terminology methods only. No generic IPC, filesystem, process, prompt, or model-path API was added.
- Renderer-facing transcription, recap, Ask, and export work uses one canonical asynchronous job path. Older direct operations remain private compatibility adapters for proof tooling.
- Job events are accepted only for known local work types and lifecycle states, with validated progress, timestamps, terminal consistency, error shape, and custody flags.
- Source-interface, Complete, and Complete Max package commands have distinct fail-closed gates.
- CI and developer packages identify as `Candor Source Interface` under a
  separate application ID. The production builder configuration is reachable
  only after the strict Complete or Complete Max manifest gate passes.

## Deliberately not claimed

The supplied handoff archive contained specifications only. It did not contain model weights, a llama.cpp executable, signatures, a redistributable speech fixture, or hardware evidence. Therefore this branch does not claim that a public Complete installer exists. The implemented deterministic workload validates the benchmark mechanism, but it is not a substitute for the real release hardware and quality matrix.

The following remain release blockers:

- Reproducible Qwen3-4B-Instruct-2507 Q4_K_M conversion with an exact artifact digest.
- Candor quality approval for the official Qwen3-4B Q4_K_M fallback.
- Packaged Whisper and Qwen assets with notices and redistribution review.
- A real bundled sample-audio and LLM benchmark on 8 GB, 16 GB, and 32 GB systems.
- Real microphone, system-audio, sleep/resume, device-switch, long-duration, and local-model quality evidence.
- Signed and timestamped Complete or Complete Max installers.
- Clean offline installation and upgrade proof.

Until those gates pass, `package:source-interface` is the honest development artifact and `release:complete` / `release:complete-max` must fail.
