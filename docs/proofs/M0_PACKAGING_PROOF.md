# M0 Packaging Proof

Status: **Windows local directory package and packaged runtime smoke passed; clean-machine matrix pending**

## Requirement

Electron shell and `candor-core` sidecar must package together into a runnable
app on Windows, macOS, and Linux.

## Expected Layout

- Electron main/preload: `dist-v3/electron`
- Renderer: `dist-v3/renderer`
- Rust sidecar: packaged as `resources/bin/candor-core` or
  `resources/bin/candor-core.exe`
- Packaged Rust sidecar is built with `sqlcipher-vault,local-whisper` so the
  release binary includes the encrypted vault and local Whisper transcription
  feature gates.

## Build Commands

```powershell
npm run electron:v3:build
npm run electron:v3:dist
npm run v3:release-artifact-smoke
npm run m0:proof-audit:self-test
npm run m0:packaged-smoke
npm run m0:artifact-manifest
npm run m0:proof-audit
```

For local refresh after renderer, Electron main, sidecar, or proof-script edits,
run the single orchestration command:

```powershell
npm run m0:local-proof-refresh
```

This rebuilds the package, runs packaged smoke, writes the artifact manifest,
validates the current platform network proof runner inputs, and writes
`release-v3/proofs/m0-proof-audit-summary.json`. The validate-only network step
is intentionally recorded as input validation only. It is not accepted as the
M0 network-deny proof.

`npm run v3:release-artifact-smoke` writes
`release-v3/proofs/v3-release-artifact-smoke-<platform>-<arch>.json`. On
Windows it extracts the NSIS installer payload without installing it and checks
that `Candor v3 M0.exe`, `resources/app.asar`, and
`resources/bin/candor-core.exe` match the unpacked package by hash. On macOS
and Linux, the same gate must prove the DMG, AppImage, or deb payload entries
match the corresponding unpacked app payload hashes before M0 packaging can
pass. Windows inspection prefers electron-builder's managed 7-Zip binary over
an arbitrary system `PATH` copy so NSIS extraction layout is reproducible on
developer machines and hosted runners.
On macOS, signing and entitlement findings are recorded separately as
`releaseGaps`: they do not invalidate M0's structural package proof, but strict
artifact smoke and the M5 release-signing gate still reject those gaps.

`npm run m0:packaged-smoke` writes a machine-readable proof artifact to
`release-v3/proofs/m0-packaged-runtime-smoke-<platform>-<arch>.json`.
Labeled viewport runs write a distinct
`m0-packaged-runtime-smoke-<label>-<platform>-<arch>.json` artifact so compact
and reference-size evidence cannot overwrite one another.
That smoke run must prove the packaged app can complete a sidecar
`core.version` handshake, expose the handshake as structured supervisor status,
open the local SQLCipher vault through the typed renderer bridge using the
OS-key path when native key storage is available, or report a safe unavailable
fallback state when the runner cannot reach native key storage. In either case
it must not expose key material or raw paths. The smoke also proves supervised
sidecar restart by shutting down the first sidecar, starting a replacement,
handshaking again, and receiving `core.status` from the restarted sidecar over
stdio JSON-RPC.

The packaged renderer probe also verifies the frozen preload bridge exposes
typed `aiInstructStatus`, `aiRecapInstruct`, and `aiAskInstruct` methods. It
queries instruct status from the bundled core and requires local-only policy,
manual model installation, no background downloads, and no raw configuration
values, paths, or key material in the renderer response.
It also captures activation, first-run setup, Live Meeting, and seven secondary
product views at a stable desktop viewport and hashes them into the
packaged-smoke proof. The smoke decoder checks PNG dimensions, sampled color
diversity, luminance range, and non-white pixel ratio, so a blank white capture
cannot satisfy the visual gate. Each final capture follows a forced window
repaint and a discarded compositor warm-up frame. Hosted displays may clamp the
requested 1440 by 900 window to their work area, but the captured content must
still be at least 960 by 600 pixels and pass every DOM and pixel-content check.
The renderer Vite build uses `base: "./"` so packaged `file://` loading resolves
JavaScript and CSS beside `index.html` instead of requesting root-level asset
paths.

