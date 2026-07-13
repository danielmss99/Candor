## SPEC-2 Architecture Review

---

### 1. Refined Implementation Sequence

The stated phases are mostly sound but have two sequencing hazards:

**Phase 3 (fixtures) must precede Phase 2 (registry), not follow it.** Writing fixtures first forces the registry contract to be testable from day one rather than retroactively.

**Phase 6 (capture degraded behavior) must precede Phase 7 (test-core hang mode).** You cannot write a reliable hang-during-capture test until the degraded-state machine is defined.

Revised order:

```
1 → 3 → 2 → 4 → 7 → 6 → 5 → 8 → 9 → 10 → 11
```

Rationale for 4 before 7/6: `rawCall()`/`call()` split is infrastructure that both capture degradation (6) and job transport (5) depend on. Establishing it before either prevents parallel refactors that touch the same socket boundary.

---

### 2. Required vs. Optional

**Required (correctness or security regressions without them):**
- Phase 2: Per-operation schema validation. `core-client.ts` currently lets callers bypass `ensureHandshake()` and sends unvalidated payloads. This is a trust-boundary hole.
- Phase 4: `rawCall()` isolation. Without it, handshake and ordinary operations share the same send path, making future timeout policy inconsistent.
- Phase 5: Durable jobs with renderer-reload recovery. Any synchronous transcription or recap call that spans a renderer reload silently loses state. This is a data-loss risk today.
- Phase 6: Explicit degraded-capture state machine. "Preserve last confirmed capture state" is load-bearing; without it, a socket drop during recording can leave the user with no stop mechanism and no recovery metadata.
- Phase 8: Preload API v2 with no generic command/filesystem/process access. The current preload exposes an unconstrained core API surface. This is the primary sandbox boundary.

**Optional (improvements, not correctness fixes):**
- Phase 10 screenshot matrix: useful regression signal, but CI images are inherently flaky and not a blocking gate.
- Phase 11 SBOM automation: correct to add, but generates no new safety for local users until distribution pipeline exists.
- Regrouped Advanced Settings (Phase 9): pure UX, no security or data-loss consequence.

---

### 3. Assumptions and Unresolved Questions

**Assumptions baked into the plan:**
- The JSONL socket is the only IPC channel. If any operation uses a second channel (e.g., direct file reads via `fs` in preload), Phase 8 scope is understated.
- The Rust core can be extended to emit structured progress events on the same socket. If it emits them on stderr or a separate pipe, job tracking in Phase 5 needs a different transport.
- "Renderer-reload recovery" implies job state persists in the Rust core, not the renderer. This needs explicit confirmation; nothing in the evidence proves it.

**Unresolved questions:**
- What is the socket lifecycle when the core crashes versus when the renderer reloads? These need separate handling in Phase 6, but the plan treats them as one scenario.
- Does `handshakePromise` resolve once per core process lifetime, or per socket connection? If per-lifetime, a core restart without renderer reload leaves `handshakePromise` resolved against a dead socket.
- How is v2 import handled if audio files are large? A synchronous import call risks a timeout on the main process IPC thread today, and Phase 5 must cover this explicitly.

---

### 4. Likely Failure Modes

**Correctness:**
- `handshakePromise` is shared but `call()` does not gate on it. A caller that sends before handshake completes will receive an RPC error that is not retriable by design. Callers need to await the gate or the registry must enforce it uniformly.
- Job cancellation that arrives while the Rust core is mid-write to the JSONL log could produce a truncated record. Cancellation must drain or discard atomically.

**Security:**
- Preload v1 names (`vaultStatus`, `aiAskHeuristic`, etc.) are implementation vocabulary. If v2 preload ships alongside v1 during the migration period, both surfaces are simultaneously exposed. The overlap window must be zero-day, not gradual.
- `contextIsolation` is listed as non-negotiable, but the plan does not describe how v2 preload IPC handlers are registered. If they share any handler registration path with the generic `core` API, the boundary narrows.

