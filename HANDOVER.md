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
- Calendar tokens are stored locally.
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

The blue-team review was started but not fully completed before this handover. Continue from these findings first.

### P1: Apple CalDAV Event URL Validation

Current risk:

Renderer-supplied Apple `event_url` values reach backend CalDAV calls. Because Apple CalDAV uses a Basic auth header with the user's Apple ID and app-specific password, a compromised renderer could try to make the backend send that Authorization header to an attacker-controlled URL.

Primary files:

- `src-tauri/src/calendar.rs`

Important functions:

- `apple_get_ics`
- `apple_put_ics`
- `apple_delete_event`
- `update_calendar_event`
- `delete_calendar_event`

Recommended fix:

- Validate any renderer-supplied Apple event URL before any CalDAV request.
- Only allow `https://` URLs under the connected Apple calendar home URL.
- Reject URLs outside the discovered iCloud CalDAV calendar root.
- Consider validating final redirected URLs too, if the HTTP helper exposes them.

### P1: Plaintext Secret Fallback

Current risk:

`save_auth` attempts to store calendar secrets in the OS credential manager, then has fallback behavior that can retain secrets in `calendar.json` if retrieval checks fail. For a privacy-first app, token persistence should fail closed instead of silently keeping refresh tokens or app passwords in plaintext.

Primary file:

- `src-tauri/src/calendar.rs`

Recommended fix:

- Remove plaintext fallback for Microsoft refresh token, Google refresh token, Apple email, and Apple app password.
- If OS secret storage fails, return an error and do not save connected state.
- Keep legacy plaintext loading only for migration, then resave without plaintext secrets.

### P1: Audio Path Trust From Markdown Frontmatter

Current risk:

Meeting markdown frontmatter can contain `audio_path`. Some backend commands read or delete files based on that value. If a note file is edited by hand or tampered with, this can become an arbitrary local file read/delete primitive.

Primary file:

- `src-tauri/src/storage.rs`

Relevant areas:

- `meeting_audio_path`
- retention cleanup logic around `audio_path`

Recommended fix:

- Canonicalize `audio_path`.
- Only accept paths under Candor's app audio directory.
- Only delete retained audio files if they are under that directory.
- Return `None` for unsafe paths instead of using them.

### P2: Model Verification Coverage

Current risk:

Model hashes are pinned, but all transcription entry points should verify model integrity immediately before use. Do not rely only on the download path.

Primary file:

- `src-tauri/src/lib.rs`

Search target:

```text
model_path(&app)
```

Recommended fix:

- Add a helper such as `verified_model_path`.
- Require the selected model to exist and match its pinned SHA-256 before recording stop, import transcription, retry transcription, and recovery transcription.

### P2: Calendar Write Input Validation

Current risk:

Calendar create/update commands should validate titles, dates, and event boundaries server-side. The renderer is not a security boundary.

Primary file:

- `src-tauri/src/calendar.rs`

Recommended fix:

- Reject empty titles.
- Reject overly long titles and locations.
- Parse RFC3339 or expected local datetime format consistently.
- Require `end > start`.
- Validate provider is one of `microsoft`, `google`, or `apple`.

### P2: Documentation Mismatch

Current risk:

The docs still mention read-only calendar scopes in some places even though the app now requests write permissions.

Known stale references:

- `README.md`
  - Microsoft Graph scope still listed as `Calendars.Read`
  - Google scope still listed as `calendar.readonly`

Recommended fix:

- Update docs to `Calendars.ReadWrite` and `calendar.readwrite`.
- Explain why write access is requested.
- Update `SECURITY.md` to describe user-initiated calendar modification flows.

## Files Most Likely To Need Attention Next

- `src-tauri/src/calendar.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/storage.rs`
- `src-tauri/src/secret_store.rs`
- `src/App.tsx`
- `src/screens/Home.tsx`
- `src/components/SettingsModal.tsx`
- `src/components/MeetingMenuHost.tsx`
- `README.md`
- `SECURITY.md`

## Suggested Next Pass

1. Patch Apple CalDAV URL validation.
2. Remove plaintext secret fallback in calendar auth storage.
3. Harden `meeting_audio_path` and audio retention deletion.
4. Add verified model path checks before every transcription entry point.
5. Add backend validation for calendar write payloads.
6. Update README and SECURITY docs for write scopes.
7. Run:

```powershell
npm run build
npm run tauri -- build --no-bundle --ci
npm audit --audit-level=moderate
```

8. If installed, run:

```powershell
cargo audit
```

If `cargo audit` is not installed, install it in a separate step or record that dependency advisory scanning remains incomplete.

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
