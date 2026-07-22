use std::fs;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::bundled_ai_assets::{BundledAiAssets, VerifiedLanguageIdentity};
use crate::dictionary_package::{verify_candordict_bytes_with_trust, DictionaryTrustAnchor};
use crate::dictionary_staging::{DictionaryStaging, StagedDictionary};
use crate::job_manager::{
    AiExecutionMode, AiFallbackPolicy, JobContext, JobDescriptor, JobExecutor, JobFailure,
};
use crate::local_ai_service::{LocalAiService, LocalAskParams, LocalRecapParams};
use crate::local_instruct_model::{
    cleanup_prompt_template_sha256, recap_prompt_template_sha256, LocalInstructAskParams,
    LocalInstructCleanupParams, LocalInstructModelService, LocalInstructRecapParams,
};
use crate::local_model_scheduler::LocalModelScheduler;
use crate::meeting_profiles::MeetingProcessingProfileSnapshot;
use crate::model_manager::ModelManager;
use crate::recording_store::{
    CleanupFailureDraft, ExportRecordingParams, RecapReceiptDraft, RecordingIdParams,
    RecordingStore, RecordingStoreError,
};
use crate::terminology_dictionary::{TerminologyService, TerminologyStatusParams};
use crate::transcription_service::{TranscriptionRunLocalParams, TranscriptionService};
use candor_core::live_transcript_service::LiveTranscriptService;

#[derive(Clone)]
pub struct BackgroundJobServices {
    bundled_ai_assets: BundledAiAssets,
    model_manager: ModelManager,
    recording_store: RecordingStore,
    dictionary_staging: DictionaryStaging,
    terminology_service: TerminologyService,
    transcription_service: TranscriptionService,
    live_transcript: LiveTranscriptService,
}

