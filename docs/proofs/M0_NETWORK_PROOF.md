# M0 Network Proof

Status: **Windows final15 preflight passed; elevated boundary and cross-OS execution pending**

## Requirement

The packaged Candor v3 M0 app must run with zero outbound network traffic.
Updater checks, model downloads, crash reporting, telemetry, and Chromium
background calls are disabled for M0.

## Local Design Evidence

- Electron command-line switches disable background networking, component
  updates, domain reliability, sync, and proxy use.
- Packaged renderer CSP uses `connect-src 'none'`.
- Electron session `onBeforeRequest` blocks non-file, non-devtools, non-data
  requests in packaged mode.
- No Electron `autoUpdater` integration exists in M0.
- Rust core exposes `updates.status` so updater policy is a queryable fact:
  manual-check-only, no startup checks, no background checks, no background
  downloads, and zero attempted checks.
- No Electron `crashReporter.start` integration exists in M0.
- `npm run m0:packaged-smoke` proves packaged renderer to sidecar IPC without
  requiring localhost TCP. It also proves sidecar shutdown, restart, fresh
  `core.version` handshake, and post-restart `core.status` over stdio.
- `scripts/m0-packaged-smoke.mjs` also checks `updates.status` through the
  renderer preload bridge, including `rawPathExposed: false`.
- Packaged smoke writes `sessionNetworkGuard` counts plus a
  `networkBlockProbe`. Normal startup must show zero blocked requests before
  the explicit probe. The probe then deliberately attempts renderer `fetch`,
  external `window.open`, external navigation, and a session-level external
  fetch from a temporary smoke-only `data:` window. The proof must show the
  renderer fetch was blocked, the navigation stayed inside the app, the
  Electron session guard incremented its blocked-request count, and
  `externalAllowedRequests` remained `0`.
- Windows OS-boundary proof runner exists at
  `scripts/m0-network-deny-windows.ps1`. It creates temporary outbound block
  rules for the packaged Electron app and `candor-core`, runs the packaged
  smoke, samples TCP state and UDP endpoints for both processes, writes a JSON
  proof under `release-v3/proofs/`, fails if any TCP connections or UDP
  endpoints are observed, then removes the rules in `finally`.
- The Windows proof artifact must include enabled outbound block-rule evidence
  for both the packaged app path and the sidecar path. The combined audit rejects
  missing, disabled, non-blocking, inbound, or wrong-program rule evidence.
  The runner captures each rule's associated program path while the temporary
  rules still exist, then removes the rule group in `finally`.
- The Windows runner binds one canonical release root to the app executable,
  `candor-core`, and `app.asar`. It passes that exact app executable to the
  packaged smoke, records SHA-256 and byte-size evidence for all three files,
  and rejects the run if the embedded smoke receipt names or hashes a different
  package. The proof audit independently enforces the same identity checks.
- The Windows admin launcher passes the same explicit release root to the
  artifact manifest and the same explicit proof directory to the manifest and
  proof audit. It cannot silently refresh evidence for the default
  `release-v3` package while the firewall targets another build.
- Linux OS-boundary proof runner exists at
  `scripts/m0-network-deny-linux.mjs`. It runs the packaged smoke inside
  `unshare --net`, with `xvfb-run` for Electron, and writes
  `release-v3/proofs/m0-network-deny-linux-<timestamp>.json`. Before the
  packaged smoke is accepted, it runs a small outbound TCP sentinel inside a
  fresh network namespace and records `denyLayerProbe.blocked: true`.
- macOS proof runner exists at `scripts/m0-network-deny-macos.mjs`. In managed
  mode it enables a per-run PF anchor under `com.apple/`, loads a temporary
  outbound TCP/UDP block rule scoped to an unused execution GID, and launches
  both the sentinel and packaged app as the invoking non-root user under that
  GID. PF per-rule counters prove the sentinel was blocked and that the app made
  zero blocked attempts after the counters were reset. A simultaneous
  `pktap,all` capture records any packets that escape PF with process metadata.
  The proof verifies that the observed Candor process tree retains the isolated
  UID/GID and retains hosted-runner background packets only as diagnostics. It
  writes
  `release-v3/proofs/m0-network-deny-macos-<timestamp>.json`, then flushes the
  anchor and releases the PF enable token in `finally`. Managed-PF mode also
  runs a small outbound TCP sentinel, records `denyLayerProbe.blocked: true`,
  and requires the isolated-group rule counter to increase before accepting the
  proof. Manual external deny mode still exists for Little Snitch, PF, or an
  equivalent deny layer and remains operator-attested plus PKTAP process
  attribution.

## Windows Network-Deny Command

Run from an elevated PowerShell prompt after packaging. For the accepted
`final15` build, use explicit package identity arguments:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/m0-network-deny-windows.ps1 `
  -ReleaseDir ./release-v3-design-vetted-final15 `
  -AppPath './release-v3-design-vetted-final15/win-unpacked/Candor v3 M0.exe' `
  -CorePath ./release-v3-design-vetted-final15/win-unpacked/resources/bin/candor-core.exe `
  -ProofDir ./release-v3/proofs
