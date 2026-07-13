I have everything I need. Here is the analysis:

---

## Review of commit `7ffe10c`

### Q1 — Fail-closed at both gate points?

**Yes.**

`read_manifest` iterates candidates `[manifest.json, manifest.json.bak, manifest.json.tmp]` in order. At line ~2825, both `SCHEMA_TOO_NEW` and `SCHEMA_UNSUPPORTED` now trigger `return Err(error)` — an early return that exits the loop before the `.bak` candidate is ever attempted. The gate is in the first candidate tried, so `manifest.json.bak` is unreachable once a schema-0 primary is encountered.

`load_or_rebuild_manifest` (~2099–2110) now propagates both error codes without falling through to `manifest_from_chunks`. Both gates are closed.

### Q2 — Can schema-0 primary fall back to `.bak` or chunks in list/read/search/recover?

**No.**

- `read` (line 1140): calls `read_manifest` directly — early-returns `SCHEMA_UNSUPPORTED`, `.bak` is never tried.
- `list` and `search`: both call `collect_recording_manifests` → `load_or_rebuild_manifest` → `read_manifest`. The `SCHEMA_UNSUPPORTED` error exits `read_manifest` before `.bak`, then propagates through `load_or_rebuild_manifest` without falling to chunks.
- `recover` (line 1044): calls `load_or_rebuild_manifest` directly — same gate applies, no chunk rebuild.

All four public paths are covered.

### Q3 — Does the test prove byte-for-byte immutability?

**Yes.**

The test captures `unsupported_bytes` from the serialized schema-0 manifest, then performs two assertions:

1. After `list`: `assert_eq!(fs::read(&manifest_path)?, unsupported_bytes)` — primary is unchanged.
2. After `recover`: `assert_eq!(fs::read(&manifest_path)?, unsupported_bytes)` — primary is still unchanged.

Both are exact byte-slice comparisons. The `.bak` file's post-recovery bytes are not explicitly asserted, but because the fix prevents `.bak` from ever being read or written in this path, the omission is not material.

### Q4 — Regression for supported corrupt manifests?

**No.**

In `read_manifest`, non-schema errors (parse failures, I/O errors) store into `last_error` and continue iterating to `.bak` and `.tmp` — unchanged from pre-fix behavior. In `load_or_rebuild_manifest`, the `Err(_)` wildcard arm still falls through to `manifest_from_chunks` for any error that is not one of the two quarantine codes. Supported manifests with corruption remain fully eligible for `.bak` fallback and chunk rebuild.

---

## Verdict: **GO**
