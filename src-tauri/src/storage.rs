use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::Segment;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub initials: String,
    pub color: String,
    #[serde(rename = "voiceLabel")]
    pub voice_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMeeting {
    pub id: String,
    pub title: String,
    pub date: String,
    pub when_label: String,
    pub blurb: String,
    pub duration_minutes: u32,
    pub path: String,
    pub folder_id: Option<String>,
}

/// User-created folder for organizing meetings (Outlook-style tree).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTreeNode {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub disk_path: String,
    pub children: Vec<FolderTreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FolderStore {
    folders: Vec<OrgFolder>,
}

pub const INBOX_FOLDER_ID: &str = "inbox";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDetail {
    pub id: String,
    pub title: String,
    pub date: String,
    pub duration_seconds: u32,
    pub user_notes: String,
    pub transcript: Vec<Segment>,
    pub audio_path: Option<String>,
    pub folder_id: Option<String>,
    pub calendar_event_id: Option<String>,
    pub status: Option<String>,
    pub transcription_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageFolder {
    pub id: String,
    pub label: String,
    pub description: String,
    pub path: String,
}

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// User-facing root for organized meeting files: `{app_data}/Candor/`.
pub fn candor_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("Candor"))
}

pub fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(candor_root(app)?.join("Inbox"))
}

fn legacy_notes_dir(app: &AppHandle) -> PathBuf {
    app_data(app)
        .map(|d| d.join("notes"))
        .unwrap_or_else(|_| PathBuf::from("notes"))
}

fn folders_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(candor_root(app)?.join("folders.json"))
}

