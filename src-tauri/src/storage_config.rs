use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLibrary {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLibrariesState {
    pub libraries: Vec<StorageLibrary>,
    pub active_id: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn default_library_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("Candor"))
}

fn default_state(app: &AppHandle) -> Result<StorageLibrariesState, String> {
    let path = default_library_path(app)?;
    Ok(StorageLibrariesState {
        libraries: vec![StorageLibrary {
            id: "default".into(),
            name: "Main Library".into(),
            path: path.to_string_lossy().into_owned(),
        }],
        active_id: "default".into(),
    })
}

pub fn load_storage_libraries(app: &AppHandle) -> Result<StorageLibrariesState, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return default_state(app);
    }

    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid settings: {e}"))?;

    if let Some(libs) = v.get("storageLibraries").and_then(|x| x.as_array()) {
        let libraries: Vec<StorageLibrary> = libs
            .iter()
            .filter_map(|item| serde_json::from_value(item.clone()).ok())
            .collect();
        if !libraries.is_empty() {
            let active_id = v
                .get("activeLibraryId")
                .and_then(|x| x.as_str())
                .unwrap_or("default")
                .to_string();
            let active_id = if libraries.iter().any(|l| l.id == active_id) {
                active_id
            } else {
                libraries[0].id.clone()
            };
            return Ok(StorageLibrariesState {
                libraries,
                active_id,
            });
        }
    }

    if let Some(root) = v.get("candorRoot").and_then(|x| x.as_str()) {
        if !root.trim().is_empty() {
            return Ok(StorageLibrariesState {
                libraries: vec![StorageLibrary {
                    id: "default".into(),
                    name: "Main Library".into(),
                    path: root.trim().to_string(),
                }],
                active_id: "default".into(),
            });
        }
    }

    default_state(app)
}

pub fn save_storage_libraries(
    app: &AppHandle,
    state: &StorageLibrariesState,
) -> Result<(), String> {
    if state.libraries.is_empty() {
        return Err("At least one storage library is required".into());
    }
    if !state.libraries.iter().any(|l| l.id == state.active_id) {
        return Err("Active library not found".into());
    }

    let path = settings_path(app)?;
    let mut v: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    v["storageLibraries"] = serde_json::to_value(&state.libraries).map_err(|e| e.to_string())?;
    v["activeLibraryId"] = serde_json::Value::String(state.active_id.clone());

    fs::write(
        &path,
        serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn active_library_root(app: &AppHandle) -> Result<PathBuf, String> {
    let state = load_storage_libraries(app)?;
    let lib = state
        .libraries
        .iter()
        .find(|l| l.id == state.active_id)
        .or_else(|| state.libraries.first())
        .ok_or_else(|| "No storage library configured".to_string())?;
    Ok(PathBuf::from(&lib.path))
}

pub fn all_library_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let state = load_storage_libraries(app)?;
    Ok(state
        .libraries
        .iter()
        .map(|l| PathBuf::from(&l.path))
        .collect())
}

pub fn validate_writable_dir(path: &Path) -> Result<(), String> {
    reject_risky_library_path(path)?;
    fs::create_dir_all(path).map_err(|e| format!("Cannot create folder: {e}"))?;
    let test = path.join(".candor-write-test");
    fs::write(&test, b"ok").map_err(|e| format!("Folder is not writable: {e}"))?;
    fs::remove_file(&test).ok();
    Ok(())
}

fn reject_risky_library_path(path: &Path) -> Result<(), String> {
    let normalized = if path.exists() {
        path.canonicalize().map_err(|e| e.to_string())?
    } else {
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .and_then(|p| p.canonicalize().ok())
            .map(|parent| parent.join(path.file_name().unwrap_or_default()))
            .unwrap_or_else(|| path.to_path_buf())
    };

    if normalized.parent().is_none() {
        return Err("Choose a folder inside your user files, not a drive root.".into());
    }

    let components = normalized.components().count();
    if components <= 2 {
        return Err("Choose a more specific folder inside your user files.".into());
    }

    #[cfg(target_os = "windows")]
    {
        let lower = normalized.to_string_lossy().to_ascii_lowercase();
        let banned = [
            r"\windows",
            r"\program files",
            r"\program files (x86)",
            r"\programdata",
            r"\appdata",
        ];
        if banned.iter().any(|part| lower.contains(part)) {
            return Err(
                "Choose a normal documents folder, not a system or app data folder.".into(),
            );
        }
    }

    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Err(format!("Source is not a folder: {}", src.display()));
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn migrate_library_data(from: &Path, to: &Path) -> Result<(), String> {
    validate_writable_dir(to)?;
    if !from.exists() {
        return Ok(());
    }
    if from == to {
        return Ok(());
    }
    copy_dir_recursive(from, to)
}

pub fn pick_folder_dialog() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("Choose a folder for Candor files")
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned()))
}

