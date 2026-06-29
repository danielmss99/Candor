import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getCalendarStatus,
  getGoogleCalendarSetup,
  getMsCalendarSetup,
  invokeError,
  isGoogleClientIdConfigured,
  isMsClientIdConfigured,
  oauthUnavailableMessage,
  resolveGoogleClientId,
  resolveMsClientId,
  type GoogleCalendarSetup,
  type MsCalendarSetup,
} from "../api/calendar";

interface ConnectCalendarModalProps {
  onClose: () => void;
  onConnected: () => void;
}

type Step = "choose" | "ms-connect" | "ms-waiting" | "google-connect" | "google-waiting" | "apple";

export function ConnectCalendarModal({ onClose, onConnected }: ConnectCalendarModalProps) {
  const [step, setStep] = useState<Step>("choose");
  const [msSetup, setMsSetup] = useState<MsCalendarSetup | null>(null);
  const [googleSetup, setGoogleSetup] = useState<GoogleCalendarSetup | null>(null);
  const [appleId, setAppleId] = useState("");
  const [applePw, setApplePw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      setMsSetup({});
      setGoogleSetup({});
      return;
    }
    getMsCalendarSetup()
      .then(setMsSetup)
      .catch(() => setMsSetup({}));
    getGoogleCalendarSetup()
      .then(setGoogleSetup)
      .catch(() => setGoogleSetup({}));
  }, []);

  const msClientId = resolveMsClientId(msSetup ?? {});
  const googleClientId = resolveGoogleClientId(googleSetup ?? {});
  const msConfigured = isMsClientIdConfigured(msSetup ?? {});
  const googleConfigured = isGoogleClientIdConfigured(googleSetup ?? {});

  function startMicrosoftFlow() {
    setError(null);
    if (!isTauri()) {
      setError("Calendar sign-in only works in the Candor desktop app (npm run tauri dev).");
      return;
    }
    setStep("ms-connect");
  }

  function startGoogleFlow() {
    setError(null);
    if (!isTauri()) {
      setError("Calendar sign-in only works in the Candor desktop app (npm run tauri dev).");
      return;
    }
    setStep("google-connect");
  }

  async function connectMicrosoft() {
    if (!msClientId) {
      setError(oauthUnavailableMessage("microsoft"));
      return;
    }

    setError(null);
    setBusy(true);
    setStep("ms-waiting");

    try {
      await invoke("ms_oauth_connect", { clientId: msClientId });
      const status = await getCalendarStatus();
      if (!status.microsoft) {
        throw new Error(
          "Sign-in finished but Outlook wasn't saved. Check Azure redirect URI and try again.",
        );
      }
      onConnected();
    } catch (e) {
      setError(invokeError(e));
      setStep("ms-connect");
    } finally {
      setBusy(false);
    }
  }

  async function connectGoogle() {
    if (!googleClientId) {
      setError(oauthUnavailableMessage("google"));
      return;
    }

    setError(null);
    setBusy(true);
    setStep("google-waiting");

    try {
      await invoke("google_oauth_connect", {
        clientId: googleClientId,
        clientSecret: null,
      });
      const status = await getCalendarStatus();
      if (!status.google) {
        throw new Error(
          "Sign-in finished but Google Calendar wasn't saved. Check redirect URI and try again.",
        );
      }
      onConnected();
    } catch (e) {
      setError(invokeError(e));
      setStep("google-connect");
    } finally {
      setBusy(false);
    }
  }

  async function connectApple() {
    setError(null);
    if (!isTauri()) {
      setError("Calendar sign-in only works in the Candor desktop app (npm run tauri dev).");
      return;
    }
    setBusy(true);
    try {
      await invoke("apple_connect", { appleId, appPassword: applePw });
      const status = await getCalendarStatus();
      if (!status.apple) {
        throw new Error("iCloud credentials weren't saved. Try again.");
      }
      onConnected();
    } catch (e) {
      setError(invokeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Connect a calendar</span>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {step === "choose" && (
          <div className="modal-body">
            <p className="modal-sub">Your meetings will appear in Candor, ready to record.</p>
            {!isTauri() && (
              <div className="modal-error">
                Calendar sign-in requires the Candor desktop app — it does not work in the browser
                preview.
              </div>
            )}
            <button
              className="provider-btn provider-btn--primary"
              onClick={startMicrosoftFlow}
              disabled={busy}
            >
              <span className="provider-mark provider-mark--ms" />
              <span>
                <span className="provider-name">Microsoft</span>
                <span className="provider-desc">Outlook / Microsoft 365</span>
              </span>
            </button>
            <button
              className="provider-btn provider-btn--primary"
              onClick={startGoogleFlow}
              disabled={busy}
            >
              <span className="provider-mark provider-mark--google" />
              <span>
                <span className="provider-name">Google</span>
                <span className="provider-desc">Google Calendar</span>
              </span>
            </button>
            <button className="provider-btn" onClick={() => setStep("apple")}>
              <span className="provider-mark provider-mark--apple"></span>
              <span>
                <span className="provider-name">Apple / iCloud</span>
                <span className="provider-desc">Apple Calendar</span>
              </span>
            </button>
          </div>
        )}

        {step === "ms-connect" && (
          <div className="modal-body">
            <p className="modal-sub">Sign in with your Microsoft account to sync your calendar.</p>
            {error && <div className="modal-error">{error}</div>}
            {!msConfigured && !error && (
              <div className="modal-error">{oauthUnavailableMessage("microsoft")}</div>
            )}
            <button
              className="provider-btn provider-btn--primary"
              onClick={() => void connectMicrosoft()}
              disabled={busy || !msConfigured}
            >
              <span className="provider-mark provider-mark--ms" />
              <span>
                <span className="provider-name">
                  {busy ? "Opening browser…" : "Connect with Microsoft"}
                </span>
                <span className="provider-desc">Opens your browser to sign in</span>
              </span>
            </button>
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => {
                  setStep("choose");
                  setError(null);
                }}
                disabled={busy}
              >
                Back
              </button>
            </div>
          </div>
        )}

        {step === "ms-waiting" && (
          <div className="modal-body">
            <p className="modal-sub">
              Sign in with your Microsoft account in the browser window that opened. When you
              approve access, you&apos;ll see a confirmation page — then return here.
            </p>
            <div className="modal-waiting">
              <span className="rec-bar-spinner" />
              Waiting for you to finish signing in…
            </div>
            {error && <div className="modal-error">{error}</div>}
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => {
                  setStep("ms-connect");
                  setError(null);
                }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {step === "google-connect" && (
          <div className="modal-body">
            <p className="modal-sub">Sign in with your Google account to sync your calendar.</p>
            {error && <div className="modal-error">{error}</div>}
            {!googleConfigured && !error && (
              <div className="modal-error">{oauthUnavailableMessage("google")}</div>
            )}
            <button
              className="provider-btn provider-btn--primary"
              onClick={() => void connectGoogle()}
              disabled={busy || !googleConfigured}
            >
              <span className="provider-mark provider-mark--google" />
              <span>
                <span className="provider-name">
                  {busy ? "Opening browser…" : "Connect with Google"}
                </span>
                <span className="provider-desc">Opens your browser to sign in</span>
              </span>
            </button>
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => {
                  setStep("choose");
                  setError(null);
                }}
                disabled={busy}
              >
                Back
              </button>
            </div>
          </div>
        )}

        {step === "google-waiting" && (
          <div className="modal-body">
            <p className="modal-sub">
              Sign in with your Google account in the browser window that opened. When you approve
              access, you&apos;ll see a confirmation page — then return here.
            </p>
            <div className="modal-waiting">
              <span className="rec-bar-spinner" />
              Waiting for you to finish signing in…
            </div>
            {error && <div className="modal-error">{error}</div>}
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => {
                  setStep("google-connect");
                  setError(null);
                }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {step === "apple" && (
          <div className="modal-body">
            <p className="modal-sub">
              iCloud needs an <strong>app-specific password</strong> (because of two-factor auth).
              Create one at appleid.apple.com → Sign-In and Security → App-Specific Passwords, then
              paste it below.
            </p>
            <button
              className="link-btn link-btn--block"
              onClick={() => openUrl("https://appleid.apple.com/account/manage")}
            >
              Open appleid.apple.com →
            </button>
            <input
              className="modal-input"
              placeholder="Apple ID (email)"
              value={appleId}
              onChange={(e) => setAppleId(e.target.value)}
              autoFocus
            />
            <input
              className="modal-input"
              type="password"
              placeholder="App-specific password (xxxx-xxxx-xxxx-xxxx)"
              value={applePw}
              onChange={(e) => setApplePw(e.target.value)}
            />
            {error && <div className="modal-error">{error}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setStep("choose")}>
                Back
              </button>
              <button
                className="btn-primary"
                onClick={connectApple}
                disabled={busy || !appleId.trim() || !applePw.trim()}
              >
                {busy ? "Connecting…" : "Connect"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
