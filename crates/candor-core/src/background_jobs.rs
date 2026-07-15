use std::fs;
use std::sync::Arc;

use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::bundled_ai_assets::BundledAiAssets;
use crate::dictionary_package::{verify_candordict_bytes_with_trust, DictionaryTrustAnchor};
use crate::dictionary_staging::{DictionaryStaging, StagedDictionary};
use crate::job_manager::{
    AiExecutionMode, AiFallbackPolicy, JobContext, JobDescriptor, JobExecutor, JobFailure,
};
use crate::local_ai_service::{LocalAiService, LocalAskParams, LocalRecapParams};
use crate::local_instruct_model::{
    LocalInstructAskParams, LocalInstructModelService, LocalInstructRecapParams,
};
use crate::local_model_scheduler::LocalModelScheduler;
use crate::model_manager::ModelManager;
use crate::recording_store::{ExportRecordingParams, RecordingStore};
use crate::terminology_dictionary::{TerminologyService, TerminologyStatusParams};
use crate::transcription_service::{TranscriptionRunLocalParams, TranscriptionService};

#[derive(Clone)]
pub struct BackgroundJobServices {
    bundled_ai_assets: BundledAiAssets,
    model_manager: ModelManager,
    recording_store: RecordingStore,
    dictionary_staging: DictionaryStaging,
    terminology_service: TerminologyService,
    transcription_service: TranscriptionService,
}

impl BackgroundJobServices {
    pub fn new(
        bundled_ai_assets: BundledAiAssets,
        model_manager: ModelManager,
        recording_store: RecordingStore,
        dictionary_staging: DictionaryStaging,
        terminology_service: TerminologyService,
        transcription_service: TranscriptionService,
    ) -> Self {
        Self {
            bundled_ai_assets,
            model_manager,
            recording_store,
            dictionary_staging,
            terminology_service,
            transcription_service,
        }
    }

    pub fn executor(&self) -> JobExecutor {
        let services = self.clone();
        Arc::new(move |descriptor, context| services.execute(descriptor, context))
    }

    pub fn ensure_bundled_general_dictionary(&self) -> Result<(), JobFailure> {
        let Some(asset) = self
            .bundled_ai_assets
            .general_dictionary()
            .map_err(|error| JobFailure::new(error.code, error.message, false))?
        else {
            return Ok(());
        };
        let trust_anchor = self.dictionary_trust_anchor()?.ok_or_else(|| {
            JobFailure::new(
                "BUNDLED_DICTIONARY_TRUST_ANCHOR_MISSING",
                "the packaged dictionary publisher key is missing",
                false,
            )
        })?;
        let bytes = fs::read(asset.path).map_err(|_| {
            JobFailure::new(
                "BUNDLED_DICTIONARY_READ_FAILED",
                "the packaged general dictionary could not be read",
                false,
            )
        })?;
        let package = verify_candordict_bytes_with_trust(&bytes, Some(&trust_anchor))
            .map_err(|error| JobFailure::new(error.code, error.message, false))?;
        self.terminology_service
            .import_bundled_general_package(package)
            .map_err(|error| JobFailure::new(error.code, error.message, false))?;
        Ok(())
    }

    fn dictionary_trust_anchor(&self) -> Result<Option<DictionaryTrustAnchor>, JobFailure> {
        let Some(key_asset) = self
            .bundled_ai_assets
            .dictionary_publisher_key()
            .map_err(|error| JobFailure::new(error.code, error.message, false))?
        else {
            return Ok(None);
        };
        let key_bytes = fs::read(key_asset.path).map_err(|_| {
            JobFailure::new(
                "BUNDLED_DICTIONARY_TRUST_ANCHOR_READ_FAILED",
                "the packaged dictionary publisher key could not be read",
                false,
            )
        })?;
        DictionaryTrustAnchor::from_json_bytes(&key_bytes)
            .map(Some)
            .map_err(|error| JobFailure::new(error.code, error.message, false))
    }

