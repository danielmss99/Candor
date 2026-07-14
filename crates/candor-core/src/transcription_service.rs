use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::local_model_scheduler::{
    LocalModelJobKind, LocalModelScheduler, LocalModelSchedulerError,
};
use crate::model_manager;
use crate::model_manager::{ModelManager, ModelManagerError};
use crate::recording_store::{
    ExportRecordingParams, RecordingIdParams, RecordingStore, RecordingStoreError,
    StartRecordingParams, WriteAudioChunkParams, WriteTranscriptSegmentParams,
};
use crate::terminology_dictionary::{TerminologyError, TerminologyService};
use crate::transcription_quality::{
    TranscriptionBenchmarkMeasurement, TranscriptionBenchmarkParams, TranscriptionBenchmarkTier,
    TranscriptionQualityError, TranscriptionQualityService, TranscriptionQualityUpdateParams,
};

#[cfg(feature = "local-whisper")]
use crate::recording_store::PcmTrack;

#[cfg(feature = "local-whisper")]
struct WhisperTrackRequest<'a> {
    recording_id: &'a str,
    model_id: &'a str,
    language: &'a str,
    initial_prompt: Option<&'a str>,
}

const WHISPER_SAMPLE_RATE: u32 = 16_000;
#[cfg(feature = "local-whisper")]
const BENCHMARK_AUDIO_SECONDS: u32 = 30;

#[derive(Clone, Debug)]
pub struct WhisperBenchmarkMeasurement {
    pub real_time_factor: f64,
    pub model_sha256: String,
}

