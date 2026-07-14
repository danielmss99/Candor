I have enough to form well-grounded opinions. Let me now write the plan.

---

# SPEC-4 Independent Review: Whisper Quality Tiers and Local LLM

## What I verified from the code (not the spec)

Before any plan, here is what the baseline actually contains versus what the spec assumes.

| Claim | Evidence | Honest status |
|---|---|---|
| `small.en` and `small` SHA-256 trusted | `model_manager.rs:32–51` — both digests compiled in | **True** |
| `large-v3-turbo` and `large-v3` SHA-256 trusted | `model_manager.rs:56–63` | **True** |
| Persistent tier preference (`fast`/`balanced`/`maximum`) | Not in any file | **Missing** |
| Hardware capability snapshot | Not in any file | **Missing** |
| Terminology dictionary | Not in any file | **Missing** |
| Pharmaceutical high-risk safeguards | Not in any file | **Missing** |
| Strict JSON result schema for instruct output | Not in any file; current grounding is Markdown post-processing | **Missing** |
| Qwen3-4B-Instruct-2507 selected or digested | `model-lock.json:language.candidates = []` | **Absent** |
| llama.cpp b9637 packaged | `runtime-lock.json: selectionStatus = "candidate-not-packaged"` | **Absent** |
| `large` and `medium` model entries in `model-lock.json` | File has only `base.en`, `base`, `small.en` | **Absent from lock** |
| Bundle `releaseReady: true` | `manifest.json: releaseReady: false` | **Correctly blocked** |
| Source-controlled test for mutation / pharmaceutical | Not found | **Missing** |

The grounding function at `local_instruct_model.rs:1215` works today for general text but has no special handling for numerals, units, drug names, or dates. The citation schema is Markdown brackets, not a typed structure.

---

## 1. Refined Phase-by-Phase Plan

### Phase A — Persistent transcription quality policy (no assets required)

**Goal:** A small, core-owned record that maps `fast | balanced | maximum` to a resolved `model_id` and persists the user's choice. This should not touch `main.rs` dispatch logic.

**Proposed structure:** A new file `crates/candor-core/src/transcription_quality.rs` that owns:

```
TranscriptionTier: fast | balanced | maximum
TierPolicy: { tier, language_preference, resolved_model_id, guard_reason? }
```

The policy is serialized into the recording store's config directory (alongside vault state), loaded once at startup, and written on explicit user change. The Electron layer calls a new `transcription.quality.get` / `transcription.quality.set` operation.

**Tier-to-model mapping** (deterministic, no benchmark needed yet):

| Tier | English preset | Multilingual preset | Guard |
|---|---|---|---|
| `fast` | `small.en` | `small` | none |
| `balanced` | `large-v3-turbo` | `large-v3-turbo` | RAM ≥ 8 GB **required** |
| `maximum` | `large-v3` | `large-v3` | RAM ≥ 16 GB + explicit user acknowledgement |

The `resolve` function in `TranscriptionTier` consults the policy and hardware snapshot, then returns either the resolved model ID or a `GuardReason`. This keeps `transcription_service.rs:run_local_inner` simple: it calls `resolve()` instead of `model_manager.resolve_model_id()`.

**Answer to Q1:** The minimum safe architecture is one new `transcription_quality.rs` module, a read/write persist pair on the existing config path, and two new IPC operations. `main.rs` gets zero new routing logic — it delegates to the module exactly as it delegates to `TranscriptionService` today.

---

### Phase B — Hardware capability snapshot (deterministic guards, no invented numbers)

**Goal:** A `HardwareCapabilitySnapshot` that can be collected once on launch and consulted by the tier resolver.

**What can be deterministic now:**

- RAM total via `sysinfo` crate (already used in memory budget path): compare against 8 GB and 16 GB thresholds.
- CPU core count: already available as `std::thread::available_parallelism()`.
- Apple Silicon detection: `cfg!(target_os = "macos") && cfg!(target_arch = "aarch64")` — safe guard for ANE acceleration eligibility.

**What must remain `benchmark-pending`:**