    fn execute(&self, descriptor: JobDescriptor, context: JobContext) -> Result<Value, JobFailure> {
        match descriptor {
            JobDescriptor::Transcription {
                recording_id,
                channel,
                model_id,
                ..
            } => self.transcribe(recording_id, channel, model_id, context),
            JobDescriptor::Recap {
                recording_id,
                mode,
                fallback_policy,
                ..
            } => self.recap(recording_id, mode, fallback_policy, context),
            JobDescriptor::Ask {
                recording_id,
                question,
                mode,
                fallback_policy,
                ..
            } => self.ask(recording_id, question, mode, fallback_policy, context),
            JobDescriptor::Export { params } => self.export(params, context),
            JobDescriptor::DictionaryImport {
                staging_token,
                expected_sha256,
                original_display_name,
                bytes,
                ..
            } => self.import_dictionary(
                staging_token,
                expected_sha256,
                original_display_name,
                bytes,
                context,
            ),
            JobDescriptor::DictionaryIndex { dictionary_id } => {
                context.progress("preparing-terminology", 0, Some(1), Some("stage"));
                let mut value = self
                    .terminology_service
                    .status(TerminologyStatusParams { recording_id: None });
                if let Some(root) = value.as_object_mut() {
                    root.insert(
                        "indexedDictionaryId".to_string(),
                        Value::String(dictionary_id),
                    );
                }
                Ok(value)
            }
        }
    }

    fn transcribe(
        &self,
        recording_id: String,
        channel: Option<String>,
        model_id: Option<String>,
        context: JobContext,
    ) -> Result<Value, JobFailure> {
        context.progress("loading-audio", 0, Some(3), Some("stage"));
        let mut scheduler = LocalModelScheduler::default();
        context.progress("transcribing", 1, Some(3), Some("stage"));
        let mut service = self.transcription_service.clone();
        let value = service
            .run_local_cancellable(
                &self.recording_store,
                &mut scheduler,
                &self.model_manager,
                TranscriptionRunLocalParams {
                    recording_id: recording_id.clone(),
                    channel,
                    model_id,
                },
                context.cancellation_flag(),
            )
            .map_err(|error| JobFailure::new(error.code, error.message, true))?;
        context.progress("saving-transcript", 2, Some(3), Some("stage"));
        let model = value.get("model").and_then(Value::as_object);
        self.recording_store
            .record_processing_fact(
                &recording_id,
                "transcription",
                value["engine"].as_str().unwrap_or("whisper-rs"),
                model
                    .and_then(|item| item.get("modelId"))
                    .and_then(Value::as_str),
                model
                    .and_then(|item| item.get("sha256"))
                    .and_then(Value::as_str),
            )
            .map_err(|error| JobFailure::new(error.code, error.message, true))?;
        Ok(transcription_completion_summary(recording_id, &value))
    }

    fn recap(
        &self,
        recording_id: String,
        mode: AiExecutionMode,
        fallback_policy: AiFallbackPolicy,
        context: JobContext,
    ) -> Result<Value, JobFailure> {
        context.progress("preparing", 0, Some(3), Some("stage"));
        let result = match mode {
            AiExecutionMode::HeuristicFallback => {
                context.progress("summarizing", 1, Some(3), Some("stage"));
                with_ai_provenance(
                    self.heuristic_recap(&recording_id)?,
                    "heuristic",
                    None,
                    true,
                    Some("user-requested"),
                    "candor-heuristic-v1",
                )?
            }
            AiExecutionMode::LocalLlm => {
                let service = self.local_instruct_service();
                let mut scheduler = LocalModelScheduler::default();
                let status = service.status(&scheduler);
                if status["ready"] != true {
                    let code = stable_local_ai_code(
                        status["failureCode"]
                            .as_str()
                            .unwrap_or("LOCAL_LLM_UNAVAILABLE"),
                    );
                    self.recap_fallback_or_fail(
                        &recording_id,
                        fallback_policy,
                        code,
                        "the packaged local language model is not ready",
                        &context,
                    )?
                } else {
                    context.progress("generating", 1, Some(3), Some("stage"));
                    match service.recap_cancellable(
                        &self.recording_store,
                        &mut scheduler,
                        LocalInstructRecapParams {
                            recording_id: recording_id.clone(),
                            max_tokens: None,
                        },
                        context.cancellation_flag(),
                    ) {
                        Ok(value) => with_ai_provenance(
                            value,
                            "local-llm",
                            Some(self.local_llm_model_id()),
                            false,
                            None,
                            "candor-grounded-v1",
                        )?,
                        Err(error) if context.cancelled() || is_non_fallback_error(error.code) => {
                            return Err(JobFailure::new(error.code, error.message, true));
                        }
                        Err(error) => self.recap_fallback_or_fail(
                            &recording_id,
                            fallback_policy,
                            error.code,
                            &error.message,
                            &context,
                        )?,
                    }
                }
            }
        };
        if context.cancelled() {
            return Err(JobFailure::new(
                "JOB_CANCELLED",
                "the recap was cancelled before its result was saved",
                false,
            ));
        }
        context.progress("saving-local-result", 2, Some(3), Some("stage"));
        self.recording_store
            .record_ai_processing_fact(
                &recording_id,
                "local-ai-recap",
                result.get("provenance").unwrap_or(&Value::Null),
            )
            .map_err(|error| JobFailure::new(error.code, error.message, true))?;
        Ok(result)
    }

