# Claude Code Review Reconciliation

## Accepted and fixed

1. **Storage races**: terminology and transcription-quality reads, updates, backups, and atomic replacements now share a per-service storage mutex. Read-modify-write operations hold the same lock for the complete transaction. A concurrent dictionary import test verifies that both updates survive.
2. **Stale renderer responses**: terminology status and correction proposal requests now carry local generations. Results and errors from superseded meeting requests are ignored.
3. **Poisoned job state**: worker state mutation and event emission recover the mutex guard instead of silently dropping all future transitions.
4. **Untrusted terminology context**: imports reject model control markers and instruction-role prefixes. LLM glossary content is explicitly fenced as untrusted data, and the system prompt says meeting text and metadata are data rather than instructions.
5. **Repeated bundle inspection**: local instruct configuration is resolved and verified once per recap or Ask job, then reused across transcript batches.
6. **Protocol reflection**: `core.ping` no longer echoes arbitrary parameters, and parameter decoding no longer returns raw serde details.
7. **Unauthenticated allocation**: terminology reads no longer reserve the full metadata-declared store size before AEAD authentication.
8. **Repeated lowercase allocation**: terminology scoring reuses the already-normalized context.
9. **Ambiguous developer packaging**: ordinary package commands now build the
   separately identified `Candor Source Interface`. Only strict Complete and
   Complete Max commands can invoke the production Candor builder configuration.

## Rejected with evidence

1. **Private asset path is arbitrary**: rejected as a defect. The operation is unavailable to the renderer, receives a path from Electron's native file picker, then verifies asset kind, exact SHA-256, and format before importing. Restricting it to the application data directory would defeat local file import.
2. **Missing `citationsAddedByCore` should pass**: rejected. The strict llama result contract intentionally requires the field to be exactly `false`; omission is a protocol failure, not a valid response.
3. **Durable chunk methods lack Electron validators**: rejected. The cited methods are not entries in the private Electron operation registry. They are exercised through direct core proof clients.
4. **Pre-epoch timestamp could cross-contaminate cached hashes**: rejected. The digest cache is keyed by canonical asset path, then validates size and modification time within that path entry.
5. **Section-length arithmetic can realistically overflow**: rejected. Model output is byte bounded before JSON parsing, and each section is limited to a small fixed count. The proposed `usize` overflow cannot be reached through the operation boundary.
6. **ANSI text in notes executes in the renderer**: rejected. Browser text rendering does not interpret terminal escape sequences, and report export already rejects unsafe control characters.
7. **Rebuilding correction proposals on decision is wasteful**: retained intentionally. Rebuilding against current transcript and dictionary state prevents a stale client proposal from being trusted as the decision source.

## Deferred improvements

- Consolidating repeated error, ID, numeric-token, and hex helpers is useful cleanup but outside this focused release boundary.
- An in-memory decrypted dictionary cache could reduce repeated local reads, but it would increase sensitive-data residency and needs an explicit revision and invalidation design.
- A dedicated queued worker pool could replace one OS thread per local job in a later performance hardening pass.

## Review status

The interrupted Claude pass produced actionable independent findings, all of which were checked against repository evidence. The authenticated final synthesis then reported two P1 and four P2 findings.

### Final synthesis disposition

1. **Private job IPC validation**: rejected as a defect. `jobs-ipc.ts` calls `CoreClient.call()`, which resolves the private operation and executes `operation.paramsSchema.parse()` before handshake or process startup. A regression test now proves an oversized Ask question returns `CORE_PARAMS_SCHEMA_INVALID` with zero core spawns.
2. **Windows prompt ACL**: accepted and fixed. Prompt files are created with a protected DACL through `CreateFileW`; only the creating owner and LocalSystem receive access. A Windows security-descriptor test rejects broad user groups.
3. **Multi-source attribution**: accepted and fixed. Claims preserve all speakers and use explicit mixed attribution instead of silently assigning the first source.
4. **Weak short-claim overlap**: accepted and fixed. Four-to-seven-token claims now require three meaningful overlaps, with exact pharmaceutical and numeric checks evaluated first.
5. **Merged summary citation flood**: accepted and fixed. Summary Markdown cites only summary evidence; other sections retain their own citations.
6. **Path separator bypass**: accepted and fixed. Sensitive path checks normalize slash direction and case before comparison.
7. **Benchmark during capture**: added during reconciliation. The Rust core now rejects local performance checks while capture is active instead of relying only on the renderer control state.

The focused authenticated Claude rereview confirmed all seven dispositions, found no remaining P0 or P1 defects, and returned a code-level ready-to-merge verdict. No Complete release claim depends on that verdict: real model assets, license approvals, measured hardware benchmarks, signing, and clean-machine evidence remain closed gates.
