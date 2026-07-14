use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::recording_store::{
    RecordingIdParams, RecordingStore, RecordingStoreError, StartRecordingParams,
    WriteAudioChunkParams,
};

#[cfg(target_os = "macos")]
#[path = "capture_service_macos.rs"]
mod macos;

const DEFAULT_CAPTURE_CHUNK_MS: u64 = 500;
const MIN_CAPTURE_CHUNK_MS: u64 = 100;
const MAX_CAPTURE_CHUNK_MS: u64 = 2_000;
const CAPTURE_READY_TIMEOUT: Duration = Duration::from_secs(5);
const CAPTURE_POLL_TIMEOUT: Duration = Duration::from_millis(50);
const CAPTURE_CALLBACK_QUEUE_CAPACITY: usize = 32;

#[derive(Debug)]
pub struct CaptureError {
    pub code: &'static str,
    pub message: String,
}

impl CaptureError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<RecordingStoreError> for CaptureError {
    fn from(error: RecordingStoreError) -> Self {
        Self::new(error.code, error.message)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStartParams {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub chunk_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStartMicAndSystemParams {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub mic_device_id: Option<String>,
    #[serde(default)]
    pub system_device_id: Option<String>,
    #[serde(default)]
    pub chunk_ms: Option<u64>,
}

#[derive(Clone, Debug)]
struct CaptureRuntimeInfo {
    source: &'static str,
    device_label: String,
    sample_rate_hz: u32,
    channel_count: u16,
    chunk_ms: u64,
}

struct CaptureSession {
    recording_id: String,
    stop: Arc<AtomicBool>,
    joins: Vec<thread::JoinHandle<()>>,
    writer_join: Option<thread::JoinHandle<()>>,
    runtimes: Vec<CaptureRuntimeInfo>,
    last_error: Arc<Mutex<Option<String>>>,
    started_at_ms: u128,
}

#[derive(Default)]
pub struct CaptureManager {
    active: Option<CaptureSession>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureSource {
    Mic,
    System,
}

impl CaptureSource {
    fn label(self) -> &'static str {
        match self {
            CaptureSource::Mic => "mic",
            CaptureSource::System => "system",
        }
    }
}

struct CapturedAudioChunk {
    source: CaptureSource,
    sample_rate_hz: u32,
    channel_count: u16,
    start_ms: u64,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CaptureCallbackFailure {
    code: &'static str,
    message: String,
}

enum CaptureSink {
    Direct {
        store: RecordingStore,
        recording_id: String,
    },
    Queue {
        tx: mpsc::SyncSender<CapturedAudioChunk>,
    },
}

impl CaptureSink {
    fn write(
        &self,
        source: CaptureSource,
        sample_rate_hz: u32,
        channel_count: u16,
        start_ms: u64,
        bytes: Vec<u8>,
    ) -> Result<(), CaptureError> {
        match self {
            CaptureSink::Direct {
                store,
                recording_id,
            } => write_pcm_chunk(
                store,
                recording_id,
                source.label(),
                sample_rate_hz,
                channel_count,
                start_ms,
                bytes,
            ),
            CaptureSink::Queue { tx } => tx
                .send(CapturedAudioChunk {
                    source,
                    sample_rate_hz,
                    channel_count,
                    start_ms,
                    bytes,
                })
                .map_err(|_| {
                    CaptureError::new(
                        "CAPTURE_WRITER_CLOSED",
                        "capture writer closed before the audio chunk was persisted",
                    )
                }),
        }
    }
}

impl CaptureManager {
    pub fn is_active(&self) -> bool {
        self.active.is_some()
    }

    pub fn status(&mut self) -> Value {
        let active = self.active.as_ref().map(|session| {
            let runtimes = session_runtimes_json(&session.runtimes);
            let primary = session.runtimes.first();
            let source = if session.runtimes.len() > 1 {
                "mic+system"
            } else {
                primary.map(|runtime| runtime.source).unwrap_or("unknown")
            };
            let device_label = if session.runtimes.len() > 1 {
                session
                    .runtimes
                    .iter()
                    .map(|runtime| format!("{}: {}", runtime.source, runtime.device_label))
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                primary
                    .map(|runtime| runtime.device_label.clone())
                    .unwrap_or_else(|| "Unknown capture device".to_string())
            };
            let last_error = session
                .last_error
                .lock()
                .ok()
                .and_then(|error| error.clone());
            let integrity_status = if last_error.is_some() {
                "failed"
            } else {
                "recording"
            };
            json!({
                "recordingId": session.recording_id,
                "source": source,
                "mode": if session.runtimes.len() > 1 { "separated" } else { "single-source" },
                "deviceLabel": device_label,
                "sampleRateHz": primary.map(|runtime| runtime.sample_rate_hz),
                "channelCount": primary.map(|runtime| runtime.channel_count),
                "chunkMs": primary.map(|runtime| runtime.chunk_ms),
                "tracks": session.runtimes.iter().map(|runtime| runtime.source).collect::<Vec<_>>(),
                "sources": runtimes,
                "startedAtMs": session.started_at_ms,
                "lastError": last_error,
                "integrityStatus": integrity_status,
                "rawPathExposed": false
            })
        });
        json!({
            "implemented": true,
            "active": self.active.is_some(),
            "defaultInputAvailable": default_input_available(),
            "defaultOutputAvailable": default_output_available(),
            "sources": capture_sources(),
            "integrityPolicy": capture_integrity_policy(),
            "activeSession": active,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    pub fn devices(&self) -> Value {
        json!({
            "defaultInputAvailable": default_input_available(),
            "defaultOutputAvailable": default_output_available(),
            "inputs": input_devices(),
            "outputs": output_devices(),
            "devices": input_devices(),
            "rawPathExposed": false
        })
    }

    pub fn start_mic(
        &mut self,
        store: RecordingStore,
        params: CaptureStartParams,
    ) -> Result<Value, CaptureError> {
        if self.active.is_some() {
            return Err(CaptureError::new(
                "CAPTURE_ALREADY_ACTIVE",
                "a capture session is already active",
            ));
        }

        let chunk_ms = params
            .chunk_ms
            .unwrap_or(DEFAULT_CAPTURE_CHUNK_MS)
            .clamp(MIN_CAPTURE_CHUNK_MS, MAX_CAPTURE_CHUNK_MS);
        let started = store.start(StartRecordingParams {
            label: params.label.clone(),
        })?;
        let recording_id = started["recordingId"]
            .as_str()
            .ok_or_else(|| {
                CaptureError::new(
                    "CAPTURE_RECORDING_ID_MISSING",
                    "recording start did not return an id",
                )
            })?
            .to_string();

        let stop = Arc::new(AtomicBool::new(false));
        let last_error = Arc::new(Mutex::new(None::<String>));
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread_stop = stop.clone();
        let thread_error = last_error.clone();
        let thread_device_id = params.device_id.clone();
        let thread_sink = CaptureSink::Direct {
            store: store.clone(),
            recording_id: recording_id.clone(),
        };

        let join = thread::spawn(move || {
            let capture_stop = thread_stop.clone();
            let result = run_capture(
                thread_sink,
                thread_device_id,
                CaptureSource::Mic,
                chunk_ms,
                capture_stop,
                ready_tx,
            );
            if let Err(error) = result {
                thread_stop.store(true, Ordering::SeqCst);
                set_last_capture_error(&thread_error, error.message);
            }
        });

        let runtime = match ready_rx.recv_timeout(CAPTURE_READY_TIMEOUT) {
            Ok(Ok(runtime)) => runtime,
            Ok(Err(error)) => {
                stop.store(true, Ordering::SeqCst);
                let _ = join.join();
                let _ = store.finish(RecordingIdParams {
                    recording_id: recording_id.clone(),
                });
                return Err(error);
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                let _ = join.join();
                let _ = store.finish(RecordingIdParams {
                    recording_id: recording_id.clone(),
                });
                return Err(CaptureError::new(
                    "CAPTURE_START_TIMEOUT",
                    "microphone capture did not become ready in time",
                ));
            }
        };

        self.active = Some(CaptureSession {
            recording_id: recording_id.clone(),
            stop,
            joins: vec![join],
            writer_join: None,
            runtimes: vec![runtime.clone()],
            last_error,
            started_at_ms: now_ms(),
        });

        Ok(json!({
            "recording": started,
            "capture": {
                "recordingId": recording_id,
                "source": runtime.source,
                "deviceLabel": runtime.device_label,
                "sampleRateHz": runtime.sample_rate_hz,
                "channelCount": runtime.channel_count,
                "chunkMs": runtime.chunk_ms,
                "rawPathExposed": false
            },
            "rawPathExposed": false
        }))
    }

    pub fn start_system(
        &mut self,
        store: RecordingStore,
        params: CaptureStartParams,
    ) -> Result<Value, CaptureError> {
        if !system_audio_available_on_this_platform() {
            return Err(CaptureError::new(
                "CAPTURE_SYSTEM_AUDIO_UNSUPPORTED",
                system_audio_unsupported_message(),
            ));
        }
        if self.active.is_some() {
            return Err(CaptureError::new(
                "CAPTURE_ALREADY_ACTIVE",
                "a capture session is already active",
            ));
        }

        let chunk_ms = params
            .chunk_ms
            .unwrap_or(DEFAULT_CAPTURE_CHUNK_MS)
            .clamp(MIN_CAPTURE_CHUNK_MS, MAX_CAPTURE_CHUNK_MS);
        let started = store.start(StartRecordingParams {
            label: params.label.clone(),
        })?;
        let recording_id = started["recordingId"]
            .as_str()
            .ok_or_else(|| {
                CaptureError::new(
                    "CAPTURE_RECORDING_ID_MISSING",
                    "recording start did not return an id",
                )
            })?
            .to_string();

        let stop = Arc::new(AtomicBool::new(false));
        let last_error = Arc::new(Mutex::new(None::<String>));
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread_stop = stop.clone();
        let thread_error = last_error.clone();
        let thread_device_id = params.device_id.clone();
        let thread_sink = CaptureSink::Direct {
            store: store.clone(),
            recording_id: recording_id.clone(),
        };

        let join = thread::spawn(move || {
            let capture_stop = thread_stop.clone();
            let result = run_capture(
                thread_sink,
                thread_device_id,
                CaptureSource::System,
                chunk_ms,
                capture_stop,
                ready_tx,
            );
            if let Err(error) = result {
                thread_stop.store(true, Ordering::SeqCst);
                set_last_capture_error(&thread_error, error.message);
            }
        });

        let runtime = match ready_rx.recv_timeout(CAPTURE_READY_TIMEOUT) {
            Ok(Ok(runtime)) => runtime,
            Ok(Err(error)) => {
                stop.store(true, Ordering::SeqCst);
                let _ = join.join();
                let _ = store.finish(RecordingIdParams {
                    recording_id: recording_id.clone(),
                });
                return Err(error);
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                let _ = join.join();
                let _ = store.finish(RecordingIdParams {
                    recording_id: recording_id.clone(),
                });
                return Err(CaptureError::new(
                    "CAPTURE_START_TIMEOUT",
                    "system audio capture did not become ready in time",
                ));
            }
        };

        self.active = Some(CaptureSession {
            recording_id: recording_id.clone(),
            stop,
            joins: vec![join],
            writer_join: None,
            runtimes: vec![runtime.clone()],
            last_error,
            started_at_ms: now_ms(),
        });

        Ok(json!({
            "recording": started,
            "capture": {
                "recordingId": recording_id,
                "source": runtime.source,
                "deviceLabel": runtime.device_label,
                "sampleRateHz": runtime.sample_rate_hz,
                "channelCount": runtime.channel_count,
                "chunkMs": runtime.chunk_ms,
                "adapter": system_audio_backend(),
                "rawPathExposed": false
            },
            "rawPathExposed": false
        }))
    }

    pub fn start_mic_and_system(
        &mut self,
        store: RecordingStore,
        params: CaptureStartMicAndSystemParams,
    ) -> Result<Value, CaptureError> {
        if !system_audio_available_on_this_platform() {
            return Err(CaptureError::new(
                "CAPTURE_SYSTEM_AUDIO_UNSUPPORTED",
                system_audio_unsupported_message(),
            ));
        }
        if self.active.is_some() {
            return Err(CaptureError::new(
                "CAPTURE_ALREADY_ACTIVE",
                "a capture session is already active",
            ));
        }

        let chunk_ms = params
            .chunk_ms
            .unwrap_or(DEFAULT_CAPTURE_CHUNK_MS)
            .clamp(MIN_CAPTURE_CHUNK_MS, MAX_CAPTURE_CHUNK_MS);
        let started = store.start(StartRecordingParams {
            label: params.label.clone(),
        })?;
        let recording_id = started["recordingId"]
            .as_str()
            .ok_or_else(|| {
                CaptureError::new(
                    "CAPTURE_RECORDING_ID_MISSING",
                    "recording start did not return an id",
                )
            })?
            .to_string();

        let stop = Arc::new(AtomicBool::new(false));
        let last_error = Arc::new(Mutex::new(None::<String>));
        let (ready_tx, ready_rx) = mpsc::channel();
        let (audio_tx, audio_rx) = mpsc::sync_channel::<CapturedAudioChunk>(64);

        let writer_store = store.clone();
        let writer_recording_id = recording_id.clone();
        let writer_error = last_error.clone();
        let mut writer_join = Some(thread::spawn(move || {
            run_serialized_writer(writer_store, writer_recording_id, audio_rx, writer_error);
        }));

        let mut joins = Vec::new();
        for (source, device_id) in [
            (CaptureSource::Mic, params.mic_device_id.clone()),
            (CaptureSource::System, params.system_device_id.clone()),
        ] {
            let thread_stop = stop.clone();
            let thread_error = last_error.clone();
            let thread_ready = ready_tx.clone();
            let thread_audio = audio_tx.clone();
            joins.push(thread::spawn(move || {
                let capture_stop = thread_stop.clone();
                let result = run_capture(
                    CaptureSink::Queue { tx: thread_audio },
                    device_id,
                    source,
                    chunk_ms,
                    capture_stop,
                    thread_ready,
                );
                if let Err(error) = result {
                    thread_stop.store(true, Ordering::SeqCst);
                    set_last_capture_error(&thread_error, error.message);
                }
            }));
        }
        drop(ready_tx);
        drop(audio_tx);

        let mut runtimes = Vec::new();
        for _ in 0..2 {
            match ready_rx.recv_timeout(CAPTURE_READY_TIMEOUT) {
                Ok(Ok(runtime)) => runtimes.push(runtime),
                Ok(Err(error)) => {
                    abort_capture_start(&stop, &mut joins, &mut writer_join, &store, &recording_id);
                    return Err(error);
                }
                Err(_) => {
                    abort_capture_start(&stop, &mut joins, &mut writer_join, &store, &recording_id);
                    return Err(CaptureError::new(
                        "CAPTURE_START_TIMEOUT",
                        "combined mic and system capture did not become ready in time",
                    ));
                }
            }
        }
        runtimes.sort_by_key(|runtime| match runtime.source {
            "mic" => 0,
            "system" => 1,
            _ => 2,
        });

        self.active = Some(CaptureSession {
            recording_id: recording_id.clone(),
            stop,
            joins,
            writer_join,
            runtimes: runtimes.clone(),
            last_error,
            started_at_ms: now_ms(),
        });

        Ok(json!({
            "recording": started,
            "capture": {
                "recordingId": recording_id,
                "source": "mic+system",
                "mode": "separated",
                "tracks": runtimes.iter().map(|runtime| runtime.source).collect::<Vec<_>>(),
                "sources": session_runtimes_json(&runtimes),
                "adapter": combined_capture_backend(),
                "serializedWriter": true,
                "rawPathExposed": false
            },
            "rawPathExposed": false
        }))
    }

    pub fn stop(&mut self, store: &RecordingStore) -> Result<Value, CaptureError> {
        let Some(mut session) = self.active.take() else {
            return Err(CaptureError::new(
                "CAPTURE_NOT_ACTIVE",
                "there is no active capture session",
            ));
        };
        session.stop.store(true, Ordering::SeqCst);
        for join in session.joins.drain(..) {
            join.join().map_err(|_| {
                CaptureError::new("CAPTURE_THREAD_FAILED", "capture thread panicked")
            })?;
        }
        if let Some(join) = session.writer_join.take() {
            join.join().map_err(|_| {
                CaptureError::new("CAPTURE_WRITER_FAILED", "capture writer thread panicked")
            })?;
        }
        let last_error = session
            .last_error
            .lock()
            .ok()
            .and_then(|error| error.clone());
        let finished = if last_error.is_some() {
            store.mark_needs_recovery(RecordingIdParams {
                recording_id: session.recording_id.clone(),
            })?
        } else {
            store.finish(RecordingIdParams {
                recording_id: session.recording_id.clone(),
            })?
        };
        let integrity_status = if last_error.is_some() {
            "failed"
        } else {
            "verified"
        };
        let primary = session.runtimes.first();
        Ok(json!({
            "recording": finished,
            "capture": {
                "recordingId": session.recording_id,
                "source": if session.runtimes.len() > 1 { "mic+system" } else { primary.map(|runtime| runtime.source).unwrap_or("unknown") },
                "mode": if session.runtimes.len() > 1 { "separated" } else { "single-source" },
                "deviceLabel": if session.runtimes.len() > 1 {
                    session.runtimes.iter().map(|runtime| format!("{}: {}", runtime.source, runtime.device_label)).collect::<Vec<_>>().join(", ")
                } else {
                    primary.map(|runtime| runtime.device_label.clone()).unwrap_or_else(|| "Unknown capture device".to_string())
                },
                "sampleRateHz": primary.map(|runtime| runtime.sample_rate_hz),
                "channelCount": primary.map(|runtime| runtime.channel_count),
                "chunkMs": primary.map(|runtime| runtime.chunk_ms),
                "tracks": session.runtimes.iter().map(|runtime| runtime.source).collect::<Vec<_>>(),
                "sources": session_runtimes_json(&session.runtimes),
                "lastError": last_error,
                "integrityStatus": integrity_status,
                "rawPathExposed": false
            },
            "rawPathExposed": false
        }))
    }

    pub fn proof_synthetic(&self, store: &RecordingStore) -> Result<Value, CaptureError> {
        let started = store.start(StartRecordingParams {
            label: Some("capture synthetic proof".to_string()),
        })?;
        let recording_id = started["recordingId"]
            .as_str()
            .ok_or_else(|| {
                CaptureError::new(
                    "CAPTURE_RECORDING_ID_MISSING",
                    "recording start did not return an id",
                )
            })?
            .to_string();

        let mic = vec![0_u8; 9_600];
        let system = vec![1_u8; 9_600];
        write_pcm_chunk(store, &recording_id, "mic", 48_000, 1, 0, mic)?;
        write_pcm_chunk(store, &recording_id, "system", 48_000, 1, 100, system)?;
        let finished = store.finish(RecordingIdParams {
            recording_id: recording_id.clone(),
        })?;
        let replay = store.replay_manifest(RecordingIdParams {
            recording_id: recording_id.clone(),
        })?;

        Ok(json!({
            "recording": finished,
            "replay": replay,
            "proof": {
                "synthetic": true,
                "micSystemSeparated": true,
                "durableAudioChunks": true,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            },
            "rawPathExposed": false
        }))
    }

    pub fn proof_serialized_writer(&self, store: &RecordingStore) -> Result<Value, CaptureError> {
        let started = store.start(StartRecordingParams {
            label: Some("capture serialized writer proof".to_string()),
        })?;
        let recording_id = started["recordingId"]
            .as_str()
            .ok_or_else(|| {
                CaptureError::new(
                    "CAPTURE_RECORDING_ID_MISSING",
                    "recording start did not return an id",
                )
            })?
            .to_string();

        if let Err(error) = write_synthetic_serialized_chunks(store, &recording_id, 6) {
            let _ = store.finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            });
            return Err(error);
        }

        let finished = store.finish(RecordingIdParams {
            recording_id: recording_id.clone(),
        })?;
        let replay = store.replay_manifest(RecordingIdParams {
            recording_id: recording_id.clone(),
        })?;

        Ok(json!({
            "recording": finished,
            "replay": replay,
            "proof": {
                "synthetic": true,
                "serializedWriter": true,
                "concurrentProducers": 2,
                "chunksPerProducer": 6,
                "micSystemSeparated": true,
                "durableAudioChunks": true,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            },
            "rawPathExposed": false
        }))
    }

    pub fn proof_interrupted_serialized_writer(
        &self,
        store: &RecordingStore,
    ) -> Result<Value, CaptureError> {
        let started = store.start(StartRecordingParams {
            label: Some("capture interrupted serialized writer proof".to_string()),
        })?;
        let recording_id = started["recordingId"]
            .as_str()
            .ok_or_else(|| {
                CaptureError::new(
                    "CAPTURE_RECORDING_ID_MISSING",
                    "recording start did not return an id",
                )
            })?
            .to_string();

        if let Err(error) = write_synthetic_serialized_chunks(store, &recording_id, 4) {
            let _ = store.finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            });
            return Err(error);
        }

        let replay = store.replay_manifest(RecordingIdParams {
            recording_id: recording_id.clone(),
        })?;

        Ok(json!({
            "recordingId": recording_id,
            "recording": started,
            "replay": replay,
            "proof": {
                "synthetic": true,
                "interrupted": true,
                "leftOpenForStartupRecovery": true,
                "serializedWriter": true,
                "concurrentProducers": 2,
                "chunksPerProducer": 4,
                "micSystemSeparated": true,
                "durableAudioChunks": true,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            },
            "rawPathExposed": false
        }))
    }
}

fn write_synthetic_serialized_chunks(
    store: &RecordingStore,
    recording_id: &str,
    chunks_per_producer: u64,
) -> Result<(), CaptureError> {
    let last_error = Arc::new(Mutex::new(None::<String>));
    let (audio_tx, audio_rx) = mpsc::sync_channel::<CapturedAudioChunk>(4);
    let writer_store = store.clone();
    let writer_recording_id = recording_id.to_string();
    let writer_error = last_error.clone();
    let writer_join = thread::spawn(move || {
        run_serialized_writer(writer_store, writer_recording_id, audio_rx, writer_error);
    });

    let mut producers = Vec::new();
    for source in [CaptureSource::Mic, CaptureSource::System] {
        let tx = audio_tx.clone();
        producers.push(thread::spawn(move || -> Result<(), CaptureError> {
            for index in 0..chunks_per_producer {
                tx.send(CapturedAudioChunk {
                    source,
                    sample_rate_hz: 48_000,
                    channel_count: 1,
                    start_ms: index.saturating_mul(100),
                    bytes: vec![if source == CaptureSource::Mic { 0 } else { 1 }; 9_600],
                })
                .map_err(|_| {
                    CaptureError::new(
                        "CAPTURE_WRITER_CLOSED",
                        "serialized writer closed during synthetic proof",
                    )
                })?;
            }
            Ok(())
        }));
    }
    drop(audio_tx);

    let mut producer_error = None;
    for producer in producers {
        match producer.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                if producer_error.is_none() {
                    producer_error = Some(error);
                }
            }
            Err(_) => {
                if producer_error.is_none() {
                    producer_error = Some(CaptureError::new(
                        "CAPTURE_PRODUCER_FAILED",
                        "synthetic capture producer thread panicked",
                    ));
                }
            }
        }
    }

    writer_join.join().map_err(|_| {
        CaptureError::new(
            "CAPTURE_WRITER_FAILED",
            "serialized writer proof thread panicked",
        )
    })?;

    if let Some(error) = producer_error {
        return Err(error);
    }

    if let Some(message) = last_error.lock().ok().and_then(|error| error.clone()) {
        return Err(CaptureError::new(
            "CAPTURE_SERIALIZED_WRITER_FAILED",
            message,
        ));
    }

    Ok(())
}

fn run_serialized_writer(
    store: RecordingStore,
    recording_id: String,
    audio_rx: mpsc::Receiver<CapturedAudioChunk>,
    last_error: Arc<Mutex<Option<String>>>,
) {
    while let Ok(chunk) = audio_rx.recv() {
        if let Err(error) = write_pcm_chunk(
            &store,
            &recording_id,
            chunk.source.label(),
            chunk.sample_rate_hz,
            chunk.channel_count,
            chunk.start_ms,
            chunk.bytes,
        ) {
            set_last_capture_error(&last_error, error.message);
            break;
        }
    }
}

fn session_runtimes_json(runtimes: &[CaptureRuntimeInfo]) -> Vec<Value> {
    runtimes
        .iter()
        .map(|runtime| {
            json!({
                "source": runtime.source,
                "deviceLabel": runtime.device_label,
                "sampleRateHz": runtime.sample_rate_hz,
                "channelCount": runtime.channel_count,
                "chunkMs": runtime.chunk_ms,
                "rawPathExposed": false
            })
        })
        .collect()
}

fn set_last_capture_error(last_error: &Arc<Mutex<Option<String>>>, message: String) {
    if let Ok(mut last_error) = last_error.lock() {
        if last_error.is_none() {
            *last_error = Some(message);
        }
    }
}

fn abort_capture_start(
    stop: &Arc<AtomicBool>,
    joins: &mut Vec<thread::JoinHandle<()>>,
    writer_join: &mut Option<thread::JoinHandle<()>>,
    store: &RecordingStore,
    recording_id: &str,
) {
    stop.store(true, Ordering::SeqCst);
    for join in joins.drain(..) {
        let _ = join.join();
    }
    if let Some(join) = writer_join.take() {
        let _ = join.join();
    }
    let _ = store.finish(RecordingIdParams {
        recording_id: recording_id.to_string(),
    });
}

fn run_capture(
    sink: CaptureSink,
    device_id: Option<String>,
    source: CaptureSource,
    chunk_ms: u64,
    stop: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<CaptureRuntimeInfo, CaptureError>>,
) -> Result<(), CaptureError> {
    match source {
        CaptureSource::Mic => run_cpal_capture(sink, device_id, source, chunk_ms, stop, ready_tx),
        CaptureSource::System => run_system_capture(sink, device_id, chunk_ms, stop, ready_tx),
    }
}

#[cfg(target_os = "macos")]
fn run_system_capture(
    sink: CaptureSink,
    device_id: Option<String>,
    chunk_ms: u64,
    stop: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<CaptureRuntimeInfo, CaptureError>>,
) -> Result<(), CaptureError> {
    macos::run_system_capture(sink, device_id, chunk_ms, stop, ready_tx)
}

#[cfg(not(target_os = "macos"))]
fn run_system_capture(
    sink: CaptureSink,
    device_id: Option<String>,
    chunk_ms: u64,
    stop: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<CaptureRuntimeInfo, CaptureError>>,
) -> Result<(), CaptureError> {
    run_cpal_capture(
        sink,
        device_id,
        CaptureSource::System,
        chunk_ms,
        stop,
        ready_tx,
    )
}

fn run_cpal_capture(
    sink: CaptureSink,
    device_id: Option<String>,
    source: CaptureSource,
    chunk_ms: u64,
    stop: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<CaptureRuntimeInfo, CaptureError>>,
) -> Result<(), CaptureError> {
    let host = cpal::default_host();
    let device = match source {
        CaptureSource::Mic => select_input_device(&host, device_id.as_deref()),
        CaptureSource::System => select_system_device(&host, device_id.as_deref()),
    }
    .map_err(|error| announce_capture_start_error(&ready_tx, error))?;
    let device_label = device.name().unwrap_or_else(|_| match source {
        CaptureSource::Mic => "Microphone".to_string(),
        CaptureSource::System => "System audio".to_string(),
    });
    let supported = match source {
        CaptureSource::Mic => device.default_input_config().map_err(|error| {
            CaptureError::new("CAPTURE_INPUT_CONFIG_UNAVAILABLE", error.to_string())
        }),
        CaptureSource::System => system_device_config(&device),
    }
    .map_err(|error| announce_capture_start_error(&ready_tx, error))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let sample_rate_hz = config.sample_rate.0;
    let channel_count = config.channels;
    let frame_bytes = usize::from(channel_count).saturating_mul(2).max(2);
    let target_bytes = ((u64::from(sample_rate_hz)
        .saturating_mul(u64::from(channel_count))
        .saturating_mul(2)
        .saturating_mul(chunk_ms))
        / 1000)
        .max(frame_bytes as u64) as usize;
    let target_bytes = target_bytes - (target_bytes % frame_bytes);
    let (audio_tx, audio_rx) = mpsc::sync_channel::<Vec<u8>>(CAPTURE_CALLBACK_QUEUE_CAPACITY);
    let callback_failure = Arc::new(Mutex::new(None::<CaptureCallbackFailure>));
    let error_for_callback = callback_failure.clone();
    let err_fn = move |error: cpal::StreamError| {
        record_capture_callback_failure(
            &error_for_callback,
            "CAPTURE_STREAM_ERROR",
            error.to_string(),
        );
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let data_failure = callback_failure.clone();
            device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    send_capture_callback_audio(
                        &audio_tx,
                        &data_failure,
                        samples_f32_to_pcm16(data),
                    );
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let data_failure = callback_failure.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    send_capture_callback_audio(
                        &audio_tx,
                        &data_failure,
                        samples_i16_to_pcm16(data),
                    );
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let data_failure = callback_failure.clone();
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    send_capture_callback_audio(
                        &audio_tx,
                        &data_failure,
                        samples_u16_to_pcm16(data),
                    );
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I32 => {
            let data_failure = callback_failure.clone();
            device.build_input_stream(
                &config,
                move |data: &[i32], _| {
                    send_capture_callback_audio(
                        &audio_tx,
                        &data_failure,
                        samples_i32_to_pcm16(data),
                    );
                },
                err_fn,
                None,
            )
        }
        other => {
            let error = CaptureError::new(
                "CAPTURE_SAMPLE_FORMAT_UNSUPPORTED",
                format!("unsupported input sample format: {other:?}"),
            );
            return Err(announce_capture_start_error(&ready_tx, error));
        }
    }
    .map_err(|error| {
        announce_capture_start_error(
            &ready_tx,
            CaptureError::new("CAPTURE_STREAM_CREATE_FAILED", error.to_string()),
        )
    })?;

    stream.play().map_err(|error| {
        announce_capture_start_error(
            &ready_tx,
            CaptureError::new("CAPTURE_STREAM_PLAY_FAILED", error.to_string()),
        )
    })?;
    ready_tx
        .send(Ok(CaptureRuntimeInfo {
            source: source.label(),
            device_label,
            sample_rate_hz,
            channel_count,
            chunk_ms,
        }))
        .ok();

    let mut pending = Vec::<u8>::new();
    let mut frames_written = 0_u64;
    let mut capture_error = None;
    while !stop.load(Ordering::SeqCst) {
        if let Some(error) = take_capture_callback_failure(&callback_failure) {
            capture_error = Some(error);
            break;
        }
        match audio_rx.recv_timeout(CAPTURE_POLL_TIMEOUT) {
            Ok(bytes) => pending.extend_from_slice(&bytes),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                capture_error = Some(CaptureError::new(
                    "CAPTURE_STREAM_CLOSED",
                    "capture callback stopped before the session was closed",
                ));
                break;
            }
        }
        if let Some(error) = take_capture_callback_failure(&callback_failure) {
            capture_error = Some(error);
            break;
        }
        if let Err(error) = flush_pending_audio(
            &sink,
            source,
            sample_rate_hz,
            channel_count,
            frame_bytes,
            target_bytes,
            &mut frames_written,
            &mut pending,
        ) {
            capture_error = Some(error);
            break;
        }
    }

