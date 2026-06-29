// Candor — local meeting transcription backend.
//
// Long recordings: mic audio streams to `{id}.recording.wav` on disk (~115 MB/h at
// 16 kHz mono after resample). Whisper runs in 5-minute chunks from file (bounded RAM).
// Checkpoints save a draft note every 5 minutes. Practical limit: disk space — e.g.
// 4+ hours needs ~500 MB audio + ~2 GB free recommended on Windows.

mod audio;
mod calendar;
mod privacy;
mod storage;

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::{AppHandle, Emitter, Manager, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const WHISPER_SAMPLE_RATE: u32 = audio::WHISPER_SAMPLE_RATE;
const DEFAULT_MODEL: &str = "base.en";
const VALID_MODELS: [&str; 3] = ["tiny.en", "base.en", "small.en"];

/// Save a draft note every 5 minutes while recording (crash recovery).
const CHECKPOINT_INTERVAL_SECS: u64 = 300;
/// Whisper processes audio in 5-minute chunks (~48 chunks for 4 h).
const CHUNK_DURATION_SECS: u32 = 300;

/// One transcript line surfaced to the UI.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct Segment {
    /// mm:ss start offset.
    pub time: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
}

/// Result returned after stopping a recording.
#[derive(serde::Serialize)]
pub struct StopRecordingResult {
    pub segments: Vec<Segment>,
    #[serde(rename = "meetingId")]
    pub meeting_id: String,
    pub status: String,
    #[serde(rename = "transcriptionError")]
    pub transcription_error: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct TranscriptionProgress {
    chunk: u32,
    #[serde(rename = "totalChunks")]
    total_chunks: u32,
    percent: u32,
}

#[derive(serde::Serialize, Clone)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

#[derive(serde::Serialize, Clone)]
struct RecordingCheckpoint {
    #[serde(rename = "meetingId")]
    meeting_id: String,
    #[serde(rename = "durationSeconds")]
    duration_seconds: u32,
    #[serde(rename = "audioPath")]
    audio_path: String,
    #[serde(rename = "freeDiskBytes")]
    free_disk_bytes: Option<u64>,
    #[serde(rename = "lowDisk")]
    low_disk: bool,
}

#[derive(serde::Serialize)]
struct RecordingRecovery {
    #[serde(rename = "meetingId")]
    meeting_id: String,
    #[serde(rename = "liveWavPath")]
    live_wav_path: String,
    #[serde(rename = "durationSeconds")]
    duration_seconds: u32,
    title: Option<String>,
}

/// Shared recording state held in Tauri's managed state.
#[derive(Default)]
struct AudioState {
    recording: Arc<AtomicBool>,
    /// Raw interleaved samples at the device's native rate (legacy fallback).
    samples: Arc<Mutex<Vec<f32>>>,
    /// (sample_rate, channels) captured when recording started.
    config: Arc<Mutex<Option<(u32, u16)>>>,
    system_active: Arc<AtomicBool>,
    /// Meeting id assigned when recording starts (audio saved under this id).
    recording_id: Arc<Mutex<Option<String>>>,
    recording_title: Arc<Mutex<Option<String>>>,
    /// Incremental WAV writer — audio hits disk during capture.
    live_wav: Arc<Mutex<Option<audio::StreamingWavWriter>>>,
    live_wav_path: Arc<Mutex<Option<PathBuf>>>,
    system_live_wav: Arc<Mutex<Option<audio::StreamingWavWriter>>>,
    system_live_wav_path: Arc<Mutex<Option<PathBuf>>>,
    recording_started_at: Arc<Mutex<Option<std::time::Instant>>>,
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

fn recovery_error(live_path: Option<&Path>, message: &str) -> String {
    if let Some(path) = live_path.filter(|p| p.exists()) {
        format!(
            "{message}. Your recording may be recoverable at {} — open Settings → Storage → Meeting audio, then use Library → Import audio.",
            path.display()
        )
    } else {
        message.to_string()
    }
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
fn get_privacy_settings(app: AppHandle) -> Result<privacy::PrivacySettings, String> {
    Ok(privacy::load_privacy(&app))
}

#[tauri::command]
fn set_privacy_settings(app: AppHandle, settings: privacy::PrivacySettings) -> Result<(), String> {
    privacy::save_privacy(&app, &settings)
}

#[tauri::command]
fn start_recording(
    app: AppHandle,
    state: State<AudioState>,
    capture_system_audio: Option<bool>,
    title_override: Option<String>,
) -> Result<(), String> {
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
    state.system_active.store(false, Ordering::SeqCst);
    *state.system_live_wav.lock().unwrap() = None;
    *state.system_live_wav_path.lock().unwrap() = None;

    let meeting_id = uuid::Uuid::new_v4().to_string();
    let audio_dir = audio::audio_dir(&app)?;
    let live_path = audio_dir.join(format!("{}.recording.wav", &meeting_id[..8]));
    let live_writer =
        audio::StreamingWavWriter::create(&live_path, sample_rate, channels)?;
    *state.recording_id.lock().unwrap() = Some(meeting_id.clone());
    *state.recording_title.lock().unwrap() = title_override.clone();
    *state.live_wav_path.lock().unwrap() = Some(live_path.clone());
    *state.live_wav.lock().unwrap() = Some(live_writer);
    *state.recording_started_at.lock().unwrap() = Some(std::time::Instant::now());

    let started_at = chrono::Local::now().to_rfc3339();
    let mut system_path: Option<PathBuf> = None;

    let want_system =
        capture_system_audio.unwrap_or_else(|| privacy::load_privacy(&app).capture_system_audio);
    if want_system {
        let sys_path = audio_dir.join(format!("{}.system.recording.wav", &meeting_id[..8]));
        if let Ok(sys_writer) =
            audio::StreamingWavWriter::create(&sys_path, sample_rate, 2)
        {
            *state.system_live_wav.lock().unwrap() = Some(sys_writer);
            *state.system_live_wav_path.lock().unwrap() = Some(sys_path.clone());
            system_path = Some(sys_path.clone());
            if audio::start_loopback_capture(
                state.recording.clone(),
                state.system_live_wav.clone(),
                sample_rate,
                2,
                app.clone(),
            )
            .is_ok()
            {
                state.system_active.store(true, Ordering::SeqCst);
            } else {
                *state.system_live_wav.lock().unwrap() = None;
                *state.system_live_wav_path.lock().unwrap() = None;
                system_path = None;
            }
        }
    }

    storage::save_active_recording(
        &app,
        &storage::ActiveRecording {
            meeting_id: meeting_id.clone(),
            started_at,
            live_wav_path: live_path.to_string_lossy().into_owned(),
            system_wav_path: system_path
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            title: title_override.clone(),
            last_checkpoint_at: None,
        },
    )?;

    // Periodic checkpoint thread — saves draft + emits progress for long sessions.
    let checkpoint_app = app.clone();
    let cp_recording = state.recording.clone();
    let cp_id = meeting_id.clone();
    let cp_live = live_path.clone();
    let cp_title = title_override.clone();
    let cp_sr = sample_rate;
    std::thread::spawn(move || {
        while cp_recording.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(CHECKPOINT_INTERVAL_SECS));
            if !cp_recording.load(Ordering::SeqCst) {
                break;
            }
            let duration = estimate_recording_duration(&cp_live, cp_sr);
            let free = audio::free_disk_bytes(&cp_live).ok();
            let low_disk = free.is_some_and(|b| b < audio::DISK_WARN_BYTES);
            let _ = storage::save_recording_checkpoint(
                &checkpoint_app,
                &cp_id,
                duration,
                &cp_live.to_string_lossy(),
                cp_title.as_deref(),
            );
            let _ = storage::save_active_recording(
                &checkpoint_app,
                &storage::ActiveRecording {
                    meeting_id: cp_id.clone(),
                    started_at: chrono::Local::now().to_rfc3339(),
                    live_wav_path: cp_live.to_string_lossy().into_owned(),
                    system_wav_path: None,
                    title: cp_title.clone(),
                    last_checkpoint_at: Some(chrono::Local::now().to_rfc3339()),
                },
            );
            let _ = checkpoint_app.emit(
                "recording-checkpoint",
                RecordingCheckpoint {
                    meeting_id: cp_id.clone(),
                    duration_seconds: duration,
                    audio_path: cp_live.to_string_lossy().into_owned(),
                    free_disk_bytes: free,
                    low_disk,
                },
            );
            let _ = cp_sr;
        }
    });