    fn ask(
        &self,
        recording_id: String,
        question: String,
        mode: AiExecutionMode,
        fallback_policy: AiFallbackPolicy,
        context: JobContext,
    ) -> Result<Value, JobFailure> {
        context.progress("preparing", 0, Some(3), Some("stage"));
        let result = match mode {
            AiExecutionMode::HeuristicFallback => {
                context.progress("answering", 1, Some(3), Some("stage"));
                with_ai_provenance(
                    self.heuristic_ask(&recording_id, &question)?,
                    "heuristic",
                    None,
                    true,
                    Some("user-requested"),
                    "candor-heuristic-v1",
                )?
            }
            AiExecutionMode::LocalLlm => {
                let service = self.local_instruct_service();
                let mut scheduler = LocalModelScheduler::default();
                let status = service.status(&scheduler);
                if status["ready"] != true {
                    let code = stable_local_ai_code(
                        status["failureCode"]
                            .as_str()
                            .unwrap_or("LOCAL_LLM_UNAVAILABLE"),
                    );
                    self.ask_fallback_or_fail(
                        &recording_id,
                        &question,
                        fallback_policy,
                        code,
                        "the packaged local language model is not ready",
                        &context,
                    )?
                } else {
                    context.progress("generating", 1, Some(3), Some("stage"));
                    match service.ask_cancellable(
                        &self.recording_store,
                        &mut scheduler,
                        LocalInstructAskParams {
                            recording_id: recording_id.clone(),
                            question: question.clone(),
                            max_tokens: None,
                        },
                        context.cancellation_flag(),
                    ) {
                        Ok(value) => with_ai_provenance(
                            value,
                            "local-llm",
                            Some(self.local_llm_model_id()),
                            false,
                            None,
                            "candor-grounded-v1",
                        )?,
                        Err(error) if context.cancelled() || is_non_fallback_error(error.code) => {
                            return Err(JobFailure::new(error.code, error.message, true));
                        }
                        Err(error) => self.ask_fallback_or_fail(
                            &recording_id,
                            &question,
                            fallback_policy,
                            error.code,
                            &error.message,
                            &context,
                        )?,
                    }
                }
            }
        };
        if context.cancelled() {
            return Err(JobFailure::new(
                "JOB_CANCELLED",
                "the answer was cancelled before its result was saved",
                false,
            ));
        }
        context.progress("saving-local-result", 2, Some(3), Some("stage"));
        self.recording_store
            .record_ai_processing_fact(
                &recording_id,
                "local-ai-ask",
                result.get("provenance").unwrap_or(&Value::Null),
            )
            .map_err(|error| JobFailure::new(error.code, error.message, true))?;
        Ok(result)
    }

    fn local_instruct_service(&self) -> LocalInstructModelService {
        LocalInstructModelService::with_sources_and_terminology(
            self.recording_store.models_root_for_core().join("instruct"),
            self.bundled_ai_assets.clone(),
            self.terminology_service.clone(),
        )
    }

    fn local_llm_model_id(&self) -> String {
        self.bundled_ai_assets
            .language_config()
            .ok()
            .flatten()
            .and_then(|config| config.model.model_id)
            .unwrap_or_else(|| "managed-local-model".to_string())
    }

