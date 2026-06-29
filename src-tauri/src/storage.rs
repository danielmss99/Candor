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
}

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

pub fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("notes"))
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
}

pub fn save_note_file(
    app: &AppHandle,
    segs: &[Segment],
    user_notes: Option<&str>,
    duration_seconds: u32,
    opts: SaveNoteOptions<'_>,
) -> Result<(PathBuf, String), String> {
    let dir = notes_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let now = Local::now();
    let id = opts
        .meeting_id
        .unwrap_or_else(|| Uuid::new_v4().to_string());
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
    if let Some(fid) = opts.folder_id {
        md.push_str(&format!("folder_id: {fid}\n"));
    }
    if let Some(eid) = opts.calendar_event_id {
        md.push_str(&format!("calendar_event_id: {eid}\n"));
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

    Some(SavedMeeting {
        id,
        title,
        date,
        when_label,
        blurb,
        duration_minutes,
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn list_meetings(app: AppHandle) -> Result<Vec<SavedMeeting>, String> {
    let dir = notes_dir(&app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut meetings: Vec<SavedMeeting> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
        .filter_map(|e| meeting_from_file(&e.path()))
        .collect();
    meetings.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(meetings)
}

#[tauri::command]
pub fn read_meeting(app: AppHandle, id: String) -> Result<MeetingDetail, String> {
    let dir = notes_dir(&app)?;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().is_none_or(|x| x != "md") {
            continue;
        }
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let (meta, body) = parse_frontmatter(&raw);
        let file_id = meta
            .get("id")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| {
                path.file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
        if file_id != id {
            continue;
        }
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
        return Ok(MeetingDetail {
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
        });
    }
    Err("Meeting not found".into())
}

fn meeting_path_by_id(dir: &Path, id: &str) -> Result<PathBuf, String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().is_none_or(|x| x != "md") {
            continue;
        }
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

#[derive(Deserialize)]
pub struct UpdateSavedMeetingPayload {
    id: String,
    title: Option<String>,
    date: Option<String>,
    folder_id: Option<String>,
}

#[tauri::command]
pub fn update_saved_meeting(app: AppHandle, payload: UpdateSavedMeetingPayload) -> Result<(), String> {
    let dir = notes_dir(&app)?;
    let path = meeting_path_by_id(&dir, &payload.id)?;
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
    if let Some(folder) = &payload.folder_id {
        if folder.is_empty() {
            meta.remove("folder_id");
        } else {
            meta.insert(
                "folder_id".into(),
                serde_json::Value::String(folder.clone()),
            );
        }
    }
    fs::write(&path, write_frontmatter(&meta, &body)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_saved_meeting(app: AppHandle, id: String) -> Result<(), String> {
    let dir = notes_dir(&app)?;
    let path = meeting_path_by_id(&dir, &id)?;
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
            id: "notes".into(),
            label: "Meeting notes".into(),
            description: "Transcripts and recaps saved from your recordings".into(),
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
    let dir = notes_dir(app)?;
    let path = meeting_path_by_id(&dir, id)?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (meta, _) = parse_frontmatter(&raw);
    Ok(meta
        .get("audio_path")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|p| Path::new(p).exists()))
}
