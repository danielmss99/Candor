use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};
use getrandom::getrandom;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::os_key_store;

const MAX_RETAINED_JOBS: usize = 256;
const JOB_STORE_SCHEMA_VERSION: u32 = 1;
const JOB_STORE_FILE: &str = "background-jobs.bin";
const JOB_STORE_BACKUP_FILE: &str = "background-jobs.bin.bak";
const JOB_STORE_TEMP_FILE: &str = "background-jobs.bin.tmp";
const JOB_STORE_MAGIC: &[u8] = b"candor-jobs-v1\0";
const JOB_STORE_AAD: &[u8] = b"candor-background-jobs-v1";
const JOB_STORE_KEY_LABEL: &[u8] = b"candor-background-jobs-v1";
const NONCE_BYTES: usize = 12;
const MAX_JOB_STORE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PERSISTED_RESULT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug)]
pub struct JobManagerError {
    pub code: &'static str,
    pub message: String,
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
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobQuality {
    #[default]
    Fast,
    Best,
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
    Recap {
        recording_id: String,
        #[serde(default)]
        quality: JobQuality,
    },
    Ask {
        recording_id: String,
        question: String,
        #[serde(default)]
        quality: JobQuality,
    },
    Export {
        params: Value,
    },
    DictionaryImport {
        source_file_name: String,
        archive_base64: String,
    },
    DictionaryIndex {
        dictionary_id: String,
    },
}

impl JobDescriptor {
    pub fn job_type(&self) -> &'static str {
        match self {
            Self::Transcription { .. } => "transcription",
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
            | Self::Recap { recording_id, .. }
            | Self::Ask { recording_id, .. } => Some(recording_id),
            Self::Export { params } => params.get("recordingId").and_then(Value::as_str),
            Self::DictionaryImport { .. } | Self::DictionaryIndex { .. } => None,
        }
    }

    fn exclusive_inference(&self) -> bool {
        matches!(
            self,
            Self::Transcription { .. } | Self::Recap { .. } | Self::Ask { .. }
        )
    }

    fn scheduling_priority(&self) -> u8 {
        match self {
            Self::Transcription { .. } => 60,
            Self::Recap { .. } | Self::Ask { .. } => 50,
            Self::Export { .. } => 40,
            Self::DictionaryImport { .. } | Self::DictionaryIndex { .. } => 10,
        }
    }

