// Candor — local meeting transcription backend.
//
// Pipeline (batch mode): start_recording captures mic audio via cpal into a
// buffer; stop_recording resamples it to 16 kHz mono and runs Whisper.cpp
// (via whisper-rs) to produce a transcript, which is also saved as a markdown
// note. The Whisper model (ggml-base.en) is downloaded on first use.

mod calendar;
mod storage;

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::{AppHandle, Emitter, Manager, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const WHISPER_SAMPLE_RATE: u32 = 16_000;
const DEFAULT_MODEL: &str = "base.en";
const VALID_MODELS: [&str; 3] = ["tiny.en", "base.en", "small.en"];

/// One transcript line surfaced to the UI.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct Segment {
    /// mm:ss start offset.
    pub time: String,
    pub text: String,
}

/// Result returned after stopping a recording.
#[derive(serde::Serialize)]
pub struct StopRecordingResult {
    pub segments: Vec<Segment>,
    #[serde(rename = "meetingId")]
    pub meeting_id: String,
}

#[derive(serde::Serialize, Clone)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

/// Shared recording state held in Tauri's managed state.
#[derive(Default)]
struct AudioState {
    recording: Arc<AtomicBool>,
    /// Raw interleaved samples at the device's native rate.
    samples: Arc<Mutex<Vec<f32>>>,
    /// (sample_rate, channels) captured when recording started.
    config: Arc<Mutex<Option<(u32, u16)>>>,
}

// ---------- Settings ----------

