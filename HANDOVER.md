# Candor Handover

Last updated: 2026-06-30

## Project

Candor is a Windows-first Tauri desktop app for local meeting recording, Whisper.cpp transcription, markdown note storage, calendar integration, and meeting follow-up workflows.

Core stack:

- Tauri 2
- Rust backend
- React 19 + TypeScript + Vite frontend
- `whisper-rs` for local Whisper transcription
- Markdown files for local note storage
- Windows Credential Manager for calendar secrets on Windows

Repository path:

```text
C:\Claude_Config\candor
```

## Current Git State

The worktree is intentionally dirty. Do not reset it.

There are many modified and added files from recent feature and security work, including:

- Calendar read/write support
- User onboarding and profile customization
- Settings sectioning and scrolling
- Theme customization
- Local model hash pinning
- Storage/privacy/security changes
- Documentation updates

Before continuing, run:

```powershell
git -C "C:\Claude_Config\candor" status --short
```

Treat unrelated existing edits as user-owned unless you can directly tie them to the current task.

## Build Commands

Frontend build:

```powershell
npm run build
```

Tauri dev:

```powershell
npm run tauri:dev
```

Tauri compile check without bundling:

```powershell
npm run tauri -- build --no-bundle --ci
```

Store bundle:

```powershell
npm run build:store
```

The last known successful checks before this handover were:

- `npm run build`
- `npm run tauri -- build --no-bundle --ci`

Those passed after calendar write support and Whisper model hash pinning. They should be rerun after any new edits.

## Important Product Decisions

Candor is local-first:

- Transcripts and notes stay on the user's device.
- Whisper models run locally.
- Calendar token metadata is stored locally; token secrets use operating-system secret storage on Windows.
- No server infrastructure is expected for the app's core functionality.

Calendar integration is now write-capable by product request:

- Microsoft Graph scope: `offline_access User.Read Calendars.ReadWrite`
- Google scope: `https://www.googleapis.com/auth/calendar.readwrite`
- Apple Calendar uses CalDAV with an Apple app-specific password.

This changed the threat model. The app can now create, update, and delete calendar events, so backend validation and renderer compromise resistance matter more.

## Whisper Models

Downloaded model directory:

```text
C:\Users\danny\AppData\Roaming\com.candor.app\models
```

Pinned models:

| Model | File | Size | SHA-256 |
|---|---|---:|---|
| tiny.en | `ggml-tiny.en.bin` | 77,704,715 bytes | `921E4CF8686FDD993DCD081A5DA5B6C365BFDE1162E72B08D75AC75289920B1F` |
| base.en | `ggml-base.en.bin` | 147,964,211 bytes | `A03779C86DF3323075F5E796CB2CE5029F00EC8869EEE3FDFB897AFE36C6D002` |
| small.en | `ggml-small.en.bin` | 487,614,201 bytes | `C6138D6D58ECC8322097E0F987C32F1BE8BB0A18532A3F88F734D1BBF9C41E5D` |

Pinning locations:

- `scripts/tauri-dev.ps1`
- `.env.example`
- `README.md`

The Rust backend reads hash values at compile time through `src-tauri/build.rs` and `option_env!` in `src-tauri/src/lib.rs`.

## Calendar Work Completed

Backend:

- `src-tauri/src/calendar.rs`
  - Microsoft OAuth and Graph event read/write.
  - Google OAuth and Calendar event read/write.
  - Apple CalDAV event read/write.
  - Commands include create, update, and delete calendar event paths.

- `src-tauri/src/lib.rs`
  - Calendar commands are registered in the Tauri invoke handler.

Frontend:

- `src/api/meetings.ts`
  - API wrappers for calendar create, update, and delete.

- `src/screens/Home.tsx`
  - Create Meeting modal with provider, title, start, end, and location.

- `src/components/MeetingMenuHost.tsx`
  - Meeting edit/delete menu support.

- `src/App.tsx`
  - Wires connected calendar providers and create flow.

## Security Review State

The previous blue-team backlog has been closed for the Windows alpha path. Keep the items below as regression checks for future work.

### Closed: Apple CalDAV Event URL Validation