pub fn add_library(app: &AppHandle, name: String, path: String) -> Result<StorageLibrary, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Library name cannot be empty".into());
    }
    let path_buf = PathBuf::from(path.trim());
    if path_buf.as_os_str().is_empty() {
        return Err("Folder path cannot be empty".into());
    }
    validate_writable_dir(&path_buf)?;

    let mut state = load_storage_libraries(app)?;
    if state
        .libraries
        .iter()
        .any(|l| Path::new(&l.path) == path_buf.as_path())
    {
        return Err("This folder is already a storage location".into());
    }

    let library = StorageLibrary {
        id: Uuid::new_v4().to_string(),
        name: trimmed_name.to_string(),
        path: path_buf.to_string_lossy().into_owned(),
    };
    state.libraries.push(library.clone());
    save_storage_libraries(app, &state)?;
    Ok(library)
}

pub fn set_active_library(app: &AppHandle, id: String) -> Result<StorageLibrariesState, String> {
    let mut state = load_storage_libraries(app)?;
    if !state.libraries.iter().any(|l| l.id == id) {
        return Err("Storage location not found".into());
    }
    state.active_id = id;
    save_storage_libraries(app, &state)?;
    Ok(state)
}

pub fn change_library_path(
    app: &AppHandle,
    id: String,
    new_path: String,
    migrate: bool,
) -> Result<StorageLibrary, String> {
    let path_buf = PathBuf::from(new_path.trim());
    if path_buf.as_os_str().is_empty() {
        return Err("Folder path cannot be empty".into());
    }
    validate_writable_dir(&path_buf)?;

    let mut state = load_storage_libraries(app)?;
    let idx = state
        .libraries
        .iter()
        .position(|l| l.id == id)
        .ok_or_else(|| "Storage location not found".to_string())?;
    let old_path = PathBuf::from(&state.libraries[idx].path);

    if state
        .libraries
        .iter()
        .enumerate()
        .any(|(i, l)| i != idx && Path::new(&l.path) == path_buf.as_path())
    {
        return Err("This folder is already a storage location".into());
    }

    if migrate && old_path != path_buf {
        migrate_library_data(&old_path, &path_buf)?;
    }

    state.libraries[idx].path = path_buf.to_string_lossy().into_owned();
    let updated = state.libraries[idx].clone();
    save_storage_libraries(app, &state)?;
    Ok(updated)
}

pub fn rename_library(app: &AppHandle, id: String, name: String) -> Result<StorageLibrary, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Library name cannot be empty".into());
    }
    let mut state = load_storage_libraries(app)?;
    let idx = state
        .libraries
        .iter()
        .position(|l| l.id == id)
        .ok_or_else(|| "Storage location not found".to_string())?;
    state.libraries[idx].name = trimmed.to_string();
    let updated = state.libraries[idx].clone();
    save_storage_libraries(app, &state)?;
    Ok(updated)
}

pub fn remove_library(app: &AppHandle, id: String) -> Result<StorageLibrariesState, String> {
    let mut state = load_storage_libraries(app)?;
    if state.libraries.len() <= 1 {
        return Err("Cannot remove the only storage location".into());
    }
    let idx = state
        .libraries
        .iter()
        .position(|l| l.id == id)
        .ok_or_else(|| "Storage location not found".to_string())?;
    let removing_active = state.libraries[idx].id == state.active_id;
    state.libraries.remove(idx);
    if removing_active {
        state.active_id = state.libraries[0].id.clone();
    }
    save_storage_libraries(app, &state)?;
    Ok(state)
}
