use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};
use getrandom::getrandom;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::dictionary_staging::DictionaryStaging;
use crate::os_key_store;

const MAX_RETAINED_JOBS: usize = 256;
const JOB_STORE_SCHEMA_VERSION: u32 = 2;
const JOB_STORE_FILE: &str = "background-jobs.bin";
const JOB_STORE_BACKUP_FILE: &str = "background-jobs.bin.bak";
const JOB_STORE_TEMP_FILE: &str = "background-jobs.bin.tmp";
const JOB_STORE_MIGRATION_BACKUP_FILE: &str = "background-jobs.bin.migration.bak";
const JOB_STORE_RECOVERY_TEMP_FILE: &str = ".background-jobs.recovery.tmp";
const JOB_STORE_MAGIC: &[u8] = b"candor-jobs-v1\0";
const JOB_STORE_AAD: &[u8] = b"candor-background-jobs-v1";
const JOB_STORE_KEY_LABEL: &[u8] = b"candor-background-jobs-v1";
const NONCE_BYTES: usize = 12;
const MAX_JOB_STORE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PERSISTED_RESULT_BYTES: usize = 1024 * 1024;
const ASK_QUESTION_RETENTION_MS: u128 = 24 * 60 * 60 * 1000;
const TERMINAL_JOB_RETENTION_MS: u128 = 7 * 24 * 60 * 60 * 1000;
const RETRYABLE_DICTIONARY_STAGING_RETENTION_MS: u128 = 72 * 60 * 60 * 1000;

#[derive(Clone, Debug)]
pub struct JobManagerError {
    pub code: &'static str,
    pub message: String,
}

pub struct JobAcknowledgement {
    pub response: Value,
}

impl JobManagerError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug)]
pub struct JobFailure {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl JobFailure {
    pub fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum JobState {
    Queued,
    Running,
    Paused,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}

impl JobState {
    fn label(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Cancelling => "cancelling",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    fn cancellable(self) -> bool {
        matches!(self, Self::Queued | Self::Running | Self::Paused)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LegacyJobQuality {
    Fast,
    Best,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiExecutionMode {
    #[default]
    LocalLlm,
    HeuristicFallback,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiFallbackPolicy {
    AllowDisclosed,
    #[default]
    RequireLocalLlm,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JobDescriptor {
    Transcription {
        recording_id: String,
        #[serde(default)]
        channel: Option<String>,
        #[serde(default)]
        model_id: Option<String>,
        #[serde(default)]
        follow_up: Option<Box<JobDescriptor>>,
    },
    Cleanup {
        recording_id: String,
        #[serde(default)]
        fallback_to_raw: bool,
        #[serde(default)]
        follow_up: Option<Box<JobDescriptor>>,
    },
    Recap {
        recording_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recap_template: Option<String>,
        #[serde(default)]
        mode: AiExecutionMode,
        #[serde(default)]
        fallback_policy: AiFallbackPolicy,
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "quality")]
        legacy_quality: Option<LegacyJobQuality>,
    },
    Ask {
        recording_id: String,
        question: String,
        #[serde(default)]
        mode: AiExecutionMode,
        #[serde(default)]
        fallback_policy: AiFallbackPolicy,
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "quality")]
        legacy_quality: Option<LegacyJobQuality>,
    },
    Export {
        params: Value,
    },
    DictionaryImport {
        #[serde(default)]
        staging_token: String,
        #[serde(default)]
        expected_sha256: String,
        #[serde(default)]
        original_display_name: String,
        #[serde(default)]
        bytes: u64,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "source_file_name"
        )]
        legacy_source_file_name: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "archive_base64"
        )]
        legacy_archive_base64: Option<String>,
    },
    DictionaryIndex {
        dictionary_id: String,
    },
}