fn sanitize_folder_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = s.trim();
    if trimmed.is_empty() {
        "Folder".to_string()
    } else if trimmed == "." || trimmed == ".." {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

fn load_folder_store_raw(app: &AppHandle) -> Result<FolderStore, String> {
    let path = folders_config_path(app)?;
    if !path.exists() {
        return Ok(FolderStore {
            folders: vec![OrgFolder {
                id: INBOX_FOLDER_ID.into(),
                name: "Inbox".into(),
                parent_id: None,
            }],
        });
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn save_folder_store(app: &AppHandle, store: &FolderStore) -> Result<(), String> {
    let root = candor_root(app)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let path = folders_config_path(app)?;
    fs::write(
        &path,
        serde_json::to_string_pretty(store).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn folder_rel_segments(folders: &[OrgFolder], id: &str) -> Result<Vec<String>, String> {
    let mut segments = Vec::new();
    let mut current = Some(id.to_string());
    while let Some(fid) = current {
        let folder = folders
            .iter()
            .find(|f| f.id == fid)
            .ok_or_else(|| format!("Folder not found: {fid}"))?;
        segments.push(sanitize_folder_name(&folder.name));
        current = folder.parent_id.clone();
    }
    segments.reverse();
    Ok(segments)
}

fn folder_disk_path(root: &Path, folders: &[OrgFolder], id: &str) -> Result<PathBuf, String> {
    let segments = folder_rel_segments(folders, id)?;
    Ok(segments.iter().fold(root.to_path_buf(), |p, s| p.join(s)))
}

fn sync_disk_folders(app: &AppHandle, folders: &[OrgFolder]) -> Result<(), String> {
    let root = candor_root(app)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    for folder in folders {
        let path = folder_disk_path(&root, folders, &folder.id)?;
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn migrate_legacy_notes(app: &AppHandle) -> Result<(), String> {
    let legacy = legacy_notes_dir(app);
    if !legacy.exists() {
        return Ok(());
    }
    let store = load_folder_store_raw(app)?;
    let inbox = folder_disk_path(&candor_root(app)?, &store.folders, INBOX_FOLDER_ID)?;
    fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(&legacy).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().is_some_and(|x| x == "md") {
            let dest = inbox.join(path.file_name().ok_or("Invalid filename")?);
            if !dest.exists() {
                fs::rename(&path, &dest).or_else(|_| {
                    fs::copy(&path, &dest).map(|_| ()).map_err(|e| e.to_string())
                })?;
            }
        }
    }
    Ok(())
}

pub fn ensure_folder_store(app: &AppHandle) -> Result<Vec<OrgFolder>, String> {
    let root = candor_root(app)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut store = load_folder_store_raw(app)?;
    if !store.folders.iter().any(|f| f.id == INBOX_FOLDER_ID) {
        store.folders.insert(
            0,
            OrgFolder {
                id: INBOX_FOLDER_ID.into(),
                name: "Inbox".into(),
                parent_id: None,
            },
        );
    }
    migrate_legacy_notes(app)?;
    sync_disk_folders(app, &store.folders)?;
    save_folder_store(app, &store)?;
    Ok(store.folders)
}

fn meeting_search_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    ensure_folder_store(app)?;
    let mut roots = vec![candor_root(app)?];
    let legacy = legacy_notes_dir(app);
    if legacy.exists() {
        roots.push(legacy);
    }
    Ok(roots)
}

fn collect_md_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_md_files(&path, out)?;
        } else if path.extension().is_some_and(|x| x == "md") {
            out.push(path);
        }
    }
    Ok(())
}

fn meeting_path_by_id_recursive(dir: &Path, id: &str) -> Result<PathBuf, String> {
    let mut files = Vec::new();
    collect_md_files(dir, &mut files)?;
    for path in files {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let (meta, _) = parse_frontmatter(&raw);
        let file_id = meta
            .get("id")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| {
                path.file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
        if file_id == id {
            return Ok(path);
        }
    }
    Err("Meeting not found".into())
}

fn meeting_path_by_id(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    for root in meeting_search_roots(app)? {
        if let Ok(path) = meeting_path_by_id_recursive(&root, id) {
            return Ok(path);
        }
    }
    Err("Meeting not found".into())
}

fn resolve_target_dir(app: &AppHandle, folder_id: Option<&str>) -> Result<PathBuf, String> {
    let folders = ensure_folder_store(app)?;
    let fid = folder_id.unwrap_or(INBOX_FOLDER_ID);
    let root = candor_root(app)?;
    folder_disk_path(&root, &folders, fid)
}

fn move_meeting_file(app: &AppHandle, path: &Path, folder_id: Option<&str>) -> Result<PathBuf, String> {
    let target_dir = resolve_target_dir(app, folder_id)?;
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let filename = path
        .file_name()
        .ok_or("Invalid meeting filename")?
        .to_owned();
    let dest = target_dir.join(filename);
    if path != dest.as_path() {
        if dest.exists() {
            fs::remove_file(&dest).ok();
        }
        fs::rename(path, &dest).or_else(|_| {
            fs::copy(path, &dest).map(|_| ()).map_err(|e| e.to_string())?;
            fs::remove_file(path).map_err(|e| e.to_string())
        })?;
    }
    Ok(dest)
}

fn build_folder_tree(folders: &[OrgFolder], root: &Path, parent_id: Option<&str>) -> Vec<FolderTreeNode> {
    folders
        .iter()
        .filter(|f| f.parent_id.as_deref() == parent_id)
        .map(|f| {
            let disk_path = folder_disk_path(root, folders, &f.id)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            FolderTreeNode {
                id: f.id.clone(),
                name: f.name.clone(),
                parent_id: f.parent_id.clone(),
                disk_path,
                children: build_folder_tree(folders, root, Some(&f.id)),
            }
        })
        .collect()
}

fn folder_descendants(folders: &[OrgFolder], id: &str) -> Vec<String> {
    let mut out = vec![id.to_string()];
    let mut i = 0;
    while i < out.len() {
        let current = out[i].clone();
        for f in folders {
            if f.parent_id.as_deref() == Some(current.as_str()) {
                out.push(f.id.clone());
            }
        }
        i += 1;
    }
    out
}

fn collect_meetings_in_folder_dirs(
    root: &Path,
    folders: &[OrgFolder],
    folder_id: &str,
) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for fid in folder_descendants(folders, folder_id) {
        let dir = folder_disk_path(root, folders, &fid)?;
        collect_md_files(&dir, &mut paths)?;
    }
    Ok(paths)
}

fn people_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("people.json"))
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("models"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedAction {
    pub id: String,
    pub text: String,
    pub owner: String,
    pub due: String,
    pub meeting: String,
    pub meeting_id: Option<String>,
    pub soon: Option<bool>,
    pub completed_at: String,
}

fn completed_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("completed"))
}

