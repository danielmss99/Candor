# Candor

Desktop meeting recorder with calendar sync.

## Calendar OAuth (developer setup)

End users connect calendars with one click. They never visit Azure or Google Cloud Console.
Register OAuth apps **once** as the Candor developer, add the client IDs to `.env`, and rebuild.

### Microsoft (Outlook / Microsoft 365)

1. Open [Microsoft Entra admin center](https://entra.microsoft.com) → **App registrations** → **New registration**
2. Name: `Candor`
3. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
4. Redirect URI: platform **Mobile and desktop applications** → `http://localhost:8765/callback`
5. After creating the app, copy the **Application (client) ID** into `.env` as `VITE_MS_CLIENT_ID`
6. **Authentication** → Advanced settings → **Allow public client flows**: Yes
7. **API permissions** → Microsoft Graph delegated: `offline_access`, `User.Read`, `Calendars.ReadWrite`

### Google Calendar

1. Open [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Enable **Google Calendar API** for your project
3. **Credentials** → **Create credentials** → **OAuth client ID**
4. Application type: **Desktop app** (no client secret)
5. Authorized redirect URI: `http://localhost:8721/oauth/google/callback`
6. OAuth consent screen: add scope `https://www.googleapis.com/auth/calendar.readwrite`
7. Copy the client ID into `.env` as `VITE_GOOGLE_CLIENT_ID`
8. Do not put Google client secrets in `.env` or release-build environment variables

Candor requests calendar write access so users can create, edit, and delete meeting events from inside the app. Calendar changes are user-initiated, and calendar credentials are stored locally in operating-system secret storage where available.

### Build

```bash
cp .env.example .env   # then fill in client IDs
npm install
npm run tauri dev      # development
npm run tauri build    # release installer
npm run build:all      # same as build + tauri build
```

### CI (GitHub Actions)

Every push to `main` runs the [Tauri Desktop Build](.github/workflows/tauri-build.yml) workflow on `windows-latest`: Node frontend build, then a full `npm run tauri build` (including whisper-rs native compile). Installers (`.exe`, `.msi`) are uploaded as artifacts on push runs.

For a Microsoft Store candidate, run the workflow manually or run `npm run build:store` locally. Store builds use `src-tauri/tauri.store.conf.json`, which switches WebView2 to the offline installer mode required for Store-style packaging.

To download a build: open the repo on GitHub → **Actions** → select the workflow run → scroll to **Artifacts** → download `candor-windows-<commit-sha>`.

The first run or a cold cache can take a while because whisper.cpp is compiled from source. Cached Rust dependencies shorten later runs.

Set each client ID once as `VITE_MS_CLIENT_ID` / `VITE_GOOGLE_CLIENT_ID` in `.env`. Vite bundles them for the frontend; `src-tauri/build.rs` reads the same file and passes them to Rust at compile time. Restart `npm run tauri dev` after changing `.env`.

Optional public client ID overrides: `CANDOR_MS_CLIENT_ID` and `CANDOR_GOOGLE_CLIENT_ID`. Google client secrets are runtime-only and must not be compiled into release builds.

Speech model downloads are SHA-256 checked before use. Set these at build time for release builds:

- `CANDOR_SHA256_TINY_EN=921E4CF8686FDD993DCD081A5DA5B6C365BFDE1162E72B08D75AC75289920B1F`
- `CANDOR_SHA256_BASE_EN=A03779C86DF3323075F5E796CB2CE5029F00EC8869EEE3FDFB897AFE36C6D002`
- `CANDOR_SHA256_SMALL_EN=C6138D6D58ECC8322097E0F987C32F1BE8BB0A18532A3F88F734D1BBF9C41E5D`

The local dev script and `.env.example` include all three model hashes.