**Data loss:**
- Phase 5 jobs depend on terminal results being stored somewhere accessible after renderer reload. The plan does not name the store (Rust core memory, SQLite, file). Until named, recovery is an assertion, not a design.
- Package version `2.0.0` vs. description "Candor v3" creates a migration ambiguity. If any storage path is derived from the package version, changing either without migration loses recordings. This must be resolved in Phase 1 before any other phase touches identity.

**Cross-platform:**
- Windows path separators in log redaction patterns. If `complete paths` are scrubbed by regex, Windows paths with backslashes need explicit coverage.
- The `rawCall()` timeout must be wall-clock, not event-loop tick, or a hung Rust core on Windows (which does not receive SIGTERM) stalls the timeout indefinitely.

---

### 5. Tests and Acceptance Checks Per Phase

| Phase | Minimum acceptance check |
|-------|--------------------------|
| 1 | Gap ledger lists every current bypass of `ensureHandshake()` by file and line. |
| 3 | Fixture set covers: valid handshake, invalid version, missing op field, unknown op, malformed params. Both TS and Rust tests import the same JSON files. |
| 2 | Registry rejects any `call()` invocation whose params fail the schema with a typed error, not a generic RPC error. 100% of operations have entries. |
| 4 | Unit test: `rawCall()` sends before handshake; `call()` queues until handshake resolves. Test: core crash mid-handshake returns a recoverable error, not an unhandled promise rejection. |
| 7 | Test-core can be started in `hang-during-capture` mode via a flag. The hang is deterministic (not a sleep). |
| 6 | Integration test: socket drop during active capture → `capture-connection-degraded` fires → Stop button remains enabled → bounded reconnect attempts exactly N times → recovery metadata written to disk. No automatic core kill. |
| 5 | Job lifecycle test: start → progress events arrive → cancel → terminal result is `cancelled`, not `error`. Renderer reload mid-job → reconnect → job state recoverable from core. |
| 8 | Preload v2 surface: enumerate all exposed functions; assert none accept a free-form command string, a filesystem path, or a process identifier. |
| 9 | Renderer: no component imports a symbol from `core-client` or `protocol` directly. |
| 10 | Screenshot diff test fails if the main window changes size or a new modal appears on startup. |
| 11 | Checksum file is present and matches the built artifact hash. SBOM lists all production dependencies. Both are verified in CI, not just generated. |

---

### 6. Incremental Jobs and Preload v2 Introduction

**Jobs (Phase 5):** Introduce a `JobHandle` abstraction in `core-client.ts` that wraps a request ID and exposes `progress$`, `cancel()`, and `result`. Do not change the preload API yet. Wire existing synchronous callers to `JobHandle` internally while the preload still exposes the old synchronous-looking API. This limits renderer changes to Phase 9 and keeps Phase 5 isolated to the IPC layer.

**Preload v2 (Phase 8):** Add `window.candorV2` alongside `window.core`. Do not remove `window.core` until every renderer call site is migrated and verified. Track remaining v1 call sites with a grep fixture in CI that must reach zero before `window.core` is deleted. Deleting prematurely breaks the renderer; deleting too late extends the dual-surface window. The grep fixture makes the window explicit and automatable.

---

### 7. Release Claims That Must Remain Blocked

The following cannot be marked complete from local development evidence alone:

- **Code signing validity** — requires a signing certificate issued to the correct identity, a signed artifact, and Gatekeeper/SmartScreen acceptance on a machine that has never seen the unsigned build.
- **Clean-machine upgrade** — requires an installed prior version on a machine with no development toolchain, followed by an update that preserves all recordings and settings.
- **Hardware audio validation** — requires a physical microphone and speaker on at least one non-development machine per platform.
- **Privacy claims** ("audio never leaves device", "transcription is local-only") — require network capture evidence on a machine with no dev proxy, not a code audit.
- **Windows path scrubbing in logs** — requires a test run on a Windows machine with a real user home path, not a mocked path string.

Any CI job that auto-passes these gates based on simulated or mocked evidence is a fabricated claim and must be removed or replaced with an explicit `BLOCKED: requires external evidence` status.