fn completed_actions_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(completed_dir(app)?.join("actions.json"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTask {
    pub id: String,
    pub text: String,
    pub owner: String,
    pub due: String,
    pub meeting: String,
    pub soon: Option<bool>,
    pub created_at: String,
}

fn user_tasks_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("tasks.json"))
}

fn parse_frontmatter(raw: &str) -> (serde_json::Map<String, serde_json::Value>, String) {
    let mut meta = serde_json::Map::new();
    let body = if raw.starts_with("---\n") {
        if let Some(end) = raw[4..].find("\n---\n") {
            let fm = &raw[4..4 + end];
            for line in fm.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    meta.insert(
                        k.trim().to_string(),
                        serde_json::Value::String(v.trim().to_string()),
                    );
                }
            }
            raw[4 + end + 5..].to_string()
        } else {
            raw.to_string()
        }
    } else {
        raw.to_string()
    };
    (meta, body)
}

fn parse_transcript(body: &str) -> Vec<Segment> {
    let mut segs = Vec::new();
    let mut in_transcript = false;
    for line in body.lines() {
        if line.starts_with("# Transcript") {
            in_transcript = true;
            continue;
        }
        if !in_transcript {
            continue;
        }
        if line.starts_with('#') {
            break;
        }
        if let Some(rest) = line.strip_prefix('`') {
            if let Some((time, text)) = rest.split_once('`') {
                let text = text.trim();
                if !text.is_empty() {
                    let (speaker, body) = if let Some(stripped) = text.strip_prefix('[') {
                        if let Some((spk, rest)) = stripped.split_once("] ") {
                            (Some(spk.to_string()), rest.to_string())
                        } else {
                            (None, text.to_string())
                        }
                    } else {
                        (None, text.to_string())
                    };
                    segs.push(Segment {
                        time: time.to_string(),
                        text: body,
                        speaker,
                    });
                }
            }
        }
    }
    segs
}

fn parse_user_notes(body: &str) -> String {
    let mut notes = String::new();
    let mut in_notes = false;
    for line in body.lines() {
        if line.starts_with("# My notes") {
            in_notes = true;
            continue;
        }
        if in_notes {
            if line.starts_with('#') {
                break;
            }
            notes.push_str(line);
            notes.push('\n');
        }
    }
    notes.trim().to_string()
}

fn preview_from_body(body: &str, transcript: &[Segment]) -> String {
    if let Some(first) = transcript.first() {
        let t = first.text.trim();
        if t.len() > 120 {
            return format!("{}…", &t[..117]);
        }
        return t.to_string();
    }
    parse_user_notes(body)
}

fn relative_when(iso: &str) -> String {
    DateTime::parse_from_rfc3339(iso)
        .map(|dt| {
            let local: DateTime<Local> = dt.into();
            let now = Local::now();
            if local.date_naive() == now.date_naive() {
                "Today".to_string()
            } else if local.date_naive() == now.date_naive() - chrono::Days::new(1) {
                "Yesterday".to_string()
            } else {
                local.format("%a").to_string()
            }
        })
        .unwrap_or_else(|_| "Saved".to_string())
}