- Actual words-per-second throughput — cannot be known without a real model on real hardware.
- VRAM detection — not universally available without a GPU-specific crate, and `large-v3-turbo` VRAM requirements differ per GPU.
- Thermal throttle behaviour.

The snapshot exposes only these fields to the renderer: `{ ramTotalGb, cpuCores, likelyAppleSilicon, tier_guard_reasons: [] }`. No "estimated speed" or "estimated time" is emitted. The renderer shows "This device meets the requirement" or the guard reason — not an invented number.

**Answer to Q2:** The only safe deterministic guard now is RAM threshold. Everything else is `benchmark-pending` and must say so explicitly in the capability response.

---

### Phase C — Tier resolution integrated into transcription flow

**Change:** `TranscriptionRunLocalParams` grows an optional `tier: Option<String>` field. When `tier` is set and `model_id` is not, the service resolves via the persisted policy. When `model_id` is set directly, it is treated as an advanced override and the bundle model path is used as before.

No user-visible model picker before recording — the tier was already set in Settings. The `model_id` override path is hidden under Advanced Diagnostics in the Electron layer.

**English vs. multilingual (Answer to Q3):**

The policy stores a `language_preference` field. Its default is `english` unless the user explicitly changes it in Settings. Tier resolution consults the field: if `language_preference == "english"` and the `fast` tier is selected, `small.en` is used; if `language_preference == "multilingual"`, `small` is used. **A tier change does not alter the user's language preference.** A model change via the `model_id` advanced override never silently resets the language preference either. The stored tier and stored language are separate fields.

---

### Phase D — Terminology dictionary (bounded, validated)

**Goal:** A `terminology_dictionary.rs` that stores user-supplied terms, validates them, selects relevant terms for a given transcript, and records correction approvals.

**What is safe to implement:**

- Bounded store: max 200 terms, max 60 bytes per term, ASCII/Latin-1 + common punctuation only.
- Validation: reject terms that are purely numeric, empty, or exceed the byte limit.
- Relevant-term selection for a transcript: substring/token match against the transcript text, returning the N most relevant terms to include in the Whisper `initial_prompt`.
- Approval history: a JSON log keyed by `(recording_id, original_term, proposed_term)` with an accepted/rejected flag.

**Answer to Q4 — pharmaceutical correction rules:**

The following rules are safe to implement in the source layer because they are structural, not knowledge-based:

1. **No silent correction**: A proposed correction for a drug name, dosage value, concentration, or unit must be presented to the user for explicit approval before it is committed.
2. **Numeric integrity**: The correction service must never modify a standalone number (e.g., `200`) or a number-unit pair (e.g., `200mg`, `0.9%`) without flagging it as high-risk and requiring approval.
3. **Owner attribution**: Correction proposals must always attribute the suggested term to the transcript segment that motivated it (`citation_id`), not to the dictionary term alone.
4. **Conservative match**: A match score below a configurable threshold (default: 0.8 exact-character overlap) produces no automatic proposal — only a flag for human review.
5. **Rejected terms are not re-proposed**: The approval history prevents re-surfacing a rejected correction in the same recording.

What is **not safe** to implement: any logic that assumes knowledge of what a drug name _should_ be corrected to. The dictionary is the user's responsibility; the code only enforces the rules above.

---

### Phase E — Structured instruct output schema (Answer to Q5)

The current Markdown citation post-processor at `local_instruct_model.rs:1215` is not sufficient for pharmaceutical-grade safety, but introducing a strict JSON result schema is a larger change than needed for the other phases.

The pragmatic path is a two-level approach:

1. **Now (SPEC-4):** Add typed `StructuredInstructResult` with these validated fields:
   ```
   { mode, answer?, recapSections: [{heading, bullets: [{text, citationId}]}], unsupported_claims_removed, citations }
   ```
   This is constructed by the existing `ground_model_output` function — the grounding logic stays unchanged but its output is re-serialized into the typed structure instead of raw Markdown. The Electron operation result schema is updated to match.

2. **Post-SPEC-4:** The model output parser can be tightened to handle edge cases found in practice.

