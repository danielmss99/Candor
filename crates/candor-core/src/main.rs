mod capture_service;
mod consent_store;
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

use std::io::{self, BufRead, Write};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use capture_service::{
    CaptureError, CaptureManager, CaptureStartMicAndSystemParams, CaptureStartParams,
};
use consent_store::{ConsentAcknowledgeParams, ConsentError, ConsentStore};
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
const MAX_RPC_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcRequest {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcResponse {
    id: Value,
    protocol_version: &'static str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcError {
    code: &'static str,
    message: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
    raw_path_exposed: bool,
}

struct CoreState {
    started_at_ms: u128,
    capture_manager: CaptureManager,
    consent_store: ConsentStore,
    local_ai_service: LocalAiService,
    local_instruct_assets: LocalInstructAssetManager,
    local_instruct_model: LocalInstructModelService,
    model_manager: ModelManager,
    model_scheduler: LocalModelScheduler,
    recording_store: RecordingStore,
    startup_recovery: StartupRecoveryStatus,
    transcription_service: TranscriptionService,
    update_policy: UpdatePolicy,
    v2_importer: V2Importer,
    vault_store: VaultStore,
}

impl CoreState {
    fn new(started_at_ms: u128) -> Self {
        let recording_store = RecordingStore::from_env();
        let startup_recovery = startup_recovery_status(recording_store.recover());
        let instruct_assets_root = recording_store.models_root_for_core().join("instruct");
        Self {
            started_at_ms,
            capture_manager: CaptureManager::default(),
            consent_store: ConsentStore::from_env(),
            local_ai_service: LocalAiService,
            local_instruct_assets: LocalInstructAssetManager::with_root(
                instruct_assets_root.clone(),
            ),
            local_instruct_model: LocalInstructModelService::with_asset_root(instruct_assets_root),
            model_manager: ModelManager,
            model_scheduler: LocalModelScheduler::default(),
            recording_store,
            startup_recovery,
            transcription_service: TranscriptionService,
            update_policy: UpdatePolicy,
            v2_importer: V2Importer,
            vault_store: VaultStore::from_env(),
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
        let startup_recovery = startup_recovery_status(recording_store.recover());
        let instruct_assets_root = recording_store.models_root_for_core().join("instruct");
        Self {
            started_at_ms,
            capture_manager: CaptureManager::default(),
            consent_store: ConsentStore::with_root(consent_root),
            local_ai_service: LocalAiService,
            local_instruct_assets: LocalInstructAssetManager::with_root(
                instruct_assets_root.clone(),
            ),
            local_instruct_model: LocalInstructModelService::with_asset_root(instruct_assets_root),
            model_manager: ModelManager,
            model_scheduler: LocalModelScheduler::default(),
            recording_store,
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
            error_code: None,
            raw_path_exposed: false,
        },
        Err(error) => StartupRecoveryStatus {
            attempted: true,
            ok: false,
            recovered_count: 0,
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
        protocol_version: PROTOCOL_VERSION,
        ok: false,
        result: None,
        error: Some(RpcError {
            code,
            message: message.into(),
        }),
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
                "models.importStart",
                "models.importChunk",
                "models.importFinish",
                "models.importAbort",
                "models.proofSynthetic",
                "ai.status",
                "ai.askHeuristic",
                "ai.recapHeuristic",
                "ai.instructStatus",
                "ai.instructAssetsStatus",
                "ai.instructAssetsImportFromPath",
                "ai.proofInstructPreflight",
                "ai.recapInstruct",
                "ai.askInstruct",
                "ai.schedulerStatus",
                "ai.proofHeuristicAsk",
                "ai.proofHeuristicRecap",
                "ai.proofSchedulerBusy",
                "transcription.status",
                "transcription.runLocal",
                "transcription.proofSynthetic",
                "recording.durable.status",
                "recording.durable.start",
                "recording.durable.writeTextChunk",
                "recording.durable.writeTranscriptSegment",
                "recording.durable.writeAudioChunk",
                "recording.durable.finish",
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
                "export.create"
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
        "transcription.status" => state
            .transcription_service
            .status(&state.recording_store, &state.model_scheduler),
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
            let response = RpcResponse {
                id,
                protocol_version: PROTOCOL_VERSION,
                ok: true,
                result: Some(json!({ "shutdown": true })),
                error: None,
            };
            write_response(&response);
            process::exit(0);
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
        protocol_version: PROTOCOL_VERSION,
        ok: true,
        result: Some(result),
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

fn annotate_recovery_result(mut value: Value, state: &mut CoreState) -> Value {
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
        Ok(req) => handle_request(req, state),
        Err(err) => make_error(Value::Null, "MALFORMED_JSON_RPC", err.to_string()),
    })
}

fn write_response(response: &RpcResponse) {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    if serde_json::to_writer(&mut lock, response).is_ok() {
        let _ = lock.write_all(b"\n");
        let _ = lock.flush();
    }
}

fn main() {
    let started_at_ms = now_ms();
    let mut state = CoreState::new(started_at_ms);
    let stdin = io::stdin();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                write_response(&make_error(
                    Value::Null,
                    "STDIN_READ_ERROR",
                    err.to_string(),
                ));
                continue;
            }
        };

        if let Some(response) = handle_line(&line, &mut state) {
            write_response(&response);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

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
        RpcRequest {
            id: json!(1),
            method: method.to_string(),
            params: Value::Null,
        }
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
            RpcRequest {
                id: json!(1),
                method: "capture.startMic".to_string(),
                params: json!({
                    "label": "must fail before consent"
                }),
            },
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
    fn empty_rpc_frames_are_ignored() {
        let mut state = core_state();
        assert!(handle_line("   ", &mut state).is_none());
    }

    #[test]
    fn durable_recording_rpc_round_trip_uses_local_store_without_paths() {
        let mut state = core_state();
        let start = handle_request(
            RpcRequest {
                id: json!(1),
                method: "recording.durable.start".to_string(),
                params: json!({ "label": "unit" }),
            },
            &mut state,
        );
        assert!(start.ok);
        let recording_id = start.result.as_ref().unwrap()["recordingId"]
            .as_str()
            .unwrap()
            .to_string();

        let write = handle_request(
            RpcRequest {
                id: json!(2),
                method: "recording.durable.writeTextChunk".to_string(),
                params: json!({
                    "recordingId": recording_id.clone(),
                    "channel": "mic",
                    "dataUtf8": "audio bytes"
                }),
            },
            &mut state,
        );
        assert!(write.ok);
        let result = write.result.expect("write result");
        assert_eq!(result["chunkCount"], 1);
        assert_eq!(result["rawPathExposed"], false);

        let audio_bytes = vec![0_u8; 160];
        let write_audio = handle_request(
            RpcRequest {
                id: json!(7),
                method: "recording.durable.writeAudioChunk".to_string(),
                params: json!({
                    "recordingId": recording_id.clone(),
                    "channel": "system",
                    "sampleRateHz": 8000,
                    "channelCount": 1,
                    "bitsPerSample": 16,
                    "dataBase64": BASE64_STANDARD.encode(&audio_bytes)
                }),
            },
            &mut state,
        );
        assert!(write_audio.ok);

        let write_segment = handle_request(
            RpcRequest {
                id: json!(10),
                method: "recording.durable.writeTranscriptSegment".to_string(),
                params: json!({
                    "recordingId": recording_id.clone(),
                    "channel": "mic",
                    "speaker": "Alex",
                    "text": "Reliability is our moat.",
                    "startMs": 0,
                    "durationMs": 900,
                    "confidence": 0.91
                }),
            },
            &mut state,
        );
        assert!(write_segment.ok);

        let finish = handle_request(
            RpcRequest {
                id: json!(3),
                method: "recording.durable.finish".to_string(),
                params: json!({ "recordingId": recording_id.clone() }),
            },
            &mut state,
        );
        assert!(finish.ok);

        let list = handle_request(request("recording.durable.list"), &mut state);
        assert!(list.ok);
        let list_result = list.result.expect("list result");
        assert_eq!(list_result["rawPathExposed"], false);
        assert_eq!(list_result["recordingCount"], 1);

        let read = handle_request(
            RpcRequest {
                id: json!(4),
                method: "recording.durable.read".to_string(),
                params: json!({ "recordingId": recording_id.clone() }),
            },
            &mut state,
        );
        assert!(read.ok);
        let read_result = read.result.expect("read result");
        assert_eq!(read_result["rawPathExposed"], false);
        assert_eq!(read_result["chunks"][0]["textUtf8"], "audio bytes");
        assert_eq!(read_result["chunks"][1]["kind"], "audioPcm16le");
        assert_eq!(read_result["chunks"][2]["kind"], "transcriptSegment");

        let transcript = handle_request(
            RpcRequest {
                id: json!(11),
                method: "recording.durable.transcript".to_string(),
                params: json!({ "recordingId": recording_id.clone() }),
            },
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
            RpcRequest {
                id: json!(8),
                method: "recording.durable.replayManifest".to_string(),
                params: json!({ "recordingId": recording_id.clone() }),
            },
            &mut state,
        );
        assert!(replay.ok);
        let replay_result = replay.result.expect("replay result");
        assert_eq!(replay_result["rawPathExposed"], false);
        assert_eq!(replay_result["audioChunkCount"], 1);
        assert_eq!(replay_result["audioChunks"][0]["durationMs"], 10);

        let audio = handle_request(
            RpcRequest {
                id: json!(9),
                method: "recording.durable.readAudioChunk".to_string(),
                params: json!({ "recordingId": recording_id.clone(), "index": 1 }),
            },
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
            RpcRequest {
                id: json!(5),
                method: "recording.durable.search".to_string(),
                params: json!({ "query": "Reliability" }),
            },
            &mut state,
        );
        assert!(search.ok);
        let search_result = search.result.expect("search result");
        assert_eq!(search_result["rawPathExposed"], false);
        assert_eq!(search_result["matchCount"], 1);

        let export = handle_request(
            RpcRequest {
                id: json!(6),
                method: "export.create".to_string(),
                params: json!({ "recordingId": recording_id, "format": "markdown" }),
            },
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
            RpcRequest {
                id: json!(1),
                method: "vault.proofWrongKeyFails".to_string(),
                params: json!({
                    "correctPassphrase": "correct horse battery staple",
                    "wrongPassphrase": "wrong horse battery staple"
                }),
            },
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