    fn heuristic_recap(&self, recording_id: &str) -> Result<Value, JobFailure> {
        LocalAiService
            .recap_heuristic(
                &self.recording_store,
                LocalRecapParams {
                    recording_id: recording_id.to_string(),
                },
            )
            .map_err(|error| JobFailure::new(error.code, error.message, true))
    }

    fn heuristic_ask(&self, recording_id: &str, question: &str) -> Result<Value, JobFailure> {
        LocalAiService
            .ask_heuristic(
                &self.recording_store,
                LocalAskParams {
                    recording_id: recording_id.to_string(),
                    question: question.to_string(),
                },
            )
            .map_err(|error| JobFailure::new(error.code, error.message, true))
    }

    fn recap_fallback_or_fail(
        &self,
        recording_id: &str,
        policy: AiFallbackPolicy,
        code: &'static str,
        message: &str,
        context: &JobContext,
    ) -> Result<Value, JobFailure> {
        let Some(reason) = disclosed_fallback_reason(policy, code, context.cancelled()) else {
            return Err(JobFailure::new(code, message, true));
        };
        context.progress("using-disclosed-fallback", 1, Some(3), Some("stage"));
        with_ai_provenance(
            self.heuristic_recap(recording_id)?,
            "heuristic",
            None,
            true,
            Some(reason),
            "candor-heuristic-v1",
        )
    }

    fn ask_fallback_or_fail(
        &self,
        recording_id: &str,
        question: &str,
        policy: AiFallbackPolicy,
        code: &'static str,
        message: &str,
        context: &JobContext,
    ) -> Result<Value, JobFailure> {
        let Some(reason) = disclosed_fallback_reason(policy, code, context.cancelled()) else {
            return Err(JobFailure::new(code, message, true));
        };
        context.progress("using-disclosed-fallback", 1, Some(3), Some("stage"));
        with_ai_provenance(
            self.heuristic_ask(recording_id, question)?,
            "heuristic",
            None,
            true,
            Some(reason),
            "candor-heuristic-v1",
        )
    }

    fn export(&self, params: Value, context: JobContext) -> Result<Value, JobFailure> {
        let params = serde_json::from_value::<ExportRecordingParams>(params).map_err(|_| {
            JobFailure::new(
                "EXPORT_JOB_DESCRIPTOR_INVALID",
                "the saved export request is invalid",
                false,
            )
        })?;
        context.progress("rendering", 0, Some(2), Some("stage"));
        let value = self
            .recording_store
            .export_create(params)
            .map_err(|error| JobFailure::new(error.code, error.message, true))?;
        context.progress("finalizing", 1, Some(2), Some("stage"));
        Ok(value)
    }

    fn import_dictionary(
        &self,
        staging_token: String,
        expected_sha256: String,
        source_file_name: String,
        bytes: u64,
        context: JobContext,
    ) -> Result<Value, JobFailure> {
        if context.cancelled() {
            self.remove_dictionary_staging(&staging_token)?;
            return Err(JobFailure::new(
                "JOB_CANCELLED",
                "the dictionary import was cancelled",
                false,
            ));
        }
        context.progress("verifying-signature", 0, Some(3), Some("stage"));
        let archive = match self.dictionary_staging.read_verified(
            &staging_token,
            &expected_sha256,
            bytes,
            &source_file_name,
        ) {
            Ok(value) => value,
            Err(error) => {
                if !error.retryable {
                    self.remove_dictionary_staging(&staging_token)?;
                }
                return Err(JobFailure::new(error.code, error.message, error.retryable));
            }
        };
        if context.cancelled() {
            self.remove_dictionary_staging(&staging_token)?;
            return Err(JobFailure::new(
                "JOB_CANCELLED",
                "the dictionary import was cancelled",
                false,
            ));
        }
        let trust_anchor = match self.dictionary_trust_anchor() {
            Ok(value) => value,
            Err(error) => {
                if !error.retryable {
                    self.remove_dictionary_staging(&staging_token)?;
                }
                return Err(error);
            }
        };
        let package = match verify_candordict_bytes_with_trust(&archive, trust_anchor.as_ref()) {
            Ok(value) => value,
            Err(error) => {
                self.remove_dictionary_staging(&staging_token)?;
                return Err(JobFailure::new(error.code, error.message, false));
            }
        };
        if context.cancelled() {
            self.remove_dictionary_staging(&staging_token)?;
            return Err(JobFailure::new(
                "JOB_CANCELLED",
                "the dictionary import was cancelled",
                false,
            ));
        }
        context.progress("validating-terms", 1, Some(3), Some("stage"));
        let mut value = match self.terminology_service.import_verified_package(package) {
            Ok(value) => value,
            Err(error) => {
                self.remove_dictionary_staging(&staging_token)?;
                return Err(JobFailure::new(error.code, error.message, false));
            }
        };
        context.progress("saving-locally", 2, Some(3), Some("stage"));
        self.remove_dictionary_staging(&staging_token)?;
        if let Some(root) = value.as_object_mut() {
            root.insert("localOnly".to_string(), Value::Bool(true));
        }
        Ok(value)
    }