**Risk of not doing this now:** The renderer currently receives `recapMarkdown: string` and must parse it to display. This creates a path where the renderer could display an unsupported claim if the grounding ever misses it. Moving to structured output eliminates that path. This is a **required change**, not optional.

---

### Phase F — Electron operations and Settings UI

**New renderer-scoped operations (required):**

```
transcription.quality.get  → { tier, languagePreference, resolvedModelId, guardReason?, hardwareCapability }
transcription.quality.set  → { tier } → { tier, resolvedModelId, guardReason? }
transcription.quality.estimate → { tier } → { available, guardReason?, hardwareCapability }
```

**Settings UI changes:**

- Add a Quality panel with three labelled options: `Fast`, `Balanced` (default indicator when hardware permits), `Maximum`.
- Each option shows a user-readable description, not a model filename.
- The guard reason is shown as an inline note if the hardware does not meet the requirement.
- Raw model IDs and SHA-256 digests appear only in Advanced Diagnostics (existing `diagnosticPreview` path).
- No model picker before or during recording.

**The `model_id` override path:** Remains in Advanced Diagnostics, gated by `advancedOpen`. The `TranscriptionRunLocalParams.model_id` field is preserved for developer use but is not exposed as a normal UI affordance.

---

### Phase G — Bundle manifest, locks, SBOM, and verifier

**What can be done in source without assets:**

- Add `small`, `large-v3-turbo`, `large-v3` as candidates to `model-lock.json`'s `speech.candidates` array with their trusted SHA-256 values (already compiled into `model_manager.rs` — copy them into the lock).
- Add Qwen3-4B-Instruct-2507 Q4_K_M as a candidate to `model-lock.json`'s `language.candidates` with a `REPLACE` placeholder SHA-256 and `selectionStatus: "blocked-license-provenance-and-benchmark-review"`.
- Add llama.cpp b9637 candidate entry to `runtime-lock.json` with the known commit hash (already in the file) but `selectionStatus: "candidate-not-packaged"`.
- Extend `spec3-verify-ai-bundle.mjs` to validate that the `balanced` and `maximum` tier models appear in `speech.candidates` when `releaseReady` is true. The verifier should fail if `selectionStatus` is `REPLACE` on a `releaseReady` bundle.
- **Do not set `releaseReady: true`** in `manifest.json`. The bundle cannot be release-ready until the assets, licenses, model cards, and signatures exist.

**Complete and Complete Max packages (Answer to Q6):**

The package tier names can be defined in source (e.g., an enum or a documented constant set). The source can state that `Complete` includes the `balanced` default speech model and the Qwen LLM, and `Complete Max` includes `maximum` speech. But the package cannot be represented as ready, and the installer cannot be tested, until the actual binaries and signed installers exist. Source-controlled code should express the schema — not the claim of readiness.

---

### Phase H — Pharmaceutical fixture tests and mutation proofs

**Required tests (can be written now, without real models):**

1. `terminology_dictionary_rejects_purely_numeric_term` — Passing `"200"` alone returns an error.
2. `terminology_high_risk_flags_dosage_pair` — A proposed correction of `200mg → 250mg` must not pass without an approval record.
3. `instruct_output_without_citation_is_removed` — A claim with no grounding segment match is not in `StructuredInstructResult`.
4. `pharmaceutical_correction_rejected_term_not_reproposed` — After rejection, the same pair does not appear in the next proposal set.
5. Mutation test: `ground_model_output` with an owner invented from thin air (no speaker in transcript) → removed.
6. Mutation test: Structured output for a recap with zero citations → `citationsVerifiedFromOutput: false` and the output is not presented as trusted.

---

## 2. Required vs. Optional

### Required (the spec cannot be honestly called complete without these)

- Persistent tier policy module with `fast / balanced / maximum` only (Phase A)
- Hardware capability snapshot with RAM guard (Phase B)
- Tier resolution in `run_local_inner` (Phase C)
- Pharmaceutical correction approval guard (Phase D rules 1–5)
- Structured instruct result type (Phase E — currently a security gap)
- Three new typed Electron operations (Phase F)
- Settings Quality panel with tier labels (Phase F)
- Update `model-lock.json` speech candidates to include the missing models (Phase G)
- Mutation and pharmaceutical fixture tests (Phase H)
- Verifier extension for bundle completeness (Phase G)

