// Calendar integration. Microsoft (Outlook/365) and Google Calendar via browser
// OAuth (PKCE + localhost callback). Apple/iCloud uses CalDAV. Tokens are stored
// locally in the app data dir.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use chrono::{DateTime, SecondsFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::secret_store;

const SCOPE: &str = "offline_access User.Read Calendars.ReadWrite";
const AUTHORIZE_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_CALENDARVIEW: &str = "https://graph.microsoft.com/v1.0/me/calendarView";
const MS_OAUTH_PORT: u16 = 8765;
const MS_REDIRECT_PATH: &str = "/callback";
const MS_OAUTH_TIMEOUT_SECS: u64 = 300;

const GOOGLE_SCOPE: &str = "https://www.googleapis.com/auth/calendar.readwrite";
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_EVENTS_URL: &str = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_OAUTH_PORT: u16 = 8721;
const GOOGLE_REDIRECT_PATH: &str = "/oauth/google/callback";

/// Optional compile-time client ID (`CANDOR_MS_CLIENT_ID` env at build time).
fn default_ms_client_id() -> Option<String> {
    option_env!("CANDOR_MS_CLIENT_ID")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Optional compile-time Google OAuth client ID (`CANDOR_GOOGLE_CLIENT_ID`).
fn default_google_client_id() -> Option<String> {
    option_env!("CANDOR_GOOGLE_CLIENT_ID")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Google client secrets are intentionally runtime-only so they are never
/// compiled into a public desktop binary.
fn default_google_client_secret() -> Option<String> {
    None
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// An ureq agent that returns 4xx/5xx as Ok responses (so we can read error bodies).
fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into()
}

#[derive(Serialize)]
pub struct CalendarEvent {
    id: String,
    title: String,
    start: String,
    end: String,
    attendees: Vec<String>,
    organizer: String,
    location: String,
    #[serde(rename = "onlineUrl")]
    online_url: Option<String>,
    #[serde(rename = "allDay")]
    all_day: bool,
    provider: String,
    #[serde(rename = "eventUrl")]
    event_url: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct StoredAuth {
    ms_client_id: Option<String>,
    ms_access_token: Option<String>,
    ms_refresh_token: Option<String>,
    ms_expires_at: Option<i64>,
    google_client_id: Option<String>,
    google_client_secret: Option<String>,
    google_access_token: Option<String>,
    google_refresh_token: Option<String>,
    google_expires_at: Option<i64>,
    // Apple/iCloud
    apple_id: Option<String>,
    apple_app_password: Option<String>,
    apple_calendar_url: Option<String>,
}

const SECRET_MS_ACCESS: &str = "calendar.microsoft.access_token";
const SECRET_MS_REFRESH: &str = "calendar.microsoft.refresh_token";
const SECRET_GOOGLE_CLIENT_SECRET: &str = "calendar.google.client_secret";
const SECRET_GOOGLE_ACCESS: &str = "calendar.google.access_token";
const SECRET_GOOGLE_REFRESH: &str = "calendar.google.refresh_token";
const SECRET_APPLE_ID: &str = "calendar.apple.id";
const SECRET_APPLE_APP_PASSWORD: &str = "calendar.apple.app_password";

fn auth_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("calendar.json"))
}

fn auth_has_plaintext_secrets(auth: &StoredAuth) -> bool {
    auth.ms_access_token.is_some()
        || auth.ms_refresh_token.is_some()
        || auth.google_client_secret.is_some()
        || auth.google_access_token.is_some()
        || auth.google_refresh_token.is_some()
        || auth.apple_id.is_some()
        || auth.apple_app_password.is_some()
}

fn auth_metadata(auth: &StoredAuth) -> StoredAuth {
    StoredAuth {
        ms_client_id: auth.ms_client_id.clone(),
        ms_expires_at: auth.ms_expires_at,
        google_client_id: auth.google_client_id.clone(),
        google_expires_at: auth.google_expires_at,
        apple_calendar_url: auth.apple_calendar_url.clone(),
        ..StoredAuth::default()
    }
}

fn write_auth_metadata(app: &AppHandle, auth: &StoredAuth) -> Result<(), String> {
    let p = auth_path(app)?;
    let json = serde_json::to_string_pretty(&auth_metadata(auth)).map_err(|e| e.to_string())?;
    std::fs::write(p, json).map_err(|e| e.to_string())
}

fn secure_or_migrate_secret(
    app: &AppHandle,
    name: &str,
    legacy_value: Option<String>,
) -> Option<String> {
    if let Some(value) = secret_store::get_secret(app, name).filter(|s| !s.trim().is_empty()) {
        return Some(value);
    }

    let value = legacy_value.filter(|s| !s.trim().is_empty())?;
    if secret_store::set_secret(app, name, Some(&value)).is_ok() {
        Some(value)
    } else {
        None
    }
}

fn load_auth(app: &AppHandle) -> StoredAuth {
    let mut auth: StoredAuth = auth_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let had_plaintext_secrets = auth_has_plaintext_secrets(&auth);

    auth.ms_access_token =
        secure_or_migrate_secret(app, SECRET_MS_ACCESS, auth.ms_access_token.take());
    auth.ms_refresh_token =
        secure_or_migrate_secret(app, SECRET_MS_REFRESH, auth.ms_refresh_token.take());
    auth.google_client_secret = secure_or_migrate_secret(
        app,
        SECRET_GOOGLE_CLIENT_SECRET,
        auth.google_client_secret.take(),
    );
    auth.google_access_token =
        secure_or_migrate_secret(app, SECRET_GOOGLE_ACCESS, auth.google_access_token.take());
    auth.google_refresh_token =
        secure_or_migrate_secret(app, SECRET_GOOGLE_REFRESH, auth.google_refresh_token.take());
    auth.apple_id = secure_or_migrate_secret(app, SECRET_APPLE_ID, auth.apple_id.take());
    auth.apple_app_password = secure_or_migrate_secret(
        app,
        SECRET_APPLE_APP_PASSWORD,
        auth.apple_app_password.take(),
    );

    if had_plaintext_secrets {
        let _ = write_auth_metadata(app, &auth);
    }

    auth
}

fn save_auth(app: &AppHandle, a: &StoredAuth) -> Result<(), String> {
    secret_store::set_secret(app, SECRET_MS_ACCESS, a.ms_access_token.as_deref())?;
    secret_store::set_secret(app, SECRET_MS_REFRESH, a.ms_refresh_token.as_deref())?;
    secret_store::set_secret(
        app,
        SECRET_GOOGLE_CLIENT_SECRET,
        a.google_client_secret.as_deref(),
    )?;
    secret_store::set_secret(app, SECRET_GOOGLE_ACCESS, a.google_access_token.as_deref())?;
    secret_store::set_secret(
        app,
        SECRET_GOOGLE_REFRESH,
        a.google_refresh_token.as_deref(),
    )?;
    secret_store::set_secret(app, SECRET_APPLE_ID, a.apple_id.as_deref())?;
    secret_store::set_secret(
        app,
        SECRET_APPLE_APP_PASSWORD,
        a.apple_app_password.as_deref(),
    )?;

    write_auth_metadata(app, a)
}

// ---------- Status ----------

#[derive(Serialize)]
pub struct CalendarStatus {
    microsoft: bool,
    google: bool,
    apple: bool,
}

#[derive(Serialize)]
pub struct MsCalendarSetup {
    #[serde(rename = "storedClientId")]
    stored_client_id: Option<String>,
    #[serde(rename = "defaultClientId")]
    default_client_id: Option<String>,
    /// Redirect URI to register once in Azure (Authentication → Add platform → Mobile/desktop).
    #[serde(rename = "redirectUri")]
    redirect_uri: String,
}

#[tauri::command]
pub fn ms_calendar_setup(_app: AppHandle) -> MsCalendarSetup {
    MsCalendarSetup {
        stored_client_id: load_auth(&_app).ms_client_id.clone(),
        default_client_id: default_ms_client_id(),
        redirect_uri: ms_redirect_uri(MS_OAUTH_PORT),
    }
}

#[tauri::command]
pub fn calendar_status(app: AppHandle) -> CalendarStatus {
    let a = load_auth(&app);
    CalendarStatus {
        microsoft: a.ms_refresh_token.is_some(),
        google: a.google_refresh_token.is_some(),
        apple: a.apple_id.is_some(),
    }
}

// ---------- Microsoft browser OAuth (PKCE + localhost callback) ----------

fn ms_redirect_uri(port: u16) -> String {
    format!("http://localhost:{port}{MS_REDIRECT_PATH}")
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

struct PkcePair {
    verifier: String,
    challenge: String,
}

fn generate_pkce() -> PkcePair {
    let u1 = uuid::Uuid::new_v4();
    let u2 = uuid::Uuid::new_v4();
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(u1.as_bytes());
    bytes[16..].copy_from_slice(u2.as_bytes());
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    PkcePair {
        verifier,
        challenge,
    }
}

fn bind_oauth_listener(base_port: u16) -> Result<(TcpListener, u16), String> {
    for port in base_port..=base_port + 10 {
        match TcpListener::bind(format!("127.0.0.1:{port}")) {
            Ok(listener) => return Ok((listener, port)),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(e) => return Err(format!("Couldn't start sign-in listener: {e}")),
        }
    }
    Err(format!(
        "Ports {base_port}–{} are in use — close other apps using them and try again.",
        base_port + 10
    ))
}

fn parse_query_params(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((k.to_string(), url_decode(v)))
        })
        .collect()
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_from_http_request(req: &str) -> HashMap<String, String> {
    let path = req
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .nth(1)
        .unwrap_or("");
    let query = path.split('?').nth(1).unwrap_or("");
    parse_query_params(query)
}

fn send_oauth_html(stream: &mut TcpStream, title: &str, message: &str) {
    let body = format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body style=\"font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem\">\
         <h1>{title}</h1><p>{message}</p></body></html>"
    );
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

fn wait_for_oauth_callback(
    listener: &TcpListener,
    expected_state: &str,
    success_title: &str,
) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Listener error: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(MS_OAUTH_TIMEOUT_SECS);

    loop {
        if Instant::now() >= deadline {
            return Err("Timed out waiting for sign-in — try again.".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buf = vec![0u8; 8192];
                let n = stream
                    .read(&mut buf)
                    .map_err(|e| format!("Callback read error: {e}"))?;
                let req = String::from_utf8_lossy(&buf[..n]);
                let params = query_from_http_request(&req);

                if let Some(err) = params.get("error") {
                    let desc = params
                        .get("error_description")
                        .map(|s| s.as_str())
                        .unwrap_or(err);
                    send_oauth_html(
                        &mut stream,
                        "Sign-in failed",
                        "Return to Candor and try again.",
                    );
                    return Err(desc.to_string());
                }

                if params.get("state").map(|s| s.as_str()) != Some(expected_state) {
                    send_oauth_html(
                        &mut stream,
                        "Sign-in failed",
                        "Security check failed. Return to Candor and try again.",
                    );
                    return Err("Sign-in state mismatch — try again.".into());
                }

                if let Some(code) = params.get("code").cloned() {
                    send_oauth_html(
                        &mut stream,
                        success_title,
                        "You can close this tab and return to Candor.",
                    );
                    return Ok(code);
                }

                send_oauth_html(
                    &mut stream,
                    "Candor",
                    "Waiting for sign-in… return to the Microsoft page if needed.",
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("Callback listener error: {e}")),
        }
    }
}

fn save_ms_tokens(app: &AppHandle, v: &serde_json::Value) -> Result<(), String> {
    let access = v["access_token"]
        .as_str()
        .ok_or("Microsoft didn't return an access token.")?;
    let refresh = v["refresh_token"].as_str().ok_or(
        "Microsoft didn't return a refresh token. In Azure, add offline_access permission and enable public client flows.",
    )?;
    let mut a = load_auth(app);
    a.ms_access_token = Some(access.to_string());
    a.ms_refresh_token = Some(refresh.to_string());
    a.ms_expires_at = Some(now_secs() + v["expires_in"].as_i64().unwrap_or(3600) - 60);
    save_auth(app, &a)
}

fn exchange_auth_code(
    app: &AppHandle,
    client_id: &str,
    redirect_uri: &str,
    code: &str,
    code_verifier: &str,
) -> Result<(), String> {
    let resp = agent()
        .post(TOKEN_URL)
        .send_form([
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", code_verifier),
            ("scope", SCOPE),
        ])
        .map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .into_body()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(v["error_description"]
            .as_str()
            .or(v["error"].as_str())
            .unwrap_or("Microsoft rejected the sign-in. Check the redirect URI in Azure matches http://localhost:8765/callback.")
            .to_string());
    }
    save_ms_tokens(app, &v)
}

