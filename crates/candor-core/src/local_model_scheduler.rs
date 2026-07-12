use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

#[derive(Debug)]
pub struct LocalModelSchedulerError {
    pub code: &'static str,
    pub message: String,
}

impl LocalModelSchedulerError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum LocalModelJobKind {
    Whisper,
    Llm,
}

impl LocalModelJobKind {
    fn label(self) -> &'static str {
        match self {
            Self::Whisper => "whisper",
            Self::Llm => "llm",
        }
    }
}

#[derive(Clone, Debug)]
struct ActiveJob {
    id: u64,
    kind: LocalModelJobKind,
    owner: &'static str,
    started_at_ms: u128,
}

#[derive(Debug)]
pub struct LocalModelScheduler {
    next_job_id: u64,
    active: Option<ActiveJob>,
    ram_budget_mb: u32,
    vram_budget_mb: u32,
}

impl Default for LocalModelScheduler {
    fn default() -> Self {
        Self {
            next_job_id: 1,
            active: None,
            ram_budget_mb: 6_144,
            vram_budget_mb: 0,
        }
    }
}

impl LocalModelScheduler {
    pub fn status(&self) -> Value {
        json!({
            "implemented": true,
            "active": self.active.is_some(),
            "activeJob": self.active.as_ref().map(|job| json!({
                "id": job.id,
                "kind": job.kind.label(),
                "owner": job.owner,
                "startedAtMs": job.started_at_ms
            })),
            "singleLocalModelJob": true,
            "whisperLlmConcurrent": false,
            "budgets": {
                "ramBudgetMb": self.ram_budget_mb,
                "vramBudgetMb": self.vram_budget_mb,
                "policy": "deny-new-local-model-job-while-active"
            },
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    pub fn start_job(
        &mut self,
        kind: LocalModelJobKind,
        owner: &'static str,
    ) -> Result<u64, LocalModelSchedulerError> {
        if let Some(active) = &self.active {
            return Err(LocalModelSchedulerError::new(
                "LOCAL_MODEL_JOB_ACTIVE",
                format!(
                    "local model job '{}' is already active for {}",
                    active.kind.label(),
                    active.owner
                ),
            ));
        }

        let id = self.next_job_id;
        self.next_job_id = self.next_job_id.saturating_add(1).max(1);
        self.active = Some(ActiveJob {
            id,
            kind,
            owner,
            started_at_ms: now_ms(),
        });
        Ok(id)
    }

    pub fn finish_job(&mut self, id: u64) {
        if self.active.as_ref().is_some_and(|job| job.id == id) {
            self.active = None;
        }
    }

    pub fn proof_busy_denies_second_job(&mut self) -> Value {
        let first_job = self.start_job(LocalModelJobKind::Whisper, "scheduler.proof");
        let mut denied_code = None;
        let mut denied_message = None;
        let mut second_job_denied = false;

        if let Ok(job_id) = first_job {
            match self.start_job(LocalModelJobKind::Llm, "scheduler.proof") {
                Ok(second_id) => {
                    self.finish_job(second_id);
                }
                Err(error) => {
                    second_job_denied = true;
                    denied_code = Some(error.code);
                    denied_message = Some(error.message);
                }
            }
            self.finish_job(job_id);
        }

        json!({
            "proof": {
                "synthetic": true,
                "firstJob": "whisper",
                "secondJob": "llm",
                "secondJobDenied": second_job_denied,
                "deniedCode": denied_code,
                "deniedMessage": denied_message,
                "whisperLlmConcurrent": false,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            },
            "statusAfterProof": self.status(),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduler_denies_second_local_model_job() {
        let mut scheduler = LocalModelScheduler::default();
        let first = scheduler
            .start_job(LocalModelJobKind::Whisper, "unit-test")
            .expect("first job starts");
        let error = scheduler
            .start_job(LocalModelJobKind::Llm, "unit-test")
            .expect_err("second job is denied");

        assert_eq!(error.code, "LOCAL_MODEL_JOB_ACTIVE");
        assert_eq!(scheduler.status()["active"], true);

        scheduler.finish_job(first);
        assert_eq!(scheduler.status()["active"], false);
    }

    #[test]
    fn scheduler_proof_is_pathless() {
        let mut scheduler = LocalModelScheduler::default();
        let proof = scheduler.proof_busy_denies_second_job();

        assert_eq!(proof["proof"]["secondJobDenied"], true);
        assert_eq!(proof["proof"]["deniedCode"], "LOCAL_MODEL_JOB_ACTIVE");
        assert_eq!(proof["proof"]["rawPathExposed"], false);
        assert_eq!(proof["statusAfterProof"]["active"], false);
    }
}
