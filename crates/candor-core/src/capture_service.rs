use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::meeting_profiles::MeetingProcessingProfileSnapshot;
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
const LIVE_PCM_QUEUE_CAPACITY: usize = 4;
const MICROPHONE_PREFERENCE_SCHEMA_VERSION: u32 = 1;
const MICROPHONE_PREFERENCE_FILE: &str = "microphone-preference.json";
const MICROPHONE_PREFERENCE_BACKUP_FILE: &str = "microphone-preference.json.bak";
const MICROPHONE_PREFERENCE_TEMP_FILE: &str = "microphone-preference.json.tmp";
const MAX_MICROPHONE_PREFERENCE_BYTES: u64 = 16 * 1024;
const MIC_TEST_SAMPLE_RATE_HZ: u32 = 16_000;
const MIC_TEST_MAX_SECONDS: usize = 5;
const MIC_TEST_MAX_SAMPLES: usize = MIC_TEST_SAMPLE_RATE_HZ as usize * MIC_TEST_MAX_SECONDS;
const MIC_TEST_SIGNAL_RMS_THRESHOLD: f32 = 0.01;
const MIC_TEST_CLIPPING_THRESHOLD: f32 = 0.98;
const MIC_TEST_STOP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug)]
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
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub profile_version: Option<u32>,
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
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub profile_version: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetPreferredMicrophoneParams {
    pub device_id: String,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub ordinal: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MicTestStartParams {
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Clone, Debug)]
struct CaptureRuntimeInfo {
    source: &'static str,
    device_label: String,
    sample_rate_hz: u32,
    channel_count: u16,
    chunk_ms: u64,
    selection_resolution: Option<&'static str>,
    reselection_required: bool,
}

struct CaptureSession {
    recording_id: String,
    stop: Arc<AtomicBool>,
    joins: Vec<thread::JoinHandle<()>>,
    writer_join: Option<thread::JoinHandle<()>>,
    runtimes: Vec<CaptureRuntimeInfo>,
    last_error: Arc<Mutex<Option<String>>>,
    live_pcm_tap: LivePcmTap,
    started_at_ms: u128,
}

/// One bounded, in-memory PCM observation delivered only to the trusted local
/// live-ASR worker. It has no serializer and cannot cross the core boundary.
#[derive(Debug)]
#[cfg_attr(not(feature = "local-whisper"), allow(dead_code))]
pub(crate) struct LiveCapturePcmChunk {
    pub(crate) source: CaptureSource,
    pub(crate) sample_rate_hz: u32,
    pub(crate) channel_count: u16,
    pub(crate) start_ms: u64,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LivePcmSourceSet {
    Mic,
    System,
    MicAndSystem,
}

impl LivePcmSourceSet {
    fn accepts(self, source: CaptureSource) -> bool {
        matches!(
            (self, source),
            (LivePcmSourceSet::Mic, CaptureSource::Mic)
                | (LivePcmSourceSet::System, CaptureSource::System)
                | (LivePcmSourceSet::MicAndSystem, _)
        )
    }

    #[cfg(test)]
    fn label(self) -> &'static str {
        match self {
            LivePcmSourceSet::Mic => "mic",
            LivePcmSourceSet::System => "system",
            LivePcmSourceSet::MicAndSystem => "mic+system",
        }
    }
}

#[derive(Debug, Default)]
struct LivePcmTapState {
    generation: u64,
    selected_sources: Option<LivePcmSourceSet>,
    sender: Option<mpsc::SyncSender<LiveCapturePcmChunk>>,
    dropped_chunk_count: Option<Arc<AtomicU64>>,
}

#[derive(Clone, Debug, Default)]
struct LivePcmTap {
    state: Arc<Mutex<LivePcmTapState>>,
}

impl LivePcmTap {
    #[cfg_attr(not(feature = "local-whisper"), allow(dead_code))]
    fn attach(
        &self,
        selected_sources: LivePcmSourceSet,
    ) -> Result<LivePcmSubscription, CaptureError> {
        let mut state = self.state.lock().map_err(|_| {
            CaptureError::new(
                "LIVE_TRANSCRIPT_TAP_UNAVAILABLE",
                "the live audio observation state is unavailable",
            )
        })?;
        if state.sender.is_some() {
            return Err(CaptureError::new(
                "LIVE_TRANSCRIPT_TAP_ACTIVE",
                "a live transcript producer is already observing this capture",
            ));
        }
        state.generation = state.generation.saturating_add(1).max(1);
        let generation = state.generation;
        let dropped_chunk_count = Arc::new(AtomicU64::new(0));
        let (sender, receiver) = mpsc::sync_channel(LIVE_PCM_QUEUE_CAPACITY);
        state.selected_sources = Some(selected_sources);
        state.sender = Some(sender);
        state.dropped_chunk_count = Some(dropped_chunk_count.clone());
        Ok(LivePcmSubscription {
            receiver,
            tap: self.clone(),
            generation,
            combines_sources: selected_sources == LivePcmSourceSet::MicAndSystem,
            #[cfg(test)]
            selected_sources: selected_sources.label(),
            dropped_chunk_count,
        })
    }

    fn accepts(&self, source: CaptureSource) -> bool {
        self.state.lock().is_ok_and(|state| {
            state
                .selected_sources
                .is_some_and(|selected| selected.accepts(source))
                && state.sender.is_some()
        })
    }

    fn publish(
        &self,
        source: CaptureSource,
        sample_rate_hz: u32,
        channel_count: u16,
        start_ms: u64,
        bytes: Vec<u8>,
    ) {
        let selected = self.state.lock().ok().and_then(|state| {
            state
                .selected_sources
                .is_some_and(|selected| selected.accepts(source))
                .then(|| (state.sender.clone(), state.dropped_chunk_count.clone()))
        });
        let Some((Some(sender), dropped_chunk_count)) = selected else {
            return;
        };
        let chunk = LiveCapturePcmChunk {
            source,
            sample_rate_hz,
            channel_count,
            start_ms,
            bytes,
        };
        match sender.try_send(chunk) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => {
                if let Some(counter) = dropped_chunk_count {
                    counter.fetch_add(1, Ordering::Relaxed);
                }
            }
            Err(mpsc::TrySendError::Disconnected(_)) => self.detach_current(),
        }
    }

    fn detach(&self, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state.generation == generation {
                state.sender = None;
                state.selected_sources = None;
                state.dropped_chunk_count = None;
            }
        }
    }

    fn detach_current(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.sender = None;
            state.selected_sources = None;
            state.dropped_chunk_count = None;
        }
    }
}

/// Ownership token for the sole live PCM consumer. Dropping it detaches the
/// sender immediately, even if its worker is still unwinding Whisper.
#[derive(Debug)]
#[cfg_attr(not(feature = "local-whisper"), allow(dead_code))]
pub(crate) struct LivePcmSubscription {
    pub(crate) receiver: mpsc::Receiver<LiveCapturePcmChunk>,
    tap: LivePcmTap,
    generation: u64,
    combines_sources: bool,
    #[cfg(test)]
    pub(crate) selected_sources: &'static str,
    dropped_chunk_count: Arc<AtomicU64>,
}

#[derive(Clone, Debug)]
pub(crate) struct LivePcmDetachHandle {
    tap: LivePcmTap,
    generation: u64,
}

impl LivePcmDetachHandle {
    pub(crate) fn detach(&self) {
        self.tap.detach(self.generation);
    }
}

impl LivePcmSubscription {
    #[cfg_attr(not(feature = "local-whisper"), allow(dead_code))]
    pub(crate) fn combines_sources(&self) -> bool {
        self.combines_sources
    }

    #[cfg(test)]
    pub(crate) fn dropped_chunk_count(&self) -> u64 {
        self.dropped_chunk_count.load(Ordering::Relaxed)
    }

    #[cfg_attr(not(feature = "local-whisper"), allow(dead_code))]
    pub(crate) fn dropped_chunk_counter(&self) -> Arc<AtomicU64> {
        self.dropped_chunk_count.clone()
    }

    #[cfg(test)]
    pub(crate) fn detach(&self) {
        self.tap.detach(self.generation);
    }

    #[cfg_attr(not(feature = "local-whisper"), allow(dead_code))]
    pub(crate) fn detach_handle(&self) -> LivePcmDetachHandle {
        LivePcmDetachHandle {
            tap: self.tap.clone(),
            generation: self.generation,
        }
    }
}