The packaged smoke also runs an explicit network-denial probe. It verifies that
normal startup has no blocked requests before the probe, renderer `fetch` is
blocked, external `window.open` is denied, external navigation stays inside the
app, a temporary smoke-only session fetch is blocked by Electron's session
guard, and no external request is allowed.

`npm run m0:artifact-manifest` writes
`release-v3/proofs/m0-artifact-manifest-<platform>-<arch>.json`, hashing the
packaged executable, `candor-core`, `app.asar`, release-shaped platform
artifacts, and M0 source/proof files. The manifest requires the Windows NSIS
installer, macOS DMG, or Linux AppImage plus deb artifact for the current
platform before it can pass.
The manifest also records git and CI provenance. `npm run v3:verify` and
`npm run m0:packaged-smoke` write the same provenance into their proof files,
and the M0 proof audit rejects staged-verification or packaged-smoke proof that
cannot be matched to a valid manifest from the same source identity.
The packaged smoke proof also records hashes for the packaged executable,
`candor-core`, and `app.asar`. The proof audit cross-checks those hashes against
the artifact manifest so stale smoke results cannot be paired with a different
package, and writes the matching hash evidence into the audit summary row.

Windows network-deny proof uses the packaged smoke as a subcheck and writes a
separate `release-v3/proofs/m0-network-deny-windows-<timestamp>.json` artifact
when run from an elevated PowerShell session.
`npm run m0:network-deny:windows:admin` is the local UAC launcher for that
same proof. Its launcher receipt is not accepted as the network-deny proof; it
only records the operator path used to invoke the elevated runner.
The runner now derives one canonical release root and requires the selected
app executable, `candor-core`, and `app.asar` to use the expected paths beneath
that root. It passes the selected app path explicitly to packaged smoke, then
checks the smoke receipt paths, byte sizes, and SHA-256 values against the
selected release. The admin launcher also passes that release root explicitly
to the artifact manifest. Mixed-package or default-fallback evidence is
rejected before it can become a passing network receipt.

Linux and macOS network proof runners use the same packaged smoke subcheck and
write platform-specific proof artifacts under `release-v3/proofs/`.

`npm run m0:proof-audit` reads the proof directory and reports which M0 proof
artifacts are present, valid, missing, or failed. `npm run m0:proof-audit:strict`
is the M0 exit gate and must fail until packaged smoke, release artifact smoke,
OS-boundary network proof, and artifact manifest proof artifacts exist for
Windows, Linux, and macOS.
`npm run m0:proof-audit:self-test` verifies that stale smoke artifacts without
sidecar handshake and restart evidence are rejected, and that staged
verification or packaged-smoke proof with a different git or CI identity from
the package manifest is rejected. It also verifies that release artifact smoke
proofs reject installer payloads that do not match the unpacked sidecar hash,
and that a Windows network proof cannot embed smoke evidence from another
release.

The GitHub Actions matrix now builds release-shaped artifacts and then runs real
Windows, Linux, and macOS network-deny proofs by default. Windows uses temporary
outbound firewall rules for the packaged app and sidecar. Linux runs the
packaged smoke inside an ephemeral network namespace. macOS uses a temporary
managed PF anchor scoped to an isolated execution GID, per-rule blocked-attempt
counters, and temporary-pcapng PKTAP escape attribution with explicit
zero-kernel-drop and raw-trace-deletion gates. Linux and managed-PF
macOS proofs must also record a blocked outbound deny-layer sentinel before the
packaged smoke proof is accepted. The Linux namespace and macOS PF/PKTAP
controls stay privileged, while the packaged app is explicitly dropped back to
the invoking non-root desktop user. The Linux job installs the native build and runtime
packages needed for the Rust audio stack, SQLCipher key storage checks,
Electron smoke, `xvfb-run`, and `unshare`.

The macOS build runner is pinned to GitHub's `macos-26` workflow label, which
selects the `macOS-26-arm64` hosted image, and asserts an SDK major version of
at least 26. The current `apple-metal` dependency contains SDK 26
symbol references that an older SDK cannot parse, even though those calls are
runtime guarded. This build-host requirement is distinct from the app runtime
contract: the build exports `MACOSX_DEPLOYMENT_TARGET=13.0`, the packaged app
declares `LSMinimumSystemVersion` 13.0, and the DMG smoke verifies that plist
value.

