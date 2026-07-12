use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::local_model_scheduler::{
    LocalModelJobKind, LocalModelScheduler, LocalModelSchedulerError,
};
use crate::model_manager;
use crate::model_manager::ModelManagerError;
use crate::recording_store::{
    ExportRecordingParams, RecordingIdParams, RecordingStore, RecordingStoreError,
    StartRecordingParams, WriteAudioChunkParams, WriteTranscriptSegmentParams,
};

#[cfg(feature = "local-whisper")]
use crate::recording_store::PcmTrack;

const WHISPER_SAMPLE_RATE: u32 = 16_000;
const DEFAULT_LANGUAGE: &str = "en";

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionRunLocalParams {
    pub recording_id: String,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub initial_prompt: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionProofParams {
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Default)]
pub struct TranscriptionService;

impl TranscriptionService {
    pub fn status(&self, store: &RecordingStore, scheduler: &LocalModelScheduler) -> Value {
        let scheduler_status = scheduler.status();
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
            "defaultModelId": model_manager::default_model_id(),
            "modelIds": model_manager::valid_model_ids(),
            "modelRootKind": store.root_kind(),
            "modelPathAcceptedFromRenderer": false,
            "recordingInput": "recordingId+optionalChannel",
            "acceptedAudioFormat": "pcm_s16le",
            "targetSampleRateHz": WHISPER_SAMPLE_RATE,
            "scheduler": scheduler_status,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    pub fn run_local(
        &mut self,
        store: &RecordingStore,
        scheduler: &mut LocalModelScheduler,
        params: TranscriptionRunLocalParams,
    ) -> Result<Value, TranscriptionError> {
        let job_id = scheduler.start_job(LocalModelJobKind::Whisper, "transcription.runLocal")?;
        let result = self.run_local_inner(store, params);
        scheduler.finish_job(job_id);
        result
    }

    fn run_local_inner(
        &self,
        store: &RecordingStore,
        params: TranscriptionRunLocalParams,
    ) -> Result<Value, TranscriptionError> {
        let model_id = model_manager::normalize_model_id(params.model_id)?;
        let language = normalize_language(params.language)?;
        let initial_prompt = normalize_initial_prompt(params.initial_prompt)?;
        let channel = normalize_optional_channel(params.channel)?;
        let track = store.pcm_track_for_transcription(&params.recording_id, channel.as_deref())?;

        #[cfg(feature = "local-whisper")]
        {
            run_whisper_track(
                store,
                &params.recording_id,
                &model_id,
                &language,
                initial_prompt.as_deref(),
                track,
            )
        }

        #[cfg(not(feature = "local-whisper"))]
        {
            let _ = (language, initial_prompt, track);
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

fn normalize_language(value: Option<String>) -> Result<String, TranscriptionError> {
    let language = value.unwrap_or_else(|| DEFAULT_LANGUAGE.to_string());
    let language = language.trim();
    let valid = language == "auto"
        || (!language.is_empty()
            && language.len() <= 16
            && language
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
    if valid {
        Ok(language.to_string())
    } else {
        Err(TranscriptionError::new(
            "TRANSCRIPTION_LANGUAGE_INVALID",
            "language must be auto or a short ASCII language tag",
        ))
    }
}

fn normalize_initial_prompt(value: Option<String>) -> Result<Option<String>, TranscriptionError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let prompt = value.trim();
    if prompt.is_empty() {
        return Ok(None);
    }
    if prompt.len() > 1_000 {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_PROMPT_TOO_LONG",
            "initial prompt must be at most 1000 bytes",
        ));
    }
    Ok(Some(prompt.to_string()))
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
    recording_id: &str,
    model_id: &str,
    language: &str,
    initial_prompt: Option<&str>,
    track: PcmTrack,
) -> Result<Value, TranscriptionError> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    let verified_model = model_manager::verified_model_path(store, model_id)?;
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

    state
        .full(whisper_params, &audio)
        .map_err(|err| TranscriptionError::new("TRANSCRIPTION_ENGINE_FAILED", err.to_string()))?;

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