```

To launch the same proof through UAC from a normal PowerShell prompt:

```powershell
npm run m0:network-deny:windows:admin -- `
  -ReleaseDir ./release-v3-design-vetted-final15 `
  -AppPath './release-v3-design-vetted-final15/win-unpacked/Candor v3 M0.exe' `
  -CorePath ./release-v3-design-vetted-final15/win-unpacked/resources/bin/candor-core.exe `
  -ProofDir ./release-v3/proofs
```

The admin launcher validates the packaged app and sidecar paths, opens an
elevated PowerShell process, runs the real Windows network-deny proof, refreshes
the artifact manifest, refreshes the proof-audit summary, and writes
`release-v3/proofs/m0-network-deny-windows-admin-launcher-<timestamp>.json`.
The launcher receipt includes `latestNetworkProof`, a summary of the newest real
`m0-network-deny-windows-<timestamp>.json` artifact found after validation or
UAC execution. That summary records whether the proof parsed, whether it was
`ok`, whether it ran as administrator, firewall rule count, observed TCP/UDP
counts, cleanup status, and any proof error.
That launcher receipt is operator evidence only. The combined audit still
requires a valid `m0-network-deny-windows-<timestamp>.json` proof with enabled
outbound firewall rules and zero observed TCP or UDP endpoints.
Admin-launcher receipt files are intentionally ignored by the Windows
`networkDeny` artifact selector.

For a non-elevated path and syntax check only:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/m0-network-deny-windows.ps1 -ValidateOnly
```

The admin launcher also has a validate-only mode:

```powershell
npm run m0:network-deny:windows:admin -- -ValidateOnly
```

Validate-only output includes `validateOnlyIsNotNetworkProof: true`,
`releaseDir`, immutable app/core/archive hashes, `administrator`,
`netSecurityAvailable`, and `canCreateFirewallRules`. A real
non-elevated run writes a failed
`release-v3/proofs/m0-network-deny-windows-<timestamp>.json` attempt artifact
before exiting non-zero. That artifact records
`prerequisiteFailure: administrator-required`, so the audit can report the exact
missing privilege instead of treating the Windows network row as absent or
cascading into firewall-rule checks that were never allowed to run.
Admin-launcher validate-only mode also writes a
`m0-network-deny-windows-admin-launcher-<timestamp>.json` receipt with
`latestNetworkProof`, but that receipt is still not accepted as the network
boundary proof.

## Linux Network-Deny Command

Run on Linux after `npm run electron:v3:dist`. This needs root because it creates
a fresh network namespace:

```bash
sudo npm run m0:network-deny:linux
```

For a path and dependency check only:

```bash
npm run m0:network-deny:linux -- --validate-only
```

Validate-only output includes `validateOnlyIsNotNetworkProof: true`, command
presence for `bash`, `unshare`, `xvfb-run`, `node`, and `ip`, plus
`canRunProof`. The Linux CI job installs `iproute2` because the proof brings
loopback up inside the fresh namespace before launching Electron.

The Linux network proof is valid only when the namespace sentinel also records
`denyLayerProbe.blocked: true`, proving the namespace denies ordinary outbound
TCP before the packaged smoke is accepted.

The GitHub Actions workflow runs this proof on the ephemeral Ubuntu runner by
default. The uploaded `release-v3/proofs/` artifact should include both:

- `m0-packaged-runtime-smoke-linux-<arch>.json`
- `m0-network-deny-linux-<timestamp>.json`

The workflow also runs the Windows network-deny proof on the hosted Windows
runner after validate-only succeeds, and the managed-PF macOS proof on the
hosted macOS runner after validate-only succeeds.

## macOS Network-Deny Command

Run on macOS after `npm run electron:v3:dist`. The default proof path manages a
temporary PF anchor itself:

```bash
sudo npm run m0:network-deny:macos -- --managed-pf
```

External deny tools are still supported when a human operator has already
enabled the deny layer for the test window:

```bash
sudo npm run m0:network-deny:macos -- --external-deny-confirmed
```

For a path and dependency check only:

```bash
npm run m0:network-deny:macos -- --validate-only
```

Validate-only output includes `validateOnlyIsNotNetworkProof: true`, command
presence for `bash`, `tcpdump`, `pfctl`, `ps`, and `node`, plus
separate `canRunManagedPfProof` and `canRunExternalDenyProof` booleans.

Managed-PF proof artifacts must include `denyLayerProbe.blocked: true`,
`managedPf.anchorLoaded: true`, `managedPf.anchorFlushed: true`, and
`managedPf.enableTokenReleased: true`. They must also show non-zero sentinel
rule counters, a zero application counter baseline, zero final application rule
counters, complete PKTAP process attribution, an identity-consistent Candor
process tree, and zero blocked or escaped Candor-attributed outbound TCP/UDP
packets.
External-deny fallback artifacts are accepted only with explicit
`externalDenyConfirmed: true`, complete PKTAP
attribution, and the same zero-Candor-packet result.