fn do_oauth_connect(app: &AppHandle, client_id: String) -> Result<(), String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err(
            "Microsoft calendar sign-in isn't configured in this build. Update Candor or contact support."
                .into(),
        );
    }

    let (listener, port) = bind_oauth_listener(MS_OAUTH_PORT)?;
    let redirect_uri = ms_redirect_uri(port);
    let pkce = generate_pkce();
    let state = uuid::Uuid::new_v4().to_string();

    let auth_url = format!(
        "{AUTHORIZE_URL}?client_id={}&response_type=code&redirect_uri={}&response_mode=query&scope={}&state={}&code_challenge={}&code_challenge_method=S256&prompt=select_account",
        url_encode(&client_id),
        url_encode(&redirect_uri),
        url_encode(SCOPE),
        url_encode(&state),
        url_encode(&pkce.challenge),
    );

    let mut a = load_auth(app);
    a.ms_client_id = Some(client_id.clone());
    save_auth(app, &a)?;

    tauri_plugin_opener::open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("Couldn't open your browser: {e}"))?;

    let code = wait_for_oauth_callback(&listener, &state, "Outlook connected")?;
    exchange_auth_code(app, &client_id, &redirect_uri, &code, &pkce.verifier)
}

#[tauri::command]
pub async fn ms_oauth_connect(app: AppHandle, client_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || do_oauth_connect(&app, client_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn ms_disconnect(app: AppHandle) -> Result<(), String> {
    let mut a = load_auth(&app);
    a.ms_access_token = None;
    a.ms_refresh_token = None;
    a.ms_expires_at = None;
    save_auth(&app, &a)
}

// ---------- Google browser OAuth (PKCE + localhost callback) ----------

fn oauth_redirect_uri(port: u16, path: &str) -> String {
    format!("http://localhost:{port}{path}")
}

#[derive(Serialize)]
pub struct GoogleCalendarSetup {
    #[serde(rename = "storedClientId")]
    stored_client_id: Option<String>,
    #[serde(rename = "defaultClientId")]
    default_client_id: Option<String>,
    #[serde(rename = "redirectUri")]
    redirect_uri: String,
    #[serde(rename = "hasClientSecret")]
    has_client_secret: bool,
}

#[tauri::command]
pub fn google_calendar_setup(app: AppHandle) -> GoogleCalendarSetup {
    let a = load_auth(&app);
    GoogleCalendarSetup {
        stored_client_id: a.google_client_id.clone(),
        default_client_id: default_google_client_id(),
        redirect_uri: oauth_redirect_uri(GOOGLE_OAUTH_PORT, GOOGLE_REDIRECT_PATH),
        has_client_secret: a.google_client_secret.is_some()
            || default_google_client_secret().is_some(),
    }
}

fn save_google_tokens(app: &AppHandle, v: &serde_json::Value) -> Result<(), String> {
    let access = v["access_token"]
        .as_str()
        .ok_or("Google didn't return an access token.")?;
    let refresh = v["refresh_token"].as_str().ok_or(
        "Google didn't return a refresh token. Disconnect and reconnect, approving all requested permissions.",
    )?;
    let mut a = load_auth(app);
    a.google_access_token = Some(access.to_string());
    a.google_refresh_token = Some(refresh.to_string());
    a.google_expires_at = Some(now_secs() + v["expires_in"].as_i64().unwrap_or(3600) - 60);
    save_auth(app, &a)
}

fn exchange_google_auth_code(
    app: &AppHandle,
    client_id: &str,
    client_secret: Option<&str>,
    redirect_uri: &str,
    code: &str,
    code_verifier: &str,
) -> Result<(), String> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", code_verifier),
    ];
    if let Some(secret) = client_secret.filter(|s| !s.is_empty()) {
        form.push(("client_secret", secret));
    }
    let resp = agent()
        .post(GOOGLE_TOKEN_URL)
        .send_form(form)
        .map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .into_body()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(v["error_description"]
            .as_str()
            .or(v["error"].as_str())
            .unwrap_or(
                "Google rejected the sign-in. Check the redirect URI in Google Cloud Console.",
            )
            .to_string());
    }
    save_google_tokens(app, &v)
}

