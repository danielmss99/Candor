use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use candor_core::live_transcript_service::CommittedFinalRevisionRef;
use candor_core::live_transcription::ImmutableFinalRevisionRef;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::local_model_scheduler::{
    LocalModelJobKind, LocalModelScheduler, LocalModelSchedulerError,
};
#[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
use crate::meeting_profiles::MeetingProcessingProfileSnapshot;
use crate::model_manager;
#[cfg(feature = "local-whisper")]
use crate::model_manager::VerifiedModel;
use crate::model_manager::{ModelManager, ModelManagerError};
use crate::parakeet_package::{PARAKEET_MODEL_ID, PARAKEET_RUNTIME_VERSION};
use crate::recording_store::{
    transcript_text_sha256, ExportRecordingParams, RecordingIdParams, RecordingStore,
    RecordingStoreError, StartRecordingParams, TranscriptComparisonDraft,
    TranscriptionFailureDraft, TranscriptionSuccessDraft, WriteAudioChunkParams,
    WriteTranscriptSegmentParams,
};
#[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
use crate::replacement_rules::normalize_transcript_text;
use crate::replacement_rules::{
    apply_reviewed_protected_terms, ReplacementChange, ReplacementRuleError, ReplacementRuleSet,
};
use crate::terminology_dictionary::{TerminologyError, TerminologyService};
#[cfg(feature = "local-whisper")]
use crate::transcription_quality::TRANSCRIPTION_BENCHMARK_AUDIO_SECONDS;
use crate::transcription_quality::{
    TranscriptionBenchmarkMeasurement, TranscriptionBenchmarkParams, TranscriptionBenchmarkTier,
    TranscriptionQualityError, TranscriptionQualityService, TranscriptionQualityUpdateParams,
};

#[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
use crate::recording_store::PcmTrack;

#[cfg(feature = "local-whisper")]
struct WhisperTrackRequest<'a> {
    recording_id: &'a str,
    attempt_id: &'a str,
    model_id: &'a str,
    language: &'a str,
    initial_prompt: Option<&'a str>,
    replacement_rule_set: Option<&'a ReplacementRuleSet>,
}

#[cfg(all(windows, feature = "local-parakeet"))]
struct ParakeetTrackRequest<'a> {
    recording_id: &'a str,
    attempt_id: &'a str,
    language: &'a str,
    replacement_rule_set: Option<&'a ReplacementRuleSet>,
}

#[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
struct WhisperAudio {
    channel: String,
    source_channels: Vec<String>,
    duration_ms: u64,
    samples: Vec<f32>,
}

struct LocalTranscriptionExecution {
    public_value: Value,
    raw_text: String,
}

pub(crate) struct LocalTranscriptionRun {
    pub(crate) public_value: Value,
    pub(crate) committed_final_revision: CommittedFinalRevisionRef,
}

/// Internal-only configuration for the capture-time Whisper worker. Model
/// paths and prompts never implement serialization and never enter an RPC
/// response.
#[cfg(feature = "local-whisper")]
pub(crate) struct LiveWhisperConfig {
    pub(crate) verified_model: VerifiedModel,
    pub(crate) language: String,
    pub(crate) initial_prompt: Option<String>,
    pub(crate) replacement_rule_set: Option<ReplacementRuleSet>,
}

const WHISPER_SAMPLE_RATE: u32 = 16_000;
const MAX_PROTECTED_TERM_PREVIEW_SEGMENTS: usize = 64;
const MAX_PROTECTED_TERM_PREVIEW_TEXT_BYTES: usize = 1_024;

fn live_whisper_fallback_model_id(language: &str) -> &'static str {
    if language.eq_ignore_ascii_case("en") || language.to_ascii_lowercase().starts_with("en-") {
        "small.en"
    } else {
        "small"
    }
}
#[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
fn processing_profile_binding_value(profile: &MeetingProcessingProfileSnapshot) -> Value {
    let live_fallback_applied = profile.model_id == PARAKEET_MODEL_ID;
    let live_speech_model_id = if live_fallback_applied {
        live_whisper_fallback_model_id(&profile.transcription_language)
    } else {
        profile.model_id.as_str()
    };
    json!({
        "schemaVersion": profile.schema_version,
        "profileId": profile.profile_id,
        "profileVersion": profile.profile_version,
        "modelId": profile.model_id,
        "speechModelId": profile.speech_model_id,
        "cleanupModelId": profile.cleanup_model_id,
        "summaryModelId": profile.summary_model_id,
        "language": profile.language,
        "transcriptionLanguage": profile.transcription_language,
        "dictionaryIds": profile.dictionary_ids,
        "replacementRuleSetId": profile.replacement_rule_set.as_ref().map(|set| set.id.as_str()),
        "replacementRuleSetVersion": profile.replacement_rule_set.as_ref().map(|set| set.version),
        "liveTranscription": profile.live_transcription,
        "liveSpeechModelId": live_speech_model_id,
        "liveSpeechModelFallbackApplied": live_fallback_applied,
        "immutableAtCaptureStart": true,
        "rawPathExposed": false
    })
}

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

