use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacySettings {
    /// Delete WAV files after successful transcription.
    pub delete_audio_after_transcribe: bool,
    /// Days to retain meetings (0 = keep forever).
    pub retention_days: u32,
    /// Capture system/loopback audio alongside microphone.
    pub capture_system_audio: bool,
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn load_privacy(app: &AppHandle) -> PrivacySettings {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| serde_json::from_value::<PrivacySettings>(v.get("privacy")?.clone()).ok())
        .unwrap_or_default()
}

pub fn save_privacy(app: &AppHandle, privacy: &PrivacySettings) -> Result<(), String> {
    let p = settings_path(app)?;
    let mut v: serde_json::Value = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    v["privacy"] = serde_json::to_value(privacy).map_err(|e| e.to_string())?;
    std::fs::write(
        p,
        serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
