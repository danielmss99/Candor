use std::fs;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

use crate::bundled_ai_assets::BundledAiAssets;
use crate::dictionary_package::verify_candordict_base64;
use crate::job_manager::{JobContext, JobDescriptor, JobExecutor, JobFailure, JobQuality};
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
    terminology_service: TerminologyService,
    transcription_service: TranscriptionService,
}

impl BackgroundJobServices {
    pub fn new(
        bundled_ai_assets: BundledAiAssets,
        model_manager: ModelManager,
        recording_store: RecordingStore,
        terminology_service: TerminologyService,
        transcription_service: TranscriptionService,
    ) -> Self {
        Self {
            bundled_ai_assets,
            model_manager,
            recording_store,
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
        let bytes = fs::read(asset.path).map_err(|_| {
            JobFailure::new(
                "BUNDLED_DICTIONARY_READ_FAILED",
                "the packaged general dictionary could not be read",
                false,
            )
        })?;
        let mut package = verify_candordict_base64(&STANDARD.encode(bytes))
            .map_err(|error| JobFailure::new(error.code, error.message, false))?;
        package.trust_label = "verified-candor-bundle".to_string();
        self.terminology_service
            .import_verified_package(package)
            .map_err(|error| JobFailure::new(error.code, error.message, false))?;
        Ok(())
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
                quality,
            } => self.recap(recording_id, quality, context),
            JobDescriptor::Ask {
                recording_id,
                question,
                quality,
            } => self.ask(recording_id, question, quality, context),
            JobDescriptor::Export { params } => self.export(params, context),
            JobDescriptor::DictionaryImport {
                source_file_name,
                archive_base64,
            } => self.import_dictionary(source_file_name, archive_base64, context),
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
        Ok(value)
    }

    fn recap(
        &self,
        recording_id: String,
        quality: JobQuality,
        context: JobContext,
    ) -> Result<Value, JobFailure> {
        context.progress("preparing", 0, Some(3), Some("stage"));
        let mut result = None;
        if quality == JobQuality::Best {
            let service = LocalInstructModelService::with_sources_and_terminology(
                self.recording_store.models_root_for_core().join("instruct"),
                self.bundled_ai_assets.clone(),
                self.terminology_service.clone(),
            );
            let mut scheduler = LocalModelScheduler::default();
            if service.status(&scheduler)["ready"] == true {
                context.progress("generating", 1, Some(3), Some("stage"));
                result = Some(
                    service
                        .recap_cancellable(
                            &self.recording_store,
                            &mut scheduler,
                            LocalInstructRecapParams {
                                recording_id: recording_id.clone(),
                                max_tokens: None,
                            },
                            context.cancellation_flag(),
                        )
                        .map_err(|error| JobFailure::new(error.code, error.message, true))?,
                );
            }
        }
        if result.is_none() {
            context.progress("summarizing", 1, Some(3), Some("stage"));
            result = Some(
                LocalAiService
                    .recap_heuristic(
                        &self.recording_store,
                        LocalRecapParams {
                            recording_id: recording_id.clone(),
                        },
                    )
                    .map_err(|error| JobFailure::new(error.code, error.message, true))?,
            );
        }
        let result = result.expect("recap result is assigned");
        context.progress("saving-local-result", 2, Some(3), Some("stage"));
        self.recording_store
            .record_processing_fact(
                &recording_id,
                "local-ai-recap",
                result["engine"].as_str().unwrap_or("local-ai"),
                None,
                None,
            )
            .map_err(|error| JobFailure::new(error.code, error.message, true))?;
        Ok(result)
    }

    fn ask(
        &self,
        recording_id: String,
        question: String,
        quality: JobQuality,
        context: JobContext,
    ) -> Result<Value, JobFailure> {
        context.progress("preparing", 0, Some(3), Some("stage"));
        let mut result = None;
        if quality == JobQuality::Best {
            let service = LocalInstructModelService::with_sources_and_terminology(
                self.recording_store.models_root_for_core().join("instruct"),
                self.bundled_ai_assets.clone(),
                self.terminology_service.clone(),
            );
            let mut scheduler = LocalModelScheduler::default();
            if service.status(&scheduler)["ready"] == true {
                context.progress("generating", 1, Some(3), Some("stage"));
                result = Some(
                    service
                        .ask_cancellable(
                            &self.recording_store,
                            &mut scheduler,
                            LocalInstructAskParams {
                                recording_id: recording_id.clone(),
                                question: question.clone(),
                                max_tokens: None,
                            },
                            context.cancellation_flag(),
                        )
                        .map_err(|error| JobFailure::new(error.code, error.message, true))?,
                );
            }
        }
        if result.is_none() {
            context.progress("answering", 1, Some(3), Some("stage"));
            result = Some(
                LocalAiService
                    .ask_heuristic(
                        &self.recording_store,
                        LocalAskParams {
                            recording_id: recording_id.clone(),
                            question,
                        },
                    )
                    .map_err(|error| JobFailure::new(error.code, error.message, true))?,
            );
        }
        let result = result.expect("Ask result is assigned");
        context.progress("saving-local-result", 2, Some(3), Some("stage"));
        self.recording_store
            .record_processing_fact(
                &recording_id,
                "local-ai-ask",
                result["engine"].as_str().unwrap_or("local-ai"),
                None,
                None,
            )
            .map_err(|error| JobFailure::new(error.code, error.message, true))?;
        Ok(result)
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
        source_file_name: String,
        archive_base64: String,
        context: JobContext,
    ) -> Result<Value, JobFailure> {
        context.progress("verifying-signature", 0, Some(3), Some("stage"));
        let package = verify_candordict_base64(&archive_base64)
            .map_err(|error| JobFailure::new(error.code, error.message, false))?;
        context.progress("validating-terms", 1, Some(3), Some("stage"));
        let mut value = self
            .terminology_service
            .import_verified_package(package)
            .map_err(|error| JobFailure::new(error.code, error.message, false))?;
        context.progress("saving-locally", 2, Some(3), Some("stage"));
        if let Some(root) = value.as_object_mut() {
            root.insert(
                "sourceFileName".to_string(),
                Value::String(source_file_name),
            );
            root.insert("localOnly".to_string(), Value::Bool(true));
        }
        Ok(value)
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
            quality: JobQuality::Fast,
        })
    });
    JobDescriptor::Transcription {
        recording_id,
        channel,
        model_id,
        follow_up,
    }
}

pub fn descriptor_for_recap(recording_id: String, best: bool) -> JobDescriptor {
    JobDescriptor::Recap {
        recording_id,
        quality: if best {
            JobQuality::Best
        } else {
            JobQuality::Fast
        },
    }
}

pub fn descriptor_for_ask(recording_id: String, question: String, best: bool) -> JobDescriptor {
    JobDescriptor::Ask {
        recording_id,
        question,
        quality: if best {
            JobQuality::Best
        } else {
            JobQuality::Fast
        },
    }
}

pub fn descriptor_for_export(params: Value) -> JobDescriptor {
    JobDescriptor::Export { params }
}

pub fn descriptor_for_dictionary_import(
    source_file_name: String,
    archive_base64: String,
) -> JobDescriptor {
    JobDescriptor::DictionaryImport {
        source_file_name,
        archive_base64,
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