fn do_google_oauth_connect(
    app: &AppHandle,
    client_id: String,
    client_secret: Option<String>,
) -> Result<(), String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err(
            "Google Calendar sign-in isn't configured in this build. Update Candor or contact support."
                .into(),
        );
    }

    let secret = client_secret
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| load_auth(app).google_client_secret.clone())
        .or_else(default_google_client_secret);

    let (listener, port) = bind_oauth_listener(GOOGLE_OAUTH_PORT)?;
    let redirect_uri = oauth_redirect_uri(port, GOOGLE_REDIRECT_PATH);
    let pkce = generate_pkce();
    let state = uuid::Uuid::new_v4().to_string();

    let auth_url = format!(
        "{GOOGLE_AUTH_URL}?client_id={}&response_type=code&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        url_encode(&client_id),
        url_encode(&redirect_uri),
        url_encode(GOOGLE_SCOPE),
        url_encode(&state),
        url_encode(&pkce.challenge),
    );

    let mut a = load_auth(app);
    a.google_client_id = Some(client_id.clone());
    if secret.is_some() {
        a.google_client_secret = secret.clone();
    }
    save_auth(app, &a)?;

    tauri_plugin_opener::open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("Couldn't open your browser: {e}"))?;

    let code = wait_for_oauth_callback(&listener, &state, "Google Calendar connected")?;
    exchange_google_auth_code(
        app,
        &client_id,
        secret.as_deref(),
        &redirect_uri,
        &code,
        &pkce.verifier,
    )
}

#[tauri::command]
pub async fn google_oauth_connect(
    app: AppHandle,
    client_id: String,
    client_secret: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        do_google_oauth_connect(&app, client_id, client_secret)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn google_disconnect(app: AppHandle) -> Result<(), String> {
    let mut a = load_auth(&app);
    a.google_access_token = None;
    a.google_refresh_token = None;
    a.google_expires_at = None;
    save_auth(&app, &a)
}

fn google_valid_token(app: &AppHandle) -> Result<String, String> {
    let a = load_auth(app);
    if let Some(t) = a.google_access_token.clone() {
        if now_secs() < a.google_expires_at.unwrap_or(0) {
            return Ok(t);
        }
    }
    let client_id = a.google_client_id.clone().ok_or("Google not connected.")?;
    let refresh = a
        .google_refresh_token
        .clone()
        .ok_or("Google not connected.")?;
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("client_id", client_id.as_str()),
        ("refresh_token", refresh.as_str()),
    ];
    if let Some(secret) = a.google_client_secret.as_deref().filter(|s| !s.is_empty()) {
        form.push(("client_secret", secret));
    }
    let resp = agent()
        .post(GOOGLE_TOKEN_URL)
        .send_form(form)
        .map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .into_body()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(v["error_description"]
            .as_str()
            .unwrap_or("Google session expired — reconnect Google Calendar.")
            .to_string());
    }
    let mut a2 = load_auth(app);
    let access = v["access_token"]
        .as_str()
        .ok_or("No access token.")?
        .to_string();
    a2.google_access_token = Some(access.clone());
    if let Some(r) = v["refresh_token"].as_str() {
        a2.google_refresh_token = Some(r.to_string());
    }
    a2.google_expires_at = Some(now_secs() + v["expires_in"].as_i64().unwrap_or(3600) - 60);
    save_auth(app, &a2)?;
    Ok(access)
}

fn google_events(app: &AppHandle) -> Result<Vec<CalendarEvent>, String> {
    let token = google_valid_token(app)?;
    let start = (chrono::Utc::now() - chrono::Duration::days(1)).format("%Y-%m-%dT%H:%M:%SZ");
    let end = (chrono::Utc::now() + chrono::Duration::days(14)).format("%Y-%m-%dT%H:%M:%SZ");
    let url = format!(
        "{GOOGLE_EVENTS_URL}?timeMin={start}&timeMax={end}&singleEvents=true&orderBy=startTime&maxResults=50"
    );
    let resp = agent()
        .get(&url)
        .header("authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("Google Calendar request failed: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .into_body()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if status != 200 {
        let msg = v["error"]["message"]
            .as_str()
            .unwrap_or("Google Calendar rejected the request.");
        if status == 401 || status == 403 {
            return Err(format!(
                "{msg} — disconnect Google in account settings, then reconnect to refresh permissions."
            ));
        }
        return Err(format!("Google Calendar error ({status}): {msg}"));
    }

    let mut out = Vec::new();
    if let Some(items) = v["items"].as_array() {
        for it in items {
            let (start, all_day) = if let Some(dt) = it["start"]["dateTime"].as_str() {
                (dt.to_string(), false)
            } else {
                let d = it["start"]["date"].as_str().unwrap_or("");
                (format!("{d}T00:00:00"), true)
            };
            let end = it["end"]["dateTime"]
                .as_str()
                .or(it["end"]["date"].as_str())
                .unwrap_or("")
                .to_string();
            let attendees = it["attendees"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|p| {
                            p["displayName"]
                                .as_str()
                                .or(p["email"].as_str())
                                .map(|s| s.to_string())
                        })
                        .collect()
                })
                .unwrap_or_default();
            let online_url = it["hangoutLink"]
                .as_str()
                .or(it["conferenceData"]["entryPoints"]
                    .as_array()
                    .and_then(|arr| arr.first())
                    .and_then(|ep| ep["uri"].as_str()))
                .map(|s| s.to_string());
            out.push(CalendarEvent {
                id: it["id"].as_str().unwrap_or("").to_string(),
                title: it["summary"].as_str().unwrap_or("(no subject)").to_string(),
                start,
                end,
                attendees,
                organizer: it["organizer"]["displayName"]
                    .as_str()
                    .or(it["organizer"]["email"].as_str())
                    .unwrap_or("")
                    .to_string(),
                location: it["location"].as_str().unwrap_or("").to_string(),
                online_url,
                all_day,
                provider: "google".into(),
                event_url: it["htmlLink"].as_str().map(|s| s.to_string()),
            });
        }
    }
    Ok(out)
}

// ---------- Microsoft Graph events ----------