fn ensure_transcription_not_cancelled(
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<(), TranscriptionError> {
    if cancellation.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_CANCELLED",
            "local transcription was cancelled",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;

    #[test]
    fn cancellation_is_rejected_before_whisper_startup() {
        let cancellation = Arc::new(AtomicBool::new(true));
        let error = ensure_transcription_not_cancelled(Some(&cancellation))
            .expect_err("cancelled transcription");
        assert_eq!(error.code, "TRANSCRIPTION_CANCELLED");
    }
}

#[derive(Debug)]
pub struct TranscriptionError {
    pub code: &'static str,
    pub message: String,
}

impl TranscriptionError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<RecordingStoreError> for TranscriptionError {
    fn from(error: RecordingStoreError) -> Self {
        Self::new(error.code, error.message)
    }
}

impl From<ModelManagerError> for TranscriptionError {
    fn from(error: ModelManagerError) -> Self {
        Self::new(error.code, error.message)
    }
}

impl From<LocalModelSchedulerError> for TranscriptionError {
    fn from(error: LocalModelSchedulerError) -> Self {
        Self::new(error.code, error.message)
    }
}

impl From<TranscriptionQualityError> for TranscriptionError {
    fn from(error: TranscriptionQualityError) -> Self {
        Self::new(error.code, error.message)
    }
}

impl From<TerminologyError> for TranscriptionError {
    fn from(error: TerminologyError) -> Self {
        Self::new(error.code, error.message)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptionRunLocalParams {
    pub recording_id: String,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionProofParams {
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Clone)]
pub struct TranscriptionService {
    quality: TranscriptionQualityService,
    terminology: TerminologyService,
}

impl TranscriptionService {
    pub fn with_quality_and_terminology(
        root: std::path::PathBuf,
        terminology: TerminologyService,
    ) -> Self {
        Self {
            quality: TranscriptionQualityService::with_root(root),
            terminology,
        }
    }

    pub fn quality_status(&self) -> Value {
        self.quality.status()
    }

    pub fn update_quality(
        &self,
        params: TranscriptionQualityUpdateParams,
    ) -> Result<Value, TranscriptionQualityError> {
        self.quality.update(params)
    }

    pub fn benchmark_whisper_cancellable(
        &self,
        store: &RecordingStore,
        scheduler: &mut LocalModelScheduler,
        model_manager: &ModelManager,
        params: TranscriptionBenchmarkParams,
        cancellation: Arc<AtomicBool>,
    ) -> Result<WhisperBenchmarkMeasurement, TranscriptionError> {
        ensure_transcription_not_cancelled(Some(&cancellation))?;
        let job_id = scheduler.start_job(LocalModelJobKind::Whisper, "quality-benchmark")?;
        #[cfg(feature = "local-whisper")]
        let result = run_whisper_benchmark(store, model_manager, params.tier, Some(cancellation));
        #[cfg(not(feature = "local-whisper"))]
        let result = {
            let _ = (store, model_manager, params, cancellation);
            Err(TranscriptionError::new(
                "TRANSCRIPTION_BENCHMARK_ENGINE_UNAVAILABLE",
                "the packaged local Whisper runtime is unavailable",
            ))
        };
        scheduler.finish_job(job_id);
        result
    }

    pub fn record_quality_benchmark(
        &self,
        measurement: TranscriptionBenchmarkMeasurement,
    ) -> Result<Value, TranscriptionQualityError> {
        self.quality.record_benchmark(measurement)
    }

    pub fn record_quality_benchmark_failure(
        &self,
        tier: TranscriptionBenchmarkTier,
        failure_code: &'static str,
    ) -> Result<(), TranscriptionQualityError> {
        self.quality.record_benchmark_failure(tier, failure_code)
    }

    pub fn status(
        &self,
        store: &RecordingStore,
        scheduler: &LocalModelScheduler,
        model_manager: &ModelManager,
    ) -> Value {
        let scheduler_status = scheduler.status();
        let model_status = model_manager.status(store);
        json!({
            "implemented": true,
            "active": scheduler_status
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            "localOnly": true,
            "cloudAi": false,
            "engine": "whisper-rs",
            "whisperFeatureEnabled": cfg!(feature = "local-whisper"),
            "defaultModelId": model_manager.selected_default_model_id(),
            "modelIds": model_manager::valid_model_ids(),
            "modelRootKind": store.root_kind(),
            "bundledDefaultsSupported": true,
            "bundledAssets": model_status.get("bundledAssets").cloned().unwrap_or(Value::Null),
            "modelPathAcceptedFromRenderer": false,
            "recordingInput": "recordingId+optionalChannel+advancedModelOverride",
            "userPromptInputAccepted": false,
            "terminologyContext": "automatic-local-dictionary-selection",
            "acceptedAudioFormat": "pcm_s16le",
            "targetSampleRateHz": WHISPER_SAMPLE_RATE,
            "scheduler": scheduler_status,
            "quality": self.quality.status(),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    pub fn run_local(
        &mut self,
        store: &RecordingStore,
        scheduler: &mut LocalModelScheduler,
        model_manager: &ModelManager,
        params: TranscriptionRunLocalParams,
    ) -> Result<Value, TranscriptionError> {
        let job_id = scheduler.start_job(LocalModelJobKind::Whisper, "transcription.runLocal")?;
        let result = self.run_local_inner(store, model_manager, params, None);
        scheduler.finish_job(job_id);
        result
    }

    pub fn run_local_cancellable(
        &mut self,
        store: &RecordingStore,
        scheduler: &mut LocalModelScheduler,
        model_manager: &ModelManager,
        params: TranscriptionRunLocalParams,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Value, TranscriptionError> {
        let job_id = scheduler.start_job(LocalModelJobKind::Whisper, "transcription.runLocal")?;
        let result = self.run_local_inner(store, model_manager, params, Some(cancellation));
        scheduler.finish_job(job_id);
        result
    }

    fn run_local_inner(
        &self,
        store: &RecordingStore,
        model_manager: &ModelManager,
        params: TranscriptionRunLocalParams,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<Value, TranscriptionError> {
        ensure_transcription_not_cancelled(cancellation.as_ref())?;
        let quality = self.quality.resolve()?;
        let model_id = match params.model_id {
            Some(model_id) => model_manager.resolve_model_id(Some(model_id))?,
            None => quality.model_id.to_string(),
        };
        let language = quality.language_preference.whisper_language().to_string();
        let initial_prompt = self
            .terminology
            .whisper_prompt(store, &params.recording_id)?;
        let channel = normalize_optional_channel(params.channel)?;
        let track = store.pcm_track_for_transcription(&params.recording_id, channel.as_deref())?;

        #[cfg(feature = "local-whisper")]
        {
            let mut result = run_whisper_track(
                store,
                model_manager,
                WhisperTrackRequest {
                    recording_id: &params.recording_id,
                    model_id: &model_id,
                    language: &language,
                    initial_prompt: initial_prompt.as_deref(),
                },
                track,
                cancellation,
            )?;
            if let Some(object) = result.as_object_mut() {
                object.insert(
                    "qualityTier".to_string(),
                    Value::String(quality.tier.id().to_string()),
                );
                object.insert(
                    "qualityFallbackApplied".to_string(),
                    Value::Bool(quality.fallback_applied),
                );
                object.insert(
                    "qualityGuardReason".to_string(),
                    quality
                        .guard_reason
                        .map(|reason| Value::String(reason.to_string()))
                        .unwrap_or(Value::Null),
                );
                object.insert(
                    "terminologyContextApplied".to_string(),
                    Value::Bool(initial_prompt.is_some()),
                );
                object.insert("userPromptAccepted".to_string(), Value::Bool(false));
            }
            Ok(result)
        }

        #[cfg(not(feature = "local-whisper"))]
        {
            let _ = (
                language,
                initial_prompt,
                track,
                model_manager,
                quality,
                cancellation,
            );
            Err(TranscriptionError::new(
                "TRANSCRIPTION_ENGINE_UNAVAILABLE",
                format!(
                    "local Whisper is not enabled in this candor-core build; rebuild with the local-whisper feature to transcribe with {model_id}"
                ),
            ))
        }
    }

    pub fn proof_synthetic(
        &self,
        store: &RecordingStore,
        params: TranscriptionProofParams,
    ) -> Result<Value, TranscriptionError> {
        let started = store.start(StartRecordingParams {
            label: Some(
                params
                    .label
                    .unwrap_or_else(|| "transcription synthetic proof".to_string()),
            ),
        })?;
        let recording_id = started["recordingId"]
            .as_str()
            .ok_or_else(|| {
                TranscriptionError::new(
                    "TRANSCRIPTION_RECORDING_ID_MISSING",
                    "recording start did not return an id",
                )
            })?
            .to_string();

        write_pcm_chunk(store, &recording_id, "mic", 0, vec![0_u8; 9_600])?;
        write_pcm_chunk(store, &recording_id, "system", 100, vec![1_u8; 9_600])?;

        store.write_transcript_segment(WriteTranscriptSegmentParams {
            recording_id: recording_id.clone(),
            channel: "mic".to_string(),
            speaker: Some("Me".to_string()),
            text: "Local transcription proof created this synced segment.".to_string(),
            start_ms: 0,
            duration_ms: Some(900),
            end_ms: None,
            confidence: Some(0.99),
        })?;
        store.write_transcript_segment(WriteTranscriptSegmentParams {
            recording_id: recording_id.clone(),
            channel: "system".to_string(),
            speaker: Some("Them".to_string()),
            text: "System audio stays local and pathless.".to_string(),
            start_ms: 900,
            duration_ms: Some(1_100),
            end_ms: None,
            confidence: Some(0.98),
        })?;

        let finished = store.finish(RecordingIdParams {
            recording_id: recording_id.clone(),
        })?;
        let transcript = store.transcript(RecordingIdParams {
            recording_id: recording_id.clone(),
        })?;
        let replay = store.replay_manifest(RecordingIdParams {
            recording_id: recording_id.clone(),
        })?;
        let export = store.export_create(ExportRecordingParams {
            recording_id: recording_id.clone(),
            format: "markdown".to_string(),
            channel: None,
            report: None,
            options: Default::default(),
        })?;

        Ok(json!({
            "recording": finished,
            "transcript": transcript,
            "replay": replay,
            "export": {
                "format": export.get("format").cloned().unwrap_or(Value::Null),
                "bytes": export.get("bytes").cloned().unwrap_or(Value::Null),
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            },
            "proof": {
                "synthetic": true,
                "engine": "synthetic-proof",
                "whisperRan": false,
                "syncedTranscriptSegments": true,
                "localOnly": true,
                "cloudAi": false,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            },
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }
}

#[cfg(feature = "local-whisper")]
fn run_whisper_benchmark(
    store: &RecordingStore,
    model_manager: &ModelManager,
    tier: TranscriptionBenchmarkTier,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<WhisperBenchmarkMeasurement, TranscriptionError> {
    use std::time::Instant;
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    ensure_transcription_not_cancelled(cancellation.as_ref())?;
    let verified_model = model_manager.verified_model_path(store, tier.model_id())?;
    let audio = deterministic_benchmark_audio();
    let context =
        WhisperContext::new_with_params(&verified_model.path, WhisperContextParameters::default())
            .map_err(|_| {
                TranscriptionError::new(
            "TRANSCRIPTION_BENCHMARK_MODEL_LOAD_FAILED",
            "the verified local Whisper model could not be loaded for the performance check",
        )
            })?;
    let mut state = context.create_state().map_err(|_| {
        TranscriptionError::new(
            "TRANSCRIPTION_BENCHMARK_ENGINE_FAILED",
            "the local Whisper performance check could not initialize",
        )
    })?;
    let mut whisper_params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    whisper_params.set_n_threads(
        std::thread::available_parallelism()
            .map(|count| count.get() as i32)
            .unwrap_or(4),
    );
    whisper_params.set_language(Some("en"));
    whisper_params.set_translate(false);
    whisper_params.set_print_special(false);
    whisper_params.set_print_progress(false);
    whisper_params.set_print_realtime(false);
    whisper_params.set_print_timestamps(false);
    whisper_params.set_tdrz_enable(false);
    if let Some(cancellation) = cancellation.clone() {
        let abort_callback: Box<dyn FnMut() -> bool> =
            Box::new(move || cancellation.load(Ordering::SeqCst));
        whisper_params.set_abort_callback_safe::<_, Box<dyn FnMut() -> bool>>(Some(abort_callback));
    }

    let started = Instant::now();
    if state.full(whisper_params, &audio).is_err() {
        ensure_transcription_not_cancelled(cancellation.as_ref())?;
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_BENCHMARK_ENGINE_FAILED",
            "the local Whisper performance check did not complete",
        ));
    }
    ensure_transcription_not_cancelled(cancellation.as_ref())?;
    let elapsed_seconds = started.elapsed().as_secs_f64();
    let real_time_factor = elapsed_seconds / f64::from(BENCHMARK_AUDIO_SECONDS);
    if !real_time_factor.is_finite() || real_time_factor <= 0.0 {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_BENCHMARK_MEASUREMENT_INVALID",
            "the local Whisper performance check returned an invalid measurement",
        ));
    }
    Ok(WhisperBenchmarkMeasurement {
        real_time_factor,
        model_sha256: verified_model.sha256,
    })
}

#[cfg(feature = "local-whisper")]
fn deterministic_benchmark_audio() -> Vec<f32> {
    let sample_count = WHISPER_SAMPLE_RATE as usize * BENCHMARK_AUDIO_SECONDS as usize;
    let mut seed = 0x43_41_4e_44_u32;
    (0..sample_count)
        .map(|index| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = ((seed >> 8) as f32 / 16_777_215.0) * 2.0 - 1.0;
            let seconds = index as f32 / WHISPER_SAMPLE_RATE as f32;
            let carrier = (seconds * 2.0 * std::f32::consts::PI * 173.0).sin();
            let envelope = 0.25 + 0.75 * (seconds * 2.0 * std::f32::consts::PI * 3.0).sin().abs();
            (carrier * 0.012 + noise * 0.004) * envelope
        })
        .collect()
}

fn write_pcm_chunk(
    store: &RecordingStore,
    recording_id: &str,
    channel: &str,
    start_ms: u64,
    bytes: Vec<u8>,
) -> Result<(), TranscriptionError> {
    store.write_audio_chunk(WriteAudioChunkParams {
        recording_id: recording_id.to_string(),
        channel: channel.to_string(),
        data_base64: BASE64_STANDARD.encode(bytes),
        sample_rate_hz: 48_000,
        channel_count: 1,
        bits_per_sample: 16,
        start_ms: Some(start_ms),
    })?;
    Ok(())
}

fn normalize_optional_channel(value: Option<String>) -> Result<Option<String>, TranscriptionError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let channel = value.trim();
    let valid = !channel.is_empty()
        && channel.len() <= 32
        && channel
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(Some(channel.to_string()))
    } else {
        Err(TranscriptionError::new(
            "TRANSCRIPTION_CHANNEL_INVALID",
            "transcription channel must be ASCII alphanumeric, dash, or underscore",
        ))
    }
}

#[cfg(feature = "local-whisper")]
fn run_whisper_track(
    store: &RecordingStore,
    model_manager: &ModelManager,
    request: WhisperTrackRequest<'_>,
    track: PcmTrack,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<Value, TranscriptionError> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    let WhisperTrackRequest {
        recording_id,
        model_id,
        language,
        initial_prompt,
    } = request;

    let verified_model = model_manager.verified_model_path(store, model_id)?;
    let audio = pcm16le_to_mono_16k(&track)?;
    if audio.is_empty() {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_AUDIO_EMPTY",
            "recording audio had no samples to transcribe",
        ));
    }

    let ctx =
        WhisperContext::new_with_params(&verified_model.path, WhisperContextParameters::default())
            .map_err(|err| {
                TranscriptionError::new("TRANSCRIPTION_MODEL_LOAD_FAILED", err.to_string())
            })?;
    let mut state = ctx
        .create_state()
        .map_err(|err| TranscriptionError::new("TRANSCRIPTION_ENGINE_FAILED", err.to_string()))?;

    let mut whisper_params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let threads = std::thread::available_parallelism()
        .map(|count| count.get() as i32)
        .unwrap_or(4);
    whisper_params.set_n_threads(threads);
    if language == "auto" {
        whisper_params.set_language(None);
    } else {
        whisper_params.set_language(Some(language));
    }
    whisper_params.set_translate(false);
    whisper_params.set_print_special(false);
    whisper_params.set_print_progress(false);
    whisper_params.set_print_realtime(false);
    whisper_params.set_print_timestamps(false);
    whisper_params.set_tdrz_enable(false);
    if let Some(prompt) = initial_prompt {
        whisper_params.set_initial_prompt(prompt);
    }

    if let Some(cancellation) = cancellation.clone() {
        let abort_callback: Box<dyn FnMut() -> bool> =
            Box::new(move || cancellation.load(Ordering::SeqCst));
        whisper_params.set_abort_callback_safe::<_, Box<dyn FnMut() -> bool>>(Some(abort_callback));
    }

    if let Err(error) = state.full(whisper_params, &audio) {
        ensure_transcription_not_cancelled(cancellation.as_ref())?;
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_ENGINE_FAILED",
            error.to_string(),
        ));
    }
    ensure_transcription_not_cancelled(cancellation.as_ref())?;

    let speaker = speaker_for_channel(&track.channel);
    let mut written_segments = 0_u64;
    let n = state.full_n_segments();
    for i in 0..n {
        let Some(segment) = state.get_segment(i) else {
            continue;
        };
        let text = segment
            .to_str_lossy()
            .map(|text| text.trim().to_string())
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        let start_ms = centiseconds_to_ms(segment.start_timestamp());
        let end_ms = centiseconds_to_ms(segment.end_timestamp()).max(start_ms.saturating_add(1));
        store.write_transcript_segment(WriteTranscriptSegmentParams {
            recording_id: recording_id.to_string(),
            channel: track.channel.clone(),
            speaker: speaker.clone(),
            text,
            start_ms,
            duration_ms: Some(end_ms.saturating_sub(start_ms)),
            end_ms: None,
            confidence: None,
        })?;
        written_segments += 1;
    }

    let transcript = store.transcript(RecordingIdParams {
        recording_id: recording_id.to_string(),
    })?;
    Ok(json!({
        "recordingId": recording_id,
        "engine": "whisper-rs",
        "model": verified_model.public_value(),
        "language": language,
        "channel": track.channel,
        "audioDurationMs": track.duration_ms,
        "targetSampleRateHz": WHISPER_SAMPLE_RATE,
        "writtenSegmentCount": written_segments,
        "transcript": transcript,
        "localOnly": true,
        "cloudAi": false,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    }))
}

#[cfg(feature = "local-whisper")]
fn pcm16le_to_mono_16k(track: &PcmTrack) -> Result<Vec<f32>, TranscriptionError> {
    if track.bits_per_sample != 16 {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_AUDIO_BITS_INVALID",
            "local Whisper accepts PCM 16-bit audio",
        ));
    }
    if track.sample_rate_hz == 0 || track.channel_count == 0 {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_AUDIO_FORMAT_INVALID",
            "audio track has an invalid sample rate or channel count",
        ));
    }
    let frame_bytes = usize::from(track.channel_count).saturating_mul(2);
    if frame_bytes == 0 || !track.pcm.len().is_multiple_of(frame_bytes) {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_AUDIO_FRAME_INVALID",
            "audio track did not align to whole PCM frames",
        ));
    }

    let mut mono = Vec::with_capacity(track.pcm.len() / frame_bytes);
    for frame in track.pcm.chunks_exact(frame_bytes) {
        let mut sum = 0.0_f32;
        for channel in 0..usize::from(track.channel_count) {
            let offset = channel * 2;
            let sample = i16::from_le_bytes([frame[offset], frame[offset + 1]]) as f32 / 32768.0;
            sum += sample;
        }
        mono.push(sum / f32::from(track.channel_count));
    }

    if track.sample_rate_hz == WHISPER_SAMPLE_RATE {
        Ok(mono)
    } else {
        Ok(resample_linear(
            &mono,
            track.sample_rate_hz,
            WHISPER_SAMPLE_RATE,
        ))
    }
}