    fn remove_dictionary_staging(&self, staging_token: &str) -> Result<(), JobFailure> {
        self.dictionary_staging
            .delete(staging_token)
            .map_err(|error| JobFailure::new(error.code, error.message, error.retryable))
    }
}

pub fn descriptor_for_transcription(
    recording_id: String,
    channel: Option<String>,
    model_id: Option<String>,
    auto_recap: bool,
) -> JobDescriptor {
    let follow_up = auto_recap.then(|| {
        Box::new(JobDescriptor::Recap {
            recording_id: recording_id.clone(),
            mode: AiExecutionMode::LocalLlm,
            fallback_policy: AiFallbackPolicy::AllowDisclosed,
            legacy_quality: None,
        })
    });
    JobDescriptor::Transcription {
        recording_id,
        channel,
        model_id,
        follow_up,
    }
}

pub fn descriptor_for_recap(
    recording_id: String,
    mode: AiExecutionMode,
    fallback_policy: AiFallbackPolicy,
) -> JobDescriptor {
    JobDescriptor::Recap {
        recording_id,
        mode,
        fallback_policy,
        legacy_quality: None,
    }
}

pub fn descriptor_for_ask(
    recording_id: String,
    question: String,
    mode: AiExecutionMode,
    fallback_policy: AiFallbackPolicy,
) -> JobDescriptor {
    JobDescriptor::Ask {
        recording_id,
        question,
        mode,
        fallback_policy,
        legacy_quality: None,
    }
}

pub fn descriptor_for_export(params: Value) -> JobDescriptor {
    JobDescriptor::Export { params }
}

pub fn descriptor_for_dictionary_import(staged: StagedDictionary) -> JobDescriptor {
    JobDescriptor::DictionaryImport {
        staging_token: staged.staging_token,
        expected_sha256: staged.expected_sha256,
        original_display_name: staged.original_display_name,
        bytes: staged.bytes,
        legacy_source_file_name: None,
        legacy_archive_base64: None,
    }
}

fn with_ai_provenance(
    mut result: Value,
    engine: &'static str,
    model_id: Option<String>,
    fallback_used: bool,
    fallback_reason: Option<&'static str>,
    prompt_version: &'static str,
) -> Result<Value, JobFailure> {
    let root = result.as_object_mut().ok_or_else(|| {
        JobFailure::new(
            "LOCAL_AI_RESULT_INVALID",
            "local AI returned an invalid result",
            false,
        )
    })?;
    root.insert(
        "provenance".to_string(),
        json!({
            "engine": engine,
            "modelId": model_id,
            "fallbackUsed": fallback_used,
            "fallbackReason": fallback_reason,
            "promptVersion": prompt_version,
            "generatedAt": OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_else(|_| "unknown".to_string())
        }),
    );
    Ok(result)
}

fn transcription_completion_summary(recording_id: String, result: &Value) -> Value {
    json!({
        "recordingId": recording_id,
        "engine": result["engine"].as_str().unwrap_or("whisper-rs"),
        "segmentCount": result["writtenSegmentCount"].as_u64().unwrap_or(0),
        "rawPathExposed": false
    })
}

fn is_non_fallback_error(code: &str) -> bool {
    matches!(
        code,
        "LOCAL_LLM_COMMAND_CANCELLED"
            | "JOB_CANCELLED"
            | "APP_SHUTTING_DOWN"
            | "RECORDING_PRIORITY"
            | "LOCAL_MODEL_JOB_ACTIVE"
    )
}