impl Drop for LivePcmSubscription {
    fn drop(&mut self) {
        self.tap.detach(self.generation);
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredMicrophonePreference {
    schema_version: u32,
    #[serde(default)]
    preferred_microphone: Option<StoredPreferredMicrophone>,
}

impl Default for StoredMicrophonePreference {
    fn default() -> Self {
        Self {
            schema_version: MICROPHONE_PREFERENCE_SCHEMA_VERSION,
            preferred_microphone: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredPreferredMicrophone {
    fingerprint: String,
    ordinal: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct InputDeviceIdentity {
    id: String,
    label: String,
    fingerprint: String,
    ordinal: usize,
    is_default: bool,
}

#[derive(Clone, Debug)]
struct ResolvedMicrophonePreference {
    device_id: Option<String>,
    device_label: Option<String>,
    resolution: &'static str,
    reselection_required: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum MicrophoneDeviceSelection {
    Default,
    Preferred {
        fingerprint: String,
        saved_ordinal: usize,
    },
}

#[derive(Clone, Debug)]
enum CaptureDeviceSelection {
    Microphone(MicrophoneDeviceSelection),
    System(Option<String>),
}

struct SelectedInputDevice {
    device: cpal::Device,
    device_label: String,
    supported: cpal::SupportedStreamConfig,
    resolution: &'static str,
    reselection_required: bool,
}

#[derive(Clone, Debug)]
struct MicrophoneProbeRuntime {
    device_label: String,
    sample_rate_hz: u32,
    channel_count: u16,
    selection_resolution: &'static str,
    reselection_required: bool,
}

#[derive(Debug)]
struct MicrophoneProbeState {
    samples: VecDeque<i16>,
    source_sample_rate_hz: u32,
    source_channel_count: u16,
    resample_accumulator: u64,
    rms: f32,
    peak: f32,
    clipping: bool,
    signal_detected: bool,
    capture_complete: bool,
    last_error: Option<CaptureError>,
}

impl Default for MicrophoneProbeState {
    fn default() -> Self {
        Self {
            samples: VecDeque::with_capacity(MIC_TEST_MAX_SAMPLES),
            source_sample_rate_hz: MIC_TEST_SAMPLE_RATE_HZ,
            source_channel_count: 1,
            resample_accumulator: 0,
            rms: 0.0,
            peak: 0.0,
            clipping: false,
            signal_detected: false,
            capture_complete: false,
            last_error: None,
        }
    }
}

impl MicrophoneProbeState {
    fn process_interleaved<T, F>(&mut self, data: &[T], sample_to_f32: F)
    where
        F: Fn(&T) -> f32,
    {
        let channel_count = usize::from(self.source_channel_count.max(1));
        let source_sample_rate_hz = u64::from(self.source_sample_rate_hz.max(1));
        let mut squared_sum = 0.0_f64;
        let mut peak = 0.0_f32;
        let mut frame_count = 0_u64;

        for frame in data.chunks_exact(channel_count) {
            let mono = frame
                .iter()
                .map(|sample| sample_to_f32(sample).clamp(-1.0, 1.0))
                .sum::<f32>()
                / channel_count as f32;
            let magnitude = mono.abs();
            squared_sum += f64::from(mono) * f64::from(mono);
            peak = peak.max(magnitude);
            frame_count = frame_count.saturating_add(1);

            self.resample_accumulator = self
                .resample_accumulator
                .saturating_add(u64::from(MIC_TEST_SAMPLE_RATE_HZ));
            while self.resample_accumulator >= source_sample_rate_hz {
                self.resample_accumulator -= source_sample_rate_hz;
                let pcm = (mono * i16::MAX as f32).round() as i16;
                if self.samples.len() == MIC_TEST_MAX_SAMPLES {
                    self.samples.pop_front();
                }
                self.samples.push_back(pcm);
            }
        }

        if frame_count > 0 {
            self.rms = (squared_sum / frame_count as f64).sqrt() as f32;
            self.peak = peak;
            self.clipping |= peak >= MIC_TEST_CLIPPING_THRESHOLD;
            self.signal_detected |= self.rms >= MIC_TEST_SIGNAL_RMS_THRESHOLD;
        }
    }

    fn zero_and_clear_samples(&mut self) {
        for sample in &mut self.samples {
            *sample = 0;
        }
        self.samples.clear();
        self.resample_accumulator = 0;
    }

    fn zero_audio_state(&mut self) {
        self.zero_and_clear_samples();
        self.rms = 0.0;
        self.peak = 0.0;
        self.clipping = false;
        self.signal_detected = false;
        self.capture_complete = false;
    }

    fn zero_and_reset(&mut self) {
        self.zero_audio_state();
        self.last_error = None;
    }
}

struct MicrophoneProbe {
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
    state: Arc<Mutex<MicrophoneProbeState>>,
    runtime: Option<MicrophoneProbeRuntime>,
    started_at_ms: u128,
}

enum MicrophoneProbeJoinResult {
    Joined,
    Panicked,
    TimedOut,
}

enum MicrophoneProbeRunResult {
    Completed,
    Stopped,
}

#[derive(Default)]
pub struct CaptureManager {
    active: Option<CaptureSession>,
    microphone_probe: Option<MicrophoneProbe>,
    preferences_root: Option<PathBuf>,
}

impl Drop for CaptureManager {
    fn drop(&mut self) {
        if let Some(mut probe) = self.microphone_probe.take() {
            probe.stop.store(true, Ordering::SeqCst);
            clear_probe_state(&probe.state);
            // Shutdown must remain bounded even if an OS audio backend stalls
            // while releasing its stream. The callback observes `stop` before
            // accepting more audio, so the cleared sample buffer stays empty.
            let _ = join_microphone_probe_bounded(&mut probe, MIC_TEST_STOP_TIMEOUT);
            clear_probe_state(&probe.state);
        }
    }
}

fn join_microphone_probe_bounded(
    probe: &mut MicrophoneProbe,
    timeout: Duration,
) -> MicrophoneProbeJoinResult {
    let Some(join) = probe.join.take() else {
        return MicrophoneProbeJoinResult::Joined;
    };
    let deadline = Instant::now() + timeout;
    while !join.is_finished() && Instant::now() < deadline {
        thread::sleep(CAPTURE_POLL_TIMEOUT);
    }
    if !join.is_finished() {
        probe.join = Some(join);
        return MicrophoneProbeJoinResult::TimedOut;
    }
    match join.join() {
        Ok(()) => MicrophoneProbeJoinResult::Joined,
        Err(_) => MicrophoneProbeJoinResult::Panicked,
    }
}

fn resolve_microphone_preference(
    stored: &StoredMicrophonePreference,
    devices: &[InputDeviceIdentity],
) -> ResolvedMicrophonePreference {
    let Some(preferred) = stored.preferred_microphone.as_ref() else {
        return ResolvedMicrophonePreference {
            device_id: None,
            device_label: devices
                .iter()
                .find(|device| device.is_default)
                .map(|device| device.label.clone()),
            resolution: if devices.is_empty() {
                "unavailable"
            } else {
                "default"
            },
            reselection_required: false,
        };
    };

    let fingerprint_matches = devices
        .iter()
        .filter(|device| device.fingerprint == preferred.fingerprint)
        .collect::<Vec<_>>();
    if fingerprint_matches.len() == 1 {
        let device = fingerprint_matches[0];
        return ResolvedMicrophonePreference {
            device_id: Some(device.id.clone()),
            device_label: Some(device.label.clone()),
            resolution: "fingerprint",
            reselection_required: false,
        };
    }

    ResolvedMicrophonePreference {
        device_id: None,
        device_label: devices
            .iter()
            .find(|device| device.is_default)
            .map(|device| device.label.clone()),
        resolution: if devices.is_empty() {
            "unavailable"
        } else if fingerprint_matches.len() > 1 {
            "ambiguous-fingerprint"
        } else {
            "default-fallback"
        },
        reselection_required: true,
    }
}

fn microphone_device_selection(
    stored: &StoredMicrophonePreference,
    requested_device_id: Option<&str>,
) -> Result<MicrophoneDeviceSelection, CaptureError> {
    let requested_device_id = requested_device_id
        .map(str::trim)
        .filter(|device_id| !device_id.is_empty());
    if requested_device_id == Some("default") {
        return Ok(MicrophoneDeviceSelection::Default);
    }

    let preferred = stored.preferred_microphone.as_ref();
    if let Some(requested_device_id) = requested_device_id {
        let requested_ordinal = requested_device_id
            .strip_prefix("input-")
            .and_then(|ordinal| ordinal.parse::<usize>().ok())
            .ok_or_else(|| {
                CaptureError::new(
                    "CAPTURE_DEVICE_ID_INVALID",
                    "microphone device id must be default or input-N",
                )
            })?;
        let preferred = preferred.ok_or_else(|| {
            CaptureError::new(
                "CAPTURE_DEVICE_IDENTITY_REQUIRED",
                "save the microphone identity before opening a non-default device",
            )
        })?;
        if requested_ordinal != preferred.ordinal {
            return Err(CaptureError::new(
                "CAPTURE_DEVICE_IDENTITY_STALE",
                "microphone devices changed; refresh and save the selection before opening it",
            ));
        }
    }

    Ok(match preferred {
        Some(preferred) => MicrophoneDeviceSelection::Preferred {
            fingerprint: preferred.fingerprint.clone(),
            saved_ordinal: preferred.ordinal,
        },
        None => MicrophoneDeviceSelection::Default,
    })
}

fn microphone_device_fingerprint(
    label: &str,
    sample_rate_hz: u32,
    channel_count: u16,
    sample_format: &str,
) -> String {
    let normalized_label = label
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(b"candor-microphone-fingerprint-v1\0");
    hasher.update(normalized_label.as_bytes());
    hasher.update(b"\0");
    hasher.update(sample_rate_hz.to_le_bytes());
    hasher.update(channel_count.to_le_bytes());
    hasher.update(b"\0");
    hasher.update(sample_format.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn mark_unique_default_input(
    devices: &mut [InputDeviceIdentity],
    default_fingerprint: Option<&str>,
) {
    devices
        .iter_mut()
        .for_each(|device| device.is_default = false);
    let Some(default_fingerprint) = default_fingerprint else {
        return;
    };
    let matches = devices
        .iter()
        .enumerate()
        .filter_map(|(index, device)| (device.fingerprint == default_fingerprint).then_some(index))
        .collect::<Vec<_>>();
    if let [index] = matches.as_slice() {
        devices[*index].is_default = true;
    }
}

fn input_device_identities() -> Result<Vec<InputDeviceIdentity>, CaptureError> {
    let host = cpal::default_host();
    let default_fingerprint = host.default_input_device().and_then(|device| {
        let label = device.name().ok()?;
        let config = device.default_input_config().ok()?;
        Some(microphone_device_fingerprint(
            &label,
            config.sample_rate().0,
            config.channels(),
            &format!("{:?}", config.sample_format()),
        ))
    });
    let devices = host
        .input_devices()
        .map_err(|error| CaptureError::new("CAPTURE_DEVICE_LIST_FAILED", error.to_string()))?;
    let mut identities = devices
        .enumerate()
        .map(|(ordinal, device)| {
            let label = device.name().unwrap_or_else(|_| "Input device".to_string());
            let (sample_rate_hz, channel_count, sample_format) = device
                .default_input_config()
                .map(|config| {
                    (
                        config.sample_rate().0,
                        config.channels(),
                        format!("{:?}", config.sample_format()),
                    )
                })
                .unwrap_or_else(|_| (0, 0, "unknown".to_string()));
            InputDeviceIdentity {
                id: format!("input-{ordinal}"),
                fingerprint: microphone_device_fingerprint(
                    &label,
                    sample_rate_hz,
                    channel_count,
                    &sample_format,
                ),
                ordinal,
                is_default: false,
                label,
            }
        })
        .collect::<Vec<_>>();
    mark_unique_default_input(&mut identities, default_fingerprint.as_deref());
    Ok(identities)
}

fn microphone_preference_status_value(
    stored: &StoredMicrophonePreference,
    devices: &[InputDeviceIdentity],
    state: &'static str,
    failure_code: Option<&'static str>,
) -> Value {
    let resolved = resolve_microphone_preference(stored, devices);
    let configured = stored.preferred_microphone.is_some();
    let fingerprint = stored
        .preferred_microphone
        .as_ref()
        .map(|preferred| preferred.fingerprint.clone());
    let ordinal = stored
        .preferred_microphone
        .as_ref()
        .map(|preferred| preferred.ordinal);
    let preferred_device_id = resolved
        .device_id
        .clone()
        .unwrap_or_else(|| "default".to_string());
    json!({
        "implemented": true,
        "state": state,
        "configured": configured,
        "preferredMicrophoneId": preferred_device_id,
        "preferredMicrophone": {
            "deviceId": resolved.device_id.unwrap_or_else(|| "default".to_string()),
            "deviceLabel": resolved.device_label,
            "fingerprint": fingerprint,
            "ordinal": ordinal,
            "resolution": resolved.resolution,
            "reselectionRequired": resolved.reselection_required
        },
        "failureCode": failure_code,
        "localOnly": true,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn read_microphone_preference(path: &Path) -> Result<StoredMicrophonePreference, CaptureError> {
    let metadata = fs::metadata(path).map_err(|_| {
        CaptureError::new(
            "CAPTURE_PREFERENCES_READ_FAILED",
            "capture preferences could not be read",
        )
    })?;
    if metadata.len() > MAX_MICROPHONE_PREFERENCE_BYTES {
        return Err(CaptureError::new(
            "CAPTURE_PREFERENCES_CORRUPT",
            "capture preferences exceeded the supported size",
        ));
    }
    let bytes = fs::read(path).map_err(|_| {
        CaptureError::new(
            "CAPTURE_PREFERENCES_READ_FAILED",
            "capture preferences could not be read",
        )
    })?;
    let stored = serde_json::from_slice::<StoredMicrophonePreference>(&bytes).map_err(|_| {
        CaptureError::new(
            "CAPTURE_PREFERENCES_CORRUPT",
            "capture preferences were not valid JSON",
        )
    })?;
    if stored.schema_version != MICROPHONE_PREFERENCE_SCHEMA_VERSION {
        return Err(CaptureError::new(
            "CAPTURE_PREFERENCES_SCHEMA_UNSUPPORTED",
            "capture preferences used an unsupported schema version",
        ));
    }
    if stored
        .preferred_microphone
        .as_ref()
        .is_some_and(|preferred| {
            preferred.fingerprint.len() != 64
                || !preferred
                    .fingerprint
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(CaptureError::new(
            "CAPTURE_PREFERENCES_CORRUPT",
            "preferred microphone identity was invalid",
        ));
    }
    Ok(stored)
}

fn write_microphone_preference(
    root: &Path,
    stored: &StoredMicrophonePreference,
) -> Result<(), CaptureError> {
    fs::create_dir_all(root).map_err(|_| {
        CaptureError::new(
            "CAPTURE_PREFERENCES_DIR_FAILED",
            "capture preferences storage could not be prepared",
        )
    })?;
    let target = root.join(MICROPHONE_PREFERENCE_FILE);
    let backup = root.join(MICROPHONE_PREFERENCE_BACKUP_FILE);
    let temporary = root.join(MICROPHONE_PREFERENCE_TEMP_FILE);
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(|_| {
            CaptureError::new(
                "CAPTURE_PREFERENCES_TEMP_FAILED",
                "stale temporary capture preferences could not be removed",
            )
        })?;
    }
    let payload = serde_json::to_vec_pretty(stored).map_err(|_| {
        CaptureError::new(
            "CAPTURE_PREFERENCES_SERIALIZE_FAILED",
            "capture preferences could not be encoded",
        )
    })?;
    if payload.len() as u64 > MAX_MICROPHONE_PREFERENCE_BYTES {
        return Err(CaptureError::new(
            "CAPTURE_PREFERENCES_TOO_LARGE",
            "capture preferences exceeded the supported size",
        ));
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| {
            CaptureError::new(
                "CAPTURE_PREFERENCES_WRITE_FAILED",
                "capture preferences could not be written",
            )
        })?;
    file.write_all(&payload)
        .and_then(|_| file.sync_all())
        .map_err(|_| {
            CaptureError::new(
                "CAPTURE_PREFERENCES_WRITE_FAILED",
                "capture preferences could not be written durably",
            )
        })?;
    drop(file);

    if backup.exists() {
        fs::remove_file(&backup).map_err(|_| {
            CaptureError::new(
                "CAPTURE_PREFERENCES_BACKUP_FAILED",
                "stale capture preferences backup could not be removed",
            )
        })?;
    }
    let had_target = target.exists();
    if had_target {
        fs::rename(&target, &backup).map_err(|_| {
            CaptureError::new(
                "CAPTURE_PREFERENCES_BACKUP_FAILED",
                "current capture preferences could not be backed up",
            )
        })?;
    }
    if fs::rename(&temporary, &target).is_err() {
        if had_target && backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        return Err(CaptureError::new(
            "CAPTURE_PREFERENCES_COMMIT_FAILED",
            "new capture preferences could not be committed",
        ));
    }
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

fn active_session_status(session: &CaptureSession) -> Value {
    let runtimes = session_runtimes_json(&session.runtimes);
    let primary = session.runtimes.first();
    const MAX_SAFE_JSON_INTEGER: u128 = 9_007_199_254_740_991;
    let duration_ms = now_ms()
        .saturating_sub(session.started_at_ms)
        .min(MAX_SAFE_JSON_INTEGER) as u64;
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
        "durationMs": duration_ms,
        "lastError": last_error,
        "integrityStatus": integrity_status,
        "rawPathExposed": false
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CaptureSource {
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
        live_pcm_tap: LivePcmTap,
    },
    Queue {
        tx: mpsc::SyncSender<CapturedAudioChunk>,
        live_pcm_tap: LivePcmTap,
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
                live_pcm_tap,
            } => {
                write_pcm_chunk(
                    store,
                    recording_id,
                    source.label(),
                    sample_rate_hz,
                    channel_count,
                    start_ms,
                    &bytes,
                )?;
                live_pcm_tap.publish(source, sample_rate_hz, channel_count, start_ms, bytes);
                Ok(())
            }
            CaptureSink::Queue { tx, live_pcm_tap } => {
                let observe = live_pcm_tap.accepts(source);
                if observe {
                    tx.send(CapturedAudioChunk {
                        source,
                        sample_rate_hz,
                        channel_count,
                        start_ms,
                        bytes: bytes.clone(),
                    })
                    .map_err(|_| {
                        CaptureError::new(
                            "CAPTURE_WRITER_CLOSED",
                            "capture writer closed before the audio chunk was persisted",
                        )
                    })?;
                    live_pcm_tap.publish(source, sample_rate_hz, channel_count, start_ms, bytes);
                } else {
                    tx.send(CapturedAudioChunk {
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
                    })?;
                }
                Ok(())
            }
        }
    }
}

impl CaptureManager {
    pub fn with_preferences_root(root: PathBuf) -> Self {
        Self {
            active: None,
            microphone_probe: None,
            preferences_root: Some(root),
        }
    }

    pub fn preferences(&self) -> Value {
        let (stored, state, failure_code) = match self.load_microphone_preference() {
            Ok(stored) => (stored, "ready", None),
            Err(error) => (
                StoredMicrophonePreference::default(),
                "corrupt",
                Some(error.code),
            ),
        };
        let devices = input_device_identities().unwrap_or_default();
        microphone_preference_status_value(&stored, &devices, state, failure_code)
    }

    pub fn set_preferred_microphone(
        &mut self,
        params: SetPreferredMicrophoneParams,
    ) -> Result<Value, CaptureError> {
        let requested_id = params.device_id.trim();
        if requested_id.is_empty() {
            return Err(CaptureError::new(
                "CAPTURE_DEVICE_ID_INVALID",
                "preferred microphone device id must be default or input-N",
            ));
        }

        let devices = if requested_id == "default" {
            input_device_identities().unwrap_or_default()
        } else {
            input_device_identities()?
        };
        let preferred_microphone = if requested_id == "default" {
            None
        } else {
            let identity = devices
                .iter()
                .find(|device| device.id == requested_id)
                .ok_or_else(|| {
                    CaptureError::new(
                        "CAPTURE_DEVICE_NOT_FOUND",
                        "preferred microphone input device was not found",
                    )
                })?;
            if params
                .fingerprint
                .as_deref()
                .is_some_and(|fingerprint| fingerprint != identity.fingerprint)
                || params
                    .ordinal
                    .is_some_and(|ordinal| ordinal != identity.ordinal)
            {
                return Err(CaptureError::new(
                    "CAPTURE_DEVICE_IDENTITY_STALE",
                    "microphone devices changed; refresh the device list before saving",
                ));
            }
            Some(StoredPreferredMicrophone {
                fingerprint: identity.fingerprint.clone(),
                ordinal: identity.ordinal,
            })
        };
        let stored = StoredMicrophonePreference {
            schema_version: MICROPHONE_PREFERENCE_SCHEMA_VERSION,
            preferred_microphone,
        };
        // Device selection is a native ownership boundary, not only a renderer
        // convention. Stop and zero any active probe before publishing the new
        // preference so no callback can continue filling the old device's
        // buffer after a selection change.
        self.mic_test_stop()?;
        self.write_microphone_preference(&stored)?;
        Ok(microphone_preference_status_value(
            &stored, &devices, "ready", None,
        ))
    }

    pub fn mic_test_start(&mut self, params: MicTestStartParams) -> Result<Value, CaptureError> {
        if self.active.is_some() {
            return Err(CaptureError::new(
                "CAPTURE_ALREADY_ACTIVE",
                "microphone test cannot start while a capture session is active",
            ));
        }
        if self.microphone_probe.is_some() {
            return Err(CaptureError::new(
                "CAPTURE_MIC_TEST_ALREADY_ACTIVE",
                "a microphone test is already active",
            ));
        }

        let device_selection = self.microphone_device_selection(params.device_id.as_deref())?;
        let stop = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(MicrophoneProbeState::default()));
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread_stop = stop.clone();
        let thread_state = state.clone();
        let join = thread::spawn(move || {
            let result = run_microphone_probe(
                device_selection,
                thread_stop.clone(),
                thread_state.clone(),
                ready_tx,
            );
            match result {
                Ok(MicrophoneProbeRunResult::Completed) => {}
                Ok(MicrophoneProbeRunResult::Stopped) => {
                    clear_probe_audio_state(&thread_state);
                }
                Err(error) => {
                    thread_stop.store(true, Ordering::SeqCst);
                    set_probe_error(&thread_state, error);
                    clear_probe_audio_state(&thread_state);
                }
            }
        });

        let runtime = match ready_rx.recv_timeout(CAPTURE_READY_TIMEOUT) {
            Ok(Ok(runtime)) => runtime,
            Ok(Err(error)) => {
                stop.store(true, Ordering::SeqCst);
                let _ = join.join();
                clear_probe_state(&state);
                return Err(error);
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                clear_probe_state(&state);
                // Retain ownership while the native backend unwinds so durable
                // capture cannot overlap a late device open or stream play.
                self.microphone_probe = Some(MicrophoneProbe {
                    stop,
                    join: Some(join),
                    state,
                    runtime: None,
                    started_at_ms: now_ms(),
                });
                return Err(CaptureError::new(
                    "CAPTURE_MIC_TEST_START_TIMEOUT",
                    "microphone test did not become ready in time",
                ));
            }
        };

        self.microphone_probe = Some(MicrophoneProbe {
            stop,
            join: Some(join),
            state,
            runtime: Some(runtime),
            started_at_ms: now_ms(),
        });
        Ok(self.mic_test_status())
    }

    pub fn mic_test_status(&self) -> Value {
        match self.microphone_probe.as_ref() {
            Some(probe) => microphone_probe_status_value(probe),
            None => inactive_microphone_probe_status_value(),
        }
    }

    pub fn mic_test_sample(&self) -> Result<Value, CaptureError> {
        let probe = self.microphone_probe.as_ref().ok_or_else(|| {
            CaptureError::new(
                "CAPTURE_MIC_TEST_NOT_ACTIVE",
                "there is no active microphone test",
            )
        })?;
        if probe.runtime.is_none() {
            return Err(CaptureError::new(
                "CAPTURE_MIC_TEST_STOPPING",
                "the timed-out microphone test is still releasing the native audio device",
            ));
        }
        let (mut samples, clipping, signal_detected) = {
            let mut state = probe.state.lock().map_err(|_| {
                CaptureError::new(
                    "CAPTURE_MIC_TEST_STATE_FAILED",
                    "microphone test state is temporarily unavailable",
                )
            })?;
            let samples = state.samples.iter().copied().collect::<Vec<_>>();
            let clipping = state.clipping;
            let signal_detected = state.signal_detected;
            state.zero_and_clear_samples();
            (samples, clipping, signal_detected)
        };
        let sample_count = samples.len();
        let duration_ms = sample_count.saturating_mul(1000) / MIC_TEST_SAMPLE_RATE_HZ as usize;
        let mut wav = pcm16_mono_wav(&samples, MIC_TEST_SAMPLE_RATE_HZ);
        let byte_count = wav.len();
        let data_base64 = BASE64_STANDARD.encode(&wav);
        samples.fill(0);
        wav.fill(0);
        Ok(json!({
            "format": "wav",
            "mimeType": "audio/wav",
            "sampleRateHz": MIC_TEST_SAMPLE_RATE_HZ,
            "channelCount": 1,
            "bitsPerSample": 16,
            "sampleCount": sample_count,
            "durationMs": duration_ms,
            "byteCount": byte_count,
            "dataBase64": data_base64,
            "clipping": clipping,
            "signalDetected": signal_detected,
            "bufferCleared": true,
            "maxDurationMs": MIC_TEST_MAX_SECONDS * 1000,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn mic_test_stop(&mut self) -> Result<Value, CaptureError> {
        self.mic_test_stop_with_timeout(MIC_TEST_STOP_TIMEOUT)
    }

    fn mic_test_stop_with_timeout(&mut self, timeout: Duration) -> Result<Value, CaptureError> {
        let Some(mut probe) = self.microphone_probe.take() else {
            return Ok(stopped_microphone_probe_status_value());
        };
        probe.stop.store(true, Ordering::SeqCst);
        // Clear before waiting for native teardown. If teardown stalls, no
        // captured sample remains resident and the stopped probe stays owned by
        // the manager so durable capture cannot overlap it.
        clear_probe_state(&probe.state);
        match join_microphone_probe_bounded(&mut probe, timeout) {
            MicrophoneProbeJoinResult::Joined => Ok(stopped_microphone_probe_status_value()),
            MicrophoneProbeJoinResult::Panicked => Err(CaptureError::new(
                "CAPTURE_MIC_TEST_THREAD_FAILED",
                "microphone test thread panicked",
            )),
            MicrophoneProbeJoinResult::TimedOut => {
                self.microphone_probe = Some(probe);
                Err(CaptureError::new(
                    "CAPTURE_MIC_TEST_STOP_TIMEOUT",
                    "microphone test is still releasing the native audio device",
                ))
            }
        }
    }

    fn stop_microphone_probe_for_capture(&mut self) -> Result<(), CaptureError> {
        self.stop_microphone_probe_for_capture_with_timeout(MIC_TEST_STOP_TIMEOUT)
    }

    fn stop_microphone_probe_for_capture_with_timeout(
        &mut self,
        timeout: Duration,
    ) -> Result<(), CaptureError> {
        if self.microphone_probe.is_some() {
            self.mic_test_stop_with_timeout(timeout)?;
        }
        Ok(())
    }

    fn microphone_device_selection(
        &self,
        requested_device_id: Option<&str>,
    ) -> Result<MicrophoneDeviceSelection, CaptureError> {
        let stored = self.load_microphone_preference()?;
        microphone_device_selection(&stored, requested_device_id)
    }

    fn load_microphone_preference(&self) -> Result<StoredMicrophonePreference, CaptureError> {
        let Some(root) = self.preferences_root.as_ref() else {
            return Ok(StoredMicrophonePreference::default());
        };
        let target = root.join(MICROPHONE_PREFERENCE_FILE);
        let backup = root.join(MICROPHONE_PREFERENCE_BACKUP_FILE);
        if !target.exists() {
            if backup.exists() {
                let stored = read_microphone_preference(&backup)?;
                fs::rename(&backup, &target).map_err(|_| {
                    CaptureError::new(
                        "CAPTURE_PREFERENCES_BACKUP_FAILED",
                        "capture preferences could not be restored after an interrupted write",
                    )
                })?;
                return Ok(stored);
            }
            return Ok(StoredMicrophonePreference::default());
        }
        match read_microphone_preference(&target) {
            Ok(stored) => Ok(stored),
            Err(primary_error) => {
                if backup.exists() {
                    read_microphone_preference(&backup).map_err(|_| primary_error)
                } else {
                    Err(primary_error)
                }
            }
        }
    }

    fn write_microphone_preference(
        &self,
        stored: &StoredMicrophonePreference,
    ) -> Result<(), CaptureError> {
        let root = self.preferences_root.as_ref().ok_or_else(|| {
            CaptureError::new(
                "CAPTURE_PREFERENCES_UNAVAILABLE",
                "capture preferences do not have a durable settings root",
            )
        })?;
        write_microphone_preference(root, stored)
    }

    pub fn is_active(&self) -> bool {
        self.active.is_some()
    }

    /// Stops new capture delivery immediately without joining threads or
    /// finalizing the durable recording. The regular `stop` call retains sole
    /// ownership of those potentially blocking operations.
    pub(crate) fn request_stop(&self) -> Option<String> {
        let session = self.active.as_ref()?;
        session.live_pcm_tap.detach_current();
        session.stop.store(true, Ordering::SeqCst);
        Some(session.recording_id.clone())
    }

    #[cfg_attr(not(feature = "local-whisper"), allow(dead_code))]
    pub(crate) fn subscribe_live_pcm(
        &self,
        recording_id: &str,
    ) -> Result<LivePcmSubscription, CaptureError> {
        let session = self.active.as_ref().ok_or_else(|| {
            CaptureError::new(
                "LIVE_TRANSCRIPT_CAPTURE_INACTIVE",
                "live transcription requires an active capture session",
            )
        })?;
        if session.recording_id != recording_id {
            return Err(CaptureError::new(
                "LIVE_TRANSCRIPT_RECORDING_MISMATCH",
                "the live transcript recording does not match the active capture",
            ));
        }
        let has_mic = session
            .runtimes
            .iter()
            .any(|runtime| runtime.source == CaptureSource::Mic.label());
        let has_system = session
            .runtimes
            .iter()
            .any(|runtime| runtime.source == CaptureSource::System.label());
        let selected_sources = match (has_mic, has_system) {
            (true, true) => LivePcmSourceSet::MicAndSystem,
            (true, false) => LivePcmSourceSet::Mic,
            (false, true) => LivePcmSourceSet::System,
            (false, false) => {
                return Err(CaptureError::new(
                    "LIVE_TRANSCRIPT_CAPTURE_SOURCE_UNAVAILABLE",
                    "the active capture has no supported live transcript source",
                ));
            }
        };
        session.live_pcm_tap.attach(selected_sources)
    }

    #[cfg(test)]
    pub(crate) fn activate_synthetic_for_test(&mut self) {
        self.active = Some(CaptureSession {
            recording_id: "synthetic-active".to_string(),
            stop: Arc::new(AtomicBool::new(false)),
            joins: Vec::new(),
            writer_join: None,
            runtimes: Vec::new(),
            last_error: Arc::new(Mutex::new(None)),
            live_pcm_tap: LivePcmTap::default(),
            started_at_ms: now_ms(),
        });
    }

    pub fn status(&mut self) -> Value {
        let active = self.active.as_ref().map(active_session_status);
        json!({
            "implemented": true,
            "active": self.active.is_some(),
            "defaultInputAvailable": default_input_available(),
            "defaultOutputAvailable": default_output_available(),
            "sources": capture_sources(),
            "integrityPolicy": capture_integrity_policy(),
            "activeSession": active,
            "microphoneTest": self.mic_test_status(),
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
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    pub(crate) fn start_mic_with_processing_profile(
        &mut self,
        store: RecordingStore,
        params: CaptureStartParams,
        processing_profile: Option<MeetingProcessingProfileSnapshot>,
    ) -> Result<Value, CaptureError> {
        if self.active.is_some() {
            return Err(CaptureError::new(
                "CAPTURE_ALREADY_ACTIVE",
                "a capture session is already active",
            ));
        }
        self.stop_microphone_probe_for_capture()?;

        let thread_device_selection =
            self.microphone_device_selection(params.device_id.as_deref())?;
        let chunk_ms = params
            .chunk_ms
            .unwrap_or(DEFAULT_CAPTURE_CHUNK_MS)
            .clamp(MIN_CAPTURE_CHUNK_MS, MAX_CAPTURE_CHUNK_MS);
        let started = store.start_with_processing_profile(
            StartRecordingParams {
                label: params.label.clone(),
            },
            processing_profile,
        )?;
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
        let live_pcm_tap = LivePcmTap::default();
        let thread_sink = CaptureSink::Direct {
            store: store.clone(),
            recording_id: recording_id.clone(),
            live_pcm_tap: live_pcm_tap.clone(),
        };

        let join = thread::spawn(move || {
            let capture_stop = thread_stop.clone();
            let result = run_capture(
                thread_sink,
                CaptureDeviceSelection::Microphone(thread_device_selection),
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
            live_pcm_tap,
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
                "selectionResolution": runtime.selection_resolution,
                "reselectionRequired": runtime.reselection_required,
                "rawPathExposed": false
            },
            "rawPathExposed": false
        }))
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub fn start_system(
        &mut self,
        store: RecordingStore,
        params: CaptureStartParams,
    ) -> Result<Value, CaptureError> {
        self.start_system_with_processing_profile(store, params, None)
    }

    pub(crate) fn start_system_with_processing_profile(
        &mut self,
        store: RecordingStore,
        params: CaptureStartParams,
        processing_profile: Option<MeetingProcessingProfileSnapshot>,
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
        self.stop_microphone_probe_for_capture()?;

        let chunk_ms = params
            .chunk_ms
            .unwrap_or(DEFAULT_CAPTURE_CHUNK_MS)
            .clamp(MIN_CAPTURE_CHUNK_MS, MAX_CAPTURE_CHUNK_MS);
        let started = store.start_with_processing_profile(
            StartRecordingParams {
                label: params.label.clone(),
            },
            processing_profile,
        )?;
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
        let thread_device_selection = CaptureDeviceSelection::System(params.device_id.clone());
        let live_pcm_tap = LivePcmTap::default();
        let thread_sink = CaptureSink::Direct {
            store: store.clone(),
            recording_id: recording_id.clone(),
            live_pcm_tap: live_pcm_tap.clone(),
        };

        let join = thread::spawn(move || {
            let capture_stop = thread_stop.clone();
            let result = run_capture(
                thread_sink,
                thread_device_selection,
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
            live_pcm_tap,
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

    #[cfg(test)]
    #[allow(dead_code)]
    pub fn start_mic_and_system(
        &mut self,
        store: RecordingStore,
        params: CaptureStartMicAndSystemParams,
    ) -> Result<Value, CaptureError> {
        self.start_mic_and_system_with_processing_profile(store, params, None)
    }

    pub(crate) fn start_mic_and_system_with_processing_profile(
        &mut self,
        store: RecordingStore,
        params: CaptureStartMicAndSystemParams,
        processing_profile: Option<MeetingProcessingProfileSnapshot>,
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
        self.stop_microphone_probe_for_capture()?;

        let resolved_mic_device =
            self.microphone_device_selection(params.mic_device_id.as_deref())?;
        let chunk_ms = params
            .chunk_ms
            .unwrap_or(DEFAULT_CAPTURE_CHUNK_MS)
            .clamp(MIN_CAPTURE_CHUNK_MS, MAX_CAPTURE_CHUNK_MS);
        let started = store.start_with_processing_profile(
            StartRecordingParams {
                label: params.label.clone(),
            },
            processing_profile,
        )?;
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
        let live_pcm_tap = LivePcmTap::default();

        let writer_store = store.clone();
        let writer_recording_id = recording_id.clone();
        let writer_error = last_error.clone();
        let mut writer_join = Some(thread::spawn(move || {
            run_serialized_writer(writer_store, writer_recording_id, audio_rx, writer_error);
        }));

        let mut joins = Vec::new();
        for device_selection in [
            CaptureDeviceSelection::Microphone(resolved_mic_device),
            CaptureDeviceSelection::System(params.system_device_id.clone()),
        ] {
            let thread_stop = stop.clone();
            let thread_error = last_error.clone();
            let thread_ready = ready_tx.clone();
            let thread_audio = audio_tx.clone();
            let thread_live_pcm_tap = live_pcm_tap.clone();
            joins.push(thread::spawn(move || {
                let capture_stop = thread_stop.clone();
                let result = run_capture(
                    CaptureSink::Queue {
                        tx: thread_audio,
                        live_pcm_tap: thread_live_pcm_tap,
                    },
                    device_selection,
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
            live_pcm_tap,
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
        session.live_pcm_tap.detach_current();
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
                "selectionResolution": runtime.selection_resolution,
                "reselectionRequired": runtime.reselection_required,
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

fn run_microphone_probe(
    device_selection: MicrophoneDeviceSelection,
    stop: Arc<AtomicBool>,
    state: Arc<Mutex<MicrophoneProbeState>>,
    ready_tx: mpsc::Sender<Result<MicrophoneProbeRuntime, CaptureError>>,
) -> Result<MicrophoneProbeRunResult, CaptureError> {
    let host = cpal::default_host();
    let selected = select_input_device(&host, &device_selection)
        .map_err(|error| announce_microphone_probe_start_error(&ready_tx, error))?;
    if stop.load(Ordering::SeqCst) {
        return Ok(MicrophoneProbeRunResult::Stopped);
    }
    let SelectedInputDevice {
        device,
        device_label,
        supported,
        resolution,
        reselection_required,
    } = selected;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let sample_rate_hz = config.sample_rate.0;
    let channel_count = config.channels;
    if let Ok(mut probe_state) = state.lock() {
        probe_state.source_sample_rate_hz = sample_rate_hz;
        probe_state.source_channel_count = channel_count;
    }

    let error_state = state.clone();
    let error_stop = stop.clone();
    let err_fn = move |error: cpal::StreamError| {
        set_probe_error(
            &error_state,
            microphone_probe_access_error(
                "CAPTURE_MICROPHONE_DEVICE_DISCONNECTED",
                error.to_string(),
            ),
        );
        error_stop.store(true, Ordering::SeqCst);
    };
    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let callback_state = state.clone();
            let callback_stop = stop.clone();
            device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    process_probe_callback(&callback_state, &callback_stop, data, |sample| {
                        if sample.is_finite() {
                            *sample
                        } else {
                            0.0
                        }
                    });
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let callback_state = state.clone();
            let callback_stop = stop.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    process_probe_callback(&callback_state, &callback_stop, data, |sample| {
                        f32::from(*sample) / 32_768.0
                    });
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let callback_state = state.clone();
            let callback_stop = stop.clone();
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    process_probe_callback(&callback_state, &callback_stop, data, |sample| {
                        (f32::from(*sample) - 32_768.0) / 32_768.0
                    });
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I32 => {
            let callback_state = state.clone();
            let callback_stop = stop.clone();
            device.build_input_stream(
                &config,
                move |data: &[i32], _| {
                    process_probe_callback(&callback_state, &callback_stop, data, |sample| {
                        *sample as f32 / 2_147_483_648.0
                    });
                },
                err_fn,
                None,
            )
        }
        other => {
            let error = CaptureError::new(
                "CAPTURE_SAMPLE_FORMAT_UNSUPPORTED",
                format!("unsupported microphone test sample format: {other:?}"),
            );
            return Err(announce_microphone_probe_start_error(&ready_tx, error));
        }
    }
    .map_err(|error| {
        announce_microphone_probe_start_error(
            &ready_tx,
            microphone_probe_access_error("CAPTURE_STREAM_CREATE_FAILED", error.to_string()),
        )
    })?;

    if stop.load(Ordering::SeqCst) {
        drop(stream);
        return Ok(MicrophoneProbeRunResult::Stopped);
    }

    stream.play().map_err(|error| {
        announce_microphone_probe_start_error(
            &ready_tx,
            microphone_probe_access_error("CAPTURE_STREAM_PLAY_FAILED", error.to_string()),
        )
    })?;
    if stop.load(Ordering::SeqCst) {
        drop(stream);
        return Ok(MicrophoneProbeRunResult::Stopped);
    }
    ready_tx
        .send(Ok(MicrophoneProbeRuntime {
            device_label,
            sample_rate_hz,
            channel_count,
            selection_resolution: resolution,
            reselection_required,
        }))
        .ok();
    let capture_deadline = Instant::now() + Duration::from_secs(MIC_TEST_MAX_SECONDS as u64);
    while !stop.load(Ordering::SeqCst) && Instant::now() < capture_deadline {
        thread::sleep(CAPTURE_POLL_TIMEOUT);
    }
    if !stop.load(Ordering::SeqCst) {
        mark_probe_capture_complete(&state);
    }
    drop(stream);
    if stop.load(Ordering::SeqCst) {
        Ok(MicrophoneProbeRunResult::Stopped)
    } else {
        Ok(MicrophoneProbeRunResult::Completed)
    }
}

fn microphone_probe_access_error(
    fallback_code: &'static str,
    backend_message: impl Into<String>,
) -> CaptureError {
    let backend_message = backend_message.into();
    let normalized = backend_message.to_ascii_lowercase();
    let permission_denied = [
        "access is denied",
        "access denied",
        "permission denied",
        "not permitted",
        "not allowed",
        "e_accessdenied",
        "0x80070005",
    ]
    .iter()
    .any(|marker| normalized.contains(marker));
    if permission_denied {
        CaptureError::new(
            "CAPTURE_MICROPHONE_PERMISSION_DENIED",
            "microphone access is blocked by operating-system privacy settings",
        )
    } else {
        CaptureError::new(fallback_code, backend_message)
    }
}

fn announce_microphone_probe_start_error(
    ready_tx: &mpsc::Sender<Result<MicrophoneProbeRuntime, CaptureError>>,
    error: CaptureError,
) -> CaptureError {
    let _ = ready_tx.send(Err(CaptureError::new(error.code, error.message.clone())));
    error
}

fn process_probe_callback<T, F>(
    state: &Arc<Mutex<MicrophoneProbeState>>,
    stop: &Arc<AtomicBool>,
    data: &[T],
    sample_to_f32: F,
) where
    F: Fn(&T) -> f32,
{
    if stop.load(Ordering::SeqCst) {
        return;
    }
    if let Ok(mut state) = state.lock() {
        if !stop.load(Ordering::SeqCst) && !state.capture_complete {
            state.process_interleaved(data, sample_to_f32);
        }
    }
}

fn set_probe_error(state: &Arc<Mutex<MicrophoneProbeState>>, error: CaptureError) {
    if let Ok(mut state) = state.lock() {
        if state.last_error.is_none() {
            state.last_error = Some(error);
        }
    }
}

fn mark_probe_capture_complete(state: &Arc<Mutex<MicrophoneProbeState>>) {
    if let Ok(mut state) = state.lock() {
        state.capture_complete = true;
    }
}

fn clear_probe_state(state: &Arc<Mutex<MicrophoneProbeState>>) {
    if let Ok(mut state) = state.lock() {
        state.zero_and_reset();
    }
}

fn clear_probe_audio_state(state: &Arc<Mutex<MicrophoneProbeState>>) {
    if let Ok(mut state) = state.lock() {
        state.zero_audio_state();
    }
}

fn microphone_probe_status_value(probe: &MicrophoneProbe) -> Value {
    let runtime = probe.runtime.as_ref();
    let active = !probe.stop.load(Ordering::SeqCst)
        && probe.join.as_ref().is_some_and(|join| !join.is_finished());
    let (rms, peak, clipping, signal_detected, capture_complete, sample_count, last_error) = probe
        .state
        .lock()
        .map(|state| {
            (
                state.rms,
                state.peak,
                state.clipping,
                state.signal_detected,
                state.capture_complete,
                state.samples.len(),
                state.last_error.clone(),
            )
        })
        .unwrap_or((0.0, 0.0, false, false, false, 0, None));
    let signal_state = if clipping {
        "clipping"
    } else if signal_detected {
        "signal"
    } else {
        "silence"
    };
    let permission_denied = last_error
        .as_ref()
        .is_some_and(|error| error.code == "CAPTURE_MICROPHONE_PERMISSION_DENIED");
    let state = if permission_denied {
        "permission-denied"
    } else if last_error.is_some() {
        "device-disconnected"
    } else if capture_complete && signal_detected {
        "playback-ready"
    } else if capture_complete {
        "no-signal"
    } else if !active {
        "idle"
    } else if clipping {
        "clipping"
    } else if signal_detected {
        "signal-detected"
    } else {
        "listening"
    };
    let access_error = last_error.as_ref().map(|error| {
        if error.code == "CAPTURE_MICROPHONE_PERMISSION_DENIED" {
            json!({
                "code": "MICROPHONE_PERMISSION_DENIED",
                "message": "Microphone access is blocked by operating-system privacy settings"
            })
        } else {
            json!({
                "code": "MICROPHONE_DEVICE_DISCONNECTED",
                "message": "Microphone access ended because the device became unavailable"
            })
        }
    });
    json!({
        "implemented": true,
        "active": active,
        "state": state,
        "deviceLabel": runtime.map(|value| value.device_label.as_str()),
        "sourceSampleRateHz": runtime.map(|value| value.sample_rate_hz),
        "sourceChannelCount": runtime.map(|value| value.channel_count),
        "selectionResolution": runtime.map(|value| value.selection_resolution),
        "reselectionRequired": runtime.is_some_and(|value| value.reselection_required),
        "sampleRateHz": MIC_TEST_SAMPLE_RATE_HZ,
        "channelCount": 1,
        "rms": rms,
        "peak": peak,
        "clipping": clipping,
        "signalDetected": signal_detected,
        "signalState": signal_state,
        "captureComplete": capture_complete,
        "sampleCount": sample_count,
        "bufferedDurationMs": sample_count.saturating_mul(1000) / MIC_TEST_SAMPLE_RATE_HZ as usize,
        "durationMs": now_ms()
            .saturating_sub(probe.started_at_ms)
            .min((MIC_TEST_MAX_SECONDS * 1000) as u128) as u64,
        "maxDurationMs": MIC_TEST_MAX_SECONDS * 1000,
        "accessError": access_error,
        "lastError": last_error.as_ref().map(|error| {
            if error.code == "CAPTURE_MICROPHONE_PERMISSION_DENIED" {
                "microphone permission denied"
            } else {
                "microphone device became unavailable"
            }
        }),
        "ephemeral": true,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn inactive_microphone_probe_status_value() -> Value {
    json!({
        "implemented": true,
        "active": false,
        "state": "idle",
        "deviceLabel": null,
        "sourceSampleRateHz": null,
        "sourceChannelCount": null,
        "sampleRateHz": MIC_TEST_SAMPLE_RATE_HZ,
        "channelCount": 1,
        "rms": 0.0,
        "peak": 0.0,
        "clipping": false,
        "signalDetected": false,
        "signalState": "inactive",
        "captureComplete": false,
        "sampleCount": 0,
        "bufferedDurationMs": 0,
        "durationMs": 0,
        "maxDurationMs": MIC_TEST_MAX_SECONDS * 1000,
        "accessError": null,
        "lastError": null,
        "ephemeral": true,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn stopped_microphone_probe_status_value() -> Value {
    json!({
        "implemented": true,
        "active": false,
        "state": "idle",
        "stopped": true,
        "bufferCleared": true,
        "captureComplete": false,
        "sampleRateHz": MIC_TEST_SAMPLE_RATE_HZ,
        "channelCount": 1,
        "maxDurationMs": MIC_TEST_MAX_SECONDS * 1000,
        "accessError": null,
        "lastError": null,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn pcm16_mono_wav(samples: &[i16], sample_rate_hz: u32) -> Vec<u8> {
    let data_size = samples.len().saturating_mul(2).min(u32::MAX as usize) as u32;
    let mut wav = Vec::with_capacity(44_usize.saturating_add(data_size as usize));
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&36_u32.saturating_add(data_size).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate_hz.to_le_bytes());
    wav.extend_from_slice(&sample_rate_hz.saturating_mul(2).to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    for sample in samples.iter().take(data_size as usize / 2) {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

fn run_capture(
    sink: CaptureSink,
    device_selection: CaptureDeviceSelection,
    chunk_ms: u64,
    stop: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<CaptureRuntimeInfo, CaptureError>>,
) -> Result<(), CaptureError> {
    match device_selection {
        CaptureDeviceSelection::Microphone(selection) => run_cpal_capture(
            sink,
            CaptureDeviceSelection::Microphone(selection),
            CaptureSource::Mic,
            chunk_ms,
            stop,
            ready_tx,
        ),
        CaptureDeviceSelection::System(device_id) => {
            run_system_capture(sink, device_id, chunk_ms, stop, ready_tx)
        }
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
        CaptureDeviceSelection::System(device_id),
        CaptureSource::System,
        chunk_ms,
        stop,
        ready_tx,
    )
}

fn run_cpal_capture(
    sink: CaptureSink,
    device_selection: CaptureDeviceSelection,
    source: CaptureSource,
    chunk_ms: u64,
    stop: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<CaptureRuntimeInfo, CaptureError>>,
) -> Result<(), CaptureError> {
    let host = cpal::default_host();
    let (device, device_label, supported, selection_resolution, reselection_required) =
        match device_selection {
            CaptureDeviceSelection::Microphone(selection) => {
                let selected = select_input_device(&host, &selection)
                    .map_err(|error| announce_capture_start_error(&ready_tx, error))?;
                (
                    selected.device,
                    selected.device_label,
                    selected.supported,
                    Some(selected.resolution),
                    selected.reselection_required,
                )
            }
            CaptureDeviceSelection::System(device_id) => {
                let device = select_system_device(&host, device_id.as_deref())
                    .map_err(|error| announce_capture_start_error(&ready_tx, error))?;
                let device_label = device.name().unwrap_or_else(|_| "System audio".to_string());
                let supported = system_device_config(&device)
                    .map_err(|error| announce_capture_start_error(&ready_tx, error))?;
                (device, device_label, supported, None, false)
            }
        };
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
            selection_resolution,
            reselection_required,
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
    bytes: impl AsRef<[u8]>,
) -> Result<(), CaptureError> {
    store.write_audio_chunk(WriteAudioChunkParams {
        recording_id: recording_id.to_string(),
        channel: channel.to_string(),
        data_base64: BASE64_STANDARD.encode(bytes.as_ref()),
        sample_rate_hz,
        channel_count,
        bits_per_sample: 16,
        start_ms: Some(start_ms),
    })?;
    Ok(())
}

fn select_input_device(
    host: &cpal::Host,
    selection: &MicrophoneDeviceSelection,
) -> Result<SelectedInputDevice, CaptureError> {
    if matches!(selection, MicrophoneDeviceSelection::Default) {
        return select_default_input_device(host, "default", false);
    }

    let MicrophoneDeviceSelection::Preferred {
        fingerprint,
        saved_ordinal: _,
    } = selection
    else {
        unreachable!("default microphone selection returned above")
    };
    let devices = host
        .input_devices()
        .map_err(|error| CaptureError::new("CAPTURE_DEVICE_LIST_FAILED", error.to_string()))?;
    let mut matches = Vec::new();
    for (ordinal, device) in devices.enumerate() {
        let device_label = device.name().unwrap_or_else(|_| "Input device".to_string());
        let supported = device.default_input_config().ok();
        let (sample_rate_hz, channel_count, sample_format) = supported
            .as_ref()
            .map(|config| {
                (
                    config.sample_rate().0,
                    config.channels(),
                    format!("{:?}", config.sample_format()),
                )
            })
            .unwrap_or_else(|| (0, 0, "unknown".to_string()));
        if microphone_device_fingerprint(
            &device_label,
            sample_rate_hz,
            channel_count,
            &sample_format,
        ) == *fingerprint
        {
            matches.push((ordinal, device, device_label, supported));
        }
    }

    if matches.len() == 1 {
        let (_ordinal, device, device_label, supported) =
            matches.pop().expect("one matching microphone");
        let supported = supported.ok_or_else(|| {
            CaptureError::new(
                "CAPTURE_INPUT_CONFIG_UNAVAILABLE",
                "the selected microphone input configuration is unavailable",
            )
        })?;
        return Ok(SelectedInputDevice {
            device,
            device_label,
            supported,
            resolution: "fingerprint",
            reselection_required: false,
        });
    }

    select_default_input_device(
        host,
        if matches.is_empty() {
            "default-fallback"
        } else {
            "ambiguous-fingerprint"
        },
        true,
    )
}

fn select_default_input_device(
    host: &cpal::Host,
    resolution: &'static str,
    reselection_required: bool,
) -> Result<SelectedInputDevice, CaptureError> {
    let device = host.default_input_device().ok_or_else(|| {
        CaptureError::new(
            "CAPTURE_NO_DEFAULT_INPUT",
            "no default microphone input was found",
        )
    })?;
    let device_label = device.name().unwrap_or_else(|_| "Microphone".to_string());
    let supported = device.default_input_config().map_err(|error| {
        CaptureError::new("CAPTURE_INPUT_CONFIG_UNAVAILABLE", error.to_string())
    })?;
    Ok(SelectedInputDevice {
        device,
        device_label,
        supported,
        resolution,
        reselection_required,
    })
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
    input_device_identities()
        .unwrap_or_default()
        .into_iter()
        .map(|device| {
            let system_monitor_eligible =
                cfg!(target_os = "linux") && is_linux_monitor_device_name(&device.label);
            json!({
                "id": device.id,
                "label": device.label,
                "fingerprint": device.fingerprint,
                "ordinal": device.ordinal,
                "isDefault": device.is_default,
                "systemMonitorEligible": system_monitor_eligible,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            })
        })
        .collect()
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
                        "rawPathExposed": false,
                        "keyMaterialExposedToRenderer": false
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
        "flushBufferedAudioOnStop": true,
        "liveTranscriptObserver": {
            "queueCapacity": LIVE_PCM_QUEUE_CAPACITY,
            "overflow": "drop-newest-provisional-only",
            "durableCaptureAffected": false,
            "sourcePreference": "microphone-then-system",
            "memoryOnly": true
        }
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

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "candor-capture-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ))
    }

    fn input_identity(
        id: &str,
        label: &str,
        fingerprint: &str,
        ordinal: usize,
        is_default: bool,
    ) -> InputDeviceIdentity {
        InputDeviceIdentity {
            id: id.to_string(),
            label: label.to_string(),
            fingerprint: fingerprint.to_string(),
            ordinal,
            is_default,
        }
    }

    fn fake_microphone_probe(state: Arc<Mutex<MicrophoneProbeState>>) -> MicrophoneProbe {
        MicrophoneProbe {
            stop: Arc::new(AtomicBool::new(false)),
            join: Some(thread::spawn(|| {})),
            state,
            runtime: Some(MicrophoneProbeRuntime {
                device_label: "Synthetic microphone".to_string(),
                sample_rate_hz: 48_000,
                channel_count: 1,
                selection_resolution: "fingerprint",
                reselection_required: false,
            }),
            started_at_ms: now_ms(),
        }
    }

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
    fn microphone_fingerprint_is_normalized_and_configuration_sensitive() {
        let first = microphone_device_fingerprint("  USB   Microphone ", 48_000, 1, "F32");
        let normalized = microphone_device_fingerprint("usb microphone", 48_000, 1, "F32");
        let different_config = microphone_device_fingerprint("usb microphone", 44_100, 1, "F32");

        assert_eq!(first, normalized);
        assert_eq!(first.len(), 64);
        assert_ne!(first, different_config);
    }

    #[test]
    fn default_microphone_identity_is_marked_only_for_one_unique_fingerprint() {
        let mut devices = vec![
            input_identity("input-0", "USB microphone", "first", 0, true),
            input_identity("input-1", "USB microphone", "second", 1, true),
        ];

        mark_unique_default_input(&mut devices, Some("second"));
        assert!(!devices[0].is_default);
        assert!(devices[1].is_default);

        devices[0].fingerprint = "second".to_string();
        mark_unique_default_input(&mut devices, Some("second"));
        assert!(devices.iter().all(|device| !device.is_default));
    }

    #[test]
    fn microphone_preference_requires_a_unique_fingerprint_match() {
        let stored = StoredMicrophonePreference {
            schema_version: MICROPHONE_PREFERENCE_SCHEMA_VERSION,
            preferred_microphone: Some(StoredPreferredMicrophone {
                fingerprint: "preferred-fingerprint".to_string(),
                ordinal: 0,
            }),
        };
        let reordered = vec![
            input_identity("input-0", "Other", "other-fingerprint", 0, true),
            input_identity("input-1", "Preferred", "preferred-fingerprint", 1, false),
        ];
        let fingerprint_match = resolve_microphone_preference(&stored, &reordered);
        assert_eq!(fingerprint_match.device_id.as_deref(), Some("input-1"));
        assert_eq!(fingerprint_match.resolution, "fingerprint");

        let replaced = vec![input_identity(
            "input-0",
            "Replacement",
            "replacement-fingerprint",
            0,
            true,
        )];
        let replacement = resolve_microphone_preference(&stored, &replaced);
        assert_eq!(replacement.device_id, None);
        assert_eq!(replacement.device_label.as_deref(), Some("Replacement"));
        assert_eq!(replacement.resolution, "default-fallback");
        assert!(replacement.reselection_required);

        let duplicates = vec![
            input_identity("input-0", "Preferred A", "preferred-fingerprint", 0, true),
            input_identity("input-1", "Preferred B", "preferred-fingerprint", 1, false),
        ];
        let ambiguous = resolve_microphone_preference(&stored, &duplicates);
        assert_eq!(ambiguous.device_id, None);
        assert_eq!(ambiguous.device_label.as_deref(), Some("Preferred A"));
        assert_eq!(ambiguous.resolution, "ambiguous-fingerprint");
        assert!(ambiguous.reselection_required);
    }

    #[test]
    fn microphone_preference_recovers_after_hot_unplug_without_a_default_device() {
        let stored = StoredMicrophonePreference {
            schema_version: MICROPHONE_PREFERENCE_SCHEMA_VERSION,
            preferred_microphone: Some(StoredPreferredMicrophone {
                fingerprint: "preferred-fingerprint".to_string(),
                ordinal: 0,
            }),
        };

        let unplugged = resolve_microphone_preference(&stored, &[]);
        assert_eq!(unplugged.device_id, None);
        assert_eq!(unplugged.device_label, None);
        assert_eq!(unplugged.resolution, "unavailable");
        assert!(unplugged.reselection_required);

        let replacement_without_default = resolve_microphone_preference(
            &stored,
            &[input_identity(
                "input-0",
                "Replacement",
                "replacement-fingerprint",
                0,
                false,
            )],
        );
        assert_eq!(replacement_without_default.device_id, None);
        assert_eq!(replacement_without_default.device_label, None);
        assert_eq!(replacement_without_default.resolution, "default-fallback");
        assert!(replacement_without_default.reselection_required);

        let replugged = resolve_microphone_preference(
            &stored,
            &[input_identity(
                "input-1",
                "Preferred",
                "preferred-fingerprint",
                1,
                false,
            )],
        );
        assert_eq!(replugged.device_id.as_deref(), Some("input-1"));
        assert_eq!(replugged.device_label.as_deref(), Some("Preferred"));
        assert_eq!(replugged.resolution, "fingerprint");
        assert!(!replugged.reselection_required);
    }

    #[test]
    fn microphone_open_requests_bind_legacy_ordinals_to_the_saved_fingerprint() {
        let stored = StoredMicrophonePreference {
            schema_version: MICROPHONE_PREFERENCE_SCHEMA_VERSION,
            preferred_microphone: Some(StoredPreferredMicrophone {
                fingerprint: "preferred-fingerprint".to_string(),
                ordinal: 2,
            }),
        };
        let expected = MicrophoneDeviceSelection::Preferred {
            fingerprint: "preferred-fingerprint".to_string(),
            saved_ordinal: 2,
        };

        assert_eq!(
            microphone_device_selection(&stored, None).expect("preferred selection"),
            expected
        );
        assert_eq!(
            microphone_device_selection(&stored, Some("input-2"))
                .expect("legacy ordinal bound to stored identity"),
            expected
        );
        assert_eq!(
            microphone_device_selection(&stored, Some("default")).expect("explicit default"),
            MicrophoneDeviceSelection::Default
        );
        assert_eq!(
            microphone_device_selection(&stored, Some("input-1"))
                .expect_err("a reordered ordinal must not select another device")
                .code,
            "CAPTURE_DEVICE_IDENTITY_STALE"
        );
        assert_eq!(
            microphone_device_selection(&StoredMicrophonePreference::default(), Some("input-2"))
                .expect_err("an ordinal without a saved fingerprint must fail")
                .code,
            "CAPTURE_DEVICE_IDENTITY_REQUIRED"
        );
    }

    #[test]
    fn microphone_preference_round_trip_is_pathless_and_keyless() {
        let root = test_root("preference-round-trip");
        let fingerprint = "a".repeat(64);
        let stored = StoredMicrophonePreference {
            schema_version: MICROPHONE_PREFERENCE_SCHEMA_VERSION,
            preferred_microphone: Some(StoredPreferredMicrophone {
                fingerprint: fingerprint.clone(),
                ordinal: 3,
            }),
        };
        write_microphone_preference(&root, &stored).expect("persist microphone preference");
        let manager = CaptureManager::with_preferences_root(root.clone());
        assert_eq!(
            manager
                .load_microphone_preference()
                .expect("load microphone preference"),
            stored
        );
        let value = microphone_preference_status_value(
            &stored,
            &[input_identity(
                "input-3",
                "Synthetic",
                &fingerprint,
                3,
                true,
            )],
            "ready",
            None,
        );
        assert_eq!(value["preferredMicrophone"]["deviceId"], "input-3");
        assert_eq!(value["preferredMicrophone"]["ordinal"], 3);
        assert_eq!(value["rawPathExposed"], false);
        assert_eq!(value["keyMaterialExposedToRenderer"], false);
        assert!(!serde_json::to_string(&value)
            .expect("serialize preference status")
            .contains(root.to_string_lossy().as_ref()));
        drop(manager);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn microphone_preference_promotes_backup_after_interrupted_commit() {
        let root = test_root("preference-backup-promotion");
        let stored = StoredMicrophonePreference {
            schema_version: MICROPHONE_PREFERENCE_SCHEMA_VERSION,
            preferred_microphone: Some(StoredPreferredMicrophone {
                fingerprint: "b".repeat(64),
                ordinal: 2,
            }),
        };
        write_microphone_preference(&root, &stored).expect("persist microphone preference");
        fs::rename(
            root.join(MICROPHONE_PREFERENCE_FILE),
            root.join(MICROPHONE_PREFERENCE_BACKUP_FILE),
        )
        .expect("simulate interrupted commit");

        let manager = CaptureManager::with_preferences_root(root.clone());
        assert_eq!(manager.load_microphone_preference().unwrap(), stored);
        assert!(root.join(MICROPHONE_PREFERENCE_FILE).is_file());
        assert!(!root.join(MICROPHONE_PREFERENCE_BACKUP_FILE).exists());
        drop(manager);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn changing_microphone_preference_stops_and_zeroes_an_active_probe() {
        let root = test_root("preference-change-stops-probe");
        let state = Arc::new(Mutex::new(MicrophoneProbeState {
            samples: VecDeque::from([12_i16, -12_i16, 24_i16, -24_i16]),
            rms: 0.5,
            peak: 0.75,
            clipping: true,
            signal_detected: true,
            ..MicrophoneProbeState::default()
        }));
        let mut manager = CaptureManager {
            active: None,
            microphone_probe: Some(fake_microphone_probe(state.clone())),
            preferences_root: Some(root.clone()),
        };

        let status = manager
            .set_preferred_microphone(SetPreferredMicrophoneParams {
                device_id: "default".to_string(),
                fingerprint: None,
                ordinal: None,
            })
            .expect("change microphone preference");

        assert!(manager.microphone_probe.is_none());
        assert_eq!(status["configured"], false);
        let locked = state.lock().expect("probe state after preference change");
        assert!(locked.samples.is_empty());
        assert_eq!(locked.rms, 0.0);
        assert_eq!(locked.peak, 0.0);
        assert!(!locked.clipping);
        assert!(!locked.signal_detected);
        drop(locked);
        assert!(root.join(MICROPHONE_PREFERENCE_FILE).is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn microphone_probe_downmixes_to_a_bounded_sixteen_kilohertz_ring() {
        let mut state = MicrophoneProbeState {
            source_sample_rate_hz: 48_000,
            source_channel_count: 1,
            ..MicrophoneProbeState::default()
        };
        let six_seconds = vec![0.5_f32; 48_000 * 6];
        state.process_interleaved(&six_seconds, |sample| *sample);

        assert_eq!(state.samples.len(), MIC_TEST_MAX_SAMPLES);
        assert!((state.rms - 0.5).abs() < 0.001);
        assert!((state.peak - 0.5).abs() < 0.001);
        assert!(state.signal_detected);
        assert!(!state.clipping);

        state.process_interleaved(&[1.0_f32, 1.0, 1.0], |sample| *sample);
        assert!(state.clipping);
        assert_eq!(state.samples.len(), MIC_TEST_MAX_SAMPLES);
    }

    #[test]
    fn microphone_sample_is_bounded_wav_and_zero_clears_probe_memory() {
        let state = Arc::new(Mutex::new(MicrophoneProbeState::default()));
        {
            let mut locked = state.lock().expect("probe state");
            locked.samples = (0..MIC_TEST_MAX_SAMPLES)
                .map(|index| (index % i16::MAX as usize) as i16)
                .collect();
            locked.rms = 0.25;
            locked.peak = 0.75;
            locked.signal_detected = true;
        }
        let mut manager = CaptureManager {
            active: None,
            microphone_probe: Some(fake_microphone_probe(state.clone())),
            preferences_root: None,
        };

        let sample = manager.mic_test_sample().expect("microphone test sample");
        assert_eq!(sample["byteCount"], 44 + MIC_TEST_MAX_SAMPLES * 2);
        assert_eq!(sample["durationMs"], MIC_TEST_MAX_SECONDS * 1000);
        assert_eq!(sample["bufferCleared"], true);
        assert_eq!(sample["rawPathExposed"], false);
        assert_eq!(sample["keyMaterialExposedToRenderer"], false);
        let wav = BASE64_STANDARD
            .decode(sample["dataBase64"].as_str().expect("WAV base64"))
            .expect("decode WAV");
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert!(state
            .lock()
            .expect("cleared probe state")
            .samples
            .is_empty());

        {
            let mut locked = state.lock().expect("probe state before stop");
            locked.samples.extend([12_i16, -12_i16]);
            locked.clipping = true;
        }
        let stopped = manager.mic_test_stop().expect("stop microphone test");
        assert_eq!(stopped["bufferCleared"], true);
        let locked = state.lock().expect("probe state after stop");
        assert!(locked.samples.is_empty());
        assert_eq!(locked.rms, 0.0);
        assert!(!locked.clipping);
        drop(locked);
        let stopped_again = manager
            .mic_test_stop()
            .expect("idempotent microphone test stop");
        assert_eq!(stopped_again["state"], "idle");
        assert_eq!(stopped_again["bufferCleared"], true);
    }

    #[test]
    fn microphone_sample_playback_is_memory_only_and_consumes_the_buffer_once() {
        let root = test_root("memory-only-microphone-sample");
        fs::create_dir_all(&root).expect("create empty microphone test root");
        let state = Arc::new(Mutex::new(MicrophoneProbeState {
            samples: VecDeque::from([1_i16, -1_i16, 2_i16, -2_i16]),
            rms: 0.25,
            peak: 0.5,
            signal_detected: true,
            capture_complete: true,
            ..MicrophoneProbeState::default()
        }));
        let mut manager = CaptureManager {
            active: None,
            microphone_probe: Some(fake_microphone_probe(state.clone())),
            preferences_root: Some(root.clone()),
        };

        let first = manager
            .mic_test_sample()
            .expect("consume the in-memory microphone sample");
        assert_eq!(first["sampleCount"], 4);
        assert_eq!(first["byteCount"], 52);
        assert_eq!(first["bufferCleared"], true);

        let second = manager
            .mic_test_sample()
            .expect("a second read returns only an empty WAV");
        assert_eq!(second["sampleCount"], 0);
        assert_eq!(second["byteCount"], 44);
        assert!(state
            .lock()
            .expect("consumed microphone sample state")
            .samples
            .is_empty());
        assert_eq!(
            fs::read_dir(&root)
                .expect("inspect microphone test root")
                .count(),
            0,
            "microphone testing must not create a recording, temporary sample, or preference file",
        );

        manager
            .mic_test_stop()
            .expect("stop memory-only microphone test");
        assert_eq!(
            fs::read_dir(&root)
                .expect("inspect microphone test root after stop")
                .count(),
            0,
        );
        drop(manager);
        fs::remove_dir_all(root).expect("remove microphone test root");
    }

    #[test]
    fn timed_out_microphone_probe_blocks_capture_and_clears_samples_during_teardown() {
        let state = Arc::new(Mutex::new(MicrophoneProbeState {
            samples: VecDeque::from([12_i16, -12_i16]),
            rms: 0.25,
            peak: 0.75,
            signal_detected: true,
            ..MicrophoneProbeState::default()
        }));
        let release_stalled_backend = Arc::new(AtomicBool::new(false));
        let worker_release = release_stalled_backend.clone();
        let stalled_join = thread::spawn(move || {
            while !worker_release.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(5));
            }
        });
        let mut manager = CaptureManager {
            active: None,
            microphone_probe: Some(MicrophoneProbe {
                stop: Arc::new(AtomicBool::new(false)),
                join: Some(stalled_join),
                state: state.clone(),
                runtime: None,
                started_at_ms: now_ms(),
            }),
            preferences_root: None,
        };

        let error = manager
            .stop_microphone_probe_for_capture_with_timeout(Duration::from_millis(10))
            .expect_err("durable capture must remain blocked during native teardown");
        assert_eq!(error.code, "CAPTURE_MIC_TEST_STOP_TIMEOUT");
        let locked = state.lock().expect("probe state cleared before timeout");
        assert!(locked.samples.is_empty());
        assert_eq!(locked.rms, 0.0);
        assert!(!locked.signal_detected);
        drop(locked);
        assert!(manager.microphone_probe.is_some());
        assert!(manager
            .microphone_probe
            .as_ref()
            .expect("stopping probe retained")
            .stop
            .load(Ordering::SeqCst));

        release_stalled_backend.store(true, Ordering::SeqCst);
        let stopped = manager
            .mic_test_stop_with_timeout(Duration::from_secs(1))
            .expect("released backend joins on retry");
        assert_eq!(stopped["bufferCleared"], true);
        assert!(manager.microphone_probe.is_none());
    }

    #[test]
    fn stopped_or_completed_microphone_callback_cannot_accept_more_audio() {
        let state = Arc::new(Mutex::new(MicrophoneProbeState::default()));
        let stop = Arc::new(AtomicBool::new(true));
        process_probe_callback(&state, &stop, &[0.5_f32, -0.5_f32], |sample| *sample);
        assert!(state
            .lock()
            .expect("stopped probe state")
            .samples
            .is_empty());

        stop.store(false, Ordering::SeqCst);
        state
            .lock()
            .expect("completed probe state")
            .capture_complete = true;
        process_probe_callback(&state, &stop, &[0.5_f32, -0.5_f32], |sample| *sample);
        assert!(state
            .lock()
            .expect("completed probe state")
            .samples
            .is_empty());
    }

    #[test]
    fn microphone_permission_backend_errors_map_to_a_stable_pathless_code() {
        for message in [
            "IAudioClient failed: E_ACCESSDENIED",
            "backend failed with 0x80070005",
            "permission denied by privacy controls",
        ] {
            let error = microphone_probe_access_error("CAPTURE_STREAM_CREATE_FAILED", message);
            assert_eq!(error.code, "CAPTURE_MICROPHONE_PERMISSION_DENIED");
            assert_eq!(
                error.message,
                "microphone access is blocked by operating-system privacy settings"
            );
            assert!(!error.message.contains(message));
        }
        let other = microphone_probe_access_error(
            "CAPTURE_STREAM_CREATE_FAILED",
            "unsupported sample format",
        );
        assert_eq!(other.code, "CAPTURE_STREAM_CREATE_FAILED");
    }

    #[test]
    fn microphone_status_maps_stream_failure_to_bounded_disconnect_state() {
        let state = Arc::new(Mutex::new(MicrophoneProbeState {
            last_error: Some(CaptureError::new(
                "CAPTURE_MICROPHONE_DEVICE_DISCONNECTED",
                "vendor endpoint detail",
            )),
            ..MicrophoneProbeState::default()
        }));
        let mut probe = fake_microphone_probe(state);
        probe.stop.store(true, Ordering::SeqCst);
        if let Some(join) = probe.join.take() {
            join.join().expect("fake probe thread");
        }
        let status = microphone_probe_status_value(&probe);

        assert_eq!(status["active"], false);
        assert_eq!(status["state"], "device-disconnected");
        assert_eq!(
            status["accessError"]["code"],
            "MICROPHONE_DEVICE_DISCONNECTED"
        );
        let serialized = serde_json::to_string(&status).expect("serialize probe status");
        assert!(!serialized.contains("vendor endpoint detail"));
        assert_eq!(status["rawPathExposed"], false);
        assert_eq!(status["keyMaterialExposedToRenderer"], false);
    }

    #[test]
    fn microphone_status_preserves_mid_test_permission_denial_category() {
        let state = Arc::new(Mutex::new(MicrophoneProbeState {
            last_error: Some(CaptureError::new(
                "CAPTURE_MICROPHONE_PERMISSION_DENIED",
                "private backend detail",
            )),
            ..MicrophoneProbeState::default()
        }));
        let mut probe = fake_microphone_probe(state);
        probe.stop.store(true, Ordering::SeqCst);
        if let Some(join) = probe.join.take() {
            join.join().expect("fake probe thread");
        }
        let status = microphone_probe_status_value(&probe);
        assert_eq!(status["state"], "permission-denied");
        assert_eq!(
            status["accessError"]["code"],
            "MICROPHONE_PERMISSION_DENIED"
        );
        let serialized = serde_json::to_string(&status).expect("serialize permission status");
        assert!(!serialized.contains("private backend detail"));
    }

    #[test]
    fn microphone_status_distinguishes_silence_signal_clipping_and_playback_readiness() {
        let state = Arc::new(Mutex::new(MicrophoneProbeState::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let join = thread::spawn(move || {
            while !worker_stop.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(1));
            }
        });
        let manager = CaptureManager {
            active: None,
            microphone_probe: Some(MicrophoneProbe {
                stop,
                join: Some(join),
                state: state.clone(),
                runtime: Some(MicrophoneProbeRuntime {
                    device_label: "Synthetic microphone".to_string(),
                    sample_rate_hz: 48_000,
                    channel_count: 1,
                    selection_resolution: "fingerprint",
                    reselection_required: false,
                }),
                started_at_ms: now_ms(),
            }),
            preferences_root: None,
        };

        let silent = manager.mic_test_status();
        assert_eq!(silent["state"], "listening");
        assert_eq!(silent["signalState"], "silence");

        {
            let mut locked = state.lock().expect("signal probe state");
            locked.rms = 0.2;
            locked.peak = 0.5;
            locked.signal_detected = true;
        }
        let signal = manager.mic_test_status();
        assert_eq!(signal["state"], "signal-detected");
        assert_eq!(signal["signalState"], "signal");

        state.lock().expect("clipping probe state").clipping = true;
        let clipping = manager.mic_test_status();
        assert_eq!(clipping["state"], "clipping");
        assert_eq!(clipping["signalState"], "clipping");

        {
            let mut locked = state.lock().expect("complete silent probe state");
            locked.rms = 0.0;
            locked.peak = 0.0;
            locked.clipping = false;
            locked.signal_detected = false;
            locked.capture_complete = true;
        }
        assert_eq!(manager.mic_test_status()["state"], "no-signal");

        state
            .lock()
            .expect("complete signal probe state")
            .signal_detected = true;
        assert_eq!(manager.mic_test_status()["state"], "playback-ready");

        drop(manager);
    }

    #[test]
    fn microphone_worker_clears_audio_but_preserves_terminal_device_error_until_stop() {
        let state = Arc::new(Mutex::new(MicrophoneProbeState {
            samples: VecDeque::from([12_i16, -12_i16]),
            rms: 0.25,
            peak: 0.75,
            clipping: true,
            signal_detected: true,
            last_error: Some(CaptureError::new(
                "CAPTURE_MICROPHONE_DEVICE_DISCONNECTED",
                "private backend detail",
            )),
            ..MicrophoneProbeState::default()
        }));

        clear_probe_audio_state(&state);
        {
            let locked = state.lock().expect("terminal probe state");
            assert!(locked.samples.is_empty());
            assert_eq!(locked.rms, 0.0);
            assert_eq!(locked.peak, 0.0);
            assert!(!locked.clipping);
            assert!(!locked.signal_detected);
            assert_eq!(
                locked
                    .last_error
                    .as_ref()
                    .map(|error| error.message.as_str()),
                Some("private backend detail")
            );
        }

        clear_probe_state(&state);
        assert!(state
            .lock()
            .expect("explicitly stopped probe")
            .last_error
            .is_none());
    }

    #[test]
    fn microphone_probe_is_cleared_before_capture_and_test_is_denied_during_capture() {
        let state = Arc::new(Mutex::new(MicrophoneProbeState::default()));
        let mut manager = CaptureManager {
            active: None,
            microphone_probe: Some(fake_microphone_probe(state.clone())),
            preferences_root: None,
        };
        manager
            .stop_microphone_probe_for_capture()
            .expect("real capture start clears the probe first");
        assert!(manager.microphone_probe.is_none());
        assert!(state
            .lock()
            .expect("cleared probe state")
            .samples
            .is_empty());

        let mut active_manager = CaptureManager {
            active: Some(CaptureSession {
                recording_id: "synthetic-active".to_string(),
                stop: Arc::new(AtomicBool::new(false)),
                joins: Vec::new(),
                writer_join: None,
                runtimes: Vec::new(),
                last_error: Arc::new(Mutex::new(None)),
                live_pcm_tap: LivePcmTap::default(),
                started_at_ms: now_ms(),
            }),
            microphone_probe: None,
            preferences_root: None,
        };
        let error = active_manager
            .mic_test_start(MicTestStartParams { device_id: None })
            .expect_err("microphone test must not start during durable capture");
        assert_eq!(error.code, "CAPTURE_ALREADY_ACTIVE");
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
    fn live_pcm_tap_is_single_consumer_bounded_and_drops_newest_only() {
        let tap = LivePcmTap::default();
        let subscription = tap.attach(LivePcmSourceSet::Mic).expect("attach live tap");
        assert_eq!(subscription.selected_sources, "mic");
        assert!(!subscription.combines_sources());
        assert_eq!(
            tap.attach(LivePcmSourceSet::Mic).unwrap_err().code,
            "LIVE_TRANSCRIPT_TAP_ACTIVE"
        );

        tap.publish(CaptureSource::System, 48_000, 1, 0, vec![9, 9]);
        for index in 0..=LIVE_PCM_QUEUE_CAPACITY {
            tap.publish(
                CaptureSource::Mic,
                48_000,
                1,
                index as u64 * 500,
                vec![index as u8, 0],
            );
        }

        assert_eq!(subscription.dropped_chunk_count(), 1);
        let received = (0..LIVE_PCM_QUEUE_CAPACITY)
            .map(|_| subscription.receiver.try_recv().expect("queued live PCM"))
            .collect::<Vec<_>>();
        assert!(received
            .iter()
            .all(|chunk| chunk.source == CaptureSource::Mic));
        assert_eq!(received[0].start_ms, 0);
        assert_eq!(
            received.last().expect("last retained chunk").start_ms,
            (LIVE_PCM_QUEUE_CAPACITY as u64 - 1) * 500
        );
        assert!(subscription.receiver.try_recv().is_err());

        subscription.detach();
        tap.publish(CaptureSource::Mic, 48_000, 1, 9_000, vec![1, 0]);
        assert!(subscription.receiver.try_recv().is_err());
    }

    #[test]
    fn combined_live_pcm_subscription_accepts_both_tagged_sources() {
        let tap = LivePcmTap::default();
        let subscription = tap
            .attach(LivePcmSourceSet::MicAndSystem)
            .expect("attach combined live tap");
        assert_eq!(subscription.selected_sources, "mic+system");
        assert!(subscription.combines_sources());

        tap.publish(CaptureSource::Mic, 16_000, 1, 0, vec![1, 0]);
        tap.publish(CaptureSource::System, 16_000, 1, 0, vec![2, 0]);

        let microphone = subscription.receiver.try_recv().expect("microphone chunk");
        let system = subscription.receiver.try_recv().expect("system chunk");
        assert_eq!(microphone.source, CaptureSource::Mic);
        assert_eq!(microphone.bytes, vec![1, 0]);
        assert_eq!(system.source, CaptureSource::System);
        assert_eq!(system.bytes, vec![2, 0]);
    }

    #[test]
    fn combined_capture_manager_selects_both_live_pcm_sources() {
        let tap = LivePcmTap::default();
        let runtime = |source| CaptureRuntimeInfo {
            source,
            device_label: source.to_string(),
            sample_rate_hz: 16_000,
            channel_count: 1,
            chunk_ms: 500,
            selection_resolution: None,
            reselection_required: false,
        };
        let manager = CaptureManager {
            active: Some(CaptureSession {
                recording_id: "combined-live".to_string(),
                stop: Arc::new(AtomicBool::new(false)),
                joins: Vec::new(),
                writer_join: None,
                runtimes: vec![runtime("mic"), runtime("system")],
                last_error: Arc::new(Mutex::new(None)),
                live_pcm_tap: tap.clone(),
                started_at_ms: now_ms(),
            }),
            microphone_probe: None,
            preferences_root: None,
        };

        let subscription = manager
            .subscribe_live_pcm("combined-live")
            .expect("combined subscription");
        assert!(subscription.combines_sources());
        tap.publish(CaptureSource::Mic, 16_000, 1, 0, vec![1, 0]);
        tap.publish(CaptureSource::System, 16_000, 1, 0, vec![2, 0]);
        assert_eq!(
            subscription.receiver.try_recv().unwrap().source,
            CaptureSource::Mic
        );
        assert_eq!(
            subscription.receiver.try_recv().unwrap().source,
            CaptureSource::System
        );

        manager.request_stop();
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
    fn active_session_status_reports_monotonic_elapsed_duration() {
        let manager = CaptureManager {
            active: Some(CaptureSession {
                recording_id: "timer-regression".to_string(),
                stop: Arc::new(AtomicBool::new(false)),
                joins: Vec::new(),
                writer_join: None,
                runtimes: Vec::new(),
                last_error: Arc::new(Mutex::new(None)),
                live_pcm_tap: LivePcmTap::default(),
                started_at_ms: now_ms().saturating_sub(1_000),
            }),
            microphone_probe: None,
            preferences_root: None,
        };

        let first = active_session_status(manager.active.as_ref().expect("active session"))
            ["durationMs"]
            .as_u64()
            .expect("active capture duration");
        thread::sleep(Duration::from_millis(2));
        let second = active_session_status(manager.active.as_ref().expect("active session"))
            ["durationMs"]
            .as_u64()
            .expect("updated active capture duration");

        assert!(first >= 1_000);
        assert!(second >= first);
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
                live_pcm_tap: LivePcmTap::default(),
                started_at_ms: now_ms(),
            }),
            microphone_probe: None,
            preferences_root: None,
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
        assert_eq!(policy["liveTranscriptObserver"]["queueCapacity"], 4);
        assert_eq!(
            policy["liveTranscriptObserver"]["overflow"],
            "drop-newest-provisional-only"
        );
        assert_eq!(
            policy["liveTranscriptObserver"]["durableCaptureAffected"],
            false
        );
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