#[cfg(feature = "local-whisper")]
fn resample_linear(samples: &[f32], from_hz: u32, to_hz: u32) -> Vec<f32> {
    if samples.is_empty() || from_hz == to_hz {
        return samples.to_vec();
    }
    let target_len = (samples.len() as u128)
        .saturating_mul(u128::from(to_hz))
        .checked_div(u128::from(from_hz.max(1)))
        .unwrap_or_default()
        .max(1) as usize;
    let ratio = from_hz as f64 / to_hz as f64;
    let mut out = Vec::with_capacity(target_len);
    for index in 0..target_len {
        let position = index as f64 * ratio;
        let left = position.floor() as usize;
        let right = (left + 1).min(samples.len().saturating_sub(1));
        let weight = (position - left as f64) as f32;
        let sample = samples[left] * (1.0 - weight) + samples[right] * weight;
        out.push(sample);
    }
    out
}

#[cfg(feature = "local-whisper")]
fn centiseconds_to_ms(value: i64) -> u64 {
    if value <= 0 {
        0
    } else {
        (value as u64).saturating_mul(10)
    }
}

#[cfg(feature = "local-whisper")]
fn speaker_for_channel(channel: &str) -> Option<String> {
    match channel {
        "mic" => Some("Me".to_string()),
        "system" => Some("Them".to_string()),
        _ => None,
    }
}