pub struct SaveNoteOptions<'a> {
    pub meeting_id: Option<String>,
    pub title_override: Option<&'a str>,
    pub audio_path: Option<&'a str>,
    pub calendar_event_id: Option<&'a str>,
    pub folder_id: Option<&'a str>,
    pub status: Option<&'a str>,
    pub transcription_error: Option<&'a str>,
}

pub fn save_note_file(
    app: &AppHandle,
    segs: &[Segment],
    user_notes: Option<&str>,
    duration_seconds: u32,
    opts: SaveNoteOptions<'_>,
) -> Result<(PathBuf, String), String> {
    let dir = resolve_target_dir(app, opts.folder_id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let now = Local::now();
    let id = opts
        .meeting_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let folder_id = opts.folder_id.unwrap_or(INBOX_FOLDER_ID);
    let filename = format!("{}-{}.md", now.format("%Y-%m-%d-%H%M%S"), &id[..8.min(id.len())]);
    let path = dir.join(filename);

    let title = opts.title_override.map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).or_else(|| {
        segs.first().map(|s| {
            let t = s.text.trim();
            if t.len() > 60 {
                format!("{}…", &t[..57])
            } else {
                t.to_string()
            }
        })
    }).unwrap_or_else(|| format!("Recording {}", now.format("%b %-d, %Y")));

    let mut md = String::new();
    md.push_str("---\n");
    md.push_str(&format!("id: {id}\n"));
    md.push_str(&format!("title: {title}\n"));
    md.push_str(&format!("date: {}\n", now.to_rfc3339()));
    md.push_str(&format!("duration_seconds: {duration_seconds}\n"));
    if let Some(ap) = opts.audio_path {
        md.push_str(&format!("audio_path: {ap}\n"));
    }
    md.push_str(&format!("folder_id: {folder_id}\n"));
    if let Some(eid) = opts.calendar_event_id {
        md.push_str(&format!("calendar_event_id: {eid}\n"));
    }
    if let Some(status) = opts.status {
        md.push_str(&format!("status: {status}\n"));
    }
    if let Some(err) = opts.transcription_error {
        md.push_str(&format!("transcription_error: {err}\n"));
    }
    md.push_str("---\n\n");

    if let Some(notes) = user_notes.filter(|n| !n.trim().is_empty()) {
        md.push_str("# My notes\n\n");
        md.push_str(notes.trim());
        md.push_str("\n\n");
    }

    md.push_str("# Transcript\n\n");
    for s in segs {
        let line = if let Some(ref spk) = s.speaker {
            format!("`{}` [{}] {}\n\n", s.time, spk, s.text)
        } else {
            format!("`{}` {}\n\n", s.time, s.text)
        };
        md.push_str(&line);
    }
    fs::write(&path, md).map_err(|e| e.to_string())?;
    Ok((path, id))
}

// Legacy notes without an id still appear in the list.
fn meeting_from_file(path: &Path) -> Option<SavedMeeting> {
    let raw = fs::read_to_string(path).ok()?;
    let (meta, body) = parse_frontmatter(&raw);
    let id = meta
        .get("id")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    let title = meta
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Recording")
        .to_string();
    let date = meta
        .get("date")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let duration_seconds: u32 = meta
        .get("duration_seconds")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let duration_minutes = (duration_seconds / 60).max(1);
    let transcript = parse_transcript(&body);
    let blurb = preview_from_body(&body, &transcript);
    let when_label = if date.is_empty() {
        "Saved".to_string()
    } else {
        format!("{} · {} min", relative_when(&date), duration_minutes)
    };

    let folder_id = meta
        .get("folder_id")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| Some(INBOX_FOLDER_ID.to_string()));

    Some(SavedMeeting {
        id,
        title,
        date,
        when_label,
        blurb,
        duration_minutes,
        path: path.to_string_lossy().into_owned(),
        folder_id,
    })
}