fn local_model_job_kind(
    store: &RecordingStore,
    params: &TranscriptionRunLocalParams,
) -> Result<LocalModelJobKind, TranscriptionError> {
    let profile_model_id = if params.model_id.is_none() {
        store
            .processing_profile(&params.recording_id)?
            .map(|profile| profile.model_id)
    } else {
        None
    };
    let model_id = params.model_id.as_deref().or(profile_model_id.as_deref());
    Ok(if model_id == Some(PARAKEET_MODEL_ID) {
        LocalModelJobKind::Parakeet
    } else {
        LocalModelJobKind::Whisper
    })
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

    #[test]
    fn parakeet_live_fallback_is_language_appropriate_whisper() {
        assert_eq!(live_whisper_fallback_model_id("en-US"), "small.en");
        assert_eq!(live_whisper_fallback_model_id("EN"), "small.en");
        assert_eq!(live_whisper_fallback_model_id("fr-FR"), "small");
        assert_eq!(live_whisper_fallback_model_id("auto"), "small");
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

impl From<ReplacementRuleError> for TranscriptionError {
    fn from(error: ReplacementRuleError) -> Self {
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtectedTermReviewParams {
    pub recording_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtectedTermApplyParams {
    pub recording_id: String,
    pub revision_id: String,
    pub preview_token: String,
}

#[derive(Debug)]
struct ProtectedTermSegment {
    channel: String,
    speaker: Option<String>,
    original_text: String,
    reviewed_text: String,
    start_ms: u64,
    duration_ms: u64,
    confidence: Option<f32>,
}

#[derive(Debug)]
struct PreparedProtectedTermReview {
    recording_id: String,
    revision_id: Option<String>,
    rule_set_id: Option<String>,
    rule_set_version: Option<u32>,
    segments: Vec<ProtectedTermSegment>,
    changes: Vec<ReplacementChange>,
    replacement_count: u32,
    preview_token: Option<String>,
    raw_text: String,
    normalized_text: String,
    raw_segment_count: u64,
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

    pub fn measured_speech_model_latencies_ms(&self) -> BTreeMap<String, u64> {
        self.quality.measured_speech_model_latencies_ms()
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
            "engines": {
                "whisper": {
                    "runtime": "whisper-rs",
                    "enabled": cfg!(feature = "local-whisper")
                },
                "parakeet": {
                    "runtime": "sherpa-onnx",
                    "version": PARAKEET_RUNTIME_VERSION,
                    "enabled": cfg!(all(windows, feature = "local-parakeet")),
                    "role": "final-transcription"
                }
            },
            "whisperFeatureEnabled": cfg!(feature = "local-whisper"),
            "parakeetFeatureEnabled": cfg!(all(windows, feature = "local-parakeet")),
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

    pub fn protected_term_review(
        &self,
        store: &RecordingStore,
        params: ProtectedTermReviewParams,
    ) -> Result<Value, TranscriptionError> {
        let prepared = self.prepare_protected_term_review(store, &params.recording_id)?;
        Ok(protected_term_review_value(&prepared))
    }

    pub fn apply_protected_term_review(
        &self,
        store: &RecordingStore,
        params: ProtectedTermApplyParams,
    ) -> Result<Value, TranscriptionError> {
        validate_protected_term_preview_token(&params.preview_token)?;
        let prepared = self.prepare_protected_term_review(store, &params.recording_id)?;
        if prepared.revision_id.as_deref() != Some(params.revision_id.as_str()) {
            return Err(TranscriptionError::new(
                "PROTECTED_TERM_REVIEW_STALE",
                "the current transcript changed after protected terms were reviewed",
            ));
        }
        if prepared.preview_token.as_deref() != Some(params.preview_token.as_str()) {
            return Err(TranscriptionError::new(
                "PROTECTED_TERM_PREVIEW_MISMATCH",
                "protected terms must be approved from the latest core-generated preview",
            ));
        }
        if prepared.replacement_count == 0 {
            return Err(TranscriptionError::new(
                "PROTECTED_TERM_REVIEW_NOT_REQUIRED",
                "the current transcript has no protected-term changes to approve",
            ));
        }

        let started_at_ms = wall_clock_ms();
        let started = Instant::now();
        let attempt_id = store.begin_transcription_attempt(&prepared.recording_id)?;
        let mut written_segment_count = 0_u64;
        for segment in &prepared.segments {
            if segment.reviewed_text.trim().is_empty() {
                continue;
            }
            store.write_transcription_attempt_segment(
                &attempt_id,
                WriteTranscriptSegmentParams {
                    recording_id: prepared.recording_id.clone(),
                    channel: segment.channel.clone(),
                    speaker: segment.speaker.clone(),
                    text: segment.reviewed_text.clone(),
                    start_ms: segment.start_ms,
                    duration_ms: Some(segment.duration_ms),
                    end_ms: None,
                    confidence: segment.confidence,
                },
            )?;
            written_segment_count = written_segment_count.saturating_add(1);
        }
        let comparison = TranscriptComparisonDraft {
            raw_text_sha256: transcript_text_sha256(&prepared.raw_text),
            normalized_text_sha256: transcript_text_sha256(&prepared.normalized_text),
            raw_text_bytes: prepared.raw_text.len() as u64,
            normalized_text_bytes: prepared.normalized_text.len() as u64,
            raw_segment_count: prepared.raw_segment_count,
            normalized_segment_count: written_segment_count,
            changed: prepared.raw_text != prepared.normalized_text,
        };
        let history = store.complete_protected_term_review_attempt(
            TranscriptionSuccessDraft {
                recording_id: prepared.recording_id.clone(),
                attempt_id: Some(attempt_id),
                chunk_indices: Vec::new(),
                engine: "candor-protected-term-review".to_string(),
                model_id: None,
                model_sha256: None,
                started_at_ms,
                elapsed_ms: elapsed_ms(&started),
                comparison,
                raw_text: prepared.raw_text,
            },
            params.revision_id,
        )?;
        Ok(json!({
            "implemented": true,
            "recordingId": prepared.recording_id,
            "applied": true,
            "replacementCount": prepared.replacement_count,
            "writtenSegmentCount": written_segment_count,
            "ruleSetId": prepared.rule_set_id,
            "ruleSetVersion": prepared.rule_set_version,
            "trustHistory": history,
            "localOnly": true,
            "networkAttempted": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    fn prepare_protected_term_review(
        &self,
        store: &RecordingStore,
        recording_id: &str,
    ) -> Result<PreparedProtectedTermReview, TranscriptionError> {
        let transcript = store.transcript(RecordingIdParams {
            recording_id: recording_id.to_string(),
        })?;
        let revision_id = transcript
            .get("currentRevisionId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let profile = store.processing_profile(recording_id)?;
        let rule_set = profile
            .as_ref()
            .and_then(|profile| profile.replacement_rule_set.as_ref());
        let rule_set_id = rule_set.map(|rule_set| rule_set.id.clone());
        let rule_set_version = rule_set.map(|rule_set| rule_set.version);
        let source_segments = transcript
            .get("segments")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                TranscriptionError::new(
                    "PROTECTED_TERM_REVIEW_SOURCE_INVALID",
                    "the current transcript could not be prepared for protected-term review",
                )
            })?;

        let mut segments = Vec::with_capacity(source_segments.len());
        let mut changes = Vec::new();
        let mut replacement_count = 0_u32;
        for source in source_segments {
            let source = source.as_object().ok_or_else(|| {
                TranscriptionError::new(
                    "PROTECTED_TERM_REVIEW_SOURCE_INVALID",
                    "the current transcript could not be prepared for protected-term review",
                )
            })?;
            let original_text = required_segment_string(source, "text")?;
            let application = match rule_set {
                Some(rule_set) => apply_reviewed_protected_terms(rule_set, &original_text)?,
                None => crate::replacement_rules::ProtectedTermApplication {
                    normalized_text: original_text.clone(),
                    changes: Vec::new(),
                    replacement_count: 0,
                },
            };
            replacement_count = replacement_count.saturating_add(application.replacement_count);
            merge_replacement_changes(&mut changes, application.changes);
            segments.push(ProtectedTermSegment {
                channel: required_segment_string(source, "channel")?,
                speaker: optional_segment_string(source, "speaker")?,
                original_text,
                reviewed_text: application.normalized_text.trim().to_string(),
                start_ms: required_segment_u64(source, "startMs")?,
                duration_ms: required_segment_u64(source, "durationMs")?,
                confidence: optional_segment_confidence(source)?,
            });
        }
        let raw_text = segments
            .iter()
            .map(|segment| segment.original_text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let normalized_text = segments
            .iter()
            .filter(|segment| !segment.reviewed_text.is_empty())
            .map(|segment| segment.reviewed_text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let preview_token = if replacement_count > 0 {
            let revision_id = revision_id.as_deref().ok_or_else(|| {
                TranscriptionError::new(
                    "PROTECTED_TERM_REVIEW_REVISION_REQUIRED",
                    "protected-term review requires an immutable transcript revision",
                )
            })?;
            let rule_set = rule_set.ok_or_else(|| {
                TranscriptionError::new(
                    "PROTECTED_TERM_REVIEW_RULE_SET_REQUIRED",
                    "protected-term review requires the capture-time replacement rule set",
                )
            })?;
            Some(protected_term_preview_token(
                recording_id,
                revision_id,
                rule_set,
                &segments,
            ))
        } else {
            None
        };
        Ok(PreparedProtectedTermReview {
            recording_id: recording_id.to_string(),
            revision_id,
            rule_set_id,
            rule_set_version,
            raw_segment_count: segments.len() as u64,
            segments,
            changes,
            replacement_count,
            preview_token,
            raw_text,
            normalized_text,
        })
    }

    #[cfg(feature = "local-whisper")]
    pub(crate) fn prepare_live_whisper(
        &self,
        store: &RecordingStore,
        model_manager: &ModelManager,
        recording_id: &str,
    ) -> Result<LiveWhisperConfig, TranscriptionError> {
        let processing_profile = store.processing_profile(recording_id)?.ok_or_else(|| {
            TranscriptionError::new(
                "LIVE_TRANSCRIPT_PROFILE_REQUIRED",
                "live transcription requires the immutable capture profile",
            )
        })?;
        if !processing_profile.live_transcription {
            return Err(TranscriptionError::new(
                "LIVE_TRANSCRIPT_PROFILE_DISABLED",
                "the recording profile does not enable live transcription",
            ));
        }
        let initial_prompt = self.terminology.whisper_prompt_with_dictionary_ids(
            store,
            recording_id,
            processing_profile.dictionary_ids.as_slice(),
        )?;
        let final_speech_model_id = processing_profile.model_id.clone();
        let fallback_applied = final_speech_model_id == PARAKEET_MODEL_ID;
        let live_model_id = if fallback_applied {
            live_whisper_fallback_model_id(&processing_profile.transcription_language)
        } else {
            final_speech_model_id.as_str()
        };
        let verified_model = model_manager.cached_verified_model_path(store, live_model_id)?;
        Ok(LiveWhisperConfig {
            verified_model,
            language: processing_profile.transcription_language,
            initial_prompt,
            replacement_rule_set: processing_profile.replacement_rule_set,
        })
    }

    pub(crate) fn run_local_with_commit(
        &mut self,
        store: &RecordingStore,
        scheduler: &mut LocalModelScheduler,
        model_manager: &ModelManager,
        params: TranscriptionRunLocalParams,
    ) -> Result<LocalTranscriptionRun, TranscriptionError> {
        let kind = local_model_job_kind(store, &params)?;
        let job_id = scheduler.start_job(kind, "transcription.runLocal")?;
        let result = self.run_local_inner(store, model_manager, params, None);
        scheduler.finish_job(job_id);
        result
    }

    pub(crate) fn run_local_cancellable_with_commit(
        &mut self,
        store: &RecordingStore,
        scheduler: &mut LocalModelScheduler,
        model_manager: &ModelManager,
        params: TranscriptionRunLocalParams,
        cancellation: Arc<AtomicBool>,
    ) -> Result<LocalTranscriptionRun, TranscriptionError> {
        let kind = local_model_job_kind(store, &params)?;
        let job_id = scheduler.start_job(kind, "transcription.runLocal")?;
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
    ) -> Result<LocalTranscriptionRun, TranscriptionError> {
        let recording_id = params.recording_id.clone();
        let requested_model_id = params.model_id.clone();
        let started_at_ms = wall_clock_ms();
        let started = Instant::now();
        let attempt_id = store.begin_transcription_attempt(&recording_id)?;
        let execution = self.execute_local_inner(
            store,
            model_manager,
            params,
            &attempt_id,
            cancellation.clone(),
        );
        let receipt_model_id = execution
            .as_ref()
            .ok()
            .and_then(|execution| execution.public_value.get("model"))
            .and_then(Value::as_object)
            .and_then(|model| model.get("modelId"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(requested_model_id);
        let finalized = execution.and_then(|execution| {
            ensure_transcription_not_cancelled(cancellation.as_ref())?;
            let value = execution.public_value;
            let comparison = comparison_from_result(&value)?;
            let model = value.get("model").and_then(Value::as_object);
            let history = store.complete_transcription_attempt(TranscriptionSuccessDraft {
                recording_id: recording_id.clone(),
                attempt_id: Some(attempt_id.clone()),
                chunk_indices: Vec::new(),
                engine: value
                    .get("engine")
                    .and_then(Value::as_str)
                    .unwrap_or("whisper-rs")
                    .to_string(),
                model_id: model
                    .and_then(|item| item.get("modelId"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                model_sha256: model
                    .and_then(|item| item.get("sha256"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                started_at_ms,
                elapsed_ms: elapsed_ms(&started),
                comparison,
                raw_text: execution.raw_text,
            })?;
            Ok((value, history))
        });
        match finalized {
            Ok((mut value, history)) => {
                let revision_id = history
                    .get("revisionId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        TranscriptionError::new(
                            "TRANSCRIPTION_COMMIT_PROOF_MISSING",
                            "the committed transcript revision proof was missing",
                        )
                    })?
                    .to_string();
                if let Some(object) = value.as_object_mut() {
                    object.insert("trustHistory".to_string(), history);
                    object.insert(
                        "transcript".to_string(),
                        store.transcript(RecordingIdParams {
                            recording_id: recording_id.clone(),
                        })?,
                    );
                }
                let final_revision =
                    ImmutableFinalRevisionRef::new(recording_id.clone(), revision_id)
                        .map_err(|error| TranscriptionError::new(error.code, error.message))?;
                Ok(LocalTranscriptionRun {
                    public_value: value,
                    committed_final_revision: CommittedFinalRevisionRef::after_commit(
                        final_revision,
                    ),
                })
            }
            Err(error) => {
                let failure_engine = if receipt_model_id.as_deref() == Some(PARAKEET_MODEL_ID) {
                    "sherpa-onnx"
                } else {
                    "whisper-rs"
                };
                let _ = store.record_transcription_failure(TranscriptionFailureDraft {
                    recording_id,
                    engine: failure_engine.to_string(),
                    model_id: receipt_model_id,
                    started_at_ms,
                    elapsed_ms: elapsed_ms(&started),
                    cancelled: error.code == "TRANSCRIPTION_CANCELLED",
                    error_code: error.code.to_string(),
                });
                Err(error)
            }
        }
    }

    fn execute_local_inner(
        &self,
        store: &RecordingStore,
        model_manager: &ModelManager,
        params: TranscriptionRunLocalParams,
        attempt_id: &str,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<LocalTranscriptionExecution, TranscriptionError> {
        ensure_transcription_not_cancelled(cancellation.as_ref())?;
        let processing_profile = store.processing_profile(&params.recording_id)?;
        let quality = if processing_profile.is_none() {
            Some(self.quality.resolve()?)
        } else {
            None
        };
        let model_id = match params.model_id {
            Some(model_id) => model_manager.resolve_model_id(Some(model_id))?,
            None => processing_profile
                .as_ref()
                .map(|profile| profile.model_id.clone())
                .or_else(|| quality.as_ref().map(|quality| quality.model_id.to_string()))
                .ok_or_else(|| {
                    TranscriptionError::new(
                        "TRANSCRIPTION_MODEL_UNRESOLVED",
                        "the local transcription model could not be resolved",
                    )
                })?,
        };
        let language = processing_profile
            .as_ref()
            .map(|profile| profile.transcription_language.clone())
            .or_else(|| {
                quality
                    .as_ref()
                    .map(|quality| quality.language_preference.whisper_language().to_string())
            })
            .unwrap_or_else(|| "auto".to_string());
        let initial_prompt = self.terminology.whisper_prompt_with_dictionary_ids(
            store,
            &params.recording_id,
            processing_profile
                .as_ref()
                .map(|profile| profile.dictionary_ids.as_slice())
                .unwrap_or_default(),
        )?;
        let channel = normalize_optional_channel(params.channel)?;
        let tracks =
            store.pcm_tracks_for_transcription(&params.recording_id, channel.as_deref())?;

        #[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
        {
            let audio = prepare_whisper_audio(tracks)?;
            let replacement_rule_set = processing_profile
                .as_ref()
                .and_then(|profile| profile.replacement_rule_set.as_ref());
            let mut result = if model_id == PARAKEET_MODEL_ID {
                run_parakeet_track_dispatch(
                    store,
                    model_manager,
                    &params.recording_id,
                    attempt_id,
                    &language,
                    replacement_rule_set,
                    audio,
                    cancellation,
                )?
            } else {
                run_whisper_track_dispatch(
                    store,
                    model_manager,
                    &params.recording_id,
                    attempt_id,
                    &model_id,
                    &language,
                    initial_prompt.as_deref(),
                    replacement_rule_set,
                    audio,
                    cancellation,
                )?
            };
            let is_parakeet = model_id == PARAKEET_MODEL_ID;
            if let Some(object) = result.public_value.as_object_mut() {
                object.insert(
                    "qualityTier".to_string(),
                    Value::String(
                        quality
                            .as_ref()
                            .map(|quality| quality.tier.id())
                            .unwrap_or("capture-profile")
                            .to_string(),
                    ),
                );
                object.insert(
                    "qualityFallbackApplied".to_string(),
                    Value::Bool(
                        quality
                            .as_ref()
                            .is_some_and(|quality| quality.fallback_applied),
                    ),
                );
                object.insert(
                    "qualityGuardReason".to_string(),
                    quality
                        .as_ref()
                        .and_then(|quality| quality.guard_reason)
                        .map(|reason| Value::String(reason.to_string()))
                        .unwrap_or(Value::Null),
                );
                object.insert(
                    "terminologyContextApplied".to_string(),
                    Value::Bool(!is_parakeet && initial_prompt.is_some()),
                );
                object.insert(
                    "terminologyPromptSupported".to_string(),
                    Value::Bool(!is_parakeet),
                );
                object.insert("userPromptAccepted".to_string(), Value::Bool(false));
                object.insert(
                    "processingProfile".to_string(),
                    processing_profile
                        .as_ref()
                        .map(processing_profile_binding_value)
                        .unwrap_or(Value::Null),
                );
            }
            Ok(result)
        }

        #[cfg(not(any(feature = "local-whisper", feature = "local-parakeet")))]
        {
            let _ = (
                language,
                initial_prompt,
                tracks,
                model_manager,
                quality,
                processing_profile,
                attempt_id,
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

fn protected_term_review_value(prepared: &PreparedProtectedTermReview) -> Value {
    let changed_segments = prepared
        .segments
        .iter()
        .filter(|segment| segment.original_text != segment.reviewed_text)
        .collect::<Vec<_>>();
    let preview_segments = changed_segments
        .iter()
        .take(MAX_PROTECTED_TERM_PREVIEW_SEGMENTS)
        .map(|segment| {
            json!({
                "channel": segment.channel,
                "speaker": segment.speaker,
                "startMs": segment.start_ms,
                "durationMs": segment.duration_ms,
                "before": bounded_preview_text(&segment.original_text),
                "after": bounded_preview_text(&segment.reviewed_text),
                "beforeTruncated": segment.original_text.len() > MAX_PROTECTED_TERM_PREVIEW_TEXT_BYTES,
                "afterTruncated": segment.reviewed_text.len() > MAX_PROTECTED_TERM_PREVIEW_TEXT_BYTES
            })
        })
        .collect::<Vec<_>>();
    json!({
        "implemented": true,
        "recordingId": prepared.recording_id,
        "revisionId": prepared.revision_id,
        "ruleSetId": prepared.rule_set_id,
        "ruleSetVersion": prepared.rule_set_version,
        "reviewRequired": prepared.replacement_count > 0,
        "replacementCount": prepared.replacement_count,
        "changes": prepared.changes,
        "changedSegmentCount": changed_segments.len(),
        "previewSegments": preview_segments,
        "previewTruncated": changed_segments.len() > MAX_PROTECTED_TERM_PREVIEW_SEGMENTS,
        "previewToken": prepared.preview_token,
        "durableApplyCreatesRevision": true,
        "rendererSuppliedTranscriptAccepted": false,
        "captureTimeRuleSnapshotUsed": true,
        "localOnly": true,
        "networkAttempted": false,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn required_segment_string(
    source: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<String, TranscriptionError> {
    source
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            TranscriptionError::new(
                "PROTECTED_TERM_REVIEW_SOURCE_INVALID",
                "the current transcript could not be prepared for protected-term review",
            )
        })
}

fn optional_segment_string(
    source: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<String>, TranscriptionError> {
    match source.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(TranscriptionError::new(
            "PROTECTED_TERM_REVIEW_SOURCE_INVALID",
            "the current transcript could not be prepared for protected-term review",
        )),
    }
}

fn required_segment_u64(
    source: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<u64, TranscriptionError> {
    source.get(field).and_then(Value::as_u64).ok_or_else(|| {
        TranscriptionError::new(
            "PROTECTED_TERM_REVIEW_SOURCE_INVALID",
            "the current transcript could not be prepared for protected-term review",
        )
    })
}

fn optional_segment_confidence(
    source: &serde_json::Map<String, Value>,
) -> Result<Option<f32>, TranscriptionError> {
    match source.get("confidence") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let confidence = value.as_f64().ok_or_else(|| {
                TranscriptionError::new(
                    "PROTECTED_TERM_REVIEW_SOURCE_INVALID",
                    "the current transcript could not be prepared for protected-term review",
                )
            })?;
            if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
                return Err(TranscriptionError::new(
                    "PROTECTED_TERM_REVIEW_SOURCE_INVALID",
                    "the current transcript could not be prepared for protected-term review",
                ));
            }
            Ok(Some(confidence as f32))
        }
    }
}

fn bounded_preview_text(text: &str) -> &str {
    if text.len() <= MAX_PROTECTED_TERM_PREVIEW_TEXT_BYTES {
        return text;
    }
    let mut end = MAX_PROTECTED_TERM_PREVIEW_TEXT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn validate_protected_term_preview_token(token: &str) -> Result<(), TranscriptionError> {
    if token.len() != 64
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(TranscriptionError::new(
            "PROTECTED_TERM_PREVIEW_TOKEN_INVALID",
            "protected-term preview token must be a lowercase SHA-256 digest",
        ));
    }
    Ok(())
}

fn protected_term_preview_token(
    recording_id: &str,
    revision_id: &str,
    rule_set: &ReplacementRuleSet,
    segments: &[ProtectedTermSegment],
) -> String {
    let mut hasher = Sha256::new();
    hash_protected_term_field(&mut hasher, b"candor-protected-term-review-v1");
    hash_protected_term_field(&mut hasher, recording_id.as_bytes());
    hash_protected_term_field(&mut hasher, revision_id.as_bytes());
    hash_protected_term_field(&mut hasher, rule_set.id.as_bytes());
    hasher.update(rule_set.version.to_be_bytes());
    for segment in segments {
        hash_protected_term_field(&mut hasher, segment.channel.as_bytes());
        hash_protected_term_field(
            &mut hasher,
            segment.speaker.as_deref().unwrap_or_default().as_bytes(),
        );
        hasher.update(segment.start_ms.to_be_bytes());
        hasher.update(segment.duration_ms.to_be_bytes());
        hash_protected_term_field(&mut hasher, segment.original_text.as_bytes());
        hash_protected_term_field(&mut hasher, segment.reviewed_text.as_bytes());
    }
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hash_protected_term_field(hasher: &mut Sha256, field: &[u8]) {
    hasher.update(u64::try_from(field.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(field);
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
    let _runtime_load = model_manager.mark_runtime_loaded(tier.model_id());
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
    let real_time_factor = elapsed_seconds / f64::from(TRANSCRIPTION_BENCHMARK_AUDIO_SECONDS);
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
    let sample_count =
        WHISPER_SAMPLE_RATE as usize * TRANSCRIPTION_BENCHMARK_AUDIO_SECONDS as usize;
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

fn comparison_from_result(value: &Value) -> Result<TranscriptComparisonDraft, TranscriptionError> {
    let comparison = value
        .get("comparison")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            TranscriptionError::new(
                "TRANSCRIPTION_COMPARISON_MISSING",
                "local transcription did not return comparison metadata",
            )
        })?;
    let required_hash = |field: &str| {
        comparison
            .get(field)
            .and_then(Value::as_str)
            .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .map(str::to_string)
            .ok_or_else(|| {
                TranscriptionError::new(
                    "TRANSCRIPTION_COMPARISON_INVALID",
                    "local transcription comparison metadata was invalid",
                )
            })
    };
    Ok(TranscriptComparisonDraft {
        raw_text_sha256: required_hash("rawTextSha256")?,
        normalized_text_sha256: required_hash("normalizedTextSha256")?,
        raw_text_bytes: comparison
            .get("rawTextBytes")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                TranscriptionError::new(
                    "TRANSCRIPTION_COMPARISON_INVALID",
                    "local transcription comparison metadata was invalid",
                )
            })?,
        normalized_text_bytes: comparison
            .get("normalizedTextBytes")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                TranscriptionError::new(
                    "TRANSCRIPTION_COMPARISON_INVALID",
                    "local transcription comparison metadata was invalid",
                )
            })?,
        raw_segment_count: comparison
            .get("rawSegmentCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                TranscriptionError::new(
                    "TRANSCRIPTION_COMPARISON_INVALID",
                    "local transcription comparison metadata was invalid",
                )
            })?,
        normalized_segment_count: comparison
            .get("normalizedSegmentCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                TranscriptionError::new(
                    "TRANSCRIPTION_COMPARISON_INVALID",
                    "local transcription comparison metadata was invalid",
                )
            })?,
        changed: comparison
            .get("changed")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                TranscriptionError::new(
                    "TRANSCRIPTION_COMPARISON_INVALID",
                    "local transcription comparison metadata was invalid",
                )
            })?,
    })
}

fn wall_clock_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn elapsed_ms(started: &Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
#[allow(clippy::too_many_arguments)]
fn run_whisper_track_dispatch(
    store: &RecordingStore,
    model_manager: &ModelManager,
    recording_id: &str,
    attempt_id: &str,
    model_id: &str,
    language: &str,
    initial_prompt: Option<&str>,
    replacement_rule_set: Option<&ReplacementRuleSet>,
    audio: WhisperAudio,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<LocalTranscriptionExecution, TranscriptionError> {
    #[cfg(feature = "local-whisper")]
    {
        return run_whisper_track(
            store,
            model_manager,
            WhisperTrackRequest {
                recording_id,
                attempt_id,
                model_id,
                language,
                initial_prompt,
                replacement_rule_set,
            },
            audio,
            cancellation,
        );
    }
    #[cfg(not(feature = "local-whisper"))]
    {
        let _ = (
            store,
            model_manager,
            recording_id,
            attempt_id,
            model_id,
            language,
            initial_prompt,
            replacement_rule_set,
            audio,
            cancellation,
        );
        Err(TranscriptionError::new(
            "TRANSCRIPTION_ENGINE_UNAVAILABLE",
            "this Candor build does not include the local Whisper runtime",
        ))
    }
}

#[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
#[allow(clippy::too_many_arguments)]
fn run_parakeet_track_dispatch(
    store: &RecordingStore,
    model_manager: &ModelManager,
    recording_id: &str,
    attempt_id: &str,
    language: &str,
    replacement_rule_set: Option<&ReplacementRuleSet>,
    audio: WhisperAudio,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<LocalTranscriptionExecution, TranscriptionError> {
    #[cfg(all(windows, feature = "local-parakeet"))]
    {
        return run_parakeet_track(
            store,
            model_manager,
            ParakeetTrackRequest {
                recording_id,
                attempt_id,
                language,
                replacement_rule_set,
            },
            audio,
            cancellation,
        );
    }
    #[cfg(not(all(windows, feature = "local-parakeet")))]
    {
        let _ = (
            store,
            model_manager,
            recording_id,
            attempt_id,
            language,
            replacement_rule_set,
            audio,
            cancellation,
        );
        Err(TranscriptionError::new(
            "PARAKEET_RUNTIME_UNAVAILABLE",
            "this Candor build does not include the Windows x64 Parakeet runtime",
        ))
    }
}

#[cfg(all(windows, feature = "local-parakeet"))]
fn run_parakeet_track(
    store: &RecordingStore,
    model_manager: &ModelManager,
    request: ParakeetTrackRequest<'_>,
    audio: WhisperAudio,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<LocalTranscriptionExecution, TranscriptionError> {
    use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig};

    let ParakeetTrackRequest {
        recording_id,
        attempt_id,
        language,
        replacement_rule_set,
    } = request;
    let WhisperAudio {
        channel,
        source_channels,
        duration_ms,
        samples,
    } = audio;
    if samples.is_empty() {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_AUDIO_EMPTY",
            "recording audio had no samples to transcribe",
        ));
    }
    ensure_transcription_not_cancelled(cancellation.as_ref())?;
    let package = model_manager.verified_parakeet_package(store)?;
    let path_string = |path: std::path::PathBuf| {
        path.to_str().map(str::to_string).ok_or_else(|| {
            TranscriptionError::new(
                "PARAKEET_MODEL_PATH_INVALID",
                "the private Parakeet model path was not valid Unicode",
            )
        })
    };
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.transducer = OfflineTransducerModelConfig {
        encoder: Some(path_string(package.encoder())?),
        decoder: Some(path_string(package.decoder())?),
        joiner: Some(path_string(package.joiner())?),
    };
    config.model_config.tokens = Some(path_string(package.tokens())?);
    config.model_config.model_type = Some("nemo_transducer".to_string());
    config.model_config.provider = Some("cpu".to_string());
    config.model_config.num_threads = std::thread::available_parallelism()
        .map(|count| count.get().min(i32::MAX as usize) as i32)
        .unwrap_or(4);
    config.decoding_method = Some("greedy_search".to_string());
    let recognizer = OfflineRecognizer::create(&config).ok_or_else(|| {
        TranscriptionError::new(
            "PARAKEET_MODEL_LOAD_FAILED",
            "the verified Parakeet model could not be loaded by sherpa-onnx",
        )
    })?;
    let _runtime_load = model_manager.mark_runtime_loaded(PARAKEET_MODEL_ID);
    ensure_transcription_not_cancelled(cancellation.as_ref())?;
    let stream = recognizer.create_stream();
    stream.accept_waveform(WHISPER_SAMPLE_RATE as i32, &samples);
    let inference_started = Instant::now();
    recognizer.decode(&stream);
    ensure_transcription_not_cancelled(cancellation.as_ref())?;
    let result = stream.get_result().ok_or_else(|| {
        TranscriptionError::new(
            "PARAKEET_RESULT_MISSING",
            "sherpa-onnx did not return a Parakeet recognition result",
        )
    })?;
    let raw_text = result.text.trim().to_string();
    let mut normalized_text = raw_text.clone();
    let mut automatic_changes = Vec::<ReplacementChange>::new();
    let mut protected_term_matches = Vec::<ReplacementChange>::new();
    let mut automatic_replacement_count = 0_u32;
    if let Some(rule_set) = replacement_rule_set {
        let outcome = normalize_transcript_text(rule_set, &normalized_text)
            .map_err(|error| TranscriptionError::new(error.code, error.message))?;
        normalized_text = outcome.normalized_text;
        automatic_replacement_count = outcome.automatic_replacement_count;
        automatic_changes = outcome.automatic_changes;
        protected_term_matches = outcome.protected_term_matches;
    }
    let mut written_segments = 0_u64;
    if !normalized_text.is_empty() {
        store.write_transcription_attempt_segment(
            attempt_id,
            WriteTranscriptSegmentParams {
                recording_id: recording_id.to_string(),
                channel: channel.clone(),
                speaker: speaker_for_channel(&channel),
                text: normalized_text.clone(),
                start_ms: 0,
                duration_ms: Some(duration_ms.max(1)),
                end_ms: None,
                confidence: None,
            },
        )?;
        written_segments = 1;
    }
    let transcript = store.transcript(RecordingIdParams {
        recording_id: recording_id.to_string(),
    })?;
    let public_value = json!({
        "recordingId": recording_id,
        "engine": "sherpa-onnx",
        "runtimeVersion": PARAKEET_RUNTIME_VERSION,
        "model": {
            "modelId": PARAKEET_MODEL_ID,
            "sha256": package.archive_sha256,
            "bytes": package.bytes,
            "modifiedUnixMs": package.modified_unix_ms,
            "source": "managed-local-package",
            "modelPackageDigest": package.archive_sha256,
            "rawPathExposed": false
        },
        "language": language,
        "languageHandling": "model-auto-detection",
        "channel": channel,
        "sourceChannels": source_channels,
        "audioDurationMs": duration_ms,
        "targetSampleRateHz": WHISPER_SAMPLE_RATE,
        "writtenSegmentCount": written_segments,
        "wordTimestampsAvailable": result.timestamps.is_some(),
        "tokenCount": result.tokens.len(),
        "inferenceElapsedMs": elapsed_ms(&inference_started),
        "normalization": {
            "ruleSetId": replacement_rule_set.map(|set| set.id.as_str()),
            "ruleSetVersion": replacement_rule_set.map(|set| set.version),
            "automaticReplacementCount": automatic_replacement_count,
            "automaticChanges": automatic_changes,
            "protectedTermReviewRequired": !protected_term_matches.is_empty(),
            "protectedTermMatches": protected_term_matches,
            "protectedTermsAutoReplaced": false,
            "rulesAppliedInDeterministicOrder": true
        },
        "comparison": {
            "rawTextSha256": transcript_text_sha256(&raw_text),
            "normalizedTextSha256": transcript_text_sha256(&normalized_text),
            "rawTextBytes": raw_text.len(),
            "normalizedTextBytes": normalized_text.len(),
            "rawSegmentCount": if raw_text.is_empty() { 0 } else { 1 },
            "normalizedSegmentCount": if normalized_text.is_empty() { 0 } else { 1 },
            "changed": raw_text != normalized_text
        },
        "transcript": transcript,
        "localOnly": true,
        "cloudAi": false,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    });
    Ok(LocalTranscriptionExecution {
        public_value,
        raw_text,
    })
}

#[cfg(feature = "local-whisper")]
fn run_whisper_track(
    store: &RecordingStore,
    model_manager: &ModelManager,
    request: WhisperTrackRequest<'_>,
    audio: WhisperAudio,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<LocalTranscriptionExecution, TranscriptionError> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    let WhisperTrackRequest {
        recording_id,
        attempt_id,
        model_id,
        language,
        initial_prompt,
        replacement_rule_set,
    } = request;
    let WhisperAudio {
        channel,
        source_channels,
        duration_ms,
        samples,
    } = audio;

    let verified_model = model_manager.verified_model_path(store, model_id)?;
    if samples.is_empty() {
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
    let _runtime_load = model_manager.mark_runtime_loaded(model_id);
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

    if let Err(error) = state.full(whisper_params, &samples) {
        ensure_transcription_not_cancelled(cancellation.as_ref())?;
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_ENGINE_FAILED",
            error.to_string(),
        ));
    }
    ensure_transcription_not_cancelled(cancellation.as_ref())?;

    let speaker = speaker_for_channel(&channel);
    let mut written_segments = 0_u64;
    let mut raw_segments = Vec::new();
    let mut normalized_segments = Vec::new();
    let mut automatic_changes = Vec::<ReplacementChange>::new();
    let mut protected_term_matches = Vec::<ReplacementChange>::new();
    let mut automatic_replacement_count = 0_u32;
    let n = state.full_n_segments();
    for i in 0..n {
        ensure_transcription_not_cancelled(cancellation.as_ref())?;
        let Some(segment) = state.get_segment(i) else {
            continue;
        };
        let raw_text = segment
            .to_str_lossy()
            .map(|text| text.to_string())
            .unwrap_or_default();
        raw_segments.push(raw_text.clone());
        let mut text = raw_text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        if let Some(rule_set) = replacement_rule_set {
            let outcome = normalize_transcript_text(rule_set, &text)
                .map_err(|error| TranscriptionError::new(error.code, error.message))?;
            text = outcome.normalized_text;
            automatic_replacement_count =
                automatic_replacement_count.saturating_add(outcome.automatic_replacement_count);
            merge_replacement_changes(&mut automatic_changes, outcome.automatic_changes);
            merge_replacement_changes(&mut protected_term_matches, outcome.protected_term_matches);
        }
        if text.is_empty() {
            continue;
        }
        normalized_segments.push(text.clone());
        let start_ms = centiseconds_to_ms(segment.start_timestamp());
        let end_ms = centiseconds_to_ms(segment.end_timestamp()).max(start_ms.saturating_add(1));
        store.write_transcription_attempt_segment(
            attempt_id,
            WriteTranscriptSegmentParams {
                recording_id: recording_id.to_string(),
                channel: channel.clone(),
                speaker: speaker.clone(),
                text,
                start_ms,
                duration_ms: Some(end_ms.saturating_sub(start_ms)),
                end_ms: None,
                confidence: None,
            },
        )?;
        written_segments += 1;
    }
    ensure_transcription_not_cancelled(cancellation.as_ref())?;

    let transcript = store.transcript(RecordingIdParams {
        recording_id: recording_id.to_string(),
    })?;
    let raw_text = raw_segments.join("\n");
    let normalized_text = normalized_segments.join("\n");
    let public_value = json!({
        "recordingId": recording_id,
        "engine": "whisper-rs",
        "model": verified_model.public_value(),
        "language": language,
        "channel": channel,
        "sourceChannels": source_channels,
        "audioDurationMs": duration_ms,
        "targetSampleRateHz": WHISPER_SAMPLE_RATE,
        "writtenSegmentCount": written_segments,
        "normalization": {
            "ruleSetId": replacement_rule_set.map(|set| set.id.as_str()),
            "ruleSetVersion": replacement_rule_set.map(|set| set.version),
            "automaticReplacementCount": automatic_replacement_count,
            "automaticChanges": automatic_changes,
            "protectedTermReviewRequired": !protected_term_matches.is_empty(),
            "protectedTermMatches": protected_term_matches,
            "protectedTermsAutoReplaced": false,
            "rulesAppliedInDeterministicOrder": true
        },
        "comparison": {
            "rawTextSha256": transcript_text_sha256(&raw_text),
            "normalizedTextSha256": transcript_text_sha256(&normalized_text),
            "rawTextBytes": raw_text.len(),
            "normalizedTextBytes": normalized_text.len(),
            "rawSegmentCount": raw_segments.len(),
            "normalizedSegmentCount": normalized_segments.len(),
            "changed": raw_text != normalized_text
        },
        "transcript": transcript,
        "localOnly": true,
        "cloudAi": false,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    });
    Ok(LocalTranscriptionExecution {
        public_value,
        raw_text,
    })
}

fn merge_replacement_changes(
    target: &mut Vec<ReplacementChange>,
    incoming: Vec<ReplacementChange>,
) {
    for change in incoming {
        if let Some(existing) = target.iter_mut().find(|existing| {
            existing.rule_id == change.rule_id && existing.rule_order == change.rule_order
        }) {
            existing.replacement_count = existing
                .replacement_count
                .saturating_add(change.replacement_count);
        } else {
            target.push(change);
        }
    }
    target.sort_by(|left, right| {
        left.rule_order
            .cmp(&right.rule_order)
            .then_with(|| left.rule_id.cmp(&right.rule_id))
    });
}

#[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
fn prepare_whisper_audio(tracks: Vec<PcmTrack>) -> Result<WhisperAudio, TranscriptionError> {
    if tracks.is_empty() {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_AUDIO_UNAVAILABLE",
            "recording has no audio tracks to transcribe",
        ));
    }
    if tracks.len() > 8 {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_AUDIO_SOURCE_LIMIT",
            "local transcription accepts at most eight aligned audio sources",
        ));
    }

    let source_channels = tracks
        .iter()
        .map(|track| track.channel.clone())
        .collect::<Vec<_>>();
    let duration_ms = tracks
        .iter()
        .map(|track| track.duration_ms)
        .max()
        .unwrap_or_default();
    if tracks.len() == 1 {
        let mut tracks = tracks;
        let track = tracks.remove(0);
        let samples = pcm16le_to_mono_16k(&track)?;
        return Ok(WhisperAudio {
            channel: track.channel,
            source_channels,
            duration_ms,
            samples,
        });
    }

    let mut mixed = Vec::<f32>::new();
    for track in &tracks {
        let samples = pcm16le_to_mono_16k(track)?;
        if mixed.len() < samples.len() {
            mixed.resize(samples.len(), 0.0);
        }
        for (index, sample) in samples.into_iter().enumerate() {
            mixed[index] += sample;
        }
    }
    for sample in &mut mixed {
        *sample = sample.clamp(-1.0, 1.0);
    }

    Ok(WhisperAudio {
        channel: "combined".to_string(),
        source_channels,
        duration_ms,
        samples: mixed,
    })
}

#[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
fn pcm16le_to_mono_16k(track: &PcmTrack) -> Result<Vec<f32>, TranscriptionError> {
    live_pcm16le_to_mono_16k(
        &track.pcm,
        track.sample_rate_hz,
        track.channel_count,
        track.bits_per_sample,
    )
}

#[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
pub(crate) fn live_pcm16le_to_mono_16k(
    pcm: &[u8],
    sample_rate_hz: u32,
    channel_count: u16,
    bits_per_sample: u16,
) -> Result<Vec<f32>, TranscriptionError> {
    if bits_per_sample != 16 {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_AUDIO_BITS_INVALID",
            "local speech recognition accepts PCM 16-bit audio",
        ));
    }
    if sample_rate_hz == 0 || channel_count == 0 {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_AUDIO_FORMAT_INVALID",
            "audio track has an invalid sample rate or channel count",
        ));
    }
    let frame_bytes = usize::from(channel_count).saturating_mul(2);
    if frame_bytes == 0 || !pcm.len().is_multiple_of(frame_bytes) {
        return Err(TranscriptionError::new(
            "TRANSCRIPTION_AUDIO_FRAME_INVALID",
            "audio track did not align to whole PCM frames",
        ));
    }

    let mut mono = Vec::with_capacity(pcm.len() / frame_bytes);
    for frame in pcm.chunks_exact(frame_bytes) {
        let mut sum = 0.0_f32;
        for channel in 0..usize::from(channel_count) {
            let offset = channel * 2;
            let sample = i16::from_le_bytes([frame[offset], frame[offset + 1]]) as f32 / 32768.0;
            sum += sample;
        }
        mono.push(sum / f32::from(channel_count));
    }

    if sample_rate_hz == WHISPER_SAMPLE_RATE {
        Ok(mono)
    } else {
        Ok(resample_linear(&mono, sample_rate_hz, WHISPER_SAMPLE_RATE))
    }
}

#[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
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

#[cfg(any(feature = "local-whisper", feature = "local-parakeet"))]
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
    fn combined_whisper_audio_retains_aligned_samples_from_each_source() {
        let mut microphone = track(pcm16le(&[8_192, 0]), 16_000, 1);
        microphone.channel = "mic".to_string();
        microphone.duration_ms = 2;
        let mut system = track(pcm16le(&[0, 4_096]), 16_000, 1);
        system.channel = "system".to_string();
        system.duration_ms = 2;

        let combined =
            prepare_whisper_audio(vec![microphone, system]).expect("combined Whisper audio");

        assert_eq!(combined.channel, "combined");
        assert_eq!(combined.source_channels, ["mic", "system"]);
        assert_eq!(combined.duration_ms, 2);
        assert_eq!(combined.samples.len(), 2);
        assert!((combined.samples[0] - 0.25).abs() < 0.0001);
        assert!((combined.samples[1] - 0.125).abs() < 0.0001);
    }

    #[test]
    fn combined_whisper_audio_clamps_summed_sources() {
        let mut microphone = track(pcm16le(&[30_000]), 16_000, 1);
        microphone.channel = "mic".to_string();
        let mut system = track(pcm16le(&[30_000]), 16_000, 1);
        system.channel = "system".to_string();

        let combined =
            prepare_whisper_audio(vec![microphone, system]).expect("combined Whisper audio");

        assert_eq!(combined.samples, [1.0]);
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
