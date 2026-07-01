import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  loadPrivacySettings,
  savePrivacySettings,
  loadStorageLibraries,
  pickStorageFolder,
  addStorageLibrary,
  setActiveStorageLibrary,
  changeStorageLibraryPath,
  removeStorageLibrary,
  type PrivacySettings,
  type StorageLibrariesState,
} from "../api/local";
import {
  THEME_VARS,
  applyTheme,
  clearThemeOverrides,
  defaultVarColor,
  loadThemeMode,
  loadThemeOverrides,
  saveThemeOverrides,
  type ThemeMode,
  type ThemeOverrides,
} from "../theme";
import {
  SUMMARY_TEMPLATES,
  loadSummaryTemplate,
  saveSummaryTemplate,
  type SummaryTemplateId,
} from "../v2/summaryTemplates";
import {
  readImageAsDataUrl,
  saveProfileImage,
} from "../user";
import { Avatar } from "./Avatar";

export type Theme = ThemeMode;

type SettingsTab = "general" | "customize";
type SettingsSection = {
  id: string;
  label: string;
};

interface SettingsModalProps {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onClose: () => void;
  userInitials: string;
  avatarUrl: string | null;
  onAvatarChange: (url: string | null) => void;
  onStorageChange?: () => void;
}

const MODELS: { value: string; label: string }[] = [
  { value: "tiny.en", label: "Tiny — fastest, roughest" },
  { value: "base.en", label: "Base — recommended" },
  { value: "small.en", label: "Small — most accurate, slower" },
];

const SETTINGS_SECTIONS: Record<SettingsTab, SettingsSection[]> = {
  general: [
    { id: "settings-appearance", label: "Appearance" },
    { id: "settings-transcription", label: "Transcription" },
    { id: "settings-privacy", label: "Privacy & capture" },
    { id: "settings-storage", label: "Storage" },
  ],
  customize: [
    { id: "settings-profile", label: "Profile" },
    { id: "settings-colors", label: "Color scheme" },
  ],
};