#[cfg(all(test, feature = "local-whisper"))]
mod tests {
    use super::*;

    fn pcm16le(samples: &[i16]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect()
    }

    fn track(pcm: Vec<u8>, sample_rate_hz: u32, channel_count: u16) -> PcmTrack {
        PcmTrack {
            channel: "system".to_string(),
            sample_rate_hz,
            channel_count,
            bits_per_sample: 16,
            duration_ms: 1,
            pcm,
        }
    }

    #[test]
    fn pcm16le_to_mono_16k_downmixes_and_resamples() {
        let source = track(pcm16le(&[32767, 0, 0, 32767]), 32_000, 2);

        let audio = pcm16le_to_mono_16k(&source).expect("audio");

        assert_eq!(audio.len(), 1);
        assert!(audio[0] > 0.49);
        assert!(audio[0] < 0.51);
    }

    #[test]
    fn pcm16le_to_mono_16k_rejects_misaligned_frames() {
        let source = track(vec![0, 1, 2], 48_000, 2);

        let error = pcm16le_to_mono_16k(&source).expect_err("misaligned frame error");

        assert_eq!(error.code, "TRANSCRIPTION_AUDIO_FRAME_INVALID");
    }

    #[test]
    fn speaker_mapping_is_channel_based() {
        assert_eq!(speaker_for_channel("mic").as_deref(), Some("Me"));
        assert_eq!(speaker_for_channel("system").as_deref(), Some("Them"));
        assert_eq!(speaker_for_channel("screen").as_deref(), None);
    }

    #[test]
    fn centiseconds_convert_to_milliseconds() {
        assert_eq!(centiseconds_to_ms(-1), 0);
        assert_eq!(centiseconds_to_ms(0), 0);
        assert_eq!(centiseconds_to_ms(123), 1230);
    }
}
