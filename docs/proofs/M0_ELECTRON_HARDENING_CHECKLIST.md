# M0 Electron Hardening Checklist

Status: **implemented baseline, pending packaged OS proof**

## BrowserWindow

- [x] `contextIsolation: true`
- [x] `sandbox: true`
- [x] `nodeIntegration: false`
- [x] `webSecurity: true`
- [x] CommonJS sandbox preload emitted as `dist-v3/electron/preload.cjs`
- [x] no remote module
- [x] external window opens denied
- [x] navigation outside app denied
- [x] packaged smoke runs a renderer isolation probe proving the page cannot see
      `require`, `process`, `ipcRenderer`, or Electron globals
- [x] packaged smoke proves the `core`, `license`, and `shell` preload surfaces
      are frozen

## Session

- [x] permission requests denied by default
- [x] permission checks denied by default
- [x] packaged-mode requests restricted to `file:`, `data:`, and `devtools:`
- [x] renderer CSP blocks network with `connect-src 'none'`
- [x] packaged smoke records session request counters and fails if any external
      request is allowed
- [x] packaged smoke proves normal startup has zero blocked requests before its
      explicit network probe
- [x] packaged smoke deliberately probes renderer fetch, external window-open,
      external navigation, and session-level fetch denial

## Network/Telemetry

- [x] auto-updater absent in M0
- [x] core `updates.status` reports manual-check-only, no startup checks, no
      background checks, no background downloads, and zero attempted checks
- [x] packaged smoke verifies update policy through the typed preload bridge
- [x] crash reporter absent in M0
- [x] Chromium background networking disabled by command-line switch
- [x] component updater disabled by command-line switch
- [x] sync disabled by command-line switch

## Sidecar Supervision

- [x] Electron main requires a `core.version` handshake before treating the
      sidecar as healthy
- [x] supervisor status records lifecycle state, restart count, last exit, and
      last handshake
- [x] renderer receives only read-only structured supervisor status
- [x] packaged smoke proves a sidecar shutdown, restart, fresh handshake, and
      post-restart `core.status` response

## Model Import Boundary

- [x] renderer can request `modelsImportFromFile` only through the typed preload
      bridge
- [x] Electron main owns the native file picker and streams the selected model
      file to the core
- [x] packaged smoke verifies the preload bridge is frozen and does not expose
      private model import chunks, raw file APIs, process execution, or external
      navigation commands
- [x] preload does not expose `models.importStart`, `models.importChunk`,
      `models.importFinish`, or `models.importAbort`
- [x] renderer receives structured import results without the selected file path

## Local Document Save Boundary

- [x] renderer exposes one typed `exportSaveLocal` command for Markdown, DOCX,
      and PDF reports
- [x] Electron main owns `dialog.showSaveDialog` and never returns its selected
      path
- [x] main validates recording id, structured input size, core custody facts,
      MIME type, declared byte length, output limit, and native file signature
- [x] renderer receives only the saved basename, byte count, SHA-256, and
      document capability facts
- [x] packaged smoke generates and hashes native DOCX and searchable PDF bytes
      inside the shipped sidecar without writing payload bytes into the proof
      receipt
- [x] preload exposes no dialog, `writeFile`, destination path, or unrestricted
      filesystem method

## First-Run and Visual Proof

- [x] packaged smoke uses an isolated Electron user-data directory
- [x] activation can start a local trial without a persistent account
- [x] license status and portal responses expose no raw path or key material
- [x] packaged smoke captures activation, onboarding, Live Meeting, Home,
      Library, Summary, Review, Export, Settings, and Custody views
- [x] every screenshot is decoded and checked for dimensions, color diversity,
      luminance range, and nonblank pixels
- [x] capture forces a full repaint and compositor warm-up before each final PNG

## CI Proof Contract

- [x] `scripts/m0-ci-contract-smoke.mjs` verifies the v3 M0 workflow keeps the
      Windows, macOS, and Linux matrix, per-OS network-deny proof runners,
      artifact uploads, combined proof audit summary, and strict combined
      proof gate.
- [x] The CI contract smoke rejects the old optional manual strict-audit input.
- [x] M0 local verification runs the CI contract smoke before build steps.
- [x] The artifact manifest hashes both `.github/workflows/v3-m0.yml` and
      `scripts/m0-ci-contract-smoke.mjs`.
- [x] Windows network proof binds the app, sidecar, and `app.asar` to one
      canonical release root and passes the selected app explicitly to packaged
      smoke.
- [x] Windows network proof checks embedded smoke paths, byte sizes, and
      SHA-256 values against the selected release before reporting success.
- [x] Windows firewall rule evidence is captured before cleanup, preserving the
      associated app and sidecar program paths in the JSON receipt.
- [x] Windows admin refresh passes explicit release and proof directories to
      the manifest and proof audit.
- [x] CI contract and proof-audit self-tests reject default-fallback or
      mixed-package Windows network evidence.
- [x] Windows runner uses the PowerShell 5.1-compatible
      `ProcessStartInfo.Arguments` API; CI rejects `ArgumentList`, and an actual
      PowerShell 5.1 packaged-smoke launch passed against `final15`.
- [ ] Elevated Windows firewall proof for `release-v3-design-vetted-final15`
      still requires interactive UAC approval.

## Verification Commands

```powershell
npm run v3:verify
npm run m0:verify
npm run m0:ci-contract-smoke
npm run m0:proof-audit:self-test
npm run electron:v3:dist
npm run m0:packaged-smoke
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/m0-network-deny-windows.ps1 -ValidateOnly
npm run m0:network-deny:linux -- --validate-only
npm run m0:network-deny:macos -- --validate-only
npm run m0:artifact-manifest
npm run m0:proof-audit
```

Updater policy details live in `docs/proofs/M0_UPDATER_POLICY_PROOF.md`.

Packaged network proof still requires clean-machine firewall capture on
Windows, macOS, and Linux.
