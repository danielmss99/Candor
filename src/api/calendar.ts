import { invoke, isTauri } from "@tauri-apps/api/core";

/** Optional build-time client ID (set VITE_MS_CLIENT_ID in .env). */
export const MS_CLIENT_ID = import.meta.env.VITE_MS_CLIENT_ID?.trim() ?? "";

/** Optional build-time Google OAuth client ID (set VITE_GOOGLE_CLIENT_ID in .env). */
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? "";

export interface MsCalendarSetup {
  storedClientId?: string | null;
  defaultClientId?: string | null;
  redirectUri?: string | null;
}

export interface GoogleCalendarSetup {
  storedClientId?: string | null;
  defaultClientId?: string | null;
  redirectUri?: string | null;
  hasClientSecret?: boolean;
}

export interface CalendarStatus {
  microsoft: boolean;
  google: boolean;
  apple: boolean;
}

/** Turn a Tauri invoke rejection into a user-readable string. */
export function invokeError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string" && o.message) return o.message;
    if (typeof o.error === "string" && o.error) return o.error;
  }
  const s = String(e);
  return s === "[object Object]" ? "Something went wrong. Try again." : s;
}

export function resolveMsClientId(setup: MsCalendarSetup): string {
  return (
    setup.storedClientId?.trim() ||
    MS_CLIENT_ID ||
    setup.defaultClientId?.trim() ||
    ""
  );
}

export function resolveGoogleClientId(setup: GoogleCalendarSetup): string {
  return (
    setup.storedClientId?.trim() ||
    GOOGLE_CLIENT_ID ||
    setup.defaultClientId?.trim() ||
    ""
  );
}

export function isMsClientIdConfigured(setup: MsCalendarSetup): boolean {
  return resolveMsClientId(setup).length > 0;
}

export function isGoogleClientIdConfigured(setup: GoogleCalendarSetup): boolean {
  return resolveGoogleClientId(setup).length > 0;
}

export type OAuthProvider = "microsoft" | "google";

const OAUTH_UNAVAILABLE_PROD: Record<OAuthProvider, string> = {
  microsoft:
    "Microsoft calendar isn't available in this build. Update Candor or contact support.",
  google: "Google Calendar isn't available in this build. Update Candor or contact support.",
};

const OAUTH_UNAVAILABLE_DEV: Record<OAuthProvider, string> = {
  microsoft:
    "Microsoft OAuth isn't configured. Add your Azure Application (client) ID to `.env` as `VITE_MS_CLIENT_ID`, then restart with `npm run tauri:dev`. See `.env.example` or README.md.",
  google:
    "Google OAuth isn't configured. Add your OAuth client ID to `.env` as `VITE_GOOGLE_CLIENT_ID`, then restart with `npm run tauri:dev`. See `.env.example` or README.md.",
};

export function oauthUnavailableMessage(provider: OAuthProvider): string {
  if (import.meta.env.DEV) {
    return OAUTH_UNAVAILABLE_DEV[provider];
  }
  return OAUTH_UNAVAILABLE_PROD[provider];
}

export async function getMsCalendarSetup(): Promise<MsCalendarSetup> {
  if (!isTauri()) return {};
  return invoke<MsCalendarSetup>("ms_calendar_setup");
}

export async function getGoogleCalendarSetup(): Promise<GoogleCalendarSetup> {
  if (!isTauri()) return {};
  return invoke<GoogleCalendarSetup>("google_calendar_setup");
}

export async function getCalendarStatus(): Promise<CalendarStatus> {
  return invoke<CalendarStatus>("calendar_status");
}