    drop(stream);
    while let Ok(bytes) = audio_rx.try_recv() {
        pending.extend_from_slice(&bytes);
    }
    let callback_error = take_capture_callback_failure(&callback_failure);
    let flush_error = flush_all_audio(
        &sink,
        source,
        sample_rate_hz,
        channel_count,
        frame_bytes,
        &mut frames_written,
        &mut pending,
    )
    .err();
    if let Some(error) = capture_error.or(callback_error).or(flush_error) {
        return Err(error);
    }
    Ok(())
}

fn announce_capture_start_error(
    ready_tx: &mpsc::Sender<Result<CaptureRuntimeInfo, CaptureError>>,
    error: CaptureError,
) -> CaptureError {
    let _ = ready_tx.send(Err(CaptureError::new(error.code, error.message.clone())));
    error
}

fn record_capture_callback_failure(
    failure: &Arc<Mutex<Option<CaptureCallbackFailure>>>,
    code: &'static str,
    message: impl Into<String>,
) {
    if let Ok(mut failure) = failure.lock() {
        if failure.is_none() {
            *failure = Some(CaptureCallbackFailure {
                code,
                message: message.into(),
            });
        }
    }
}

fn take_capture_callback_failure(
    failure: &Arc<Mutex<Option<CaptureCallbackFailure>>>,
) -> Option<CaptureError> {
    failure
        .lock()
        .ok()
        .and_then(|mut failure| failure.take())
        .map(|failure| CaptureError::new(failure.code, failure.message))
}