    state.recording.store(true, Ordering::SeqCst);

    let recording = state.recording.clone();
    let live_wav = state.live_wav.clone();
    let app_err = app.clone();
    let app_emit = app.clone();
    let (ready_tx, ready_rx) = mpsc::channel();

    // cpal::Stream is !Send on Windows, so it lives entirely on this thread.
    std::thread::spawn(move || {
        let err_fn = {
            let app = app_err.clone();
            move |e| {
                let _ = app.emit("recording-error", format!("{e}"));
            }
        };
        let rec = recording.clone();
        let wav = live_wav.clone();

        let write_samples = move |data: &[f32]| {
            if !rec.load(Ordering::Relaxed) {
                return;
            }
            if let Ok(mut guard) = wav.lock() {
                if let Some(w) = guard.as_mut() {
                    if let Err(e) = w.write_f32_interleaved(data) {
                        let _ = app_err.emit(
                            "recording-error",
                            format!("Failed to write audio to disk: {e}"),
                        );
                    }
                }
            }
        };

        let built = match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                move |d: &[f32], _: &cpal::InputCallbackInfo| write_samples(d),
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config,
                move |d: &[i16], _: &cpal::InputCallbackInfo| {
                    let mapped: Vec<f32> = d.iter().map(|s| *s as f32 / 32768.0).collect();
                    write_samples(&mapped);
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config,
                move |d: &[u16], _: &cpal::InputCallbackInfo| {
                    let mapped: Vec<f32> = d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0).collect();
                    write_samples(&mapped);
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::I32 => device.build_input_stream(
                &config,
                move |d: &[i32], _: &cpal::InputCallbackInfo| {
                    let mapped: Vec<f32> = d
                        .iter()
                        .map(|s| *s as f32 / 2_147_483_648.0)
                        .collect();
                    write_samples(&mapped);
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
    title_override: Option<String>,
    calendar_event_id: Option<String>,
    folder_id: Option<String>,
) -> Result<StopRecordingResult, String> {
    if !state.recording.load(Ordering::SeqCst) {
        return Err("Not recording".into());
    }
    state.recording.store(false, Ordering::SeqCst);
    // Let the capture thread observe the flag and drop the stream.
    std::thread::sleep(Duration::from_millis(250));

    let meeting_id = state
        .recording_id
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let live_path = state.live_wav_path.lock().unwrap().clone();
    let system_live_path = state.system_live_wav_path.lock().unwrap().clone();

    // Finalize incremental WAV writers so audio is on disk before processing.
    let _ = state
        .live_wav
        .lock()
        .unwrap()
        .take()
        .map(|w| w.finalize())
        .transpose()?;
    let _ = state
        .system_live_wav
        .lock()
        .unwrap()
        .take()
        .map(|w| w.finalize())
        .transpose()?;

    let mic_path = live_path.as_ref().filter(|p| p.exists()).ok_or_else(|| {
        recovery_error(
            live_path.as_deref(),
            "No audio captured — check microphone permissions",
        )
    })?;

    let privacy = privacy::load_privacy(&app);
    let audio_dir = audio::audio_dir(&app)?;
    let wav_path = audio_dir.join(format!("{}.wav", &meeting_id[..8]));
    let sys_ref = system_live_path
        .as_deref()
        .filter(|p| p.exists() && state.system_active.load(Ordering::SeqCst));

    let file_duration = tauri::async_runtime::spawn_blocking({
        let mic = mic_path.clone();
        let sys = sys_ref.map(Path::to_path_buf);
        let dest = wav_path.clone();
        move || audio::stream_resample_mix_to_16k(&mic, sys.as_deref(), &dest)
    })
    .await
    .map_err(|e| e.to_string())??;

    let duration_seconds = file_duration.max(duration_seconds);
    if duration_seconds == 0 {
        return Err(recovery_error(
            live_path.as_deref(),
            "No audio captured — check microphone permissions",
        ));
    }

    let audio_saved = Some(wav_path.to_string_lossy().into_owned());
    let _ = app.emit(
        "recording-saved",
        serde_json::json!({
            "meetingId": meeting_id,
            "audioPath": audio_saved,
            "durationSeconds": duration_seconds,
        }),
    );

    if let Some(ref path) = live_path {
        let _ = std::fs::remove_file(path);
    }
    if let Some(ref path) = system_live_path {
        let _ = std::fs::remove_file(path);
    }
    let _ = storage::clear_active_recording(&app);

    let model = model_path(&app)?;
    if !model.exists() {
        let (_path, meeting_id) = storage::save_note_file(
            &app,
            &[],
            user_notes.as_deref(),
            duration_seconds,
            storage::SaveNoteOptions {
                meeting_id: Some(meeting_id),
                title_override: title_override.as_deref(),
                audio_path: audio_saved.as_deref(),
                calendar_event_id: calendar_event_id.as_deref(),
                folder_id: folder_id.as_deref(),
                status: Some("transcription_failed"),
                transcription_error: Some("Model not downloaded yet"),
            },
        )?;
        return Ok(StopRecordingResult {
            segments: vec![],
            meeting_id,
            status: "transcription_failed".into(),
            transcription_error: Some("Model not downloaded yet".into()),
        });
    }

    let wav_for_transcribe = wav_path.clone();
    let app_progress = app.clone();
    let transcription_result = tauri::async_runtime::spawn_blocking(move || {
        transcribe_wav_file_chunked(&model, &wav_for_transcribe, Some(&app_progress))
    })
    .await;

    let (mut segs, status, transcription_error) = match transcription_result {
        Ok(Ok(segments)) => (segments, "complete", None),
        Ok(Err(e)) => (Vec::new(), "transcription_failed", Some(e)),
        Err(e) => (Vec::new(), "transcription_failed", Some(e.to_string())),
    };

    if !segs.is_empty() {
        audio::diarize_segments(&mut segs);
    }

    let persist_audio = if privacy.delete_audio_after_transcribe && status == "complete" {
        None
    } else {
        audio_saved.as_deref()
    };

    let (_path, meeting_id) = storage::save_note_file(
        &app,
        &segs,
        user_notes.as_deref(),
        duration_seconds,
        storage::SaveNoteOptions {
            meeting_id: Some(meeting_id),
            title_override: title_override.as_deref(),
            audio_path: persist_audio,
            calendar_event_id: calendar_event_id.as_deref(),
            folder_id: folder_id.as_deref(),
            status: Some(status),
            transcription_error: transcription_error.as_deref(),
        },
    )?;

    if privacy.delete_audio_after_transcribe && status == "complete" {
        if let Some(ref path) = audio_saved {
            let _ = std::fs::remove_file(path);
        }
    }

    if let Some(url) = privacy.webhook_url.filter(|u| !u.trim().is_empty()) {
        let payload = serde_json::json!({
            "event": "meeting_saved",
            "meetingId": meeting_id,
            "durationSeconds": duration_seconds,
            "segmentCount": segs.len(),
            "status": status,
        });
        privacy::fire_webhook(&url, &payload);
    }

    Ok(StopRecordingResult {
        segments: segs,
        meeting_id,
        status: status.into(),
        transcription_error,
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
  transcribe_chunked(model_path, audio, None)
}

/// Transcribe long audio in ~5-minute chunks to avoid OOM/timeouts.
pub fn transcribe_chunked(
    model_path: &Path,
    audio: &[f32],
    app: Option<&AppHandle>,
) -> Result<Vec<Segment>, String> {
    let chunk_samples = CHUNK_DURATION_SECS as usize * WHISPER_SAMPLE_RATE as usize;
    if audio.is_empty() {
        return Ok(Vec::new());
    }

    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("Failed to load model: {e}"))?;

    let total_chunks = audio.len().div_ceil(chunk_samples).max(1) as u32;
    let mut all = Vec::new();

    for (idx, chunk) in audio.chunks(chunk_samples).enumerate() {
        if let Some(handle) = app {
            let _ = handle.emit(
                "transcription-progress",
                TranscriptionProgress {
                    chunk: idx as u32 + 1,
                    total_chunks,
                    percent: ((idx + 1) * 100 / total_chunks as usize).min(100) as u32,
                },
            );
        }
        let offset_cs = (idx * chunk_samples) as i64 * 100 / WHISPER_SAMPLE_RATE as i64;
        let mut segs = transcribe_with_context(&ctx, chunk, offset_cs)?;
        all.append(&mut segs);
    }

    Ok(all)
}

/// Transcribe a 16 kHz mono WAV file chunk-by-chunk — bounded RAM for multi-hour sessions.
pub fn transcribe_wav_file_chunked(
    model_path: &Path,
    wav_path: &Path,
    app: Option<&AppHandle>,
) -> Result<Vec<Segment>, String> {
    let chunk_samples = CHUNK_DURATION_SECS as usize * WHISPER_SAMPLE_RATE as usize;
    let mut reader = audio::WavChunkReader::open(wav_path, chunk_samples)?;
    let total_chunks = reader.total_chunks();

    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("Failed to load model: {e}"))?;

    let mut all = Vec::new();
    let mut idx = 0u32;

    while let Some(chunk) = reader.next_chunk()? {
        if let Some(handle) = app {
            let _ = handle.emit(
                "transcription-progress",
                TranscriptionProgress {
                    chunk: idx + 1,
                    total_chunks,
                    percent: (((idx + 1) as usize) * 100 / total_chunks as usize).min(100) as u32,
                },
            );
        }
        let offset_cs = (idx as usize * chunk_samples) as i64 * 100 / WHISPER_SAMPLE_RATE as i64;
        let mut segs = transcribe_with_context(&ctx, &chunk, offset_cs)?;
        all.append(&mut segs);
        idx += 1;
    }

    Ok(all)
}

fn transcribe_with_context(
    ctx: &WhisperContext,
    audio: &[f32],
    offset_cs: i64,
) -> Result<Vec<Segment>, String> {
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
                time: fmt_centiseconds(seg.start_timestamp() + offset_cs),
                text,
                speaker: None,
            });
        }
    }
    Ok(out)
}

fn fmt_centiseconds(cs: i64) -> String {
    let secs = (cs / 100).max(0);
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

fn estimate_recording_duration(path: &Path, sample_rate: u32) -> u32 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    let data_bytes = meta.len().saturating_sub(44);
    (data_bytes / (sample_rate.max(1) as u64 * 2)).min(u32::MAX as u64) as u32
}

#[tauri::command]
fn get_recording_status(state: State<AudioState>) -> Result<Option<RecordingCheckpoint>, String> {
    if !state.recording.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let meeting_id = state
        .recording_id
        .lock()
        .unwrap()
        .clone()
        .ok_or("Recording active but no meeting id")?;
    let live_path = state
        .live_wav_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("Recording active but no audio path")?;
    let sample_rate = state
        .config
        .lock()
        .unwrap()
        .map(|(sr, _)| sr)
        .unwrap_or(WHISPER_SAMPLE_RATE);
    let duration = estimate_recording_duration(&live_path, sample_rate);
    let free = audio::free_disk_bytes(&live_path).ok();
    let low_disk = free.is_some_and(|b| b < audio::DISK_WARN_BYTES);
    Ok(Some(RecordingCheckpoint {
        meeting_id,
        duration_seconds: duration,
        audio_path: live_path.to_string_lossy().into_owned(),
        free_disk_bytes: free,
        low_disk,
    }))
}

#[tauri::command]
fn check_recording_recovery(app: AppHandle) -> Result<Option<RecordingRecovery>, String> {
    if let Some(active) = storage::load_active_recording(&app)? {
        let live = PathBuf::from(&active.live_wav_path);
        if live.exists() {
            let duration = audio::wav_duration_seconds(&live)
                .unwrap_or_else(|_| estimate_recording_duration(&live, WHISPER_SAMPLE_RATE));
            return Ok(Some(RecordingRecovery {
                meeting_id: active.meeting_id,
                live_wav_path: active.live_wav_path,
                duration_seconds: duration,
                title: active.title,
            }));
        }
        let _ = storage::clear_active_recording(&app);
    }
    let audio_dir = audio::audio_dir(&app)?;
    if !audio_dir.exists() {
        return Ok(None);
    }
    for entry in std::fs::read_dir(&audio_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(".recording.wav"))
        {
            let duration = audio::wav_duration_seconds(&path)
                .unwrap_or_else(|_| estimate_recording_duration(&path, WHISPER_SAMPLE_RATE));
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .trim_end_matches(".recording");
            return Ok(Some(RecordingRecovery {
                meeting_id: stem.to_string(),
                live_wav_path: path.to_string_lossy().into_owned(),
                duration_seconds: duration,
                title: None,
            }));
        }
    }
    Ok(None)
}

#[tauri::command]
async fn recover_partial_recording(
    app: AppHandle,
    live_wav_path: String,
    meeting_id: Option<String>,
    title_override: Option<String>,
) -> Result<StopRecordingResult, String> {
    let live_path = PathBuf::from(&live_wav_path);
    if !live_path.exists() {
        return Err("Recording file not found".into());
    }
    let meeting_id = meeting_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let audio_dir = audio::audio_dir(&app)?;
    let wav_path = audio_dir.join(format!("{}.wav", &meeting_id[..8.min(meeting_id.len())]));

    let duration_seconds = tauri::async_runtime::spawn_blocking({
        let live = live_path.clone();
        let dest = wav_path.clone();
        move || audio::stream_resample_mix_to_16k(&live, None, &dest)
    })
    .await
    .map_err(|e| e.to_string())??;

    let _ = std::fs::remove_file(&live_path);
    let _ = storage::clear_active_recording(&app);

    let audio_saved = Some(wav_path.to_string_lossy().into_owned());
    let model = model_path(&app)?;
    if !model.exists() {
        let (_path, id) = storage::save_note_file(
            &app,
            &[],
            None,
            duration_seconds,
            storage::SaveNoteOptions {
                meeting_id: Some(meeting_id.clone()),
                title_override: title_override.as_deref(),
                audio_path: audio_saved.as_deref(),
                calendar_event_id: None,
                folder_id: None,
                status: Some("transcription_failed"),
                transcription_error: Some("Model not downloaded yet"),
            },
        )?;
        return Ok(StopRecordingResult {
            segments: vec![],
            meeting_id: id,
            status: "transcription_failed".into(),
            transcription_error: Some("Model not downloaded yet".into()),
        });
    }

    let wav_for_transcribe = wav_path.clone();
    let app_progress = app.clone();
    let transcription_result = tauri::async_runtime::spawn_blocking(move || {
        transcribe_wav_file_chunked(&model, &wav_for_transcribe, Some(&app_progress))
    })
    .await;

    let (mut segs, status, transcription_error) = match transcription_result {
        Ok(Ok(segments)) => (segments, "complete", None),
        Ok(Err(e)) => (Vec::new(), "transcription_failed", Some(e)),
        Err(e) => (Vec::new(), "transcription_failed", Some(e.to_string())),
    };

    if !segs.is_empty() {
        audio::diarize_segments(&mut segs);
    }

    let (_path, meeting_id) = storage::save_note_file(
        &app,
        &segs,
        None,
        duration_seconds,
        storage::SaveNoteOptions {
            meeting_id: Some(meeting_id),
            title_override: title_override.as_deref(),
            audio_path: audio_saved.as_deref(),
            calendar_event_id: None,
            folder_id: None,
            status: Some(status),
            transcription_error: transcription_error.as_deref(),
        },
    )?;

    Ok(StopRecordingResult {
        segments: segs,
        meeting_id,
        status: status.into(),
        transcription_error,
    })
}

#[tauri::command]
async fn import_audio_file(
    app: AppHandle,
    path: String,
    title: Option<String>,
) -> Result<StopRecordingResult, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err("File not found".into());
    }
    let default_title = src
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string);
    let app2 = app.clone();
    let title2 = title.clone();
    let (pcm, sr) = tauri::async_runtime::spawn_blocking(move || audio::decode_audio_file(&src))
        .await
        .map_err(|e| e.to_string())??;
    let audio = audio::preprocess_audio(&audio::resample_to_16k_mono(&pcm, sr, 1));
    if audio.is_empty() {
        return Err("No audio decoded from file".into());
    }
    let duration_seconds = (audio.len() as u32).saturating_div(WHISPER_SAMPLE_RATE);
    let meeting_id = uuid::Uuid::new_v4().to_string();
    let audio_dir = audio::audio_dir(&app2)?;
    let wav_path = audio_dir.join(format!("{}.wav", &meeting_id[..8]));
    let audio_saved = audio::save_wav(&wav_path, &audio, WHISPER_SAMPLE_RATE)
        .ok()
        .map(|()| wav_path.to_string_lossy().into_owned());

    let model = model_path(&app2)?;
    let audio_for_transcribe = audio.clone();
    let app_progress = app2.clone();
    let transcription_result = if model.exists() {
        tauri::async_runtime::spawn_blocking(move || {
            transcribe_chunked(&model, &audio_for_transcribe, Some(&app_progress))
        })
        .await
    } else {
        return Ok(StopRecordingResult {
            segments: vec![],
            meeting_id: storage::save_note_file(
                &app2,
                &[],
                None,
                duration_seconds,
                storage::SaveNoteOptions {
                    meeting_id: Some(meeting_id),
                    title_override: title2.as_deref().or(default_title.as_deref()),
                    audio_path: audio_saved.as_deref(),
                    calendar_event_id: None,
                    folder_id: None,
                    status: Some("transcription_failed"),
                    transcription_error: Some("Model not downloaded yet"),
                },
            )?
            .1,
            status: "transcription_failed".into(),
            transcription_error: Some("Model not downloaded yet".into()),
        });
    };

    let (mut segs, status, transcription_error) = match transcription_result {
        Ok(Ok(segments)) => (segments, "complete", None),
        Ok(Err(e)) => (Vec::new(), "transcription_failed", Some(e)),
        Err(e) => (Vec::new(), "transcription_failed", Some(e.to_string())),
    };

    if !segs.is_empty() {
        audio::diarize_segments(&mut segs);
    }

    let privacy = privacy::load_privacy(&app2);
    let persist_audio = if privacy.delete_audio_after_transcribe && status == "complete" {
        None
    } else {
        audio_saved.as_deref()
    };

    let (_path, meeting_id) = storage::save_note_file(
        &app2,
        &segs,
        None,
        duration_seconds,
        storage::SaveNoteOptions {
            meeting_id: Some(meeting_id),
            title_override: title2.as_deref().or(default_title.as_deref()),
            audio_path: persist_audio,
            calendar_event_id: None,
            folder_id: None,
            status: Some(status),
            transcription_error: transcription_error.as_deref(),
        },
    )?;

    if privacy.delete_audio_after_transcribe && status == "complete" {
        if let Some(ref path) = audio_saved {
            let _ = std::fs::remove_file(path);
        }
    }

    Ok(StopRecordingResult {
        segments: segs,
        meeting_id,
        status: status.into(),
        transcription_error,
    })
}

