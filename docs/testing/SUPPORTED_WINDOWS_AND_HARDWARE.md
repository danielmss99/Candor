# Candor Windows Support And Hardware Evidence

## Release support status

Candor's first public beta target is Windows 11 x64 on versions still supported by Microsoft. This is a target, not a compatibility claim. Public beta support remains blocked until the signed installer, clean upgrade, and hardware matrix pass against the same committed release candidate.

Windows 10, Windows on Arm, virtual audio cables, remote desktop audio, and enterprise-managed capture devices are not part of the first beta support claim unless separate evidence is attached.

## Required hardware coverage

The release candidate must pass with:

- one built-in microphone;
- one USB microphone;
- one Bluetooth microphone;
- WASAPI system audio;
- microphone and system audio together;
- input disconnect and device switching;
- sleep and resume;
- lock and unlock.

The tested device name should be reduced to a non-sensitive model reference. Do not record a Windows user name, device serial number, complete local path, meeting content, or participant name in proof receipts.

## Current tested hardware

No hardware is listed as supported until its evidence passes `npm run v3:manual-release-matrix:strict`. The source template is [`manual-release-evidence.template.json`](manual-release-evidence.template.json). Operator evidence belongs under the ignored `release-v3/manual-evidence/` directory.

## Updating this document

After a candidate passes, replace this pending section with the tested Windows build numbers, CPU class, memory, audio device model references, driver versions, and proof receipt identifiers. Keep the statement scoped to exactly what was tested.