fn send_capture_callback_audio(
    audio_tx: &mpsc::SyncSender<Vec<u8>>,
    failure: &Arc<Mutex<Option<CaptureCallbackFailure>>>,
    bytes: Vec<u8>,
) {
    match audio_tx.try_send(bytes) {
        Ok(()) => {}
        Err(mpsc::TrySendError::Full(_)) => record_capture_callback_failure(
            failure,
            "CAPTURE_CALLBACK_OVERFLOW",
            "capture callback queue overflowed before a durable write",
        ),
        Err(mpsc::TrySendError::Disconnected(_)) => record_capture_callback_failure(
            failure,
            "CAPTURE_WRITER_CLOSED",
            "capture callback queue closed before a durable write",
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn flush_pending_audio(
    sink: &CaptureSink,
    source: CaptureSource,
    sample_rate_hz: u32,
    channel_count: u16,
    frame_bytes: usize,
    target_bytes: usize,
    frames_written: &mut u64,
    pending: &mut Vec<u8>,
) -> Result<(), CaptureError> {
    while pending.len() >= target_bytes && target_bytes >= frame_bytes {
        let bytes = pending.drain(..target_bytes).collect::<Vec<_>>();
        let start_ms = frames_to_ms(*frames_written, sample_rate_hz);
        *frames_written = frames_written.saturating_add((bytes.len() / frame_bytes) as u64);
        sink.write(source, sample_rate_hz, channel_count, start_ms, bytes)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn flush_all_audio(
    sink: &CaptureSink,
    source: CaptureSource,
    sample_rate_hz: u32,
    channel_count: u16,
    frame_bytes: usize,
    frames_written: &mut u64,
    pending: &mut Vec<u8>,
) -> Result<(), CaptureError> {
    let full_len = pending.len() - (pending.len() % frame_bytes);
    if full_len == 0 {
        pending.clear();
        return Ok(());
    }
    let bytes = pending.drain(..full_len).collect::<Vec<_>>();
    let start_ms = frames_to_ms(*frames_written, sample_rate_hz);
    *frames_written = frames_written.saturating_add((bytes.len() / frame_bytes) as u64);
    sink.write(source, sample_rate_hz, channel_count, start_ms, bytes)
}

fn write_pcm_chunk(
    store: &RecordingStore,
    recording_id: &str,
    channel: &str,
    sample_rate_hz: u32,
    channel_count: u16,
    start_ms: u64,
    bytes: Vec<u8>,
) -> Result<(), CaptureError> {
    store.write_audio_chunk(WriteAudioChunkParams {
        recording_id: recording_id.to_string(),
        channel: channel.to_string(),
        data_base64: BASE64_STANDARD.encode(bytes),
        sample_rate_hz,
        channel_count,
        bits_per_sample: 16,
        start_ms: Some(start_ms),
    })?;
    Ok(())
}

fn select_input_device(
    host: &cpal::Host,
    device_id: Option<&str>,
) -> Result<cpal::Device, CaptureError> {
    match device_id.filter(|id| !id.trim().is_empty() && *id != "default") {
        Some(id) if id.starts_with("input-") => {
            let index = id
                .trim_start_matches("input-")
                .parse::<usize>()
                .map_err(|_| {
                    CaptureError::new("CAPTURE_DEVICE_ID_INVALID", "capture device id was invalid")
                })?;
            host.input_devices()
                .map_err(|error| {
                    CaptureError::new("CAPTURE_DEVICE_LIST_FAILED", error.to_string())
                })?
                .nth(index)
                .ok_or_else(|| {
                    CaptureError::new(
                        "CAPTURE_DEVICE_NOT_FOUND",
                        "capture input device was not found",
                    )
                })
        }
        Some(_) => Err(CaptureError::new(
            "CAPTURE_DEVICE_ID_INVALID",
            "capture device id must be default or input-N",
        )),
        None => host.default_input_device().ok_or_else(|| {
            CaptureError::new(
                "CAPTURE_NO_DEFAULT_INPUT",
                "no default microphone input was found",
            )
        }),
    }
}

fn select_system_device(
    host: &cpal::Host,
    device_id: Option<&str>,
) -> Result<cpal::Device, CaptureError> {
    if !system_audio_available_on_this_platform() {
        return Err(CaptureError::new(
            "CAPTURE_SYSTEM_AUDIO_UNSUPPORTED",
            system_audio_unsupported_message(),
        ));
    }
    if cfg!(target_os = "linux") {
        return select_linux_monitor_input_device(host, device_id);
    }
    match device_id.filter(|id| !id.trim().is_empty() && *id != "default") {
        Some(id) if id.starts_with("output-") => {
            let index = id
                .trim_start_matches("output-")
                .parse::<usize>()
                .map_err(|_| {
                    CaptureError::new(
                        "CAPTURE_DEVICE_ID_INVALID",
                        "output device id must use output-N",
                    )
                })?;
            host.output_devices()
                .map_err(|error| {
                    CaptureError::new("CAPTURE_DEVICE_LIST_FAILED", error.to_string())
                })?
                .nth(index)
                .ok_or_else(|| {
                    CaptureError::new(
                        "CAPTURE_DEVICE_NOT_FOUND",
                        "requested output device was not found",
                    )
                })
        }
        Some(_) => Err(CaptureError::new(
            "CAPTURE_DEVICE_ID_INVALID",
            "system capture device id must be default or output-N",
        )),
        None => host.default_output_device().ok_or_else(|| {
            CaptureError::new(
                "CAPTURE_NO_DEFAULT_OUTPUT",
                "no default system output device was found",
            )
        }),
    }
}

fn select_linux_monitor_input_device(
    host: &cpal::Host,
    device_id: Option<&str>,
) -> Result<cpal::Device, CaptureError> {
    match device_id.filter(|id| !id.trim().is_empty() && *id != "default") {
        Some(id) if id.starts_with("input-") => {
            let index = id
                .trim_start_matches("input-")
                .parse::<usize>()
                .map_err(|_| {
                    CaptureError::new(
                        "CAPTURE_DEVICE_ID_INVALID",
                        "system capture monitor device id must use input-N",
                    )
                })?;
            let device = host
                .input_devices()
                .map_err(|error| {
                    CaptureError::new("CAPTURE_DEVICE_LIST_FAILED", error.to_string())
                })?
                .nth(index)
                .ok_or_else(|| {
                    CaptureError::new(
                        "CAPTURE_DEVICE_NOT_FOUND",
                        "requested system monitor input device was not found",
                    )
                })?;
            let name = device.name().unwrap_or_default();
            if !is_linux_monitor_device_name(&name) {
                return Err(CaptureError::new(
                    "CAPTURE_SYSTEM_MONITOR_REQUIRED",
                    "Linux system capture requires a PipeWire or PulseAudio monitor input device",
                ));
            }
            Ok(device)
        }
        Some(_) => Err(CaptureError::new(
            "CAPTURE_DEVICE_ID_INVALID",
            "Linux system capture device id must be default or input-N",
        )),
        None => first_linux_monitor_input_device(host),
    }
}

fn first_linux_monitor_input_device(host: &cpal::Host) -> Result<cpal::Device, CaptureError> {
    host.input_devices()
        .map_err(|error| CaptureError::new("CAPTURE_DEVICE_LIST_FAILED", error.to_string()))?
        .find(|device| {
            device
                .name()
                .ok()
                .as_deref()
                .is_some_and(is_linux_monitor_device_name)
        })
        .ok_or_else(|| {
            CaptureError::new(
                "CAPTURE_NO_SYSTEM_MONITOR",
                "no PipeWire or PulseAudio monitor input device was found",
            )
        })
}

fn system_device_config(
    device: &cpal::Device,
) -> Result<cpal::SupportedStreamConfig, CaptureError> {
    if cfg!(target_os = "windows") {
        device.default_output_config().map_err(|error| {
            CaptureError::new("CAPTURE_OUTPUT_CONFIG_UNAVAILABLE", error.to_string())
        })
    } else {
        device.default_input_config().map_err(|error| {
            CaptureError::new("CAPTURE_INPUT_CONFIG_UNAVAILABLE", error.to_string())
        })
    }
}

fn input_devices() -> Vec<Value> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    host.input_devices()
        .ok()
        .map(|devices| {
            devices
                .enumerate()
                .map(|(index, device)| {
                    let name = device.name().unwrap_or_else(|_| "Input device".to_string());
                    json!({
                        "id": format!("input-{index}"),
                        "label": name,
                        "isDefault": default_name.as_ref().is_some_and(|default| default == &name),
                        "systemMonitorEligible": cfg!(target_os = "linux") && is_linux_monitor_device_name(&name),
                        "rawPathExposed": false
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn output_devices() -> Vec<Value> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|device| device.name().ok());
    host.output_devices()
        .ok()
        .map(|devices| {
            devices
                .enumerate()
                .map(|(index, device)| {
                    let name = device
                        .name()
                        .unwrap_or_else(|_| "Output device".to_string());
                    json!({
                        "id": format!("output-{index}"),
                        "label": name,
                        "isDefault": default_name.as_ref().is_some_and(|default| default == &name),
                        "loopbackEligible": cfg!(target_os = "windows"),
                        "rawPathExposed": false
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn default_input_available() -> bool {
    cpal::default_host().default_input_device().is_some()
}

fn default_output_available() -> bool {
    cpal::default_host().default_output_device().is_some()
}

fn default_system_audio_device_available() -> bool {
    let host = cpal::default_host();
    if cfg!(target_os = "windows") {
        host.default_output_device().is_some()
    } else if cfg!(target_os = "linux") {
        first_linux_monitor_input_device(&host).is_ok()
    } else {
        cfg!(target_os = "macos")
    }
}

fn capture_sources() -> Value {
    let system_implemented = system_audio_available_on_this_platform();
    json!({
        "mic": {
            "implemented": true,
            "backend": "cpal-default-host",
            "durableChannel": "mic",
            "integrityPolicy": capture_integrity_policy()
        },
        "system": {
            "implemented": system_implemented,
            "backend": system_audio_backend(),
            "durableChannel": "system",
            "defaultOutputAvailable": default_output_available(),
            "defaultSystemDeviceAvailable": default_system_audio_device_available(),
            "availabilityProbe": system_audio_availability_probe(),
            "simultaneousMicAndSystem": system_implemented,
            "simultaneousMethod": if system_implemented { "capture.startMicAndSystem" } else { "pending-native-adapter" },
            "serializedWriter": system_implemented,
            "requiresOsPermission": cfg!(target_os = "macos"),
            "minimumSystemVersion": if cfg!(target_os = "macos") { Some("13.0") } else { None },
            "adapters": system_audio_adapters(),
            "plannedAdapters": system_audio_adapters(),
            "integrityPolicy": capture_integrity_policy()
        }
    })
}

fn capture_integrity_policy() -> Value {
    json!({
        "callbackQueueCapacity": CAPTURE_CALLBACK_QUEUE_CAPACITY,
        "callbackOverflow": "fail-capture-session",
        "runtimeStreamErrors": "propagate-to-session",
        "silentCallbackDropsAllowed": false,
        "flushBufferedAudioOnStop": true
    })
}

fn system_audio_available_on_this_platform() -> bool {
    system_audio_available_for(std::env::consts::OS)
}

fn system_audio_available_for(os: &str) -> bool {
    matches!(os, "windows" | "linux" | "macos")
}

fn system_audio_backend() -> &'static str {
    system_audio_backend_for(std::env::consts::OS)
}

fn system_audio_backend_for(os: &str) -> &'static str {
    match os {
        "windows" => "cpal-wasapi-loopback",
        "linux" => "cpal-linux-monitor-input",
        "macos" => "screencapturekit-system-audio",
        _ => "pending-native-adapter",
    }
}

fn combined_capture_backend() -> &'static str {
    combined_capture_backend_for(std::env::consts::OS)
}

fn combined_capture_backend_for(os: &str) -> &'static str {
    match os {
        "windows" => "cpal-wasapi-loopback+mic",
        "linux" => "cpal-linux-monitor-input+mic",
        "macos" => "screencapturekit-system-audio+cpal-coreaudio-mic",
        _ => "pending-native-adapter",
    }
}

fn system_audio_unsupported_message() -> &'static str {
    "system audio capture has no native adapter for this platform"
}

fn system_audio_availability_probe() -> &'static str {
    match std::env::consts::OS {
        "windows" => "default-output-device",
        "linux" => "monitor-input-device",
        "macos" => "tcc-gated-at-capture-start",
        _ => "unsupported-platform",
    }
}

fn system_audio_adapters() -> Vec<&'static str> {
    system_audio_adapters_for(std::env::consts::OS)
}

fn system_audio_adapters_for(os: &str) -> Vec<&'static str> {
    match os {
        "windows" => vec!["wasapi-loopback"],
        "linux" => vec!["pipewire-monitor-input", "pulseaudio-monitor-input"],
        "macos" => vec!["screencapturekit-system-audio"],
        _ => vec!["native-system-audio-adapter"],
    }
}

fn is_linux_monitor_device_name(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.contains("monitor")
}

fn samples_f32_to_pcm16(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

fn samples_i16_to_pcm16(samples: &[i16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

fn samples_u16_to_pcm16(samples: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let centered = (*sample as i32 - 32_768) as i16;
        out.extend_from_slice(&centered.to_le_bytes());
    }
    out
}

fn samples_i32_to_pcm16(samples: &[i32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let value = (sample >> 16) as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

#[cfg(any(target_os = "macos", test))]
fn float32_audio_buffers_to_pcm16(
    buffers: &[(&[u8], u32)],
    channel_count: u16,
) -> Result<Vec<u8>, CaptureError> {
    if channel_count == 0 || buffers.is_empty() {
        return Err(CaptureError::new(
            "CAPTURE_AUDIO_BUFFER_INVALID",
            "captured audio did not contain any channels",
        ));
    }

    if buffers.len() == 1 {
        let (bytes, buffer_channels) = buffers[0];
        if buffer_channels != u32::from(channel_count) {
            return Err(CaptureError::new(
                "CAPTURE_AUDIO_BUFFER_INVALID",
                "interleaved audio channel metadata did not match the stream configuration",
            ));
        }
        let samples = decode_native_f32_samples(bytes)?;
        if !samples.len().is_multiple_of(usize::from(channel_count)) {
            return Err(CaptureError::new(
                "CAPTURE_AUDIO_BUFFER_INVALID",
                "interleaved audio did not contain complete frames",
            ));
        }
        return Ok(samples_f32_to_pcm16(&samples));
    }

    if buffers.len() != usize::from(channel_count)
        || buffers
            .iter()
            .any(|(_, buffer_channels)| *buffer_channels != 1)
    {
        return Err(CaptureError::new(
            "CAPTURE_AUDIO_BUFFER_INVALID",
            "planar audio buffer count did not match the stream channel count",
        ));
    }

    let channels = buffers
        .iter()
        .map(|(bytes, _)| decode_native_f32_samples(bytes))
        .collect::<Result<Vec<_>, _>>()?;
    let frame_count = channels.first().map(Vec::len).unwrap_or_default();
    if channels.iter().any(|samples| samples.len() != frame_count) {
        return Err(CaptureError::new(
            "CAPTURE_AUDIO_BUFFER_INVALID",
            "planar audio channels did not contain the same number of frames",
        ));
    }

    let mut interleaved = Vec::with_capacity(frame_count.saturating_mul(channels.len()));
    for frame in 0..frame_count {
        for channel in &channels {
            interleaved.push(channel[frame]);
        }
    }
    Ok(samples_f32_to_pcm16(&interleaved))
}

#[cfg(any(target_os = "macos", test))]
fn decode_native_f32_samples(bytes: &[u8]) -> Result<Vec<f32>, CaptureError> {
    if !bytes.len().is_multiple_of(std::mem::size_of::<f32>()) {
        return Err(CaptureError::new(
            "CAPTURE_AUDIO_BUFFER_INVALID",
            "float audio buffer length was not aligned to 32-bit samples",
        ));
    }
    Ok(bytes
        .chunks_exact(std::mem::size_of::<f32>())
        .map(|sample| f32::from_ne_bytes([sample[0], sample[1], sample[2], sample[3]]))
        .collect())
}

fn frames_to_ms(frames: u64, sample_rate_hz: u32) -> u64 {
    frames.saturating_mul(1000) / u64::from(sample_rate_hz.max(1))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f32_bytes(samples: &[f32]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_ne_bytes())
            .collect()
    }

    #[test]
    fn sample_conversion_is_little_endian_pcm16() {
        assert_eq!(samples_i16_to_pcm16(&[1, -2]), vec![1, 0, 254, 255]);
        assert_eq!(samples_u16_to_pcm16(&[32_768]), vec![0, 0]);
        assert_eq!(samples_i32_to_pcm16(&[65_536]), vec![1, 0]);
    }

    #[test]
    fn float_audio_conversion_supports_interleaved_and_planar_stereo() {
        let interleaved = f32_bytes(&[1.0, -1.0, 0.5, -0.5]);
        let left = f32_bytes(&[1.0, 0.5]);
        let right = f32_bytes(&[-1.0, -0.5]);
        let expected = samples_f32_to_pcm16(&[1.0, -1.0, 0.5, -0.5]);

        assert_eq!(
            float32_audio_buffers_to_pcm16(&[(&interleaved, 2)], 2).expect("interleaved"),
            expected
        );
        assert_eq!(
            float32_audio_buffers_to_pcm16(&[(&left, 1), (&right, 1)], 2).expect("planar"),
            expected
        );
    }

    #[test]
    fn float_audio_conversion_rejects_incomplete_frames() {
        let malformed = f32_bytes(&[0.25]);
        let error = float32_audio_buffers_to_pcm16(&[(&malformed, 2)], 2)
            .expect_err("incomplete stereo frame must fail");
        assert_eq!(error.code, "CAPTURE_AUDIO_BUFFER_INVALID");
    }

    #[test]
    fn callback_queue_overflow_is_detected_instead_of_silently_dropped() {
        let (audio_tx, _audio_rx) = mpsc::sync_channel::<Vec<u8>>(1);
        let failure = Arc::new(Mutex::new(None::<CaptureCallbackFailure>));

        send_capture_callback_audio(&audio_tx, &failure, vec![1]);
        send_capture_callback_audio(&audio_tx, &failure, vec![2]);

        let error = take_capture_callback_failure(&failure)
            .expect("a full callback queue must fail the capture session");
        assert_eq!(error.code, "CAPTURE_CALLBACK_OVERFLOW");
        assert!(error.message.contains("before a durable write"));
    }

    #[test]
    fn callback_failure_and_session_error_preserve_the_first_integrity_failure() {
        let failure = Arc::new(Mutex::new(None::<CaptureCallbackFailure>));
        record_capture_callback_failure(&failure, "CAPTURE_STREAM_ERROR", "device removed");
        record_capture_callback_failure(&failure, "CAPTURE_CALLBACK_OVERFLOW", "later overflow");
        let error = take_capture_callback_failure(&failure).expect("callback failure");
        assert_eq!(error.code, "CAPTURE_STREAM_ERROR");
        assert_eq!(error.message, "device removed");

        let last_error = Arc::new(Mutex::new(None::<String>));
        set_last_capture_error(&last_error, "first".to_string());
        set_last_capture_error(&last_error, "second".to_string());
        assert_eq!(
            last_error.lock().expect("last error lock").as_deref(),
            Some("first")
        );
    }

    #[test]
    fn stopping_after_a_writer_failure_marks_the_recording_for_recovery() {
        let root = std::env::temp_dir().join(format!("candor-capture-recovery-{}", now_ms()));
        let store = RecordingStore::with_root(root);
        let started = store
            .start(StartRecordingParams {
                label: Some("writer failure".to_string()),
            })
            .expect("start test recording");
        let recording_id = started["recordingId"]
            .as_str()
            .expect("recording id")
            .to_string();
        let mut manager = CaptureManager {
            active: Some(CaptureSession {
                recording_id,
                stop: Arc::new(AtomicBool::new(false)),
                joins: Vec::new(),
                writer_join: None,
                runtimes: Vec::new(),
                last_error: Arc::new(Mutex::new(Some(
                    "free local storage is below the durable write reserve".to_string(),
                ))),
                started_at_ms: now_ms(),
            }),
        };

        let stopped = manager.stop(&store).expect("stop failed capture");

        assert_eq!(stopped["recording"]["state"], "needsRecovery");
        assert_eq!(stopped["capture"]["integrityStatus"], "failed");
    }

    #[test]
    fn capture_integrity_policy_is_fail_closed() {
        let policy = capture_integrity_policy();
        assert_eq!(
            policy["callbackQueueCapacity"],
            CAPTURE_CALLBACK_QUEUE_CAPACITY
        );
        assert_eq!(policy["callbackOverflow"], "fail-capture-session");
        assert_eq!(policy["runtimeStreamErrors"], "propagate-to-session");
        assert_eq!(policy["silentCallbackDropsAllowed"], false);
        assert_eq!(policy["flushBufferedAudioOnStop"], true);
    }

    #[test]
    fn supported_platform_contract_includes_screencapturekit() {
        assert!(system_audio_available_for("windows"));
        assert!(system_audio_available_for("linux"));
        assert!(system_audio_available_for("macos"));
        assert!(!system_audio_available_for("android"));
        assert_eq!(
            system_audio_backend_for("macos"),
            "screencapturekit-system-audio"
        );
        assert_eq!(
            combined_capture_backend_for("macos"),
            "screencapturekit-system-audio+cpal-coreaudio-mic"
        );
        assert_eq!(
            system_audio_adapters_for("macos"),
            vec!["screencapturekit-system-audio"]
        );
    }
}
