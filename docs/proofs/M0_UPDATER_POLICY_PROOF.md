# M0 Updater Policy Proof

## Purpose

Candor v3 must not perform background update checks in M0. Updates are a future
manual-only release feature, and any network action must be explicitly started
by the user and proven separately.

## Command

```powershell
npm run v3:updater-policy-proof
```

The aggregate staged verifier also runs it:

```powershell
npm run v3:verify
```

The older M0 local verifier also checks the same core facts:

```powershell
npm run m0:verify
```

The packaged proof refresh also checks renderer-visible update facts:

```powershell
npm run m0:local-proof-refresh
```

The dedicated proof writes:

```text
release-v3/proofs/v3-updater-policy-proof-<platform>-<arch>.json
```

## Expected Result

`updates.status` reports:

- `policy: manual-check-only`
- `backgroundChecks: false`
- `backgroundDownloads: false`
- `startupCheck: false`
- `manualCheckNetworkEnabled: false`
- `attemptedChecks: 0`
- `attemptedDownloads: 0`
- `rawPathExposed: false`

`scripts/v3-updater-policy-proof.mjs` records static Electron checks plus a
live `updates.status` sidecar query. `scripts/m0-core-smoke.mjs` checks the core
status. `scripts/m0-packaged-smoke.mjs` checks the same facts through the
renderer preload bridge.

## Boundary

Implemented:

- typed `updates.status`
- no startup update check
- no background update check
- no background download
- packaged smoke assertion for update policy

Still pending:

- user-initiated update check
- pinned release endpoint
- signed update metadata verification
- release-channel UI