impl JobDescriptor {
    pub fn job_type(&self) -> &'static str {
        match self {
            Self::Transcription { .. } => "transcription",
            Self::Cleanup { .. } => "transcript-cleanup",
            Self::Recap { .. } => "recap",
            Self::Ask { .. } => "ask",
            Self::Export { .. } => "export",
            Self::DictionaryImport { .. } => "dictionary-import",
            Self::DictionaryIndex { .. } => "dictionary-index",
        }
    }

    pub fn recording_id(&self) -> Option<&str> {
        match self {
            Self::Transcription { recording_id, .. }
            | Self::Cleanup { recording_id, .. }
            | Self::Recap { recording_id, .. }
            | Self::Ask { recording_id, .. } => Some(recording_id),
            Self::Export { params } => params.get("recordingId").and_then(Value::as_str),
            Self::DictionaryImport { .. } | Self::DictionaryIndex { .. } => None,
        }
    }

    fn exclusive_inference(&self) -> bool {
        matches!(
            self,
            Self::Transcription { .. }
                | Self::Cleanup { .. }
                | Self::Recap { .. }
                | Self::Ask { .. }
        )
    }

    fn scheduling_priority(&self) -> u8 {
        match self {
            Self::Transcription { .. } => 60,
            Self::Cleanup { .. } => 55,
            Self::Recap { .. } | Self::Ask { .. } => 50,
            Self::Export { .. } => 40,
            Self::DictionaryImport { .. } | Self::DictionaryIndex { .. } => 10,
        }
    }

    fn follow_up(&self) -> Option<JobDescriptor> {
        match self {
            Self::Transcription { follow_up, .. } | Self::Cleanup { follow_up, .. } => {
                follow_up.as_deref().cloned()
            }
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobProgress {
    completed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unit: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedJobEntry {
    job_id: String,
    job_type: String,
    state: JobState,
    created_at: String,
    updated_at: String,
    created_at_ms: u128,
    updated_at_ms: u128,
    #[serde(default)]
    started_at_ms: Option<u128>,
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    progress: Option<JobProgress>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    result_persisted: bool,
    #[serde(default)]
    error: Option<Value>,
    #[serde(default)]
    cancel_requested: bool,
    #[serde(default)]
    descriptor: Option<JobDescriptor>,
    #[serde(default)]
    exclusive_inference: bool,
    #[serde(default)]
    retry_count: u32,
    #[serde(default)]
    parent_job_id: Option<String>,
    #[serde(default)]
    follow_up_queued: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobStoreDocument {
    schema_version: u32,
    jobs: Vec<PersistedJobEntry>,
}

impl Default for JobStoreDocument {
    fn default() -> Self {
        Self {
            schema_version: JOB_STORE_SCHEMA_VERSION,
            jobs: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
struct JobEntry {
    job_id: String,
    job_type: String,
    state: JobState,
    created_at: String,
    updated_at: String,
    created_at_ms: u128,
    updated_at_ms: u128,
    started_at_ms: Option<u128>,
    stage: Option<String>,
    progress: Option<JobProgress>,
    result: Option<Value>,
    result_persisted: bool,
    error: Option<Value>,
    cancel_requested: bool,
    cancellation: Arc<AtomicBool>,
    descriptor: Option<JobDescriptor>,
    exclusive_inference: bool,
    retry_count: u32,
    parent_job_id: Option<String>,
    follow_up_queued: bool,
    preempt_requested: bool,
    shutdown_pause_requested: bool,
}

impl JobEntry {
    fn from_persisted(value: PersistedJobEntry) -> Self {
        let mut state = value.state;
        let mut stage = value.stage;
        let mut error = value.error;
        let mut cancel_requested = state == JobState::Cancelled;
        if !state.terminal() {
            if value.descriptor.is_some() {
                state = JobState::Paused;
                stage = Some("restart-recovery".to_string());
                error = None;
            } else {
                state = JobState::Failed;
                stage = Some("interrupted".to_string());
                error = Some(job_error_value(
                    &value.job_id,
                    &value.job_type,
                    JobFailure::new(
                        "JOB_INTERRUPTED",
                        "local work was interrupted and must be started again",
                        true,
                    ),
                ));
            }
            cancel_requested = false;
        }
        Self {
            job_id: value.job_id,
            job_type: value.job_type,
            state,
            created_at: value.created_at,
            updated_at: timestamp(),
            created_at_ms: value.created_at_ms,
            updated_at_ms: now_ms(),
            started_at_ms: value.started_at_ms,
            stage,
            progress: value.progress,
            result: value.result,
            result_persisted: value.result_persisted,
            error,
            cancel_requested,
            cancellation: Arc::new(AtomicBool::new(false)),
            descriptor: value.descriptor,
            exclusive_inference: value.exclusive_inference,
            retry_count: value.retry_count,
            parent_job_id: value.parent_job_id,
            follow_up_queued: value.follow_up_queued,
            preempt_requested: false,
            shutdown_pause_requested: false,
        }
    }

    fn persisted(&self) -> PersistedJobEntry {
        let (result, result_persisted) = bounded_persisted_result(self.result.as_ref());
        PersistedJobEntry {
            job_id: self.job_id.clone(),
            job_type: self.job_type.clone(),
            state: self.state,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
            started_at_ms: self.started_at_ms,
            stage: self.stage.clone(),
            progress: self.progress.clone(),
            result,
            result_persisted,
            error: self.error.clone(),
            cancel_requested: self.cancel_requested,
            descriptor: self.descriptor.clone(),
            exclusive_inference: self.exclusive_inference,
            retry_count: self.retry_count,
            parent_job_id: self.parent_job_id.clone(),
            follow_up_queued: self.follow_up_queued,
        }
    }

    fn estimated_remaining_ms(&self) -> Option<u128> {
        if self.state != JobState::Running {
            return None;
        }
        let progress = self.progress.as_ref()?;
        let total = progress.total?;
        if progress.completed == 0 || progress.completed >= total {
            return None;
        }
        let started = self.started_at_ms?;
        let elapsed = now_ms().saturating_sub(started);
        Some(
            elapsed.saturating_mul(u128::from(total.saturating_sub(progress.completed)))
                / u128::from(progress.completed),
        )
    }

    fn scheduling_priority(&self) -> u8 {
        self.descriptor
            .as_ref()
            .map(JobDescriptor::scheduling_priority)
            .unwrap_or_else(|| job_type_priority(&self.job_type))
    }

    fn value(&self, include_result: bool) -> Value {
        let cancelled_dictionary_import = self.state == JobState::Cancelled
            && matches!(
                self.descriptor,
                Some(JobDescriptor::DictionaryImport { .. })
            );
        let retryable = !cancelled_dictionary_import
            && self.descriptor.is_some()
            && (matches!(self.state, JobState::Paused | JobState::Cancelled)
                || self
                    .error
                    .as_ref()
                    .and_then(|value| value.get("retryable"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false));
        let provenance = self
            .result
            .as_ref()
            .and_then(|result| result.get("provenance"))
            .cloned();
        let engine = provenance
            .as_ref()
            .and_then(|value| value.get("engine"))
            .cloned();
        let fallback_used = provenance
            .as_ref()
            .and_then(|value| value.get("fallbackUsed"))
            .cloned();
        json!({
            "jobId": self.job_id,
            "type": self.job_type,
            "state": self.state.label(),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "stage": self.stage,
            "progress": self.progress,
            "estimatedRemainingMs": self.estimated_remaining_ms(),
            "recordingId": self.descriptor.as_ref().and_then(JobDescriptor::recording_id),
            "parentJobId": self.parent_job_id,
            "result": if include_result { self.result.clone() } else { None },
            "resultAvailableAfterRestart": self.result_persisted,
            "error": self.error,
            "engine": engine,
            "fallbackUsed": fallback_used,
            "provenance": provenance,
            "cancelRequested": self.cancel_requested,
            "retryCount": self.retry_count,
            "retryable": retryable,
            "terminal": self.state.terminal(),
            "sourceDataPreserved": true,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }
}

fn job_entry_recording_id(entry: &JobEntry) -> Option<&str> {
    entry
        .descriptor
        .as_ref()
        .and_then(JobDescriptor::recording_id)
        .or_else(|| {
            entry
                .result
                .as_ref()
                .and_then(|value| value.get("recordingId"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            entry
                .error
                .as_ref()
                .and_then(|value| value.get("recordingId"))
                .and_then(Value::as_str)
        })
}

#[derive(Clone)]
struct JobPersistence {
    root: PathBuf,
    key_root: PathBuf,
    #[cfg(test)]
    test_key: Option<[u8; 32]>,
}

struct JobManagerInner {
    protocol_version: &'static str,
    jobs: Mutex<HashMap<String, JobEntry>>,
    deleting_recordings: Mutex<HashSet<String>>,
    workers: Mutex<HashSet<String>>,
    inference_gate: Mutex<()>,
    recording_active: AtomicBool,
    shutdown_requested: AtomicBool,
    priority_lock: Mutex<()>,
    priority_changed: Condvar,
    persistence: Option<JobPersistence>,
    persistence_lock: Mutex<()>,
    persistence_error: Mutex<Option<JobManagerError>>,
}

#[derive(Clone)]
pub struct JobManager {
    inner: Arc<JobManagerInner>,
}

#[derive(Clone)]
pub struct JobContext {
    manager: JobManager,
    job_id: String,
    cancellation: Arc<AtomicBool>,
}

impl JobContext {
    pub fn cancelled(&self) -> bool {
        self.cancellation.load(Ordering::SeqCst)
    }

    pub fn cancellation_flag(&self) -> Arc<AtomicBool> {
        self.cancellation.clone()
    }

    pub fn progress(&self, stage: &str, completed: u64, total: Option<u64>, unit: Option<&str>) {
        let (completed, total, unit) = match (unit, total) {
            (Some("stage" | "job"), Some(total)) if total > 0 => (
                completed.saturating_mul(100) / total,
                Some(100),
                Some("percent"),
            ),
            (Some("stage" | "job"), _) => (completed.min(100), None, Some("percent")),
            _ => (completed, total, unit),
        };
        self.manager.update_progress(
            &self.job_id,
            stage,
            JobProgress {
                completed,
                total,
                unit: unit.map(str::to_string),
            },
        );
    }
}

pub type JobExecutor =
    Arc<dyn Fn(JobDescriptor, JobContext) -> Result<Value, JobFailure> + Send + Sync + 'static>;

enum WorkerGate {
    Ready,
    Cancelled,
    PausedForShutdown,
}

struct WorkerRegistration {
    manager: JobManager,
    job_id: String,
}

impl WorkerRegistration {
    fn new(manager: JobManager, job_id: String) -> Self {
        Self { manager, job_id }
    }
}

impl Drop for WorkerRegistration {
    fn drop(&mut self) {
        self.manager.release_worker(&self.job_id);
    }
}

impl JobManager {
    /// Creates a manager with no durable job store. This is used by the
    /// read-only automation core so merely listing meetings cannot read,
    /// recover, or rewrite the desktop process's background-job state.
    pub fn in_memory(protocol_version: &'static str) -> Self {
        Self::build(protocol_version, None, None)
    }

    #[cfg(test)]
    pub fn new(protocol_version: &'static str) -> Self {
        Self::in_memory(protocol_version)
    }

    pub fn with_roots_and_staging(
        protocol_version: &'static str,
        root: PathBuf,
        key_root: PathBuf,
        staging: &DictionaryStaging,
    ) -> Self {
        Self::build(
            protocol_version,
            Some(JobPersistence {
                root,
                key_root,
                #[cfg(test)]
                test_key: None,
            }),
            Some(staging),
        )
    }

    #[cfg(test)]
    pub fn with_test_roots(
        protocol_version: &'static str,
        root: PathBuf,
        key_root: PathBuf,
    ) -> Self {
        Self::build(
            protocol_version,
            Some(JobPersistence {
                root,
                key_root,
                test_key: Some([0x39; 32]),
            }),
            None,
        )
    }

    #[cfg(test)]
    pub fn with_test_roots_and_staging(
        protocol_version: &'static str,
        root: PathBuf,
        key_root: PathBuf,
        staging: &DictionaryStaging,
    ) -> Self {
        Self::build(
            protocol_version,
            Some(JobPersistence {
                root,
                key_root,
                test_key: Some([0x39; 32]),
            }),
            Some(staging),
        )
    }

    fn build(
        protocol_version: &'static str,
        persistence: Option<JobPersistence>,
        staging: Option<&DictionaryStaging>,
    ) -> Self {
        let mut persistence_error = None;
        let mut jobs = HashMap::new();
        if let Some(config) = persistence.as_ref() {
            match read_job_document_with_recovery(config)
                .and_then(|document| prepare_job_document(config, document, staging))
            {
                Ok(document) => {
                    for value in document.jobs {
                        if validate_job_id(&value.job_id).is_ok() {
                            jobs.insert(value.job_id.clone(), JobEntry::from_persisted(value));
                        }
                    }
                }
                Err(error) => persistence_error = Some(error),
            }
        }
        let manager = Self {
            inner: Arc::new(JobManagerInner {
                protocol_version,
                jobs: Mutex::new(jobs),
                deleting_recordings: Mutex::new(HashSet::new()),
                workers: Mutex::new(HashSet::new()),
                inference_gate: Mutex::new(()),
                recording_active: AtomicBool::new(false),
                shutdown_requested: AtomicBool::new(false),
                priority_lock: Mutex::new(()),
                priority_changed: Condvar::new(),
                persistence,
                persistence_lock: Mutex::new(()),
                persistence_error: Mutex::new(persistence_error),
            }),
        };
        if manager.persistence_available() {
            manager.persist_best_effort();
        }
        manager
    }

    pub fn submit<F>(
        &self,
        job_type: &str,
        exclusive_inference: bool,
        task: F,
    ) -> Result<Value, JobManagerError>
    where
        F: FnOnce(JobContext) -> Result<Value, JobFailure> + Send + 'static,
    {
        let (job_id, accepted) = self.insert_job(job_type, exclusive_inference, None, None)?;
        self.spawn_once(
            job_id,
            job_type == "media-import",
            exclusive_inference,
            task,
        );
        Ok(accepted)
    }

    pub fn submit_descriptor(
        &self,
        descriptor: JobDescriptor,
        executor: JobExecutor,
    ) -> Result<Value, JobManagerError> {
        let job_type = descriptor.job_type();
        let exclusive = descriptor.exclusive_inference();
        let (job_id, accepted) =
            self.insert_job(job_type, exclusive, Some(descriptor.clone()), None)?;
        self.spawn_descriptor(job_id, descriptor, executor);
        Ok(accepted)
    }

    fn insert_job(
        &self,
        job_type: &str,
        exclusive_inference: bool,
        descriptor: Option<JobDescriptor>,
        parent_job_id: Option<String>,
    ) -> Result<(String, Value), JobManagerError> {
        if self.inner.shutdown_requested.load(Ordering::SeqCst) {
            return Err(JobManagerError::new(
                "JOB_SHUTDOWN_IN_PROGRESS",
                "new local work cannot start while Candor is closing",
            ));
        }
        if descriptor.is_some() {
            self.require_persistence_ready()?;
        }
        let _deletion_guard =
            if let Some(recording_id) = descriptor.as_ref().and_then(JobDescriptor::recording_id) {
                let deleting = self.inner.deleting_recordings.lock().map_err(|_| {
                    JobManagerError::new(
                        "JOB_RECORDING_DELETE_GATE_UNAVAILABLE",
                        "recording deletion coordination is unavailable",
                    )
                })?;
                if deleting.contains(recording_id) {
                    return Err(JobManagerError::new(
                        "JOB_RECORDING_DELETION_IN_PROGRESS",
                        "new local work cannot start for a recording being deleted",
                    ));
                }
                Some(deleting)
            } else {
                None
            };
        let job_id = new_job_id()?;
        let created_at = timestamp();
        let created_at_ms = now_ms();
        let entry = JobEntry {
            job_id: job_id.clone(),
            job_type: job_type.to_string(),
            state: JobState::Queued,
            created_at: created_at.clone(),
            updated_at: created_at.clone(),
            created_at_ms,
            updated_at_ms: created_at_ms,
            started_at_ms: None,
            stage: Some("queued".to_string()),
            progress: None,
            result: None,
            result_persisted: false,
            error: None,
            cancel_requested: false,
            cancellation: Arc::new(AtomicBool::new(false)),
            descriptor,
            exclusive_inference,
            retry_count: 0,
            parent_job_id,
            follow_up_queued: false,
            preempt_requested: false,
            shutdown_pause_requested: false,
        };
        {
            let mut jobs = self.inner.jobs.lock().map_err(|_| {
                JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
            })?;
            if jobs.len() >= MAX_RETAINED_JOBS {
                return Err(JobManagerError::new(
                    "JOB_RETENTION_LIMIT",
                    "completed jobs must be acknowledged before more work can start",
                ));
            }
            jobs.insert(job_id.clone(), entry);
            if self.inner.persistence.is_some() {
                let projected_size = match projected_job_store_size(&jobs) {
                    Ok(size) => size,
                    Err(error) => {
                        jobs.remove(&job_id);
                        return Err(error);
                    }
                };
                if projected_size > MAX_JOB_STORE_BYTES {
                    jobs.remove(&job_id);
                    return Err(job_store_capacity_error());
                }
            }
        }
        if let Err(error) = self.persist() {
            self.inner
                .jobs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&job_id);
            if error.code == "JOB_STORE_TOO_LARGE" {
                return Err(job_store_capacity_error());
            }
            self.remember_persistence_error(error.clone());
            return Err(error);
        }
        self.emit(&job_id);
        Ok((
            job_id.clone(),
            json!({
                "jobId": job_id,
                "type": job_type,
                "state": "queued",
                "createdAt": created_at,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            }),
        ))
    }

    pub fn recover(&self, executor: JobExecutor) {
        let (recoverable, pending_follow_ups) = {
            let jobs = self
                .inner
                .jobs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let recoverable = jobs
                .values()
                .filter(|entry| !entry.state.terminal())
                .filter_map(|entry| {
                    entry
                        .descriptor
                        .clone()
                        .map(|descriptor| (entry.job_id.clone(), descriptor))
                })
                .collect::<Vec<_>>();
            let pending_follow_ups = jobs
                .values()
                .filter(|entry| entry.state == JobState::Completed && !entry.follow_up_queued)
                .filter_map(|entry| {
                    entry
                        .descriptor
                        .as_ref()
                        .and_then(JobDescriptor::follow_up)
                        .map(|descriptor| (entry.job_id.clone(), descriptor))
                })
                .collect::<Vec<_>>();
            (recoverable, pending_follow_ups)
        };
        for (job_id, descriptor) in recoverable {
            self.spawn_descriptor(job_id, descriptor, executor.clone());
        }
        for (parent_job_id, descriptor) in pending_follow_ups {
            let _ = self.submit_follow_up(&parent_job_id, descriptor, executor.clone());
        }
    }

    pub fn get(&self, job_id: &str) -> Result<Value, JobManagerError> {
        validate_job_id(job_id)?;
        let jobs = self.inner.jobs.lock().map_err(|_| {
            JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
        })?;
        jobs.get(job_id)
            .map(|entry| entry.value(true))
            .ok_or_else(|| JobManagerError::new("JOB_NOT_FOUND", "local job was not found"))
    }

    pub fn list(&self) -> Result<Value, JobManagerError> {
        let jobs = self.inner.jobs.lock().map_err(|_| {
            JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
        })?;
        let mut values = jobs
            .values()
            .map(|entry| entry.value(false))
            .collect::<Vec<_>>();
        values.sort_by(|left, right| right["createdAt"].as_str().cmp(&left["createdAt"].as_str()));
        let active_count = jobs
            .values()
            .filter(|entry| !entry.state.terminal())
            .count();
        let persistence_error = self
            .inner
            .persistence_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        Ok(json!({
            "jobs": values,
            "jobCount": values.len(),
            "activeCount": active_count,
            "persistenceState": if self.inner.persistence.is_none() {
                "memory-only"
            } else if persistence_error.is_some() {
                "unavailable"
            } else {
                "encrypted"
            },
            "persistenceFailureCode": persistence_error.map(|error| error.code),
            "encryptedAtRest": self.inner.persistence.is_some(),
            "recordingPriorityActive": self.inner.recording_active.load(Ordering::SeqCst),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn active_summary(&self) -> Result<Value, JobManagerError> {
        let jobs = self.inner.jobs.lock().map_err(|_| {
            JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
        })?;
        let active = jobs
            .values()
            .filter(|entry| !entry.state.terminal())
            .map(|entry| entry.value(false))
            .collect::<Vec<_>>();
        Ok(json!({
            "activeCount": active.len(),
            "jobs": active,
            "rawPathExposed": false
        }))
    }

    pub fn begin_recording_deletion(&self, recording_id: &str) -> Result<Value, JobManagerError> {
        let mut deleting = self.inner.deleting_recordings.lock().map_err(|_| {
            JobManagerError::new(
                "JOB_RECORDING_DELETE_GATE_UNAVAILABLE",
                "recording deletion coordination is unavailable",
            )
        })?;
        if deleting.contains(recording_id) {
            return Ok(json!({
                "recordingId": recording_id,
                "deleteGateActive": true,
                "activeJobCount": 0,
                "rawPathExposed": false
            }));
        }
        let jobs = self.inner.jobs.lock().map_err(|_| {
            JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
        })?;
        let active_job_count = jobs
            .values()
            .filter(|entry| {
                job_entry_recording_id(entry) == Some(recording_id) && !entry.state.terminal()
            })
            .count();
        if active_job_count > 0 {
            return Err(JobManagerError::new(
                "JOB_RECORDING_BUSY",
                "local work for this recording must finish or be cancelled before deletion",
            ));
        }
        drop(jobs);
        deleting.insert(recording_id.to_string());
        Ok(json!({
            "recordingId": recording_id,
            "deleteGateActive": true,
            "activeJobCount": 0,
            "rawPathExposed": false
        }))
    }

    pub fn recover_recording_deletion(&self, recording_id: &str) -> Result<(), JobManagerError> {
        self.inner
            .deleting_recordings
            .lock()
            .map_err(|_| {
                JobManagerError::new(
                    "JOB_RECORDING_DELETE_GATE_UNAVAILABLE",
                    "recording deletion coordination is unavailable",
                )
            })?
            .insert(recording_id.to_string());
        Ok(())
    }

    pub fn purge_recording_jobs(&self, recording_id: &str) -> Result<Value, JobManagerError> {
        let deleting = self.inner.deleting_recordings.lock().map_err(|_| {
            JobManagerError::new(
                "JOB_RECORDING_DELETE_GATE_UNAVAILABLE",
                "recording deletion coordination is unavailable",
            )
        })?;
        if !deleting.contains(recording_id) {
            return Err(JobManagerError::new(
                "JOB_RECORDING_DELETE_GATE_REQUIRED",
                "recording job data cannot be purged outside a deletion transaction",
            ));
        }
        let removed_count = {
            let mut jobs = self.inner.jobs.lock().map_err(|_| {
                JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
            })?;
            let before = jobs.len();
            jobs.retain(|_, entry| job_entry_recording_id(entry) != Some(recording_id));
            before.saturating_sub(jobs.len())
        };
        drop(deleting);
        self.persist_without_prior_state_artifacts()?;
        Ok(json!({
            "recordingId": recording_id,
            "purgedJobCount": removed_count,
            "persisted": self.inner.persistence.is_some(),
            "priorStateArtifactsRemoved": true,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn complete_recording_deletion(&self, recording_id: &str) {
        self.inner
            .deleting_recordings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(recording_id);
    }

    pub fn abort_recording_deletion(&self, recording_id: &str) {
        self.complete_recording_deletion(recording_id);
    }

    pub fn has_active_type(&self, job_type: &str) -> Result<bool, JobManagerError> {
        let jobs = self.inner.jobs.lock().map_err(|_| {
            JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
        })?;
        Ok(jobs
            .values()
            .any(|entry| entry.job_type == job_type && !entry.state.terminal()))
    }

    pub fn cancel(&self, job_id: &str) -> Result<Value, JobManagerError> {
        validate_job_id(job_id)?;
        let result = {
            let mut jobs = self.inner.jobs.lock().map_err(|_| {
                JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
            })?;
            let entry = jobs
                .get_mut(job_id)
                .ok_or_else(|| JobManagerError::new("JOB_NOT_FOUND", "local job was not found"))?;
            if entry.state.terminal() {
                return Ok(json!({
                    "jobId": entry.job_id,
                    "state": entry.state.label(),
                    "cancelRequested": false,
                    "terminal": true,
                    "rawPathExposed": false
                }));
            }
            entry.cancel_requested = true;
            entry.preempt_requested = false;
            entry.state = JobState::Cancelling;
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
            entry.stage = Some("cancelling".to_string());
            entry.cancellation.store(true, Ordering::SeqCst);
            entry.value(false)
        };
        self.persist_best_effort();
        self.inner.priority_changed.notify_all();
        self.emit(job_id);
        Ok(json!({
            "jobId": job_id,
            "state": "cancelling",
            "cancelRequested": true,
            "terminal": false,
            "job": result,
            "rawPathExposed": false
        }))
    }

    pub fn cancel_all(&self) -> Result<Value, JobManagerError> {
        let active_workers = self.inner.workers.lock().map_err(|_| {
            JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
        })?;
        let ids = {
            let mut jobs = self.inner.jobs.lock().map_err(|_| {
                JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
            })?;
            let skipped_count = jobs
                .values()
                .filter(|entry| entry.state == JobState::Cancelling)
                .count();
            let mut ids = Vec::new();
            for entry in jobs.values_mut().filter(|entry| entry.state.cancellable()) {
                entry.cancel_requested = true;
                entry.preempt_requested = false;
                entry.shutdown_pause_requested = false;
                entry.cancellation.store(true, Ordering::SeqCst);
                if active_workers.contains(&entry.job_id) {
                    entry.state = JobState::Cancelling;
                    entry.stage = Some("cancelling".to_string());
                } else {
                    entry.state = JobState::Cancelled;
                    entry.stage = Some("cancelled".to_string());
                }
                entry.updated_at = timestamp();
                entry.updated_at_ms = now_ms();
                ids.push(entry.job_id.clone());
            }
            (ids, skipped_count)
        };
        drop(active_workers);
        self.persist()?;
        self.inner.priority_changed.notify_all();
        for job_id in &ids.0 {
            self.emit(job_id);
        }
        Ok(json!({
            "cancelRequestedCount": ids.0.len(),
            "requestedCount": ids.0.len(),
            "skippedCount": ids.1,
            "rawPathExposed": false
        }))
    }

    pub fn pause_all_for_shutdown(&self) -> Result<Value, JobManagerError> {
        self.inner.shutdown_requested.store(true, Ordering::SeqCst);
        let mut paused = Vec::new();
        {
            let mut jobs = self.inner.jobs.lock().map_err(|_| {
                JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
            })?;
            for entry in jobs.values_mut().filter(|entry| !entry.state.terminal()) {
                entry.updated_at = timestamp();
                entry.updated_at_ms = now_ms();
                if entry.cancel_requested || entry.state == JobState::Cancelling {
                    entry.cancellation.store(true, Ordering::SeqCst);
                    entry.state = JobState::Cancelled;
                    entry.stage = Some("cancelled".to_string());
                } else if entry.descriptor.is_some() {
                    entry.shutdown_pause_requested = true;
                    entry.preempt_requested = true;
                    entry.cancellation.store(true, Ordering::SeqCst);
                    entry.state = JobState::Paused;
                    entry.stage = Some("paused-for-close".to_string());
                    entry.cancel_requested = false;
                } else {
                    entry.cancel_requested = true;
                    entry.cancellation.store(true, Ordering::SeqCst);
                    entry.state = JobState::Cancelling;
                    entry.stage = Some("cancelling-for-close".to_string());
                }
                paused.push(entry.job_id.clone());
            }
        }
        if paused.is_empty() {
            return Ok(json!({
                "pausedCount": 0,
                "restartOnNextLaunch": false,
                "rawPathExposed": false
            }));
        }
        self.persist()?;
        self.inner.priority_changed.notify_all();
        for job_id in &paused {
            self.emit(job_id);
        }
        Ok(json!({
            "pausedCount": paused.len(),
            "restartOnNextLaunch": true,
            "rawPathExposed": false
        }))
    }

    pub fn retry(&self, job_id: &str, executor: JobExecutor) -> Result<Value, JobManagerError> {
        validate_job_id(job_id)?;
        self.require_persistence_ready()?;
        let descriptor = {
            let mut jobs = self.inner.jobs.lock().map_err(|_| {
                JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
            })?;
            let entry = jobs
                .get_mut(job_id)
                .ok_or_else(|| JobManagerError::new("JOB_NOT_FOUND", "local job was not found"))?;
            if entry_has_unresolved_media_import_cleanup(entry) {
                return Err(JobManagerError::new(
                    "MEDIA_IMPORT_CLEANUP_UNRESOLVED",
                    "media import cleanup must be reconciled by recording recovery before this job can be retried",
                ));
            }
            if !matches!(
                entry.state,
                JobState::Failed | JobState::Cancelled | JobState::Paused
            ) {
                return Err(JobManagerError::new(
                    "JOB_NOT_RETRYABLE",
                    "only failed, cancelled, or paused work can be retried",
                ));
            }
            let descriptor = entry.descriptor.clone().ok_or_else(|| {
                JobManagerError::new("JOB_NOT_RETRYABLE", "this local job cannot be restarted")
            })?;
            entry.state = JobState::Queued;
            entry.stage = Some("queued-for-retry".to_string());
            entry.progress = None;
            entry.result = None;
            entry.result_persisted = false;
            entry.error = None;
            entry.cancel_requested = false;
            entry.preempt_requested = false;
            entry.shutdown_pause_requested = false;
            entry.cancellation.store(false, Ordering::SeqCst);
            entry.retry_count = entry.retry_count.saturating_add(1);
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
            descriptor
        };
        self.persist()?;
        self.emit(job_id);
        self.spawn_descriptor(job_id.to_string(), descriptor, executor);
        self.get(job_id)
    }

    pub fn acknowledge(&self, job_id: &str) -> Result<JobAcknowledgement, JobManagerError> {
        validate_job_id(job_id)?;
        let removed = {
            let mut jobs = self.inner.jobs.lock().map_err(|_| {
                JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
            })?;
            let entry = jobs
                .get(job_id)
                .ok_or_else(|| JobManagerError::new("JOB_NOT_FOUND", "local job was not found"))?;
            if !entry.state.terminal() {
                return Err(JobManagerError::new(
                    "JOB_NOT_TERMINAL",
                    "a running local job cannot be acknowledged",
                ));
            }
            if entry_has_unresolved_media_import_cleanup(entry) {
                return Err(JobManagerError::new(
                    "MEDIA_IMPORT_CLEANUP_UNRESOLVED",
                    "media import cleanup must be reconciled by recording recovery before this job can be acknowledged",
                ));
            }
            jobs.remove(job_id).is_some()
        };
        self.persist_best_effort();
        Ok(JobAcknowledgement {
            response: json!({
                "jobId": job_id,
                "acknowledged": removed,
                "rawPathExposed": false
            }),
        })
    }

    pub fn dictionary_staging_references(&self) -> HashSet<String> {
        self.inner
            .jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter_map(|entry| match entry.descriptor.as_ref() {
                Some(JobDescriptor::DictionaryImport { staging_token, .. })
                    if !staging_token.is_empty() =>
                {
                    Some(staging_token.clone())
                }
                _ => None,
            })
            .collect()
    }

    pub fn dictionary_staging_reference(
        &self,
        job_id: &str,
    ) -> Result<Option<String>, JobManagerError> {
        validate_job_id(job_id)?;
        let jobs = self.inner.jobs.lock().map_err(|_| {
            JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
        })?;
        Ok(jobs
            .get(job_id)
            .and_then(|entry| match entry.descriptor.as_ref() {
                Some(JobDescriptor::DictionaryImport { staging_token, .. }) => {
                    Some(staging_token.clone())
                }
                _ => None,
            }))
    }

    pub fn terminal_dictionary_staging_reference(
        &self,
        job_id: &str,
    ) -> Result<Option<String>, JobManagerError> {
        validate_job_id(job_id)?;
        let jobs = self.inner.jobs.lock().map_err(|_| {
            JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
        })?;
        let entry = jobs
            .get(job_id)
            .ok_or_else(|| JobManagerError::new("JOB_NOT_FOUND", "local job was not found"))?;
        if !entry.state.terminal() {
            return Err(JobManagerError::new(
                "JOB_NOT_TERMINAL",
                "a running local job cannot be acknowledged",
            ));
        }
        Ok(match entry.descriptor.as_ref() {
            Some(JobDescriptor::DictionaryImport { staging_token, .. }) => {
                Some(staging_token.clone())
            }
            _ => None,
        })
    }

    pub fn discard_dictionary_staging(&self, job_id: &str) -> Option<String> {
        let token = {
            // Cleanup follows a successful physical delete. Recovering a poisoned
            // mutex here prevents a deleted staging file from retaining a ghost
            // descriptor until the next retention sweep.
            let mut jobs = self
                .inner
                .jobs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let entry = jobs.get_mut(job_id)?;
            match entry.descriptor.take() {
                Some(JobDescriptor::DictionaryImport { staging_token, .. }) => Some(staging_token),
                Some(descriptor) => {
                    entry.descriptor = Some(descriptor);
                    None
                }
                None => None,
            }
        };
        if token.is_some() {
            self.persist_best_effort();
            self.emit(job_id);
        }
        token
    }

    pub fn discard_all_dictionary_staging(&self) -> Vec<String> {
        let (tokens, changed_job_ids) = {
            let mut jobs = self
                .inner
                .jobs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut tokens = Vec::new();
            let mut changed_job_ids = Vec::new();
            for (job_id, entry) in jobs.iter_mut() {
                if let Some(JobDescriptor::DictionaryImport { staging_token, .. }) =
                    entry.descriptor.as_ref()
                {
                    tokens.push(staging_token.clone());
                    entry.descriptor = None;
                    changed_job_ids.push(job_id.clone());
                }
            }
            (tokens, changed_job_ids)
        };
        if !tokens.is_empty() {
            self.persist_best_effort();
            for job_id in changed_job_ids {
                self.emit(&job_id);
            }
        }
        tokens
    }

    pub fn apply_retention(&self) -> Result<Vec<String>, JobManagerError> {
        let now = now_ms();
        let (tokens, changed) = {
            let mut jobs = self.inner.jobs.lock().map_err(|_| {
                JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
            })?;
            let mut tokens = Vec::new();
            let mut changed = false;
            let expired_ids = jobs
                .iter()
                .filter(|(_, entry)| {
                    entry.state.terminal()
                        && !entry_has_unresolved_media_import_cleanup(entry)
                        && now.saturating_sub(entry.updated_at_ms) >= TERMINAL_JOB_RETENTION_MS
                })
                .map(|(job_id, _)| job_id.clone())
                .collect::<Vec<_>>();
            for job_id in expired_ids {
                if let Some(entry) = jobs.remove(&job_id) {
                    if let Some(JobDescriptor::DictionaryImport { staging_token, .. }) =
                        entry.descriptor
                    {
                        tokens.push(staging_token);
                    }
                    changed = true;
                }
            }
            for entry in jobs.values_mut() {
                let lifetime_age = now.saturating_sub(entry.created_at_ms);
                if lifetime_age >= ASK_QUESTION_RETENTION_MS {
                    if let Some(JobDescriptor::Ask { question, .. }) = entry.descriptor.as_mut() {
                        if !question.is_empty() {
                            question.clear();
                            changed = true;
                        }
                    }
                    if let Some(result) = entry.result.as_mut().and_then(Value::as_object_mut) {
                        if result.get("question").is_some_and(|value| !value.is_null()) {
                            result.insert("question".to_string(), Value::Null);
                            changed = true;
                        }
                    }
                }
                let dictionary_cancelled = entry.state == JobState::Cancelled
                    && matches!(
                        entry.descriptor,
                        Some(JobDescriptor::DictionaryImport { .. })
                    );
                if dictionary_cancelled {
                    if let Some(JobDescriptor::DictionaryImport { staging_token, .. }) =
                        entry.descriptor.take()
                    {
                        tokens.push(staging_token);
                        changed = true;
                    }
                    continue;
                }
                let dictionary_expired = lifetime_age >= RETRYABLE_DICTIONARY_STAGING_RETENTION_MS
                    && matches!(entry.state, JobState::Paused | JobState::Failed)
                    && matches!(
                        entry.descriptor,
                        Some(JobDescriptor::DictionaryImport { .. })
                    );
                if dictionary_expired {
                    if let Some(JobDescriptor::DictionaryImport { staging_token, .. }) =
                        entry.descriptor.take()
                    {
                        tokens.push(staging_token);
                    }
                    entry.state = JobState::Failed;
                    entry.stage = Some("staging-expired".to_string());
                    entry.error = Some(job_error_value(
                        &entry.job_id,
                        &entry.job_type,
                        JobFailure::new(
                            "DICTIONARY_STAGING_EXPIRED",
                            "the staged dictionary package expired and must be selected again",
                            false,
                        ),
                    ));
                    entry.updated_at = timestamp();
                    entry.updated_at_ms = now;
                    changed = true;
                }
            }
            (tokens, changed)
        };
        if changed {
            self.persist()?;
        }
        Ok(tokens)
    }

    pub fn set_recording_active(&self, active: bool) {
        self.inner.recording_active.store(active, Ordering::SeqCst);
        if active {
            self.signal_recording_priority();
        } else {
            self.persist_best_effort();
            self.inner.priority_changed.notify_all();
        }
    }

    fn signal_recording_priority(&self) {
        let mut changed = Vec::new();
        let mut jobs = self
            .inner
            .jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for entry in jobs
            .values_mut()
            .filter(|entry| entry.exclusive_inference && !entry.state.terminal())
        {
            if entry.cancel_requested {
                continue;
            }
            entry.preempt_requested = true;
            entry.cancellation.store(true, Ordering::SeqCst);
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
            if matches!(entry.state, JobState::Running | JobState::Cancelling) {
                entry.state = JobState::Cancelling;
                entry.stage = Some("yielding-to-recording".to_string());
            } else if entry.job_type == "media-import" {
                // Media imports are one-shot jobs backed only by the selected source.
                // Once recording wins priority, a queued import must terminate instead
                // of silently resuming after the recording ends.
                finish_entry_cancelled(entry);
            } else {
                entry.state = JobState::Paused;
                entry.stage = Some("recording-priority".to_string());
            }
            changed.push(entry.job_id.clone());
        }
        drop(jobs);
        self.persist_best_effort();
        self.inner.priority_changed.notify_all();
        for job_id in changed {
            self.emit(&job_id);
        }
    }

    /// Acquires recording priority and waits until every preempted media-import
    /// worker has returned with a verified terminal outcome. The returned bool
    /// is true only when this call changed the inactive state to active. Callers
    /// must release priority after a failed capture start only when it is true.
    pub fn begin_recording_priority(
        &self,
        media_import_cleanup_timeout: Duration,
    ) -> Result<bool, JobManagerError> {
        if self
            .inner
            .recording_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(false);
        }
        let targets = match self.media_import_barrier_targets() {
            Ok(targets) => targets,
            Err(error) => {
                self.set_recording_active(false);
                return Err(error);
            }
        };
        self.signal_recording_priority();
        let deadline = Instant::now()
            .checked_add(media_import_cleanup_timeout)
            .unwrap_or_else(Instant::now);
        let result = (|| loop {
            if !self.media_import_target_worker_active(&targets)? {
                self.verify_media_import_barrier_targets(&targets)?;
                return Ok(true);
            }

            let now = Instant::now();
            if now >= deadline {
                return Err(JobManagerError::new(
                        "MEDIA_IMPORT_CLEANUP_TIMEOUT",
                        "recording could not start because a cancelled media import was still cleaning up",
                    ));
            }
            let remaining = deadline.saturating_duration_since(now);
            let guard = self
                .inner
                .priority_lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let _ = self
                .inner
                .priority_changed
                .wait_timeout(guard, remaining.min(Duration::from_millis(25)));
        })();
        if result.is_err() {
            self.set_recording_active(false);
        }
        result
    }

    /// Resolves persistent media-import cleanup failures only after the
    /// recording store completed a full, pathless recovery scan without any
    /// quarantined recordings or pending deletions. The failed job remains as
    /// an audit record, but no longer blocks recording once this proof is
    /// durably stored.
    pub fn resolve_media_import_cleanup_after_recovery(
        &self,
        recovery: &Value,
    ) -> Result<Value, JobManagerError> {
        let recovery_object = recovery.as_object().ok_or_else(|| {
            JobManagerError::new(
                "MEDIA_IMPORT_RECOVERY_PROOF_INVALID",
                "recording recovery did not return a valid cleanup proof",
            )
        })?;
        let recovered_count = recovery_object
            .get("recoveredCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                JobManagerError::new(
                    "MEDIA_IMPORT_RECOVERY_PROOF_INVALID",
                    "recording recovery omitted its recovered recording count",
                )
            })?;
        let quarantined_count = recovery_object
            .get("quarantinedCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                JobManagerError::new(
                    "MEDIA_IMPORT_RECOVERY_PROOF_INVALID",
                    "recording recovery omitted its quarantined recording count",
                )
            })?;
        let pending_deletion_count = recovery_object
            .get("pendingDeletionCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                JobManagerError::new(
                    "MEDIA_IMPORT_RECOVERY_PROOF_INVALID",
                    "recording recovery omitted its pending deletion count",
                )
            })?;
        if recovery_object
            .get("rawPathExposed")
            .and_then(Value::as_bool)
            != Some(false)
        {
            return Err(JobManagerError::new(
                "MEDIA_IMPORT_RECOVERY_PROOF_INVALID",
                "recording recovery did not provide a pathless cleanup proof",
            ));
        }

        if quarantined_count != 0 || pending_deletion_count != 0 {
            return Ok(json!({
                "resolved": false,
                "resolvedCount": 0,
                "recoveredCount": recovered_count,
                "quarantinedCount": quarantined_count,
                "pendingDeletionCount": pending_deletion_count,
                "resolution": "recording-store-recovery-incomplete",
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            }));
        }

        let _write_guard = if self.inner.persistence.is_some() {
            Some(self.inner.persistence_lock.lock().map_err(|_| {
                JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job storage is unavailable")
            })?)
        } else {
            None
        };
        let mut jobs = self.inner.jobs.lock().map_err(|_| {
            JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
        })?;
        let resolved_at = timestamp();
        let resolved_at_ms = now_ms();
        let mut prior_values = Vec::new();
        for (job_id, entry) in jobs.iter_mut() {
            if !entry_has_unresolved_media_import_cleanup(entry) {
                continue;
            }
            let Some(error) = entry.error.as_mut().and_then(Value::as_object_mut) else {
                continue;
            };
            prior_values.push((
                job_id.clone(),
                Value::Object(error.clone()),
                entry.updated_at.clone(),
                entry.updated_at_ms,
            ));
            error.insert("cleanupResolved".to_string(), json!(true));
            error.insert(
                "cleanupResolution".to_string(),
                json!("recording-store-recovery"),
            );
            entry.updated_at = resolved_at.clone();
            entry.updated_at_ms = resolved_at_ms;
        }
        let resolved_job_ids = prior_values
            .iter()
            .map(|(job_id, _, _, _)| job_id.clone())
            .collect::<HashSet<_>>();

        if resolved_job_ids.is_empty() {
            drop(jobs);
            drop(_write_guard);
            return Ok(json!({
                "resolved": true,
                "resolvedCount": 0,
                "recoveredCount": recovered_count,
                "quarantinedCount": 0,
                "pendingDeletionCount": 0,
                "resolution": "recording-store-recovery",
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            }));
        }

        if let Some(config) = self.inner.persistence.as_ref() {
            let document = JobStoreDocument {
                schema_version: JOB_STORE_SCHEMA_VERSION,
                jobs: jobs.values().map(JobEntry::persisted).collect(),
            };
            if let Err(error) = write_job_document(config, &document) {
                let durable_resolution = read_job_document(config).is_ok_and(|persisted| {
                    resolved_job_ids.iter().all(|job_id| {
                        persisted.jobs.iter().any(|entry| {
                            entry.job_id == *job_id
                                && entry
                                    .error
                                    .as_ref()
                                    .and_then(|error| error.get("cleanupResolved"))
                                    .and_then(Value::as_bool)
                                    == Some(true)
                        })
                    })
                });
                if !durable_resolution {
                    for (job_id, error, updated_at, updated_at_ms) in &prior_values {
                        if let Some(entry) = jobs.get_mut(job_id) {
                            entry.error = Some(error.clone());
                            entry.updated_at = updated_at.clone();
                            entry.updated_at_ms = *updated_at_ms;
                        }
                    }
                    drop(jobs);
                    drop(_write_guard);
                    self.remember_persistence_error(error.clone());
                    return Err(error);
                }
            }
        }
        drop(jobs);
        drop(_write_guard);

        if self.inner.persistence.is_some() {
            *self
                .inner
                .persistence_error
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        }

        for job_id in &resolved_job_ids {
            self.emit(job_id);
        }
        self.inner.priority_changed.notify_all();
        Ok(json!({
            "resolved": true,
            "resolvedCount": resolved_job_ids.len(),
            "recoveredCount": recovered_count,
            "quarantinedCount": 0,
            "pendingDeletionCount": 0,
            "resolution": "recording-store-recovery",
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    fn media_import_barrier_targets(&self) -> Result<HashSet<String>, JobManagerError> {
        let jobs = self.inner.jobs.lock().map_err(|_| {
            JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
        })?;
        Ok(jobs
            .values()
            .filter(|entry| {
                entry.job_type == "media-import"
                    && (!entry.state.terminal() || entry_has_unresolved_media_import_cleanup(entry))
            })
            .map(|entry| entry.job_id.clone())
            .collect())
    }

    fn media_import_target_worker_active(
        &self,
        targets: &HashSet<String>,
    ) -> Result<bool, JobManagerError> {
        let workers = self.inner.workers.lock().map_err(|_| {
            JobManagerError::new(
                "JOB_STORE_UNAVAILABLE",
                "local job worker coordination is unavailable",
            )
        })?;
        Ok(targets.iter().any(|job_id| workers.contains(job_id)))
    }

    fn verify_media_import_barrier_targets(
        &self,
        targets: &HashSet<String>,
    ) -> Result<(), JobManagerError> {
        let jobs = self.inner.jobs.lock().map_err(|_| {
            JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
        })?;
        for job_id in targets {
            let Some(entry) = jobs.get(job_id) else {
                return Err(JobManagerError::new(
                    "MEDIA_IMPORT_CLEANUP_UNCONFIRMED",
                    "recording could not start because media import cleanup could not be confirmed",
                ));
            };
            match entry.state {
                JobState::Completed | JobState::Cancelled => {}
                JobState::Failed => {
                    let code = entry
                        .error
                        .as_ref()
                        .and_then(|error| error.get("code"))
                        .and_then(Value::as_str)
                        .unwrap_or("MEDIA_IMPORT_CLEANUP_UNCONFIRMED");
                    let message = entry
                        .error
                        .as_ref()
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("media import cleanup failed before recording could start");
                    return Err(match code {
                        "MEDIA_IMPORT_CLEANUP_FAILED" => {
                            JobManagerError::new("MEDIA_IMPORT_CLEANUP_FAILED", message)
                        }
                        "MEDIA_IMPORT_WORKER_PANIC" => {
                            JobManagerError::new("MEDIA_IMPORT_WORKER_PANIC", message)
                        }
                        _ => JobManagerError::new(
                            "MEDIA_IMPORT_CLEANUP_UNCONFIRMED",
                            format!("media import ended with {code} before recording could start"),
                        ),
                    });
                }
                JobState::Queued | JobState::Running | JobState::Paused | JobState::Cancelling => {
                    return Err(JobManagerError::new(
                        "MEDIA_IMPORT_CLEANUP_UNCONFIRMED",
                        "recording could not start because media import cleanup did not reach a terminal state",
                    ));
                }
            }
        }
        Ok(())
    }

    fn spawn_once<F>(&self, job_id: String, media_import: bool, exclusive_inference: bool, task: F)
    where
        F: FnOnce(JobContext) -> Result<Value, JobFailure> + Send + 'static,
    {
        if !self.claim_worker(&job_id) {
            return;
        }
        let manager = self.clone();
        thread::spawn(move || {
            let _worker_registration = WorkerRegistration::new(manager.clone(), job_id.clone());
            let execution = catch_unwind(AssertUnwindSafe(|| {
                let gate = manager.wait_for_priority(&job_id, exclusive_inference);
                if !matches!(gate, WorkerGate::Ready) {
                    if matches!(gate, WorkerGate::Cancelled) {
                        manager.finish_cancelled(&job_id);
                    }
                    return;
                }
                let Some(context) = manager.context(&job_id) else {
                    return;
                };
                let result = if exclusive_inference {
                    match manager.inner.inference_gate.lock() {
                        Ok(_guard) => {
                            if manager.inner.recording_active.load(Ordering::SeqCst) {
                                Err(JobFailure::new(
                                    "RECORDING_PRIORITY",
                                    "local work yielded to an active recording",
                                    true,
                                ))
                            } else {
                                if manager.set_running(&job_id) {
                                    task(context.clone())
                                } else {
                                    Err(JobFailure::new(
                                        "JOB_CANCELLED",
                                        "local work was cancelled before it started",
                                        false,
                                    ))
                                }
                            }
                        }
                        Err(_) => Err(JobFailure::new(
                            "LOCAL_MODEL_SCHEDULER_UNAVAILABLE",
                            "local model scheduling is unavailable",
                            true,
                        )),
                    }
                } else {
                    if manager.set_running(&job_id) {
                        task(context.clone())
                    } else {
                        Err(JobFailure::new(
                            "JOB_CANCELLED",
                            "local work was cancelled before it started",
                            false,
                        ))
                    }
                };

                if media_import && media_import_result_committed(&result) {
                    if let Ok(value) = result {
                        manager.finish_committed_media_import(&job_id, value);
                    }
                } else if media_import && media_import_result_requires_recovery(&result) {
                    if let Err(error) = result {
                        manager.finish_failed_after_preemption(&job_id, error);
                    }
                } else if media_import && manager.preempt_requested(&job_id) {
                    manager.finish_preempted_media_import(&job_id, result);
                } else if manager.user_cancel_requested(&job_id) || context.cancelled() {
                    if manager.preempt_requested(&job_id) {
                        manager.finish_failed(
                            &job_id,
                            JobFailure::new(
                                "RECORDING_PRIORITY",
                                "local work yielded to an active recording",
                                true,
                            ),
                        );
                    } else {
                        manager.finish_cancelled(&job_id);
                    }
                } else {
                    match result {
                        Ok(value) => {
                            manager.finish_completed(&job_id, value);
                        }
                        Err(error) => manager.finish_failed(&job_id, error),
                    }
                }
            }));
            if execution.is_err() {
                manager.finish_worker_panicked(&job_id, media_import);
            }
        });
    }

    fn spawn_descriptor(&self, job_id: String, descriptor: JobDescriptor, executor: JobExecutor) {
        if !self.claim_worker(&job_id) {
            return;
        }
        let manager = self.clone();
        thread::spawn(move || {
            loop {
                match manager.wait_for_priority(&job_id, descriptor.exclusive_inference()) {
                    WorkerGate::Cancelled => {
                        manager.finish_cancelled(&job_id);
                        break;
                    }
                    WorkerGate::PausedForShutdown => break,
                    WorkerGate::Ready => {}
                }
                let Some(context) = manager.context(&job_id) else {
                    break;
                };
                let result = if descriptor.exclusive_inference() {
                    match manager.inner.inference_gate.lock() {
                        Ok(_guard) => {
                            if manager.inner.recording_active.load(Ordering::SeqCst) {
                                Err(JobFailure::new(
                                    "RECORDING_PRIORITY",
                                    "local work yielded to an active recording",
                                    true,
                                ))
                            } else {
                                if manager.set_running(&job_id) {
                                    executor(descriptor.clone(), context.clone())
                                } else {
                                    Err(JobFailure::new(
                                        "JOB_CANCELLED",
                                        "local work was cancelled before it started",
                                        false,
                                    ))
                                }
                            }
                        }
                        Err(_) => Err(JobFailure::new(
                            "LOCAL_MODEL_SCHEDULER_UNAVAILABLE",
                            "local model scheduling is unavailable",
                            true,
                        )),
                    }
                } else {
                    if manager.set_running(&job_id) {
                        executor(descriptor.clone(), context.clone())
                    } else {
                        Err(JobFailure::new(
                            "JOB_CANCELLED",
                            "local work was cancelled before it started",
                            false,
                        ))
                    }
                };

                if manager.user_cancel_requested(&job_id) {
                    manager.finish_cancelled(&job_id);
                    break;
                }
                if manager.shutdown_pause_requested(&job_id) {
                    manager.set_paused(&job_id, "paused-for-close");
                    break;
                }
                if result.is_err() && manager.preempt_requested(&job_id) {
                    manager.set_paused(&job_id, "recording-priority");
                    continue;
                }
                match result {
                    Ok(value) => {
                        if manager.finish_completed(&job_id, value) {
                            if let Some(follow_up) = descriptor.follow_up() {
                                let _ =
                                    manager.submit_follow_up(&job_id, follow_up, executor.clone());
                            }
                        }
                    }
                    Err(error) => manager.finish_failed(&job_id, error),
                }
                break;
            }
            manager.release_worker(&job_id);
        });
    }

    fn submit_follow_up(
        &self,
        parent_job_id: &str,
        descriptor: JobDescriptor,
        executor: JobExecutor,
    ) -> Result<Value, JobManagerError> {
        let existing = {
            let jobs = self.inner.jobs.lock().map_err(|_| {
                JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
            })?;
            jobs.values()
                .find(|entry| entry.parent_job_id.as_deref() == Some(parent_job_id))
                .map(|entry| entry.value(false))
        };
        if let Some(existing) = existing {
            self.mark_follow_up_queued(parent_job_id);
            return Ok(existing);
        }
        let job_type = descriptor.job_type();
        let exclusive = descriptor.exclusive_inference();
        let (job_id, accepted) = self.insert_job(
            job_type,
            exclusive,
            Some(descriptor.clone()),
            Some(parent_job_id.to_string()),
        )?;
        self.mark_follow_up_queued(parent_job_id);
        self.spawn_descriptor(job_id, descriptor, executor);
        Ok(accepted)
    }

    fn mark_follow_up_queued(&self, parent_job_id: &str) {
        self.mutate(parent_job_id, |entry| {
            entry.follow_up_queued = true;
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
        });
    }

    fn wait_for_priority(&self, job_id: &str, exclusive_inference: bool) -> WorkerGate {
        loop {
            let wait_reason = {
                let jobs = self
                    .inner
                    .jobs
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let Some(entry) = jobs.get(job_id) else {
                    return WorkerGate::Cancelled;
                };
                if entry.cancel_requested {
                    return WorkerGate::Cancelled;
                }
                if entry.shutdown_pause_requested
                    || self.inner.shutdown_requested.load(Ordering::SeqCst)
                {
                    return WorkerGate::PausedForShutdown;
                }
                if exclusive_inference && self.inner.recording_active.load(Ordering::SeqCst) {
                    Some("recording-priority")
                } else if exclusive_inference {
                    let current_priority = entry.scheduling_priority();
                    let current_created_at = entry.created_at_ms;
                    let blocked = jobs.values().any(|other| {
                        if other.job_id == job_id
                            || !other.exclusive_inference
                            || other.state.terminal()
                            || other.cancel_requested
                            || other.shutdown_pause_requested
                        {
                            return false;
                        }
                        let other_priority = other.scheduling_priority();
                        other_priority > current_priority
                            || (other_priority == current_priority
                                && (other.created_at_ms < current_created_at
                                    || (other.created_at_ms == current_created_at
                                        && other.job_id < entry.job_id)))
                    });
                    blocked.then_some("waiting-for-higher-priority-work")
                } else {
                    None
                }
            };
            if wait_reason.is_none() {
                self.mutate(job_id, |entry| {
                    if entry.state.terminal()
                        || entry.cancel_requested
                        || entry.shutdown_pause_requested
                    {
                        return;
                    }
                    if entry.state == JobState::Paused {
                        entry.state = JobState::Queued;
                        entry.stage = Some("queued".to_string());
                    }
                    entry.preempt_requested = false;
                    entry.cancellation.store(false, Ordering::SeqCst);
                    entry.updated_at = timestamp();
                    entry.updated_at_ms = now_ms();
                });
                return WorkerGate::Ready;
            }
            if wait_reason == Some("recording-priority") {
                self.set_paused(job_id, "recording-priority");
            } else {
                self.set_queued(job_id, "waiting-for-higher-priority-work");
            }
            let guard = self
                .inner
                .priority_lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let _ = self
                .inner
                .priority_changed
                .wait_timeout(guard, Duration::from_millis(100));
        }
    }

    fn context(&self, job_id: &str) -> Option<JobContext> {
        let jobs = self
            .inner
            .jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        jobs.get(job_id).map(|entry| JobContext {
            manager: self.clone(),
            job_id: job_id.to_string(),
            cancellation: entry.cancellation.clone(),
        })
    }

    fn set_running(&self, job_id: &str) -> bool {
        let changed = {
            let mut jobs = self
                .inner
                .jobs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some(entry) = jobs.get_mut(job_id) else {
                return false;
            };
            if entry.state.terminal() || entry.cancel_requested || entry.shutdown_pause_requested {
                return false;
            }
            entry.state = JobState::Running;
            entry.stage = Some("starting".to_string());
            entry.started_at_ms = Some(now_ms());
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
            true
        };
        if changed {
            self.persist_best_effort();
            self.emit(job_id);
            self.inner.priority_changed.notify_all();
        }
        changed
    }

    fn set_queued(&self, job_id: &str, stage: &str) {
        self.mutate(job_id, |entry| {
            if entry.state.terminal() || entry.cancel_requested {
                return;
            }
            entry.state = JobState::Queued;
            entry.stage = Some(stage.to_string());
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
        });
    }

    fn set_paused(&self, job_id: &str, stage: &str) {
        self.mutate(job_id, |entry| {
            if entry.state.terminal() || entry.cancel_requested {
                return;
            }
            entry.state = JobState::Paused;
            entry.stage = Some(stage.to_string());
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
        });
    }

    fn update_progress(&self, job_id: &str, stage: &str, progress: JobProgress) {
        self.mutate(job_id, |entry| {
            entry.stage = Some(stage.to_string());
            entry.progress = Some(progress);
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
        });
    }

    fn finish_completed(&self, job_id: &str, result: Value) -> bool {
        let mut completed = false;
        self.mutate(job_id, |entry| {
            if entry.cancel_requested
                || matches!(entry.state, JobState::Cancelling | JobState::Cancelled)
            {
                finish_entry_cancelled(entry);
                return;
            }
            entry.state = JobState::Completed;
            entry.stage = Some("completed".to_string());
            entry.progress = Some(JobProgress {
                completed: 100,
                total: Some(100),
                unit: Some("percent".to_string()),
            });
            entry.result = Some(result);
            if matches!(
                entry.descriptor,
                Some(JobDescriptor::DictionaryImport { .. })
            ) {
                entry.descriptor = None;
            }
            entry.error = None;
            entry.cancel_requested = false;
            entry.preempt_requested = false;
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
            completed = true;
        });
        completed
    }

    fn finish_committed_media_import(&self, job_id: &str, result: Value) {
        self.mutate(job_id, |entry| {
            if entry.state == JobState::Completed {
                return;
            }
            entry.state = JobState::Completed;
            entry.stage = Some("completed".to_string());
            entry.progress = Some(JobProgress {
                completed: 100,
                total: Some(100),
                unit: Some("percent".to_string()),
            });
            entry.result = Some(result);
            entry.error = None;
            entry.cancel_requested = false;
            entry.preempt_requested = false;
            entry.shutdown_pause_requested = false;
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
        });
    }

    fn finish_preempted_media_import(&self, job_id: &str, result: Result<Value, JobFailure>) {
        match result {
            Ok(_) => self.finish_cancelled(job_id),
            Err(error)
                if matches!(
                    error.code,
                    "MEDIA_IMPORT_CANCELLED" | "RECORDING_PRIORITY" | "JOB_CANCELLED"
                ) =>
            {
                self.finish_cancelled(job_id)
            }
            Err(error) => self.finish_failed_after_preemption(job_id, error),
        }
    }

    fn finish_worker_panicked(&self, job_id: &str, media_import: bool) {
        let failure = JobFailure::new(
            if media_import {
                "MEDIA_IMPORT_WORKER_PANIC"
            } else {
                "JOB_WORKER_PANIC"
            },
            if media_import {
                "media import stopped unexpectedly before cleanup could be confirmed"
            } else {
                "local work stopped unexpectedly"
            },
            false,
        );
        if media_import {
            self.finish_failed_after_preemption(job_id, failure);
        } else {
            self.finish_failed(job_id, failure);
        }
    }

    fn finish_failed_after_preemption(&self, job_id: &str, failure: JobFailure) {
        self.mutate(job_id, |entry| {
            if entry.state == JobState::Completed {
                return;
            }
            entry.state = JobState::Failed;
            entry.stage = Some("failed".to_string());
            entry.result = None;
            entry.result_persisted = false;
            entry.error = Some(job_error_value(
                &entry.job_id,
                &entry.job_type,
                JobFailure {
                    retryable: false,
                    ..failure
                },
            ));
            entry.cancel_requested = false;
            entry.preempt_requested = false;
            entry.shutdown_pause_requested = false;
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
        });
    }

    fn finish_failed(&self, job_id: &str, failure: JobFailure) {
        self.mutate(job_id, |entry| {
            if entry.cancel_requested
                || matches!(entry.state, JobState::Cancelling | JobState::Cancelled)
            {
                finish_entry_cancelled(entry);
                return;
            }
            entry.state = JobState::Failed;
            entry.stage = Some("failed".to_string());
            let retryable = failure.retryable && entry.descriptor.is_some();
            let failure = JobFailure {
                retryable,
                ..failure
            };
            entry.error = Some(job_error_value(&entry.job_id, &entry.job_type, failure));
            if !retryable
                && matches!(
                    entry.descriptor,
                    Some(JobDescriptor::DictionaryImport { .. })
                )
            {
                entry.descriptor = None;
            }
            entry.cancel_requested = false;
            entry.preempt_requested = false;
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
        });
    }

    fn finish_cancelled(&self, job_id: &str) {
        self.mutate(job_id, |entry| {
            finish_entry_cancelled(entry);
        });
    }

    fn mutate(&self, job_id: &str, update: impl FnOnce(&mut JobEntry)) {
        let changed = {
            let mut jobs = self
                .inner
                .jobs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(entry) = jobs.get_mut(job_id) {
                update(entry);
                true
            } else {
                false
            }
        };
        if changed {
            self.persist_best_effort();
            self.emit(job_id);
            self.inner.priority_changed.notify_all();
        }
    }

    fn user_cancel_requested(&self, job_id: &str) -> bool {
        self.inner
            .jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(job_id)
            .is_some_and(|entry| entry.cancel_requested)
    }

    fn preempt_requested(&self, job_id: &str) -> bool {
        self.inner
            .jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(job_id)
            .is_some_and(|entry| entry.preempt_requested)
    }

    fn shutdown_pause_requested(&self, job_id: &str) -> bool {
        self.inner
            .jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(job_id)
            .is_some_and(|entry| entry.shutdown_pause_requested)
    }

    fn claim_worker(&self, job_id: &str) -> bool {
        self.inner
            .workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(job_id.to_string())
    }

    fn release_worker(&self, job_id: &str) {
        self.inner
            .workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(job_id);
        self.inner.priority_changed.notify_all();
    }

    fn emit(&self, job_id: &str) {
        let jobs = self
            .inner
            .jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let payload = jobs.get(job_id).map(|entry| entry.value(false));
        drop(jobs);
        if let Some(payload) = payload {
            crate::write_protocol_value(&CoreEvent {
                protocol_version: self.inner.protocol_version,
                event: "jobs.changed",
                payload,
            });
        }
    }

    fn persistence_available(&self) -> bool {
        self.inner
            .persistence_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_none()
    }

    fn require_persistence_ready(&self) -> Result<(), JobManagerError> {
        if self.inner.persistence.is_none() {
            return Ok(());
        }
        if let Some(error) = self
            .inner
            .persistence_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            return Err(error);
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), JobManagerError> {
        self.persist_internal(false)
    }

    fn persist_without_prior_state_artifacts(&self) -> Result<(), JobManagerError> {
        self.persist_internal(true)
    }

    fn persist_internal(&self, remove_prior_state_artifacts: bool) -> Result<(), JobManagerError> {
        let Some(config) = self.inner.persistence.as_ref() else {
            return Ok(());
        };
        let _write_guard = self.inner.persistence_lock.lock().map_err(|_| {
            JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job storage is unavailable")
        })?;
        let document = {
            let jobs = self.inner.jobs.lock().map_err(|_| {
                JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
            })?;
            JobStoreDocument {
                schema_version: JOB_STORE_SCHEMA_VERSION,
                jobs: jobs.values().map(JobEntry::persisted).collect(),
            }
        };
        write_job_document(config, &document)?;
        if remove_prior_state_artifacts {
            remove_job_prior_state_artifacts(config)?;
        }
        Ok(())
    }

    fn persist_best_effort(&self) {
        match self.persist() {
            Ok(()) => {
                *self
                    .inner
                    .persistence_error
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            }
            Err(error) => self.remember_persistence_error(error),
        }
    }

    fn remember_persistence_error(&self, error: JobManagerError) {
        *self
            .inner
            .persistence_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error);
    }
}

fn media_import_result_committed(result: &Result<Value, JobFailure>) -> bool {
    result.as_ref().is_ok_and(|value| {
        value
            .get("imported")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    })
}

fn media_import_failure_requires_recovery(code: &str) -> bool {
    code == "MEDIA_IMPORT_WORKER_PANIC"
        || (code.starts_with("MEDIA_IMPORT_")
            && (code.contains("CLEANUP") || code.contains("ROLLBACK")))
}

fn media_import_result_requires_recovery(result: &Result<Value, JobFailure>) -> bool {
    result
        .as_ref()
        .err()
        .is_some_and(|failure| media_import_failure_requires_recovery(failure.code))
}

fn entry_has_unresolved_media_import_cleanup(entry: &JobEntry) -> bool {
    if entry.job_type != "media-import" || entry.state != JobState::Failed {
        return false;
    }
    let Some(error) = entry.error.as_ref() else {
        return false;
    };
    let resolved = error
        .get("cleanupResolved")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    !resolved
        && error
            .get("code")
            .and_then(Value::as_str)
            .is_some_and(media_import_failure_requires_recovery)
}

fn finish_entry_cancelled(entry: &mut JobEntry) {
    entry.state = JobState::Cancelled;
    entry.stage = Some("cancelled".to_string());
    entry.result = None;
    entry.result_persisted = false;
    entry.error = None;
    entry.cancel_requested = true;
    entry.preempt_requested = false;
    entry.shutdown_pause_requested = false;
    entry.updated_at = timestamp();
    entry.updated_at_ms = now_ms();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreEvent<'a> {
    protocol_version: &'static str,
    event: &'a str,
    payload: Value,
}

fn job_error_value(job_id: &str, job_type: &str, failure: JobFailure) -> Value {
    json!({
        "code": failure.code,
        "title": "Local operation failed",
        "message": safe_failure_message(job_type, &failure.message),
        "retryable": failure.retryable,
        "severity": "error",
        "correlationId": job_id,
        "rawPathExposed": false
    })
}

fn bounded_persisted_result(result: Option<&Value>) -> (Option<Value>, bool) {
    let Some(result) = result else {
        return (None, false);
    };
    match serde_json::to_vec(result) {
        Ok(bytes) if bytes.len() <= MAX_PERSISTED_RESULT_BYTES => (Some(result.clone()), true),
        _ => (None, false),
    }
}

fn projected_job_store_size(jobs: &HashMap<String, JobEntry>) -> Result<u64, JobManagerError> {
    let document = JobStoreDocument {
        schema_version: JOB_STORE_SCHEMA_VERSION,
        jobs: jobs.values().map(JobEntry::persisted).collect(),
    };
    serde_json::to_vec(&document)
        .map(|bytes| bytes.len() as u64)
        .map_err(|_| {
            JobManagerError::new(
                "JOB_STORE_WRITE_FAILED",
                "local job state could not be encoded",
            )
        })
}

fn job_store_capacity_error() -> JobManagerError {
    JobManagerError::new(
        "JOB_STORE_CAPACITY",
        "finish or dismiss background work before starting another local job",
    )
}

fn prepare_job_document(
    config: &JobPersistence,
    mut document: JobStoreDocument,
    staging: Option<&DictionaryStaging>,
) -> Result<JobStoreDocument, JobManagerError> {
    if document.schema_version == JOB_STORE_SCHEMA_VERSION {
        validate_current_job_document(&document, staging)?;
        let migration_backup = config.root.join(JOB_STORE_MIGRATION_BACKUP_FILE);
        if migration_backup.exists() {
            let _ = fs::remove_file(migration_backup);
        }
        return Ok(document);
    }
    if document.schema_version != 1 {
        return Err(JobManagerError::new(
            "JOB_STORE_SCHEMA_UNSUPPORTED",
            "local job state uses an unsupported schema",
        ));
    }
    let staging = staging.ok_or_else(|| {
        JobManagerError::new(
            "JOB_STORE_MIGRATION_REQUIRED",
            "local background tasks require secure dictionary staging migration",
        )
    })?;
    let target = config.root.join(JOB_STORE_FILE);
    let migration_backup = config.root.join(JOB_STORE_MIGRATION_BACKUP_FILE);
    let _ = fs::remove_file(&migration_backup);
    fs::copy(&target, &migration_backup).map_err(|_| {
        JobManagerError::new(
            "JOB_STORE_MIGRATION_BACKUP_FAILED",
            "local background task migration could not create a rollback backup",
        )
    })?;

    let mut staged_tokens = Vec::new();
    let migration_result = (|| {
        for entry in &mut document.jobs {
            if let Some(descriptor) = entry.descriptor.as_mut() {
                migrate_descriptor(descriptor, staging, false, &mut staged_tokens)?;
            }
        }
        document.schema_version = JOB_STORE_SCHEMA_VERSION;
        write_job_document(config, &document)?;
        let verified = read_job_document(config)?;
        if verified.schema_version != JOB_STORE_SCHEMA_VERSION {
            return Err(JobManagerError::new(
                "JOB_STORE_MIGRATION_VERIFY_FAILED",
                "local background task migration did not verify",
            ));
        }
        validate_current_job_document(&verified, Some(staging))?;
        Ok(verified)
    })();

    match migration_result {
        Ok(verified) => Ok(verified),
        Err(error) => {
            for token in staged_tokens {
                let _ = staging.delete(&token);
            }
            let _ = fs::remove_file(&target);
            if fs::rename(&migration_backup, &target).is_err() {
                return Err(JobManagerError::new(
                    "JOB_STORE_MIGRATION_ROLLBACK_FAILED",
                    "local background task migration failed and its rollback could not be restored",
                ));
            }
            Err(error)
        }
    }
}

fn validate_current_job_document(
    document: &JobStoreDocument,
    staging: Option<&DictionaryStaging>,
) -> Result<(), JobManagerError> {
    for entry in &document.jobs {
        if let Some(descriptor) = entry.descriptor.as_ref() {
            validate_current_descriptor(descriptor, staging)?;
        }
    }
    Ok(())
}

fn validate_current_descriptor(
    descriptor: &JobDescriptor,
    staging: Option<&DictionaryStaging>,
) -> Result<(), JobManagerError> {
    match descriptor {
        JobDescriptor::Transcription { follow_up, .. } => {
            if let Some(follow_up) = follow_up.as_deref() {
                validate_current_descriptor(follow_up, staging)?;
            }
        }
        JobDescriptor::DictionaryImport {
            staging_token,
            expected_sha256,
            original_display_name,
            bytes,
            legacy_source_file_name,
            legacy_archive_base64,
        } => {
            if legacy_source_file_name.is_some() || legacy_archive_base64.is_some() {
                return Err(JobManagerError::new(
                    "JOB_STORE_LEGACY_DICTIONARY_DATA_REJECTED",
                    "current local background task state contained a legacy dictionary archive",
                ));
            }
            let staging = staging.ok_or_else(|| {
                JobManagerError::new(
                    "JOB_STORE_DICTIONARY_STAGING_UNAVAILABLE",
                    "secure dictionary staging is required by saved background work",
                )
            })?;
            staging
                .validate_descriptor(
                    staging_token,
                    expected_sha256,
                    *bytes,
                    original_display_name,
                )
                .map_err(|_| {
                    JobManagerError::new(
                        "JOB_STORE_DICTIONARY_DESCRIPTOR_INVALID",
                        "saved dictionary staging metadata is invalid",
                    )
                })?;
        }
        JobDescriptor::Recap { recap_template, .. } => {
            if recap_template.as_ref().is_some_and(|template| {
                template.is_empty()
                    || template.len() > 4_096
                    || template.chars().any(|character| {
                        character == '\0'
                            || (character.is_control()
                                && character != '\n'
                                && character != '\r'
                                && character != '\t')
                    })
            }) {
                return Err(JobManagerError::new(
                    "JOB_STORE_RECAP_TEMPLATE_INVALID",
                    "saved recap template metadata is invalid",
                ));
            }
        }
        JobDescriptor::Cleanup { .. }
        | JobDescriptor::Ask { .. }
        | JobDescriptor::Export { .. }
        | JobDescriptor::DictionaryIndex { .. } => {}
    }
    Ok(())
}

fn migrate_descriptor(
    descriptor: &mut JobDescriptor,
    staging: &DictionaryStaging,
    is_follow_up: bool,
    staged_tokens: &mut Vec<String>,
) -> Result<(), JobManagerError> {
    match descriptor {
        JobDescriptor::Transcription { follow_up, .. }
        | JobDescriptor::Cleanup { follow_up, .. } => {
            if let Some(follow_up) = follow_up.as_deref_mut() {
                migrate_descriptor(follow_up, staging, true, staged_tokens)?;
            }
        }
        JobDescriptor::Recap {
            mode,
            fallback_policy,
            legacy_quality,
            ..
        } => {
            if let Some(quality) = legacy_quality.take() {
                *mode = match (quality, is_follow_up) {
                    (LegacyJobQuality::Fast, false) => AiExecutionMode::HeuristicFallback,
                    _ => AiExecutionMode::LocalLlm,
                };
                *fallback_policy = AiFallbackPolicy::AllowDisclosed;
            }
        }
        JobDescriptor::Ask {
            mode,
            fallback_policy,
            legacy_quality,
            ..
        } => {
            if let Some(quality) = legacy_quality.take() {
                *mode = match quality {
                    LegacyJobQuality::Fast => AiExecutionMode::HeuristicFallback,
                    LegacyJobQuality::Best => AiExecutionMode::LocalLlm,
                };
                *fallback_policy = AiFallbackPolicy::AllowDisclosed;
            }
        }
        JobDescriptor::DictionaryImport {
            staging_token,
            expected_sha256,
            original_display_name,
            bytes,
            legacy_source_file_name,
            legacy_archive_base64,
        } => {
            if staging_token.is_empty() {
                let display_name = legacy_source_file_name.take().ok_or_else(|| {
                    JobManagerError::new(
                        "JOB_STORE_MIGRATION_INVALID",
                        "a queued dictionary import omitted its display name",
                    )
                })?;
                let archive = legacy_archive_base64.take().ok_or_else(|| {
                    JobManagerError::new(
                        "JOB_STORE_MIGRATION_INVALID",
                        "a queued dictionary import omitted its package",
                    )
                })?;
                let staged = staging
                    .stage_base64(&display_name, &archive)
                    .map_err(|error| {
                        let code = if error.code == "DICTIONARY_ARCHIVE_TOO_LARGE" {
                            "JOB_STORE_MIGRATION_ARCHIVE_TOO_LARGE"
                        } else {
                            error.code
                        };
                        JobManagerError::new(code, error.message)
                    })?;
                staged_tokens.push(staged.staging_token.clone());
                *staging_token = staged.staging_token;
                *expected_sha256 = staged.expected_sha256;
                *original_display_name = staged.original_display_name;
                *bytes = staged.bytes;
            } else {
                *legacy_source_file_name = None;
                *legacy_archive_base64 = None;
            }
        }
        JobDescriptor::Export { .. } | JobDescriptor::DictionaryIndex { .. } => {}
    }
    Ok(())
}

fn read_job_document(config: &JobPersistence) -> Result<JobStoreDocument, JobManagerError> {
    let target = config.root.join(JOB_STORE_FILE);
    if !target.exists() {
        return Ok(JobStoreDocument::default());
    }
    read_job_document_from_path(config, &target)
}

fn read_job_document_with_recovery(
    config: &JobPersistence,
) -> Result<JobStoreDocument, JobManagerError> {
    let target = config.root.join(JOB_STORE_FILE);
    let primary = if target.exists() {
        match read_job_document_from_path(config, &target) {
            Ok(document) => return Ok(document),
            Err(error) => Some(error),
        }
    } else {
        None
    };

    for backup_name in [JOB_STORE_MIGRATION_BACKUP_FILE, JOB_STORE_BACKUP_FILE] {
        let backup = config.root.join(backup_name);
        if !backup.exists() || read_job_document_from_path(config, &backup).is_err() {
            continue;
        }
        restore_job_store_backup(config, &backup)?;
        return read_job_document_from_path(config, &target);
    }

    match primary {
        Some(error) => Err(error),
        None => Ok(JobStoreDocument::default()),
    }
}

fn read_job_document_from_path(
    config: &JobPersistence,
    target: &Path,
) -> Result<JobStoreDocument, JobManagerError> {
    let metadata = fs::metadata(target).map_err(|_| {
        JobManagerError::new(
            "JOB_STORE_READ_FAILED",
            "local job state could not be inspected",
        )
    })?;
    if metadata.len() > MAX_JOB_STORE_BYTES {
        return Err(JobManagerError::new(
            "JOB_STORE_TOO_LARGE",
            "local job state exceeds the safe size limit",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(target)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|_| {
            JobManagerError::new("JOB_STORE_READ_FAILED", "local job state could not be read")
        })?;
    if bytes.len() <= JOB_STORE_MAGIC.len() + NONCE_BYTES || !bytes.starts_with(JOB_STORE_MAGIC) {
        return Err(JobManagerError::new(
            "JOB_STORE_CORRUPT",
            "local job state did not pass its integrity check",
        ));
    }
    let nonce_start = JOB_STORE_MAGIC.len();
    let payload_start = nonce_start + NONCE_BYTES;
    let key = job_store_key(config)?;
    let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| {
        JobManagerError::new(
            "JOB_STORE_KEY_FAILED",
            "local job encryption could not start",
        )
    })?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&bytes[nonce_start..payload_start]),
            Payload {
                msg: &bytes[payload_start..],
                aad: JOB_STORE_AAD,
            },
        )
        .map_err(|_| {
            JobManagerError::new(
                "JOB_STORE_CORRUPT",
                "local job state did not pass its integrity check",
            )
        })?;
    let document: JobStoreDocument = serde_json::from_slice(&plaintext)
        .map_err(|_| JobManagerError::new("JOB_STORE_CORRUPT", "local job state is not valid"))?;
    if !matches!(document.schema_version, 1 | JOB_STORE_SCHEMA_VERSION)
        || document.jobs.len() > MAX_RETAINED_JOBS
    {
        return Err(JobManagerError::new(
            "JOB_STORE_SCHEMA_UNSUPPORTED",
            "local job state uses an unsupported schema",
        ));
    }
    Ok(document)
}

fn restore_job_store_backup(config: &JobPersistence, backup: &Path) -> Result<(), JobManagerError> {
    fs::create_dir_all(&config.root).map_err(|_| {
        JobManagerError::new(
            "JOB_STORE_RECOVERY_FAILED",
            "local job recovery storage could not be created",
        )
    })?;
    let target = config.root.join(JOB_STORE_FILE);
    let temporary = config.root.join(JOB_STORE_RECOVERY_TEMP_FILE);
    let _ = fs::remove_file(&temporary);
    fs::copy(backup, &temporary).map_err(|_| {
        JobManagerError::new(
            "JOB_STORE_RECOVERY_FAILED",
            "local job state could not be restored from its rollback backup",
        )
    })?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&temporary)
        .and_then(|file| file.sync_all())
        .map_err(|_| {
            let _ = fs::remove_file(&temporary);
            JobManagerError::new(
                "JOB_STORE_RECOVERY_FAILED",
                "restored local job state could not be committed",
            )
        })?;
    if target.exists() {
        fs::remove_file(&target).map_err(|_| {
            let _ = fs::remove_file(&temporary);
            JobManagerError::new(
                "JOB_STORE_RECOVERY_FAILED",
                "the interrupted local job state could not be replaced",
            )
        })?;
    }
    fs::rename(&temporary, &target).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        JobManagerError::new(
            "JOB_STORE_RECOVERY_FAILED",
            "the restored local job state could not be promoted",
        )
    })
}

fn write_job_document(
    config: &JobPersistence,
    document: &JobStoreDocument,
) -> Result<(), JobManagerError> {
    fs::create_dir_all(&config.root).map_err(|_| {
        JobManagerError::new(
            "JOB_STORE_WRITE_FAILED",
            "local job storage could not be created",
        )
    })?;
    let plaintext = serde_json::to_vec(document).map_err(|_| {
        JobManagerError::new(
            "JOB_STORE_WRITE_FAILED",
            "local job state could not be encoded",
        )
    })?;
    if plaintext.len() as u64 > MAX_JOB_STORE_BYTES {
        return Err(JobManagerError::new(
            "JOB_STORE_TOO_LARGE",
            "local job state exceeds the safe size limit",
        ));
    }
    let key = job_store_key(config)?;
    let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| {
        JobManagerError::new(
            "JOB_STORE_KEY_FAILED",
            "local job encryption could not start",
        )
    })?;
    let mut nonce = [0_u8; NONCE_BYTES];
    getrandom(&mut nonce).map_err(|_| {
        JobManagerError::new(
            "JOB_STORE_WRITE_FAILED",
            "local job encryption nonce failed",
        )
    })?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: JOB_STORE_AAD,
            },
        )
        .map_err(|_| {
            JobManagerError::new(
                "JOB_STORE_WRITE_FAILED",
                "local job state could not be encrypted",
            )
        })?;
    let temporary = config.root.join(JOB_STORE_TEMP_FILE);
    let target = config.root.join(JOB_STORE_FILE);
    let backup = config.root.join(JOB_STORE_BACKUP_FILE);
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(|_| {
            JobManagerError::new(
                "JOB_STORE_WRITE_FAILED",
                "stale local job staging could not be removed",
            )
        })?;
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| {
            JobManagerError::new(
                "JOB_STORE_WRITE_FAILED",
                "local job state could not be staged",
            )
        })?;
    file.write_all(JOB_STORE_MAGIC)
        .and_then(|_| file.write_all(&nonce))
        .and_then(|_| file.write_all(&ciphertext))
        .and_then(|_| file.sync_all())
        .map_err(|_| {
            JobManagerError::new(
                "JOB_STORE_WRITE_FAILED",
                "local job state could not be saved",
            )
        })?;
    drop(file);

    let had_target = target.exists();
    if had_target {
        let _ = fs::remove_file(&backup);
        fs::rename(&target, &backup).map_err(|_| {
            JobManagerError::new(
                "JOB_STORE_WRITE_FAILED",
                "local job backup could not be created",
            )
        })?;
    }
    if fs::rename(&temporary, &target).is_err() {
        if had_target && backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        return Err(JobManagerError::new(
            "JOB_STORE_WRITE_FAILED",
            "local job state could not be committed",
        ));
    }
    if backup.exists() {
        fs::remove_file(&backup).map_err(|_| {
            JobManagerError::new(
                "JOB_STORE_BACKUP_CLEANUP_FAILED",
                "the prior local job backup could not be removed after commit",
            )
        })?;
    }
    Ok(())
}

fn remove_job_prior_state_artifacts(config: &JobPersistence) -> Result<(), JobManagerError> {
    for name in [
        JOB_STORE_BACKUP_FILE,
        JOB_STORE_MIGRATION_BACKUP_FILE,
        JOB_STORE_TEMP_FILE,
        JOB_STORE_RECOVERY_TEMP_FILE,
    ] {
        let artifact = config.root.join(name);
        if !artifact.exists() {
            continue;
        }
        let metadata = fs::symlink_metadata(&artifact).map_err(|_| {
            JobManagerError::new(
                "JOB_STORE_ARTIFACT_CLEANUP_FAILED",
                "a prior local job artifact could not be inspected",
            )
        })?;
        if !metadata.file_type().is_file() {
            return Err(JobManagerError::new(
                "JOB_STORE_ARTIFACT_CLEANUP_FAILED",
                "a prior local job artifact was not a regular file",
            ));
        }
        fs::remove_file(&artifact).map_err(|_| {
            JobManagerError::new(
                "JOB_STORE_ARTIFACT_CLEANUP_FAILED",
                "a prior local job artifact could not be removed",
            )
        })?;
    }
    Ok(())
}

fn job_store_key(config: &JobPersistence) -> Result<[u8; 32], JobManagerError> {
    #[cfg(test)]
    if let Some(key) = config.test_key {
        return Ok(key);
    }
    os_key_store::get_or_create_key(&config.key_root)
        .map(|key| key.derive_key(JOB_STORE_KEY_LABEL))
        .map_err(|_| {
            JobManagerError::new(
                "JOB_STORE_KEY_FAILED",
                "local job encryption key is unavailable",
            )
        })
}

fn new_job_id() -> Result<String, JobManagerError> {
    let mut bytes = [0_u8; 16];
    getrandom(&mut bytes).map_err(|_| {
        JobManagerError::new(
            "JOB_ID_UNAVAILABLE",
            "secure local job id generation failed",
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn validate_job_id(job_id: &str) -> Result<(), JobManagerError> {
    if job_id.len() == 32 && job_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(JobManagerError::new(
            "JOB_ID_INVALID",
            "local job id is invalid",
        ))
    }
}

fn timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn safe_failure_message(job_type: &str, _message: &str) -> String {
    match job_type {
        "transcription" => {
            "Local transcription could not be completed. Your recording is safe.".to_string()
        }
        "transcript-cleanup" => {
            "Local transcript cleanup could not be completed. The original transcript is safe."
                .to_string()
        }
        "recap" | "ask" => {
            "Local AI could not complete this request. Your meeting data is safe.".to_string()
        }
        "export" => "The local report could not be created. Your meeting is safe.".to_string(),
        "dictionary-import" | "dictionary-index" => {
            "The local dictionary operation could not be completed.".to_string()
        }
        "legacy-import" => "The local import could not be completed.".to_string(),
        "speech-model-verification" | "speech-model-import" | "local-ai-component-import" => {
            "The local model could not be verified.".to_string()
        }
        "local-ai-benchmark" => "The local performance check could not be completed.".to_string(),
        _ => "The local operation could not be completed.".to_string(),
    }
}

fn job_type_priority(job_type: &str) -> u8 {
    match job_type {
        "transcription" => 60,
        "transcript-cleanup" => 55,
        "recap" | "ask" => 50,
        "export" => 40,
        "local-ai-benchmark" => 20,
        "dictionary-import" | "dictionary-index" => 10,
        _ => 30,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "candor-job-manager-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ))
    }

    fn wait_for_terminal(manager: &JobManager, job_id: &str) -> Value {
        for _ in 0..200 {
            let value = manager.get(job_id).expect("job status");
            if value["terminal"] == true {
                return value;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("job did not reach a terminal state");
    }

    fn wait_for_state(manager: &JobManager, job_id: &str, state: &str) -> Value {
        for _ in 0..200 {
            let value = manager.get(job_id).expect("job status");
            if value["state"] == state {
                return value;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("job did not reach state {state}");
    }

    fn successful_recording_recovery() -> Value {
        json!({
            "recoveredCount": 0,
            "quarantinedCount": 0,
            "pendingDeletionCount": 0,
            "rawPathExposed": false
        })
    }

    fn executor(attempts: Arc<AtomicUsize>) -> JobExecutor {
        Arc::new(move |descriptor, context| {
            attempts.fetch_add(1, AtomicOrdering::SeqCst);
            match descriptor {
                JobDescriptor::Transcription { recording_id, .. } => {
                    for _ in 0..100 {
                        if context.cancelled() {
                            return Err(JobFailure::new(
                                "TRANSCRIPTION_CANCELLED",
                                "cancelled",
                                true,
                            ));
                        }
                        thread::sleep(Duration::from_millis(1));
                    }
                    Ok(json!({ "recordingId": recording_id, "rawPathExposed": false }))
                }
                JobDescriptor::Recap { recording_id, .. } => {
                    Ok(json!({ "recordingId": recording_id, "rawPathExposed": false }))
                }
                _ => Ok(json!({ "rawPathExposed": false })),
            }
        })
    }

    fn test_persistence(root: &Path) -> JobPersistence {
        JobPersistence {
            root: root.join("jobs"),
            key_root: root.join("keys"),
            test_key: Some([0x39; 32]),
        }
    }

    fn persisted_entry(job_id: &str, descriptor: JobDescriptor) -> PersistedJobEntry {
        PersistedJobEntry {
            job_id: job_id.to_string(),
            job_type: descriptor.job_type().to_string(),
            state: JobState::Paused,
            created_at: timestamp(),
            updated_at: timestamp(),
            created_at_ms: now_ms(),
            updated_at_ms: now_ms(),
            started_at_ms: None,
            stage: Some("restart-recovery".to_string()),
            progress: None,
            result: None,
            result_persisted: false,
            error: None,
            cancel_requested: false,
            exclusive_inference: descriptor.exclusive_inference(),
            descriptor: Some(descriptor),
            retry_count: 0,
            parent_job_id: None,
            follow_up_queued: false,
        }
    }

    fn recap_descriptor(recording_id: &str) -> JobDescriptor {
        JobDescriptor::Recap {
            recording_id: recording_id.to_string(),
            recap_template: None,
            mode: AiExecutionMode::LocalLlm,
            fallback_policy: AiFallbackPolicy::RequireLocalLlm,
            legacy_quality: None,
        }
    }

    #[test]
    fn recording_deletion_gate_rejects_queued_and_running_jobs() {
        for state in [JobState::Queued, JobState::Running] {
            let manager = JobManager::new("test-protocol");
            let (job_id, _) = manager
                .insert_job(
                    "recap",
                    true,
                    Some(recap_descriptor("recording-busy")),
                    None,
                )
                .expect("insert job");
            manager
                .inner
                .jobs
                .lock()
                .expect("jobs")
                .get_mut(&job_id)
                .expect("job")
                .state = state;

            let error = manager
                .begin_recording_deletion("recording-busy")
                .expect_err("active recording job must block deletion");
            assert_eq!(error.code, "JOB_RECORDING_BUSY");
        }
    }

    #[test]
    fn recording_deletion_purges_terminal_results_and_blocks_new_jobs() {
        let manager = JobManager::new("test-protocol");
        let (job_id, _) = manager
            .insert_job(
                "recap",
                true,
                Some(recap_descriptor("recording-delete")),
                None,
            )
            .expect("insert terminal job");
        {
            let mut jobs = manager.inner.jobs.lock().expect("jobs");
            let job = jobs.get_mut(&job_id).expect("job");
            job.state = JobState::Completed;
            job.result = Some(json!({
                "recordingId": "recording-delete",
                "summary": "private completed recap"
            }));
            job.result_persisted = true;
        }

        manager
            .begin_recording_deletion("recording-delete")
            .expect("begin deletion");
        let denied = manager
            .insert_job(
                "recap",
                true,
                Some(recap_descriptor("recording-delete")),
                None,
            )
            .expect_err("new work must be gated");
        assert_eq!(denied.code, "JOB_RECORDING_DELETION_IN_PROGRESS");
        let purged = manager
            .purge_recording_jobs("recording-delete")
            .expect("purge terminal data");
        assert_eq!(purged["purgedJobCount"], 1);
        assert_eq!(manager.list().expect("list")["jobCount"], 0);
    }

    #[test]
    fn recording_job_purge_survives_restart() {
        let root = test_root("recording-delete-restart");
        let manager =
            JobManager::with_test_roots("test-protocol", root.join("jobs"), root.join("keys"));
        let (job_id, _) = manager
            .insert_job(
                "recap",
                true,
                Some(recap_descriptor("recording-restart")),
                None,
            )
            .expect("insert persisted job");
        {
            let mut jobs = manager.inner.jobs.lock().expect("jobs");
            let job = jobs.get_mut(&job_id).expect("job");
            job.state = JobState::Completed;
            job.result = Some(json!({
                "recordingId": "recording-restart",
                "summary": "private restart recap"
            }));
            job.result_persisted = true;
        }
        manager.persist().expect("persist completed job");
        let job_root = root.join("jobs");
        fs::copy(
            job_root.join(JOB_STORE_FILE),
            job_root.join(JOB_STORE_MIGRATION_BACKUP_FILE),
        )
        .expect("seed migration backup with deleted job data");
        fs::copy(
            job_root.join(JOB_STORE_FILE),
            job_root.join(JOB_STORE_RECOVERY_TEMP_FILE),
        )
        .expect("seed recovery artifact with deleted job data");
        manager
            .begin_recording_deletion("recording-restart")
            .expect("begin deletion");
        let purged = manager
            .purge_recording_jobs("recording-restart")
            .expect("persist purge");
        assert_eq!(purged["priorStateArtifactsRemoved"], true);
        for name in [
            JOB_STORE_BACKUP_FILE,
            JOB_STORE_MIGRATION_BACKUP_FILE,
            JOB_STORE_TEMP_FILE,
            JOB_STORE_RECOVERY_TEMP_FILE,
        ] {
            assert!(!job_root.join(name).exists(), "{name} must be removed");
        }
        drop(manager);

        let restored =
            JobManager::with_test_roots("test-protocol", root.join("jobs"), root.join("keys"));
        assert_eq!(restored.list().expect("restored jobs")["jobCount"], 0);
    }

    #[test]
    fn persisted_cancelled_task_retains_cancellation_semantics() {
        let descriptor = JobDescriptor::Recap {
            recording_id: "recording-cancelled".to_string(),
            recap_template: None,
            mode: AiExecutionMode::LocalLlm,
            fallback_policy: AiFallbackPolicy::RequireLocalLlm,
            legacy_quality: None,
        };
        let mut persisted = persisted_entry(&"a".repeat(32), descriptor);
        persisted.state = JobState::Cancelled;
        persisted.stage = Some("cancelled".to_string());
        persisted.cancel_requested = false;

        let restored = JobEntry::from_persisted(persisted).value(false);

        assert_eq!(restored["state"], "cancelled");
        assert_eq!(restored["cancelRequested"], true);
        assert_eq!(restored["terminal"], true);
    }

    #[test]
    fn persisted_ai_descriptors_without_a_policy_default_to_ask_first() {
        let mut serialized = serde_json::to_value(JobDescriptor::Recap {
            recording_id: "recording-migrated".to_string(),
            recap_template: None,
            mode: AiExecutionMode::LocalLlm,
            fallback_policy: AiFallbackPolicy::RequireLocalLlm,
            legacy_quality: None,
        })
        .expect("serialize descriptor");
        let object = serialized.as_object_mut().expect("descriptor object");
        assert!(object.remove("fallback_policy").is_some());

        let restored = serde_json::from_value::<JobDescriptor>(serialized)
            .expect("deserialize descriptor without policy");
        match restored {
            JobDescriptor::Recap {
                fallback_policy, ..
            } => assert_eq!(fallback_policy, AiFallbackPolicy::RequireLocalLlm),
            _ => panic!("expected recap descriptor"),
        }
    }

    #[test]
    fn persisted_recap_templates_are_bounded_and_round_trip_locally() {
        let descriptor = JobDescriptor::Recap {
            recording_id: "recording-profile-template".to_string(),
            recap_template: Some("Focus on blockers and named owners.".to_string()),
            mode: AiExecutionMode::LocalLlm,
            fallback_policy: AiFallbackPolicy::RequireLocalLlm,
            legacy_quality: None,
        };
        validate_current_descriptor(&descriptor, None).expect("valid recap template");
        let restored = serde_json::from_value::<JobDescriptor>(
            serde_json::to_value(&descriptor).expect("serialize recap template"),
        )
        .expect("restore recap template");
        assert_eq!(restored, descriptor);

        let invalid = JobDescriptor::Recap {
            recording_id: "recording-profile-template".to_string(),
            recap_template: Some("x".repeat(4_097)),
            mode: AiExecutionMode::LocalLlm,
            fallback_policy: AiFallbackPolicy::RequireLocalLlm,
            legacy_quality: None,
        };
        assert_eq!(
            validate_current_descriptor(&invalid, None)
                .unwrap_err()
                .code,
            "JOB_STORE_RECAP_TEMPLATE_INVALID"
        );
    }

    #[test]
    fn jobs_remain_queryable_until_acknowledged() {
        let manager = JobManager::new("test-protocol");
        let (progress_tx, progress_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let accepted = manager
            .submit("export", false, move |context| {
                context.progress("rendering", 1, Some(2), Some("stage"));
                progress_tx.send(()).expect("progress signal");
                release_rx
                    .recv_timeout(Duration::from_secs(1))
                    .expect("completion release");
                Ok(json!({ "format": "markdown", "rawPathExposed": false }))
            })
            .expect("accepted job");
        let job_id = accepted["jobId"].as_str().expect("job id");
        progress_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("progress update");
        let running = manager.get(job_id).expect("running job status");
        assert_eq!(running["progress"]["completed"], 50);
        assert_eq!(running["progress"]["total"], 100);
        assert_eq!(running["progress"]["unit"], "percent");
        release_tx.send(()).expect("release completion");
        let completed = wait_for_terminal(&manager, job_id);
        assert_eq!(completed["state"], "completed");
        assert_eq!(completed["result"]["format"], "markdown");
        assert_eq!(completed["progress"]["completed"], 100);
        assert_eq!(completed["progress"]["total"], 100);
        assert_eq!(completed["progress"]["unit"], "percent");
        assert_eq!(
            manager.acknowledge(job_id).unwrap().response["acknowledged"],
            true
        );
        assert_eq!(manager.get(job_id).unwrap_err().code, "JOB_NOT_FOUND");
    }

    #[test]
    fn legacy_stage_progress_without_a_positive_total_remains_wire_safe() {
        let manager = JobManager::new("test-protocol");
        let (progress_tx, progress_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let accepted = manager
            .submit("export", false, move |context| {
                context.progress("preparing", 7, None, Some("stage"));
                progress_tx.send(()).expect("progress signal");
                release_rx
                    .recv_timeout(Duration::from_secs(1))
                    .expect("completion release");
                Ok(json!({ "format": "markdown", "rawPathExposed": false }))
            })
            .expect("accepted job");
        let job_id = accepted["jobId"].as_str().expect("job id");
        progress_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("progress update");

        let running = manager.get(job_id).expect("running job status");
        assert_eq!(running["progress"]["completed"], 7);
        assert_eq!(running["progress"]["total"], Value::Null);
        assert_eq!(running["progress"]["unit"], "percent");

        release_tx.send(()).expect("release completion");
        wait_for_terminal(&manager, job_id);
    }

    #[test]
    fn completed_work_cannot_be_retried() {
        let manager = JobManager::new("test-protocol");
        let (job_id, _) = manager
            .insert_job(
                "export",
                false,
                Some(JobDescriptor::Export {
                    params: json!({ "format": "markdown" }),
                }),
                None,
            )
            .expect("export job");
        manager.finish_completed(
            &job_id,
            json!({ "format": "markdown", "rawPathExposed": false }),
        );

        let error = manager
            .retry(&job_id, executor(Arc::new(AtomicUsize::new(0))))
            .expect_err("completed work must not restart");

        assert_eq!(error.code, "JOB_NOT_RETRYABLE");
        assert_eq!(manager.get(&job_id).unwrap()["state"], "completed");
    }

    #[test]
    fn retryability_requires_a_restart_descriptor() {
        let manager = JobManager::new("test-protocol");
        let (job_id, _) = manager
            .insert_job("export", false, None, None)
            .expect("nonrestartable job");

        manager.finish_failed(
            &job_id,
            JobFailure::new("EXPORT_FAILED", "local export failed", true),
        );

        let failed = manager.get(&job_id).expect("failed job status");
        assert_eq!(failed["state"], "failed");
        assert_eq!(failed["retryable"], false);
        assert_eq!(failed["error"]["retryable"], false);
    }

    #[test]
    fn acknowledging_terminal_dictionary_work_removes_the_job() {
        let manager = JobManager::new("test-protocol");
        let staging_token = "a".repeat(64);
        let (job_id, _) = manager
            .insert_job(
                "dictionary-import",
                false,
                Some(JobDescriptor::DictionaryImport {
                    staging_token: staging_token.clone(),
                    expected_sha256: "b".repeat(64),
                    original_display_name: "terms.candordict".to_string(),
                    bytes: 128,
                    legacy_source_file_name: None,
                    legacy_archive_base64: None,
                }),
                None,
            )
            .expect("dictionary job");
        manager.cancel_all().expect("cancel queued job");

        assert_eq!(
            manager
                .terminal_dictionary_staging_reference(&job_id)
                .expect("terminal staging reference")
                .as_deref(),
            Some(staging_token.as_str())
        );

        let acknowledgement = manager.acknowledge(&job_id).expect("acknowledge job");

        assert_eq!(acknowledgement.response["acknowledged"], true);
        assert_eq!(manager.get(&job_id).unwrap_err().code, "JOB_NOT_FOUND");
    }

    #[test]
    fn deleting_cancelled_dictionary_staging_removes_retryability() {
        let manager = JobManager::new("test-protocol");
        let staging_token = "c".repeat(64);
        let (job_id, _) = manager
            .insert_job(
                "dictionary-import",
                false,
                Some(JobDescriptor::DictionaryImport {
                    staging_token: staging_token.clone(),
                    expected_sha256: "d".repeat(64),
                    original_display_name: "cancelled.candordict".to_string(),
                    bytes: 128,
                    legacy_source_file_name: None,
                    legacy_archive_base64: None,
                }),
                None,
            )
            .expect("dictionary job");
        manager.cancel_all().expect("cancel queued job");

        let deleted_token = manager.discard_dictionary_staging(&job_id);
        let cancelled = manager.get(&job_id).expect("cancelled task");

        assert_eq!(deleted_token.as_deref(), Some(staging_token.as_str()));
        assert_eq!(cancelled["state"], "cancelled");
        assert_eq!(cancelled["retryable"], false);
        assert_eq!(
            manager
                .retry(&job_id, executor(Arc::new(AtomicUsize::new(0))))
                .expect_err("deleted staging cannot be retried")
                .code,
            "JOB_NOT_RETRYABLE"
        );
    }

    #[test]
    fn dictionary_cleanup_recovers_a_poisoned_job_lock_after_physical_delete() {
        let manager = JobManager::new("test-protocol");
        let staging_token = "9".repeat(64);
        let (job_id, _) = manager
            .insert_job(
                "dictionary-import",
                false,
                Some(JobDescriptor::DictionaryImport {
                    staging_token: staging_token.clone(),
                    expected_sha256: "8".repeat(64),
                    original_display_name: "cleanup.candordict".to_string(),
                    bytes: 128,
                    legacy_source_file_name: None,
                    legacy_archive_base64: None,
                }),
                None,
            )
            .expect("dictionary job");
        let inner = manager.inner.clone();
        let _ = std::panic::catch_unwind(move || {
            let _guard = inner.jobs.lock().expect("job lock");
            panic!("poison job lock for cleanup regression");
        });

        let deleted_token = manager.discard_dictionary_staging(&job_id);
        let jobs = manager
            .inner
            .jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        assert_eq!(deleted_token.as_deref(), Some(staging_token.as_str()));
        assert!(jobs
            .get(&job_id)
            .expect("job remains available")
            .descriptor
            .is_none());
    }

    #[test]
    fn active_dictionary_cancellation_preserves_token_for_immediate_cleanup() {
        let manager = JobManager::new("test-protocol");
        let staging_token = "e".repeat(64);
        let accepted = manager
            .submit_descriptor(
                JobDescriptor::DictionaryImport {
                    staging_token: staging_token.clone(),
                    expected_sha256: "f".repeat(64),
                    original_display_name: "active.candordict".to_string(),
                    bytes: 128,
                    legacy_source_file_name: None,
                    legacy_archive_base64: None,
                },
                Arc::new(|_, context| {
                    while !context.cancelled() {
                        thread::sleep(Duration::from_millis(1));
                    }
                    Ok(json!({ "rawPathExposed": false }))
                }),
            )
            .expect("active dictionary job");
        let job_id = accepted["jobId"].as_str().expect("job id");
        wait_for_state(&manager, job_id, "running");

        assert_eq!(
            manager
                .terminal_dictionary_staging_reference(job_id)
                .expect_err("active staging cannot be acknowledged")
                .code,
            "JOB_NOT_TERMINAL"
        );

        manager.cancel(job_id).expect("cancel active job");
        let cancelled = wait_for_terminal(&manager, job_id);
        let deleted_token = manager.discard_dictionary_staging(job_id);

        assert_eq!(cancelled["state"], "cancelled");
        assert_eq!(cancelled["retryable"], false);
        assert_eq!(deleted_token.as_deref(), Some(staging_token.as_str()));
        assert_eq!(
            manager.get(job_id).expect("updated task")["retryable"],
            false
        );
    }

    #[test]
    fn cancellation_reaches_a_terminal_state_without_deleting_results() {
        let manager = JobManager::new("test-protocol");
        let accepted = manager
            .submit("transcription", false, |context| {
                for _ in 0..100 {
                    if context.cancelled() {
                        return Ok(json!({ "sourceDataDeleted": false }));
                    }
                    thread::sleep(Duration::from_millis(2));
                }
                Ok(json!({ "sourceDataDeleted": false }))
            })
            .expect("accepted job");
        let job_id = accepted["jobId"].as_str().expect("job id");
        manager.cancel(job_id).expect("cancel request");
        let cancelled = wait_for_terminal(&manager, job_id);
        assert_eq!(cancelled["state"], "cancelled");
        assert_eq!(cancelled["result"], Value::Null);
        assert_eq!(cancelled["sourceDataPreserved"], true);
    }

    #[test]
    fn running_media_import_job_terminates_after_yielding_to_recording_priority() {
        let manager = JobManager::new("test-protocol");
        let cancellation_observed = Arc::new(AtomicUsize::new(0));
        let worker_observation = cancellation_observed.clone();
        let accepted = manager
            .submit("media-import", true, move |context| {
                for _ in 0..250 {
                    if context.cancelled() {
                        worker_observation.store(1, AtomicOrdering::SeqCst);
                        return Ok(json!({
                            "imported": false,
                            "rawPathExposed": false,
                            "keyMaterialExposedToRenderer": false
                        }));
                    }
                    thread::sleep(Duration::from_millis(2));
                }
                Err(JobFailure::new(
                    "TEST_CANCELLATION_NOT_OBSERVED",
                    "media import test did not observe recording preemption",
                    false,
                ))
            })
            .expect("accepted media import");
        let job_id = accepted["jobId"].as_str().expect("job id");
        wait_for_state(&manager, job_id, "running");

        manager.set_recording_active(true);

        let yielded = wait_for_terminal(&manager, job_id);
        assert_eq!(cancellation_observed.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(yielded["state"], "cancelled");
        assert_eq!(yielded["stage"], "cancelled");
        assert_eq!(yielded["terminal"], true);
        assert_eq!(yielded["result"], Value::Null);
        assert_eq!(yielded["sourceDataPreserved"], true);
        manager.set_recording_active(false);
    }

    #[test]
    fn recording_priority_waits_for_media_import_cleanup_before_succeeding() {
        let manager = JobManager::new("test-protocol");
        let (cancellation_observed, observe_cancellation) = std::sync::mpsc::channel();
        let (release_cleanup, cleanup_released) = std::sync::mpsc::channel();
        let accepted = manager
            .submit("media-import", true, move |context| {
                while !context.cancelled() {
                    thread::sleep(Duration::from_millis(1));
                }
                cancellation_observed.send(()).expect("report cancellation");
                cleanup_released.recv().expect("release simulated cleanup");
                Ok(json!({
                    "imported": false,
                    "partialRecordingRemoved": true,
                    "rawPathExposed": false,
                    "keyMaterialExposedToRenderer": false
                }))
            })
            .expect("accepted media import");
        let job_id = accepted["jobId"]
            .as_str()
            .expect("media import job id")
            .to_string();
        wait_for_state(&manager, &job_id, "running");

        let barrier_manager = manager.clone();
        let (barrier_finished, observe_barrier) = std::sync::mpsc::channel();
        let barrier = thread::spawn(move || {
            barrier_finished
                .send(barrier_manager.begin_recording_priority(Duration::from_secs(2)))
                .expect("report recording barrier result");
        });

        observe_cancellation
            .recv_timeout(Duration::from_secs(1))
            .expect("media import observed recording priority");
        assert!(
            observe_barrier
                .recv_timeout(Duration::from_millis(25))
                .is_err(),
            "recording barrier must remain closed while rollback is running"
        );

        release_cleanup.send(()).expect("finish simulated cleanup");
        observe_barrier
            .recv_timeout(Duration::from_secs(1))
            .expect("recording barrier completed")
            .expect("recording barrier succeeded after cleanup");
        barrier.join().expect("join recording barrier");
        assert_eq!(wait_for_terminal(&manager, &job_id)["state"], "cancelled");
        assert!(manager.inner.recording_active.load(Ordering::SeqCst));
        manager.set_recording_active(false);
    }

    #[test]
    fn recording_priority_fails_closed_when_media_import_cleanup_times_out() {
        let manager = JobManager::new("test-protocol");
        let (cancellation_observed, observe_cancellation) = std::sync::mpsc::channel();
        let (release_cleanup, cleanup_released) = std::sync::mpsc::channel();
        let accepted = manager
            .submit("media-import", true, move |context| {
                while !context.cancelled() {
                    thread::sleep(Duration::from_millis(1));
                }
                cancellation_observed.send(()).expect("report cancellation");
                cleanup_released.recv().expect("release simulated cleanup");
                Ok(json!({ "rawPathExposed": false }))
            })
            .expect("accepted media import");
        let job_id = accepted["jobId"]
            .as_str()
            .expect("media import job id")
            .to_string();
        wait_for_state(&manager, &job_id, "running");

        let barrier_manager = manager.clone();
        let barrier = thread::spawn(move || {
            barrier_manager.begin_recording_priority(Duration::from_millis(30))
        });
        observe_cancellation
            .recv_timeout(Duration::from_secs(1))
            .expect("media import observed recording priority");
        let error = barrier
            .join()
            .expect("join recording barrier")
            .expect_err("unfinished cleanup must block capture");
        assert_eq!(error.code, "MEDIA_IMPORT_CLEANUP_TIMEOUT");
        assert!(!manager.inner.recording_active.load(Ordering::SeqCst));

        release_cleanup.send(()).expect("finish simulated cleanup");
        assert_eq!(wait_for_terminal(&manager, &job_id)["state"], "cancelled");
    }

    #[test]
    fn recording_priority_reports_media_import_cleanup_failure() {
        let manager = JobManager::new("test-protocol");
        let accepted = manager
            .submit("media-import", true, |context| {
                while !context.cancelled() {
                    thread::sleep(Duration::from_millis(1));
                }
                Err(JobFailure::new(
                    "MEDIA_IMPORT_CLEANUP_FAILED",
                    "partial recording rollback failed",
                    false,
                ))
            })
            .expect("accepted media import");
        let job_id = accepted["jobId"]
            .as_str()
            .expect("media import job id")
            .to_string();
        wait_for_state(&manager, &job_id, "running");

        let error = manager
            .begin_recording_priority(Duration::from_secs(1))
            .expect_err("cleanup failure must block capture");
        assert_eq!(error.code, "MEDIA_IMPORT_CLEANUP_FAILED");
        let failed = wait_for_terminal(&manager, &job_id);
        assert_eq!(failed["state"], "failed");
        assert_eq!(failed["error"]["code"], "MEDIA_IMPORT_CLEANUP_FAILED");
        assert!(!manager.inner.recording_active.load(Ordering::SeqCst));

        let retry_error = manager
            .begin_recording_priority(Duration::from_millis(25))
            .expect_err("unresolved cleanup must block later recording attempts");
        assert_eq!(retry_error.code, "MEDIA_IMPORT_CLEANUP_FAILED");
        assert_eq!(
            manager
                .acknowledge(&job_id)
                .err()
                .expect("unresolved cleanup cannot be acknowledged")
                .code,
            "MEDIA_IMPORT_CLEANUP_UNRESOLVED"
        );
        {
            let mut jobs = manager.inner.jobs.lock().expect("job store");
            jobs.get_mut(&job_id).expect("failed job").updated_at_ms = 0;
        }
        assert!(manager.apply_retention().expect("retention").is_empty());
        assert_eq!(
            manager.get(&job_id).expect("retained failure")["state"],
            "failed"
        );

        let unresolved = manager
            .resolve_media_import_cleanup_after_recovery(&json!({
                "recoveredCount": 0,
                "quarantinedCount": 1,
                "pendingDeletionCount": 0,
                "rawPathExposed": false
            }))
            .expect("incomplete recovery result");
        assert_eq!(unresolved["resolved"], false);
        assert_eq!(
            manager
                .begin_recording_priority(Duration::from_millis(25))
                .expect_err("quarantined recovery must not clear the cleanup latch")
                .code,
            "MEDIA_IMPORT_CLEANUP_FAILED"
        );

        let resolved = manager
            .resolve_media_import_cleanup_after_recovery(&successful_recording_recovery())
            .expect("safe recovery resolves the cleanup latch");
        assert_eq!(resolved["resolved"], true);
        assert_eq!(resolved["resolvedCount"], 1);
        assert!(manager
            .begin_recording_priority(Duration::from_millis(25))
            .expect("resolved cleanup no longer blocks recording"));
        manager.set_recording_active(false);
    }

    #[test]
    fn user_cancelled_media_import_preserves_cleanup_failure_when_recording_waits() {
        let manager = JobManager::new("test-protocol");
        let (cancellation_observed, observe_cancellation) = std::sync::mpsc::channel();
        let (release_cleanup, cleanup_released) = std::sync::mpsc::channel();
        let accepted = manager
            .submit("media-import", true, move |context| {
                while !context.cancelled() {
                    thread::sleep(Duration::from_millis(1));
                }
                cancellation_observed.send(()).expect("report cancellation");
                cleanup_released.recv().expect("release failed cleanup");
                Err(JobFailure::new(
                    "MEDIA_IMPORT_CLEANUP_FAILED",
                    "partial recording rollback failed after user cancellation",
                    false,
                ))
            })
            .expect("accepted media import");
        let job_id = accepted["jobId"]
            .as_str()
            .expect("media import job id")
            .to_string();
        wait_for_state(&manager, &job_id, "running");

        manager.cancel(&job_id).expect("cancel media import");
        observe_cancellation
            .recv_timeout(Duration::from_secs(1))
            .expect("worker observed user cancellation");

        let barrier_manager = manager.clone();
        let (barrier_finished, observe_barrier) = std::sync::mpsc::channel();
        let barrier = thread::spawn(move || {
            barrier_finished
                .send(barrier_manager.begin_recording_priority(Duration::from_secs(1)))
                .expect("report recording barrier result");
        });
        assert!(
            observe_barrier
                .recv_timeout(Duration::from_millis(25))
                .is_err(),
            "recording must wait for user-cancelled import cleanup"
        );

        release_cleanup.send(()).expect("finish failed cleanup");
        let error = observe_barrier
            .recv_timeout(Duration::from_secs(1))
            .expect("recording barrier completed")
            .expect_err("cleanup failure must remain visible after user cancellation");
        assert_eq!(error.code, "MEDIA_IMPORT_CLEANUP_FAILED");
        barrier.join().expect("join recording barrier");
        let failed = wait_for_terminal(&manager, &job_id);
        assert_eq!(failed["state"], "failed");
        assert_eq!(failed["error"]["code"], "MEDIA_IMPORT_CLEANUP_FAILED");
        assert!(!manager.preempt_requested(&job_id));
        assert!(!manager.inner.recording_active.load(Ordering::SeqCst));
    }

    #[test]
    fn recording_priority_reports_panicking_media_import_without_stale_worker() {
        let manager = JobManager::new("test-protocol");
        let accepted = manager
            .submit("media-import", true, |context| {
                while !context.cancelled() {
                    thread::sleep(Duration::from_millis(1));
                }
                panic!("injected media import worker panic");
            })
            .expect("accepted media import");
        let job_id = accepted["jobId"]
            .as_str()
            .expect("media import job id")
            .to_string();
        wait_for_state(&manager, &job_id, "running");

        let error = manager
            .begin_recording_priority(Duration::from_secs(1))
            .expect_err("worker panic must block capture");
        assert_eq!(error.code, "MEDIA_IMPORT_WORKER_PANIC");
        let failed = wait_for_terminal(&manager, &job_id);
        assert_eq!(failed["state"], "failed");
        assert_eq!(failed["error"]["code"], "MEDIA_IMPORT_WORKER_PANIC");
        assert!(!manager.inner.recording_active.load(Ordering::SeqCst));

        let retry_error = manager
            .begin_recording_priority(Duration::from_millis(25))
            .expect_err("worker panic remains blocked until recovery");
        assert_eq!(retry_error.code, "MEDIA_IMPORT_WORKER_PANIC");
        assert_eq!(
            manager
                .acknowledge(&job_id)
                .err()
                .expect("unresolved worker panic cannot be acknowledged")
                .code,
            "MEDIA_IMPORT_CLEANUP_UNRESOLVED"
        );

        let resolved = manager
            .resolve_media_import_cleanup_after_recovery(&successful_recording_recovery())
            .expect("safe recording recovery resolves panic latch");
        assert_eq!(resolved["resolvedCount"], 1);
        let acquired = manager
            .begin_recording_priority(Duration::from_millis(25))
            .expect("released worker registration and resolved latch permit recording");
        assert!(acquired);
        manager.set_recording_active(false);
    }

    #[test]
    fn unresolved_media_import_cleanup_survives_restart_until_verified_recovery() {
        let root = test_root("media-import-cleanup-latch");
        let jobs_root = root.join("jobs");
        let key_root = root.join("keys");
        let manager =
            JobManager::with_test_roots("test-protocol", jobs_root.clone(), key_root.clone());
        let accepted = manager
            .submit("media-import", true, |context| {
                while !context.cancelled() {
                    thread::sleep(Duration::from_millis(1));
                }
                Err(JobFailure::new(
                    "MEDIA_IMPORT_CLEANUP_FAILED",
                    "persisted partial recording rollback failed",
                    false,
                ))
            })
            .expect("accepted media import");
        let job_id = accepted["jobId"]
            .as_str()
            .expect("media import job id")
            .to_string();
        wait_for_state(&manager, &job_id, "running");
        assert_eq!(
            manager
                .begin_recording_priority(Duration::from_secs(1))
                .expect_err("cleanup failure blocks recording")
                .code,
            "MEDIA_IMPORT_CLEANUP_FAILED"
        );
        drop(manager);

        let restored =
            JobManager::with_test_roots("test-protocol", jobs_root.clone(), key_root.clone());
        assert_eq!(
            restored.get(&job_id).expect("restored failure")["state"],
            "failed"
        );
        assert_eq!(
            restored
                .begin_recording_priority(Duration::from_millis(25))
                .expect_err("persisted cleanup latch blocks after restart")
                .code,
            "MEDIA_IMPORT_CLEANUP_FAILED"
        );
        let blocked_temporary = jobs_root.join(JOB_STORE_TEMP_FILE);
        fs::create_dir(&blocked_temporary).expect("block cleanup-resolution staging write");
        let persistence_error = restored
            .resolve_media_import_cleanup_after_recovery(&successful_recording_recovery())
            .expect_err("failed persistence must roll back cleanup resolution");
        assert_eq!(persistence_error.code, "JOB_STORE_WRITE_FAILED");
        assert_eq!(
            restored.get(&job_id).expect("rolled back cleanup audit")["error"]["cleanupResolved"],
            Value::Null
        );
        assert_eq!(
            restored
                .begin_recording_priority(Duration::from_millis(25))
                .expect_err("rolled back resolution must keep recording blocked")
                .code,
            "MEDIA_IMPORT_CLEANUP_FAILED"
        );
        fs::remove_dir(&blocked_temporary).expect("remove staging-write blocker");
        let resolved = restored
            .resolve_media_import_cleanup_after_recovery(&successful_recording_recovery())
            .expect("verified recovery is persisted");
        assert_eq!(resolved["resolvedCount"], 1);
        drop(restored);

        let recovered = JobManager::with_test_roots("test-protocol", jobs_root, key_root);
        assert_eq!(
            recovered.get(&job_id).expect("resolved audit record")["error"]["cleanupResolved"],
            true
        );
        assert!(recovered
            .begin_recording_priority(Duration::from_millis(25))
            .expect("resolved latch stays clear after restart"));
        recovered.set_recording_active(false);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recording_priority_preserves_media_import_committed_before_preemption() {
        let manager = JobManager::new("test-protocol");
        let (commit_completed, observe_commit) = std::sync::mpsc::channel();
        let (release_result, result_released) = std::sync::mpsc::channel();
        let accepted = manager
            .submit("media-import", true, move |_context| {
                commit_completed.send(()).expect("report durable commit");
                result_released
                    .recv()
                    .expect("release committed import result");
                Ok(json!({
                    "imported": true,
                    "recordingId": "recording-import-committed",
                    "rawPathExposed": false,
                    "keyMaterialExposedToRenderer": false
                }))
            })
            .expect("accepted media import");
        let job_id = accepted["jobId"]
            .as_str()
            .expect("media import job id")
            .to_string();
        wait_for_state(&manager, &job_id, "running");
        observe_commit
            .recv_timeout(Duration::from_secs(1))
            .expect("durable commit completed");

        let barrier_manager = manager.clone();
        let (barrier_finished, observe_barrier) = std::sync::mpsc::channel();
        let barrier = thread::spawn(move || {
            barrier_finished
                .send(barrier_manager.begin_recording_priority(Duration::from_secs(1)))
                .expect("report recording barrier result");
        });
        assert!(
            observe_barrier
                .recv_timeout(Duration::from_millis(25))
                .is_err(),
            "recording must wait for the committed import worker to publish success"
        );

        release_result
            .send(())
            .expect("publish committed import result");
        assert!(observe_barrier
            .recv_timeout(Duration::from_secs(1))
            .expect("recording barrier completed")
            .expect("committed import must not block capture"));
        barrier.join().expect("join recording barrier");
        let completed = wait_for_terminal(&manager, &job_id);
        assert_eq!(completed["state"], "completed");
        assert_eq!(completed["result"]["imported"], true);
        assert_eq!(
            completed["result"]["recordingId"],
            "recording-import-committed"
        );
        manager.set_recording_active(false);
    }

    #[test]
    fn queued_media_import_job_is_cancelled_instead_of_resuming_after_recording() {
        let manager = JobManager::new("test-protocol");
        let (release_blocker, blocker_released) = std::sync::mpsc::channel::<()>();
        let blocker = manager
            .submit("transcription", true, move |_context| {
                let _ = blocker_released.recv();
                Ok(json!({ "rawPathExposed": false }))
            })
            .expect("accepted blocker");
        let blocker_id = blocker["jobId"].as_str().expect("blocker job id");
        wait_for_state(&manager, blocker_id, "running");

        let attempts = Arc::new(AtomicUsize::new(0));
        let worker_attempts = attempts.clone();
        let accepted = manager
            .submit("media-import", true, move |_context| {
                worker_attempts.fetch_add(1, AtomicOrdering::SeqCst);
                Ok(json!({ "rawPathExposed": false }))
            })
            .expect("accepted media import");
        let job_id = accepted["jobId"].as_str().expect("media import job id");
        wait_for_state(&manager, job_id, "queued");

        manager.set_recording_active(true);

        let cancelled = wait_for_terminal(&manager, job_id);
        assert_eq!(cancelled["state"], "cancelled");
        assert_eq!(cancelled["stage"], "cancelled");
        assert_eq!(cancelled["terminal"], true);
        assert_eq!(cancelled["result"], Value::Null);
        assert_eq!(cancelled["sourceDataPreserved"], true);
        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 0);

        manager.set_recording_active(false);
        let _ = release_blocker.send(());
        wait_for_terminal(&manager, blocker_id);
        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 0);
    }

    #[test]
    fn cancellation_cannot_be_overwritten_by_a_concurrent_pause_or_start() {
        let root = test_root("cancel-pause-race");
        let manager =
            JobManager::with_test_roots("test-protocol", root.join("jobs"), root.join("keys"));
        manager.set_recording_active(true);
        let attempts = Arc::new(AtomicUsize::new(0));
        let accepted = manager
            .submit_descriptor(
                JobDescriptor::Transcription {
                    recording_id: "recording-cancelled".to_string(),
                    channel: None,
                    model_id: None,
                    follow_up: None,
                },
                executor(attempts.clone()),
            )
            .expect("queued descriptor");
        let job_id = accepted["jobId"].as_str().unwrap();
        wait_for_state(&manager, job_id, "paused");

        manager.cancel_all().expect("cancel all");
        manager.set_paused(job_id, "recording-priority");
        assert!(!manager.set_running(job_id));
        manager.set_recording_active(false);

        let cancelled = wait_for_terminal(&manager, job_id);
        assert_eq!(cancelled["state"], "cancelled");
        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancel_all_reports_cancelling_until_an_active_worker_stops() {
        let manager = JobManager::new("test-protocol");
        let (job_id, _) = manager
            .insert_job(
                "export",
                false,
                Some(JobDescriptor::Export {
                    params: json!({ "format": "pdf" }),
                }),
                None,
            )
            .expect("insert active fixture");
        assert!(manager.claim_worker(&job_id));

        manager.cancel_all().expect("request cancellation");
        assert_eq!(manager.get(&job_id).unwrap()["state"], "cancelling");
        assert_eq!(manager.get(&job_id).unwrap()["terminal"], false);

        manager.finish_cancelled(&job_id);
        manager.release_worker(&job_id);
        assert_eq!(manager.get(&job_id).unwrap()["state"], "cancelled");
        assert_eq!(manager.get(&job_id).unwrap()["terminal"], true);
        assert_eq!(manager.get(&job_id).unwrap()["retryable"], true);
    }

    #[test]
    fn cancellation_wins_atomically_over_worker_completion_or_failure() {
        let manager = JobManager::new("test-protocol");
        let descriptor = || JobDescriptor::Export {
            params: json!({ "format": "pdf" }),
        };

        let (completed_job_id, _) = manager
            .insert_job("export", false, Some(descriptor()), None)
            .expect("insert completion fixture");
        assert!(manager.claim_worker(&completed_job_id));
        manager
            .cancel_all()
            .expect("request completion cancellation");
        assert!(
            !manager.finish_completed(&completed_job_id, json!({ "path": "should-not-survive" }))
        );
        manager.release_worker(&completed_job_id);

        let completed = manager
            .get(&completed_job_id)
            .expect("cancelled completion");
        assert_eq!(completed["state"], "cancelled");
        assert_eq!(completed["terminal"], true);
        assert_eq!(completed["retryable"], true);
        assert!(completed["result"].is_null());
        assert!(completed["error"].is_null());

        let (failed_job_id, _) = manager
            .insert_job("export", false, Some(descriptor()), None)
            .expect("insert failure fixture");
        assert!(manager.claim_worker(&failed_job_id));
        manager.cancel_all().expect("request failure cancellation");
        manager.finish_failed(
            &failed_job_id,
            JobFailure::new("WORKER_FAILED", "failure after cancellation", true),
        );
        manager.release_worker(&failed_job_id);

        let failed = manager.get(&failed_job_id).expect("cancelled failure");
        assert_eq!(failed["state"], "cancelled");
        assert_eq!(failed["terminal"], true);
        assert_eq!(failed["retryable"], true);
        assert!(failed["result"].is_null());
        assert!(failed["error"].is_null());
    }

    #[test]
    fn oversized_descriptor_is_rejected_without_poisoning_the_job_store() {
        let root = test_root("descriptor-capacity");
        let manager =
            JobManager::with_test_roots("test-protocol", root.join("jobs"), root.join("keys"));
        let archive_base64 = "A".repeat(3_333_352);
        let mut accepted_ids = Vec::new();
        for index in 0..5 {
            let (job_id, _) = manager
                .insert_job(
                    "export",
                    false,
                    Some(JobDescriptor::Export {
                        params: json!({
                            "capacityFixture": archive_base64.clone(),
                            "index": index
                        }),
                    }),
                    None,
                )
                .expect("descriptor fits within the bounded store");
            accepted_ids.push(job_id);
        }
        let error = manager
            .insert_job(
                "export",
                false,
                Some(JobDescriptor::Export {
                    params: json!({ "capacityFixture": archive_base64 }),
                }),
                None,
            )
            .expect_err("projected overflow must be rejected before persistence");
        assert_eq!(error.code, "JOB_STORE_CAPACITY");
        assert_eq!(manager.list().unwrap()["persistenceState"], "encrypted");

        manager.cancel_all().expect("cancel retained jobs");
        for job_id in accepted_ids {
            manager.acknowledge(&job_id).expect("release capacity");
        }
        let accepted = manager
            .submit_descriptor(
                JobDescriptor::Recap {
                    recording_id: "recording-after-capacity".to_string(),
                    recap_template: None,
                    mode: AiExecutionMode::HeuristicFallback,
                    fallback_policy: AiFallbackPolicy::AllowDisclosed,
                    legacy_quality: None,
                },
                executor(Arc::new(AtomicUsize::new(0))),
            )
            .expect("job store remains usable after a capacity rejection");
        wait_for_terminal(&manager, accepted["jobId"].as_str().unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn active_type_detection_prevents_duplicate_background_work() {
        let manager = JobManager::new("test-protocol");
        let accepted = manager
            .submit("local-ai-benchmark", true, |_context| {
                thread::sleep(Duration::from_millis(20));
                Ok(json!({ "measured": true }))
            })
            .expect("accepted benchmark");
        assert!(manager
            .has_active_type("local-ai-benchmark")
            .expect("active query"));
        let job_id = accepted["jobId"].as_str().expect("job id");
        wait_for_terminal(&manager, job_id);
        assert!(!manager
            .has_active_type("local-ai-benchmark")
            .expect("terminal query"));
    }

    #[test]
    fn encrypted_jobs_resume_after_manager_restart() {
        let root = test_root("restart");
        let jobs_root = root.join("jobs");
        let key_root = root.join("keys");
        let first =
            JobManager::with_test_roots("test-protocol", jobs_root.clone(), key_root.clone());
        first.set_recording_active(true);
        let accepted = first
            .submit_descriptor(
                JobDescriptor::Transcription {
                    recording_id: "recording-1".to_string(),
                    channel: None,
                    model_id: None,
                    follow_up: None,
                },
                executor(Arc::new(AtomicUsize::new(0))),
            )
            .expect("queued descriptor");
        let job_id = accepted["jobId"].as_str().unwrap().to_string();
        wait_for_state(&first, &job_id, "paused");
        first
            .pause_all_for_shutdown()
            .expect("pause persisted work");

        let encrypted = fs::read(jobs_root.join(JOB_STORE_FILE)).expect("job store");
        assert!(encrypted.starts_with(JOB_STORE_MAGIC));
        assert!(!String::from_utf8_lossy(&encrypted).contains("recording-1"));

        let attempts = Arc::new(AtomicUsize::new(0));
        let second = JobManager::with_test_roots("test-protocol", jobs_root, key_root);
        second.recover(executor(attempts.clone()));
        let completed = wait_for_terminal(&second, &job_id);
        assert_eq!(completed["state"], "completed");
        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn encrypted_job_store_does_not_expose_questions_or_recording_ids() {
        let root = test_root("sensitive-descriptor");
        let jobs_root = root.join("jobs");
        let manager =
            JobManager::with_test_roots("test-protocol", jobs_root.clone(), root.join("keys"));
        manager.set_recording_active(true);
        let accepted = manager
            .submit_descriptor(
                JobDescriptor::Ask {
                    recording_id: "sensitive-recording-id".to_string(),
                    question: "What dosage did the patient discuss?".to_string(),
                    mode: AiExecutionMode::HeuristicFallback,
                    fallback_policy: AiFallbackPolicy::AllowDisclosed,
                    legacy_quality: None,
                },
                executor(Arc::new(AtomicUsize::new(0))),
            )
            .expect("queued Ask descriptor");
        let job_id = accepted["jobId"].as_str().unwrap();
        wait_for_state(&manager, job_id, "paused");
        manager.pause_all_for_shutdown().expect("pause jobs");

        let encrypted = fs::read(jobs_root.join(JOB_STORE_FILE)).expect("job store");
        let text = String::from_utf8_lossy(&encrypted);
        assert!(!text.contains("sensitive-recording-id"));
        assert!(!text.contains("What dosage did the patient discuss?"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recording_priority_preempts_and_resumes_descriptor_inference() {
        let root = test_root("priority");
        let manager =
            JobManager::with_test_roots("test-protocol", root.join("jobs"), root.join("keys"));
        let attempts = Arc::new(AtomicUsize::new(0));
        let accepted = manager
            .submit_descriptor(
                JobDescriptor::Transcription {
                    recording_id: "recording-2".to_string(),
                    channel: None,
                    model_id: None,
                    follow_up: None,
                },
                executor(attempts.clone()),
            )
            .expect("submitted");
        let job_id = accepted["jobId"].as_str().unwrap();
        wait_for_state(&manager, job_id, "running");
        for _ in 0..100 {
            if attempts.load(AtomicOrdering::SeqCst) > 0 {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 1);
        manager.set_recording_active(true);
        wait_for_state(&manager, job_id, "paused");
        manager.set_recording_active(false);
        let completed = wait_for_terminal(&manager, job_id);
        assert_eq!(completed["state"], "completed");
        assert!(attempts.load(AtomicOrdering::SeqCst) >= 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn queued_transcription_runs_before_user_ai() {
        let root = test_root("ordered-priority");
        let manager =
            JobManager::with_test_roots("test-protocol", root.join("jobs"), root.join("keys"));
        manager.set_recording_active(true);
        let execution_order = Arc::new(Mutex::new(Vec::new()));
        let observed_order = execution_order.clone();
        let ordered_executor: JobExecutor = Arc::new(move |descriptor, _context| {
            observed_order
                .lock()
                .expect("execution order")
                .push(descriptor.job_type());
            thread::sleep(Duration::from_millis(5));
            Ok(json!({ "rawPathExposed": false }))
        });
        let ask = manager
            .submit_descriptor(
                JobDescriptor::Ask {
                    recording_id: "recording-5".to_string(),
                    question: "What was decided?".to_string(),
                    mode: AiExecutionMode::HeuristicFallback,
                    fallback_policy: AiFallbackPolicy::AllowDisclosed,
                    legacy_quality: None,
                },
                ordered_executor.clone(),
            )
            .expect("queued Ask");
        let transcription = manager
            .submit_descriptor(
                JobDescriptor::Transcription {
                    recording_id: "recording-6".to_string(),
                    channel: None,
                    model_id: None,
                    follow_up: None,
                },
                ordered_executor,
            )
            .expect("queued transcription");
        let ask_id = ask["jobId"].as_str().unwrap();
        let transcription_id = transcription["jobId"].as_str().unwrap();
        wait_for_state(&manager, ask_id, "paused");
        wait_for_state(&manager, transcription_id, "paused");
        manager.set_recording_active(false);
        wait_for_terminal(&manager, transcription_id);
        wait_for_terminal(&manager, ask_id);
        assert_eq!(
            execution_order.lock().expect("execution order").as_slice(),
            ["transcription", "ask"]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn successful_transcription_queues_exactly_one_follow_up() {
        let root = test_root("chain");
        let manager =
            JobManager::with_test_roots("test-protocol", root.join("jobs"), root.join("keys"));
        let attempts = Arc::new(AtomicUsize::new(0));
        let accepted = manager
            .submit_descriptor(
                JobDescriptor::Transcription {
                    recording_id: "recording-3".to_string(),
                    channel: None,
                    model_id: None,
                    follow_up: Some(Box::new(JobDescriptor::Recap {
                        recording_id: "recording-3".to_string(),
                        recap_template: None,
                        mode: AiExecutionMode::LocalLlm,
                        fallback_policy: AiFallbackPolicy::AllowDisclosed,
                        legacy_quality: None,
                    })),
                },
                executor(attempts.clone()),
            )
            .expect("submitted");
        let parent = accepted["jobId"].as_str().unwrap();
        wait_for_terminal(&manager, parent);
        for _ in 0..200 {
            let list = manager.list().unwrap();
            if list["jobCount"] == 2 && list["activeCount"] == 0 {
                assert_eq!(attempts.load(AtomicOrdering::SeqCst), 2);
                let _ = fs::remove_dir_all(root);
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("follow-up did not complete");
    }

    #[test]
    fn corrupt_job_store_fails_closed_for_restartable_work() {
        let root = test_root("corrupt");
        let jobs_root = root.join("jobs");
        fs::create_dir_all(&jobs_root).unwrap();
        fs::write(jobs_root.join(JOB_STORE_FILE), b"not-a-job-store").unwrap();
        let manager = JobManager::with_test_roots("test-protocol", jobs_root, root.join("keys"));
        let error = manager
            .submit_descriptor(
                JobDescriptor::Recap {
                    recording_id: "recording-4".to_string(),
                    recap_template: None,
                    mode: AiExecutionMode::HeuristicFallback,
                    fallback_policy: AiFallbackPolicy::AllowDisclosed,
                    legacy_quality: None,
                },
                executor(Arc::new(AtomicUsize::new(0))),
            )
            .expect_err("corrupt store must block persisted jobs");
        assert_eq!(error.code, "JOB_STORE_CORRUPT");
        assert_eq!(manager.list().unwrap()["persistenceState"], "unavailable");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn encrypted_job_store_replaces_stale_temp_file_exclusively() {
        let root = test_root("stale-job-temp");
        let persistence = test_persistence(&root);
        fs::create_dir_all(&persistence.root).expect("jobs root");
        let temporary = persistence.root.join(JOB_STORE_TEMP_FILE);
        fs::write(&temporary, b"stale encrypted staging").expect("stale temp fixture");
        let document = JobStoreDocument {
            schema_version: JOB_STORE_SCHEMA_VERSION,
            jobs: Vec::new(),
        };

        write_job_document(&persistence, &document).expect("replace stale temp");

        assert!(!temporary.exists());
        assert_eq!(
            read_job_document(&persistence)
                .expect("read committed job store")
                .schema_version,
            JOB_STORE_SCHEMA_VERSION
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_dictionary_descriptor_migrates_to_encrypted_staging_with_backup() {
        let root = test_root("dictionary-migration");
        let persistence = test_persistence(&root);
        let staging =
            DictionaryStaging::with_test_roots(root.join("dictionary-staging"), root.join("keys"));
        let archive = b"legacy dictionary archive";
        let document = JobStoreDocument {
            schema_version: 1,
            jobs: vec![persisted_entry(
                "11111111111111111111111111111111",
                JobDescriptor::DictionaryImport {
                    staging_token: String::new(),
                    expected_sha256: String::new(),
                    original_display_name: String::new(),
                    bytes: 0,
                    legacy_source_file_name: Some("legacy.candordict".to_string()),
                    legacy_archive_base64: Some(STANDARD.encode(archive)),
                },
            )],
        };
        write_job_document(&persistence, &document).expect("legacy job store");

        let manager = JobManager::with_test_roots_and_staging(
            "test-protocol",
            persistence.root.clone(),
            persistence.key_root.clone(),
            &staging,
        );
        assert_eq!(
            manager.list().expect("migrated jobs")["persistenceState"],
            "encrypted"
        );
        let migrated = read_job_document(&persistence).expect("migrated document");
        assert_eq!(migrated.schema_version, JOB_STORE_SCHEMA_VERSION);
        let descriptor = migrated.jobs[0].descriptor.as_ref().expect("descriptor");
        let JobDescriptor::DictionaryImport {
            staging_token,
            expected_sha256,
            original_display_name,
            bytes,
            legacy_source_file_name,
            legacy_archive_base64,
        } = descriptor
        else {
            panic!("expected migrated dictionary descriptor");
        };
        assert!(!staging_token.is_empty());
        assert_eq!(original_display_name, "legacy.candordict");
        assert_eq!(*bytes, archive.len() as u64);
        assert!(legacy_source_file_name.is_none());
        assert!(legacy_archive_base64.is_none());
        assert_eq!(
            staging
                .read_verified(
                    staging_token,
                    expected_sha256,
                    *bytes,
                    original_display_name
                )
                .expect("staged archive"),
            archive
        );
        assert!(persistence
            .root
            .join(JOB_STORE_MIGRATION_BACKUP_FILE)
            .exists());

        drop(manager);
        let _next_launch = JobManager::with_test_roots_and_staging(
            "test-protocol",
            persistence.root.clone(),
            persistence.key_root.clone(),
            &staging,
        );
        assert!(!persistence
            .root
            .join(JOB_STORE_MIGRATION_BACKUP_FILE)
            .exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn interrupted_dictionary_migration_restores_rollback_backup_before_retrying() {
        let root = test_root("dictionary-migration-interrupted");
        let persistence = test_persistence(&root);
        let staging =
            DictionaryStaging::with_test_roots(root.join("dictionary-staging"), root.join("keys"));
        let document = JobStoreDocument {
            schema_version: 1,
            jobs: vec![persisted_entry(
                "12121212121212121212121212121212",
                JobDescriptor::DictionaryImport {
                    staging_token: String::new(),
                    expected_sha256: String::new(),
                    original_display_name: String::new(),
                    bytes: 0,
                    legacy_source_file_name: Some("interrupted.candordict".to_string()),
                    legacy_archive_base64: Some(STANDARD.encode(b"interrupted archive")),
                },
            )],
        };
        write_job_document(&persistence, &document).expect("legacy job store");
        let target = persistence.root.join(JOB_STORE_FILE);
        let migration_backup = persistence.root.join(JOB_STORE_MIGRATION_BACKUP_FILE);
        fs::copy(&target, &migration_backup).expect("migration rollback backup");
        fs::remove_file(&target).expect("simulate interrupted promotion");

        let manager = JobManager::with_test_roots_and_staging(
            "test-protocol",
            persistence.root.clone(),
            persistence.key_root.clone(),
            &staging,
        );

        let recovered_jobs = manager.list().expect("recovered jobs");
        assert_eq!(recovered_jobs["jobCount"], 1, "{recovered_jobs}");
        let recovered = read_job_document(&persistence).expect("recovered job store");
        assert_eq!(recovered.schema_version, JOB_STORE_SCHEMA_VERSION);
        assert_eq!(recovered.jobs.len(), 1);
        assert!(migration_backup.exists());
        let JobDescriptor::DictionaryImport {
            staging_token,
            legacy_archive_base64,
            ..
        } = recovered.jobs[0]
            .descriptor
            .as_ref()
            .expect("recovered descriptor")
        else {
            panic!("expected recovered dictionary descriptor");
        };
        assert!(!staging_token.is_empty());
        assert!(legacy_archive_base64.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn current_job_store_rejects_legacy_dictionary_archive_fields() {
        let root = test_root("dictionary-current-schema-legacy-data");
        let persistence = test_persistence(&root);
        let staging =
            DictionaryStaging::with_test_roots(root.join("dictionary-staging"), root.join("keys"));
        let document = JobStoreDocument {
            schema_version: JOB_STORE_SCHEMA_VERSION,
            jobs: vec![persisted_entry(
                "abababababababababababababababab",
                JobDescriptor::DictionaryImport {
                    staging_token: "a".repeat(64),
                    expected_sha256: "b".repeat(64),
                    original_display_name: "legacy.candordict".to_string(),
                    bytes: 12,
                    legacy_source_file_name: Some("legacy.candordict".to_string()),
                    legacy_archive_base64: Some(STANDARD.encode(b"legacy bytes")),
                },
            )],
        };
        write_job_document(&persistence, &document).expect("current job store fixture");
        let original = fs::read(persistence.root.join(JOB_STORE_FILE)).expect("original bytes");

        let manager = JobManager::with_test_roots_and_staging(
            "test-protocol",
            persistence.root.clone(),
            persistence.key_root.clone(),
            &staging,
        );
        assert_eq!(
            manager.list().expect("store status")["persistenceState"],
            "unavailable"
        );
        assert_eq!(
            fs::read(persistence.root.join(JOB_STORE_FILE)).expect("unchanged store"),
            original
        );
        let error = manager
            .submit_descriptor(
                JobDescriptor::Recap {
                    recording_id: "recording-legacy".to_string(),
                    recap_template: None,
                    mode: AiExecutionMode::LocalLlm,
                    fallback_policy: AiFallbackPolicy::AllowDisclosed,
                    legacy_quality: None,
                },
                executor(Arc::new(AtomicUsize::new(0))),
            )
            .expect_err("unsafe current-schema store must stay fail closed");
        assert_eq!(error.code, "JOB_STORE_LEGACY_DICTIONARY_DATA_REJECTED");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_dictionary_migration_restores_original_store_and_removes_staging() {
        let root = test_root("dictionary-migration-rollback");
        let persistence = test_persistence(&root);
        let staging_root = root.join("dictionary-staging");
        let staging = DictionaryStaging::with_test_roots(staging_root.clone(), root.join("keys"));
        let valid = JobDescriptor::DictionaryImport {
            staging_token: String::new(),
            expected_sha256: String::new(),
            original_display_name: String::new(),
            bytes: 0,
            legacy_source_file_name: Some("valid.candordict".to_string()),
            legacy_archive_base64: Some(STANDARD.encode(b"valid archive")),
        };
        let invalid = JobDescriptor::DictionaryImport {
            staging_token: String::new(),
            expected_sha256: String::new(),
            original_display_name: String::new(),
            bytes: 0,
            legacy_source_file_name: Some("invalid.candordict".to_string()),
            legacy_archive_base64: None,
        };
        let document = JobStoreDocument {
            schema_version: 1,
            jobs: vec![
                persisted_entry("22222222222222222222222222222222", valid),
                persisted_entry("33333333333333333333333333333333", invalid),
            ],
        };
        write_job_document(&persistence, &document).expect("legacy job store");
        let original = fs::read(persistence.root.join(JOB_STORE_FILE)).expect("original bytes");

        let manager = JobManager::with_test_roots_and_staging(
            "test-protocol",
            persistence.root.clone(),
            persistence.key_root.clone(),
            &staging,
        );
        assert_eq!(
            manager.list().expect("failed migration status")["persistenceState"],
            "unavailable"
        );
        assert_eq!(
            fs::read(persistence.root.join(JOB_STORE_FILE)).expect("restored store"),
            original
        );
        assert!(!persistence
            .root
            .join(JOB_STORE_MIGRATION_BACKUP_FILE)
            .exists());
        let staged_count = fs::read_dir(staging_root)
            .map(|entries| entries.filter_map(Result::ok).count())
            .unwrap_or_default();
        assert_eq!(staged_count, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_legacy_dictionary_migration_rolls_back_without_data_loss() {
        let root = test_root("dictionary-migration-oversized");
        let persistence = test_persistence(&root);
        let staging_root = root.join("dictionary-staging");
        let staging = DictionaryStaging::with_test_roots(staging_root.clone(), root.join("keys"));
        let oversized_archive = vec![0x5a; 2_500_001];
        let document = JobStoreDocument {
            schema_version: 1,
            jobs: vec![
                persisted_entry(
                    "44444444444444444444444444444444",
                    JobDescriptor::DictionaryImport {
                        staging_token: String::new(),
                        expected_sha256: String::new(),
                        original_display_name: String::new(),
                        bytes: 0,
                        legacy_source_file_name: Some("oversized.candordict".to_string()),
                        legacy_archive_base64: Some(STANDARD.encode(oversized_archive)),
                    },
                ),
                persisted_entry(
                    "55555555555555555555555555555555",
                    JobDescriptor::Recap {
                        recording_id: "recording-preserved".to_string(),
                        recap_template: None,
                        mode: AiExecutionMode::LocalLlm,
                        fallback_policy: AiFallbackPolicy::AllowDisclosed,
                        legacy_quality: None,
                    },
                ),
            ],
        };
        write_job_document(&persistence, &document).expect("legacy job store");
        let original = fs::read(persistence.root.join(JOB_STORE_FILE)).expect("original bytes");

        let manager = JobManager::with_test_roots_and_staging(
            "test-protocol",
            persistence.root.clone(),
            persistence.key_root.clone(),
            &staging,
        );
        let status = manager.list().expect("migration failure status");
        assert_eq!(status["persistenceState"], "unavailable");
        assert_eq!(
            status["persistenceFailureCode"],
            "JOB_STORE_MIGRATION_ARCHIVE_TOO_LARGE"
        );
        assert_eq!(
            fs::read(persistence.root.join(JOB_STORE_FILE)).expect("restored store"),
            original
        );
        assert!(!persistence
            .root
            .join(JOB_STORE_MIGRATION_BACKUP_FILE)
            .exists());
        let staged_count = fs::read_dir(staging_root)
            .map(|entries| entries.filter_map(Result::ok).count())
            .unwrap_or_default();
        assert_eq!(staged_count, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn retention_scrubs_questions_expires_staging_and_purges_terminal_jobs() {
        let root = test_root("retention");
        let persistence = test_persistence(&root);
        let staging =
            DictionaryStaging::with_test_roots(root.join("dictionary-staging"), root.join("keys"));
        let staged = staging
            .stage_bytes("retry.candordict", b"retry archive")
            .expect("stage dictionary");
        let manager = JobManager::with_test_roots_and_staging(
            "test-protocol",
            persistence.root.clone(),
            persistence.key_root.clone(),
            &staging,
        );
        let (ask_id, _) = manager
            .insert_job(
                "ask",
                true,
                Some(JobDescriptor::Ask {
                    recording_id: "recording-retention".to_string(),
                    question: "What dosage was discussed?".to_string(),
                    mode: AiExecutionMode::LocalLlm,
                    fallback_policy: AiFallbackPolicy::AllowDisclosed,
                    legacy_quality: None,
                }),
                None,
            )
            .expect("ask job");
        let (dictionary_id, _) = manager
            .insert_job(
                "dictionary-import",
                false,
                Some(JobDescriptor::DictionaryImport {
                    staging_token: staged.staging_token.clone(),
                    expected_sha256: staged.expected_sha256.clone(),
                    original_display_name: staged.original_display_name.clone(),
                    bytes: staged.bytes,
                    legacy_source_file_name: None,
                    legacy_archive_base64: None,
                }),
                None,
            )
            .expect("dictionary job");
        let (terminal_id, _) = manager
            .insert_job(
                "export",
                false,
                Some(JobDescriptor::Export { params: json!({}) }),
                None,
            )
            .expect("terminal job");
        {
            let mut jobs = manager.inner.jobs.lock().expect("jobs");
            let ask = jobs.get_mut(&ask_id).expect("ask");
            ask.state = JobState::Paused;
            ask.result = Some(json!({
                "question": "What dosage was discussed?",
                "answer": "A retained answer"
            }));
            ask.created_at_ms = now_ms().saturating_sub(ASK_QUESTION_RETENTION_MS + 1);
            ask.updated_at_ms = now_ms();
            let dictionary = jobs.get_mut(&dictionary_id).expect("dictionary");
            dictionary.state = JobState::Failed;
            dictionary.created_at_ms =
                now_ms().saturating_sub(RETRYABLE_DICTIONARY_STAGING_RETENTION_MS + 1);
            dictionary.updated_at_ms = now_ms();
            let terminal = jobs.get_mut(&terminal_id).expect("terminal");
            terminal.state = JobState::Completed;
            terminal.updated_at_ms = now_ms().saturating_sub(TERMINAL_JOB_RETENTION_MS + 1);
        }
        manager.persist().expect("aged jobs");

        let tokens = manager.apply_retention().expect("apply retention");
        assert_eq!(tokens, vec![staged.staging_token.clone()]);
        for token in tokens {
            staging.delete(&token).expect("delete expired staging");
        }
        {
            let jobs = manager.inner.jobs.lock().expect("jobs");
            let ask = jobs.get(&ask_id).expect("retained ask");
            let Some(JobDescriptor::Ask { question, .. }) = ask.descriptor.as_ref() else {
                panic!("expected Ask descriptor");
            };
            assert!(question.is_empty());
            assert_eq!(
                ask.result.as_ref().and_then(|value| value.get("question")),
                Some(&Value::Null)
            );
            assert_eq!(
                ask.result.as_ref().and_then(|value| value.get("answer")),
                Some(&Value::String("A retained answer".to_string()))
            );
            let dictionary = jobs
                .get(&dictionary_id)
                .expect("retained dictionary result");
            assert!(dictionary.descriptor.is_none());
            assert_eq!(dictionary.stage.as_deref(), Some("staging-expired"));
            assert_eq!(
                dictionary
                    .error
                    .as_ref()
                    .and_then(|value| value["code"].as_str()),
                Some("DICTIONARY_STAGING_EXPIRED")
            );
            assert!(!jobs.contains_key(&terminal_id));
        }
        assert!(staging
            .read_verified(
                &staged.staging_token,
                &staged.expected_sha256,
                staged.bytes,
                &staged.original_display_name,
            )
            .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn startup_retention_discards_staging_left_by_interrupted_cancellation() {
        let root = test_root("cancelled-dictionary-retention");
        let persistence = test_persistence(&root);
        let staging =
            DictionaryStaging::with_test_roots(root.join("dictionary-staging"), root.join("keys"));
        let staged = staging
            .stage_bytes("cancelled.candordict", b"cancelled archive")
            .expect("stage dictionary");
        let manager = JobManager::with_test_roots_and_staging(
            "test-protocol",
            persistence.root.clone(),
            persistence.key_root.clone(),
            &staging,
        );
        let (job_id, _) = manager
            .insert_job(
                "dictionary-import",
                false,
                Some(JobDescriptor::DictionaryImport {
                    staging_token: staged.staging_token.clone(),
                    expected_sha256: staged.expected_sha256.clone(),
                    original_display_name: staged.original_display_name.clone(),
                    bytes: staged.bytes,
                    legacy_source_file_name: None,
                    legacy_archive_base64: None,
                }),
                None,
            )
            .expect("dictionary job");
        {
            let mut jobs = manager.inner.jobs.lock().expect("jobs");
            finish_entry_cancelled(jobs.get_mut(&job_id).expect("dictionary"));
        }
        manager.persist().expect("cancelled state");

        let tokens = manager.apply_retention().expect("startup retention");
        let cancelled = manager.get(&job_id).expect("cancelled task");

        assert_eq!(tokens, vec![staged.staging_token]);
        assert_eq!(cancelled["state"], "cancelled");
        assert_eq!(cancelled["retryable"], false);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shutdown_without_active_jobs_does_not_require_job_store_access() {
        let root = test_root("shutdown-empty-corrupt-store");
        let jobs_root = root.join("jobs");
        fs::create_dir_all(&jobs_root).unwrap();
        fs::write(jobs_root.join(JOB_STORE_FILE), b"not-a-job-store").unwrap();
        let manager = JobManager::with_test_roots("test-protocol", jobs_root, root.join("keys"));

        let result = manager
            .pause_all_for_shutdown()
            .expect("an empty queue should shut down without rewriting job state");

        assert_eq!(result["pausedCount"], 0);
        assert_eq!(result["restartOnNextLaunch"], false);
        assert_eq!(manager.list().unwrap()["persistenceState"], "unavailable");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shutdown_rejects_new_jobs_after_the_empty_queue_check() {
        let manager = JobManager::new("test-protocol");
        let result = manager
            .pause_all_for_shutdown()
            .expect("an empty in-memory queue should shut down");
        assert_eq!(result["pausedCount"], 0);

        let error = manager
            .submit("late-work", false, |_| Ok(json!({ "completed": true })))
            .expect_err("shutdown must close the submission gate");

        assert_eq!(error.code, "JOB_SHUTDOWN_IN_PROGRESS");
        assert_eq!(manager.list().unwrap()["jobCount"], 0);
    }
}
