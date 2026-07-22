#![recursion_limit = "256"]

mod ai_fallback_preference;
mod background_jobs;
mod bundled_ai_assets;
mod capture_service;
mod consent_store;
mod diarization_service;
mod dictionary_package;
mod dictionary_staging;
mod grounded_output;
mod job_manager;
mod live_asr_producer;
mod local_ai_service;
mod local_instruct_assets;
mod local_instruct_model;
mod local_model_scheduler;
mod media_decoder;
mod media_import;
mod media_import_service;
#[cfg(test)]
mod media_test_fixtures;
mod meeting_profiles;
mod model_manager;
mod os_key_store;
mod parakeet_package;
mod recording_store;
mod replacement_rules;
mod report_export;
mod terminology_dictionary;
mod transcription_quality;
mod transcription_service;
mod update_policy;
mod v2_importer;
mod vault_store;

use std::collections::{HashSet, VecDeque};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ai_fallback_preference::{
    AiFallbackPreferenceError, AiFallbackPreferenceService, AiFallbackPreferenceUpdateParams,
    AiJobIntent,
};
use background_jobs::{
    descriptor_for_ask, descriptor_for_cleanup, descriptor_for_dictionary_import,
    descriptor_for_export, descriptor_for_recording_recap, descriptor_for_transcription,
    processing_queue_failure, BackgroundJobServices,
};
use bundled_ai_assets::BundledAiAssets;
use candor_core::live_transcript_service::{LiveTranscriptService, LiveTranscriptServiceError};
use capture_service::{
    CaptureError, CaptureManager, CaptureStartMicAndSystemParams, CaptureStartParams,
    MicTestStartParams, SetPreferredMicrophoneParams,
};
use consent_store::{ConsentAcknowledgeParams, ConsentError, ConsentStore};
use diarization_service::{
    DiarizationAssignSpeakerNameParams, DiarizationPreferenceParams, DiarizationRecordingParams,
    DiarizationRemoveSpeakerNameParams, DiarizationService, DiarizationServiceError,
};
use dictionary_staging::DictionaryStaging;
use job_manager::{JobFailure, JobManager, JobManagerError};
use live_asr_producer::{LiveAsrProducerError, LiveAsrProducerManager};
use local_ai_service::{
    LocalAiError, LocalAiProofParams, LocalAiService, LocalAskParams, LocalRecapParams,
};
use local_instruct_assets::{
    InstructAssetError, InstructAssetImportParams, LocalInstructAssetManager,
};
use local_instruct_model::{
    LocalInstructAskParams, LocalInstructError, LocalInstructModelService, LocalInstructRecapParams,
};
use local_model_scheduler::LocalModelScheduler;
use media_import_service::{
    production_local_media_storage_supported, MediaImportService, MediaImportServiceError,
};
use meeting_profiles::{
    MeetingProcessingProfileSnapshot, MeetingProfileDeleteParams, MeetingProfileError,
    MeetingProfileGetParams, MeetingProfileSelectParams, MeetingProfileService,
    MeetingProfileUpsertParams, ProfileCaptureSource,
};
use model_manager::{
    ModelIdParams, ModelImportAbortParams, ModelImportChunkParams, ModelImportFinishParams,
    ModelImportStartParams, ModelManager, ModelManagerError, ModelProofParams,
};
use recording_store::{
    AudioChunkParams, ExportRecordingParams, RecordingIdParams, RecordingPageParams,
    RecordingStore, RecordingStoreError, ReprocessingPrepareParams, SaveNotesParams,
    SearchRecordingsParams, StartRecordingParams, TranscriptPageParams, TranscriptRevisionParams,
    WriteAudioChunkParams, WriteChunkParams, WriteTranscriptSegmentParams,
};
use replacement_rules::{
    ReplacementApplyParams, ReplacementPreviewParams, ReplacementRuleError, ReplacementRuleService,
    ReplacementRuleSetDeleteParams, ReplacementRuleSetGetParams, ReplacementRuleSetUpsertParams,
};
use serde::de::Error as SerdeDeError;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use terminology_dictionary::{
    TerminologyAssignParams, TerminologyDecisionParams, TerminologyError, TerminologyImportParams,
    TerminologyProposalParams, TerminologyService, TerminologySetEnabledParams,
    TerminologyStatusParams,
};
use transcription_quality::{
    TranscriptionBenchmarkMeasurement, TranscriptionBenchmarkParams, TranscriptionQualityError,
    TranscriptionQualityUpdateParams,
};
use transcription_service::{
    ProtectedTermApplyParams, ProtectedTermReviewParams, TranscriptionError,
    TranscriptionProofParams, TranscriptionRunLocalParams, TranscriptionService,
};
use update_policy::UpdatePolicy;
use v2_importer::{V2ImportError, V2ImportFolderParams, V2ImportProofParams, V2Importer};
use vault_store::{VaultOpenParams, VaultStore, VaultStoreError};

const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");
const PROTOCOL_VERSION: &str = "m0-jsonrpc-stdio-1";
const MEDIA_IMPORT_RECORDING_BARRIER_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RPC_LINE_BYTES: usize = 4_000_000;
const RECENT_REQUEST_ID_LIMIT: usize = 1_024;
const AUTOMATION_MODE_ENV: &str = "CANDOR_AUTOMATION_MODE";
const AUTOMATION_READ_ONLY_VALUE: &str = "read-only";
const AUTOMATION_READ_ONLY_METHODS: &[&str] = &[
    "recording.durable.listPage",
    "recording.durable.transcriptPage",
    "recording.durable.search",
    "core.shutdown",
];
static PROTOCOL_OUTPUT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
struct MediaLocalValidationSlot(Arc<AtomicBool>);

