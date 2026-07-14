## Review Report — SPEC-5 Dictionary, Electron, UI, Release Boundary

---

### Finding 1 — **Medium | Defect**
**Archive-bomb checks use ZIP-header sizes, not actual decompressed byte counts**
`crates/candor-core/src/dictionary_package.rs:215–250`

The three guards that bound decompressed output all consume `file.size()`, the value declared in the ZIP central-directory header:

- Per-file limit: line 222 `if file.size() > per_file_limit`
- Compression-ratio check: line 228 `file.size() / file.compressed_size().max(1)`
- Total-expansion accumulator: line 237 `total_expanded.saturating_add(file.size())`

`file.read_to_end` on line 245 then decompresses the actual Deflate stream, which is bounded only by the compressed input — not by any of the values above. The `zip` crate's decompressor does not cap output to the declared uncompressed size; it reads until the Deflate end-of-block marker, then validates CRC/size as a post-check. A crafted archive can set the central-directory `uncompressedSize` field to, say, 1 byte (passing all three guards) while the actual stream decompresses to several hundred MB from the 2.5 MB compressed-input budget, causing an OOM crash before the post-check error propagates.

**Failure scenario:** Attacker crafts a 2.5 MB `.candordict` with a highly-repetitive Deflate payload and central-directory uncompressed-size fields set near zero. All size checks pass; `read_to_end` grows a `Vec` to hundreds of MB; allocator kills the process.

**Fix:** Apply a hard read cap on the decompressor output and accumulate actual bytes read, not declared sizes:

```rust
let mut contents = Vec::new();
file.take(per_file_limit.saturating_add(1))
    .read_to_end(&mut contents)
    .map_err(|_| DictionaryPackageError::new("DICTIONARY_ARCHIVE_READ_FAILED", "…"))?;
if contents.len() > per_file_limit as usize {
    return Err(DictionaryPackageError::new("DICTIONARY_ARCHIVE_FILE_TOO_LARGE", "…"));
}
total_expanded = total_expanded.saturating_add(contents.len() as u64);
```

---

### Finding 2 — **Medium | Defect**
**`complete` profile does not reject an accidentally-included `large-v3` model**
`scripts/spec3-verify-ai-bundle.mjs:509–522` / `third_party/model-lock.json`

`verifyDecisionLocks` (lines 509–522) verifies that every model listed in `profile.speechModelIds` is present in the bundle — a MUST-include check. It performs no complementary MUST-NOT-include check for speech models that belong to a different profile.

`large-v3` (3.09 GB, `"maximum"` tier) is recorded with `"packageProfiles": ["complete-max"]` in model-lock.json but not in `"complete"`. If it is accidentally added to the bundle manifest under a `complete` build, `release:standard` finishes with no failures and publishes a ~3 GB Standard installer.

The model-lock.json candidates with `packageProfiles` provide exactly the per-candidate profile membership needed to write this check, but the verifier never reads that field.

**Fix:** After the inner `for (const modelId of profile.speechModelIds)` loop, add:

```js
for (const asset of hostAssets.filter(a => a.capability === "speech" && a.kind === "model")) {
  const candidate = modelLock.speech.candidates?.find(c => c.id === asset.modelId);
  if (candidate && !candidate.packageProfiles?.includes(manifest.packageProfile)) {
    failures.push(
      `speech model ${asset.modelId} is not approved for profile ${manifest.packageProfile}`
    );
  }
}
```

---

### Finding 3 — **Low | Defect**
**Package idempotency check ignores version — silent update rejection**
`crates/candor-core/src/terminology_dictionary.rs:464–487`

When a `.candordict` package is imported whose `package_id` already exists in the store (lines 464–487), the call returns `{imported: false, alreadyInstalled: true}` and includes the **old** version's metadata in the response. The version field is not compared.

A user who receives a corrected pharma dictionary (same `id`, new `version` with fixed drug names) will see the "already installed" response carrying the old version string. The UI has no way to distinguish this from a genuine no-op re-import; the user believes they are running the new version while the old, potentially incorrect, terms remain active.

**Fix:** Compare `existing.package_version` against `package.version`. When they differ, return a distinct response:
```rust
"alreadyInstalled": true,
"upgradeAvailable": true,
"installedVersion": existing.package_version,
"availableVersion": package_version_from_new_package,
```
and let the caller prompt the user to remove and re-import.

---

### Finding 4 — **Low | Defect**
**Per-job action buttons lack identifying `aria-label`**
`v3/renderer/src/features/jobs/BackgroundActivity.tsx:109–112`

When more than one job is visible, the rendered output contains multiple unlabeled "Cancel", "Retry", "Dismiss", and "Open meeting" buttons in sequence. Screen readers announce only the button text with no job context. Users relying on assistive technology cannot determine which job a button acts on, and cannot distinguish per-job "Cancel" from the header-level "Cancel all".

**Fix:**
```tsx
<button type="button" aria-label={`Cancel ${jobLabel(job)}`} onClick={() => onCancel(jobId)}>Cancel</button>
{canRetry ? <button type="button" className="primary" aria-label={`Retry ${jobLabel(job)}`} onClick={() => onRetry(jobId)}>Retry</button> : null}
{asBool(job.terminal) ? <button type="button" aria-label={`Dismiss ${jobLabel(job)}`} onClick={() => onDismiss(jobId)}>Dismiss</button> : null}
{recordingId ? <button type="button" aria-label={`Open meeting for ${jobLabel(job)}`} onClick={() => onOpenMeeting(recordingId)}>Open meeting</button> : null}
```
The header "Cancel all" button should also get `aria-label="Cancel all background jobs"`.

---

### No-finding areas

| Area | Assessment |
|---|---|
| ZIP path/traversal/symlink | Filename whitelist + `enclosed_name()` + `contains('/')` + Unix mode `0o120000` check collectively prevent all known bypasses. Duplicate detection via `HashMap::insert` is correct. |
| Publisher identity | `trust_label` is hardcoded `"community-unverified"` in `verify_candordict_base64`; the higher UI labels (`verified-candor-bundle`, `verified-organization`) are dead code with no import path. |
| Signature canonicalization | Domain separator + length-prefixed hashing in `signed_digest` is correctly structured. `eq_ignore_ascii_case` on hex strings is safe. |
| Content escaping / prompt injection | All error messages are static. `contains_model_control_text` catches role prefixes, `<|...|>`, and injection directives. `split_whitespace().join(" ")` followed by `is_control` removes embedded newlines before storing. |
| Pharmaceutical approval gate | `requiresApproval: true` and `autoApply: false` are hardcoded into every proposal's `public_value()`. `apply_accepted_corrections` only mutates a copy; the RecordingStore original is never touched. |
| Preload / IPC boundary | No raw paths reach the renderer (`path.basename` on all file responses). `validateDictionaryPackageInput` enforces exact two-key shape, basename-only filename, `.candordict` extension, and `Uint8Array` type. |
| Close guard state machine | `closeApproved`/`closeInProgress` interaction is sound. The `finally` reset is correct. |
| Release readiness gate | `release:standard` correctly fails with current model-lock.json (`selectionStatus: "benchmark-pending"`, `selectedModel: null` for both speech and language). `--require-ready` enforces `release-selected` status and a pinned SHA-256 for the selected language candidate before any publish proceeds. |