fn ms_valid_token(app: &AppHandle) -> Result<String, String> {
    let a = load_auth(app);
    if let Some(t) = a.ms_access_token.clone() {
        if now_secs() < a.ms_expires_at.unwrap_or(0) {
            return Ok(t);
        }
    }
    // Refresh
    let client_id = a.ms_client_id.clone().ok_or("Microsoft not connected.")?;
    let refresh = a
        .ms_refresh_token
        .clone()
        .ok_or("Microsoft not connected.")?;
    let resp = agent()
        .post(TOKEN_URL)
        .send_form([
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", refresh.as_str()),
            ("scope", SCOPE),
        ])
        .map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .into_body()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(v["error_description"]
            .as_str()
            .unwrap_or("Session expired — reconnect Outlook.")
            .to_string());
    }
    let mut a2 = load_auth(app);
    let access = v["access_token"]
        .as_str()
        .ok_or("No access token.")?
        .to_string();
    a2.ms_access_token = Some(access.clone());
    if let Some(r) = v["refresh_token"].as_str() {
        a2.ms_refresh_token = Some(r.to_string());
    }
    a2.ms_expires_at = Some(now_secs() + v["expires_in"].as_i64().unwrap_or(3600) - 60);
    save_auth(app, &a2)?;
    Ok(access)
}