export function SettingsModal({
  theme,
  onThemeChange,
  onClose,
  userInitials,
  avatarUrl,
  onAvatarChange,
  onStorageChange,
}: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [model, setModel] = useState("base.en");
  const [notesDir, setNotesDir] = useState("");
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [storage, setStorage] = useState<StorageLibrariesState | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [template, setTemplate] = useState<SummaryTemplateId>(() => loadSummaryTemplate());
  const [overrides, setOverrides] = useState<ThemeOverrides>(() => loadThemeOverrides());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke<{ model: string; notesDir: string }>("get_settings")
      .then((s) => {
        setModel(s.model);
        setNotesDir(s.notesDir);
      })
      .catch(() => {});
    loadPrivacySettings().then(setPrivacy).catch(() => {});
    loadStorageLibraries().then(setStorage).catch(() => {});
  }, []);

  const refreshStorage = async () => {
    const next = await loadStorageLibraries().catch(() => null);
    if (next) setStorage(next);
    invoke<{ model: string; notesDir: string }>("get_settings")
      .then((s) => setNotesDir(s.notesDir))
      .catch(() => {});
    onStorageChange?.();
  };

  const handleChangeLibraryPath = async (id: string) => {
    const picked = await pickStorageFolder();
    if (!picked) return;
    const migrate =
      window.confirm(
        "Move existing Candor files to the new folder?\n\nOK = copy everything to the new location\nCancel = use the new folder empty (existing files stay at the old path)",
      );
    setStorageBusy(true);
    try {
      await changeStorageLibraryPath(id, picked, migrate);
      await refreshStorage();
    } catch (e) {
      window.alert(String(e));
    } finally {
      setStorageBusy(false);
    }
  };

  const handleAddLibrary = async () => {
    const picked = await pickStorageFolder();
    if (!picked) return;
    const name = window.prompt("Name for this storage location:", "Library");
    if (!name?.trim()) return;
    setStorageBusy(true);
    try {
      await addStorageLibrary(name.trim(), picked);
      await refreshStorage();
    } catch (e) {
      window.alert(String(e));
    } finally {
      setStorageBusy(false);
    }
  };

  const handleSetActive = async (id: string) => {
    setStorageBusy(true);
    try {
      await setActiveStorageLibrary(id);
      await refreshStorage();
    } catch (e) {
      window.alert(String(e));
    } finally {
      setStorageBusy(false);
    }
  };

  const handleRemoveLibrary = async (id: string, name: string) => {
    if (
      !window.confirm(
        `Remove "${name}" from Candor?\n\nFiles on disk are not deleted — they stay at their folder path.`,
      )
    ) {
      return;
    }
    setStorageBusy(true);
    try {
      await removeStorageLibrary(id);
      await refreshStorage();
    } catch (e) {
      window.alert(String(e));
    } finally {
      setStorageBusy(false);
    }
  };

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

  const changeTheme = (t: Theme) => {
    onThemeChange(t);
    applyTheme(t, overrides);
  };

  const patchOverride = (key: string, value: string) => {
    const next = { ...overrides, [key]: value };
    if (!value.trim()) delete next[key];
    setOverrides(next);
    saveThemeOverrides(next);
    applyTheme(loadThemeMode(), next);
  };

  const resetColors = () => {
    const cleared = clearThemeOverrides();
    setOverrides(cleared);
  };

  const jumpToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readImageAsDataUrl(file);
      saveProfileImage(dataUrl);
      onAvatarChange(dataUrl);
    } catch {
      /* ignore */
    }
    e.target.value = "";
  };

  const removeImage = () => {
    saveProfileImage(null);
    onAvatarChange(null);
  };

  const groupedVars = THEME_VARS.reduce<Record<string, typeof THEME_VARS>>((acc, v) => {
    (acc[v.group] ??= []).push(v);
    return acc;
  }, {});

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Settings</span>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="settings-tabs">
          <button
            type="button"
            className={`settings-tab${tab === "general" ? " settings-tab--on" : ""}`}
            onClick={() => setTab("general")}
          >
            General
          </button>
          <button
            type="button"
            className={`settings-tab${tab === "customize" ? " settings-tab--on" : ""}`}
            onClick={() => setTab("customize")}
          >
            Customize
          </button>
        </div>

        <div className="modal-body settings-body">
          <aside className="settings-section-nav" aria-label="Settings sections">
            {SETTINGS_SECTIONS[tab].map((section) => (
              <button
                key={section.id}
                type="button"
                className="settings-section-nav-btn"
                onClick={() => jumpToSection(section.id)}
              >
                {section.label}
              </button>
            ))}
          </aside>

          <div className="settings-scroll">
          {tab === "general" && (
            <>
              <section id="settings-appearance" className="settings-section">
                <div className="setting-section-label">Appearance</div>
                <div className="setting-row">
                <div className="setting-text">
                  <div className="setting-name">Theme</div>
                  <div className="setting-desc">Light or dark base — customize colors in the Customize tab.</div>
                </div>
                <div className="seg">
                  <button
                    className={`seg-btn ${theme === "light" ? "seg-btn--on" : ""}`}
                    onClick={() => changeTheme("light")}
                  >
                    Light
                  </button>
                  <button
                    className={`seg-btn ${theme === "dark" ? "seg-btn--on" : ""}`}
                    onClick={() => changeTheme("dark")}
                  >
                    Dark
                  </button>
                </div>
              </div>
              </section>

              <section id="settings-transcription" className="settings-section">
                <div className="setting-section-label">Transcription</div>
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
              </section>

              <section id="settings-privacy" className="settings-section">
                  <div className="setting-section-label">Privacy & capture</div>
                {privacy ? (
                  <>

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
                      <div className="setting-desc">0 = keep meetings forever. Older meetings are cleaned up automatically.</div>
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

                </>
                ) : (
                  <div className="setting-loading">Loading privacy settings...</div>
                )}
              </section>

              <section id="settings-storage" className="settings-section">
              <div className="setting-section-label">Storage locations</div>
              <p className="setting-hint">
                Choose where Candor stores transcripts and notes. Add multiple locations to keep
                separate libraries — switch between them in Files. Meetings from all locations appear
                in your library.
              </p>

              {storage?.libraries.map((lib) => {
                const isActive = lib.id === storage.activeId;
                return (
                  <div key={lib.id} className="storage-lib-row">
                    <div className="storage-lib-info">
                      <div className="storage-lib-name">
                        {lib.name}
                        {isActive && <span className="storage-lib-badge">Active</span>}
                      </div>
                      <code className="storage-lib-path">{lib.path}</code>
                    </div>
                    <div className="storage-lib-actions">
                      {!isActive && (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={storageBusy}
                          onClick={() => handleSetActive(lib.id)}
                        >
                          Use
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={storageBusy}
                        onClick={() => handleChangeLibraryPath(lib.id)}
                      >
                        Change folder
                      </button>
                      {storage.libraries.length > 1 && (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={storageBusy}
                          onClick={() => handleRemoveLibrary(lib.id, lib.name)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              <div className="setting-row">
                <div className="setting-text">
                  <div className="setting-name">Add storage location</div>
                  <div className="setting-desc">
                    Pick any folder on your computer for a new Candor library.
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={storageBusy}
                  onClick={() => void handleAddLibrary()}
                >
                  Add location
                </button>
              </div>

              <div className="setting-row">
                <div className="setting-text">
                  <div className="setting-name">Main folder (Inbox)</div>
                  <div className="setting-desc setting-path">{notesDir || "…"}</div>
                </div>
                <button className="btn-ghost" onClick={() => invoke("open_notes_folder").catch(() => {})}>
                  Open
                </button>
              </div>
              </section>
            </>
          )}

          {tab === "customize" && (
            <>
              <section id="settings-profile" className="settings-section">
                <div className="setting-section-label">Profile</div>
                <div className="setting-row">
                <div className="setting-text">
                  <div className="setting-name">Account picture</div>
                  <div className="setting-desc">Shown in the sidebar. Falls back to your initials.</div>
                </div>
                <div className="avatar-picker">
                  <Avatar
                    label={userInitials}
                    src={avatarUrl}
                    bg="var(--coral)"
                    fg="var(--coral-on)"
                    size={48}
                  />
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="avatar-file-input"
                    onChange={onPickImage}
                  />
                  <button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()}>
                    Upload
                  </button>
                  {avatarUrl && (
                    <button type="button" className="btn-ghost" onClick={removeImage}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
              </section>

              <section id="settings-colors" className="settings-section">
              <div className="setting-section-label">Color scheme</div>
              <p className="setting-hint">
                Override individual colors on top of the {theme} theme. Reset to restore defaults.
              </p>

              {Object.entries(groupedVars).map(([group, vars]) => (
                <div key={group} className="theme-var-group">
                  <div className="theme-var-group-label">{group}</div>
                  {vars.map((v) => (
                    <div key={v.key} className="theme-var-row">
                      <label className="theme-var-label" htmlFor={`var-${v.key}`}>
                        {v.label}
                      </label>
                      <input
                        id={`var-${v.key}`}
                        type="color"
                        className="theme-color-input"
                        value={overrides[v.key] ?? defaultVarColor(theme, v.key)}
                        onChange={(e) => patchOverride(v.key, e.target.value)}
                      />
                      <input
                        type="text"
                        className="theme-hex-input"
                        placeholder="default"
                        value={overrides[v.key] ?? ""}
                        onChange={(e) => patchOverride(v.key, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              ))}

              <div className="setting-row">
                <div className="setting-text">
                  <div className="setting-name">Reset colors</div>
                  <div className="setting-desc">Clear all custom color overrides.</div>
                </div>
                <button type="button" className="btn-ghost" onClick={resetColors}>
                  Reset
                </button>
              </div>
              </section>
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
