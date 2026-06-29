import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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

  useEffect(() => {
    invoke<{ model: string; notesDir: string }>("get_settings")
      .then((s) => {
        setModel(s.model);
        setNotesDir(s.notesDir);
      })
      .catch(() => {});
  }, []);

  const changeModel = async (m: string) => {
    setModel(m);
    try {
      await invoke("set_model", { model: m });
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
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