fn ms_events(app: &AppHandle) -> Result<Vec<CalendarEvent>, String> {
    let token = ms_valid_token(app)?;
    let start = chrono::Utc::now() - chrono::Duration::days(1);
    let end = chrono::Utc::now() + chrono::Duration::days(14);
    let url = format!(
        "{}?startDateTime={}&endDateTime={}&$orderby=start/dateTime&$top=50&$select=subject,start,end,attendees,organizer,location,onlineMeeting,isAllDay",
        GRAPH_CALENDARVIEW,
        start.format("%Y-%m-%dT%H:%M:%SZ"),
        end.format("%Y-%m-%dT%H:%M:%SZ"),
    );
    let resp = agent()
        .get(&url)
        .header("authorization", &format!("Bearer {token}"))
        .header("prefer", "outlook.timezone=\"UTC\"")
        .call()
        .map_err(|e| format!("Graph request failed: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .into_body()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if status != 200 {
        let msg = v["error"]["message"]
            .as_str()
            .or(v["error_description"].as_str())
            .unwrap_or("Microsoft Graph rejected the calendar request.");
        if status == 401 || status == 403 {
            return Err(format!(
                "{msg} — disconnect Outlook in account settings, then reconnect to refresh permissions."
            ));
        }
        return Err(format!("Outlook calendar error ({status}): {msg}"));
    }

    let mut out = Vec::new();
    if let Some(items) = v["value"].as_array() {
        for it in items {
            let attendees = it["attendees"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|p| p["emailAddress"]["name"].as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            out.push(CalendarEvent {
                id: it["id"].as_str().unwrap_or("").to_string(),
                title: it["subject"].as_str().unwrap_or("(no subject)").to_string(),
                start: it["start"]["dateTime"].as_str().unwrap_or("").to_string(),
                end: it["end"]["dateTime"].as_str().unwrap_or("").to_string(),
                attendees,
                organizer: it["organizer"]["emailAddress"]["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                location: it["location"]["displayName"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                online_url: it["onlineMeeting"]["joinUrl"]
                    .as_str()
                    .map(|s| s.to_string()),
                all_day: it["isAllDay"].as_bool().unwrap_or(false),
                provider: "microsoft".into(),
                event_url: None,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_events(app: AppHandle) -> Result<Vec<CalendarEvent>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let a = load_auth(&app);
        let mut events = Vec::new();
        let mut errors = Vec::new();
        if a.ms_refresh_token.is_some() {
            match ms_events(&app) {
                Ok(mut e) => events.append(&mut e),
                Err(e) => errors.push(format!("Outlook: {e}")),
            }
        }
        if a.google_refresh_token.is_some() {
            match google_events(&app) {
                Ok(mut e) => events.append(&mut e),
                Err(e) => errors.push(format!("Google: {e}")),
            }
        }
        if a.apple_id.is_some() {
            match apple_events(&app) {
                Ok(mut e) => events.append(&mut e),
                Err(e) => errors.push(format!("iCloud: {e}")),
            }
        }
        if events.is_empty() && !errors.is_empty() {
            return Err(errors.join("; "));
        }
        events.sort_by(|x, y| x.start.cmp(&y.start));
        Ok(events)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Apple / iCloud (CalDAV) ----------

const ICLOUD_CALDAV: &str = "https://caldav.icloud.com/";

fn caldav_agent() -> ureq::Agent {
    // Manual redirect handling so PROPFIND/REPORT methods survive iCloud's
    // partition hops, and 4xx is readable. WebDAV methods are non-standard for
    // ureq's HTTP/1.1 encoder — must opt in explicitly.
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .allow_non_standard_methods(true)
        .build()
        .into()
}

fn basic_auth(user: &str, pass: &str) -> String {
    let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
    format!("Basic {token}")
}

fn origin_of(url: &str) -> String {
    let after = url.find("://").map(|i| i + 3).unwrap_or(0);
    let end = url[after..]
        .find('/')
        .map(|i| after + i)
        .unwrap_or(url.len());
    url[..end].to_string()
}

fn resolve(base: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        href.to_string()
    } else {
        format!("{}{}", origin_of(base), href)
    }
}

fn caldav_method(name: &str) -> Result<http::Method, String> {
    http::Method::from_bytes(name.as_bytes())
        .map_err(|_| format!("Unsupported CalDAV method: {name}"))
}

fn caldav_transport_err(e: ureq::Error) -> String {
    let msg = e.to_string();
    if msg.contains("not valid for HTTP") {
        return "CalDAV protocol error — update Candor to the latest version.".into();
    }
    format!("Could not reach iCloud ({msg}). Check your internet connection and try again.")
}

/// One CalDAV request, following redirects manually (preserving the method).
/// Returns (status, final_url, body).
fn caldav(
    method: &str,
    url: &str,
    auth: &str,
    depth: &str,
    body: &str,
) -> Result<(u16, String, String), String> {
    caldav_with_url_validator(method, url, auth, depth, body, |_| Ok(()))
}

fn caldav_with_url_validator<F>(
    method: &str,
    url: &str,
    auth: &str,
    depth: &str,
    body: &str,
    validate_url: F,
) -> Result<(u16, String, String), String>
where
    F: Fn(&str) -> Result<(), String>,
{
    let http_method = caldav_method(method)?;
    let agent = caldav_agent();
    let mut current = url.to_string();
    for _ in 0..6 {
        validate_url(&current)?;
        let req = http::Request::builder()
            .method(&http_method)
            .uri(&current)
            .header("authorization", auth)
            .header("depth", depth)
            .header("content-type", "application/xml; charset=utf-8")
            .body(body.to_string())
            .map_err(|e| e.to_string())?;
        let resp = agent.run(req).map_err(caldav_transport_err)?;
        let status = resp.status().as_u16();
        if matches!(status, 301 | 302 | 307 | 308) {
            if let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok()) {
                let next = resolve(&current, loc);
                validate_url(&next)?;
                current = next;
                continue;
            }
        }
        let text = resp
            .into_body()
            .read_to_string()
            .map_err(|e| e.to_string())?;
        return Ok((status, current, text));
    }
    Err("Too many redirects from iCloud.".into())
}

fn caldav_auth_err(status: u16) -> Option<String> {
    match status {
        401 | 403 => Some(
            "Wrong Apple ID or app-specific password. Create a new app-specific password at appleid.apple.com → Sign-In and Security → App-Specific Passwords.".into(),
        ),
        _ => None,
    }
}

/// First `<href>` inside the first element with one of the given local names.
fn xml_href_under(xml: &str, names: &[&str]) -> Option<String> {
    let doc = roxmltree::Document::parse(xml).ok()?;
    for node in doc.descendants() {
        if names.contains(&node.tag_name().name()) {
            for d in node.descendants() {
                if d.tag_name().name() == "href" {
                    if let Some(t) = d.text() {
                        return Some(t.trim().to_string());
                    }
                }
            }
        }
    }
    None
}

fn discover_home(apple_id: &str, app_pw: &str) -> Result<String, String> {
    let auth = basic_auth(apple_id, app_pw);
    let principal_body = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#;
    let (status, final_url, xml) = caldav("PROPFIND", ICLOUD_CALDAV, &auth, "0", principal_body)?;
    if let Some(msg) = caldav_auth_err(status) {
        return Err(msg);
    }
    if status != 207 && status != 200 {
        return Err(format!(
            "iCloud rejected the connection (HTTP {status}). If your credentials are correct, try again in a few minutes."
        ));
    }
    let principal = resolve(
        &final_url,
        &xml_href_under(&xml, &["current-user-principal"])
            .ok_or("Couldn't find your iCloud account.")?,
    );

    let home_body = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>"#;
    let (_s, fu, xml2) = caldav("PROPFIND", &principal, &auth, "0", home_body)?;
    let home = resolve(
        &fu,
        &xml_href_under(&xml2, &["calendar-home-set"])
            .ok_or("Couldn't find your iCloud calendars.")?,
    );
    Ok(home)
}

fn do_apple_connect(app: &AppHandle, apple_id: String, app_password: String) -> Result<(), String> {
    let apple_id = apple_id.trim().to_string();
    let app_password = app_password.trim().to_string();
    if apple_id.is_empty() || app_password.is_empty() {
        return Err("Enter your Apple ID and app-specific password.".into());
    }
    let home = discover_home(&apple_id, &app_password)?;
    let mut a = load_auth(app);
    a.apple_id = Some(apple_id);
    a.apple_app_password = Some(app_password);
    a.apple_calendar_url = Some(home);
    save_auth(app, &a)?;
    Ok(())
}

#[tauri::command]
pub async fn apple_connect(
    app: AppHandle,
    apple_id: String,
    app_password: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || do_apple_connect(&app, apple_id, app_password))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn apple_disconnect(app: AppHandle) -> Result<(), String> {
    let mut a = load_auth(&app);
    a.apple_id = None;
    a.apple_app_password = None;
    a.apple_calendar_url = None;
    save_auth(&app, &a)
}

/// Hrefs of child collections that are calendars.
fn calendar_hrefs(xml: &str) -> Vec<String> {
    let doc = match roxmltree::Document::parse(xml) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for resp in doc
        .descendants()
        .filter(|n| n.tag_name().name() == "response")
    {
        let is_calendar = resp
            .descendants()
            .any(|n| n.tag_name().name() == "calendar");
        if !is_calendar {
            continue;
        }
        if let Some(href) = resp
            .descendants()
            .find(|n| n.tag_name().name() == "href")
            .and_then(|n| n.text())
        {
            out.push(href.trim().to_string());
        }
    }
    out
}

fn calendar_data_blocks(xml: &str) -> Vec<String> {
    match roxmltree::Document::parse(xml) {
        Ok(doc) => doc
            .descendants()
            .filter(|n| n.tag_name().name() == "calendar-data")
            .filter_map(|n| n.text().map(|t| t.to_string()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// iCal datetime → ISO-ish string + all-day flag.
fn ical_dt(value: &str) -> (String, bool) {
    let v = value.trim();
    if v.len() == 8 && v.chars().all(|c| c.is_ascii_digit()) {
        return (
            format!("{}-{}-{}T00:00:00", &v[0..4], &v[4..6], &v[6..8]),
            true,
        );
    }
    if v.len() >= 15 {
        let z = if v.ends_with('Z') { "Z" } else { "" };
        let (d, t) = (&v[0..8], &v[9..15]);
        return (
            format!(
                "{}-{}-{}T{}:{}:{}{}",
                &d[0..4],
                &d[4..6],
                &d[6..8],
                &t[0..2],
                &t[2..4],
                &t[4..6],
                z
            ),
            false,
        );
    }
    (v.to_string(), false)
}

/// Pull a CN= parameter (display name) out of an ATTENDEE/ORGANIZER line.
fn cn_param(name_params: &str) -> Option<String> {
    for part in name_params.split(';') {
        if let Some(cn) = part.strip_prefix("CN=") {
            let cn = cn.trim_matches('"').trim();
            if !cn.is_empty() {
                return Some(cn.to_string());
            }
        }
    }
    None
}

fn parse_vevents(ics: &str, event_url: Option<String>) -> Vec<CalendarEvent> {
    // Unfold folded lines (continuations start with space/tab).
    let mut lines: Vec<String> = Vec::new();
    for raw in ics.split('\n') {
        let line = raw.trim_end_matches('\r');
        if (line.starts_with(' ') || line.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().unwrap().push_str(&line[1..]);
        } else {
            lines.push(line.to_string());
        }
    }

    let mut events = Vec::new();
    let mut cur: Option<CalendarEvent> = None;
    for line in &lines {
        if line == "BEGIN:VEVENT" {
            cur = Some(CalendarEvent {
                id: String::new(),
                title: "(no title)".into(),
                start: String::new(),
                end: String::new(),
                attendees: Vec::new(),
                organizer: String::new(),
                location: String::new(),
                online_url: None,
                all_day: false,
                provider: "apple".into(),
                event_url: event_url.clone(),
            });
            continue;
        }
        if line == "END:VEVENT" {
            if let Some(e) = cur.take() {
                events.push(e);
            }
            continue;
        }
        let Some(e) = cur.as_mut() else { continue };
        let Some((name_params, value)) = line.split_once(':') else {
            continue;
        };
        match name_params.split(';').next().unwrap_or("") {
            "SUMMARY" => e.title = value.to_string(),
            "UID" => e.id = value.to_string(),
            "DTSTART" => {
                let (iso, all_day) = ical_dt(value);
                e.start = iso;
                e.all_day = all_day;
            }
            "DTEND" => e.end = ical_dt(value).0,
            "LOCATION" => e.location = value.to_string(),
            "ORGANIZER" => e.organizer = cn_param(name_params).unwrap_or_default(),
            "ATTENDEE" => {
                if let Some(cn) = cn_param(name_params) {
                    e.attendees.push(cn);
                }
            }
            _ => {}
        }
    }
    events
}

fn calendar_entries(xml: &str) -> Vec<(String, String)> {
    let doc = match roxmltree::Document::parse(xml) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for resp in doc
        .descendants()
        .filter(|n| n.tag_name().name() == "response")
    {
        let href = resp
            .descendants()
            .find(|n| n.tag_name().name() == "href")
            .and_then(|n| n.text())
            .map(|t| t.trim().to_string());
        let data = resp
            .descendants()
            .find(|n| n.tag_name().name() == "calendar-data")
            .and_then(|n| n.text())
            .map(|t| t.to_string());
        if let (Some(h), Some(d)) = (href, data) {
            out.push((h, d));
        }
    }
    out
}

fn apple_events(app: &AppHandle) -> Result<Vec<CalendarEvent>, String> {
    let a = load_auth(app);
    let apple_id = a.apple_id.clone().ok_or("iCloud not connected.")?;
    let app_pw = a
        .apple_app_password
        .clone()
        .ok_or("iCloud not connected.")?;
    let home = a
        .apple_calendar_url
        .clone()
        .ok_or("iCloud not connected.")?;
    let auth = basic_auth(&apple_id, &app_pw);

    let list_body = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>"#;
    let (_s, home_final, list_xml) = caldav("PROPFIND", &home, &auth, "1", list_body)?;

    let start = (chrono::Utc::now() - chrono::Duration::days(1)).format("%Y%m%dT%H%M%SZ");
    let end = (chrono::Utc::now() + chrono::Duration::days(14)).format("%Y%m%dT%H%M%SZ");
    let report_body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="{start}" end="{end}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>"#
    );

    let mut events = Vec::new();
    for href in calendar_hrefs(&list_xml) {
        let cal_url = resolve(&home_final, &href);
        if let Ok((_st, _fu, rep_xml)) = caldav("REPORT", &cal_url, &auth, "1", &report_body) {
            for (href, ics) in calendar_entries(&rep_xml) {
                let url = resolve(&home_final, &href);
                for ev in parse_vevents(&ics, Some(url)) {
                    if !ev.start.is_empty() {
                        events.push(ev);
                    }
                }
            }
        }
    }
    Ok(events)
}

// ---------- Create / edit / delete calendar events ----------

#[derive(Deserialize)]
pub struct CreateCalendarEventPayload {
    provider: String,
    title: String,
    start: String,
    end: String,
    location: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateCalendarEventPayload {
    id: String,
    provider: String,
    #[serde(rename = "eventUrl")]
    event_url: Option<String>,
    title: Option<String>,
    start: Option<String>,
    end: Option<String>,
    location: Option<String>,
}

#[derive(Deserialize)]
pub struct DeleteCalendarEventPayload {
    id: String,
    provider: String,
    #[serde(rename = "eventUrl")]
    event_url: Option<String>,
}

const MAX_CALENDAR_TITLE_LEN: usize = 200;
const MAX_CALENDAR_LOCATION_LEN: usize = 500;
const MAX_CALENDAR_ID_LEN: usize = 1024;
const MAX_CALENDAR_URL_LEN: usize = 2048;

fn has_timezone(value: &str) -> bool {
    let suffix = value.get(10..).unwrap_or("");
    value.ends_with('Z') || suffix.contains('+') || suffix.contains('-')
}

fn calendar_datetime_candidate(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Date and time are required.".into());
    }
    let base = trimmed.split('.').next().unwrap_or(trimmed);
    let with_seconds = if base.len() == 16 {
        format!("{base}:00")
    } else {
        base.to_string()
    };
    if has_timezone(&with_seconds) {
        Ok(with_seconds)
    } else {
        Ok(format!("{with_seconds}Z"))
    }
}

fn parse_calendar_datetime(value: &str) -> Result<DateTime<chrono::FixedOffset>, String> {
    let candidate = calendar_datetime_candidate(value)?;
    DateTime::parse_from_rfc3339(&candidate).map_err(|_| format!("Invalid datetime: {value}"))
}

fn normalize_calendar_datetime(value: &str) -> Result<String, String> {
    let dt = parse_calendar_datetime(value)?;
    Ok(dt
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn iso_to_ical_datetime(iso: &str) -> Result<String, String> {
    let dt = parse_calendar_datetime(iso)?;
    Ok(dt.format("%Y%m%dT%H%M%SZ").to_string())
}

fn clean_required_text(value: &str, field: &str, max_len: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} is required."));
    }
    if trimmed.chars().count() > max_len {
        return Err(format!("{field} is too long."));
    }
    Ok(trimmed.to_string())
}

fn clean_optional_text(
    value: Option<String>,
    field: &str,
    max_len: usize,
    allow_empty: bool,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        if allow_empty {
            return Ok(Some(String::new()));
        }
        return Ok(None);
    }
    if trimmed.chars().count() > max_len {
        return Err(format!("{field} is too long."));
    }
    Ok(Some(trimmed.to_string()))
}

fn validate_calendar_provider(provider: &str) -> Result<(), String> {
    match provider {
        "microsoft" | "google" | "apple" => Ok(()),
        other => Err(format!("Unknown calendar provider: {other}")),
    }
}

fn validate_calendar_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("Calendar event ID is required.".into());
    }
    if trimmed.chars().count() > MAX_CALENDAR_ID_LEN {
        return Err("Calendar event ID is too long.".into());
    }
    Ok(trimmed.to_string())
}

fn validate_event_url_value(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_CALENDAR_URL_LEN {
        return Err("Calendar event URL is too long.".into());
    }
    Ok(Some(trimmed.to_string()))
}

fn validate_create_payload(
    mut payload: CreateCalendarEventPayload,
) -> Result<CreateCalendarEventPayload, String> {
    validate_calendar_provider(&payload.provider)?;
    payload.title = clean_required_text(&payload.title, "Title", MAX_CALENDAR_TITLE_LEN)?;
    payload.start = normalize_calendar_datetime(&payload.start)?;
    payload.end = normalize_calendar_datetime(&payload.end)?;
    let start = parse_calendar_datetime(&payload.start)?;
    let end = parse_calendar_datetime(&payload.end)?;
    if end <= start {
        return Err("Event end must be after start.".into());
    }
    payload.location = clean_optional_text(
        payload.location,
        "Location",
        MAX_CALENDAR_LOCATION_LEN,
        false,
    )?;
    Ok(payload)
}

fn validate_update_payload(
    mut payload: UpdateCalendarEventPayload,
) -> Result<UpdateCalendarEventPayload, String> {
    validate_calendar_provider(&payload.provider)?;
    payload.id = validate_calendar_id(&payload.id)?;
    payload.event_url = validate_event_url_value(payload.event_url)?;
    if let Some(title) = payload.title {
        payload.title = Some(clean_required_text(
            &title,
            "Title",
            MAX_CALENDAR_TITLE_LEN,
        )?);
    }
    payload.location = clean_optional_text(
        payload.location,
        "Location",
        MAX_CALENDAR_LOCATION_LEN,
        true,
    )?;
    if let Some(start) = payload.start {
        payload.start = Some(normalize_calendar_datetime(&start)?);
    }
    if let Some(end) = payload.end {
        payload.end = Some(normalize_calendar_datetime(&end)?);
    }
    if let (Some(start), Some(end)) = (&payload.start, &payload.end) {
        if parse_calendar_datetime(end)? <= parse_calendar_datetime(start)? {
            return Err("Event end must be after start.".into());
        }
    }
    if payload.title.is_none()
        && payload.start.is_none()
        && payload.end.is_none()
        && payload.location.is_none()
    {
        return Err("Nothing to update.".into());
    }
    Ok(payload)
}

fn validate_delete_payload(
    mut payload: DeleteCalendarEventPayload,
) -> Result<DeleteCalendarEventPayload, String> {
    validate_calendar_provider(&payload.provider)?;
    payload.id = validate_calendar_id(&payload.id)?;
    payload.event_url = validate_event_url_value(payload.event_url)?;
    Ok(payload)
}

fn replace_ical_field(ics: &str, field: &str, value: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for raw in ics.split('\n') {
        let line = raw.trim_end_matches('\r');
        if (line.starts_with(' ') || line.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().unwrap().push_str(&line[1..]);
        } else {
            lines.push(line.to_string());
        }
    }
    let mut found = false;
    for line in &mut lines {
        let Some((name_params, _old)) = line.split_once(':') else {
            continue;
        };
        if name_params.split(';').next() == Some(field) {
            *line = format!("{name_params}:{value}");
            found = true;
        }
    }
    if !found && !value.trim().is_empty() {
        if let Some(idx) = lines.iter().position(|l| l == "END:VEVENT") {
            lines.insert(idx, format!("{field}:{value}"));
        }
    }
    lines.join("\r\n")
}

fn xml_etag(xml: &str) -> Option<String> {
    let doc = roxmltree::Document::parse(xml).ok()?;
    for node in doc.descendants() {
        if node.tag_name().name() == "getetag" {
            if let Some(t) = node.text() {
                return Some(t.trim().to_string());
            }
        }
    }
    None
}

fn escape_ics_text(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
        .replace('\r', "")
}

fn apple_auth(app: &AppHandle) -> Result<(String, String), String> {
    let a = load_auth(app);
    let apple_id = a.apple_id.ok_or("iCloud not connected.")?;
    let app_pw = a.apple_app_password.ok_or("iCloud not connected.")?;
    Ok((basic_auth(&apple_id, &app_pw), apple_id))
}

fn apple_auth_and_home(app: &AppHandle) -> Result<(String, String, String), String> {
    let a = load_auth(app);
    let apple_id = a.apple_id.ok_or("iCloud not connected.")?;
    let app_pw = a.apple_app_password.ok_or("iCloud not connected.")?;
    let home = a.apple_calendar_url.ok_or("iCloud not connected.")?;
    Ok((basic_auth(&apple_id, &app_pw), apple_id, home))
}

fn parse_https_url_parts(url: &str) -> Result<(String, Option<u16>, String), String> {
    let uri: http::Uri = url
        .parse()
        .map_err(|_| "Invalid iCloud event URL.".to_string())?;
    if uri.scheme_str() != Some("https") {
        return Err("Invalid iCloud event URL.".into());
    }
    if uri.query().is_some() {
        return Err("Invalid iCloud event URL.".into());
    }
    let host = uri
        .host()
        .ok_or("Invalid iCloud event URL.")?
        .to_ascii_lowercase();
    let path = uri.path().to_string();
    let lower_path = path.to_ascii_lowercase();
    if path.contains('\\')
        || lower_path.contains("%2e")
        || lower_path.contains("%2f")
        || path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
    {
        return Err("Invalid iCloud event URL.".into());
    }
    Ok((host, uri.port_u16(), path))
}

fn validate_apple_url_under_home(home: &str, candidate: &str) -> Result<(), String> {
    let (home_host, home_port, home_path) = parse_https_url_parts(home)?;
    let (candidate_host, candidate_port, candidate_path) = parse_https_url_parts(candidate)?;
    if candidate_host != home_host || candidate_port != home_port {
        return Err("iCloud event URL is outside the connected calendar.".into());
    }
    let home_prefix = if home_path.ends_with('/') {
        home_path
    } else {
        format!("{home_path}/")
    };
    if !candidate_path.starts_with(&home_prefix) {
        return Err("iCloud event URL is outside the connected calendar.".into());
    }
    Ok(())
}

fn validated_apple_event_url(app: &AppHandle, event_url: &str) -> Result<String, String> {
    let home = load_auth(app)
        .apple_calendar_url
        .ok_or("iCloud not connected.")?;
    validate_apple_url_under_home(&home, event_url)?;
    Ok(event_url.to_string())
}

fn apple_get_ics(app: &AppHandle, event_url: &str) -> Result<(String, String), String> {
    let (auth, _, home) = apple_auth_and_home(app)?;
    let event_url = validated_apple_event_url(app, event_url)?;
    let prop_body = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav"/></d:prop></d:propfind>"#;
    let (status, _, xml) =
        caldav_with_url_validator("PROPFIND", &event_url, &auth, "0", prop_body, |url| {
            validate_apple_url_under_home(&home, url)
        })?;
    if status != 207 && status != 200 {
        return Err(format!("Could not read iCloud event (status {status})."));
    }
    let etag = xml_etag(&xml).ok_or("Missing event etag from iCloud.")?;
    let ics = calendar_data_blocks(&xml)
        .into_iter()
        .next()
        .ok_or("No calendar data on iCloud event.")?;
    Ok((etag, ics))
}

fn apple_put_ics(
    app: &AppHandle,
    event_url: &str,
    etag: Option<&str>,
    ics: &str,
) -> Result<(), String> {
    let (auth, _) = apple_auth(app)?;
    let event_url = validated_apple_event_url(app, event_url)?;
    let mut builder = http::Request::builder()
        .method("PUT")
        .uri(&event_url)
        .header("authorization", &auth)
        .header("content-type", "text/calendar; charset=utf-8");
    if let Some(etag) = etag {
        builder = builder.header("if-match", etag);
    }
    let req = builder.body(ics.to_string()).map_err(|e| e.to_string())?;
    let resp = caldav_agent()
        .run(req)
        .map_err(|e| format!("iCloud update failed: {e}"))?;
    let status = resp.status().as_u16();
    if matches!(status, 200 | 201 | 204) {
        return Ok(());
    }
    let body = resp.into_body().read_to_string().unwrap_or_default();
    Err(format!("iCloud update failed ({status}): {body}"))
}

fn apple_delete_event(app: &AppHandle, event_url: &str) -> Result<(), String> {
    let (auth, _) = apple_auth(app)?;
    let event_url = validated_apple_event_url(app, event_url)?;
    let (etag, _) = apple_get_ics(app, &event_url)?;
    let req = http::Request::builder()
        .method("DELETE")
        .uri(&event_url)
        .header("authorization", &auth)
        .header("if-match", &etag)
        .body(String::new())
        .map_err(|e| e.to_string())?;
    let resp = caldav_agent()
        .run(req)
        .map_err(|e| format!("iCloud delete failed: {e}"))?;
    let status = resp.status().as_u16();
    if matches!(status, 200 | 204) {
        return Ok(());
    }
    Err(format!("iCloud delete failed (status {status})."))
}

fn google_create_event(
    app: &AppHandle,
    payload: &CreateCalendarEventPayload,
) -> Result<(), String> {
    let token = google_valid_token(app)?;
    let body = serde_json::json!({
        "summary": payload.title,
        "start": { "dateTime": payload.start, "timeZone": "UTC" },
        "end": { "dateTime": payload.end, "timeZone": "UTC" },
        "location": payload.location.clone().unwrap_or_default(),
    });
    let resp = ureq::post(GOOGLE_EVENTS_URL)
        .header("authorization", &format!("Bearer {token}"))
        .header("content-type", "application/json")
        .send(body.to_string())
        .map_err(|e| format!("Google create failed: {e}"))?;
    let status = resp.status().as_u16();
    if matches!(status, 200 | 201) {
        return Ok(());
    }
    let body = resp.into_body().read_to_string().unwrap_or_default();
    Err(format!("Google create failed ({status}): {body}"))
}

fn google_update_event(
    app: &AppHandle,
    payload: &UpdateCalendarEventPayload,
) -> Result<(), String> {
    let token = google_valid_token(app)?;
    let mut patch = serde_json::Map::new();
    if let Some(title) = &payload.title {
        patch.insert("summary".into(), serde_json::Value::String(title.clone()));
    }
    if let Some(start) = &payload.start {
        patch.insert(
            "start".into(),
            serde_json::json!({ "dateTime": start, "timeZone": "UTC" }),
        );
    }
    if let Some(end) = &payload.end {
        patch.insert(
            "end".into(),
            serde_json::json!({ "dateTime": end, "timeZone": "UTC" }),
        );
    }
    if let Some(loc) = &payload.location {
        patch.insert("location".into(), serde_json::Value::String(loc.clone()));
    }
    if patch.is_empty() {
        return Err("Nothing to update.".into());
    }
    let url = format!("{GOOGLE_EVENTS_URL}/{}", payload.id);
    let body =
        serde_json::to_string(&serde_json::Value::Object(patch)).map_err(|e| e.to_string())?;
    let resp = ureq::patch(&url)
        .header("authorization", &format!("Bearer {token}"))
        .header("content-type", "application/json")
        .send(body)
        .map_err(|e| format!("Google update failed: {e}"))?;
    let status = resp.status().as_u16();
    if matches!(status, 200 | 204) {
        return Ok(());
    }
    let body = resp.into_body().read_to_string().unwrap_or_default();
    if status == 403 {
        return Err("Google needs write access. Disconnect and reconnect your calendar.".into());
    }
    Err(format!("Google update failed ({status}): {body}"))
}

fn google_delete_event(app: &AppHandle, id: &str) -> Result<(), String> {
    let token = google_valid_token(app)?;
    let url = format!("{GOOGLE_EVENTS_URL}/{id}");
    let resp = ureq::delete(&url)
        .header("authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("Google delete failed: {e}"))?;
    let status = resp.status().as_u16();
    if matches!(status, 200 | 204) {
        return Ok(());
    }
    if status == 403 {
        return Err("Google needs write access. Disconnect and reconnect your calendar.".into());
    }
    Err(format!("Google delete failed (status {status})."))
}

fn ms_create_event(app: &AppHandle, payload: &CreateCalendarEventPayload) -> Result<(), String> {
    let token = ms_valid_token(app)?;
    let body = serde_json::json!({
        "subject": payload.title,
        "start": { "dateTime": payload.start, "timeZone": "UTC" },
        "end": { "dateTime": payload.end, "timeZone": "UTC" },
        "location": { "displayName": payload.location.clone().unwrap_or_default() },
    });
    let resp = ureq::post("https://graph.microsoft.com/v1.0/me/events")
        .header("authorization", &format!("Bearer {token}"))
        .header("content-type", "application/json")
        .send(body.to_string())
        .map_err(|e| format!("Outlook create failed: {e}"))?;
    let status = resp.status().as_u16();
    if matches!(status, 200 | 201) {
        return Ok(());
    }
    let body = resp.into_body().read_to_string().unwrap_or_default();
    Err(format!("Outlook create failed ({status}): {body}"))
}

fn ms_update_event(app: &AppHandle, payload: &UpdateCalendarEventPayload) -> Result<(), String> {
    let token = ms_valid_token(app)?;
    let mut patch = serde_json::Map::new();
    if let Some(title) = &payload.title {
        patch.insert("subject".into(), serde_json::Value::String(title.clone()));
    }
    if let Some(start) = &payload.start {
        patch.insert(
            "start".into(),
            serde_json::json!({ "dateTime": start, "timeZone": "UTC" }),
        );
    }
    if let Some(end) = &payload.end {
        patch.insert(
            "end".into(),
            serde_json::json!({ "dateTime": end, "timeZone": "UTC" }),
        );
    }
    if let Some(loc) = &payload.location {
        patch.insert("location".into(), serde_json::json!({ "displayName": loc }));
    }
    if patch.is_empty() {
        return Err("Nothing to update.".into());
    }
    let url = format!("https://graph.microsoft.com/v1.0/me/events/{}", payload.id);
    let body =
        serde_json::to_string(&serde_json::Value::Object(patch)).map_err(|e| e.to_string())?;
    let resp = ureq::patch(&url)
        .header("authorization", &format!("Bearer {token}"))
        .header("content-type", "application/json")
        .send(body)
        .map_err(|e| format!("Outlook update failed: {e}"))?;
    let status = resp.status().as_u16();
    if matches!(status, 200 | 204) {
        return Ok(());
    }
    let body = resp.into_body().read_to_string().unwrap_or_default();
    if status == 403 {
        return Err("Outlook needs write access. Disconnect and reconnect your calendar.".into());
    }
    Err(format!("Outlook update failed ({status}): {body}"))
}

fn ms_delete_event(app: &AppHandle, id: &str) -> Result<(), String> {
    let token = ms_valid_token(app)?;
    let url = format!("https://graph.microsoft.com/v1.0/me/events/{id}");
    let resp = ureq::delete(&url)
        .header("authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("Outlook delete failed: {e}"))?;
    let status = resp.status().as_u16();
    if matches!(status, 200 | 204) {
        return Ok(());
    }
    if status == 403 {
        return Err("Outlook needs write access. Disconnect and reconnect your calendar.".into());
    }
    Err(format!("Outlook delete failed (status {status})."))
}

fn apple_create_event(app: &AppHandle, payload: &CreateCalendarEventPayload) -> Result<(), String> {
    let a = load_auth(app);
    let home = a
        .apple_calendar_url
        .clone()
        .ok_or("iCloud not connected.")?;
    let uid = uuid::Uuid::new_v4().to_string();
    let event_url = format!("{}/{}.ics", home.trim_end_matches('/'), uid);
    let start = iso_to_ical_datetime(&payload.start)?;
    let end = iso_to_ical_datetime(&payload.end)?;
    let now = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let loc = payload.location.clone().unwrap_or_default();
    let ics = format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Candor//Calendar//EN\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:{now}\r\nSUMMARY:{}\r\nDTSTART:{start}\r\nDTEND:{end}\r\nLOCATION:{}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        escape_ics_text(&payload.title),
        escape_ics_text(&loc),
    );
    apple_put_ics(app, &event_url, None, &ics)
}

fn apple_update_event(app: &AppHandle, payload: &UpdateCalendarEventPayload) -> Result<(), String> {
    let event_url = payload
        .event_url
        .clone()
        .ok_or("Missing iCloud event URL. Refresh your calendar and try again.")?;
    let (etag, ics) = apple_get_ics(app, &event_url)?;
    let mut next = ics.clone();
    if let Some(title) = &payload.title {
        next = replace_ical_field(&next, "SUMMARY", &escape_ics_text(title));
    }
    if let Some(start) = &payload.start {
        let ical = iso_to_ical_datetime(start)?;
        next = replace_ical_field(&next, "DTSTART", &ical);
    }
    if let Some(end) = &payload.end {
        let ical = iso_to_ical_datetime(end)?;
        next = replace_ical_field(&next, "DTEND", &ical);
    }
    if let Some(loc) = &payload.location {
        next = replace_ical_field(&next, "LOCATION", &escape_ics_text(loc));
    }
    apple_put_ics(app, &event_url, Some(&etag), &next)
}

#[tauri::command]
pub async fn create_calendar_event(
    app: AppHandle,
    payload: CreateCalendarEventPayload,
) -> Result<(), String> {
    let payload = validate_create_payload(payload)?;
    tauri::async_runtime::spawn_blocking(move || match payload.provider.as_str() {
        "microsoft" => ms_create_event(&app, &payload),
        "google" => google_create_event(&app, &payload),
        "apple" => apple_create_event(&app, &payload),
        _ => unreachable!("calendar provider was validated"),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn update_calendar_event(
    app: AppHandle,
    payload: UpdateCalendarEventPayload,
) -> Result<(), String> {
    let payload = validate_update_payload(payload)?;
    tauri::async_runtime::spawn_blocking(move || match payload.provider.as_str() {
        "microsoft" => ms_update_event(&app, &payload),
        "google" => google_update_event(&app, &payload),
        "apple" => apple_update_event(&app, &payload),
        _ => unreachable!("calendar provider was validated"),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_calendar_event(
    app: AppHandle,
    payload: DeleteCalendarEventPayload,
) -> Result<(), String> {
    let payload = validate_delete_payload(payload)?;
    tauri::async_runtime::spawn_blocking(move || match payload.provider.as_str() {
        "microsoft" => ms_delete_event(&app, &payload.id),
        "google" => google_delete_event(&app, &payload.id),
        "apple" => {
            let url = payload
                .event_url
                .ok_or("Missing iCloud event URL. Refresh your calendar and try again.")?;
            apple_delete_event(&app, &url)
        }
        _ => unreachable!("calendar provider was validated"),
    })
    .await
    .map_err(|e| e.to_string())?
}
