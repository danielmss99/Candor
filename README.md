# Candor

Desktop meeting recorder with calendar sync.

## Calendar OAuth (developer setup)

End users connect calendars with one click — they never visit Azure or Google Cloud Console.
Register OAuth apps **once** as the Candor developer, add the client IDs to `.env`, and rebuild.

### Microsoft (Outlook / Microsoft 365)

1. Open [Microsoft Entra admin center](https://entra.microsoft.com) → **App registrations** → **New registration**
2. Name: `Candor`
3. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
4. Redirect URI: platform **Mobile and desktop applications** → `http://localhost:8765/callback`
5. After creating the app, copy the **Application (client) ID** into `.env` as `VITE_MS_CLIENT_ID`
6. **Authentication** → Advanced settings → **Allow public client flows**: Yes
7. **API permissions** → Microsoft Graph delegated: `User.Read`, `Calendars.ReadWrite`, `offline_access`

### Google Calendar

1. Open [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Enable **Google Calendar API** for your project
3. **Credentials** → **Create credentials** → **OAuth client ID**
4. Application type: **Desktop app** (recommended — no client secret) or **Web application**
5. Authorized redirect URI: `http://localhost:8721/oauth/google/callback`
6. OAuth consent screen: add scope `https://www.googleapis.com/auth/calendar.readwrite`
7. Copy the client ID into `.env` as `VITE_GOOGLE_CLIENT_ID`
8. If you used a Web application client, also set `CANDOR_GOOGLE_CLIENT_SECRET` in `.env` for release builds

### Build

```bash
cp .env.example .env   # then fill in client IDs
npm install
npm run tauri dev      # development
npm run tauri build    # release installer
```

Set each client ID once as `VITE_MS_CLIENT_ID` / `VITE_GOOGLE_CLIENT_ID` in `.env`. Vite bundles them for the frontend; `src-tauri/build.rs` reads the same file and passes them to Rust at compile time. Restart `npm run tauri dev` after changing `.env`.

Optional overrides: `CANDOR_MS_CLIENT_ID`, `CANDOR_GOOGLE_CLIENT_ID`, or `CANDOR_GOOGLE_CLIENT_SECRET` (Web application Google clients only — never use a `VITE_` prefix for secrets).