## Exit Audit

Use the non-strict audit to summarize current proof artifacts:

```bash
npm run m0:proof-audit
```

The audit also refreshes
`release-v3/proofs/m0-proof-audit-summary.json` by default so the JSON summary
matches the latest terminal result.

To refresh local packaging evidence and capture validate-only network-runner
input evidence without claiming a firewall proof:

```bash
npm run m0:local-proof-refresh
```

The refresh command runs `npm run v3:verify`, packages the app, runs packaged
smoke, writes an artifact manifest, validates network-runner inputs, and writes
`release-v3/proofs/m0-local-proof-refresh-<platform>-<arch>.json` and keeps
`validateOnlyIsNotNetworkProof: true` in that artifact. If the audit finds a
failed or missing OS-boundary proof, the refresh receipt records that failure
without treating validate-only evidence as an M0 pass.

Use the strict audit as the M0 go/no-go gate:

```bash
npm run m0:proof-audit:strict
```

Strict audit must fail until all three OSes have valid staged-verification
proofs, packaged-smoke proofs, OS-boundary network-deny proofs, and artifact
manifests. Staged-verification proof must also match the package manifest git
and CI source identity for the same OS, so old verification JSON cannot be
combined with a newer package or network proof.

In GitHub Actions, packages and proof receipts are uploaded separately. The
`m0-proof-audit` job downloads only the small proof artifacts into
`collected-m0-artifacts/`, runs the same audit recursively, uploads
`m0-combined-proof-audit-summary.json`, and then runs strict mode. The workflow
fails if any required Windows, Linux, or macOS staged-verification, packaged
smoke, network-deny, or artifact-manifest proof is missing or invalid.

## Execution Log

Fill this in per OS when M0 is run on clean machines or VMs.

2026-07-10 local Windows check:

```powershell
scripts/m0-network-deny-windows.ps1 -ValidateOnly
```

This passed path validation for the packaged app and sidecar, and reported
`administrator: false`, `netSecurityAvailable: true`, and
`canCreateFirewallRules: false`. This is not an OS-boundary network proof. The
real Windows row still requires an elevated PowerShell run so temporary
outbound block rules can be created and removed.

2026-07-11 local Windows `final15` package-binding check:

```text
release root: release-v3-design-vetted-final15
application:  e8a0d02e164df885187e5141e9a3b1f9420c6744a88c4ca80c55a62dcc1067e7
app.asar:     7c929cbace23a5a4889551a11cfca42d2eef1f117f67b0afbc87f9c52da0207f
sidecar:      4311c9d8af8eb34874ffd1458057509414952aac8a96d111c6944cd58d487323
```

Exact-package validate-only passed in both the direct runner and admin
launcher. A deliberate test that selected `final15` but supplied the app from
`release-v3` was rejected with `must come from the selected release root`.
The proof-audit self-test also rejects an embedded packaged-smoke receipt whose
executable belongs to a different release. A visible elevated launch reached
UAC, but no approval was received. The waiting launcher was stopped, zero
temporary Candor firewall rules remained, and no successful Windows network
proof was claimed.

The post-elevation process-launch path was also exercised directly under
Windows PowerShell 5.1. The runner uses the PowerShell 5.1-compatible
`ProcessStartInfo.Arguments` API with quoted arguments, and a real packaged
smoke passed against the exact `final15` executable. The CI contract bans the
unsupported `ProcessStartInfo.ArgumentList` API from this runner.

The current proof audit therefore remains:

```text
Windows: staged=PASS smoke=PASS artifact=PASS network=FAIL manifest=PASS
```

| OS | Build ID | Tool | Tested Actions | Outbound Attempts | Result |
| --- | --- | --- | --- | --- | --- |
| Windows | Pending | `scripts/m0-network-deny-windows.ps1` plus Windows Firewall/WFP capture | Launch, status, quit, enabled app/core outbound block rules, zero observed TCP connections, zero observed UDP endpoints | Pending | Pending |
| macOS | Pending | `scripts/m0-network-deny-macos.mjs --managed-pf` plus PF counters/PKTAP | Launch, status, quit, isolated-group TCP/UDP deny, counted sentinel, zero blocked or escaped Candor-attributed packets, anchor cleanup | Pending | Pending |
| Linux | Pending | `scripts/m0-network-deny-linux.mjs` with `unshare --net` | Launch, status, quit | Pending | Pending |

## Exit Standard

M0 is not complete until each OS row shows zero outbound attempts during packaged
app launch and basic core-status interaction.

The packaged smoke guard and explicit block probe are useful local evidence,
but they are not a substitute for OS firewall or packet-capture proof. The
final M0 network row for each OS must come from the operating system boundary,
not only the app's own counters.
