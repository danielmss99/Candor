## Review Findings

**No Critical or High findings.**

---

### Medium

**M1 — `installNotices` fetches license files without SHA-256 pinning**
`scripts/install-development-ai-bundle.mjs`, `installNotices()`

The function downloads five notice files (license texts, model cards) with only HTTPS-enforcement and a 2 MiB size guard — no expected hash is recorded in any lock file and none is verified. The intent explicitly says the installer must enforce SHA-256. A CDN cache-poisoning attack or a compromised raw.githubusercontent.com CDN edge could substitute arbitrary content. The files are referenced in each manifest asset's `licenseFile` field, so a substituted file would make the bundle appear licensed under different terms than the actual release.

A content hash for each notice should be stored in `runtime-lock.json` / `model-lock.json` (or a dedicated notice-lock), and `installNotices` should call `verifyFile` for each.

---

### Low

**L1 — Post-promotion backup is deleted before the final verifier call**
`scripts/install-development-ai-bundle.mjs`, `promoteBundle` + call-site lines

`promoteBundle` atomically renames staging → destination and then immediately `rmSync`s the backup. The caller then invokes `runVerifier(bundleRoot, false, true)`. If that post-promotion verifier fails, the old bundle backup is already gone and there is no rollback path. The pre-promotion verifier mitigates this in practice, but a filesystem inconsistency (e.g. partial rename on a network drive) could leave the destination in a state that only the post-promotion check would catch, with no recovery.

Fix: keep the backup until after `runVerifier(bundleRoot, false, true)` succeeds, deleting it only inside the call-site `try` block after all verifiers pass.

---

**L2 — `whisper.cpp-LICENSE.txt` notice URL uses a mutable tag, not a commit hash**
`scripts/install-development-ai-bundle.mjs`, `installNotices()`, line with `"v1.8.3"`

```js
["whisper.cpp-LICENSE.txt", "https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.8.3/LICENSE"],
```

The whisper model lock records a specific 40-character commit (`candidate.revision`), but the notice is fetched by a mutable tag. Tags can be force-pushed or deleted. The llama.cpp notice correctly uses `languageRuntime.commit`. The whisper notice should use `speechCandidates.find(…).revision` for consistency with the rest of the installer's immutable-revision contract.

---

**L3 — `sha256File` reads each extracted DLL fully into memory**
`scripts/install-development-ai-bundle.mjs`, `sha256File()`

```js
const descriptor = readFileSync(filePath);
digest.update(descriptor);
```

`acquireVerifiedFile` and `verifyFile` use a streaming pipeline. `sha256File` loads the entire file into a `Buffer`. For a b9637 Windows archive (16.9 MiB compressed), the extracted DLLs are manageable, but the pattern is inconsistent and would silently regress if a future locked version contains larger runtime libraries. Replace with a streaming `createReadStream` loop identical to the one in `verifyFile`.

---

**L4 — `u64::MAX` fallback in `duration_ms` would break JavaScript schema validation**
`crates/candor-core/src/capture_service.rs`, `active_session_status()` ~line 96

```rust
let duration_ms =
    u64::try_from(now_ms().saturating_sub(session.started_at_ms)).unwrap_or(u64::MAX);
```

If `now_ms()` returns a signed type and the conversion fails, `duration_ms` becomes `u64::MAX` (`18446744073709551615`). Serialized to JSON, that value exceeds `Number.MAX_SAFE_INTEGER` and fails the JavaScript schema's `Number.isSafeInteger(value.durationMs)` check, causing the schema to reject the entire status object. The `try_from` from a `u64` is infallible, so this is dead code today, but the fallback should be `0` (or `u64::MAX` should be capped to a safe sentinel) rather than silently producing an unrepresentable value.

---

**L5 — `lucide-react` added to production `dependencies` with no visible usage in the patch**
`package.json`

`"lucide-react": "^1.24.0"` is added to `dependencies` (not `devDependencies`). No import of `lucide-react` appears in any file touched by this patch. If the usage exists only in pre-existing unmodified files it may be correct placement, but the dependency should be confirmed as actually imported in production code and not a stale addition from an earlier feature.
