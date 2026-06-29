import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  loadPrivacySettings,
  savePrivacySettings,
  type PrivacySettings,
} from "../api/local";
import {
  SUMMARY_TEMPLATES,
  loadSummaryTemplate,
  saveSummaryTemplate,
  type SummaryTemplateId,
} from "../v2/summaryTemplates";

export type Theme = "light" | "dark";

interface SettingsModalProps {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onClose: () => void;
}

const MODELS: { value: string; label: string }[] = [
  { value: "tiny.en", label: "Tiny — fastest, roughest" },
  { value: "base.en", label: "Base — recommended" },
  { value: "small.en", label: "Small — most accurate, slower" },
];

export function SettingsModal({ theme, onThemeChange, onClose }: SettingsModalProps) {
  const [model, setModel] = useState("base.en");
  const [notesDir, setNotesDir] = useState("");
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [template, setTemplate] = useState<SummaryTemplateId>(() => loadSummaryTemplate());

  useEffect(() => {
    invoke<{ model: string; notesDir: string }>("get_settings")
      .then((s) => {
        setModel(s.model);
        setNotesDir(s.notesDir);
      })
      .catch(() => {});
    loadPrivacySettings().then(setPrivacy).catch(() => {});
  }, []);

  const changeModel = async (m: string) => {
    setModel(m);
    try {
      await invoke("set_model", { model: m });
    } catch {
      /* ignore */
    }
  };

  const patchPrivacy = async (patch: Partial<PrivacySettings>) => {
    if (!privacy) return;
    const next = { ...privacy, ...patch };
    setPrivacy(next);
    await savePrivacySettings(next).catch(() => {});
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Settings</span>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-name">Theme</div>
              <div className="setting-desc">Light or dark appearance.</div>
            </div>
            <div className="seg">
              <button
                className={`seg-btn ${theme === "light" ? "seg-btn--on" : ""}`}
                onClick={() => onThemeChange("light")}
              >
                Light
              </button>
              <button
                className={`seg-btn ${theme === "dark" ? "seg-btn--on" : ""}`}
                onClick={() => onThemeChange("dark")}
              >
                Dark
              </button>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-name">Transcription model</div>
              <div className="setting-desc">
                Bigger is more accurate but slower. Applies to your next recording (downloads if
                needed).
              </div>
            </div>
            <select
              className="setting-select"
              value={model}
              onChange={(e) => changeModel(e.target.value)}
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-name">Summary template</div>
              <div className="setting-desc">Shapes how AI recap is structured.</div>
            </div>
            <select
              className="setting-select"
              value={template}
              onChange={(e) => {
                const id = e.target.value as SummaryTemplateId;
                setTemplate(id);
                saveSummaryTemplate(id);
              }}
            >
              {SUMMARY_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {privacy && (
            <>
              <div className="setting-section-label">Privacy & capture</div>

              <div className="setting-row">
                <div className="setting-text">
                  <div className="setting-name">Capture system audio</div>
                  <div className="setting-desc">
                    Record meeting audio from your desktop (Zoom/Meet/Teams) via Windows loopback.
                    Requires consent from all participants.
                  </div>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={privacy.captureSystemAudio}
                    onChange={(e) => patchPrivacy({ captureSystemAudio: e.target.checked })}
                  />
                  <span className="toggle-track" />
                </label>
              </div>

              <div className="setting-row">
                <div className="setting-text">
                  <div className="setting-name">Delete audio after transcribe</div>
                  <div className="setting-desc">
                    Keep transcript only — WAV files are removed after Whisper finishes.
                  </div>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={privacy.deleteAudioAfterTranscribe}
                    onChange={(e) => patchPrivacy({ deleteAudioAfterTranscribe: e.target.checked })}
                  />
                  <span className="toggle-track" />
                </label>
              </div>

              <div className="setting-row">
                <div className="setting-text">
                  <div className="setting-name">Retention (days)</div>
                  <div className="setting-desc">0 = keep meetings forever. Auto-cleanup coming soon.</div>
                </div>
                <input
                  className="setting-input-num"
                  type="number"
                  min={0}
                  max={3650}
                  value={privacy.retentionDays}
                  onChange={(e) =>
                    patchPrivacy({ retentionDays: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </div>

              <div className="setting-row setting-row--stack">
                <div className="setting-text">
                  <div className="setting-name">Webhook on meeting saved</div>
                  <div className="setting-desc">POST JSON to this URL when a recording is saved.</div>
                </div>
                <input
                  className="setting-input"
                  type="url"
                  placeholder="https://example.com/hooks/candor"
                  value={privacy.webhookUrl ?? ""}
                  onChange={(e) => patchPrivacy({ webhookUrl: e.target.value || null })}
                />
              </div>

              <div className="setting-row">
                <div className="setting-text">
                  <div className="setting-name">Local MCP server</div>
                  <div className="setting-desc">
                    Scaffold only — see docs/mcp-server.md. Exposes meetings to Claude/Cursor.
                  </div>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={privacy.mcpServerEnabled}
                    onChange={(e) => patchPrivacy({ mcpServerEnabled: e.target.checked })}
                  />
                  <span className="toggle-track" />
                </label>
              </div>
            </>
          )}

          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-name">Notes folder</div>
              <div className="setting-desc setting-path">{notesDir || "…"}</div>
            </div>
            <button className="btn-ghost" onClick={() => invoke("open_notes_folder").catch(() => {})}>
              Open
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