    fn follow_up(&self) -> Option<JobDescriptor> {
        match self {
            Self::Transcription { follow_up, .. } => follow_up.as_deref().cloned(),
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
        let mut cancel_requested = false;
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
        let retryable = self.descriptor.is_some()
            && (self.state == JobState::Paused
                || self
                    .error
                    .as_ref()
                    .and_then(|value| value.get("retryable"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false));
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

impl JobManager {
    #[cfg(test)]
    pub fn new(protocol_version: &'static str) -> Self {
        Self::build(protocol_version, None)
    }

    pub fn with_roots(protocol_version: &'static str, root: PathBuf, key_root: PathBuf) -> Self {
        Self::build(
            protocol_version,
            Some(JobPersistence {
                root,
                key_root,
                #[cfg(test)]
                test_key: None,
            }),
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
        )
    }

    fn build(protocol_version: &'static str, persistence: Option<JobPersistence>) -> Self {
        let mut persistence_error = None;
        let mut jobs = HashMap::new();
        if let Some(config) = persistence.as_ref() {
            match read_job_document(config) {
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
        self.spawn_once(job_id, exclusive_inference, task);
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
        if descriptor.is_some() {
            self.require_persistence_ready()?;
        }
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
            progress: Some(JobProgress {
                completed: 0,
                total: Some(1),
                unit: Some("job".to_string()),
            }),
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
        let ids = {
            let mut jobs = self.inner.jobs.lock().map_err(|_| {
                JobManagerError::new("JOB_STORE_UNAVAILABLE", "local job store is unavailable")
            })?;
            let mut ids = Vec::new();
            for entry in jobs.values_mut().filter(|entry| !entry.state.terminal()) {
                entry.cancel_requested = true;
                entry.preempt_requested = false;
                entry.shutdown_pause_requested = false;
                entry.cancellation.store(true, Ordering::SeqCst);
                entry.state = JobState::Cancelled;
                entry.stage = Some("cancelled".to_string());
                entry.updated_at = timestamp();
                entry.updated_at_ms = now_ms();
                ids.push(entry.job_id.clone());
            }
            ids
        };
        self.persist()?;
        self.inner.priority_changed.notify_all();
        for job_id in &ids {
            self.emit(job_id);
        }
        Ok(json!({
            "cancelRequestedCount": ids.len(),
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
            if !entry.state.terminal() && entry.state != JobState::Paused {
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
            entry.progress = Some(JobProgress {
                completed: 0,
                total: Some(1),
                unit: Some("job".to_string()),
            });
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

    pub fn acknowledge(&self, job_id: &str) -> Result<Value, JobManagerError> {
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
            jobs.remove(job_id).is_some()
        };
        self.persist_best_effort();
        Ok(json!({
            "jobId": job_id,
            "acknowledged": removed,
            "rawPathExposed": false
        }))
    }

    pub fn set_recording_active(&self, active: bool) {
        self.inner.recording_active.store(active, Ordering::SeqCst);
        let mut changed = Vec::new();
        if active {
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
                } else {
                    entry.state = JobState::Paused;
                    entry.stage = Some("recording-priority".to_string());
                }
                changed.push(entry.job_id.clone());
            }
        }
        self.persist_best_effort();
        self.inner.priority_changed.notify_all();
        for job_id in changed {
            self.emit(&job_id);
        }
    }

    fn spawn_once<F>(&self, job_id: String, exclusive_inference: bool, task: F)
    where
        F: FnOnce(JobContext) -> Result<Value, JobFailure> + Send + 'static,
    {
        if !self.claim_worker(&job_id) {
            return;
        }
        let manager = self.clone();
        thread::spawn(move || {
            let gate = manager.wait_for_priority(&job_id, exclusive_inference);
            if !matches!(gate, WorkerGate::Ready) {
                if matches!(gate, WorkerGate::Cancelled) {
                    manager.finish_cancelled(&job_id);
                }
                manager.release_worker(&job_id);
                return;
            }
            let Some(context) = manager.context(&job_id) else {
                manager.release_worker(&job_id);
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
            if manager.user_cancel_requested(&job_id) || context.cancelled() {
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
                    Ok(value) => manager.finish_completed(&job_id, value),
                    Err(error) => manager.finish_failed(&job_id, error),
                }
            }
            manager.release_worker(&job_id);
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
                        manager.finish_completed(&job_id, value);
                        if let Some(follow_up) = descriptor.follow_up() {
                            let _ = manager.submit_follow_up(&job_id, follow_up, executor.clone());
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

    fn finish_completed(&self, job_id: &str, result: Value) {
        self.mutate(job_id, |entry| {
            if entry.state == JobState::Cancelled {
                return;
            }
            entry.state = JobState::Completed;
            entry.stage = Some("completed".to_string());
            entry.progress = Some(JobProgress {
                completed: 1,
                total: Some(1),
                unit: Some("job".to_string()),
            });
            entry.result = Some(result);
            entry.error = None;
            entry.cancel_requested = false;
            entry.preempt_requested = false;
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
        });
    }

    fn finish_failed(&self, job_id: &str, failure: JobFailure) {
        self.mutate(job_id, |entry| {
            if entry.state == JobState::Cancelled {
                return;
            }
            entry.state = JobState::Failed;
            entry.stage = Some("failed".to_string());
            entry.error = Some(job_error_value(&entry.job_id, &entry.job_type, failure));
            entry.cancel_requested = false;
            entry.preempt_requested = false;
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
        });
    }

    fn finish_cancelled(&self, job_id: &str) {
        self.mutate(job_id, |entry| {
            entry.state = JobState::Cancelled;
            entry.stage = Some("cancelled".to_string());
            entry.cancel_requested = true;
            entry.preempt_requested = false;
            entry.updated_at = timestamp();
            entry.updated_at_ms = now_ms();
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
        write_job_document(config, &document)
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

fn read_job_document(config: &JobPersistence) -> Result<JobStoreDocument, JobManagerError> {
    let target = config.root.join(JOB_STORE_FILE);
    if !target.exists() {
        return Ok(JobStoreDocument::default());
    }
    let metadata = fs::metadata(&target).map_err(|_| {
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
    File::open(&target)
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
    if document.schema_version != JOB_STORE_SCHEMA_VERSION
        || document.jobs.len() > MAX_RETAINED_JOBS
    {
        return Err(JobManagerError::new(
            "JOB_STORE_SCHEMA_UNSUPPORTED",
            "local job state uses an unsupported schema",
        ));
    }
    Ok(document)
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
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
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
    let _ = fs::remove_file(&backup);
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

    #[test]
    fn jobs_remain_queryable_until_acknowledged() {
        let manager = JobManager::new("test-protocol");
        let accepted = manager
            .submit("export", false, |context| {
                context.progress("rendering", 1, Some(2), Some("stage"));
                Ok(json!({ "format": "markdown", "rawPathExposed": false }))
            })
            .expect("accepted job");
        let job_id = accepted["jobId"].as_str().expect("job id");
        let completed = wait_for_terminal(&manager, job_id);
        assert_eq!(completed["state"], "completed");
        assert_eq!(completed["result"]["format"], "markdown");
        assert_eq!(manager.acknowledge(job_id).unwrap()["acknowledged"], true);
        assert_eq!(manager.get(job_id).unwrap_err().code, "JOB_NOT_FOUND");
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
    fn oversized_descriptor_is_rejected_without_poisoning_the_job_store() {
        let root = test_root("descriptor-capacity");
        let manager =
            JobManager::with_test_roots("test-protocol", root.join("jobs"), root.join("keys"));
        let archive_base64 = "A".repeat(3_333_352);
        let mut accepted_ids = Vec::new();
        for index in 0..5 {
            let (job_id, _) = manager
                .insert_job(
                    "dictionary-import",
                    false,
                    Some(JobDescriptor::DictionaryImport {
                        source_file_name: format!("pack-{index}.candordict"),
                        archive_base64: archive_base64.clone(),
                    }),
                    None,
                )
                .expect("descriptor fits within the bounded store");
            accepted_ids.push(job_id);
        }
        let error = manager
            .insert_job(
                "dictionary-import",
                false,
                Some(JobDescriptor::DictionaryImport {
                    source_file_name: "pack-overflow.candordict".to_string(),
                    archive_base64,
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
                    quality: JobQuality::Fast,
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
                    quality: JobQuality::Fast,
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
                    quality: JobQuality::Fast,
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
                        quality: JobQuality::Fast,
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
                    quality: JobQuality::Fast,
                },
                executor(Arc::new(AtomicUsize::new(0))),
            )
            .expect_err("corrupt store must block persisted jobs");
        assert_eq!(error.code, "JOB_STORE_CORRUPT");
        assert_eq!(manager.list().unwrap()["persistenceState"], "unavailable");
        let _ = fs::remove_dir_all(root);
    }
}