### Optional improvements (scope reduction acceptable)

- Automated `sysinfo` RAM detection (can start with a hardcoded conservative guard that always shows the requirement reason, forcing the user to choose Maximum explicitly)
- Approval history persistence (can start in-memory per session; persistence is a follow-on)
- Multilingual language preference selector in UI (can default to `english` with a toggle)

---

## 3. Assumptions and Unresolved Questions

| # | Question | Current honest answer |
|---|---|---|
| 1 | What SHA-256 does Qwen3-4B-Instruct-2507 Q4_K_M produce? | Unknown — model not in handoff. Lock must remain `REPLACE`. |
| 2 | What SHA-256 does llama.cpp b9637 produce per platform/arch? | Unknown — binary not in handoff. Lock must remain `candidate-not-packaged`. |
| 3 | Is Qwen3 redistribution approved under its license? | Not confirmed in any supplied file. `redistributionApproved` must remain `false` in the manifest. |
| 4 | What is the actual RAM usage of `large-v3-turbo` on the target platforms? | Not measured. The 8 GB guard is conservative and safe as a floor, not a claim. |
| 5 | Does the user's language field map to a Whisper language code 1:1? | Approximately. The `normalize_language()` function already validates the tag format. No new mapping is needed for SPEC-4 scope. |
| 6 | Is there an existing config path for storing the quality policy? | The `RecordingStore` exposes a `models_root_for_core()` path. A sibling `config_root_for_core()` or equivalent needs either to exist or to be added. Verify before implementation. |

---

## 4. Failure Modes, Security Concerns, and Data-Loss Risks

### Failure modes

- **Tier guard race:** User sets `maximum` tier on 16 GB RAM, upgrades hardware snapshot before a recording starts, then the guard passes but the model file is not yet in the bundle. Mitigation: the model verification step in `verified_model_path()` already gates on file existence and hash. The guard is advisory; the hash check is enforcement.
- **Language preference drift:** If a user switches from `balanced` (multilingual) to `fast` and the language preference is inadvertently reset to `english`, they will silently get `small.en` instead of `small`. Mitigation: store tier and language as separate fields and never mutate language on tier change.
- **Correction loop:** A terminology correction that is proposed, rejected, then re-matched triggers user fatigue and potentially incorrect approvals. Mitigation: Phase D rule 5 (rejection memory).
- **Structured output truncation:** If the model generates a very long recap, the existing `MAX_OUTPUT_BYTES` limit truncates the raw output before the structured converter runs. A truncated structured output could have broken bullets. Mitigation: validate that every bullet has a citation before including it in the output.

### Security concerns

- **Terminology dict as prompt injection:** Dictionary terms are inserted into the Whisper `initial_prompt`. A user could craft a term that changes Whisper's transcription behaviour (e.g., forcing hallucination). Mitigation: the initial prompt is already size-limited to 1,000 bytes in `normalize_initial_prompt()`. Dictionary terms selected for a session must be drawn from that budget and truncated if the combined length would exceed it.
- **Approval history as PII log:** The correction approval history contains pairs of (original_text, proposed_text) derived from transcript content. This violates the "no user content in logs" constraint if persisted to disk in plaintext. Mitigation: the approval history must be stored in the vault (encrypted) or session-only. Do not write it to a debug log.
- **Guard bypass via `model_id` advanced override:** An advanced user can bypass the hardware guard by specifying `model_id` directly. This is acceptable if: (a) it is gated behind `advancedOpen`, and (b) the user sees an explicit "not recommended for this hardware" warning in the UI before the field is accessible.

### Data-loss risks

