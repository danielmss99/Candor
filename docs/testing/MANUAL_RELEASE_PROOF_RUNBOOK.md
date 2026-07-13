# Candor Manual Release Proof Runbook

Use this runbook only with a release candidate built from a committed, clean source tree. Synthetic smokes do not satisfy these gates.

## Stop rules

Stop the release immediately when:

- a migration changes the only usable copy of existing data;
- a recording reports saved before durable finalization;
- recovery loses more than one configured chunk;
- an expired or unavailable license blocks open, export, or delete;
- a package lacks the expected signature or checksum;
- any meeting content, key, token, or complete local path appears in diagnostics;
- an unapproved outbound connection appears;
- the operator cannot identify whether recording is active in one second.

Preserve failed-machine logs and the untouched source vault. Do not rerun a destructive step against the only copy.

## Candidate identity

1. Check out the release commit with no tracked changes.
2. Run `npm ci`, `npm run v3:verify`, `npm run test:electron:build`, and the platform `electron:v3:dist:*` command.
3. Run `npm run v3:release-artifact-smoke` and `npm run m0:artifact-manifest`.
4. Run `npm run v3:release-checksums` and `npm run v3:release-checksums:verify`.
5. Record commit, package filename, byte size, SHA-256, OS version, architecture, operator, and UTC time.
6. Copy the installer and `SHA256SUMS` to the test machine through the planned distribution channel.
7. Verify the checksum on the destination before launch.

## Clean install

Use a machine or VM snapshot with no Node.js, Rust, repository checkout, prior Candor install, or Candor user-data directory.

1. Verify the platform signature before opening the installer.
2. Install through the normal user flow without developer tools.
3. Launch Candor from the installed shortcut.
4. Confirm the Electron window, packaged Rust sidecar, activation choice, local-only wording, and storage readiness.
5. Complete one short microphone recording, durable stop, replay, review, Word export, PDF export, and deletion.
6. Confirm exports open in native readers and contain editable or searchable text.
7. Uninstall Candor.
8. Confirm uninstall does not delete user recordings or the vault without a separate explicit choice.

## Upgrade and rollback

Start from the previous signed release on a clean snapshot.

1. Create two recordings, notes, transcript edits, a review state, and Word/PDF exports.
2. Back up the local vault using the supported backup procedure.
3. Install the candidate over the previous release.
4. Confirm every existing meeting opens, replays, exports, and deletes with networking and licensing unavailable.
5. Confirm the migration receipt and retained backup contain no user content or full path.
6. Force an injected migration failure on a disposable copy and verify the old schema remains usable.
7. Install the retained rollback build only against the documented compatible schema.
8. Restore the snapshot instead of forcing a downgrade when the schema is not backward compatible.

## Recording duration matrix

Run 5-, 30-, 60-, and 180-minute real recordings on each supported OS capture branch.

For every run:

1. Record microphone and system audio separately where supported.
2. Mark start time, configured chunk duration, free space, input devices, and output device.
3. Confirm the recording indicator, elapsed time, input state, transcript, and notes remain usable.
4. Force-kill one disposable 30-minute run at a random time.
5. Relaunch and verify recovery loses no more than one flushed chunk.
6. Stop normally, replay beginning/middle/end, transcribe locally, review, and export.
7. Compare saved duration with the external timer and record the difference.

## Sleep, resume, and devices

Use disposable recordings.

1. Sleep the machine during active capture and resume after at least one minute.
2. Verify Candor either continues with an explicit gap or enters a deterministic recovery state.
3. Disconnect and reconnect the microphone.
4. Change the default input and output devices.
5. Confirm the UI never claims uninterrupted capture when frames were lost.
6. Stop and verify all audio committed before the failure remains replayable.

## Disk pressure

Use a quota-limited disposable volume, never the only user vault.

1. Start above the low-storage threshold and confirm a persistent warning.
2. Cross the new-recording reserve and confirm new starts are blocked while existing meetings remain accessible.
3. Exhaust space during capture and confirm the active-write failure is persistent.
4. Free space, stop the recording, and verify the last committed manifest and chunks recover.
5. Confirm no partial chunk is indexed and no false saved message appears.

## Network denial

Use the packaged application and OS-specific proof command under administrator or root authority.

1. Start packet or firewall logging before Candor.
2. Exercise activation-free launch, recording, replay, transcription, local AI fallback, review, export, settings, and quit.
3. Keep model download and update checks disabled.
4. Assert no outbound connection or attempted call outside an explicitly initiated capability.
5. Preserve the raw OS log outside the repository and the redacted proof receipt in `release-v3/proofs`.

## Signing

- Windows: verify Authenticode on app, sidecar, uninstaller, and installer, including certificate chain and timestamp.
- macOS: verify hardened runtime, app and sidecar signatures, entitlements, notarization, staple, and Gatekeeper acceptance for app and DMG.
- Linux: verify AppImage and deb detached signatures with the published public key.

Run `npm run v3:release-signing-proof:strict` only after all platform artifacts are present.

## Completion record

Attach screenshots, proof JSON, checksum output, signature verification, capture logs, and pass/fail notes to the release candidate. Then run:

```powershell
npm run m0:proof-audit:strict
npm run v3:release-readiness-audit:strict
npm run v3:goal-audit:strict
```

Do not publish unless all three strict commands pass against the same committed source identity and package hashes.
