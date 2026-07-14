mod bundled_ai_assets;
mod capture_service;
mod consent_store;
mod job_manager;
mod local_ai_service;
mod local_instruct_assets;
mod local_instruct_model;
mod local_model_scheduler;
mod model_manager;
mod os_key_store;
mod recording_store;
mod report_export;
mod transcription_service;
mod update_policy;
mod v2_importer;
mod vault_store;

use std::collections::{HashSet, VecDeque};
use std::io::{self, BufRead, Write};
use std::process;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use bundled_ai_assets::BundledAiAssets;
use capture_service::{
    CaptureError, CaptureManager, CaptureStartMicAndSystemParams, CaptureStartParams,
};
use consent_store::{ConsentAcknowledgeParams, ConsentError, ConsentStore};
use job_manager::{JobFailure, JobManager, JobManagerError};
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
use model_manager::{
    ModelIdParams, ModelImportAbortParams, ModelImportChunkParams, ModelImportFinishParams,
    ModelImportStartParams, ModelManager, ModelManagerError, ModelProofParams,
};
use recording_store::{
    AudioChunkParams, ExportRecordingParams, RecordingIdParams, RecordingPageParams,
    RecordingStore, RecordingStoreError, SaveNotesParams, SearchRecordingsParams,
    StartRecordingParams, TranscriptPageParams, WriteAudioChunkParams, WriteChunkParams,
    WriteTranscriptSegmentParams,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use transcription_service::{
    TranscriptionError, TranscriptionProofParams, TranscriptionRunLocalParams, TranscriptionService,
};
use update_policy::UpdatePolicy;
use v2_importer::{V2ImportError, V2ImportFolderParams, V2ImportProofParams, V2Importer};
use vault_store::{VaultOpenParams, VaultStore, VaultStoreError};

const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");
const PROTOCOL_VERSION: &str = "m0-jsonrpc-stdio-1";
const MAX_RPC_LINE_BYTES: usize = 4_000_000;
const RECENT_REQUEST_ID_LIMIT: usize = 1_024;
static PROTOCOL_OUTPUT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AiJobQuality {
    #[default]
    Fast,
    Best,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiRecapJobParams {
    recording_id: String,
    #[serde(default)]
    quality: AiJobQuality,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiAskJobParams {
    recording_id: String,
    question: String,
    #[serde(default)]
    quality: AiJobQuality,
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
    bundled_ai_assets: BundledAiAssets,
    capture_manager: CaptureManager,
    consent_store: ConsentStore,
    local_ai_service: LocalAiService,
    local_instruct_assets: LocalInstructAssetManager,
    local_instruct_model: LocalInstructModelService,
    job_manager: JobManager,
    model_manager: ModelManager,
    model_scheduler: LocalModelScheduler,
    recording_store: RecordingStore,
    recent_request_ids: RecentRequestIds,
    shutdown_requested: bool,
    startup_recovery: StartupRecoveryStatus,
    transcription_service: TranscriptionService,
    update_policy: UpdatePolicy,
    v2_importer: V2Importer,
    vault_store: VaultStore,
}

impl CoreState {
    fn new(started_at_ms: u128) -> Self {
        let recording_store = RecordingStore::from_env();
        let vault_store = VaultStore::from_env();
        let bundled_ai_assets = BundledAiAssets::from_env();
        let startup_recovery = startup_recovery_status(
            recording_store
                .recover()
                .map(|value| reconcile_recovered_deletions(value, &recording_store, &vault_store)),
        );
        let instruct_assets_root = recording_store.models_root_for_core().join("instruct");
        Self {
            started_at_ms,
            bundled_ai_assets: bundled_ai_assets.clone(),
            capture_manager: CaptureManager::default(),
            consent_store: ConsentStore::from_env(),
            local_ai_service: LocalAiService,
            local_instruct_assets: LocalInstructAssetManager::with_root(
                instruct_assets_root.clone(),
            ),
            local_instruct_model: LocalInstructModelService::with_sources(
                instruct_assets_root,
                bundled_ai_assets.clone(),
            ),
            job_manager: JobManager::new(PROTOCOL_VERSION),
            model_manager: ModelManager::with_bundled_assets(bundled_ai_assets),
            model_scheduler: LocalModelScheduler::default(),
            recording_store,
            recent_request_ids: RecentRequestIds::default(),
            shutdown_requested: false,
            startup_recovery,
            transcription_service: TranscriptionService,
            update_policy: UpdatePolicy,
            v2_importer: V2Importer,
            vault_store,
        }
    }

    #[cfg(test)]
    fn with_stores(
        started_at_ms: u128,
        recording_store: RecordingStore,
        vault_store: VaultStore,
    ) -> Self {
        let consent_root = recording_store
            .local_data_root_for_core()
            .join("consent-state");
        let startup_recovery = startup_recovery_status(
            recording_store
                .recover()
                .map(|value| reconcile_recovered_deletions(value, &recording_store, &vault_store)),
        );
        let instruct_assets_root = recording_store.models_root_for_core().join("instruct");
        let bundled_ai_assets = BundledAiAssets::disabled();
        Self {
            started_at_ms,
            bundled_ai_assets: bundled_ai_assets.clone(),
            capture_manager: CaptureManager::default(),
            consent_store: ConsentStore::with_root(consent_root),
            local_ai_service: LocalAiService,
            local_instruct_assets: LocalInstructAssetManager::with_root(
                instruct_assets_root.clone(),
            ),
            local_instruct_model: LocalInstructModelService::with_sources(
                instruct_assets_root,
                bundled_ai_assets.clone(),
            ),
            job_manager: JobManager::new(PROTOCOL_VERSION),
            model_manager: ModelManager::with_bundled_assets(bundled_ai_assets),
            model_scheduler: LocalModelScheduler::default(),
            recording_store,
            recent_request_ids: RecentRequestIds::default(),
            shutdown_requested: false,
            startup_recovery,
            transcription_service: TranscriptionService,
            update_policy: UpdatePolicy,
            v2_importer: V2Importer,
            vault_store,
        }
    }
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
    RpcResponse {
        id,
        request_id: None,
        protocol_version: PROTOCOL_VERSION,
        ok: false,
        result: None,
        error: Some(Box::new(RpcError {
            code,
            message: message.into(),
            retryable: false,
        })),
    }
}

fn make_recording_error(id: Value, error: RecordingStoreError) -> RpcResponse {
    make_error(id, error.code, error.message)
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

fn decode_params<T>(id: Value, params: Value) -> Result<T, RpcResponse>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value::<T>(params).map_err(|err| {
        make_error(
            id,
            "INVALID_PARAMS",
            format!("invalid request parameters: {err}"),
        )
    })
}

fn handle_request(req: RpcRequest, state: &mut CoreState) -> RpcResponse {
    let id = req.id.clone();
    let result = match req.method.as_str() {
        "core.ping" => json!({
            "pong": true,
            "echo": req.params,
        }),
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
                "consent.status",
                "consent.acknowledge",
                "capture.status",
                "capture.devices",
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
                "ai.recap.start",
                "transcription.status",
                "transcription.runLocal",
                "transcription.start",
                "transcription.proofSynthetic",
                "jobs.list",
                "jobs.get",
                "jobs.cancel",
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
                "recording.privacyReceipt",
                "recording.durable.readAudioChunk",
                "recording.durable.search",
                "recording.notes.read",
                "recording.notes.save",
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
        "capture.startMic" => {
            let params = match decode_params::<CaptureStartParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            if let Err(error) = state.consent_store.require_mic_recording() {
                return make_consent_error(id, error);
            }
            match state
                .capture_manager
                .start_mic(state.recording_store.clone(), params)
            {
                Ok(value) => value,
                Err(error) => return make_capture_error(id, error),
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
            match state
                .capture_manager
                .start_system(state.recording_store.clone(), params)
            {
                Ok(value) => value,
                Err(error) => return make_capture_error(id, error),
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
            match state
                .capture_manager
                .start_mic_and_system(state.recording_store.clone(), params)
            {
                Ok(value) => value,
                Err(error) => return make_capture_error(id, error),
            }
        }
        "capture.stop" => match state.capture_manager.stop(&state.recording_store) {
            Ok(value) => value,
            Err(error) => return make_capture_error(id, error),
        },
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
        "models.listLocal" => state.model_manager.list_local(&state.recording_store),
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
                    context.progress("verifying", 0, Some(1), Some("model"));
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
                    context.progress("verifying-and-installing", 0, Some(1), Some("model"));
                    model_manager
                        .import_finish(&store, params)
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
                    context.progress("verifying-and-importing", 0, Some(1), Some("asset"));
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
            let value = match state.local_instruct_model.recap(
                &state.recording_store,
                &mut state.model_scheduler,
                params,
            ) {
                Ok(value) => value,
                Err(error) => return make_local_instruct_error(id, error),
            };
            let status = state.local_instruct_model.status(&state.model_scheduler);
            if let Err(error) = state.recording_store.record_processing_fact(
                &recording_id,
                "local-ai-recap",
                "llama-cpp-local",
                Some("managed-local-instruct"),
                status.get("modelSha256").and_then(Value::as_str),
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
            let value = match state.local_instruct_model.ask(
                &state.recording_store,
                &mut state.model_scheduler,
                params,
            ) {
                Ok(value) => value,
                Err(error) => return make_local_instruct_error(id, error),
            };
            let status = state.local_instruct_model.status(&state.model_scheduler);
            if let Err(error) = state.recording_store.record_processing_fact(
                &recording_id,
                "local-ai-ask",
                "llama-cpp-local",
                Some("managed-local-instruct"),
                status.get("modelSha256").and_then(Value::as_str),
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
        "ai.recap.start" => {
            let params = match decode_params::<AiRecapJobParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let store = state.recording_store.clone();
            let asset_root = store.models_root_for_core().join("instruct");
            let bundled_ai_assets = state.bundled_ai_assets.clone();
            match state.job_manager.submit("recap", true, move |context| {
                context.progress("preparing", 0, Some(3), Some("stage"));
                let recording_id = params.recording_id;
                let mut result = None;
                if matches!(params.quality, AiJobQuality::Best) {
                    let service =
                        LocalInstructModelService::with_sources(asset_root, bundled_ai_assets);
                    let mut scheduler = LocalModelScheduler::default();
                    if service.status(&scheduler)["ready"] == true {
                        context.progress("generating", 1, Some(3), Some("stage"));
                        result = Some(
                            service
                                .recap(
                                    &store,
                                    &mut scheduler,
                                    LocalInstructRecapParams {
                                        recording_id: recording_id.clone(),
                                        max_tokens: None,
                                    },
                                )
                                .map_err(|error| {
                                    JobFailure::new(error.code, error.message, true)
                                })?,
                        );
                    }
                }
                if result.is_none() {
                    context.progress("summarizing", 1, Some(3), Some("stage"));
                    result = Some(
                        LocalAiService
                            .recap_heuristic(
                                &store,
                                LocalRecapParams {
                                    recording_id: recording_id.clone(),
                                },
                            )
                            .map_err(|error| JobFailure::new(error.code, error.message, true))?,
                    );
                }
                let result = result.expect("recap result is assigned");
                context.progress("saving-local-result", 2, Some(3), Some("stage"));
                store
                    .record_processing_fact(
                        &recording_id,
                        "local-ai-recap",
                        result["engine"].as_str().unwrap_or("local-ai"),
                        None,
                        None,
                    )
                    .map_err(|error| JobFailure::new(error.code, error.message, true))?;
                Ok(result)
            }) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "ai.ask.start" => {
            let params = match decode_params::<AiAskJobParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let store = state.recording_store.clone();
            let asset_root = store.models_root_for_core().join("instruct");
            let bundled_ai_assets = state.bundled_ai_assets.clone();
            match state.job_manager.submit("ask", true, move |context| {
                context.progress("preparing", 0, Some(3), Some("stage"));
                let recording_id = params.recording_id;
                let question = params.question;
                let mut result = None;
                if matches!(params.quality, AiJobQuality::Best) {
                    let service =
                        LocalInstructModelService::with_sources(asset_root, bundled_ai_assets);
                    let mut scheduler = LocalModelScheduler::default();
                    if service.status(&scheduler)["ready"] == true {
                        context.progress("answering", 1, Some(3), Some("stage"));
                        result = Some(
                            service
                                .ask(
                                    &store,
                                    &mut scheduler,
                                    LocalInstructAskParams {
                                        recording_id: recording_id.clone(),
                                        question: question.clone(),
                                        max_tokens: None,
                                    },
                                )
                                .map_err(|error| {
                                    JobFailure::new(error.code, error.message, true)
                                })?,
                        );
                    }
                }
                if result.is_none() {
                    context.progress("finding-evidence", 1, Some(3), Some("stage"));
                    result = Some(
                        LocalAiService
                            .ask_heuristic(
                                &store,
                                LocalAskParams {
                                    recording_id: recording_id.clone(),
                                    question,
                                },
                            )
                            .map_err(|error| JobFailure::new(error.code, error.message, true))?,
                    );
                }
                let result = result.expect("ask result is assigned");
                context.progress("saving-local-result", 2, Some(3), Some("stage"));
                store
                    .record_processing_fact(
                        &recording_id,
                        "local-ai-ask",
                        result["engine"].as_str().unwrap_or("local-ai"),
                        None,
                        None,
                    )
                    .map_err(|error| JobFailure::new(error.code, error.message, true))?;
                Ok(result)
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
            let value = match state.transcription_service.run_local(
                &state.recording_store,
                &mut state.model_scheduler,
                &state.model_manager,
                params,
            ) {
                Ok(value) => value,
                Err(error) => return make_transcription_error(id, error),
            };
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
            let store = state.recording_store.clone();
            let model_manager = state.model_manager.clone();
            match state
                .job_manager
                .submit("transcription", true, move |context| {
                    let recording_id = params.recording_id.clone();
                    context.progress("loading-audio", 0, Some(3), Some("stage"));
                    let mut scheduler = LocalModelScheduler::default();
                    let mut service = TranscriptionService;
                    context.progress("transcribing", 1, Some(3), Some("stage"));
                    let value = service
                        .run_local(&store, &mut scheduler, &model_manager, params)
                        .map_err(|error| JobFailure::new(error.code, error.message, true))?;
                    context.progress("saving-transcript", 2, Some(3), Some("stage"));
                    let model = value.get("model").and_then(Value::as_object);
                    store
                        .record_processing_fact(
                            &recording_id,
                            "transcription",
                            value["engine"].as_str().unwrap_or("whisper-rs"),
                            model
                                .and_then(|value| value.get("modelId"))
                                .and_then(Value::as_str),
                            model
                                .and_then(|value| value.get("sha256"))
                                .and_then(Value::as_str),
                        )
                        .map_err(|error| JobFailure::new(error.code, error.message, true))?;
                    Ok(value)
                }) {
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
            match state.recording_store.delete_finished(params) {
                Ok(value) => finalize_deletion_result(value, state),
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.recover" => match state.recording_store.recover() {
            Ok(value) => annotate_recovery_result(value, state),
            Err(error) => return make_recording_error(id, error),
        },
        "recording.durable.list" => match state.recording_store.list() {
            Ok(value) => value,
            Err(error) => return make_recording_error(id, error),
        },
        "recording.durable.listPage" => {
            let params = match decode_params::<RecordingPageParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.list_page(params) {
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
                Ok(value) => value,
                Err(error) => return make_recording_error(id, error),
            }
        }
        "recording.durable.transcriptPage" => {
            let params = match decode_params::<TranscriptPageParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.recording_store.transcript_page(params) {
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
            match state.recording_store.search(params) {
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
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "jobs.acknowledge" => {
            let params = match decode_params::<JobIdParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match state.job_manager.acknowledge(&params.job_id) {
                Ok(value) => value,
                Err(error) => return make_job_error(id, error),
            }
        }
        "export.start" => {
            let params = match decode_params::<ExportRecordingParams>(id.clone(), req.params) {
                Ok(params) => params,
                Err(response) => return response,
            };
            let store = state.recording_store.clone();
            match state.job_manager.submit("export", false, move |context| {
                context.progress("rendering", 0, Some(2), Some("stage"));
                let value = store
                    .export_create(params)
                    .map_err(|error| JobFailure::new(error.code, error.message, true))?;
                context.progress("finalizing", 1, Some(2), Some("stage"));
                Ok(value)
            }) {
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

fn finalize_deletion_result(mut value: Value, state: &CoreState) -> Value {
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

    let index_cleanup = match state.vault_store.delete_recording_index(&recording_id) {
        Ok(cleanup) => cleanup,
        Err(error) => json!({
            "cleanupComplete": false,
            "state": "pending",
            "errorCode": error.code,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }),
    };
    let cleanup_complete = index_cleanup
        .get("cleanupComplete")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if cleanup_complete {
        match state
            .recording_store
            .complete_deletion_metadata(RecordingIdParams {
                recording_id: recording_id.clone(),
            }) {
            Ok(mut completed) => {
                if let Some(object) = completed.as_object_mut() {
                    object.insert("vaultIndexCleanup".to_string(), index_cleanup);
                }
                return completed;
            }
            Err(error) => {
                if let Some(object) = value.as_object_mut() {
                    object.insert("state".to_string(), json!("metadataCleanupPending"));
                    object.insert("deleted".to_string(), json!(false));
                    object.insert("metadataCleanupComplete".to_string(), json!(false));
                    object.insert("retryRequired".to_string(), json!(true));
                    object.insert("metadataErrorCode".to_string(), json!(error.code));
                }
            }
        }
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("vaultIndexCleanup".to_string(), index_cleanup);
    }
    value
}

fn reconcile_recovered_deletions(
    mut value: Value,
    recording_store: &RecordingStore,
    vault_store: &VaultStore,
) -> Value {
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
        let cleanup_complete = vault_store
            .delete_recording_index(id)
            .ok()
            .map(|cleanup| {
                cleanup
                    .get("cleanupComplete")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if cleanup_complete
            && recording_store
                .complete_deletion_metadata(RecordingIdParams {
                    recording_id: id.to_string(),
                })
                .is_ok()
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
    value = reconcile_recovered_deletions(value, &state.recording_store, &state.vault_store);
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

        for entry in fs::read_dir(fixture_root.join("valid")).expect("valid fixture directory") {
            let path = entry.expect("valid fixture entry").path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let fixture: Value =
                serde_json::from_slice(&fs::read(&path).expect("valid fixture read"))
                    .expect("valid fixture JSON");
            let kind = fixture["kind"].as_str().expect("valid fixture kind");
            let (method, params, expected) = if kind == "handshake" {
                ("core.version", Value::Null, &fixture["value"])
            } else {
                (
                    fixture["method"].as_str().expect("valid fixture method"),
                    fixture["params"].clone(),
                    &fixture["result"],
                )
            };
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
            state.job_manager.acknowledge(&job_id).unwrap()["acknowledged"],
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

        let list = handle_request(request("recording.durable.list"), &mut state);
        assert!(list.ok);
        let list = list.result.expect("list");
        assert_eq!(list["recordings"][0]["recordingId"], recording_id);
        assert_eq!(list["recordings"][0]["state"], "needsRecovery");
        assert_eq!(list["recordings"][0]["rawPathExposed"], false);
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

        let search = handle_request(
            request_with(
                json!(5),
                "recording.durable.search",
                json!({ "query": "Reliability" }),
            ),
            &mut state,
        );
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

        let bundle_status = handle_request(request("ai.bundledAssetsStatus"), &mut state);
        assert!(bundle_status.ok);
        let status = bundle_status.result.expect("bundle status");
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
                json!({ "recordingId": recording_id }),
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