#[tauri::command]
pub fn list_meetings(app: AppHandle) -> Result<Vec<SavedMeeting>, String> {
    let mut files = Vec::new();
    for root in meeting_search_roots(&app)? {
        collect_md_files(&root, &mut files)?;
    }
    let mut meetings: Vec<SavedMeeting> = files
        .iter()
        .filter_map(|p| meeting_from_file(p))
        .collect();
    meetings.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(meetings)
}

#[tauri::command]
pub fn read_meeting(app: AppHandle, id: String) -> Result<MeetingDetail, String> {
    let path = meeting_path_by_id(&app, &id)?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (meta, body) = parse_frontmatter(&raw);
    let title = meta
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Recording")
        .to_string();
    let date = meta
        .get("date")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let duration_seconds: u32 = meta
        .get("duration_seconds")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok(MeetingDetail {
        id,
        title,
        date,
        duration_seconds,
        user_notes: parse_user_notes(&body),
        transcript: parse_transcript(&body),
        audio_path: meta
            .get("audio_path")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|p| Path::new(p).exists()),
        folder_id: meta
            .get("folder_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        calendar_event_id: meta
            .get("calendar_event_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        status: meta
            .get("status")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        transcription_error: meta
            .get("transcription_error")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

fn write_frontmatter(meta: &serde_json::Map<String, serde_json::Value>, body: &str) -> String {
    let mut md = String::from("---\n");
    for (k, v) in meta {
        if let Some(s) = v.as_str() {
            md.push_str(&format!("{k}: {s}\n"));
        }
    }
    md.push_str("---\n\n");
    md.push_str(body);
    md
}

fn format_transcript_body(segs: &[Segment], user_notes: &str) -> String {
    let mut body = String::new();
    if !user_notes.trim().is_empty() {
        body.push_str("# My notes\n\n");
        body.push_str(user_notes.trim());
        body.push_str("\n\n");
    }
    body.push_str("# Transcript\n\n");
    for s in segs {
        let line = if let Some(ref spk) = s.speaker {
            format!("`{}` [{}] {}\n\n", s.time, spk, s.text)
        } else {
            format!("`{}` {}\n\n", s.time, s.text)
        };
        body.push_str(&line);
    }
    body
}

pub fn update_meeting_transcript(
    app: &AppHandle,
    id: &str,
    segs: &[Segment],
    status: &str,
    transcription_error: Option<&str>,
) -> Result<(), String> {
    let path = meeting_path_by_id(app, id)?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (mut meta, body) = parse_frontmatter(&raw);
    let user_notes = parse_user_notes(&body);
    meta.insert("status".into(), serde_json::Value::String(status.into()));
    if let Some(err) = transcription_error {
        meta.insert(
            "transcription_error".into(),
            serde_json::Value::String(err.into()),
        );
    } else {
        meta.remove("transcription_error");
    }
    let new_body = format_transcript_body(segs, &user_notes);
    fs::write(&path, write_frontmatter(&meta, &new_body)).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct UpdateSavedMeetingPayload {
    id: String,
    title: Option<String>,
    date: Option<String>,
    folder_id: Option<String>,
}

#[tauri::command]
pub fn update_saved_meeting(app: AppHandle, payload: UpdateSavedMeetingPayload) -> Result<(), String> {
    let path = meeting_path_by_id(&app, &payload.id)?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (mut meta, body) = parse_frontmatter(&raw);
    if let Some(title) = payload.title.filter(|t| !t.trim().is_empty()) {
        meta.insert(
            "title".into(),
            serde_json::Value::String(title.trim().to_string()),
        );
    }
    if let Some(date) = payload.date.filter(|d| !d.trim().is_empty()) {
        meta.insert(
            "date".into(),
            serde_json::Value::String(date.trim().to_string()),
        );
    }
    let mut new_path = path.clone();
    if let Some(folder) = &payload.folder_id {
        let target = if folder.is_empty() {
            None
        } else {
            Some(folder.as_str())
        };
        if target.is_some() {
            meta.insert(
                "folder_id".into(),
                serde_json::Value::String(folder.clone()),
            );
        } else {
            meta.insert(
                "folder_id".into(),
                serde_json::Value::String(INBOX_FOLDER_ID.into()),
            );
        }
        new_path = move_meeting_file(&app, &path, target)?;
    }
    fs::write(&new_path, write_frontmatter(&meta, &body)).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMeetingEditsPayload {
    pub id: String,
    pub title: Option<String>,
    pub user_notes: Option<String>,
    pub transcript: Option<Vec<Segment>>,
}

#[tauri::command]
pub fn save_meeting_edits(app: AppHandle, payload: SaveMeetingEditsPayload) -> Result<(), String> {
    let path = meeting_path_by_id(&app, &payload.id)?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (mut meta, body) = parse_frontmatter(&raw);
    if let Some(title) = payload.title.filter(|t| !t.trim().is_empty()) {
        meta.insert(
            "title".into(),
            serde_json::Value::String(title.trim().to_string()),
        );
    }
    let user_notes = payload
        .user_notes
        .unwrap_or_else(|| parse_user_notes(&body));
    let segs = payload
        .transcript
        .unwrap_or_else(|| parse_transcript(&body));
    let new_body = format_transcript_body(&segs, &user_notes);
    fs::write(&path, write_frontmatter(&meta, &new_body)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_saved_meeting(app: AppHandle, id: String) -> Result<(), String> {
    let path = meeting_path_by_id(&app, &id)?;
    fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_people(app: AppHandle) -> Result<Vec<Person>, String> {
    let path = people_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_people(app: AppHandle, people: Vec<Person>) -> Result<(), String> {
    let dir = app_data(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = people_path(&app)?;
    fs::write(
        &path,
        serde_json::to_string_pretty(&people).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_completed_actions(app: AppHandle) -> Result<Vec<CompletedAction>, String> {
    let path = completed_actions_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_completed_actions(app: AppHandle, actions: Vec<CompletedAction>) -> Result<(), String> {
    let dir = completed_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = completed_actions_path(&app)?;
    fs::write(
        &path,
        serde_json::to_string_pretty(&actions).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_user_tasks(app: AppHandle) -> Result<Vec<UserTask>, String> {
    let path = user_tasks_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_user_tasks(app: AppHandle, tasks: Vec<UserTask>) -> Result<(), String> {
    let dir = app_data(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = user_tasks_path(&app)?;
    fs::write(
        &path,
        serde_json::to_string_pretty(&tasks).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_storage_folders(app: AppHandle) -> Result<Vec<StorageFolder>, String> {
    let _ = ensure_folder_store(&app)?;
    let data = app_data(&app)?;
    let notes = notes_dir(&app)?;
    let models = models_dir(&app)?;
    let completed = completed_dir(&app)?;
    fs::create_dir_all(&notes).ok();
    fs::create_dir_all(&models).ok();
    fs::create_dir_all(&completed).ok();

    Ok(vec![
        StorageFolder {
            id: "audio".into(),
            label: "Meeting audio".into(),
            description: "WAV recordings linked to transcripts".into(),
            path: app_data(&app)?.join("audio").to_string_lossy().into_owned(),
        },
        StorageFolder {
            id: "candor".into(),
            label: "Candor files".into(),
            description: "Organized folders, transcripts, and notes".into(),
            path: candor_root(&app)?.to_string_lossy().into_owned(),
        },
        StorageFolder {
            id: "notes".into(),
            label: "Meeting notes (Inbox)".into(),
            description: "Default folder for new transcripts and recaps".into(),
            path: notes.to_string_lossy().into_owned(),
        },
        StorageFolder {
            id: "completed".into(),
            label: "Completed actions".into(),
            description: "Action items you marked done — stored in actions.json".into(),
            path: completed.to_string_lossy().into_owned(),
        },
        StorageFolder {
            id: "models".into(),
            label: "Speech models".into(),
            description: "Whisper models downloaded for on-device transcription".into(),
            path: models.to_string_lossy().into_owned(),
        },
        StorageFolder {
            id: "data".into(),
            label: "Candor data".into(),
            description: "People, settings, and app configuration".into(),
            path: data.to_string_lossy().into_owned(),
        },
    ])
}

#[tauri::command]
pub fn open_storage_folder(app: AppHandle, folder_id: String) -> Result<(), String> {
    let path = match folder_id.as_str() {
        "audio" => {
            let dir = app_data(&app)?.join("audio");
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            dir
        }
        "notes" => notes_dir(&app)?,
        "candor" => candor_root(&app)?,
        "completed" => completed_dir(&app)?,
        "models" => models_dir(&app)?,
        "data" => app_data(&app)?,
        other => return Err(format!("Unknown folder: {other}")),
    };
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

pub fn meeting_audio_path(app: &AppHandle, id: &str) -> Result<Option<String>, String> {
    let path = meeting_path_by_id(app, id)?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (meta, _) = parse_frontmatter(&raw);
    Ok(meta
        .get("audio_path")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|p| Path::new(p).exists()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRecording {
    pub meeting_id: String,
    pub started_at: String,
    pub live_wav_path: String,
    pub system_wav_path: Option<String>,
    pub title: Option<String>,
    pub last_checkpoint_at: Option<String>,
}

fn active_recording_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("active-recording.json"))
}

pub fn save_active_recording(app: &AppHandle, rec: &ActiveRecording) -> Result<(), String> {
    let path = active_recording_path(app)?;
    fs::write(
        &path,
        serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn load_active_recording(app: &AppHandle) -> Result<Option<ActiveRecording>, String> {
    let path = active_recording_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string()).map(Some)
}

pub fn clear_active_recording(app: &AppHandle) -> Result<(), String> {
    let path = active_recording_path(app)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Create or update a draft note while recording is in progress.
pub fn save_recording_checkpoint(
    app: &AppHandle,
    meeting_id: &str,
    duration_seconds: u32,
    audio_path: &str,
    title: Option<&str>,
) -> Result<(), String> {
    if meeting_path_by_id(app, meeting_id).is_ok() {
        let path = meeting_path_by_id(app, meeting_id)?;
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let (mut meta, body) = parse_frontmatter(&raw);
        meta.insert(
            "duration_seconds".into(),
            serde_json::Value::String(duration_seconds.to_string()),
        );
        meta.insert(
            "audio_path".into(),
            serde_json::Value::String(audio_path.into()),
        );
        meta.insert(
            "status".into(),
            serde_json::Value::String("recording_draft".into()),
        );
        if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
            meta.insert(
                "title".into(),
                serde_json::Value::String(t.trim().to_string()),
            );
        }
        fs::write(&path, write_frontmatter(&meta, &body)).map_err(|e| e.to_string())?;
    } else {
        save_note_file(
            app,
            &[],
            None,
            duration_seconds,
            SaveNoteOptions {
                meeting_id: Some(meeting_id.to_string()),
                title_override: title,
                audio_path: Some(audio_path),
                calendar_event_id: None,
                folder_id: Some(INBOX_FOLDER_ID),
                status: Some("recording_draft"),
                transcription_error: None,
            },
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_candor_root_path(app: AppHandle) -> Result<String, String> {
    ensure_folder_store(&app)?;
    Ok(candor_root(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_folder_tree(app: AppHandle) -> Result<Vec<FolderTreeNode>, String> {
    let folders = ensure_folder_store(&app)?;
    let root = candor_root(&app)?;
    Ok(build_folder_tree(&folders, &root, None))
}

#[tauri::command]
pub fn create_folder(
    app: AppHandle,
    name: String,
    parent_id: Option<String>,
) -> Result<OrgFolder, String> {
    let mut folders = ensure_folder_store(&app)?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Folder name cannot be empty".into());
    }
    if let Some(ref pid) = parent_id {
        if !folders.iter().any(|f| f.id == *pid) {
            return Err("Parent folder not found".into());
        }
    }
    let folder = OrgFolder {
        id: Uuid::new_v4().to_string(),
        name: trimmed.to_string(),
        parent_id,
    };
    folders.push(folder.clone());
    sync_disk_folders(&app, &folders)?;
    save_folder_store(&app, &FolderStore { folders })?;
    Ok(folder)
}

#[tauri::command]
pub fn rename_folder(app: AppHandle, id: String, name: String) -> Result<OrgFolder, String> {
    if id == INBOX_FOLDER_ID {
        return Err("Cannot rename the Inbox folder".into());
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Folder name cannot be empty".into());
    }
    let mut folders = ensure_folder_store(&app)?;
    let idx = folders
        .iter()
        .position(|f| f.id == id)
        .ok_or_else(|| "Folder not found".to_string())?;
    let root = candor_root(&app)?;
    let old_path = folder_disk_path(&root, &folders, &id)?;
    folders[idx].name = trimmed.to_string();
    let new_path = folder_disk_path(&root, &folders, &id)?;
    if old_path != new_path {
        if new_path.exists() {
            return Err("A folder with that name already exists".into());
        }
        if old_path.exists() {
            if let Some(parent) = new_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;
        } else {
            fs::create_dir_all(&new_path).map_err(|e| e.to_string())?;
        }
    }
    let updated = folders[idx].clone();
    save_folder_store(&app, &FolderStore { folders: folders.clone() })?;
    sync_disk_folders(&app, &folders)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_folder(app: AppHandle, id: String) -> Result<(), String> {
    if id == INBOX_FOLDER_ID {
        return Err("Cannot delete the Inbox folder".into());
    }
    let mut folders = ensure_folder_store(&app)?;
    let folder = folders
        .iter()
        .find(|f| f.id == id)
        .ok_or_else(|| "Folder not found".to_string())?
        .clone();
    let parent_id = folder
        .parent_id
        .clone()
        .unwrap_or_else(|| INBOX_FOLDER_ID.to_string());
    let root = candor_root(&app)?;
    let dir = folder_disk_path(&root, &folders, &id)?;

    let meeting_files = collect_meetings_in_folder_dirs(&root, &folders, &id)?;
    for path in meeting_files {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let (mut meta, body) = parse_frontmatter(&raw);
        meta.insert(
            "folder_id".into(),
            serde_json::Value::String(parent_id.clone()),
        );
        let dest = move_meeting_file(&app, &path, Some(&parent_id))?;
        fs::write(&dest, write_frontmatter(&meta, &body)).map_err(|e| e.to_string())?;
    }

    for f in folders.iter_mut() {
        if f.parent_id.as_deref() == Some(id.as_str()) {
            f.parent_id = Some(parent_id.clone());
        }
    }
    folders.retain(|f| f.id != id);

    if dir.exists() {
        fs::remove_dir_all(&dir).ok();
    }

    sync_disk_folders(&app, &folders)?;
    save_folder_store(&app, &FolderStore { folders })?;
    Ok(())
}

#[tauri::command]
pub fn move_meeting_to_folder(
    app: AppHandle,
    meeting_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    let target = folder_id.unwrap_or_else(|| INBOX_FOLDER_ID.to_string());
    update_saved_meeting(
        app,
        UpdateSavedMeetingPayload {
            id: meeting_id,
            title: None,
            date: None,
            folder_id: Some(target),
        },
    )
}

#[tauri::command]
pub fn open_candor_folder(app: AppHandle) -> Result<(), String> {
    let path = candor_root(&app)?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}