impl Drop for MediaLocalValidationSlot {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum MediaLocalValidationRunError {
    Busy,
    Timeout,
    Spawn,
    Disconnected,
}

fn run_bounded_media_local_validation<T, F>(
    active: Arc<AtomicBool>,
    timeout: Duration,
    operation: F,
) -> Result<T, MediaLocalValidationRunError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    if active
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(MediaLocalValidationRunError::Busy);
    }

    let (sender, receiver) = mpsc::sync_channel(1);
    let worker_active = Arc::clone(&active);
    if std::thread::Builder::new()
        .name("candor-media-local-validation".to_string())
        .spawn(move || {
            let _slot = MediaLocalValidationSlot(worker_active);
            let _ = sender.send(operation());
        })
        .is_err()
    {
        active.store(false, Ordering::SeqCst);
        return Err(MediaLocalValidationRunError::Spawn);
    }

    match receiver.recv_timeout(timeout) {
        Ok(value) => Ok(value),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(MediaLocalValidationRunError::Timeout),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(MediaLocalValidationRunError::Disconnected)
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcRequest {
    id: Value,
    #[serde(default)]
    protocol_version: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    sent_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveTranscriptRecordingParams {
    recording_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaImportPathParams {
    source_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaImportVerifiedPathParams {
    source_path: String,
    expected_source_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcResponse {
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    protocol_version: &'static str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Box<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Box<RpcError>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcError {
    code: &'static str,
    message: String,
    retryable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobIdParams {
    job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiRecapJobParams {
    recording_id: String,
    #[serde(default, deserialize_with = "deserialize_recap_template")]
    recap_template: Option<String>,
    #[serde(default)]
    intent: AiJobIntent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiCleanupJobParams {
    recording_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiAskJobParams {
    recording_id: String,
    question: String,
    #[serde(default)]
    intent: AiJobIntent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DictionaryPackageStartParams {
    source_file_name: String,
    archive_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreStatus {
    version: &'static str,
    protocol_version: &'static str,
    pid: u32,
    uptime_ms: u128,
    network_policy: &'static str,
    updater_policy: &'static str,
    vault_state: &'static str,
    sidecar_transport: &'static str,
    startup_recovery: StartupRecoveryStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupRecoveryStatus {
    attempted: bool,
    ok: bool,
    recovered_count: u64,
    completed_deletion_count: u64,
    pending_deletion_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
    raw_path_exposed: bool,
}

#[derive(Default)]
struct RecentRequestIds {
    order: VecDeque<String>,
    seen: HashSet<String>,
}

impl RecentRequestIds {
    fn insert(&mut self, id: &Value) -> bool {
        let key = serde_json::to_string(id).unwrap_or_else(|_| "null".to_string());
        if !self.seen.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        if self.order.len() > RECENT_REQUEST_ID_LIMIT {
            if let Some(expired) = self.order.pop_front() {
                self.seen.remove(&expired);
            }
        }
        true
    }
}

struct CoreState {
    started_at_ms: u128,
    automation_read_only: bool,
    ai_fallback_preference: AiFallbackPreferenceService,
    bundled_ai_assets: BundledAiAssets,
    capture_manager: CaptureManager,
    consent_store: ConsentStore,
    diarization_service: DiarizationService,
    dictionary_staging: DictionaryStaging,
    local_ai_service: LocalAiService,
    local_instruct_assets: LocalInstructAssetManager,
    local_instruct_model: LocalInstructModelService,
    live_transcript: LiveTranscriptService,
    live_asr_producer: LiveAsrProducerManager,
    media_import: MediaImportService,
    media_local_validation_active: Arc<AtomicBool>,
    meeting_profiles: MeetingProfileService,
    job_manager: JobManager,
    model_manager: ModelManager,
    model_scheduler: LocalModelScheduler,
    recording_store: RecordingStore,
    replacement_rules: ReplacementRuleService,
    recent_request_ids: RecentRequestIds,
    shutdown_requested: bool,
    startup_recovery: StartupRecoveryStatus,
    terminology_service: TerminologyService,
    transcription_service: TranscriptionService,
    update_policy: UpdatePolicy,
    v2_importer: V2Importer,
    vault_store: VaultStore,
}

impl CoreState {
    fn new(started_at_ms: u128) -> Self {
        let automation_read_only = std::env::var(AUTOMATION_MODE_ENV)
            .is_ok_and(|value| value == AUTOMATION_READ_ONLY_VALUE);
        let recording_store = RecordingStore::from_env();
        let vault_store = VaultStore::from_env();
        let bundled_ai_assets = BundledAiAssets::from_env();
        let startup_recovery_result = (!automation_read_only).then(|| recording_store.recover());
        let startup_recovery = skipped_startup_recovery_status();
        let instruct_assets_root = recording_store.models_root_for_core().join("instruct");
        let transcription_quality_root = recording_store
            .settings_root_for_core()
            .join("transcription");
        let capture_preferences_root = recording_store.settings_root_for_core().join("capture");
        let media_import = MediaImportService::with_staging_root(
            recording_store
                .local_data_root_for_core()
                .join("private-media-staging"),
        );
        let diarization_service = DiarizationService::with_roots(
            recording_store.settings_root_for_core().join("diarization"),
            recording_store.key_root_for_core(),
        );
        let meeting_profiles = MeetingProfileService::with_root(
            recording_store
                .settings_root_for_core()
                .join("meeting-profiles"),
        );
        let replacement_rules = ReplacementRuleService::with_root(
            recording_store
                .settings_root_for_core()
                .join("replacement-rules"),
        );
        let ai_fallback_preference = AiFallbackPreferenceService::with_root(
            recording_store.settings_root_for_core().join("local-ai"),
        );
        let terminology_service = TerminologyService::with_roots(
            recording_store.settings_root_for_core().join("terminology"),
            recording_store.key_root_for_core(),
        );
        let dictionary_staging = DictionaryStaging::with_roots(
            recording_store
                .settings_root_for_core()
                .join("dictionary-staging"),
            recording_store.key_root_for_core(),
        );
        let job_manager = if automation_read_only {
            JobManager::in_memory(PROTOCOL_VERSION)
        } else {
            JobManager::with_roots_and_staging(
                PROTOCOL_VERSION,
                recording_store
                    .settings_root_for_core()
                    .join("background-jobs"),
                recording_store.key_root_for_core(),
                &dictionary_staging,
            )
        };
        if !automation_read_only {
            maintain_dictionary_staging(&job_manager, &dictionary_staging);
            #[cfg(not(test))]
            start_dictionary_staging_maintenance(job_manager.clone(), dictionary_staging.clone());
        }
        let mut state = Self {
            started_at_ms,
            automation_read_only,
            ai_fallback_preference,
            bundled_ai_assets: bundled_ai_assets.clone(),
            capture_manager: CaptureManager::with_preferences_root(capture_preferences_root),
            consent_store: ConsentStore::from_env(),
            diarization_service,
            dictionary_staging,
            local_ai_service: LocalAiService,
            local_instruct_assets: LocalInstructAssetManager::with_root(
                instruct_assets_root.clone(),
            ),
            local_instruct_model: LocalInstructModelService::with_sources_and_terminology(
                instruct_assets_root,
                bundled_ai_assets.clone(),
                terminology_service.clone(),
            ),
            live_transcript: LiveTranscriptService::new(),
            live_asr_producer: LiveAsrProducerManager::default(),
            media_import,
            media_local_validation_active: Arc::new(AtomicBool::new(false)),
            meeting_profiles,
            job_manager,
            model_manager: ModelManager::with_bundled_assets(bundled_ai_assets),
            model_scheduler: LocalModelScheduler::default(),
            recording_store,
            replacement_rules,
            recent_request_ids: RecentRequestIds::default(),
            shutdown_requested: false,
            startup_recovery,
            terminology_service: terminology_service.clone(),
            transcription_service: TranscriptionService::with_quality_and_terminology(
                transcription_quality_root,
                terminology_service,
            ),
            update_policy: UpdatePolicy,
            v2_importer: V2Importer,
            vault_store,
        };
        if !automation_read_only {
            if let Some(result) = startup_recovery_result {
                let reconciled = result.map(|value| {
                    let value = reconcile_recovered_deletions(value, &state);
                    let _ = state
                        .job_manager
                        .resolve_media_import_cleanup_after_recovery(&value);
                    value
                });
                state.startup_recovery = startup_recovery_status(reconciled);
            }
            let background_services = state.background_job_services();
            let _ = background_services.ensure_bundled_general_dictionary();
            state.job_manager.recover(background_services.executor());
        }
        state
    }

    #[cfg(test)]
    fn with_stores(
        started_at_ms: u128,
        recording_store: RecordingStore,
        vault_store: VaultStore,
    ) -> Self {
        Self::with_stores_mode(started_at_ms, recording_store, vault_store, false)
    }

    #[cfg(test)]
    fn with_stores_mode(
        started_at_ms: u128,
        recording_store: RecordingStore,
        vault_store: VaultStore,
        automation_read_only: bool,
    ) -> Self {
        let consent_root = recording_store
            .local_data_root_for_core()
            .join("consent-state");
        let startup_recovery_result = (!automation_read_only).then(|| recording_store.recover());
        let startup_recovery = skipped_startup_recovery_status();
        let instruct_assets_root = recording_store.models_root_for_core().join("instruct");
        let transcription_quality_root = recording_store
            .settings_root_for_core()
            .join("transcription");
        let capture_preferences_root = recording_store.settings_root_for_core().join("capture");
        let media_import = MediaImportService::with_staging_root(
            recording_store
                .local_data_root_for_core()
                .join("private-media-staging"),
        );
        let diarization_service = DiarizationService::with_test_roots(
            recording_store.settings_root_for_core().join("diarization"),
            recording_store.key_root_for_core(),
        );
        let meeting_profiles = MeetingProfileService::with_root(
            recording_store
                .settings_root_for_core()
                .join("meeting-profiles"),
        );
        let replacement_rules = ReplacementRuleService::with_root(
            recording_store
                .settings_root_for_core()
                .join("replacement-rules"),
        );
        let ai_fallback_preference = AiFallbackPreferenceService::with_root(
            recording_store.settings_root_for_core().join("local-ai"),
        );
        let terminology_service = TerminologyService::with_roots(
            recording_store.settings_root_for_core().join("terminology"),
            recording_store.key_root_for_core(),
        );
        let dictionary_staging = DictionaryStaging::with_test_roots(
            recording_store
                .settings_root_for_core()
                .join("dictionary-staging"),
            recording_store.key_root_for_core(),
        );
        let bundled_ai_assets = BundledAiAssets::disabled();
        let job_manager = if automation_read_only {
            JobManager::in_memory(PROTOCOL_VERSION)
        } else {
            JobManager::with_test_roots_and_staging(
                PROTOCOL_VERSION,
                recording_store
                    .settings_root_for_core()
                    .join("background-jobs"),
                recording_store.key_root_for_core(),
                &dictionary_staging,
            )
        };
        if !automation_read_only {
            maintain_dictionary_staging(&job_manager, &dictionary_staging);
        }
        let mut state = Self {
            started_at_ms,
            automation_read_only,
            ai_fallback_preference,
            bundled_ai_assets: bundled_ai_assets.clone(),
            capture_manager: CaptureManager::with_preferences_root(capture_preferences_root),
            consent_store: ConsentStore::with_root(consent_root),
            diarization_service,
            dictionary_staging,
            local_ai_service: LocalAiService,
            local_instruct_assets: LocalInstructAssetManager::with_root(
                instruct_assets_root.clone(),
            ),
            local_instruct_model: LocalInstructModelService::with_sources_and_terminology(
                instruct_assets_root,
                bundled_ai_assets.clone(),
                terminology_service.clone(),
            ),
            live_transcript: LiveTranscriptService::new(),
            live_asr_producer: LiveAsrProducerManager::default(),
            media_import,
            media_local_validation_active: Arc::new(AtomicBool::new(false)),
            meeting_profiles,
            job_manager,
            model_manager: ModelManager::with_bundled_assets(bundled_ai_assets),
            model_scheduler: LocalModelScheduler::default(),
            recording_store,
            replacement_rules,
            recent_request_ids: RecentRequestIds::default(),
            shutdown_requested: false,
            startup_recovery,
            terminology_service: terminology_service.clone(),
            transcription_service: TranscriptionService::with_quality_and_terminology(
                transcription_quality_root,
                terminology_service,
            ),
            update_policy: UpdatePolicy,
            v2_importer: V2Importer,
            vault_store,
        };
        if !automation_read_only {
            if let Some(result) = startup_recovery_result {
                let reconciled = result.map(|value| {
                    let value = reconcile_recovered_deletions(value, &state);
                    let _ = state
                        .job_manager
                        .resolve_media_import_cleanup_after_recovery(&value);
                    value
                });
                state.startup_recovery = startup_recovery_status(reconciled);
            }
            let background_services = state.background_job_services();
            let _ = background_services.ensure_bundled_general_dictionary();
            state.job_manager.recover(background_services.executor());
        }
        state
    }

    fn background_job_services(&self) -> BackgroundJobServices {
        BackgroundJobServices::new(
            self.bundled_ai_assets.clone(),
            self.model_manager.clone(),
            self.recording_store.clone(),
            self.dictionary_staging.clone(),
            self.terminology_service.clone(),
            self.transcription_service.clone(),
            self.live_transcript.clone(),
        )
    }
}

fn maintain_dictionary_staging(job_manager: &JobManager, staging: &DictionaryStaging) {
    if let Ok(tokens) = job_manager.apply_retention() {
        for token in tokens {
            let _ = staging.delete(&token);
        }
    }
    let references = job_manager.dictionary_staging_references();
    let _ = staging.cleanup_orphans(&references);
}

#[cfg(not(test))]
fn start_dictionary_staging_maintenance(job_manager: JobManager, staging: DictionaryStaging) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60 * 60));
        maintain_dictionary_staging(&job_manager, &staging);
    });
}

fn startup_recovery_status(result: Result<Value, RecordingStoreError>) -> StartupRecoveryStatus {
    match result {
        Ok(value) => StartupRecoveryStatus {
            attempted: true,
            ok: true,
            recovered_count: value
                .get("recoveredCount")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            completed_deletion_count: value
                .get("completedDeletionCount")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            pending_deletion_count: value
                .get("pendingDeletionCount")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            error_code: None,
            raw_path_exposed: false,
        },
        Err(error) => StartupRecoveryStatus {
            attempted: true,
            ok: false,
            recovered_count: 0,
            completed_deletion_count: 0,
            pending_deletion_count: 0,
            error_code: Some(error.code),
            raw_path_exposed: false,
        },
    }
}

fn skipped_startup_recovery_status() -> StartupRecoveryStatus {
    StartupRecoveryStatus {
        attempted: false,
        ok: true,
        recovered_count: 0,
        completed_deletion_count: 0,
        pending_deletion_count: 0,
        error_code: None,
        raw_path_exposed: false,
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

fn core_build_features() -> Vec<&'static str> {
    let mut features = Vec::new();
    if cfg!(feature = "sqlcipher-vault") {
        features.push("sqlcipher-vault");
    }
    if cfg!(feature = "local-whisper") {
        features.push("local-whisper");
    }
    features
}

fn network_capability_matrix() -> Value {
    json!({
        "policy": "disabled-by-default",
        "externalCallsAttempted": 0,
        "capabilities": [
            {
                "id": "recording",
                "label": "Recording",
                "mode": "denied",
                "trigger": "never",
                "owner": "candor-core"
            },
            {
                "id": "transcription",
                "label": "Transcription",
                "mode": "denied",
                "trigger": "never",
                "owner": "candor-core"
            },
            {
                "id": "local-ai",
                "label": "Local AI",
                "mode": "denied",
                "trigger": "never",
                "owner": "candor-core"
            },
            {
                "id": "license",
                "label": "License activation",
                "mode": "local-only",
                "trigger": "explicit-user-action",
                "owner": "electron-main"
            },
            {
                "id": "updates",
                "label": "Update check",
                "mode": "disabled",
                "trigger": "explicit-user-action-not-implemented",
                "owner": "electron-main"
            }
        ],
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn make_error(id: Value, code: &'static str, message: impl Into<String>) -> RpcResponse {
    make_error_with_retryability(id, code, message, false)
}

fn make_error_with_retryability(
    id: Value,
    code: &'static str,
    message: impl Into<String>,
    retryable: bool,
) -> RpcResponse {
    RpcResponse {
        id,
        request_id: None,
        protocol_version: PROTOCOL_VERSION,
        ok: false,
        result: None,
        error: Some(Box::new(RpcError {
            code,
            message: message.into(),
            retryable,
        })),
    }
}

fn make_recording_error(id: Value, error: RecordingStoreError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn finalized_capture_recording_id(value: &Value) -> Option<String> {
    let capture = value.get("capture")?.as_object()?;
    if capture.get("integrityStatus")?.as_str()? != "verified" {
        return None;
    }
    capture
        .get("recordingId")?
        .as_str()
        .filter(|recording_id| !recording_id.is_empty())
        .map(str::to_string)
}

fn make_capture_error(id: Value, error: CaptureError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_consent_error(id: Value, error: ConsentError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_vault_error(id: Value, error: VaultStoreError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_transcription_error(id: Value, error: TranscriptionError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_transcription_quality_error(id: Value, error: TranscriptionQualityError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_ai_fallback_preference_error(id: Value, error: AiFallbackPreferenceError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_terminology_error(id: Value, error: TerminologyError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn deserialize_recap_template<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > 4_096
        || trimmed.chars().any(|character| {
            character == '\0'
                || (character.is_control()
                    && character != '\n'
                    && character != '\r'
                    && character != '\t')
        })
    {
        return Err(SerdeDeError::custom(
            "recapTemplate must contain at most 4096 bytes of safe text",
        ));
    }
    Ok(Some(trimmed.to_string()))
}

fn make_meeting_profile_error(id: Value, error: MeetingProfileError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_media_import_error(id: Value, error: MediaImportServiceError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_diarization_error(id: Value, error: DiarizationServiceError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_live_transcript_error(id: Value, error: LiveTranscriptServiceError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_live_asr_error(id: Value, error: LiveAsrProducerError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_replacement_rule_error(id: Value, error: ReplacementRuleError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_model_error(id: Value, error: ModelManagerError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_local_ai_error(id: Value, error: LocalAiError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_local_instruct_error(id: Value, error: LocalInstructError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_instruct_asset_error(id: Value, error: InstructAssetError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_v2_import_error(id: Value, error: V2ImportError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn make_job_error(id: Value, error: JobManagerError) -> RpcResponse {
    make_error(id, error.code, error.message)
}

fn rollback_failed_capture_start(job_manager: &JobManager, recording_priority_acquired: bool) {
    if recording_priority_acquired {
        job_manager.set_recording_active(false);
    }
}

fn decode_params<T>(id: Value, params: Value) -> Result<T, RpcResponse>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value::<T>(params).map_err(|_| {
        make_error(
            id,
            "INVALID_PARAMS",
            "request parameters did not match the operation contract",
        )
    })
}

fn capture_processing_profile(
    state: &CoreState,
    profile_id: Option<&str>,
    profile_version: Option<u32>,
    capture_source: ProfileCaptureSource,
) -> Result<MeetingProcessingProfileSnapshot, MeetingProfileError> {
    match (profile_id, profile_version) {
        (Some(profile_id), Some(profile_version)) => {
            state.meeting_profiles.processing_snapshot_for_capture(
                profile_id,
                profile_version,
                capture_source,
                &state.replacement_rules,
            )
        }
        (None, None) => state
            .meeting_profiles
            .active_processing_snapshot_for_capture(capture_source, &state.replacement_rules),
        _ => Err(MeetingProfileError {
            code: "MEETING_PROFILE_BINDING_INCOMPLETE",
            message: "capture requires both a meeting profile id and version".to_string(),
        }),
    }
}

fn handle_request(req: RpcRequest, state: &mut CoreState) -> RpcResponse {
    let id = req.id.clone();
    if state.automation_read_only && !AUTOMATION_READ_ONLY_METHODS.contains(&req.method.as_str()) {
        return make_error(
            id,
            "METHOD_NOT_ALLOWED",
            "Method is unavailable in the read-only automation core",
        );
    }
    let result = match req.method.as_str() {
        "core.ping" => json!({ "pong": true }),
        "core.version" => json!({
            "version": CORE_VERSION,
            "protocolVersion": PROTOCOL_VERSION,
            "schemaVersion": 1,
            "capabilities": [
                "stdio-json-lines",
                "durable-recording",
                "encrypted-local-vault",
                "local-transcription",
                "local-ai",
                "bundled-local-ai-assets"
            ],
            "build": {
                "commit": option_env!("CANDOR_BUILD_COMMIT"),
                "target": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
                "features": core_build_features()
            }
        }),
        "core.capabilities" => json!({
            "transport": "stdio-json-lines",
            "maxRpcFrameBytes": MAX_RPC_LINE_BYTES,
            "allowedMethods": [
                "core.ping",
                "core.version",
                "core.capabilities",
                "core.status",
                "core.shutdown",
                "vault.status",
                "vault.openLocal",
                "vault.openLocalProof",
                "vault.openWithOsKeyProof",
                "vault.proofWrongKeyFails",
                "vault.proofOsKeyStorage",
                "vault.proofPassphraseFallback",
                "privacy.auditSnapshot",
                "privacy.capabilities",
                "updates.status",
                "import.v2.status",
                "import.v2.fromFolder",
                "import.v2.startFromFolder",
                "import.v2.proofSynthetic",
                "media.importStatus",
                "media.validateLocalSourcePath",
                "media.importFromPath",
                "consent.status",
                "consent.acknowledge",
                "capture.status",
                "capture.devices",
                "capture.preferences",
                "capture.setPreferredMicrophone",
                "capture.micTestStart",
                "capture.micTestStatus",
                "capture.micTestSample",
                "capture.micTestStop",
                "capture.startMic",
                "capture.startSystem",
                "capture.startMicAndSystem",
                "capture.stop",
                "capture.proofSynthetic",
                "capture.proofSerializedWriter",
                "capture.proofInterruptedSerializedWriter",
                "models.status",
                "models.listLocal",
                "models.verifyLocal",
                "models.verify.start",
                "models.importStart",
                "models.importChunk",
                "models.importFinish",
                "models.importFinish.start",
                "models.importAbort",
                "models.proofSynthetic",
                "ai.status",
                "ai.bundledAssetsStatus",
                "ai.askHeuristic",
                "ai.recapHeuristic",
                "ai.instructStatus",
                "ai.instructAssetsStatus",
                "ai.fallbackPreference.status",
                "ai.fallbackPreference.update",
                "ai.instructAssetsImportFromPath",
                "ai.instructAssetsImport.start",
                "ai.proofInstructPreflight",
                "ai.recapInstruct",
                "ai.askInstruct",
                "ai.schedulerStatus",
                "ai.proofHeuristicAsk",
                "ai.proofHeuristicRecap",
                "ai.proofSchedulerBusy",
                "ai.ask.start",
                "ai.cleanup.start",
                "ai.recap.start",
                "transcription.status",
                "transcription.quality.status",
                "transcription.quality.update",
                "transcription.quality.benchmark.start",
                "liveTranscript.enable",
                "liveTranscript.start",
                "liveTranscript.snapshot",
                "liveTranscript.clear",
                "liveTranscript.stop",
                "liveTranscript.eventsDrain",
                "diarization.status",
                "diarization.updatePreference",
                "diarization.speakerNames",
                "diarization.assignSpeakerName",
                "diarization.removeSpeakerName",
                "profiles.list",
                "profiles.get",
                "profiles.upsert",
                "profiles.delete",
                "profiles.select",
                "replacements.list",
                "replacements.get",
                "replacements.upsert",
                "replacements.delete",
                "replacements.preview",
                "replacements.apply",
                "terminology.status",
                "terminology.import",
                "terminology.package.start",
                "terminology.setEnabled",
                "terminology.assign",
                "terminology.proposals",
                "terminology.decide",
                "transcription.runLocal",
                "transcription.start",
                "transcription.proofSynthetic",
                "transcription.protectedTermReview",
                "transcription.applyProtectedTermReview",
                "jobs.list",
                "jobs.activeSummary",
                "jobs.get",
                "jobs.cancel",
                "jobs.cancelAll",
                "jobs.pauseAll",
                "jobs.retry",
                "jobs.acknowledge",
                "recording.durable.status",
                "recording.durable.start",
                "recording.durable.writeTextChunk",
                "recording.durable.writeTranscriptSegment",
                "recording.durable.writeAudioChunk",
                "recording.durable.finish",
                "recording.durable.delete",
                "recording.durable.recover",
                "recording.durable.list",
                "recording.durable.listPage",
                "recording.durable.read",
                "recording.durable.replayManifest",
                "recording.durable.transcript",
                "recording.durable.transcriptPage",
                "recording.trustHistory",
                "recording.transcriptRevision",
                "recording.selectTranscriptRevision",
                "recording.privacyReceipt",
                "recording.durable.readAudioChunk",
                "recording.durable.search",
                "recording.notes.read",
                "recording.notes.save",
                "transcription.prepareReprocess",
                "retention.status",
                "recording.index.status",
                "export.create",
                "export.start"
            ],
            "deniedCapabilities": [
                "arbitraryFilesystem",
                "arbitraryProcessExecution",
                "rendererVaultKeys",
                "rendererRawPaths",
                "rendererVaultPassphrases",
                "localhostTcp",
                "cloudAi",
                "backgroundModelDownload",
                "autoUpdater",
                "crashReporter"
            ]
        }),
        "core.status" => {
            let status = CoreStatus {
                version: CORE_VERSION,
                protocol_version: PROTOCOL_VERSION,
                pid: process::id(),
                uptime_ms: now_ms().saturating_sub(state.started_at_ms),
                network_policy: "disabled-by-default",
                updater_policy: "manual-check-only-disabled-in-m0",
                vault_state: state.vault_store.core_status_label(),
                sidecar_transport: "stdio-json-lines",
                startup_recovery: state.startup_recovery.clone(),
            };
            serde_json::to_value(status).unwrap_or_else(|_| json!({}))
        }
        "vault.status" => state.vault_store.status(),
        "vault.openLocal" => match state.vault_store.open_local() {
            Ok(value) => value,
            Err(error) => return make_vault_error(id, error),
        },
        "vault.openLocalProof" => {
            let params = match decode_params::<VaultOpenParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.vault_store.open_or_create(params) {
                Ok(value) => value,
                Err(error) => return make_vault_error(id, error),
            }
        }
        "vault.proofWrongKeyFails" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct ProofParams {
                correct_passphrase: String,
                wrong_passphrase: String,
            }
            let params = match decode_params::<ProofParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.vault_store.proof_wrong_key_fails(
                VaultOpenParams {
                    passphrase: params.correct_passphrase,
                },
                VaultOpenParams {
                    passphrase: params.wrong_passphrase,
                },
            ) {
                Ok(value) => value,
                Err(error) => return make_vault_error(id, error),
            }
        }
        "vault.proofOsKeyStorage" => match state.vault_store.proof_os_key_storage() {
            Ok(value) => value,
            Err(error) => return make_vault_error(id, error),
        },
        "vault.proofPassphraseFallback" => match state.vault_store.proof_passphrase_fallback() {
            Ok(value) => value,
            Err(error) => return make_vault_error(id, error),
        },
        "vault.openWithOsKeyProof" => match state.vault_store.open_with_os_key_proof() {
            Ok(value) => value,
            Err(error) => return make_vault_error(id, error),
        },
        "privacy.auditSnapshot" => json!({
            "networkPolicy": "disabled-by-default",
            "externalCallsAttempted": 0,
            "autoUpdate": "disabled",
            "crashReporter": "disabled",
            "cloudAi": "disabled",
            "recordedAt": now_ms()
        }),
        "privacy.capabilities" => network_capability_matrix(),
        "updates.status" => state.update_policy.status(),
        "import.v2.status" => state.v2_importer.status(),
        "import.v2.fromFolder" => {
            let params = match decode_params::<V2ImportFolderParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .v2_importer
                .import_folder(&state.recording_store, params)
            {
                Ok(value) => annotate_import_result(value, state),
                Err(error) => return make_v2_import_error(id, error),
            }
        }
        "import.v2.startFromFolder" => {
            let params = match decode_params::<V2ImportFolderParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let store = state.recording_store.clone();
            match state
                .job_manager
                .submit("legacy-import", false, move |context| {
                    context.progress("scanning", 0, Some(2), Some("stage"));
                    let value = V2Importer
                        .import_folder(&store, params)
                        .map_err(|error| JobFailure::new(error.code, error.message, true))?;
                    context.progress("committing", 1, Some(2), Some("stage"));
                    Ok(value)
                }) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "import.v2.proofSynthetic" => {
            let params = match decode_params::<V2ImportProofParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .v2_importer
                .proof_synthetic(&state.recording_store, params)
            {
                Ok(value) => annotate_import_result(value, state),
                Err(error) => return make_v2_import_error(id, error),
            }
        }
        "media.importStatus" => json!({
            "implemented": production_local_media_storage_supported(),
            "supportedContainers": ["wav", "mp3", "m4a", "mp4", "webm"],
            "nativeImportReady": ["wav-pcm16", "mp3", "m4a-aac-lc", "m4a-alac", "mp4-aac-lc", "mp4-alac", "webm-vorbis"],
            "decoderUnavailable": ["webm-opus", "video-only", "unsupported-container-codec"],
            "pickerOwnedByMainProcess": true,
            "rendererPathAccepted": false,
            "localOnly": true,
            "networkAttempted": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }),
        "media.validateLocalSourcePath" => {
            if state.capture_manager.is_active() {
                return make_error(
                    id,
                    "MEDIA_IMPORT_CAPTURE_ACTIVE",
                    "media cannot be validated while a recording is active",
                );
            }
            let params = match decode_params::<MediaImportPathParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let media_import = state.media_import.clone();
            let source_path = PathBuf::from(params.source_path);
            match run_bounded_media_local_validation(
                Arc::clone(&state.media_local_validation_active),
                Duration::from_secs(3),
                move || media_import.validate_local_source_path(source_path),
            ) {
                Ok(Ok(value)) => json!(value),
                Ok(Err(error)) => return make_media_import_error(id, error),
                Err(MediaLocalValidationRunError::Busy) => {
                    return make_error(
                        id,
                        "MEDIA_IMPORT_LOCAL_VALIDATION_BUSY",
                        "another local media eligibility validation is still running",
                    )
                }
                Err(MediaLocalValidationRunError::Timeout) => {
                    return make_error(
                        id,
                        "MEDIA_IMPORT_LOCAL_VALIDATION_TIMEOUT",
                        "local media eligibility validation exceeded its fixed time limit",
                    )
                }
                Err(
                    MediaLocalValidationRunError::Spawn
                    | MediaLocalValidationRunError::Disconnected,
                ) => {
                    return make_error(
                        id,
                        "MEDIA_IMPORT_LOCAL_VALIDATION_FAILED",
                        "local media eligibility validation could not complete",
                    )
                }
            }
        }
        "media.importFromPath" => {
            if state.capture_manager.is_active() {
                return make_error(
                    id,
                    "MEDIA_IMPORT_CAPTURE_ACTIVE",
                    "media cannot be imported while a recording is active",
                );
            }
            let params =
                match decode_params::<MediaImportVerifiedPathParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            let store = state.recording_store.clone();
            let media_import = state.media_import.clone();
            let source_path = PathBuf::from(params.source_path);
            let expected_source_sha256 = params.expected_source_sha256;
            // Mark it exclusive so capture activation signals cancellation. The import
            // service rolls back partial durable data before the import job reports a
            // terminal state.
            match state
                .job_manager
                .submit("media-import", true, move |context| {
                    context.progress("validating", 0, Some(3), Some("stage"));
                    let cancellation = context.cancellation_flag();
                    context.progress("decoding", 1, Some(3), Some("stage"));
                    let value = media_import
                        .import_source_cancellable(
                            &store,
                            source_path,
                            expected_source_sha256,
                            cancellation.as_ref(),
                        )
                        .map_err(|error| JobFailure::new(error.code, error.message, false))?;
                    context.progress("committing", 2, Some(3), Some("stage"));
                    Ok(json!(value))
                }) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "consent.status" => match state.consent_store.status() {
            Ok(value) => value,
            Err(error) => return make_consent_error(id, error),
        },
        "consent.acknowledge" => {
            let params = match decode_params::<ConsentAcknowledgeParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.consent_store.acknowledge(params) {
                Ok(value) => value,
                Err(error) => return make_consent_error(id, error),
            }
        }
        "capture.status" => state.capture_manager.status(),
        "capture.devices" => state.capture_manager.devices(),
        "capture.preferences" => state.capture_manager.preferences(),
        "capture.setPreferredMicrophone" => {
            let params = match decode_params::<SetPreferredMicrophoneParams>(id.clone(), req.params)
            {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.capture_manager.set_preferred_microphone(params) {
                Ok(value) => value,
                Err(error) => return make_capture_error(id, error),
            }
        }
        "capture.micTestStart" => {
            let params = match decode_params::<MicTestStartParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.capture_manager.mic_test_start(params) {
                Ok(value) => value,
                Err(error) => return make_capture_error(id, error),
            }
        }
        "capture.micTestStatus" => state.capture_manager.mic_test_status(),
        "capture.micTestSample" => match state.capture_manager.mic_test_sample() {
            Ok(value) => value,
            Err(error) => return make_capture_error(id, error),
        },
        "capture.micTestStop" => match state.capture_manager.mic_test_stop() {
            Ok(value) => value,
            Err(error) => return make_capture_error(id, error),
        },
        "capture.startMic" => {
            let params = match decode_params::<CaptureStartParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            if let Err(error) = state.consent_store.require_mic_recording() {
                return make_consent_error(id, error);
            }
            let processing_profile = match capture_processing_profile(
                state,
                params.profile_id.as_deref(),
                params.profile_version,
                ProfileCaptureSource::Microphone,
            ) {
                Ok(profile) => profile,
                Err(error) => return make_meeting_profile_error(id, error),
            };
            let recording_priority_acquired = match state
                .job_manager
                .begin_recording_priority(MEDIA_IMPORT_RECORDING_BARRIER_TIMEOUT)
            {
                Ok(acquired) => acquired,
                Err(error) => return make_job_error(id, error),
            };
            match state.capture_manager.start_mic_with_processing_profile(
                state.recording_store.clone(),
                params,
                Some(processing_profile),
            ) {
                Ok(value) => value,
                Err(error) => {
                    rollback_failed_capture_start(&state.job_manager, recording_priority_acquired);
                    return make_capture_error(id, error);
                }
            }
        }
        "capture.startSystem" => {
            let params = match decode_params::<CaptureStartParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            if let Err(error) = state.consent_store.require_system_audio_recording() {
                return make_consent_error(id, error);
            }
            let processing_profile = match capture_processing_profile(
                state,
                params.profile_id.as_deref(),
                params.profile_version,
                ProfileCaptureSource::SystemAudio,
            ) {
                Ok(profile) => profile,
                Err(error) => return make_meeting_profile_error(id, error),
            };
            let recording_priority_acquired = match state
                .job_manager
                .begin_recording_priority(MEDIA_IMPORT_RECORDING_BARRIER_TIMEOUT)
            {
                Ok(acquired) => acquired,
                Err(error) => return make_job_error(id, error),
            };
            match state.capture_manager.start_system_with_processing_profile(
                state.recording_store.clone(),
                params,
                Some(processing_profile),
            ) {
                Ok(value) => value,
                Err(error) => {
                    rollback_failed_capture_start(&state.job_manager, recording_priority_acquired);
                    return make_capture_error(id, error);
                }
            }
        }
        "capture.startMicAndSystem" => {
            let params =
                match decode_params::<CaptureStartMicAndSystemParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            if let Err(error) = state.consent_store.require_mic_and_system_audio_recording() {
                return make_consent_error(id, error);
            }
            let processing_profile = match capture_processing_profile(
                state,
                params.profile_id.as_deref(),
                params.profile_version,
                ProfileCaptureSource::Combined,
            ) {
                Ok(profile) => profile,
                Err(error) => return make_meeting_profile_error(id, error),
            };
            let recording_priority_acquired = match state
                .job_manager
                .begin_recording_priority(MEDIA_IMPORT_RECORDING_BARRIER_TIMEOUT)
            {
                Ok(acquired) => acquired,
                Err(error) => return make_job_error(id, error),
            };
            match state
                .capture_manager
                .start_mic_and_system_with_processing_profile(
                    state.recording_store.clone(),
                    params,
                    Some(processing_profile),
                ) {
                Ok(value) => value,
                Err(error) => {
                    rollback_failed_capture_start(&state.job_manager, recording_priority_acquired);
                    return make_capture_error(id, error);
                }
            }
        }
        "capture.stop" => {
            let stopping_recording_id = state.capture_manager.request_stop();
            let live_asr_stop = stopping_recording_id
                .as_deref()
                .map(|recording_id| state.live_asr_producer.stop(recording_id));
            if let Some(recording_id) = stopping_recording_id.as_deref() {
                let _ = state.live_transcript.producer_stopped(recording_id);
            }
            match state.capture_manager.stop(&state.recording_store) {
                Ok(mut value) => {
                    if let (Some(root), Some(outcome)) =
                        (value.as_object_mut(), live_asr_stop.as_ref())
                    {
                        root.insert(
                            "liveTranscriptProducer".to_string(),
                            json!({
                                "workerFound": outcome.worker_found,
                                "cancellationRequested": outcome.cancellation_requested,
                                "joinedWithinBudget": outcome.joined_within_budget,
                                "joinDeferred": outcome.join_deferred,
                                "joinBudgetMs": 250,
                                "droppedPcmChunkCount": outcome.dropped_pcm_chunk_count,
                                "failureCode": outcome.failure_code,
                                "provisionalDurableWrites": false,
                                "rawPathExposed": false,
                                "keyMaterialExposedToRenderer": false
                            }),
                        );
                    }
                    let recording_id = finalized_capture_recording_id(&value);
                    if recording_id.is_some() {
                        state.job_manager.set_recording_active(false);
                    }
                    if let Some(recording_id) = recording_id {
                        match state.recording_store.processing_profile(&recording_id) {
                            Ok(processing_profile) => {
                                let descriptor = descriptor_for_transcription(
                                    recording_id,
                                    None,
                                    None,
                                    true,
                                    processing_profile.as_ref(),
                                    state
                                        .ai_fallback_preference
                                        .preference_or_safe_default()
                                        .default_fallback_policy(),
                                );
                                let executor = state.background_job_services().executor();
                                match state.job_manager.submit_descriptor(descriptor, executor) {
                                    Ok(job) => {
                                        if let Some(root) = value.as_object_mut() {
                                            root.insert(
                                                "autoProcessingQueued".to_string(),
                                                Value::Bool(true),
                                            );
                                            root.insert(
                                                "transcriptionJobId".to_string(),
                                                job.get("jobId").cloned().unwrap_or(Value::Null),
                                            );
                                        }
                                    }
                                    Err(error) => {
                                        if let Some(root) = value.as_object_mut() {
                                            root.insert(
                                                "autoProcessingQueued".to_string(),
                                                Value::Bool(false),
                                            );
                                            root.insert(
                                                "processingQueueError".to_string(),
                                                processing_queue_failure(&error),
                                            );
                                        }
                                    }
                                }
                            }
                            Err(error) => {
                                if let Some(root) = value.as_object_mut() {
                                    root.insert(
                                        "autoProcessingQueued".to_string(),
                                        Value::Bool(false),
                                    );
                                    root.insert(
                                    "processingQueueError".to_string(),
                                    json!({
                                        "code": error.code,
                                        "message": "Recording saved, but its capture-time processing profile could not be verified.",
                                        "retryable": false,
                                        "rawPathExposed": false
                                    }),
                                );
                                }
                            }
                        }
                    } else if let Some(root) = value.as_object_mut() {
                        root.insert("autoProcessingQueued".to_string(), Value::Bool(false));
                        root.insert(
                        "processingQueueError".to_string(),
                        json!({
                            "code": "CAPTURE_RECOVERY_REQUIRED",
                            "message": "Background processing is paused until the recording is recovered.",
                            "retryable": true
                        }),
                    );
                    }
                    value
                }
                Err(error) => return make_capture_error(id, error),
            }
        }
        "capture.proofSynthetic" => match state
            .capture_manager
            .proof_synthetic(&state.recording_store)
        {
            Ok(value) => value,
            Err(error) => return make_capture_error(id, error),
        },
        "capture.proofSerializedWriter" => match state
            .capture_manager
            .proof_serialized_writer(&state.recording_store)
        {
            Ok(value) => value,
            Err(error) => return make_capture_error(id, error),
        },
        "capture.proofInterruptedSerializedWriter" => match state
            .capture_manager
            .proof_interrupted_serialized_writer(&state.recording_store)
        {
            Ok(value) => value,
            Err(error) => return make_capture_error(id, error),
        },
        "models.status" => state.model_manager.status(&state.recording_store),
        "models.listLocal" => state.model_manager.list_local(
            &state.recording_store,
            &state
                .transcription_service
                .measured_speech_model_latencies_ms(),
        ),
        "models.verifyLocal" => {
            let params = match decode_params::<ModelIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .model_manager
                .verify_local(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_model_error(id, error),
            }
        }
        "models.verify.start" => {
            let params = match decode_params::<ModelIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let store = state.recording_store.clone();
            let model_manager = state.model_manager.clone();
            match state
                .job_manager
                .submit("speech-model-verification", false, move |context| {
                    context.progress("verifying", 0, Some(1), Some("stage"));
                    model_manager
                        .verify_local(&store, params)
                        .map_err(|error| JobFailure::new(error.code, error.message, true))
                }) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "models.importStart" => {
            let params = match decode_params::<ModelImportStartParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .model_manager
                .import_start(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_model_error(id, error),
            }
        }
        "models.importChunk" => {
            let params = match decode_params::<ModelImportChunkParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .model_manager
                .import_chunk(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_model_error(id, error),
            }
        }
        "models.importFinish" => {
            let params = match decode_params::<ModelImportFinishParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .model_manager
                .import_finish(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_model_error(id, error),
            }
        }
        "models.importFinish.start" => {
            let params = match decode_params::<ModelImportFinishParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let store = state.recording_store.clone();
            let model_manager = state.model_manager.clone();
            match state
                .job_manager
                .submit("speech-model-import", false, move |context| {
                    context.progress("verifying-and-installing", 0, Some(1), Some("stage"));
                    model_manager
                        .import_finish_with_cancellation(
                            &store,
                            params,
                            Some(context.cancellation_flag()),
                        )
                        .map_err(|error| JobFailure::new(error.code, error.message, true))
                }) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "models.importAbort" => {
            let params = match decode_params::<ModelImportAbortParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .model_manager
                .import_abort(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_model_error(id, error),
            }
        }
        "models.proofSynthetic" => {
            let params = match decode_params::<ModelProofParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .model_manager
                .proof_synthetic(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_model_error(id, error),
            }
        }
        "ai.status" => state.local_ai_service.status(&state.model_scheduler),
        "ai.bundledAssetsStatus" => state.model_manager.bundled_assets_status(),
        "ai.instructAssetsStatus" => state.local_instruct_assets.status(),
        "ai.instructAssetsImportFromPath" => {
            let params = match decode_params::<InstructAssetImportParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.local_instruct_assets.import_from_path(params) {
                Ok(value) => value,
                Err(error) => return make_instruct_asset_error(id, error),
            }
        }
        "ai.instructAssetsImport.start" => {
            let params = match decode_params::<InstructAssetImportParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let root = state
                .recording_store
                .models_root_for_core()
                .join("instruct");
            match state
                .job_manager
                .submit("local-ai-component-import", false, move |context| {
                    context.progress("verifying-and-importing", 0, Some(1), Some("stage"));
                    LocalInstructAssetManager::with_root(root)
                        .import_from_path(params)
                        .map_err(|error| JobFailure::new(error.code, error.message, true))
                }) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "ai.instructStatus" => state.local_instruct_model.status(&state.model_scheduler),
        "ai.proofInstructPreflight" => state
            .local_instruct_model
            .proof_preflight(&mut state.model_scheduler),
        "ai.recapInstruct" => {
            let params = match decode_params::<LocalInstructRecapParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let recording_id = params.recording_id.clone();
            let identity_before = match state.bundled_ai_assets.required_language_identity() {
                Ok(identity) => identity,
                Err(error) => return make_error(id, error.code, error.message),
            };
            let value = match state.local_instruct_model.recap(
                &state.recording_store,
                &mut state.model_scheduler,
                params,
            ) {
                Ok(value) => value,
                Err(error) => return make_local_instruct_error(id, error),
            };
            let identity_after = match state.bundled_ai_assets.required_language_identity() {
                Ok(identity) if identity == identity_before => identity,
                Ok(_) => {
                    return make_error(
                        id,
                        "LOCAL_LLM_IDENTITY_CHANGED",
                        "the verified Local AI identity changed during generation",
                    )
                }
                Err(error) => return make_error(id, error.code, error.message),
            };
            if let Err(error) = state.recording_store.record_processing_fact(
                &recording_id,
                "local-ai-recap",
                "llama-cpp-local",
                Some(&identity_after.model_id),
                Some(&identity_after.model_sha256),
            ) {
                return make_recording_error(id, error);
            }
            value
        }
        "ai.askInstruct" => {
            let params = match decode_params::<LocalInstructAskParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let recording_id = params.recording_id.clone();
            let identity_before = match state.bundled_ai_assets.required_language_identity() {
                Ok(identity) => identity,
                Err(error) => return make_error(id, error.code, error.message),
            };
            let value = match state.local_instruct_model.ask(
                &state.recording_store,
                &mut state.model_scheduler,
                params,
            ) {
                Ok(value) => value,
                Err(error) => return make_local_instruct_error(id, error),
            };
            let identity_after = match state.bundled_ai_assets.required_language_identity() {
                Ok(identity) if identity == identity_before => identity,
                Ok(_) => {
                    return make_error(
                        id,
                        "LOCAL_LLM_IDENTITY_CHANGED",
                        "the verified Local AI identity changed during generation",
                    )
                }
                Err(error) => return make_error(id, error.code, error.message),
            };
            if let Err(error) = state.recording_store.record_processing_fact(
                &recording_id,
                "local-ai-ask",
                "llama-cpp-local",
                Some(&identity_after.model_id),
                Some(&identity_after.model_sha256),
            ) {
                return make_recording_error(id, error);
            }
            value
        }
        "ai.askHeuristic" => {
            let params = match decode_params::<LocalAskParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let recording_id = params.recording_id.clone();
            let value = match state
                .local_ai_service
                .ask_heuristic(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_local_ai_error(id, error),
            };
            if let Err(error) = state.recording_store.record_processing_fact(
                &recording_id,
                "local-ai-ask",
                "heuristic-local",
                None,
                None,
            ) {
                return make_recording_error(id, error);
            }
            value
        }
        "ai.recapHeuristic" => {
            let params = match decode_params::<LocalRecapParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let recording_id = params.recording_id.clone();
            let value = match state
                .local_ai_service
                .recap_heuristic(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_local_ai_error(id, error),
            };
            if let Err(error) = state.recording_store.record_processing_fact(
                &recording_id,
                "local-ai-recap",
                "heuristic-local",
                None,
                None,
            ) {
                return make_recording_error(id, error);
            }
            value
        }
        "ai.schedulerStatus" => state.model_scheduler.status(),
        "ai.proofHeuristicAsk" => {
            let params = match decode_params::<LocalAiProofParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .local_ai_service
                .proof_heuristic_ask(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_local_ai_error(id, error),
            }
        }
        "ai.proofHeuristicRecap" => {
            let params = match decode_params::<LocalAiProofParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .local_ai_service
                .proof_heuristic_recap(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_local_ai_error(id, error),
            }
        }
        "ai.proofSchedulerBusy" => state.model_scheduler.proof_busy_denies_second_job(),
        "ai.fallbackPreference.status" => state.ai_fallback_preference.status(),
        "ai.fallbackPreference.update" => {
            let params =
                match decode_params::<AiFallbackPreferenceUpdateParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            match state.ai_fallback_preference.update(params) {
                Ok(value) => value,
                Err(error) => return make_ai_fallback_preference_error(id, error),
            }
        }
        "ai.recap.start" => {
            let params = match decode_params::<AiRecapJobParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            if let Err(error) = state.recording_store.require_finished(&params.recording_id) {
                return make_recording_error(id, error);
            }
            let policy = match state.ai_fallback_preference.resolve_intent(params.intent) {
                Ok(policy) => policy,
                Err(error) => return make_ai_fallback_preference_error(id, error),
            };
            let descriptor = match descriptor_for_recording_recap(
                &state.recording_store,
                params.recording_id,
                params.recap_template,
                policy.mode,
                policy.fallback_policy,
            ) {
                Ok(descriptor) => descriptor,
                Err(error) => return make_recording_error(id, error),
            };
            let executor = state.background_job_services().executor();
            match state.job_manager.submit_descriptor(descriptor, executor) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "ai.cleanup.start" => {
            let params = match decode_params::<AiCleanupJobParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            if let Err(error) = state.recording_store.require_finished(&params.recording_id) {
                return make_recording_error(id, error);
            }
            let descriptor = descriptor_for_cleanup(params.recording_id, true);
            let executor = state.background_job_services().executor();
            match state.job_manager.submit_descriptor(descriptor, executor) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "ai.ask.start" => {
            let params = match decode_params::<AiAskJobParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            if let Err(error) = state.recording_store.require_finished(&params.recording_id) {
                return make_recording_error(id, error);
            }
            let policy = match state.ai_fallback_preference.resolve_intent(params.intent) {
                Ok(policy) => policy,
                Err(error) => return make_ai_fallback_preference_error(id, error),
            };
            let descriptor = descriptor_for_ask(
                params.recording_id,
                params.question,
                policy.mode,
                policy.fallback_policy,
            );
            let executor = state.background_job_services().executor();
            match state.job_manager.submit_descriptor(descriptor, executor) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "liveTranscript.enable" => {
            let params =
                match decode_params::<LiveTranscriptRecordingParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            match state.live_transcript.enable(params.recording_id) {
                Ok(value) => json!(value),
                Err(error) => return make_live_transcript_error(id, error),
            }
        }
        "liveTranscript.start" => {
            let params =
                match decode_params::<LiveTranscriptRecordingParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            if !LiveAsrProducerManager::available() {
                return make_live_asr_error(
                    id,
                    LiveAsrProducerError {
                        code: "LIVE_TRANSCRIPT_ENGINE_UNAVAILABLE",
                        message:
                            "this Candor core was built without the packaged local Whisper runtime"
                                .to_string(),
                    },
                );
            }
            let value = match state.live_transcript.start(&params.recording_id) {
                Ok(value) => value,
                Err(error) => return make_live_transcript_error(id, error),
            };
            if let Err(error) = state.live_asr_producer.start(
                &params.recording_id,
                &state.capture_manager,
                state.recording_store.clone(),
                state.model_manager.clone(),
                state.transcription_service.clone(),
                state.live_transcript.clone(),
            ) {
                let _ = state.live_transcript.producer_stopped(&params.recording_id);
                return make_live_asr_error(id, error);
            }
            json!(value)
        }
        "liveTranscript.snapshot" => {
            let params =
                match decode_params::<LiveTranscriptRecordingParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            match state.live_transcript.snapshot(&params.recording_id) {
                Ok(value) => json!(value),
                Err(error) => return make_live_transcript_error(id, error),
            }
        }
        "liveTranscript.clear" => {
            let params =
                match decode_params::<LiveTranscriptRecordingParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            match state.live_transcript.clear(&params.recording_id) {
                Ok(value) => json!(value),
                Err(error) => return make_live_transcript_error(id, error),
            }
        }
        "liveTranscript.stop" => {
            let params =
                match decode_params::<LiveTranscriptRecordingParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            let _ = state.live_asr_producer.stop(&params.recording_id);
            match state.live_transcript.stop(&params.recording_id) {
                Ok(value) => json!(value),
                Err(error) => return make_live_transcript_error(id, error),
            }
        }
        "liveTranscript.eventsDrain" => {
            if let Err(response) = decode_params::<()>(id.clone(), req.params) {
                return response;
            }
            match state.live_transcript.drain_events() {
                Ok(value) => json!(value),
                Err(error) => return make_live_transcript_error(id, error),
            }
        }
        "diarization.status" => {
            if let Err(response) = decode_params::<()>(id.clone(), req.params) {
                return response;
            }
            match state.diarization_service.status() {
                Ok(value) => value,
                Err(error) => return make_diarization_error(id, error),
            }
        }
        "diarization.updatePreference" => {
            let params = match decode_params::<DiarizationPreferenceParams>(id.clone(), req.params)
            {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.diarization_service.update_preference(params) {
                Ok(value) => value,
                Err(error) => return make_diarization_error(id, error),
            }
        }
        "diarization.speakerNames" => {
            let params = match decode_params::<DiarizationRecordingParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            if let Err(error) = state.recording_store.trust_history(RecordingIdParams {
                recording_id: params.recording_id.clone(),
            }) {
                return make_recording_error(id, error);
            }
            match state.diarization_service.list_speaker_names(params) {
                Ok(value) => value,
                Err(error) => return make_diarization_error(id, error),
            }
        }
        "diarization.assignSpeakerName" => {
            let params =
                match decode_params::<DiarizationAssignSpeakerNameParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            if let Err(error) = state.recording_store.trust_history(RecordingIdParams {
                recording_id: params.recording_id.clone(),
            }) {
                return make_recording_error(id, error);
            }
            match state.diarization_service.assign_speaker_name(params) {
                Ok(value) => value,
                Err(error) => return make_diarization_error(id, error),
            }
        }
        "diarization.removeSpeakerName" => {
            let params =
                match decode_params::<DiarizationRemoveSpeakerNameParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            if let Err(error) = state.recording_store.trust_history(RecordingIdParams {
                recording_id: params.recording_id.clone(),
            }) {
                return make_recording_error(id, error);
            }
            match state.diarization_service.remove_speaker_name(params) {
                Ok(value) => value,
                Err(error) => return make_diarization_error(id, error),
            }
        }
        "profiles.list" => match state.meeting_profiles.list() {
            Ok(value) => value,
            Err(error) => return make_meeting_profile_error(id, error),
        },
        "profiles.get" => {
            let params = match decode_params::<MeetingProfileGetParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.meeting_profiles.get(params) {
                Ok(value) => value,
                Err(error) => return make_meeting_profile_error(id, error),
            }
        }
        "profiles.upsert" => {
            let params = match decode_params::<MeetingProfileUpsertParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.meeting_profiles.upsert_custom(params) {
                Ok(value) => value,
                Err(error) => return make_meeting_profile_error(id, error),
            }
        }
        "profiles.delete" => {
            let params = match decode_params::<MeetingProfileDeleteParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.meeting_profiles.delete_custom(params) {
                Ok(value) => value,
                Err(error) => return make_meeting_profile_error(id, error),
            }
        }
        "profiles.select" => {
            let params = match decode_params::<MeetingProfileSelectParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.meeting_profiles.select(params) {
                Ok(value) => value,
                Err(error) => return make_meeting_profile_error(id, error),
            }
        }
        "replacements.list" => match state.replacement_rules.list() {
            Ok(value) => value,
            Err(error) => return make_replacement_rule_error(id, error),
        },
        "replacements.get" => {
            let params = match decode_params::<ReplacementRuleSetGetParams>(id.clone(), req.params)
            {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.replacement_rules.get(params) {
                Ok(value) => value,
                Err(error) => return make_replacement_rule_error(id, error),
            }
        }
        "replacements.upsert" => {
            let params =
                match decode_params::<ReplacementRuleSetUpsertParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            match state.replacement_rules.upsert_custom(params) {
                Ok(value) => value,
                Err(error) => return make_replacement_rule_error(id, error),
            }
        }
        "replacements.delete" => {
            let params =
                match decode_params::<ReplacementRuleSetDeleteParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            match state.replacement_rules.delete_custom(params) {
                Ok(value) => value,
                Err(error) => return make_replacement_rule_error(id, error),
            }
        }
        "replacements.preview" => {
            let params = match decode_params::<ReplacementPreviewParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.replacement_rules.preview(params) {
                Ok(value) => value,
                Err(error) => return make_replacement_rule_error(id, error),
            }
        }
        "replacements.apply" => {
            let params = match decode_params::<ReplacementApplyParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.replacement_rules.apply(params) {
                Ok(value) => value,
                Err(error) => return make_replacement_rule_error(id, error),
            }
        }
        "terminology.status" => {
            let params = match decode_params::<TerminologyStatusParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            state.terminology_service.status(params)
        }
        "terminology.import" => {
            let params = match decode_params::<TerminologyImportParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.terminology_service.import_dictionary(params) {
                Ok(value) => value,
                Err(error) => return make_terminology_error(id, error),
            }
        }
        "terminology.package.start" => {
            let params = match decode_params::<DictionaryPackageStartParams>(id.clone(), req.params)
            {
                Ok(params) => params,
                Err(response) => return response,
            };
            let staged = match state
                .dictionary_staging
                .stage_base64(&params.source_file_name, &params.archive_base64)
            {
                Ok(value) => value,
                Err(error) => {
                    return make_error_with_retryability(
                        id,
                        error.code,
                        error.message,
                        error.retryable,
                    )
                }
            };
            let staging_token = staged.staging_token.clone();
            let descriptor = descriptor_for_dictionary_import(staged);
            let executor = state.background_job_services().executor();
            match state.job_manager.submit_descriptor(descriptor, executor) {
                Ok(value) => value,
                Err(error) => {
                    if let Err(cleanup_error) = state.dictionary_staging.delete(&staging_token) {
                        return make_error_with_retryability(
                            id,
                            cleanup_error.code,
                            cleanup_error.message,
                            cleanup_error.retryable,
                        );
                    }
                    return make_job_error(id, error);
                }
            }
        }
        "terminology.setEnabled" => {
            let params = match decode_params::<TerminologySetEnabledParams>(id.clone(), req.params)
            {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.terminology_service.set_enabled(params) {
                Ok(value) => value,
                Err(error) => return make_terminology_error(id, error),
            }
        }
        "terminology.assign" => {
            let params = match decode_params::<TerminologyAssignParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .terminology_service
                .assign(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_terminology_error(id, error),
            }
        }
        "terminology.proposals" => {
            let params = match decode_params::<TerminologyProposalParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .terminology_service
                .proposals(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_terminology_error(id, error),
            }
        }
        "terminology.decide" => {
            let params = match decode_params::<TerminologyDecisionParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .terminology_service
                .decide(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_terminology_error(id, error),
            }
        }
        "transcription.quality.status" => state.transcription_service.quality_status(),
        "transcription.quality.update" => {
            let params =
                match decode_params::<TranscriptionQualityUpdateParams>(id.clone(), req.params) {
                    Ok(params) => params,
                    Err(response) => return response,
                };
            match state.transcription_service.update_quality(params) {
                Ok(value) => value,
                Err(error) => return make_transcription_quality_error(id, error),
            }
        }
        "transcription.quality.benchmark.start" => {
            let params = match decode_params::<TranscriptionBenchmarkParams>(id.clone(), req.params)
            {
                Ok(params) => params,
                Err(response) => return response,
            };
            if state.capture_manager.is_active() {
                return make_error(
                    id,
                    "TRANSCRIPTION_BENCHMARK_CAPTURE_ACTIVE",
                    "the local performance check cannot run during an active recording",
                );
            }
            match state.job_manager.has_active_type("local-ai-benchmark") {
                Ok(true) => {
                    return make_error(
                        id,
                        "TRANSCRIPTION_BENCHMARK_ALREADY_RUNNING",
                        "a local performance check is already running",
                    )
                }
                Ok(false) => {}
                Err(error) => return make_job_error(id, error),
            }
            let store = state.recording_store.clone();
            let model_manager = state.model_manager.clone();
            let service = state.transcription_service.clone();
            let asset_root = store.models_root_for_core().join("instruct");
            let bundled_ai_assets = state.bundled_ai_assets.clone();
            let terminology_service = state.terminology_service.clone();
            match state
                .job_manager
                .submit("local-ai-benchmark", true, move |context| {
                    let tier = params.tier;
                    let cancellation = context.cancellation_flag();
                    let mut scheduler = LocalModelScheduler::default();
                    context.progress("measuring-transcription", 0, Some(3), Some("stage"));
                    let whisper = match service.benchmark_whisper_cancellable(
                        &store,
                        &mut scheduler,
                        &model_manager,
                        params,
                        cancellation.clone(),
                    ) {
                        Ok(measurement) => measurement,
                        Err(error) => {
                            let _ = service.record_quality_benchmark_failure(tier, error.code);
                            return Err(JobFailure::new(error.code, error.message, true));
                        }
                    };
                    context.progress("measuring-local-ai", 1, Some(3), Some("stage"));
                    let local_ai = LocalInstructModelService::with_sources_and_terminology(
                        asset_root,
                        bundled_ai_assets,
                        terminology_service,
                    );
                    let llm = match local_ai.benchmark_cancellable(&mut scheduler, cancellation) {
                        Ok(measurement) => measurement,
                        Err(error) => {
                            let _ = service.record_quality_benchmark_failure(tier, error.code);
                            return Err(JobFailure::new(error.code, error.message, true));
                        }
                    };
                    context.progress("saving-local-results", 2, Some(3), Some("stage"));
                    service
                        .record_quality_benchmark(TranscriptionBenchmarkMeasurement {
                            tier,
                            whisper_real_time_factor: whisper.real_time_factor,
                            llm_estimated_tokens_per_second: llm.estimated_tokens_per_second,
                            whisper_model_sha256: whisper.model_sha256,
                            llm_model_sha256: llm.model_sha256,
                        })
                        .map_err(|error| JobFailure::new(error.code, error.message, true))
                }) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "transcription.status" => state.transcription_service.status(
            &state.recording_store,
            &state.model_scheduler,
            &state.model_manager,
        ),
        "transcription.runLocal" => {
            let params = match decode_params::<TranscriptionRunLocalParams>(id.clone(), req.params)
            {
                Ok(params) => params,
                Err(response) => return response,
            };
            let recording_id = params.recording_id.clone();
            let run = match state.transcription_service.run_local_with_commit(
                &state.recording_store,
                &mut state.model_scheduler,
                &state.model_manager,
                params,
            ) {
                Ok(value) => value,
                Err(error) => return make_transcription_error(id, error),
            };
            let _ = state
                .live_transcript
                .reconcile_committed(&run.committed_final_revision);
            let value = run.public_value;
            let model = value.get("model").and_then(Value::as_object);
            if let Err(error) = state.recording_store.record_processing_fact(
                &recording_id,
                "transcription",
                value
                    .get("engine")
                    .and_then(Value::as_str)
                    .unwrap_or("whisper-rs"),
                model
                    .and_then(|value| value.get("modelId"))
                    .and_then(Value::as_str),
                model
                    .and_then(|value| value.get("sha256"))
                    .and_then(Value::as_str),
            ) {
                return make_recording_error(id, error);
            }
            value
        }
        "transcription.start" => {
            let params = match decode_params::<TranscriptionRunLocalParams>(id.clone(), req.params)
            {
                Ok(params) => params,
                Err(response) => return response,
            };
            if let Err(error) = state.recording_store.require_finished(&params.recording_id) {
                return make_recording_error(id, error);
            }
            let processing_profile = match state
                .recording_store
                .processing_profile(&params.recording_id)
            {
                Ok(profile) => profile,
                Err(error) => return make_recording_error(id, error),
            };
            let descriptor = descriptor_for_transcription(
                params.recording_id,
                params.channel,
                params.model_id,
                false,
                processing_profile.as_ref(),
                state
                    .ai_fallback_preference
                    .preference_or_safe_default()
                    .default_fallback_policy(),
            );
            let executor = state.background_job_services().executor();
            match state.job_manager.submit_descriptor(descriptor, executor) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "transcription.proofSynthetic" => {
            let params = match decode_params::<TranscriptionProofParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .transcription_service
                .proof_synthetic(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_transcription_error(id, error),
            }
        }
        "transcription.protectedTermReview" => {
            let params = match decode_params::<ProtectedTermReviewParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .transcription_service
                .protected_term_review(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_transcription_error(id, error),
            }
        }
        "transcription.applyProtectedTermReview" => {
            let params = match decode_params::<ProtectedTermApplyParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state
                .transcription_service
                .apply_protected_term_review(&state.recording_store, params)
            {
                Ok(value) => value,
                Err(error) => return make_transcription_error(id, error),
            }
        }
        "recording.durable.status" => match state.recording_store.status() {
            Ok(value) => value,
            Err(error) => return make_recording_error(id, error),
        },
        "retention.status" => match state.recording_store.retention_status() {
            Ok(value) => value,
            Err(error) => return make_recording_error(id, error),
        },
        "recording.index.status" => state.vault_store.recording_index_status(),
        "recording.durable.start" => {
            let params = match decode_params::<StartRecordingParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.start(params) {
                Ok(value) => annotate_recording_summary(value, state),
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.writeTextChunk" => {
            let params = match decode_params::<WriteChunkParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.write_text_chunk(params) {
                Ok(value) => annotate_recording_summary(value, state),
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.writeTranscriptSegment" => {
            let params = match decode_params::<WriteTranscriptSegmentParams>(id.clone(), req.params)
            {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.write_transcript_segment(params) {
                Ok(value) => annotate_recording_summary(value, state),
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.writeAudioChunk" => {
            let params = match decode_params::<WriteAudioChunkParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.write_audio_chunk(params) {
                Ok(value) => annotate_recording_summary(value, state),
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.finish" => {
            let params = match decode_params::<RecordingIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.finish(params) {
                Ok(value) => annotate_recording_summary(value, state),
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.delete" => {
            let params = match decode_params::<RecordingIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let deleted_recording_id = params.recording_id.clone();
            if let Err(error) = state
                .recording_store
                .require_finished(&deleted_recording_id)
            {
                return make_recording_error(id, error);
            }
            if let Err(error) = state.recording_store.trust_history(RecordingIdParams {
                recording_id: deleted_recording_id.clone(),
            }) {
                return make_recording_error(id, error);
            }
            if let Err(error) = state
                .job_manager
                .begin_recording_deletion(&deleted_recording_id)
            {
                return make_job_error(id, error);
            }
            match state.recording_store.delete_finished(params) {
                Ok(value) => finalize_deletion_result(value, state),
                Err(error) => {
                    if !state
                        .recording_store
                        .deletion_pending(&deleted_recording_id)
                    {
                        state
                            .job_manager
                            .abort_recording_deletion(&deleted_recording_id);
                    }
                    return make_recording_error(id, error);
                }
            }
        }
        "recording.durable.recover" => {
            if state.capture_manager.is_active() {
                return make_error(
                    id,
                    "RECORDING_RECOVERY_CAPTURE_ACTIVE",
                    "recording recovery cannot run while capture is active",
                );
            }
            let media_import_active = match state.job_manager.has_active_type("media-import") {
                Ok(active) => active,
                Err(error) => return make_job_error(id, error),
            };
            if media_import_active {
                return make_error(
                    id,
                    "RECORDING_RECOVERY_MEDIA_IMPORT_ACTIVE",
                    "recording recovery cannot run while a media import is active",
                );
            }
            match state.recording_store.recover() {
                Ok(value) => {
                    let mut value = annotate_recovery_result(value, state);
                    let cleanup_resolution = match state
                        .job_manager
                        .resolve_media_import_cleanup_after_recovery(&value)
                    {
                        Ok(resolution) => resolution,
                        Err(error) => return make_job_error(id, error),
                    };
                    if let Some(object) = value.as_object_mut() {
                        object.insert(
                            "mediaImportCleanupResolution".to_string(),
                            cleanup_resolution,
                        );
                    }
                    value
                }
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.list" => match state.recording_store.list() {
            Ok(value) => value,
            Err(error) => return make_recording_error(id, error),
        },
        "recording.durable.listPage" => {
            let params = match decode_params::<RecordingPageParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let listed = if state.automation_read_only {
                state.recording_store.list_page_read_only(params)
            } else {
                state.recording_store.list_page(params)
            };
            match listed {
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.read" => {
            let params = match decode_params::<RecordingIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.read(params) {
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.replayManifest" => {
            let params = match decode_params::<RecordingIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.replay_manifest(params) {
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.transcript" => {
            let params = match decode_params::<RecordingIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.transcript(params) {
                Ok(value) => match state.terminology_service.apply_accepted_corrections(value) {
                    Ok(value) => value,
                    Err(error) => return make_terminology_error(id, error),
                },
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.transcriptPage" => {
            let params = match decode_params::<TranscriptPageParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let transcript = if state.automation_read_only {
                state.recording_store.transcript_page_read_only(params)
            } else {
                state.recording_store.transcript_page(params)
            };
            match transcript {
                Ok(value) if state.automation_read_only => match state
                    .terminology_service
                    .apply_accepted_corrections_read_only(value)
                {
                    Ok(value) => value,
                    Err(error) => return make_terminology_error(id, error),
                },
                Ok(value) => match state.terminology_service.apply_accepted_corrections(value) {
                    Ok(value) => value,
                    Err(error) => return make_terminology_error(id, error),
                },
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.trustHistory" => {
            let params = match decode_params::<RecordingIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.trust_history(params) {
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.transcriptRevision" => {
            let params = match decode_params::<TranscriptRevisionParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.transcript_revision(params) {
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.selectTranscriptRevision" => {
            let params = match decode_params::<TranscriptRevisionParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.select_transcript_revision(params) {
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "transcription.prepareReprocess" => {
            let params = match decode_params::<ReprocessingPrepareParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.prepare_reprocessing(params) {
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.privacyReceipt" => {
            let params = match decode_params::<RecordingIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.privacy_receipt(params) {
                Ok(mut value) => {
                    value["network"] = network_capability_matrix();
                    value
                }
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.readAudioChunk" => {
            let params = match decode_params::<AudioChunkParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.read_audio_chunk(params) {
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.search" => {
            let params = match decode_params::<SearchRecordingsParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let result = if state.automation_read_only {
                state.recording_store.search_read_only(params)
            } else {
                state.recording_store.search(params)
            };
            match result {
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.notes.read" => {
            let params = match decode_params::<RecordingIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.read_notes(params) {
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.notes.save" => {
            let params = match decode_params::<SaveNotesParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.save_notes(params) {
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "jobs.list" => match state.job_manager.list() {
            Ok(value) => value,
            Err(error) => return make_job_error(id, error),
        },
        "jobs.activeSummary" => match state.job_manager.active_summary() {
            Ok(value) => value,
            Err(error) => return make_job_error(id, error),
        },
        "jobs.get" => {
            let params = match decode_params::<JobIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.job_manager.get(&params.job_id) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "jobs.cancel" => {
            let params = match decode_params::<JobIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.job_manager.cancel(&params.job_id) {
                Ok(value) => {
                    let staging_token = match state
                        .job_manager
                        .dictionary_staging_reference(&params.job_id)
                    {
                        Ok(token) => token,
                        Err(error) => return make_job_error(id, error),
                    };
                    if let Some(token) = staging_token {
                        if let Err(error) = state.dictionary_staging.delete(&token) {
                            return make_error_with_retryability(
                                id,
                                error.code,
                                error.message,
                                error.retryable,
                            );
                        }
                        state.job_manager.discard_dictionary_staging(&params.job_id);
                    }
                    value
                }
                Err(error) => return make_job_error(id, error),
            }
        }
        "jobs.cancelAll" => match state.job_manager.cancel_all() {
            Ok(value) => {
                for token in state.job_manager.dictionary_staging_references() {
                    if let Err(error) = state.dictionary_staging.delete(&token) {
                        return make_error_with_retryability(
                            id,
                            error.code,
                            error.message,
                            error.retryable,
                        );
                    }
                }
                state.job_manager.discard_all_dictionary_staging();
                value
            }
            Err(error) => return make_job_error(id, error),
        },
        "jobs.pauseAll" => match state.job_manager.pause_all_for_shutdown() {
            Ok(value) => value,
            Err(error) => return make_job_error(id, error),
        },
        "jobs.retry" => {
            let params = match decode_params::<JobIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let executor = state.background_job_services().executor();
            match state.job_manager.retry(&params.job_id, executor) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "jobs.acknowledge" => {
            let params = match decode_params::<JobIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let staging_token = match state
                .job_manager
                .terminal_dictionary_staging_reference(&params.job_id)
            {
                Ok(token) => token,
                Err(error) => return make_job_error(id, error),
            };
            if let Some(token) = staging_token {
                if let Err(error) = state.dictionary_staging.delete(&token) {
                    return make_error_with_retryability(
                        id,
                        error.code,
                        error.message,
                        error.retryable,
                    );
                }
            }
            match state.job_manager.acknowledge(&params.job_id) {
                Ok(acknowledgement) => acknowledgement.response,
                Err(error) => return make_job_error(id, error),
            }
        }
        "export.start" => {
            let raw_params = req.params.clone();
            let params = match decode_params::<ExportRecordingParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            if let Err(error) = state.recording_store.require_finished(&params.recording_id) {
                return make_recording_error(id, error);
            }
            let descriptor = descriptor_for_export(raw_params);
            let executor = state.background_job_services().executor();
            match state.job_manager.submit_descriptor(descriptor, executor) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "export.create" => {
            let params = match decode_params::<ExportRecordingParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.export_create(params) {
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "core.shutdown" => {
            if !state.automation_read_only {
                if let Err(error) = state.capture_manager.mic_test_stop() {
                    return make_capture_error(id, error);
                }
                let _ = state.capture_manager.request_stop();
                let _ = state.live_asr_producer.stop_all();
                if let Err(error) = state.job_manager.pause_all_for_shutdown() {
                    return make_job_error(id, error);
                }
            }
            state.shutdown_requested = true;
            json!({ "shutdown": true })
        }
        _ => {
            return make_error(
                id,
                "METHOD_NOT_ALLOWED",
                format!("Method is not in the M0 allowlist: {}", req.method),
            );
        }
    };

    RpcResponse {
        id,
        request_id: None,
        protocol_version: PROTOCOL_VERSION,
        ok: true,
        result: Some(Box::new(result)),
        error: None,
    }
}

fn annotate_recording_summary(mut value: Value, state: &mut CoreState) -> Value {
    let index = state.vault_store.index_recording_summary(&value);
    if let Some(object) = value.as_object_mut() {
        object.insert("vaultIndex".to_string(), index);
    }
    value
}

fn finalize_deletion_result(value: Value, state: &CoreState) -> Value {
    let recording_id = value
        .get("recordingId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let recording_data_removed = value
        .get("recordingDataRemoved")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !recording_data_removed || recording_id.is_empty() {
        return value;
    }

    let jobs_cleanup = match state.job_manager.purge_recording_jobs(&recording_id) {
        Ok(cleanup) => cleanup,
        Err(error) => return deletion_cleanup_pending(value, "jobs", error.code),
    };
    let live_transcript_cleanup = match state.live_transcript.remove_for_deletion(&recording_id) {
        Ok(cleanup) => json!(cleanup),
        Err(error) => return deletion_cleanup_pending(value, "live-transcript", error.code),
    };
    let terminology_cleanup = match state.terminology_service.remove_recording(&recording_id) {
        Ok(cleanup) => cleanup,
        Err(error) => return deletion_cleanup_pending(value, "terminology", error.code),
    };
    let diarization_cleanup = match state.diarization_service.remove_recording(&recording_id) {
        Ok(()) => json!({
            "recordingId": recording_id,
            "removed": true,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }),
        Err(error) => return deletion_cleanup_pending(value, "diarization", error.code),
    };
    let search_cleanup = match state.recording_store.invalidate_trust_search_index() {
        Ok(cleanup) => cleanup,
        Err(error) => return deletion_cleanup_pending(value, "search-index", error.code),
    };
    let index_cleanup = match state.vault_store.delete_recording_index(&recording_id) {
        Ok(cleanup)
            if cleanup
                .get("cleanupComplete")
                .and_then(Value::as_bool)
                .unwrap_or(false) =>
        {
            cleanup
        }
        Ok(_) => {
            return deletion_cleanup_pending(value, "vault-index", "VAULT_INDEX_CLEANUP_PENDING")
        }
        Err(error) => return deletion_cleanup_pending(value, "vault-index", error.code),
    };
    match state
        .recording_store
        .complete_deletion_metadata(RecordingIdParams {
            recording_id: recording_id.clone(),
        }) {
        Ok(mut completed) => {
            state.job_manager.complete_recording_deletion(&recording_id);
            if let Some(object) = completed.as_object_mut() {
                object.insert("jobsCleanup".to_string(), jobs_cleanup);
                object.insert("liveTranscriptCleanup".to_string(), live_transcript_cleanup);
                object.insert("terminologyCleanup".to_string(), terminology_cleanup);
                object.insert("diarizationCleanup".to_string(), diarization_cleanup);
                object.insert("searchIndexCleanup".to_string(), search_cleanup);
                object.insert("vaultIndexCleanup".to_string(), index_cleanup);
            }
            completed
        }
        Err(error) => deletion_cleanup_pending(value, "deletion-metadata", error.code),
    }
}

fn deletion_cleanup_pending(
    mut value: Value,
    stage: &'static str,
    error_code: &'static str,
) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.insert("state".to_string(), json!("metadataCleanupPending"));
        object.insert("deleted".to_string(), json!(false));
        object.insert("metadataCleanupComplete".to_string(), json!(false));
        object.insert("retryRequired".to_string(), json!(true));
        object.insert("metadataCleanupStage".to_string(), json!(stage));
        object.insert("metadataErrorCode".to_string(), json!(error_code));
    }
    value
}

fn reconcile_recovered_deletions(mut value: Value, state: &CoreState) -> Value {
    let ids = value
        .get("completedDeletionIds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut completed = 0_u64;
    let mut pending = value
        .get("pendingDeletionCount")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    for id in ids.iter().filter_map(Value::as_str) {
        if state.job_manager.recover_recording_deletion(id).is_err() {
            pending = pending.saturating_add(1);
            continue;
        }
        let finalized = finalize_deletion_result(
            json!({
                "recordingId": id,
                "state": "metadataCleanupPending",
                "deleted": false,
                "recordingDataRemoved": true,
                "metadataCleanupComplete": false,
                "retryRequired": true,
                "permanent": true,
                "rawPathExposed": false
            }),
            state,
        );
        if finalized
            .get("deleted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            completed = completed.saturating_add(1);
        } else {
            pending = pending.saturating_add(1);
        }
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("completedDeletionCount".to_string(), json!(completed));
        object.insert("pendingDeletionCount".to_string(), json!(pending));
        object.remove("completedDeletionIds");
    }
    value
}

fn annotate_recovery_result(mut value: Value, state: &mut CoreState) -> Value {
    value = reconcile_recovered_deletions(value, state);
    let mut indexed = 0_u64;
    let mut available = false;
    if let Some(recordings) = value.get("recoveredRecordings").and_then(Value::as_array) {
        for recording in recordings {
            let index = state.vault_store.index_recording_summary(recording);
            if index
                .get("available")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                available = true;
            }
            if index
                .get("indexed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                indexed += 1;
            }
        }
    }
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "vaultIndex".to_string(),
            json!({
                "available": available,
                "indexedRecoveredCount": indexed,
                "keyMaterialExposedToRenderer": false,
                "rawPathExposed": false
            }),
        );
    }
    value
}

fn annotate_import_result(mut value: Value, state: &mut CoreState) -> Value {
    let mut indexed = 0_u64;
    let mut available = false;

    if let Some(recordings) = value.get_mut("recordings").and_then(Value::as_array_mut) {
        for imported in recordings {
            let recording_summary = imported.get("recording").cloned().unwrap_or(Value::Null);
            let index = state
                .vault_store
                .index_recording_summary(&recording_summary);
            if index
                .get("available")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                available = true;
            }
            if index
                .get("indexed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                indexed += 1;
            }
            if let Some(object) = imported.as_object_mut() {
                object.insert("vaultIndex".to_string(), index);
            }
        }
    }

    if let Some(object) = value.as_object_mut() {
        object.insert(
            "vaultIndex".to_string(),
            json!({
                "available": available,
                "indexedImportedCount": indexed,
                "keyMaterialExposedToRenderer": false,
                "rawPathExposed": false
            }),
        );
    }
    value
}

fn is_uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

fn is_iso_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        })
}

fn validate_request_envelope(request: &RpcRequest) -> Result<(), RpcResponse> {
    let metadata_count = [
        request.protocol_version.is_some(),
        request.request_id.is_some(),
        request.sent_at.is_some(),
    ]
    .into_iter()
    .filter(|present| *present)
    .count();
    if metadata_count != 3 {
        return Err(make_error(
            request.id.clone(),
            "INVALID_RPC_ENVELOPE",
            "protocolVersion, requestId, and sentAt must be provided together",
        ));
    }
    if request.protocol_version.as_deref() != Some(PROTOCOL_VERSION) {
        return Err(make_error(
            request.id.clone(),
            "PROTOCOL_VERSION_MISMATCH",
            "request protocolVersion is incompatible with candor-core",
        ));
    }
    let request_id = request.request_id.as_deref().unwrap_or_default();
    if request.id.as_str() != Some(request_id) {
        return Err(make_error(
            request.id.clone(),
            "REQUEST_ID_MISMATCH",
            "id and requestId must be the same UUID",
        ));
    }
    if !is_uuid_v4(request_id) {
        return Err(make_error(
            request.id.clone(),
            "INVALID_REQUEST_ID",
            "requestId must be a version 4 UUID",
        ));
    }
    if !request
        .sent_at
        .as_deref()
        .map(is_iso_timestamp)
        .unwrap_or(false)
    {
        return Err(make_error(
            request.id.clone(),
            "INVALID_SENT_AT",
            "sentAt must be an ISO-8601 UTC timestamp",
        ));
    }
    Ok(())
}

fn with_request_id(mut response: RpcResponse, request_id: Option<String>) -> RpcResponse {
    response.request_id = request_id;
    response
}

fn handle_line(line: &str, state: &mut CoreState) -> Option<RpcResponse> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.len() > MAX_RPC_LINE_BYTES {
        return Some(make_error(
            Value::Null,
            "RPC_FRAME_TOO_LARGE",
            format!("RPC frame exceeds {} byte limit", MAX_RPC_LINE_BYTES),
        ));
    }

    Some(match serde_json::from_str::<RpcRequest>(trimmed) {
        Ok(req) => {
            let request_id = req.request_id.clone();
            if let Err(response) = validate_request_envelope(&req) {
                return Some(with_request_id(response, request_id));
            }
            if !state.recent_request_ids.insert(&req.id) {
                return Some(with_request_id(
                    make_error(
                        req.id,
                        "DUPLICATE_REQUEST_ID",
                        "request id has already been processed",
                    ),
                    request_id,
                ));
            }
            with_request_id(handle_request(req, state), request_id)
        }
        Err(err) => make_error(Value::Null, "MALFORMED_JSON_RPC", err.to_string()),
    })
}

pub(crate) fn write_protocol_value(value: &impl Serialize) {
    let _guard = PROTOCOL_OUTPUT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .ok();
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    if serde_json::to_writer(&mut lock, value).is_ok() {
        let _ = lock.write_all(b"\n");
        let _ = lock.flush();
    }
}

fn write_response(response: &RpcResponse) {
    write_protocol_value(response);
}

enum BoundedFrame {
    EndOfStream,
    Frame(Vec<u8>),
    TooLarge,
}

fn read_bounded_frame(reader: &mut impl BufRead) -> io::Result<BoundedFrame> {
    let mut frame = Vec::with_capacity(8 * 1024);
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if frame.is_empty() && !oversized {
                Ok(BoundedFrame::EndOfStream)
            } else if oversized {
                Ok(BoundedFrame::TooLarge)
            } else {
                Ok(BoundedFrame::Frame(frame))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let payload_bytes = newline.unwrap_or(available.len());
        if !oversized {
            if frame.len().saturating_add(payload_bytes) > MAX_RPC_LINE_BYTES {
                frame.clear();
                oversized = true;
            } else {
                frame.extend_from_slice(&available[..payload_bytes]);
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            return if oversized {
                Ok(BoundedFrame::TooLarge)
            } else {
                Ok(BoundedFrame::Frame(frame))
            };
        }
    }
}

fn main() {
    let started_at_ms = now_ms();
    let mut state = CoreState::new(started_at_ms);
    let stdin = io::stdin();

    let mut input = stdin.lock();
    loop {
        let frame = match read_bounded_frame(&mut input) {
            Ok(frame) => frame,
            Err(err) => {
                write_response(&make_error(
                    Value::Null,
                    "STDIN_READ_ERROR",
                    err.to_string(),
                ));
                continue;
            }
        };
        match frame {
            BoundedFrame::EndOfStream => break,
            BoundedFrame::TooLarge => write_response(&make_error(
                Value::Null,
                "RPC_FRAME_TOO_LARGE",
                format!("RPC frame exceeds {} byte limit", MAX_RPC_LINE_BYTES),
            )),
            BoundedFrame::Frame(bytes) => match std::str::from_utf8(&bytes) {
                Ok(line) => {
                    if let Some(response) = handle_line(line, &mut state) {
                        write_response(&response);
                        if state.shutdown_requested {
                            process::exit(0);
                        }
                    }
                }
                Err(error) => write_response(&make_error(
                    Value::Null,
                    "MALFORMED_JSON_RPC",
                    format!("RPC frame is not UTF-8: {error}"),
                )),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    use std::fs;
    use std::time::{Duration, Instant};

    fn core_state() -> CoreState {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root =
            std::env::temp_dir().join(format!("candor-core-main-test-{}-{stamp}", process::id()));
        CoreState::with_stores(
            now_ms(),
            RecordingStore::with_root(root.join("recordings")),
            VaultStore::with_root(root.join("vault")),
        )
    }

    #[test]
    fn background_processing_requires_verified_capture_finalization() {
        assert_eq!(
            finalized_capture_recording_id(&json!({
                "capture": { "recordingId": "recording-1", "integrityStatus": "verified" }
            })),
            Some("recording-1".to_string())
        );
        assert_eq!(
            finalized_capture_recording_id(&json!({
                "capture": { "recordingId": "recording-1", "integrityStatus": "failed" }
            })),
            None
        );
        assert_eq!(
            finalized_capture_recording_id(&json!({
                "capture": { "integrityStatus": "verified" }
            })),
            None
        );
    }

    #[test]
    fn failed_duplicate_capture_start_does_not_release_existing_recording_priority() {
        let manager = JobManager::new("test-protocol");
        let first_acquisition = manager
            .begin_recording_priority(Duration::from_millis(25))
            .expect("first capture acquires recording priority");
        assert!(first_acquisition);

        let duplicate_acquisition = manager
            .begin_recording_priority(Duration::from_millis(25))
            .expect("duplicate capture observes existing priority");
        assert!(!duplicate_acquisition);
        rollback_failed_capture_start(&manager, duplicate_acquisition);

        assert!(
            !manager
                .begin_recording_priority(Duration::from_millis(25))
                .expect("existing capture still owns recording priority"),
            "duplicate failure must not clear the first capture's priority"
        );

        rollback_failed_capture_start(&manager, first_acquisition);
        assert!(manager
            .begin_recording_priority(Duration::from_millis(25))
            .expect("priority can be acquired after the owner releases it"));
        manager.set_recording_active(false);
    }

    fn request(method: &str) -> RpcRequest {
        request_with(json!(1), method, Value::Null)
    }

    fn request_with(id: Value, method: &str, params: Value) -> RpcRequest {
        RpcRequest {
            id,
            protocol_version: None,
            request_id: None,
            method: method.to_string(),
            params,
            sent_at: None,
        }
    }

    fn wait_for_media_validation_gate_release(active: &AtomicBool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while active.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "media validation worker did not release its gate within one second"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn bounded_media_local_validation_keeps_one_worker_until_timeout_work_exits() {
        let active = Arc::new(AtomicBool::new(false));
        let (release_sender, release_receiver) = mpsc::sync_channel::<()>(0);

        let timed_out = run_bounded_media_local_validation(
            Arc::clone(&active),
            Duration::from_millis(10),
            move || {
                let _ = release_receiver.recv();
                1_u8
            },
        );
        assert_eq!(timed_out, Err(MediaLocalValidationRunError::Timeout));
        assert!(active.load(Ordering::SeqCst));

        let busy = run_bounded_media_local_validation(
            Arc::clone(&active),
            Duration::from_millis(10),
            || 2_u8,
        );
        assert_eq!(busy, Err(MediaLocalValidationRunError::Busy));

        release_sender.send(()).expect("release validation worker");
        wait_for_media_validation_gate_release(&active);

        let completed = run_bounded_media_local_validation(
            Arc::clone(&active),
            Duration::from_millis(100),
            || 3_u8,
        );
        assert_eq!(completed, Ok(3));
        wait_for_media_validation_gate_release(&active);
    }

    #[test]
    fn media_local_validation_gates_are_owned_by_each_core_state() {
        let first = core_state();
        let second = core_state();
        first
            .media_local_validation_active
            .store(true, Ordering::SeqCst);

        assert!(first.media_local_validation_active.load(Ordering::SeqCst));
        assert!(!second.media_local_validation_active.load(Ordering::SeqCst));
    }

    fn search_when_ready(state: &mut CoreState, id: Value, query: &str) -> RpcResponse {
        for _ in 0..400 {
            let response = handle_request(
                request_with(
                    id.clone(),
                    "recording.durable.search",
                    json!({ "query": query }),
                ),
                state,
            );
            if response.ok {
                return response;
            }
            if response.error.as_deref().map(|error| error.code)
                != Some("RECORDING_SEARCH_INDEX_BUILDING")
            {
                return response;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("encrypted search index did not become ready");
    }

    #[test]
    fn deletion_finalizer_preserves_a_confirmed_queue_until_data_is_removed() {
        let state = core_state();
        let queued = json!({
            "recordingId": "recording-queued",
            "state": "deletionQueued",
            "deleted": false,
            "recordingDataRemoved": false,
            "confirmationRetained": true,
            "metadataCleanupComplete": false,
            "retryRequired": true,
            "permanent": true,
            "rawPathExposed": false
        });

        assert_eq!(finalize_deletion_result(queued.clone(), &state), queued);
    }

    fn versioned_request_line(request_id: &str, method: &str) -> String {
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "id": request_id,
            "method": method,
            "params": null,
            "sentAt": "2026-07-13T03:45:00.000Z"
        })
        .to_string()
    }

    fn assert_top_level_json_shape(actual: &Value, expected: &Value) {
        let actual = actual
            .as_object()
            .expect("fixture result must be an object");
        let expected = expected
            .as_object()
            .expect("fixture contract must be an object");
        for (field, expected_value) in expected {
            let actual_value = actual
                .get(field)
                .unwrap_or_else(|| panic!("core result omitted fixture field {field}"));
            assert_eq!(
                std::mem::discriminant(actual_value),
                std::mem::discriminant(expected_value),
                "core result changed the JSON kind for fixture field {field}"
            );
        }
    }

    #[test]
    fn shared_protocol_fixtures_are_consumed_by_the_rust_core() {
        let fixture_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("fixtures")
            .join("protocol");
        let mut state = core_state();
        let export_recording = state
            .recording_store
            .start(StartRecordingParams {
                label: Some("shared protocol export fixture".to_string()),
            })
            .expect("start shared protocol export fixture");
        let export_recording_id = export_recording["recordingId"]
            .as_str()
            .expect("shared protocol export recording id")
            .to_string();
        state
            .recording_store
            .finish(RecordingIdParams {
                recording_id: export_recording_id.clone(),
            })
            .expect("finish shared protocol export fixture");

        for entry in fs::read_dir(fixture_root.join("valid")).expect("valid fixture directory") {
            let path = entry.expect("valid fixture entry").path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let fixture: Value =
                serde_json::from_slice(&fs::read(&path).expect("valid fixture read"))
                    .expect("valid fixture JSON");
            let kind = fixture["kind"].as_str().expect("valid fixture kind");
            let (method, mut params, expected) = if kind == "handshake" {
                ("core.version", Value::Null, &fixture["value"])
            } else {
                (
                    fixture["method"].as_str().expect("valid fixture method"),
                    fixture["params"].clone(),
                    &fixture["result"],
                )
            };
            if method == "export.start" {
                params["recordingId"] = json!(export_recording_id.clone());
            }
            let response = handle_request(
                request_with(
                    json!(path.file_name().unwrap().to_string_lossy()),
                    method,
                    params,
                ),
                &mut state,
            );
            assert!(response.ok, "valid fixture {path:?} was rejected");
            assert_top_level_json_shape(
                response.result.as_ref().expect("valid fixture result"),
                expected,
            );
        }

        for entry in fs::read_dir(fixture_root.join("invalid")).expect("invalid fixture directory")
        {
            let path = entry.expect("invalid fixture entry").path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let fixture: Value =
                serde_json::from_slice(&fs::read(&path).expect("invalid fixture read"))
                    .expect("invalid fixture JSON");
            assert!(
                fixture["method"].is_string(),
                "invalid fixture must identify a method"
            );
            assert!(
                fixture["expectedCode"].is_string(),
                "invalid fixture must identify an error code"
            );
        }
    }

    #[test]
    fn async_export_job_survives_request_boundaries_until_acknowledged() {
        let mut state = core_state();
        let started = state
            .recording_store
            .start(StartRecordingParams {
                label: Some("async export fixture".to_string()),
            })
            .expect("start recording");
        let recording_id = started["recordingId"].as_str().unwrap().to_string();
        state
            .recording_store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish recording");

        let accepted = handle_request(
            request_with(
                json!("export-start"),
                "export.start",
                json!({ "recordingId": recording_id, "format": "markdown" }),
            ),
            &mut state,
        );
        assert!(accepted.ok);
        let job_id = accepted.result.unwrap()["jobId"]
            .as_str()
            .unwrap()
            .to_string();

        let completed = (0..100)
            .find_map(|_| {
                let value = state.job_manager.get(&job_id).ok()?;
                if value["terminal"] == true {
                    Some(value)
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    None
                }
            })
            .expect("export job completion");
        assert_eq!(completed["state"], "completed");
        assert_eq!(completed["result"]["format"], "markdown");
        assert_eq!(state.job_manager.list().unwrap()["jobCount"], 1);
        assert_eq!(
            state.job_manager.acknowledge(&job_id).unwrap().response["acknowledged"],
            true
        );
    }

    #[test]
    fn status_reports_stdio_transport() {
        let mut state = core_state();
        let response = handle_request(request("core.status"), &mut state);

        assert!(response.ok);
        let result = response.result.expect("status result");
        assert_eq!(result["sidecarTransport"], "stdio-json-lines");
        assert_eq!(result["networkPolicy"], "disabled-by-default");
        #[cfg(not(feature = "sqlcipher-vault"))]
        assert_eq!(result["vaultState"], "m1-sqlcipher-feature-disabled");
        #[cfg(feature = "sqlcipher-vault")]
        assert_eq!(result["vaultState"], "m1-sqlcipher-feature-enabled");
    }

    #[test]
    fn every_rpc_response_carries_the_protocol_version() {
        let mut state = core_state();
        let success = handle_request(request("core.status"), &mut state);
        let denied = handle_request(request("not.allowed"), &mut state);

        assert_eq!(success.protocol_version, PROTOCOL_VERSION);
        assert_eq!(denied.protocol_version, PROTOCOL_VERSION);
    }

    #[test]
    fn version_handshake_reports_schema_capabilities_and_build() {
        let mut state = core_state();
        let response = handle_request(request("core.version"), &mut state);
        let result = response.result.expect("version handshake");

        assert_eq!(result["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(result["schemaVersion"], 1);
        assert!(result["capabilities"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        assert!(result["build"]["target"]
            .as_str()
            .is_some_and(|target| !target.is_empty()));
        assert!(result["build"]["features"].is_array());
    }

    #[test]
    fn versioned_envelopes_are_validated_and_duplicate_ids_are_rejected() {
        let request_id = "550e8400-e29b-41d4-a716-446655440000";
        let line = versioned_request_line(request_id, "core.status");
        let mut state = core_state();

        let first = handle_line(&line, &mut state).expect("first response");
        assert!(first.ok);
        assert_eq!(first.request_id.as_deref(), Some(request_id));
        assert_eq!(first.id, request_id);

        let duplicate = handle_line(&line, &mut state).expect("duplicate response");
        assert!(!duplicate.ok);
        assert_eq!(duplicate.request_id.as_deref(), Some(request_id));
        assert_eq!(
            duplicate.error.as_ref().map(|error| error.code),
            Some("DUPLICATE_REQUEST_ID")
        );
    }

    #[test]
    fn partial_or_incompatible_versioned_envelopes_are_rejected() {
        let mut state = core_state();
        let partial = json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "requestId": "550e8400-e29b-41d4-a716-446655440000",
            "method": "core.status",
            "params": null
        })
        .to_string();
        let response = handle_line(&partial, &mut state).expect("partial response");
        assert_eq!(
            response.error.as_ref().map(|error| error.code),
            Some("INVALID_RPC_ENVELOPE")
        );

        let incompatible =
            versioned_request_line("550e8400-e29b-41d4-a716-446655440001", "core.status")
                .replace(PROTOCOL_VERSION, "old-protocol");
        let response = handle_line(&incompatible, &mut state).expect("mismatch response");
        assert_eq!(
            response.error.as_ref().map(|error| error.code),
            Some("PROTOCOL_VERSION_MISMATCH")
        );
    }

    #[test]
    fn bare_request_envelopes_are_rejected() {
        let mut state = core_state();
        let bare = json!({
            "id": "bare-request",
            "method": "core.version",
            "params": null
        })
        .to_string();

        let response = handle_line(&bare, &mut state).expect("bare response");
        assert!(!response.ok);
        assert_eq!(
            response.error.as_ref().map(|error| error.code),
            Some("INVALID_RPC_ENVELOPE")
        );
    }

    #[test]
    fn unknown_methods_are_denied() {
        let mut state = core_state();
        let response = handle_request(request("recording.start"), &mut state);

        assert!(!response.ok);
        assert_eq!(response.error.expect("error").code, "METHOD_NOT_ALLOWED");
    }

    #[test]
    fn capture_start_requires_core_consent() {
        let mut state = core_state();
        let response = handle_request(
            request_with(
                json!(1),
                "capture.startMic",
                json!({
                    "label": "must fail before consent"
                }),
            ),
            &mut state,
        );

        assert!(!response.ok);
        assert_eq!(
            response.error.as_ref().map(|error| error.code),
            Some("CONSENT_REQUIRED")
        );
    }

    #[test]
    fn media_import_is_rejected_before_path_access_during_active_capture() {
        let mut state = core_state();
        state.capture_manager.activate_synthetic_for_test();

        let response = handle_request(
            request_with(
                json!("active-import"),
                "media.importFromPath",
                json!({ "sourcePath": "Z:\\path-that-must-not-be-opened\\meeting.wav" }),
            ),
            &mut state,
        );

        assert!(!response.ok);
        assert_eq!(
            response.error.as_ref().map(|error| error.code),
            Some("MEDIA_IMPORT_CAPTURE_ACTIVE")
        );
        assert!(state.capture_manager.is_active());
    }

    #[test]
    fn recording_recovery_is_rejected_during_capture_without_releasing_priority() {
        let mut state = core_state();
        let started = state
            .recording_store
            .start(StartRecordingParams {
                label: Some("active recovery guard".to_string()),
            })
            .expect("start unfinished recording");
        let recording_id = started["recordingId"]
            .as_str()
            .expect("recording id")
            .to_string();
        assert!(state
            .job_manager
            .begin_recording_priority(Duration::from_millis(25))
            .expect("capture owns recording priority"));
        state.capture_manager.activate_synthetic_for_test();

        let response = handle_request(request("recording.durable.recover"), &mut state);

        assert!(!response.ok);
        assert_eq!(
            response.error.as_ref().map(|error| error.code),
            Some("RECORDING_RECOVERY_CAPTURE_ACTIVE")
        );
        assert!(state.capture_manager.is_active());
        assert!(
            !state
                .job_manager
                .begin_recording_priority(Duration::from_millis(25))
                .expect("active capture still owns recording priority"),
            "rejected recovery must not release the active capture's priority"
        );
        let summary = state
            .recording_store
            .read(RecordingIdParams { recording_id })
            .expect("read unfinished recording");
        assert_eq!(summary["summary"]["state"], "recording");
        state.job_manager.set_recording_active(false);
    }

    #[test]
    fn recording_recovery_is_rejected_while_media_import_cleanup_is_unresolved() {
        let mut state = core_state();
        let started = state
            .recording_store
            .start(StartRecordingParams {
                label: Some("media import recovery guard".to_string()),
            })
            .expect("start unfinished recording");
        let recording_id = started["recordingId"]
            .as_str()
            .expect("recording id")
            .to_string();
        let (worker_started, observe_worker_started) = mpsc::channel();
        let (release_worker, worker_released) = mpsc::channel();
        let accepted = state
            .job_manager
            .submit("media-import", true, move |_context| {
                worker_started.send(()).expect("report active import");
                worker_released.recv().expect("release active import");
                Err(JobFailure::new(
                    "MEDIA_IMPORT_CLEANUP_FAILED",
                    "cleanup failed after the rejected recovery request",
                    false,
                ))
            })
            .expect("submit active media import");
        let job_id = accepted["jobId"]
            .as_str()
            .expect("media import job id")
            .to_string();
        observe_worker_started
            .recv_timeout(Duration::from_secs(1))
            .expect("media import entered its worker");
        assert_eq!(
            state.job_manager.get(&job_id).expect("active import")["state"],
            "running"
        );

        let response = handle_request(request("recording.durable.recover"), &mut state);

        assert!(!response.ok);
        assert_eq!(
            response.error.as_ref().map(|error| error.code),
            Some("RECORDING_RECOVERY_MEDIA_IMPORT_ACTIVE")
        );
        let summary = state
            .recording_store
            .read(RecordingIdParams { recording_id })
            .expect("read unfinished recording");
        assert_eq!(summary["summary"]["state"], "recording");
        assert_eq!(
            state
                .job_manager
                .get(&job_id)
                .expect("import remains active")["state"],
            "running"
        );

        release_worker.send(()).expect("finish import cleanup");
        let failed = (0..200)
            .find_map(|_| {
                let value = state.job_manager.get(&job_id).expect("import status");
                if value["terminal"] == true {
                    Some(value)
                } else {
                    std::thread::sleep(Duration::from_millis(5));
                    None
                }
            })
            .expect("media import reached a terminal state");
        assert_eq!(failed["state"], "failed");
        assert_eq!(failed["error"]["code"], "MEDIA_IMPORT_CLEANUP_FAILED");
        assert_eq!(failed["error"]["cleanupResolved"], Value::Null);
        assert_eq!(
            state
                .job_manager
                .begin_recording_priority(Duration::from_millis(25))
                .expect_err("rejected recovery cannot pre-resolve a later cleanup failure")
                .code,
            "MEDIA_IMPORT_CLEANUP_FAILED"
        );
    }

    #[test]
    fn media_local_validation_is_rejected_before_path_access_during_active_capture() {
        let mut state = core_state();
        state.capture_manager.activate_synthetic_for_test();

        let response = handle_request(
            request_with(
                json!("active-validation"),
                "media.validateLocalSourcePath",
                json!({ "sourcePath": "Z:\\path-that-must-not-be-opened\\meeting.wav" }),
            ),
            &mut state,
        );

        assert!(!response.ok);
        assert_eq!(
            response.error.as_ref().map(|error| error.code),
            Some("MEDIA_IMPORT_CAPTURE_ACTIVE")
        );
    }

    #[cfg(windows)]
    #[test]
    fn media_local_validation_returns_only_bounded_pathless_custody_metadata() {
        let mut state = core_state();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let source_path = std::env::temp_dir().join(format!(
            "candor-local-validation-{}-{stamp}.wav",
            process::id()
        ));
        fs::write(&source_path, [1_u8, 2, 3]).expect("write local validation source");

        let response = handle_request(
            request_with(
                json!("local-validation"),
                "media.validateLocalSourcePath",
                json!({ "sourcePath": source_path.to_string_lossy() }),
            ),
            &mut state,
        );
        let _ = fs::remove_file(&source_path);

        assert!(response.ok);
        let value = response.result.expect("local validation result");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["eligible"], true);
        assert_eq!(value["sourceSizeBytes"], 3);
        assert_eq!(value["localStorageVerified"], true);
        assert_eq!(value["regularFile"], true);
        assert_eq!(value["reparsePoint"], false);
        assert_eq!(value["cloudPlaceholder"], false);
        assert_eq!(value["localOnly"], true);
        assert_eq!(value["networkAttempted"], false);
        assert_eq!(value["rawPathExposed"], false);
        assert_eq!(value["keyMaterialExposedToRenderer"], false);
        let object = value.as_object().expect("validation result object");
        assert_eq!(object.len(), 11);
        assert!(object.get("sourcePath").is_none());
        assert!(object.get("canonicalPath").is_none());
        assert!(object.get("sourceSha256").is_none());
        assert!(object.get("sourceHash").is_none());
    }

    #[test]
    fn media_import_requires_a_bound_source_identity_before_path_access() {
        let mut state = core_state();
        let missing_identity = handle_request(
            request_with(
                json!("missing-identity"),
                "media.importFromPath",
                json!({ "sourcePath": "Z:\\path-that-must-not-be-opened\\meeting.wav" }),
            ),
            &mut state,
        );
        assert!(!missing_identity.ok);
        assert_eq!(
            missing_identity.error.as_ref().map(|error| error.code),
            Some("INVALID_PARAMS")
        );
    }

    #[test]
    fn recap_job_template_is_trimmed_and_bounded_at_the_core_boundary() {
        let params = serde_json::from_value::<AiRecapJobParams>(json!({
            "recordingId": "recording-1",
            "recapTemplate": "  Focus on decisions and owners.  "
        }))
        .expect("bounded recap template");
        assert_eq!(
            params.recap_template.as_deref(),
            Some("Focus on decisions and owners.")
        );
        assert!(serde_json::from_value::<AiRecapJobParams>(json!({
            "recordingId": "recording-1",
            "recapTemplate": "x".repeat(4_097)
        }))
        .is_err());
    }

    #[test]
    fn microphone_test_is_ephemeral_and_does_not_require_recording_consent() {
        let mut state = core_state();
        let response = handle_request(
            request_with(
                json!(2),
                "capture.micTestStart",
                json!({ "deviceId": "invalid-device" }),
            ),
            &mut state,
        );

        assert!(!response.ok);
        assert_eq!(
            response.error.as_ref().map(|error| error.code),
            Some("CAPTURE_DEVICE_ID_INVALID")
        );
        let recordings = handle_request(request("recording.durable.list"), &mut state)
            .result
            .expect("recording list after microphone test");
        assert_eq!(recordings["recordingCount"], 0);
        let status = handle_request(request("capture.micTestStatus"), &mut state)
            .result
            .expect("microphone test status");
        assert_eq!(status["active"], false);
        assert_eq!(status["state"], "idle");
        assert_eq!(status["rawPathExposed"], false);
        assert_eq!(status["keyMaterialExposedToRenderer"], false);
    }

    #[test]
    fn microphone_v4_rpc_methods_are_allowlisted() {
        let mut state = core_state();
        let capabilities = handle_request(request("core.capabilities"), &mut state)
            .result
            .expect("core capabilities");
        let methods = capabilities["allowedMethods"]
            .as_array()
            .expect("allowed method list");
        for method in [
            "capture.preferences",
            "capture.setPreferredMicrophone",
            "capture.micTestStart",
            "capture.micTestStatus",
            "capture.micTestSample",
            "capture.micTestStop",
        ] {
            assert!(methods.iter().any(|allowed| allowed == method), "{method}");
        }
    }

    #[test]
    fn protected_term_review_is_core_bound_and_creates_an_immutable_revision() {
        let mut state = core_state();
        state
            .replacement_rules
            .upsert_custom(replacement_rules::ReplacementRuleSetUpsertParams {
                id: Some("protected-rules".to_string()),
                expected_version: None,
                name: "Protected names".to_string(),
                rules: vec![replacement_rules::ReplacementRule {
                    id: "company-name".to_string(),
                    order: 1,
                    match_mode: replacement_rules::ReplacementMatchMode::WholeWord,
                    literal: "Acme".to_string(),
                    replacement: "ACME".to_string(),
                    protected_term_review: true,
                    enabled: true,
                }],
            })
            .expect("create protected replacement rules");
        state
            .meeting_profiles
            .upsert_custom(MeetingProfileUpsertParams {
                id: Some("protected-profile".to_string()),
                expected_version: None,
                name: "Protected profile".to_string(),
                capture_source: ProfileCaptureSource::Microphone,
                language: "en".to_string(),
                local_model_tier: meeting_profiles::ProfileModelTier::Fast,
                speech_model_id: None,
                cleanup_model_id: None,
                summary_model_id: None,
                dictionary_ids: Vec::new(),
                replacement_rule_set_id: Some("protected-rules".to_string()),
                recap_template: String::new(),
                live_transcription: false,
            })
            .expect("create protected meeting profile");
        let profile = state
            .meeting_profiles
            .processing_snapshot_for_capture(
                "protected-profile",
                1,
                ProfileCaptureSource::Microphone,
                &state.replacement_rules,
            )
            .expect("resolve immutable capture profile");
        let started = state
            .recording_store
            .start_with_processing_profile(
                StartRecordingParams {
                    label: Some("Protected review".to_string()),
                },
                Some(profile),
            )
            .expect("start protected review recording");
        let recording_id = started["recordingId"]
            .as_str()
            .expect("recording id")
            .to_string();
        state
            .recording_store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish protected review recording");
        let attempt_id = state
            .recording_store
            .begin_transcription_attempt(&recording_id)
            .expect("begin initial transcript attempt");
        state
            .recording_store
            .write_transcription_attempt_segment(
                &attempt_id,
                WriteTranscriptSegmentParams {
                    recording_id: recording_id.clone(),
                    channel: "mic".to_string(),
                    speaker: Some("Speaker 1".to_string()),
                    text: "Acme joined the meeting.".to_string(),
                    start_ms: 10,
                    duration_ms: Some(20),
                    end_ms: None,
                    confidence: Some(0.95),
                },
            )
            .expect("write initial transcript attempt");
        let initial_text = "Acme joined the meeting.";
        let initial = state
            .recording_store
            .complete_transcription_attempt(recording_store::TranscriptionSuccessDraft {
                recording_id: recording_id.clone(),
                attempt_id: Some(attempt_id),
                chunk_indices: Vec::new(),
                engine: "test-engine".to_string(),
                model_id: None,
                model_sha256: None,
                started_at_ms: 1,
                elapsed_ms: 1,
                comparison: recording_store::TranscriptComparisonDraft {
                    raw_text_sha256: recording_store::transcript_text_sha256(initial_text),
                    normalized_text_sha256: recording_store::transcript_text_sha256(initial_text),
                    raw_text_bytes: initial_text.len() as u64,
                    normalized_text_bytes: initial_text.len() as u64,
                    raw_segment_count: 1,
                    normalized_segment_count: 1,
                    changed: false,
                },
                raw_text: initial_text.to_string(),
            })
            .expect("commit initial transcript");
        let initial_revision_id = initial["revisionId"]
            .as_str()
            .expect("initial revision id")
            .to_string();

        let preview = handle_request(
            request_with(
                json!(90),
                "transcription.protectedTermReview",
                json!({ "recordingId": recording_id.clone() }),
            ),
            &mut state,
        );
        assert!(preview.ok);
        let preview = preview.result.expect("protected review preview");
        assert_eq!(preview["reviewRequired"], true);
        assert_eq!(preview["revisionId"], initial_revision_id);
        assert_eq!(preview["previewSegments"][0]["before"], initial_text);
        assert_eq!(
            preview["previewSegments"][0]["after"],
            "ACME joined the meeting."
        );
        let preview_token = preview["previewToken"]
            .as_str()
            .expect("preview token")
            .to_string();

        let forged = handle_request(
            request_with(
                json!(91),
                "transcription.applyProtectedTermReview",
                json!({
                    "recordingId": recording_id.clone(),
                    "revisionId": initial_revision_id,
                    "previewToken": preview_token,
                    "transcript": "renderer-forged text"
                }),
            ),
            &mut state,
        );
        assert!(!forged.ok);
        assert_eq!(
            forged.error.as_ref().map(|error| error.code),
            Some("INVALID_PARAMS")
        );

        let applied = handle_request(
            request_with(
                json!(92),
                "transcription.applyProtectedTermReview",
                json!({
                    "recordingId": recording_id.clone(),
                    "revisionId": preview["revisionId"],
                    "previewToken": preview["previewToken"]
                }),
            ),
            &mut state,
        );
        assert!(applied.ok);
        let applied = applied.result.expect("protected review apply");
        assert_eq!(applied["trustHistory"]["source"], "review");
        assert_eq!(applied["rawPathExposed"], false);
        assert_eq!(applied["networkAttempted"], false);

        let transcript = state
            .recording_store
            .transcript(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("reviewed transcript");
        assert_eq!(
            transcript["segments"][0]["text"],
            "ACME joined the meeting."
        );
        let history = state
            .recording_store
            .trust_history(RecordingIdParams { recording_id })
            .expect("protected review history");
        assert_eq!(history["revisionCount"], 2);
        assert_eq!(history["revisions"][0]["revisionId"], initial_revision_id);
        assert_eq!(history["revisions"][1]["source"], "review");
        assert_eq!(
            history["processingReceipts"][1]["operation"],
            "protected-term-review"
        );
    }

    #[test]
    fn live_transcript_renderer_methods_are_bounded_and_text_ingress_is_absent() {
        let mut state = core_state();
        let capabilities = handle_request(request("core.capabilities"), &mut state)
            .result
            .expect("core capabilities");
        let methods = capabilities["allowedMethods"]
            .as_array()
            .expect("allowed method list");
        for method in candor_core::live_transcript_service::LIVE_TRANSCRIPT_RENDERER_METHODS {
            assert!(methods.iter().any(|allowed| allowed == method), "{method}");
        }
        assert!(!methods.iter().any(|method| method == "liveTranscript.push"));
        assert!(!methods
            .iter()
            .any(|method| method == "liveTranscript.reconcile"));

        let invalid_identifier = handle_request(
            request_with(
                json!(2),
                "liveTranscript.enable",
                json!({ "recordingId": "../vault" }),
            ),
            &mut state,
        );
        assert!(!invalid_identifier.ok);
        assert_eq!(
            invalid_identifier.error.as_ref().map(|error| error.code),
            Some("LIVE_TRANSCRIPT_ID_INVALID")
        );

        let unknown_field = handle_request(
            request_with(
                json!(3),
                "liveTranscript.enable",
                json!({ "recordingId": "recording_1", "text": "forged" }),
            ),
            &mut state,
        );
        assert!(!unknown_field.ok);
        assert_eq!(
            unknown_field.error.as_ref().map(|error| error.code),
            Some("INVALID_PARAMS")
        );

        let drain_with_params = handle_request(
            request_with(
                json!(4),
                "liveTranscript.eventsDrain",
                json!({ "recordingId": "recording_1" }),
            ),
            &mut state,
        );
        assert!(!drain_with_params.ok);
        assert_eq!(
            drain_with_params.error.as_ref().map(|error| error.code),
            Some("INVALID_PARAMS")
        );
    }

    #[test]
    fn live_transcript_start_fails_closed_and_cleans_up_without_capture_prerequisites() {
        let mut state = core_state();
        let enable = handle_request(
            request_with(
                json!(2),
                "liveTranscript.enable",
                json!({ "recordingId": "recording_1" }),
            ),
            &mut state,
        )
        .result
        .expect("enable live transcript");
        assert_eq!(enable["enabled"], true);
        assert_eq!(enable["active"], false);
        assert_eq!(enable["networkAttempted"], false);
        assert_eq!(enable["rawPathExposed"], false);
        assert_eq!(enable["keyMaterialExposedToRenderer"], false);

        let start = handle_request(
            request_with(
                json!(3),
                "liveTranscript.start",
                json!({ "recordingId": "recording_1" }),
            ),
            &mut state,
        );
        assert!(!start.ok);
        assert_eq!(
            start.error.as_ref().map(|error| error.code),
            Some(if cfg!(feature = "local-whisper") {
                "RECORDING_NOT_FOUND"
            } else {
                "LIVE_TRANSCRIPT_ENGINE_UNAVAILABLE"
            })
        );
        let after_failed_start = handle_request(
            request_with(
                json!(31),
                "liveTranscript.enable",
                json!({ "recordingId": "recording_1" }),
            ),
            &mut state,
        )
        .result
        .expect("inspect failed live transcript start");
        assert_eq!(after_failed_start["active"], false);

        let snapshot = handle_request(
            request_with(
                json!(4),
                "liveTranscript.snapshot",
                json!({ "recordingId": "recording_1" }),
            ),
            &mut state,
        )
        .result
        .expect("snapshot live transcript");
        assert_eq!(snapshot["segmentCount"], 0);
        assert_eq!(snapshot["segments"], json!([]));

        let drained = handle_request(request("liveTranscript.eventsDrain"), &mut state)
            .result
            .expect("drain live transcript events");
        assert_eq!(drained["drainedEventCount"], 0);
        assert_eq!(drained["events"], json!([]));
        assert_eq!(drained["localOnly"], true);
        assert_eq!(drained["networkAttempted"], false);

        let stopped = handle_request(
            request_with(
                json!(5),
                "liveTranscript.stop",
                json!({ "recordingId": "recording_1" }),
            ),
            &mut state,
        )
        .result
        .expect("stop live transcript");
        assert_eq!(stopped["sessionRemoved"], true);
        assert_eq!(stopped["memoryCleared"], true);
        assert_eq!(stopped["zeroizationGuaranteed"], false);
    }

    #[test]
    fn startup_recovery_marks_interrupted_recordings() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!("candor-core-startup-recovery-{stamp}"));
        let recording_root = root.join("recordings");
        let vault_root = root.join("vault");
        let writer = RecordingStore::with_root(recording_root.clone());
        let started = writer
            .start(StartRecordingParams {
                label: Some("startup recovery unit".to_string()),
            })
            .expect("start recording");
        let recording_id = started["recordingId"]
            .as_str()
            .expect("recording id")
            .to_string();
        writer
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "flushed before restart".to_string(),
            })
            .expect("write chunk");
        let cleanup_jobs = JobManager::with_test_roots(
            PROTOCOL_VERSION,
            writer.settings_root_for_core().join("background-jobs"),
            writer.key_root_for_core(),
        );
        let cleanup_job = cleanup_jobs
            .submit("media-import", true, |context| {
                while !context.cancelled() {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(JobFailure::new(
                    "MEDIA_IMPORT_CLEANUP_FAILED",
                    "startup recovery fixture requires reconciliation",
                    false,
                ))
            })
            .expect("seed cleanup failure");
        let cleanup_job_id = cleanup_job["jobId"]
            .as_str()
            .expect("cleanup job id")
            .to_string();
        for _ in 0..200 {
            if cleanup_jobs.get(&cleanup_job_id).expect("cleanup status")["state"] == "running" {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            cleanup_jobs
                .begin_recording_priority(Duration::from_secs(1))
                .expect_err("seeded cleanup failure blocks recording")
                .code,
            "MEDIA_IMPORT_CLEANUP_FAILED"
        );
        drop(cleanup_jobs);

        let mut state = CoreState::with_stores(
            now_ms(),
            RecordingStore::with_root(recording_root),
            VaultStore::with_root(vault_root),
        );

        let status = handle_request(request("core.status"), &mut state);
        assert!(status.ok);
        let status = status.result.expect("status");
        assert_eq!(status["startupRecovery"]["ok"], true);
        assert_eq!(status["startupRecovery"]["recoveredCount"], 1);
        assert_eq!(status["startupRecovery"]["rawPathExposed"], false);
        assert_eq!(
            state
                .job_manager
                .get(&cleanup_job_id)
                .expect("resolved cleanup audit")["error"]["cleanupResolved"],
            true
        );
        assert!(state
            .job_manager
            .begin_recording_priority(Duration::from_millis(25))
            .expect("startup recovery resolves the persistent cleanup latch"));
        state.job_manager.set_recording_active(false);

        let list = handle_request(request("recording.durable.list"), &mut state);
        assert!(list.ok);
        let list = list.result.expect("list");
        assert_eq!(list["recordings"][0]["recordingId"], recording_id);
        assert_eq!(list["recordings"][0]["state"], "needsRecovery");
        assert_eq!(list["recordings"][0]["rawPathExposed"], false);
    }

    #[test]
    fn read_only_automation_coexists_with_an_active_recording_without_mutation() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!("candor-core-automation-read-{stamp}"));
        let recording_root = root.join("recordings");
        let vault_root = root.join("vault");
        let writer = RecordingStore::with_root(recording_root.clone());
        let started = writer
            .start(StartRecordingParams {
                label: Some("active desktop capture".to_string()),
            })
            .expect("start active recording");
        let recording_id = started["recordingId"]
            .as_str()
            .expect("recording id")
            .to_string();
        writer
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "durable active content".to_string(),
            })
            .expect("write active chunk");
        writer
            .write_transcript_segment(WriteTranscriptSegmentParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                speaker: None,
                text: "read-only active transcript".to_string(),
                start_ms: 0,
                duration_ms: Some(100),
                end_ms: None,
                confidence: Some(0.9),
            })
            .expect("write active transcript segment");
        let background_jobs_root = writer.settings_root_for_core().join("background-jobs");
        let terminology_root = writer.settings_root_for_core().join("terminology");

        let mut state = CoreState::with_stores_mode(
            now_ms(),
            RecordingStore::with_root(recording_root),
            VaultStore::with_root(vault_root),
            true,
        );
        assert!(!state.startup_recovery.attempted);
        assert!(!background_jobs_root.exists());

        let listed = handle_request(
            request_with(
                json!(81),
                "recording.durable.listPage",
                json!({ "offset": 0, "limit": 25 }),
            ),
            &mut state,
        );
        assert!(listed.ok);
        assert_eq!(
            listed.result.expect("list result")["recordings"][0]["state"],
            "recording"
        );

        let transcript = handle_request(
            request_with(
                json!(82),
                "recording.durable.transcriptPage",
                json!({ "recordingId": recording_id.clone(), "offset": 0, "limit": 25 }),
            ),
            &mut state,
        );
        assert!(transcript.ok);
        let transcript = transcript.result.expect("transcript result");
        assert_eq!(
            transcript["segments"][0]["text"],
            "read-only active transcript"
        );
        assert_eq!(transcript["terminologyCorrectionsApplied"], 0);
        assert!(!terminology_root.exists());

        let searched = handle_request(
            request_with(
                json!(83),
                "recording.durable.search",
                json!({ "query": "active content" }),
            ),
            &mut state,
        );
        assert!(searched.ok);
        let searched = searched.result.expect("search result");
        assert_eq!(searched["matchCount"], 1);
        assert_eq!(searched["matches"][0]["rowKind"], "originalTranscriptText");
        assert_eq!(searched["searchBackend"], "bounded-read-only-source-scan");

        let denied = handle_request(request("recording.durable.recover"), &mut state);
        assert!(!denied.ok);
        assert_eq!(
            denied.error.expect("denied error").code,
            "METHOD_NOT_ALLOWED"
        );

        let still_active = writer
            .read(RecordingIdParams { recording_id })
            .expect("read active manifest");
        assert_eq!(still_active["summary"]["state"], "recording");
        assert!(!background_jobs_root.exists());
        #[cfg(feature = "sqlcipher-vault")]
        {
            let mut settled = false;
            for _ in 0..200 {
                match writer.search(SearchRecordingsParams {
                    query: "active content".to_string(),
                }) {
                    Ok(_) => {
                        settled = true;
                        break;
                    }
                    Err(error) if error.code == "RECORDING_SEARCH_INDEX_BUILDING" => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => {
                        panic!("search backfill failed during test cleanup: {}", error.code)
                    }
                }
            }
            assert!(
                settled,
                "search backfill did not settle during test cleanup"
            );
        }
    }

    #[test]
    fn malformed_json_is_denied() {
        let mut state = core_state();
        let response = handle_line("{ definitely not json", &mut state).expect("response");

        assert!(!response.ok);
        assert_eq!(response.error.expect("error").code, "MALFORMED_JSON_RPC");
    }

    #[test]
    fn oversized_rpc_frames_are_denied() {
        let oversized = "x".repeat(MAX_RPC_LINE_BYTES + 1);
        let mut state = core_state();
        let response = handle_line(&oversized, &mut state).expect("response");

        assert!(!response.ok);
        assert_eq!(response.error.expect("error").code, "RPC_FRAME_TOO_LARGE");
    }

    #[test]
    fn bounded_reader_drains_an_oversized_frame_before_the_next_request() {
        let next = versioned_request_line("550e8400-e29b-41d4-a716-446655440002", "core.status");
        let input = format!("{}\n{}\n", "x".repeat(MAX_RPC_LINE_BYTES + 1), next);
        let mut reader = io::Cursor::new(input.into_bytes());

        assert!(matches!(
            read_bounded_frame(&mut reader).expect("oversized frame"),
            BoundedFrame::TooLarge
        ));
        let BoundedFrame::Frame(frame) = read_bounded_frame(&mut reader).expect("next frame")
        else {
            panic!("expected the next bounded frame");
        };
        assert_eq!(String::from_utf8(frame).expect("utf8"), next);
    }

    #[test]
    fn empty_rpc_frames_are_ignored() {
        let mut state = core_state();
        assert!(handle_line("   ", &mut state).is_none());
    }

    #[test]
    fn diarization_rpc_is_gated_pathless_and_uses_only_user_controlled_names() {
        let mut state = core_state();
        let status = handle_request(request("diarization.status"), &mut state);
        assert!(status.ok);
        let status = status.result.unwrap();
        assert_eq!(status["state"], "disabled");
        assert_eq!(status["engineAvailable"], false);
        assert_eq!(status["diarizationAvailable"], false);
        assert_eq!(status["biometricIdentityClaimed"], false);
        assert_eq!(status["networkAttempted"], false);

        let enabled = handle_request(
            request_with(
                json!(70),
                "diarization.updatePreference",
                json!({ "enabled": true }),
            ),
            &mut state,
        );
        assert!(enabled.ok);
        let enabled = enabled.result.unwrap();
        assert_eq!(enabled["state"], "engine-unavailable");
        assert_eq!(enabled["diarizationAvailable"], false);

        let started = handle_request(
            request_with(
                json!(71),
                "recording.durable.start",
                json!({ "label": "Speaker labels" }),
            ),
            &mut state,
        );
        let recording_id = started.result.unwrap()["recordingId"]
            .as_str()
            .unwrap()
            .to_string();
        let assigned = handle_request(
            request_with(
                json!(72),
                "diarization.assignSpeakerName",
                json!({
                    "recordingId": recording_id.clone(),
                    "anonymousSpeakerId": "speaker-1",
                    "displayName": "Avery"
                }),
            ),
            &mut state,
        );
        assert!(assigned.ok);
        let assigned = assigned.result.unwrap();
        assert_eq!(assigned["assignments"][0]["source"], "user");
        assert_eq!(assigned["assignments"][0]["identityInferred"], false);
        assert_eq!(assigned["encryptedAtRest"], true);
        assert_eq!(assigned["rawPathExposed"], false);
        assert!(!serde_json::to_string(&assigned)
            .unwrap()
            .contains("C:\\\\private"));

        let forged = handle_request(
            request_with(
                json!(73),
                "diarization.updatePreference",
                json!({ "enabled": true, "modelPath": "C:\\private\\model.bin" }),
            ),
            &mut state,
        );
        assert!(!forged.ok);
        assert_eq!(forged.error.unwrap().code, "INVALID_PARAMS");

        assert!(
            handle_request(
                request_with(
                    json!(74),
                    "recording.durable.finish",
                    json!({ "recordingId": recording_id.clone() }),
                ),
                &mut state,
            )
            .ok
        );
        assert!(
            handle_request(
                request_with(
                    json!(75),
                    "recording.durable.delete",
                    json!({ "recordingId": recording_id.clone() }),
                ),
                &mut state,
            )
            .ok
        );
        let names_after_delete = state
            .diarization_service
            .list_speaker_names(DiarizationRecordingParams { recording_id })
            .unwrap();
        assert_eq!(names_after_delete["assignmentCount"], 0);
    }

    #[test]
    fn durable_recording_rpc_round_trip_uses_local_store_without_paths() {
        let mut state = core_state();
        let start = handle_request(
            request_with(
                json!(1),
                "recording.durable.start",
                json!({ "label": "unit" }),
            ),
            &mut state,
        );
        assert!(start.ok);
        let recording_id = start.result.as_ref().unwrap()["recordingId"]
            .as_str()
            .unwrap()
            .to_string();

        let write = handle_request(
            request_with(
                json!(2),
                "recording.durable.writeTextChunk",
                json!({
                    "recordingId": recording_id.clone(),
                    "channel": "mic",
                    "dataUtf8": "audio bytes"
                }),
            ),
            &mut state,
        );
        assert!(write.ok);
        let result = write.result.expect("write result");
        assert_eq!(result["chunkCount"], 1);
        assert_eq!(result["rawPathExposed"], false);

        let audio_bytes = vec![0_u8; 160];
        let write_audio = handle_request(
            request_with(
                json!(7),
                "recording.durable.writeAudioChunk",
                json!({
                    "recordingId": recording_id.clone(),
                    "channel": "system",
                    "sampleRateHz": 8000,
                    "channelCount": 1,
                    "bitsPerSample": 16,
                    "dataBase64": BASE64_STANDARD.encode(&audio_bytes)
                }),
            ),
            &mut state,
        );
        assert!(write_audio.ok);

        let write_segment = handle_request(
            request_with(
                json!(10),
                "recording.durable.writeTranscriptSegment",
                json!({
                    "recordingId": recording_id.clone(),
                    "channel": "mic",
                    "speaker": "Alex",
                    "text": "Reliability is our moat.",
                    "startMs": 0,
                    "durationMs": 900,
                    "confidence": 0.91
                }),
            ),
            &mut state,
        );
        assert!(write_segment.ok);

        let finish = handle_request(
            request_with(
                json!(3),
                "recording.durable.finish",
                json!({ "recordingId": recording_id.clone() }),
            ),
            &mut state,
        );
        assert!(finish.ok);

        let list = handle_request(request("recording.durable.list"), &mut state);
        assert!(list.ok);
        let list_result = list.result.expect("list result");
        assert_eq!(list_result["rawPathExposed"], false);
        assert_eq!(list_result["recordingCount"], 1);

        let read = handle_request(
            request_with(
                json!(4),
                "recording.durable.read",
                json!({ "recordingId": recording_id.clone() }),
            ),
            &mut state,
        );
        assert!(read.ok);
        let read_result = read.result.expect("read result");
        assert_eq!(read_result["rawPathExposed"], false);
        assert_eq!(read_result["chunks"][0]["textUtf8"], "audio bytes");
        assert_eq!(read_result["chunks"][1]["kind"], "audioPcm16le");
        assert_eq!(read_result["chunks"][2]["kind"], "transcriptSegment");

        let transcript = handle_request(
            request_with(
                json!(11),
                "recording.durable.transcript",
                json!({ "recordingId": recording_id.clone() }),
            ),
            &mut state,
        );
        assert!(transcript.ok);
        let transcript_result = transcript.result.expect("transcript result");
        assert_eq!(transcript_result["rawPathExposed"], false);
        assert_eq!(transcript_result["segmentCount"], 1);
        assert_eq!(transcript_result["segments"][0]["startMs"], 0);
        assert_eq!(transcript_result["segments"][0]["endMs"], 900);
        assert_eq!(
            transcript_result["segments"][0]["text"],
            "Reliability is our moat."
        );

        let replay = handle_request(
            request_with(
                json!(8),
                "recording.durable.replayManifest",
                json!({ "recordingId": recording_id.clone() }),
            ),
            &mut state,
        );
        assert!(replay.ok);
        let replay_result = replay.result.expect("replay result");
        assert_eq!(replay_result["rawPathExposed"], false);
        assert_eq!(replay_result["audioChunkCount"], 1);
        assert_eq!(replay_result["audioChunks"][0]["durationMs"], 10);

        let audio = handle_request(
            request_with(
                json!(9),
                "recording.durable.readAudioChunk",
                json!({ "recordingId": recording_id.clone(), "index": 1 }),
            ),
            &mut state,
        );
        assert!(audio.ok);
        let audio_result = audio.result.expect("audio result");
        assert_eq!(audio_result["rawPathExposed"], false);
        assert_eq!(audio_result["keyMaterialExposedToRenderer"], false);
        assert_eq!(
            audio_result["dataBase64"],
            BASE64_STANDARD.encode(&audio_bytes)
        );

        let search = search_when_ready(&mut state, json!(5), "Reliability");
        assert!(search.ok);
        let search_result = search.result.expect("search result");
        assert_eq!(search_result["rawPathExposed"], false);
        assert_eq!(search_result["matchCount"], 1);

        let export = handle_request(
            request_with(
                json!(6),
                "export.create",
                json!({ "recordingId": recording_id, "format": "markdown" }),
            ),
            &mut state,
        );
        assert!(export.ok);
        let export_result = export.result.expect("export result");
        assert_eq!(export_result["rawPathExposed"], false);
        assert_eq!(export_result["keyMaterialExposedToRenderer"], false);
        assert!(export_result["markdown"]
            .as_str()
            .expect("markdown")
            .contains("Reliability is our moat."));
    }

    #[test]
    fn corrupt_bundled_ai_does_not_block_existing_meetings() {
        let mut state = core_state();
        let started = handle_request(
            request_with(
                json!(30),
                "recording.durable.start",
                json!({ "label": "Existing meeting" }),
            ),
            &mut state,
        );
        let recording_id = started.result.expect("started recording")["recordingId"]
            .as_str()
            .expect("recording id")
            .to_string();
        assert!(
            handle_request(
                request_with(
                    json!(31),
                    "recording.durable.finish",
                    json!({ "recordingId": recording_id.clone() }),
                ),
                &mut state,
            )
            .ok
        );

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let bundle_root = std::env::temp_dir().join(format!(
            "candor-corrupt-bundle-main-test-{}-{stamp}",
            process::id()
        ));
        fs::create_dir_all(&bundle_root).expect("create corrupt bundle root");
        fs::write(bundle_root.join("manifest.json"), b"{not-json")
            .expect("write corrupt bundle manifest");
        state.bundled_ai_assets = BundledAiAssets::with_root(bundle_root.clone());
        state.model_manager = ModelManager::with_bundled_assets(state.bundled_ai_assets.clone());

        let verification_timeout = Duration::from_secs(10);
        let verification_started = Instant::now();
        let status = loop {
            let response = handle_request(request("ai.bundledAssetsStatus"), &mut state);
            assert!(response.ok);
            let status = response.result.expect("bundle status");
            if status["state"] != "checking" {
                break status;
            }

            let elapsed = verification_started.elapsed();
            assert!(
                elapsed < verification_timeout,
                "background bundled status did not complete within {verification_timeout:?}"
            );
            std::thread::sleep(
                Duration::from_millis(5).min(verification_timeout.saturating_sub(elapsed)),
            );
        };
        assert_eq!(status["state"], "corrupt");
        assert_eq!(status["repairRequired"], true);
        assert_eq!(status["rawPathExposed"], false);
        assert_eq!(status["hashExposed"], false);
        assert!(!serde_json::to_string(&status)
            .expect("serialize bundle status")
            .contains(bundle_root.to_string_lossy().as_ref()));

        let list = handle_request(request("recording.durable.list"), &mut state);
        assert!(list.ok);
        assert_eq!(list.result.expect("meeting list")["recordingCount"], 1);
        let read = handle_request(
            request_with(
                json!(32),
                "recording.durable.read",
                json!({ "recordingId": recording_id }),
            ),
            &mut state,
        );
        assert!(read.ok);
        assert_eq!(
            read.result.expect("meeting detail")["rawPathExposed"],
            false
        );
        let _ = fs::remove_dir_all(bundle_root);
    }

    #[test]
    fn cancelling_dictionary_import_deletes_encrypted_staging_before_rpc_success() {
        let mut state = core_state();
        let staged = state
            .dictionary_staging
            .stage_bytes("cancelled.candordict", b"encrypted dictionary fixture")
            .expect("stage dictionary fixture");
        let accepted = state
            .job_manager
            .submit_descriptor(
                job_manager::JobDescriptor::DictionaryImport {
                    staging_token: staged.staging_token.clone(),
                    expected_sha256: staged.expected_sha256.clone(),
                    original_display_name: staged.original_display_name.clone(),
                    bytes: staged.bytes,
                    legacy_source_file_name: None,
                    legacy_archive_base64: None,
                },
                std::sync::Arc::new(|_, context| {
                    while !context.cancelled() {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Ok(json!({ "rawPathExposed": false }))
                }),
            )
            .expect("submit dictionary import");
        let job_id = accepted["jobId"].as_str().expect("job id").to_string();

        let response = handle_request(
            request_with(json!(33), "jobs.cancel", json!({ "jobId": job_id.clone() })),
            &mut state,
        );

        assert!(response.ok);
        assert_eq!(
            state
                .job_manager
                .dictionary_staging_reference(&job_id)
                .expect("staging reference"),
            None
        );
        let error = state
            .dictionary_staging
            .read_verified(
                &staged.staging_token,
                &staged.expected_sha256,
                staged.bytes,
                &staged.original_display_name,
            )
            .expect_err("cancelled staging must be deleted");
        assert_eq!(error.code, "DICTIONARY_STAGING_MISSING");
    }

    #[test]
    fn durable_delete_rpc_permanently_removes_finished_data_without_a_license_state() {
        let mut state = core_state();
        let started = handle_request(
            request_with(
                json!(20),
                "recording.durable.start",
                json!({ "label": "Delete RPC" }),
            ),
            &mut state,
        );
        let recording_id = started.result.expect("started recording")["recordingId"]
            .as_str()
            .expect("recording id")
            .to_string();
        let finished = handle_request(
            request_with(
                json!(21),
                "recording.durable.finish",
                json!({ "recordingId": recording_id.clone() }),
            ),
            &mut state,
        );
        assert!(finished.ok);

        let deleted = handle_request(
            request_with(
                json!(22),
                "recording.durable.delete",
                json!({ "recordingId": recording_id.clone() }),
            ),
            &mut state,
        );

        assert!(deleted.ok);
        let result = deleted.result.expect("delete result");
        assert_eq!(result["state"], "deleted");
        assert_eq!(result["deleted"], true);
        assert_eq!(result["permanent"], true);
        assert_eq!(result["rawPathExposed"], false);
        assert_eq!(
            handle_request(request("recording.durable.list"), &mut state)
                .result
                .expect("list after delete")["recordingCount"],
            0
        );

        for response in [
            handle_request(
                request_with(
                    json!(23),
                    "ai.ask.start",
                    json!({
                        "recordingId": recording_id.clone(),
                        "question": "private question after deletion"
                    }),
                ),
                &mut state,
            ),
            handle_request(
                request_with(
                    json!(24),
                    "export.start",
                    json!({
                        "recordingId": recording_id.clone(),
                        "format": "markdown"
                    }),
                ),
                &mut state,
            ),
        ] {
            assert!(!response.ok);
            assert_eq!(
                response.error.as_ref().map(|error| error.code),
                Some("RECORDING_NOT_FOUND")
            );
        }
        assert_eq!(
            state.job_manager.list().expect("jobs after delete")["jobCount"],
            0
        );
    }

    #[test]
    fn vault_os_key_storage_proof_never_exposes_key_or_path() {
        let mut state = core_state();
        let response = handle_request(request("vault.proofOsKeyStorage"), &mut state);

        assert!(response.ok);
        let result = response.result.expect("os key storage proof");
        assert_eq!(result["keyMaterialExposedToRenderer"], false);
        assert_eq!(result["rawPathExposed"], false);
    }

    #[cfg(all(windows, feature = "sqlcipher-vault"))]
    #[test]
    fn vault_open_local_uses_os_key_without_renderer_exposure() {
        let mut state = core_state();
        let response = handle_request(request("vault.openLocal"), &mut state);

        assert!(response.ok);
        let result = response.result.expect("local vault result");
        assert_eq!(result["backend"], "sqlcipher");
        assert_eq!(result["encrypted"], true);
        assert_eq!(result["openMode"], "os-key");
        assert_eq!(result["proofHarness"], false);
        assert_eq!(result["passphraseRequired"], false);
        assert_eq!(result["keyMaterialExposedToRenderer"], false);
        assert_eq!(result["rawPathExposed"], false);
    }

    #[cfg(all(windows, feature = "sqlcipher-vault"))]
    #[test]
    fn vault_os_key_open_proof_uses_sqlcipher_without_renderer_exposure() {
        let mut state = core_state();
        let response = handle_request(request("vault.openWithOsKeyProof"), &mut state);

        assert!(response.ok);
        let result = response.result.expect("os key vault proof");
        assert_eq!(result["backend"], "sqlcipher");
        assert_eq!(result["encrypted"], true);
        assert_eq!(result["passphraseRequired"], false);
        assert_eq!(result["reopenVerified"], true);
        assert_eq!(result["stableAfterReopen"], true);
        assert_eq!(result["keyMaterialExposedToRenderer"], false);
        assert_eq!(result["rawPathExposed"], false);
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn vault_wrong_key_rpc_proof_uses_sqlcipher_without_exposing_key_or_path() {
        let mut state = core_state();
        let response = handle_request(
            request_with(
                json!(1),
                "vault.proofWrongKeyFails",
                json!({
                    "correctPassphrase": "correct horse battery staple",
                    "wrongPassphrase": "wrong horse battery staple"
                }),
            ),
            &mut state,
        );

        assert!(response.ok);
        let result = response.result.expect("vault proof result");
        assert_eq!(result["wrongKeyFailed"], true);
        assert_eq!(result["keyMaterialExposedToRenderer"], false);
        assert_eq!(result["rawPathExposed"], false);
        assert_eq!(result["open"]["backend"], "sqlcipher");
    }

    #[cfg(not(feature = "sqlcipher-vault"))]
    #[test]
    fn vault_status_reports_sqlcipher_feature_disabled_without_exposing_key_or_path() {
        let mut state = core_state();
        let response = handle_request(request("vault.status"), &mut state);

        assert!(response.ok);
        let result = response.result.expect("vault status");
        assert_eq!(result["backend"], "sqlcipher");
        assert_eq!(result["sqlcipherAvailable"], false);
        assert_eq!(result["keyMaterialExposedToRenderer"], false);
        assert_eq!(result["rawPathExposed"], false);
    }
}