- **Tier policy file corruption:** If the policy file is partially written during a crash, the next launch reads a malformed file. Mitigation: write to a `.tmp` file and atomically rename — same pattern already used by `write_import_manifest()` and `write_model_verify_cache()`.
- **Correction approval record lost on crash:** If the approval is accepted but not persisted before a crash, the same proposal re-appears next session. This is a nuisance, not a data-loss risk. Mitigation: flush approval records synchronously before returning the approval response.

---

## 5. Focused Tests and Acceptance Checks

### Rust tests (can be written now)

```
transcription_quality_fast_tier_selects_small_en_for_english_preference
transcription_quality_fast_tier_selects_small_for_multilingual_preference
transcription_quality_balanced_tier_blocked_below_8gb_ram
transcription_quality_maximum_tier_blocked_without_acknowledgement
transcription_quality_tier_change_does_not_alter_language_preference
transcription_quality_policy_survives_round_trip_serialization
transcription_quality_corrupt_policy_file_falls_back_to_defaults
terminology_dict_rejects_purely_numeric_term
terminology_dict_rejects_term_exceeding_byte_limit
terminology_dict_relevant_term_selection_respects_prompt_budget
pharmaceutical_correction_numeric_pair_requires_approval
pharmaceutical_correction_rejected_term_not_reproposed_same_session
instruct_structured_output_excludes_uncited_bullets
instruct_structured_output_truncated_output_has_no_partial_bullets
```

### Electron/renderer tests

```
quality_get_returns_tier_label_not_model_id
quality_set_balanced_with_guard_returns_guard_reason
settings_quality_panel_does_not_show_raw_model_id
advanced_diagnostics_shows_raw_model_id_only_when_advancedOpen
```

### Acceptance checks that must remain blocked after source implementation

1. `releaseReady` cannot be set to `true` in `manifest.json` until real model files, license files, and model cards are present and the verifier passes on them.
2. The Qwen SHA-256 in `model-lock.json` must remain `REPLACE` until the model is available and its digest is measured.
3. "Estimated transcription time" or "estimated speed" must not appear in any UI component — these require measured benchmarks on real hardware.
4. The Complete and Complete Max installer cannot be claimed as tested until a signed installer exists and a clean-install test is documented.
5. The pharmaceutical correction test set must include at least one fixture with a measured real-world drug name (not just `"200mg"`) before the feature is marked release-ready. This requires domain input that is not in the current handoff.

---

## 6. Scope Reductions and Sequencing Corrections

### Recommended scope reductions

**Remove from SPEC-4 scope, defer to SPEC-5:**
- Measured throughput estimates — requires hardware lab time that is not unblocked yet.
- VRAM detection — adds a GPU-specific dependency that has not been reviewed.
- Approval history persistence to vault — adds vault schema migration risk; session-only approval memory is sufficient for safety in SPEC-4.
- Multilingual language preference UI toggle — the default English path works and the multilingual path can be added once it is tested on real models.

**Remove entirely (not honest to implement):**
- Any claim about "Complete" or "Complete Max" being installable or working. The package tier names can exist in source as documentation, but no code should claim the product works in those tiers while the assets are absent.

### Sequencing correction

The spec proposes introducing the terminology dictionary (item 4) before the structured output schema (item 6). This is backwards. The dictionary feeds into Whisper's `initial_prompt`, but the pharmacuitical correction safety rules depend on the structured citation output to attribute proposals to transcript segments. **Phase E (structured output) must precede Phase D (pharmaceutical correction rules).** Otherwise, correction proposals have no reliable citation to attach to.

Revised sequence: A → B → C → E → D → F → G → H.

---

## Summary

**Six items cannot be honestly completed from the current inputs:**

1. Qwen3 model SHA-256 — model absent from handoff.
2. llama.cpp b9637 platform binaries — not packaged.
3. Redistribution approval for Qwen3 — not documented in handoff.
4. Measured benchmark evidence for any tier — no hardware test data supplied.
5. Signed installer or clean-install evidence — does not exist.
6. Pharmaceutical correction fixture with real drug names — requires domain knowledge not in the handoff.

**Everything else in the proposed scope is implementable from source alone**, provided the sequencing correction (E before D) is followed and the approval history is kept session-only for SPEC-4.