The workflow uploads installers and proof receipts as separate artifacts. Its
`m0-proof-audit` job downloads only the small proof receipts and writes a
combined `m0-combined-proof-audit-summary.json` so the full OS proof set can be
checked without transferring every installer again. It then runs strict audit
mode every time. The workflow fails until Windows, Linux, and macOS all have
valid staged-verification,
packaged-smoke, release-artifact-smoke, network-deny, and artifact-manifest
proofs, with staged verification, packaged smoke, and package manifest proof
agreeing on source identity and the manifest proving the platform release
artifact exists.
Per-OS manifest, per-OS proof-audit summary, and artifact upload steps are
marked `if: always()` so failed network proof attempts still upload their JSON
receipts for diagnosis.

## Execution Log

Current vetted Windows artifact:

```text
release-v3-design-vetted-final15/Candor v3 M0 Setup 2.0.0.exe
release-v3-design-vetted-final15/win-unpacked/Candor v3 M0.exe
```

Immutable SHA-256 identities:

```text
installer:   17b683d23b4c9cac4208b3bcccac45bb5a965b3430bb0c851b2f88e29e79a6b9
application: e8a0d02e164df885187e5141e9a3b1f9420c6744a88c4ca80c55a62dcc1067e7
app.asar:    7c929cbace23a5a4889551a11cfca42d2eef1f117f67b0afbc87f9c52da0207f
sidecar:     4311c9d8af8eb34874ffd1458057509414952aac8a96d111c6944cd58d487323
```

The proof scripts were run with `--release-dir release-v3-design-vetted-final15`
so installer extraction and artifact hashes refer to this exact package.
The Windows network runner and admin-launcher validate-only paths also passed
against this exact root on 2026-07-11. A deliberate mixed-root input was
rejected. The elevated firewall run still requires an approved UAC prompt and
has not passed, so it is not listed as a Windows network proof. The
post-elevation process-launch mechanism was separately exercised under Windows
PowerShell 5.1 and successfully ran packaged smoke against this exact
executable path.

| OS | Installer/Bundle Path | Sidecar Found | Signing/Notarization | Clean Launch | Notes |
| --- | --- | --- | --- | --- | --- |
| Windows | `release-v3-design-vetted-final15/Candor v3 M0 Setup 2.0.0.exe` plus `release-v3-design-vetted-final15/win-unpacked/Candor v3 M0.exe` | `release-v3-design-vetted-final15/win-unpacked/resources/bin/candor-core.exe` verified by packaged smoke | installer artifact exists, production Authenticode certificate not configured | explicit packaged smoke passed at 1440 by 900 and 1080 by 720 on 2026-07-11 | Proof artifacts: `release-v3/proofs/m0-packaged-runtime-smoke-win32-x64.json`, `release-v3/proofs/m0-packaged-runtime-smoke-compact-win32-x64.json`, `release-v3/proofs/v3-release-artifact-smoke-win32-x64.json`, `release-v3/proofs/v3-icon-proof-win32-x64.json`, and `release-v3/proofs/m0-artifact-manifest-win32-x64.json`. Smoke proved activation and local trial, ten rendered views per viewport, preload isolation, main IPC, sidecar handshake/restart, SQLCipher vault access, blocked external navigation/network probes, native editable DOCX generation, searchable bookmarked PDF generation, packaged `candor-core` stdio RPC, fail-closed callback integrity policy, AI Suggestions mode switching, restoration of the manual notes view, notification dismissal before visual capture, and accessible accent text contrast across canvas and raised surfaces. Icon proof verified reproducible ICO, ICNS, and PNG assets plus an exact pixel match between the generated 32px source and the icon embedded in the Windows executable. Clean-machine launch still pending |
| macOS | Pending | Pending | Pending | Pending | Pending |
| Linux | Pending | Pending | Pending | Pending | Pending |

## Exit Standard

M0 packaging is complete only after each OS launches the packaged app and the
renderer receives a valid `core.status` response from the packaged sidecar after
Electron main has completed a version handshake and a supervised restart
exercise.