Renderer-supplied Apple `event_url` values are validated before CalDAV reads, writes, and deletes. The backend now requires `https`, rejects query strings and path traversal, checks host and port equality, and only accepts event paths under the connected iCloud calendar home URL.

Primary file:

- `src-tauri/src/calendar.rs`

Evidence:

- `validate_apple_url_under_home`
- `validated_apple_event_url`
- `apple_get_ics`
- `apple_put_ics`
- `apple_delete_event`

### Closed: Plaintext Secret Fallback

Calendar credentials no longer persist to `calendar.json`. `save_auth` writes Microsoft, Google, and Apple secrets through `secret_store`; `calendar.json` receives metadata only. Legacy plaintext values are loaded only for migration, and the metadata file is rewritten without those secret fields.

Primary files:

- `src-tauri/src/calendar.rs`
- `src-tauri/src/secret_store.rs`

Evidence:

- `save_auth`
- `auth_metadata`
- `secure_or_migrate_secret`
- `scripts/audit-source-security.ps1`

### Closed: Audio Path Trust From Markdown Frontmatter

Meeting `audio_path` values are canonicalized and accepted only when they resolve under Candor's managed app audio directory. Unsafe values are ignored for read and delete paths.

Primary file:

- `src-tauri/src/storage.rs`

Evidence:

- `managed_audio_path`
- `meeting_audio_path`
- retention cleanup around `audio_path`
- `delete_meeting`

### Closed: Model Verification Coverage

Transcription entry points use a verified model path before work begins. The selected model must exist and match its pinned SHA-256 before recording stop, import transcription, retry transcription, and recovery transcription.

Primary file:

- `src-tauri/src/lib.rs`

Evidence:

- `verified_model_path`
- `stop_recording`
- `recover_partial_recording`
- `transcribe_imported_audio`
- `retry_transcription`

### Closed: Calendar Write Input Validation

Backend calendar create, update, and delete commands validate provider, event IDs, titles, locations, date parsing, and event ordering. The renderer is still treated as untrusted input.

Primary file:

- `src-tauri/src/calendar.rs`

Evidence:

- `validate_create_payload`
- `validate_update_payload`
- `validate_delete_payload`

### Closed: Documentation Mismatch

Calendar setup docs now describe write permissions and explain that calendar changes are user-initiated.

Primary files:

- `README.md`
- `SECURITY.md`
- `docs/privacy-policy-draft.md`
- `docs/release-checklist.md`

## Remaining Alpha Caveats

- The Windows alpha artifacts are intentionally unsigned until the signing step is handled by release ownership.
- Clean VM execution still needs a real VM host or a hosted runner that exercises install, launch, and uninstall. Local sandbox providers were not available on this machine.
- Dependency advisory scans should be repeated before every release because Rust and npm advisories change over time.
- OAuth and CalDAV live-account flows still need manual verification with release credentials before a public launch.

## Standard Release Gate

Run these before every alpha build:

```powershell
npm run build
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
npm audit --json
cargo audit
npm run audit:release
npm run tauri:release
```

## User Preferences And Product Direction

The user wants:

- Windows first.
- Local-first privacy positioning.
- No subscriptions, no paywalls, no server cost.
- Calendar connection to Microsoft Outlook, Google Calendar, and Apple/iOS Calendar.
- Calendar events populated in-app.
- Ability to create meetings from inside Candor.
- User name captured at onboarding and used throughout the app.
- Settings menu under the user profile area.
- Settings split into sections with scrolling.
- App-wide theme and color customization.
- Profile picture customization.
- No mention of `candor-v2`.
- Marketing-friendly, plain-English copy in the dictionary area.

## Release Readiness Notes

Candor is not ready for a broad public Microsoft Store release until the P1 security items above are fixed and verified.

It may be reasonable for a private alpha only if:

- Testers understand it is pre-release.
- You distribute to a small trusted group.
- You avoid asking users to connect high-value work calendars until the calendar hardening is complete.
- You collect crash reports and bug reports manually.
- You clearly state that transcription and notes are local.

## Communication Notes

The user prefers direct, advisory feedback. Be blunt about security and release readiness. Do not over-polish bad news.