#[derive(serde::Serialize)]
struct Settings {
    model: String,
    #[serde(rename = "notesDir")]
    notes_dir: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn current_model(app: &AppHandle) -> String {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(str::to_string))
        .filter(|m| VALID_MODELS.contains(&m.as_str()))
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    storage::notes_dir(app)
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<Settings, String> {
    Ok(Settings {
        model: current_model(&app),
        notes_dir: notes_dir(&app)?.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn set_model(app: AppHandle, model: String) -> Result<(), String> {
    if !VALID_MODELS.contains(&model.as_str()) {
        return Err("Unknown model".into());
    }
    let p = settings_path(&app)?;
    let mut v: serde_json::Value = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    v["model"] = serde_json::Value::String(model);
    std::fs::write(p, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_notes_folder(app: AppHandle) -> Result<(), String> {
    let dir = notes_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------- Model management ----------

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("ggml-{}.bin", current_model(app))))
}

fn model_url(model: &str) -> String {
    format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin")
}

fn download_model(app: &AppHandle, dest: &Path, url: &str) -> Result<(), String> {
    let resp = ureq::get(url)
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    let total: u64 = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // Stream to a temp file; bypass ureq's 10MB default read cap.
    let tmp = dest.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut reader = resp
        .into_body()
        .into_with_config()
        .limit(4 * 1024 * 1024 * 1024)
        .reader();

    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        let _ = app.emit("model-download-progress", DownloadProgress { downloaded, total });
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Ensure the Whisper model is present locally, downloading it if needed.
#[tauri::command]
async fn ensure_model(app: AppHandle) -> Result<String, String> {
    let path = model_path(&app)?;
    let present = std::fs::metadata(&path)
        .map(|m| m.len() > 1_000_000)
        .unwrap_or(false);
    if present {
        return Ok(path.to_string_lossy().into_owned());
    }
    let app2 = app.clone();
    let path2 = path.clone();
    let url = model_url(&current_model(&app));
    tauri::async_runtime::spawn_blocking(move || download_model(&app2, &path2, &url))
        .await
        .map_err(|e| e.to_string())??;
    Ok(path.to_string_lossy().into_owned())
}

// ---------- Audio capture ----------

#[tauri::command]
fn start_recording(app: AppHandle, state: State<AudioState>) -> Result<(), String> {
    if state.recording.load(Ordering::SeqCst) {
        return Err("Already recording".into());
    }

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No microphone found")?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("No input config: {e}"))?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels();
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    state.samples.lock().unwrap().clear();
    *state.config.lock().unwrap() = Some((sample_rate, channels));
    state.recording.store(true, Ordering::SeqCst);

    let recording = state.recording.clone();
    let samples = state.samples.clone();
    let app_err = app.clone();
    let app_emit = app.clone();
    let (ready_tx, ready_rx) = mpsc::channel();

    // cpal::Stream is !Send on Windows, so it lives entirely on this thread.
    std::thread::spawn(move || {
        let err_fn = move |e| {
            let _ = app_err.emit("recording-error", format!("{e}"));
        };
        let rec = recording.clone();
        let buf = samples.clone();

        let built = match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                move |d: &[f32], _: &cpal::InputCallbackInfo| {
                    if rec.load(Ordering::Relaxed) {
                        buf.lock().unwrap().extend_from_slice(d);
                    }
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config,
                move |d: &[i16], _: &cpal::InputCallbackInfo| {
                    if rec.load(Ordering::Relaxed) {
                        buf.lock()
                            .unwrap()
                            .extend(d.iter().map(|s| *s as f32 / 32768.0));
                    }
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config,
                move |d: &[u16], _: &cpal::InputCallbackInfo| {
                    if rec.load(Ordering::Relaxed) {
                        buf.lock()
                            .unwrap()
                            .extend(d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0));
                    }
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::I32 => device.build_input_stream(
                &config,
                move |d: &[i32], _: &cpal::InputCallbackInfo| {
                    if rec.load(Ordering::Relaxed) {
                        buf.lock()
                            .unwrap()
                            .extend(d.iter().map(|s| *s as f32 / 2_147_483_648.0));
                    }
                },
                err_fn,
                None,
            ),
            other => {
                eprintln!("Unsupported sample format: {other:?}");
                recording.store(false, Ordering::SeqCst);
                let _ = ready_tx.send(Err(format!("Unsupported sample format: {other:?}")));
                return;
            }
        };

        match built {
            Ok(stream) => {
                if let Err(e) = stream.play() {
                    recording.store(false, Ordering::SeqCst);
                    let msg = format!("Failed to start microphone: {e}");
                    let _ = app_emit.emit("recording-error", msg.clone());
                    let _ = ready_tx.send(Err(msg));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                while recording.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                }
                drop(stream); // stops capture
            }
            Err(e) => {
                eprintln!("Failed to build input stream: {e}");
                recording.store(false, Ordering::SeqCst);
                let msg = format!("Failed to open microphone: {e}");
                let _ = app_emit.emit("recording-error", msg.clone());
                let _ = ready_tx.send(Err(msg));
            }
        }
    });

    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            state.recording.store(false, Ordering::SeqCst);
            Err("Timed out starting microphone — check Windows mic permissions for Candor".into())
        }
    }
}

#[tauri::command]
async fn stop_recording(
    app: AppHandle,
    state: State<'_, AudioState>,
    user_notes: Option<String>,
    duration_seconds: u32,
) -> Result<StopRecordingResult, String> {
    if !state.recording.load(Ordering::SeqCst) {
        return Err("Not recording".into());
    }
    state.recording.store(false, Ordering::SeqCst);
    // Let the capture thread observe the flag and drop the stream.
    std::thread::sleep(Duration::from_millis(250));

    let raw = { state.samples.lock().unwrap().clone() };
    let cfg = { *state.config.lock().unwrap() };
    let (sr, ch) = cfg.ok_or("No audio captured")?;
    if raw.is_empty() {
        return Err("No audio captured — check microphone permissions".into());
    }

    let audio = to_mono_16k(&raw, sr, ch);
    let model = model_path(&app)?;
    if !model.exists() {
        return Err("Model not downloaded yet".into());
    }

    let segs = tauri::async_runtime::spawn_blocking(move || transcribe(&model, &audio))
        .await
        .map_err(|e| e.to_string())??;

    let (_path, meeting_id) =
        storage::save_note_file(&app, &segs, user_notes.as_deref(), duration_seconds)?;
    Ok(StopRecordingResult {
        segments: segs,
        meeting_id,
    })
}

// ---------- DSP + transcription (pub for the selftest example) ----------

/// Downmix interleaved samples to mono and resample to 16 kHz (linear).
pub fn to_mono_16k(interleaved: &[f32], sample_rate: u32, channels: u16) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    let mono: Vec<f32> = if ch == 1 {
        interleaved.to_vec()
    } else {
        interleaved
            .chunks(ch)
            .map(|frame| frame.iter().sum::<f32>() / ch as f32)
            .collect()
    };

    if sample_rate == WHISPER_SAMPLE_RATE || mono.is_empty() {
        return mono;
    }

    let ratio = WHISPER_SAMPLE_RATE as f32 / sample_rate as f32;
    let out_len = (mono.len() as f32 * ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    let last = mono.len() - 1;
    for i in 0..out_len {
        let src = i as f32 / ratio;
        let i0 = src.floor() as usize;
        let i1 = (i0 + 1).min(last);
        let frac = src - i0 as f32;
        out.push(mono[i0] * (1.0 - frac) + mono[i1] * frac);
    }
    out
}

/// Run Whisper.cpp on 16 kHz mono audio and return timestamped segments.
pub fn transcribe(model_path: &Path, audio: &[f32]) -> Result<Vec<Segment>, String> {
    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("Failed to load model: {e}"))?;
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let threads = std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4);
    params.set_n_threads(threads);
    params.set_language(Some("en"));
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    state.full(params, audio).map_err(|e| e.to_string())?;

    let n = state.full_n_segments();
    let mut out = Vec::new();
    for i in 0..n {
        if let Some(seg) = state.get_segment(i) {
            let text = seg
                .to_str_lossy()
                .map(|c| c.trim().to_string())
                .unwrap_or_default();
            if text.is_empty() {
                continue;
            }
            out.push(Segment {
                time: fmt_centiseconds(seg.start_timestamp()),
                text,
            });
        }
    }
    Ok(out)
}

fn fmt_centiseconds(cs: i64) -> String {
    let secs = (cs / 100).max(0);
    format!("{:02}:{:02}", secs / 60, secs % 60)
}

// ---------- Note storage (legacy helper removed — see storage.rs) ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AudioState::default())
        .invoke_handler(tauri::generate_handler![
            ensure_model,
            start_recording,
            stop_recording,
            get_settings,
            set_model,
            open_notes_folder,
            storage::list_meetings,
            storage::read_meeting,
            storage::update_saved_meeting,
            storage::delete_saved_meeting,
            storage::get_people,
            storage::save_people,
            storage::get_completed_actions,
            storage::save_completed_actions,
            storage::get_user_tasks,
            storage::save_user_tasks,
            storage::list_storage_folders,
            storage::open_storage_folder,
            calendar::calendar_status,
            calendar::ms_calendar_setup,
            calendar::ms_oauth_connect,
            calendar::ms_disconnect,
            calendar::google_calendar_setup,
            calendar::google_oauth_connect,
            calendar::google_disconnect,
            calendar::apple_connect,
            calendar::apple_disconnect,
            calendar::list_events,
            calendar::update_calendar_event,
            calendar::delete_calendar_event,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