#[tauri::command]
async fn retry_transcription(app: AppHandle, meeting_id: String) -> Result<StopRecordingResult, String> {
    let detail = storage::read_meeting(app.clone(), meeting_id.clone())?;
    let audio_path = detail
        .audio_path
        .ok_or("No audio file saved for this meeting")?;
    let src = PathBuf::from(&audio_path);
    if !src.exists() {
        return Err("Audio file missing on disk".into());
    }

    let model = model_path(&app)?;
    if !model.exists() {
        return Err("Model not downloaded yet".into());
    }

    let wav_path = src.clone();
    let app_progress = app.clone();
    let transcription_result = tauri::async_runtime::spawn_blocking(move || {
        transcribe_wav_file_chunked(&model, &wav_path, Some(&app_progress))
    })
    .await;

    let (mut segs, status, transcription_error) = match transcription_result {
        Ok(Ok(segments)) => (segments, "complete", None),
        Ok(Err(e)) => (Vec::new(), "transcription_failed", Some(e)),
        Err(e) => (Vec::new(), "transcription_failed", Some(e.to_string())),
    };

    if !segs.is_empty() {
        audio::diarize_segments(&mut segs);
    }

    storage::update_meeting_transcript(
        &app,
        &meeting_id,
        &segs,
        status,
        transcription_error.as_deref(),
    )?;

    Ok(StopRecordingResult {
        segments: segs,
        meeting_id,
        status: status.into(),
        transcription_error,
    })
}

