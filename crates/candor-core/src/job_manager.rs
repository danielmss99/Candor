use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use getrandom::getrandom;
use serde::Serialize;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const MAX_RETAINED_JOBS: usize = 256;

#[derive(Debug)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum JobState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl JobState {
    fn label(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobProgress {
    completed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unit: Option<String>,
}

#[derive(Clone, Debug)]
struct JobEntry {
    job_id: String,
    job_type: String,
    state: JobState,
    created_at: String,
    updated_at: String,
    stage: Option<String>,
    progress: Option<JobProgress>,
    result: Option<Value>,
    error: Option<Value>,
    cancel_requested: bool,
    cancellation: Arc<AtomicBool>,
}

impl JobEntry {
    fn value(&self, include_result: bool) -> Value {
        json!({
            "jobId": self.job_id,
            "type": self.job_type,
            "state": self.state.label(),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "stage": self.stage,
            "progress": self.progress,
            "result": if include_result { self.result.clone() } else { None },
            "error": self.error,
            "cancelRequested": self.cancel_requested,
            "terminal": self.state.terminal(),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreEvent<'a> {
    protocol_version: &'static str,
    event: &'a str,
    payload: Value,
}

struct JobManagerInner {
    protocol_version: &'static str,
    jobs: Mutex<HashMap<String, JobEntry>>,
    inference_gate: Mutex<()>,
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

impl JobManager {
    pub fn new(protocol_version: &'static str) -> Self {
        Self {
            inner: Arc::new(JobManagerInner {
                protocol_version,
                jobs: Mutex::new(HashMap::new()),
                inference_gate: Mutex::new(()),
            }),
        }
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
        let job_id = new_job_id()?;
        let created_at = timestamp();
        let cancellation = Arc::new(AtomicBool::new(false));
        let entry = JobEntry {
            job_id: job_id.clone(),
            job_type: job_type.to_string(),
            state: JobState::Queued,
            created_at: created_at.clone(),
            updated_at: created_at.clone(),
            stage: Some("queued".to_string()),
            progress: Some(JobProgress {
                completed: 0,
                total: Some(1),
                unit: Some("job".to_string()),
            }),
            result: None,
            error: None,
            cancel_requested: false,
            cancellation: cancellation.clone(),
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
        }
        self.emit(&job_id);

        let manager = self.clone();
        let worker_job_id = job_id.clone();
        thread::spawn(move || {
            manager.set_running(&worker_job_id);
            let context = JobContext {
                manager: manager.clone(),
                job_id: worker_job_id.clone(),
                cancellation,
            };
            if context.cancelled() {
                manager.finish_cancelled(&worker_job_id);
                return;
            }

            let result = if exclusive_inference {
                match manager.inner.inference_gate.lock() {
                    Ok(_guard) => {
                        if context.cancelled() {
                            manager.finish_cancelled(&worker_job_id);
                            return;
                        }
                        task(context.clone())
                    }
                    Err(_) => Err(JobFailure::new(
                        "LOCAL_MODEL_SCHEDULER_UNAVAILABLE",
                        "local model scheduling is unavailable",
                        true,
                    )),
                }
            } else {
                task(context.clone())
            };

            if context.cancelled() {
                manager.finish_cancelled(&worker_job_id);
                return;
            }
            match result {
                Ok(value) => manager.finish_completed(&worker_job_id, value),
                Err(error) => manager.finish_failed(&worker_job_id, error),
            }
        });

        Ok(json!({
            "jobId": job_id,
            "type": job_type,
            "state": "queued",
            "createdAt": created_at,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
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
        Ok(json!({
            "jobs": values,
            "jobCount": values.len(),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
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
            entry.updated_at = timestamp();
            entry.stage = Some("cancelling".to_string());
            entry.cancellation.store(true, Ordering::SeqCst);
            entry.value(false)
        };
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
        Ok(json!({
            "jobId": job_id,
            "acknowledged": removed,
            "rawPathExposed": false
        }))
    }

    fn set_running(&self, job_id: &str) {
        self.mutate(job_id, |entry| {
            entry.state = JobState::Running;
            entry.stage = Some("starting".to_string());
            entry.updated_at = timestamp();
        });
    }

    fn update_progress(&self, job_id: &str, stage: &str, progress: JobProgress) {
        self.mutate(job_id, |entry| {
            entry.stage = Some(stage.to_string());
            entry.progress = Some(progress);
            entry.updated_at = timestamp();
        });
    }

    fn finish_completed(&self, job_id: &str, result: Value) {
        self.mutate(job_id, |entry| {
            entry.state = JobState::Completed;
            entry.stage = Some("completed".to_string());
            entry.progress = Some(JobProgress {
                completed: 1,
                total: Some(1),
                unit: Some("job".to_string()),
            });
            entry.result = Some(result);
            entry.updated_at = timestamp();
        });
    }

    fn finish_failed(&self, job_id: &str, failure: JobFailure) {
        self.mutate(job_id, |entry| {
            entry.state = JobState::Failed;
            entry.stage = Some("failed".to_string());
            entry.error = Some(json!({
                "code": failure.code,
                "title": "Local operation failed",
                "message": safe_failure_message(&entry.job_type, &failure.message),
                "retryable": failure.retryable,
                "severity": "error",
                "correlationId": entry.job_id,
                "rawPathExposed": false
            }));
            entry.updated_at = timestamp();
        });
    }

    fn finish_cancelled(&self, job_id: &str) {
        self.mutate(job_id, |entry| {
            entry.state = JobState::Cancelled;
            entry.stage = Some("cancelled".to_string());
            entry.cancel_requested = true;
            entry.updated_at = timestamp();
        });
    }

    fn mutate(&self, job_id: &str, update: impl FnOnce(&mut JobEntry)) {
        if let Ok(mut jobs) = self.inner.jobs.lock() {
            if let Some(entry) = jobs.get_mut(job_id) {
                update(entry);
            }
        }
        self.emit(job_id);
    }

    fn emit(&self, job_id: &str) {
        let payload = self
            .inner
            .jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(job_id).map(|entry| entry.value(false)));
        if let Some(payload) = payload {
            crate::write_protocol_value(&CoreEvent {
                protocol_version: self.inner.protocol_version,
                event: "jobs.changed",
                payload,
            });
        }
    }
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

fn safe_failure_message(job_type: &str, _message: &str) -> String {
    match job_type {
        "transcription" => "Local transcription could not be completed.".to_string(),
        "recap" | "ask" => "Local AI could not complete this request.".to_string(),
        "export" => "The local report could not be created.".to_string(),
        "import" => "The local import could not be completed.".to_string(),
        "model-verification" => "The local model could not be verified.".to_string(),
        _ => "The local operation could not be completed.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn wait_for_terminal(manager: &JobManager, job_id: &str) -> Value {
        for _ in 0..100 {
            let value = manager.get(job_id).expect("job status");
            if value["terminal"] == true {
                return value;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("job did not reach a terminal state");
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
    }
}