fn disclosed_fallback_reason(
    policy: AiFallbackPolicy,
    code: &str,
    cancelled: bool,
) -> Option<&'static str> {
    if cancelled || policy == AiFallbackPolicy::RequireLocalLlm || is_non_fallback_error(code) {
        return None;
    }
    allowed_fallback_reason(code)
}

fn allowed_fallback_reason(code: &str) -> Option<&'static str> {
    match code {
        "LOCAL_LLM_BINARY_HASH_INVALID"
        | "LOCAL_LLM_BINARY_HASH_MISMATCH"
        | "LOCAL_LLM_BINARY_HASH_UNREADABLE"
        | "LOCAL_LLM_MODEL_HASH_INVALID"
        | "LOCAL_LLM_MODEL_HASH_MISMATCH"
        | "LOCAL_LLM_MODEL_HASH_UNREADABLE"
        | "LOCAL_LLM_MODEL_CORRUPT"
        | "BUNDLED_AI_ASSET_HASH_MISMATCH"
        | "BUNDLED_AI_ASSET_SIZE_MISMATCH" => Some("model-corrupt"),
        "LOCAL_LLM_RESOURCE_POLICY" | "INSTRUCT_ASSET_DISK_BUDGET_EXCEEDED" => {
            Some("resource-policy")
        }
        "LOCAL_LLM_UNAVAILABLE"
        | "LOCAL_LLM_BINARY_HASH_NOT_CONFIGURED"
        | "LOCAL_LLM_BINARY_NOT_CONFIGURED"
        | "LOCAL_LLM_BINARY_NOT_FOUND"
        | "LOCAL_LLM_MODEL_HASH_NOT_CONFIGURED"
        | "LOCAL_LLM_MODEL_NOT_CONFIGURED"
        | "LOCAL_LLM_MODEL_NOT_FOUND"
        | "LOCAL_LLM_NOT_READY"
        | "BUNDLED_AI_ASSET_MISSING"
        | "BUNDLED_AI_ASSET_UNAVAILABLE"
        | "BUNDLED_AI_ASSET_UNREADABLE"
        | "BUNDLED_AI_ASSETS_MISSING"
        | "BUNDLED_AI_LANGUAGE_INCOMPLETE"
        | "BUNDLED_AI_MANIFEST_MISSING"
        | "BUNDLED_AI_MANIFEST_UNREADABLE"
        | "BUNDLED_AI_NO_DEFAULT_SELECTED"
        | "BUNDLED_AI_NOTICE_MISSING"
        | "BUNDLED_AI_PLATFORM_UNSUPPORTED"
        | "BUNDLED_AI_ROOT_DISABLED"
        | "BUNDLED_AI_ROOT_INVALID"
        | "BUNDLED_AI_ROOT_MISSING"
        | "BUNDLED_AI_RUNTIME_NOT_EXECUTABLE" => Some("llm-unavailable"),
        "LOCAL_LLM_RUNTIME_FAILED"
        | "LOCAL_LLM_COMMAND_FAILED"
        | "LOCAL_LLM_COMMAND_SPAWN_FAILED"
        | "LOCAL_LLM_COMMAND_TIMEOUT"
        | "LOCAL_LLM_COMMAND_WAIT_FAILED"
        | "LOCAL_LLM_OUTPUT_EMPTY"
        | "LOCAL_LLM_OUTPUT_ENCODING_INVALID"
        | "LOCAL_LLM_OUTPUT_READ_FAILED"
        | "LOCAL_LLM_OUTPUT_READER_FAILED"
        | "LOCAL_LLM_OUTPUT_TOO_LARGE"
        | "LOCAL_LLM_STDERR_TOO_LARGE" => Some("runtime-failed"),
        _ => None,
    }
}

fn stable_local_ai_code(code: &str) -> &'static str {
    match allowed_fallback_reason(code) {
        Some("model-corrupt") => "LOCAL_LLM_MODEL_CORRUPT",
        Some("resource-policy") => "LOCAL_LLM_RESOURCE_POLICY",
        Some("llm-unavailable") => "LOCAL_LLM_UNAVAILABLE",
        Some("runtime-failed") => "LOCAL_LLM_RUNTIME_FAILED",
        _ => "LOCAL_LLM_STATUS_UNKNOWN",
    }
}

