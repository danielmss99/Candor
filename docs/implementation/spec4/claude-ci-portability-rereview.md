Now I have the full picture. Here are the findings, ordered by severity.

---

## Review Findings

### P0 — None

No P0 defects. The implementation is structurally correct.

---

### P1 — Coverage regression on the fail-closed path (line 1648)

**File:** `terminology_dictionary.rs:1648`

The test previously named `dictionary_round_trip_is_os_key_encrypted_and_pathless` was the only test that called `with_roots` and exercised the OS key store path. It was renamed and switched to `with_test_roots`, so there is now no automated test that verifies `with_roots` returns `TERMINOLOGY_KEY_UNAVAILABLE` in a keyring-unavailable environment.

This is not a code defect — the production fail-closed behavior is enforced at the code level and the change is intentional. But it is a coverage gap: if someone later loosens the `encryption_key` guard or adds a fallback in `os_key_store::get_or_create_key`, no test will catch the regression.

**Recommended addition** (not required to merge): A single `#[cfg(test)]` test that calls `with_roots` and asserts the result of any write or load is `TERMINOLOGY_KEY_UNAVAILABLE` when the key store is absent. Since headless CI has no keyring, this test would naturally pass there by asserting the error code rather than by succeeding.

---

### P2 — `key_root` is stored but unreachable for encryption in `with_test_roots` (line 286–292)

**File:** `terminology_dictionary.rs:286–292`

`with_test_roots` accepts and stores `key_root` as `self.key_root`, but `encryption_key()` returns the fixed key before ever reaching `os_key_store::get_or_create_key(key_root)`. The parameter is dead for its primary purpose in this constructor.

This is not a defect — `self.key_root` is only read inside the `encryption_key()` path that is short-circuited, and the parameter is otherwise necessary so call sites can pass it naturally alongside `RecordingStore::with_root(key_root.clone())`. It is mildly misleading but correct.

---

### Answers to the posed questions

**1. Can the test-only key or constructor enter a production build or runtime path?**

No. All three additions are gated by `#[cfg(test)]`:
- The struct field at line 270–271 does not exist in the production struct.
- `with_test_roots` at line 285 is a private method stripped from production builds.
- The early-return branch in `encryption_key` at line 1068–1071 is stripped from production builds.

The production `with_roots` initializes `test_encryption_key: None` under its own `#[cfg(test)]` line (line 280–281), meaning even in a test-compiled binary, a `with_roots` instance still goes through the OS key path — it cannot reach the fixed key.

**2. Does this preserve fail-closed production key-storage behavior?**

Yes. In non-test builds, `encryption_key()` contains only the `os_key_store::get_or_create_key` call, unchanged from before. The error code `TERMINOLOGY_KEY_UNAVAILABLE` is still the only outcome when the OS key store is absent. Nothing in the change touches the error code, the error message, or the OS key store call itself.

**3. Is the fixed key `[0x5a; 32]` acceptable for unit tests?**

Yes. The tests exercise serialization round-trips, encryption format (asserting plaintext absent from the binary blob), corruption detection, concurrency via a `Mutex`, prompt budget enforcement, proposal generation, and accept/reject persistence. None of these require key diversity, key rotation, or key sensitivity. A repeated-byte key is a valid 256-bit ChaCha20Poly1305 key and will correctly encrypt and decrypt across all test operations. File system isolation per test (unique temp dirs seeded with PID + timestamp at line 1629–1634) ensures no test reads a store written with a different key setup.

**4. Is there a safer minimal design that does not require a headless desktop keyring in CI?**

The proposed design is already the minimal safe approach. The alternatives — a trait-based `KeyStore` abstraction, a file-backed key stub, or `tempfile`-backed key rotation — all add structural complexity without improving the security boundary, because `#[cfg(test)]` is an airtight compile-time gate.

**5. No P0 or P1 correctness, security, or test-coverage defect with blocking severity.**

The P1 coverage regression noted above (removed exercise of the `TERMINOLOGY_KEY_UNAVAILABLE` fail-closed path) is the only material concern, and it is an intentional consequence of fixing the CI breakage rather than a hidden defect introduced by the change.
