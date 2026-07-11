# V3 Release Signing Proof

Status: **implemented readiness proof; current release is not signing-ready**

## Purpose

Candor v3 release readiness requires signed, installer-shaped artifacts for the
supported desktop platforms. This proof records the current signing and package
state as machine-readable JSON instead of leaving signing as a checklist item.

The proof checks:

- Windows NSIS installer artifact exists
- Windows app executable is Authenticode-signed
- Windows `candor-core.exe` sidecar is Authenticode-signed
- Windows installer is Authenticode-signed
- Current platform release artifact hashes match the M0 artifact manifest
- Current platform release artifact hashes match the release artifact smoke proof
- macOS DMG artifact exists
- macOS notarization credentials are configured
- macOS app bundle codesign verification passes when an unpacked app bundle exists
- macOS app bundle Gatekeeper assessment passes when an unpacked app bundle exists
- macOS DMG Gatekeeper assessment passes
- macOS DMG or app bundle stapler validation proves notarization
- Linux AppImage and deb artifacts exist
- Linux AppImage and deb detached signatures exist and verify
- Linux package signing credentials are configured for producing those signatures

## Commands

Build release-shaped artifacts for the current platform:

```powershell
npm run electron:v3:dist
```

Build the Windows NSIS installer artifact explicitly:

```powershell
npm run electron:v3:dist:win
```

Record the current readiness state without failing the caller:

```powershell
npm run v3:release-signing-proof
```

Fail unless signing and installer readiness are complete:

```powershell
npm run v3:release-signing-proof:strict
```

The proof writes:

```text
release-v3/proofs/v3-release-signing-proof-<platform>-<arch>.json
```

## Boundary

This proof does not create certificates, notarize macOS builds, sign Linux
packages, or run installer smoke tests. It records whether those release
artifacts and signing inputs are present, rejects stale signing evidence when
the current platform artifact hash does not match the M0 artifact manifest and
release artifact smoke proof, and requires Linux package signatures to be
verified from detached `.asc`, `.sig`, `.gpg`, or `.minisig` files. On macOS,
the proof requires local `codesign`, `spctl`, and `xcrun stapler validate`
evidence for existing app bundles and DMG artifacts. Running the proof on a
non-macOS host records the macOS checks as unverified rather than treating
credential presence as proof.
`electron:v3:dist` can create installer-shaped artifacts, but signed
distribution still requires the platform signing inputs and a passing strict
release-readiness audit before Candor v3 can be called ready for distribution.