pub fn processing_queue_failure(error: &crate::job_manager::JobManagerError) -> Value {
    json!({
        "code": error.code,
        "message": "Recording saved, but automatic background processing could not be queued.",
        "retryable": true,
        "rawPathExposed": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_policy_is_explicit_and_never_masks_preemption_or_cancellation() {
        assert_eq!(
            disclosed_fallback_reason(
                AiFallbackPolicy::AllowDisclosed,
                "LOCAL_LLM_MODEL_NOT_FOUND",
                false,
            ),
            Some("llm-unavailable")
        );
        assert_eq!(
            disclosed_fallback_reason(
                AiFallbackPolicy::RequireLocalLlm,
                "LOCAL_LLM_MODEL_NOT_FOUND",
                false,
            ),
            None
        );
        assert_eq!(
            disclosed_fallback_reason(
                AiFallbackPolicy::AllowDisclosed,
                "UNRELATED_INPUT_MISSING",
                false,
            ),
            None
        );
        assert_eq!(
            stable_local_ai_code("UNRECOGNIZED_CORE_STATE"),
            "LOCAL_LLM_STATUS_UNKNOWN"
        );
        assert_eq!(
            disclosed_fallback_reason(
                AiFallbackPolicy::AllowDisclosed,
                stable_local_ai_code("UNRECOGNIZED_CORE_STATE"),
                false,
            ),
            None
        );
        assert_eq!(
            disclosed_fallback_reason(
                AiFallbackPolicy::AllowDisclosed,
                "RECORDING_PRIORITY",
                false,
            ),
            None
        );
        assert_eq!(
            disclosed_fallback_reason(
                AiFallbackPolicy::AllowDisclosed,
                "LOCAL_LLM_COMMAND_FAILED",
                true,
            ),
            None
        );
        assert_eq!(
            disclosed_fallback_reason(
                AiFallbackPolicy::AllowDisclosed,
                "LOCAL_LLM_OUTPUT_PATH_EXPOSURE",
                false,
            ),
            None
        );
    }

    #[test]
    fn provenance_is_typed_and_contains_no_source_content() {
        let value = with_ai_provenance(
            json!({ "summary": "fixture" }),
            "local-llm",
            Some("qwen3-4b-official-q4_k_m".to_string()),
            false,
            None,
            "candor-grounded-v1",
        )
        .expect("object result accepts provenance");
        let provenance = &value["provenance"];
        assert_eq!(provenance["engine"], "local-llm");
        assert_eq!(provenance["modelId"], "qwen3-4b-official-q4_k_m");
        assert_eq!(provenance["fallbackUsed"], false);
        assert_eq!(provenance["fallbackReason"], Value::Null);
        assert_eq!(provenance["promptVersion"], "candor-grounded-v1");
        assert!(provenance["generatedAt"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        assert!(provenance.get("prompt").is_none());
        assert!(provenance.get("transcript").is_none());
    }

    #[test]
    fn provenance_rejects_non_object_ai_results() {
        let error = with_ai_provenance(
            Value::Null,
            "local-llm",
            Some("qwen3-4b-official-q4_k_m".to_string()),
            false,
            None,
            "candor-grounded-v1",
        )
        .expect_err("non-object result must fail before persistence");

        assert_eq!(error.code, "LOCAL_AI_RESULT_INVALID");
        assert!(!error.retryable);
    }

    #[test]
    fn transcription_completion_omits_transcript_content_and_model_details() {
        let result = transcription_completion_summary(
            "recording-1".to_string(),
            &json!({
                "engine": "whisper-rs",
                "writtenSegmentCount": 3,
                "transcript": { "segments": [{ "text": "private meeting content" }] },
                "model": { "modelId": "private-model", "sha256": "secret-digest" }
            }),
        );
        assert_eq!(result["recordingId"], "recording-1");
        assert_eq!(result["engine"], "whisper-rs");
        assert_eq!(result["segmentCount"], 3);
        assert_eq!(result["rawPathExposed"], false);
        assert!(result.get("transcript").is_none());
        assert!(result.get("model").is_none());
    }
}