#[tauri::command]
fn get_meeting_audio_path(app: AppHandle, id: String) -> Result<Option<String>, String> {
    storage::meeting_audio_path(&app, &id)
}

#[tauri::command]
fn pick_audio_file() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .add_filter("Audio", &["wav", "mp3", "m4a", "aac", "flac", "ogg"])
        .pick_file()
        .map(|p| p.to_string_lossy().into_owned()))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportClipArgs {
    meeting_id: String,
    start_seconds: f32,
    end_seconds: f32,
    dest_path: String,
}

#[tauri::command]
fn export_audio_clip(
    app: AppHandle,
    meeting_id: String,
    start_seconds: f32,
    end_seconds: f32,
    dest_path: String,
) -> Result<String, String> {
    let src = storage::meeting_audio_path(&app, &meeting_id)?
        .ok_or("No audio file for this meeting")?;
    audio::export_clip(Path::new(&src), start_seconds, end_seconds, Path::new(&dest_path))?;
    Ok(dest_path)
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
            get_recording_status,
            check_recording_recovery,
            recover_partial_recording,
            retry_transcription,
            import_audio_file,
            pick_audio_file,
            get_meeting_audio_path,
            export_audio_clip,
            get_privacy_settings,
            set_privacy_settings,
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
            storage::get_candor_root_path,
            storage::list_folder_tree,
            storage::create_folder,
            storage::rename_folder,
            storage::delete_folder,
            storage::move_folder,
            storage::move_meeting_to_folder,
            storage::save_meeting_edits,
            storage::open_candor_folder,
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