impl BackgroundJobServices {
    pub fn new(
        bundled_ai_assets: BundledAiAssets,
        model_manager: ModelManager,
        recording_store: RecordingStore,
        dictionary_staging: DictionaryStaging,
        terminology_service: TerminologyService,
        transcription_service: TranscriptionService,
        live_transcript: LiveTranscriptService,
    ) -> Self {
        Self {
            bundled_ai_assets,
            model_manager,
            recording_store,
            dictionary_staging,
            terminology_service,
            transcription_service,
            live_transcript,
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
            JobDescriptor::Cleanup {
                recording_id,
                fallback_to_raw,
                ..
            } => self.cleanup(recording_id, fallback_to_raw, context),
            JobDescriptor::Recap {
                recording_id,
                recap_template,
                mode,
                fallback_policy,
                ..
            } => self.recap(recording_id, recap_template, mode, fallback_policy, context),
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
        let run = service
            .run_local_cancellable_with_commit(
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
        let _ = self
            .live_transcript
            .reconcile_committed(&run.committed_final_revision);
        let value = run.public_value;
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

    fn cleanup(
        &self,
        recording_id: String,
        fallback_to_raw: bool,
        context: JobContext,
    ) -> Result<Value, JobFailure> {
        context.progress("preparing-cleanup", 0, Some(3), Some("stage"));
        let selected_input = self
            .recording_store
            .transcript_for_local_ai(recording_id.clone())
            .map_err(|error| JobFailure::new(error.code, error.message, true))?;
        if selected_input
            .get("inputRevisionKind")
            .and_then(Value::as_str)
            == Some("ai-cleaned")
        {
            return Ok(json!({
                "recordingId": recording_id,
                "revisionId": selected_input.get("inputRevisionId").cloned().unwrap_or(Value::Null),
                "parentRevisionId": selected_input.get("currentRevisionId").cloned().unwrap_or(Value::Null),
                "kind": "ai-cleaned",
                "source": "ai-cleanup",
                "current": false,
                "currentCleaned": true,
                "segmentCount": selected_input.get("segmentCount").cloned().unwrap_or(json!(0)),
                "validationResult": "passed",
                "cleaned": true,
                "fallbackApplied": false,
                "reused": true,
                "localOnly": true,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            }));
        }
        let fallback_input_kind = selected_input
            .get("inputRevisionKind")
            .and_then(Value::as_str)
            .unwrap_or("legacy")
            .to_string();
        let source = self
            .recording_store
            .transcript(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .map_err(|error| JobFailure::new(error.code, error.message, true))?;
        let parent_revision_id = source
            .get("currentRevisionId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                JobFailure::new(
                    "LOCAL_LLM_CLEANUP_SOURCE_INVALID",
                    "transcript cleanup requires an immutable source revision",
                    false,
                )
            })?
            .to_string();
        let started_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        let started = Instant::now();
        let service = self.local_instruct_service();
        let mut scheduler = LocalModelScheduler::default();
        let status = service.status(&scheduler);
        let identity = if status["ready"] == true {
            Some(self.required_local_llm_identity(&status)?)
        } else {
            None
        };
        context.progress("cleaning-transcript", 1, Some(3), Some("stage"));
        let result = match identity.as_ref() {
            Some(identity) => service.cleanup_cancellable(
                &self.recording_store,
                &mut scheduler,
                LocalInstructCleanupParams {
                    recording_id: recording_id.clone(),
                    max_tokens: None,
                },
                &identity.model_id,
                &identity.model_sha256,
                context.cancellation_flag(),
            ),
            None => Err(crate::local_instruct_model::LocalInstructError {
                code: stable_local_ai_code(
                    status["failureCode"]
                        .as_str()
                        .unwrap_or("LOCAL_LLM_UNAVAILABLE"),
                ),
                message: "the verified local cleanup model is not ready".to_string(),
            }),
        };
        let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        match result {
            Ok(value) => {
                context.progress("saving-cleaned-transcript", 2, Some(3), Some("stage"));
                let identity = identity.expect("successful cleanup has verified identity");
                self.recording_store
                    .record_processing_fact(
                        &recording_id,
                        "local-ai-cleanup",
                        "llama-cpp-local",
                        Some(&identity.model_id),
                        Some(&identity.model_sha256),
                    )
                    .map_err(|error| JobFailure::new(error.code, error.message, true))?;
                Ok(value)
            }
            Err(error) => {
                let cancelled = context.cancelled() || error.code == "LOCAL_LLM_COMMAND_CANCELLED";
                let _ = self
                    .recording_store
                    .record_cleanup_failure(CleanupFailureDraft {
                        recording_id: recording_id.clone(),
                        parent_revision_id,
                        engine: "llama-cpp-local".to_string(),
                        model_id: identity.as_ref().map(|value| value.model_id.clone()),
                        model_sha256: identity.as_ref().map(|value| value.model_sha256.clone()),
                        prompt_template_sha256: cleanup_prompt_template_sha256(),
                        started_at_ms,
                        elapsed_ms,
                        error_code: error.code.to_string(),
                        cancelled,
                    });
                if fallback_to_raw && !cancelled && !is_non_fallback_error(error.code) {
                    Ok(json!({
                        "recordingId": recording_id,
                        "cleaned": false,
                        "fallbackApplied": true,
                        "fallbackInputKind": fallback_input_kind,
                        "failureCode": stable_local_ai_code(error.code),
                        "localOnly": true,
                        "rawPathExposed": false,
                        "keyMaterialExposedToRenderer": false
                    }))
                } else {
                    Err(JobFailure::new(error.code, error.message, true))
                }
            }
        }
    }

    fn recap(
        &self,
        recording_id: String,
        recap_template: Option<String>,
        mode: AiExecutionMode,
        fallback_policy: AiFallbackPolicy,
        context: JobContext,
    ) -> Result<Value, JobFailure> {
        let started_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        let started = Instant::now();
        let recap_template_requested = recap_template
            .as_deref()
            .is_some_and(|template| !template.trim().is_empty());
        context.progress("preparing", 0, Some(3), Some("stage"));
        let mut result = match mode {
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
                    let identity_before = self.required_local_llm_identity(&status)?;
                    context.progress("generating", 1, Some(3), Some("stage"));
                    match service.recap_cancellable(
                        &self.recording_store,
                        &mut scheduler,
                        LocalInstructRecapParams {
                            recording_id: recording_id.clone(),
                            recap_template,
                            max_tokens: None,
                        },
                        context.cancellation_flag(),
                    ) {
                        Ok(value) => {
                            let status_after = service.status(&scheduler);
                            let identity_after = self.required_local_llm_identity(&status_after)?;
                            if identity_after != identity_before {
                                return Err(JobFailure::new(
                                    "LOCAL_LLM_IDENTITY_CHANGED",
                                    "the verified Local AI identity changed during generation",
                                    false,
                                ));
                            }
                            with_ai_provenance(
                                value,
                                "local-llm",
                                Some(&identity_before),
                                false,
                                None,
                                "candor-grounded-v1",
                            )?
                        }
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
        if let Some(root) = result.as_object_mut() {
            root.insert(
                "recapTemplateRequested".to_string(),
                Value::Bool(recap_template_requested),
            );
            root.entry("recapTemplateApplied".to_string())
                .or_insert_with(|| {
                    Value::Bool(recap_template_requested && mode == AiExecutionMode::LocalLlm)
                });
        }
        if context.cancelled() {
            return Err(JobFailure::new(
                "JOB_CANCELLED",
                "the recap was cancelled before its result was saved",
                false,
            ));
        }
        context.progress("saving-local-result", 2, Some(3), Some("stage"));
        let input_revision_id = result
            .get("inputRevisionId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                JobFailure::new(
                    "LOCAL_AI_RECAP_LINEAGE_INVALID",
                    "the recap did not identify its transcript input revision",
                    false,
                )
            })?;
        let provenance = result.get("provenance").and_then(Value::as_object);
        let engine = result
            .get("engine")
            .and_then(Value::as_str)
            .unwrap_or("heuristic-local");
        let prompt_version = provenance
            .and_then(|value| value.get("promptVersion"))
            .and_then(Value::as_str)
            .unwrap_or("candor-heuristic-v1");
        let prompt_template_sha256 = if engine == "llama-cpp-local" {
            recap_prompt_template_sha256()
        } else {
            format!("{:x}", Sha256::digest(prompt_version.as_bytes()))
        };
        let fallback_applied = required_cleanup_fallback(&result)?
            || provenance
                .and_then(|value| value.get("fallbackUsed"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
        self.recording_store
            .record_recap_receipt(RecapReceiptDraft {
                recording_id: recording_id.clone(),
                input_revision_id: input_revision_id.to_string(),
                engine: engine.to_string(),
                model_id: provenance
                    .and_then(|value| value.get("modelId"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                model_sha256: provenance
                    .and_then(|value| value.get("modelSha256"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                prompt_template_sha256,
                validation_result: if engine == "llama-cpp-local" {
                    "passed".to_string()
                } else {
                    "not-applicable".to_string()
                },
                fallback_applied,
                started_at_ms,
                elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            })
            .map_err(|error| JobFailure::new(error.code, error.message, true))?;
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
                    let identity_before = self.required_local_llm_identity(&status)?;
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
                        Ok(value) => {
                            let status_after = service.status(&scheduler);
                            let identity_after = self.required_local_llm_identity(&status_after)?;
                            if identity_after != identity_before {
                                return Err(JobFailure::new(
                                    "LOCAL_LLM_IDENTITY_CHANGED",
                                    "the verified Local AI identity changed during generation",
                                    false,
                                ));
                            }
                            with_ai_provenance(
                                value,
                                "local-llm",
                                Some(&identity_before),
                                false,
                                None,
                                "candor-grounded-v1",
                            )?
                        }
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

    fn required_local_llm_identity(
        &self,
        status: &Value,
    ) -> Result<VerifiedLanguageIdentity, JobFailure> {
        if status
            .pointer("/configuration/source")
            .and_then(Value::as_str)
            != Some("bundled-package")
        {
            return Err(JobFailure::new(
                "LOCAL_LLM_IDENTITY_UNVERIFIED",
                "Local AI is not bound to a verified packaged model identity",
                false,
            ));
        }
        self.bundled_ai_assets
            .required_language_identity()
            .map_err(|error| JobFailure::new(error.code, error.message, false))
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
    processing_profile: Option<&MeetingProcessingProfileSnapshot>,
    recap_fallback_policy: AiFallbackPolicy,
) -> JobDescriptor {
    let model_id = model_id.or_else(|| processing_profile.map(|profile| profile.model_id.clone()));
    let recap_template = processing_profile.and_then(|profile| profile.recap_template.clone());
    let follow_up = auto_recap.then(|| {
        let recap = JobDescriptor::Recap {
            recording_id: recording_id.clone(),
            recap_template,
            mode: AiExecutionMode::LocalLlm,
            fallback_policy: recap_fallback_policy,
            legacy_quality: None,
        };
        Box::new(JobDescriptor::Cleanup {
            recording_id: recording_id.clone(),
            fallback_to_raw: true,
            follow_up: Some(Box::new(recap)),
        })
    });
    JobDescriptor::Transcription {
        recording_id,
        channel,
        model_id,
        follow_up,
    }
}

pub fn descriptor_for_cleanup(recording_id: String, fallback_to_raw: bool) -> JobDescriptor {
    JobDescriptor::Cleanup {
        recording_id,
        fallback_to_raw,
        follow_up: None,
    }
}

pub fn descriptor_for_recap(
    recording_id: String,
    recap_template: Option<String>,
    mode: AiExecutionMode,
    fallback_policy: AiFallbackPolicy,
) -> JobDescriptor {
    JobDescriptor::Recap {
        recording_id,
        recap_template,
        mode,
        fallback_policy,
        legacy_quality: None,
    }
}

pub fn descriptor_for_recording_recap(
    store: &RecordingStore,
    recording_id: String,
    requested_template: Option<String>,
    mode: AiExecutionMode,
    fallback_policy: AiFallbackPolicy,
) -> Result<JobDescriptor, RecordingStoreError> {
    let recap_template = store
        .processing_profile(&recording_id)?
        .and_then(|profile| profile.recap_template)
        .or(requested_template);
    Ok(descriptor_for_recap(
        recording_id,
        recap_template,
        mode,
        fallback_policy,
    ))
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
    identity: Option<&VerifiedLanguageIdentity>,
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
            "modelId": identity.map(|value| value.model_id.as_str()),
            "modelSha256": identity.map(|value| value.model_sha256.as_str()),
            "runtimeSha256": identity.map(|value| value.runtime_sha256.as_str()),
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
        "modelId": result["model"]["modelId"].as_str(),
        "language": result["language"].as_str(),
        "processingProfile": result.get("processingProfile").cloned().unwrap_or(Value::Null),
        "normalization": result.get("normalization").cloned().unwrap_or(Value::Null),
        "revisionId": result["trustHistory"]["revisionId"].as_str(),
        "receiptId": result["trustHistory"]["receiptId"].as_str(),
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
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

fn required_cleanup_fallback(result: &Value) -> Result<bool, JobFailure> {
    result
        .get("cleanupFallbackApplied")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            JobFailure::new(
                "LOCAL_AI_RECAP_LINEAGE_INVALID",
                "the recap did not identify whether transcript cleanup fell back",
                false,
            )
        })
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
    use crate::meeting_profiles::{
        MeetingProcessingProfileSnapshot, ProfileCaptureSource, PROCESSING_PROFILE_SCHEMA_VERSION,
    };
    use crate::recording_store::StartRecordingParams;

    fn profile_snapshot(template: &str) -> MeetingProcessingProfileSnapshot {
        MeetingProcessingProfileSnapshot {
            schema_version: PROCESSING_PROFILE_SCHEMA_VERSION,
            profile_id: "standup".to_string(),
            profile_version: 1,
            capture_source: ProfileCaptureSource::Microphone,
            model_id: "small".to_string(),
            speech_model_id: Some("small".to_string()),
            cleanup_model_id: Some("qwen3-4b-official-q4_k_m".to_string()),
            summary_model_id: Some("qwen3-4b-official-q4_k_m".to_string()),
            language: "auto".to_string(),
            transcription_language: "auto".to_string(),
            dictionary_ids: vec!["product".to_string()],
            replacement_rule_set: None,
            recap_template: Some(template.to_string()),
            live_transcription: true,
        }
    }

    #[test]
    fn automatic_recap_carries_the_selected_profile_template() {
        let profile = profile_snapshot("Focus on blockers and owners.");
        let descriptor = descriptor_for_transcription(
            "recording-profile".to_string(),
            None,
            None,
            true,
            Some(&profile),
            AiFallbackPolicy::RequireLocalLlm,
        );
        let JobDescriptor::Transcription {
            model_id,
            follow_up: Some(follow_up),
            ..
        } = descriptor
        else {
            panic!("expected transcription follow-up");
        };
        let JobDescriptor::Cleanup {
            fallback_to_raw,
            follow_up: Some(recap_follow_up),
            ..
        } = *follow_up
        else {
            panic!("expected cleanup handoff");
        };
        let JobDescriptor::Recap { recap_template, .. } = *recap_follow_up else {
            panic!("expected recap after cleanup");
        };
        assert!(fallback_to_raw);
        assert_eq!(
            recap_template.as_deref(),
            Some("Focus on blockers and owners.")
        );
        assert_eq!(model_id.as_deref(), Some("small"));
    }

    #[test]
    fn manual_recap_uses_capture_time_template_instead_of_current_renderer_profile() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "candor-recording-recap-profile-{}-{suffix}",
            std::process::id()
        ));
        let store = RecordingStore::with_root(root.clone());
        let started = store
            .start_with_processing_profile(
                StartRecordingParams {
                    label: Some("Bound recap".to_string()),
                },
                Some(profile_snapshot("Template A from capture.")),
            )
            .expect("start recording");
        let recording_id = started["recordingId"].as_str().unwrap().to_string();
        let descriptor = descriptor_for_recording_recap(
            &store,
            recording_id,
            Some("Template B from current profile.".to_string()),
            AiExecutionMode::LocalLlm,
            AiFallbackPolicy::RequireLocalLlm,
        )
        .expect("descriptor");
        let JobDescriptor::Recap { recap_template, .. } = descriptor else {
            panic!("expected recap descriptor");
        };
        assert_eq!(recap_template.as_deref(), Some("Template A from capture."));
        let _ = std::fs::remove_dir_all(root);
    }

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
    fn recap_receipt_requires_explicit_cleanup_fallback_lineage() {
        let error = required_cleanup_fallback(&json!({
            "inputRevisionId": "revision-1"
        }))
        .expect_err("missing cleanup fallback lineage must fail closed");
        assert_eq!(error.code, "LOCAL_AI_RECAP_LINEAGE_INVALID");
        assert!(!error.retryable);

        assert!(required_cleanup_fallback(&json!({
            "cleanupFallbackApplied": true
        }))
        .expect("explicit cleanup fallback lineage"));
    }

    #[test]
    fn provenance_is_typed_and_contains_no_source_content() {
        let identity = VerifiedLanguageIdentity {
            model_id: "qwen3-4b-official-q4_k_m".to_string(),
            model_sha256: "a".repeat(64),
            runtime_sha256: "b".repeat(64),
        };
        let value = with_ai_provenance(
            json!({ "summary": "fixture" }),
            "local-llm",
            Some(&identity),
            false,
            None,
            "candor-grounded-v1",
        )
        .expect("object result accepts provenance");
        let provenance = &value["provenance"];
        assert_eq!(provenance["engine"], "local-llm");
        assert_eq!(provenance["modelId"], "qwen3-4b-official-q4_k_m");
        assert_eq!(provenance["modelSha256"], "a".repeat(64));
        assert_eq!(provenance["runtimeSha256"], "b".repeat(64));
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
        let identity = VerifiedLanguageIdentity {
            model_id: "qwen3-4b-official-q4_k_m".to_string(),
            model_sha256: "a".repeat(64),
            runtime_sha256: "b".repeat(64),
        };
        let error = with_ai_provenance(
            Value::Null,
            "local-llm",
            Some(&identity),
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
