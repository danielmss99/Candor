use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::job_manager::{AiExecutionMode, AiFallbackPolicy};

const POLICY_SCHEMA_VERSION: u32 = 1;
const POLICY_FILE: &str = "ai-fallback-preference.json";
const POLICY_BACKUP_FILE: &str = "ai-fallback-preference.json.bak";
const POLICY_TEMP_FILE: &str = "ai-fallback-preference.json.tmp";
const MAX_POLICY_BYTES: u64 = 16 * 1024;

#[derive(Debug)]
pub struct AiFallbackPreferenceError {
    pub code: &'static str,
    pub message: String,
}

impl AiFallbackPreferenceError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiFallbackPreference {
    #[default]
    AskFirst,
    Automatic,
    Never,
}

impl AiFallbackPreference {
    pub fn id(self) -> &'static str {
        match self {
            Self::AskFirst => "ask-first",
            Self::Automatic => "automatic",
            Self::Never => "never",
        }
    }

    pub fn default_fallback_policy(self) -> AiFallbackPolicy {
        match self {
            Self::Automatic => AiFallbackPolicy::AllowDisclosed,
            Self::AskFirst | Self::Never => AiFallbackPolicy::RequireLocalLlm,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiJobIntent {
    #[default]
    Default,
    StrictRetry,
    ExplicitHeuristic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResolvedAiJobPolicy {
    pub mode: AiExecutionMode,
    pub fallback_policy: AiFallbackPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiFallbackPreferenceUpdateParams {
    pub preference: AiFallbackPreference,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredPreference {
    schema_version: u32,
    preference: AiFallbackPreference,
}

impl Default for StoredPreference {
    fn default() -> Self {
        Self {
            schema_version: POLICY_SCHEMA_VERSION,
            preference: AiFallbackPreference::AskFirst,
        }
    }
}

#[derive(Clone)]
pub struct AiFallbackPreferenceService {
    root: PathBuf,
    storage_lock: Arc<Mutex<()>>,
}

impl AiFallbackPreferenceService {
    pub fn with_root(root: PathBuf) -> Self {
        Self {
            root,
            storage_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn status(&self) -> Value {
        match self.load() {
            Ok(stored) => status_value(stored.preference, "ready", None),
            Err(error) => status_value(AiFallbackPreference::AskFirst, "corrupt", Some(error.code)),
        }
    }

    pub fn update(
        &self,
        params: AiFallbackPreferenceUpdateParams,
    ) -> Result<Value, AiFallbackPreferenceError> {
        let _guard = self.lock_storage()?;
        self.write_unlocked(&StoredPreference {
            schema_version: POLICY_SCHEMA_VERSION,
            preference: params.preference,
        })?;
        Ok(status_value(params.preference, "ready", None))
    }

    pub fn preference_or_safe_default(&self) -> AiFallbackPreference {
        self.load()
            .map(|stored| stored.preference)
            .unwrap_or(AiFallbackPreference::AskFirst)
    }

    pub fn resolve_intent(
        &self,
        intent: AiJobIntent,
    ) -> Result<ResolvedAiJobPolicy, AiFallbackPreferenceError> {
        let preference = self.preference_or_safe_default();
        match intent {
            AiJobIntent::Default => Ok(ResolvedAiJobPolicy {
                mode: AiExecutionMode::LocalLlm,
                fallback_policy: preference.default_fallback_policy(),
            }),
            AiJobIntent::StrictRetry => Ok(ResolvedAiJobPolicy {
                mode: AiExecutionMode::LocalLlm,
                fallback_policy: AiFallbackPolicy::RequireLocalLlm,
            }),
            AiJobIntent::ExplicitHeuristic if preference == AiFallbackPreference::Never => {
                Err(AiFallbackPreferenceError::new(
                    "HEURISTIC_FALLBACK_DISABLED",
                    "quick fallback is disabled by the Local AI fallback preference",
                ))
            }
            AiJobIntent::ExplicitHeuristic => Ok(ResolvedAiJobPolicy {
                mode: AiExecutionMode::HeuristicFallback,
                fallback_policy: AiFallbackPolicy::AllowDisclosed,
            }),
        }
    }

    fn load(&self) -> Result<StoredPreference, AiFallbackPreferenceError> {
        let _guard = self.lock_storage()?;
        self.load_unlocked()
    }

    fn load_unlocked(&self) -> Result<StoredPreference, AiFallbackPreferenceError> {
        let target = self.root.join(POLICY_FILE);
        if !target.exists() {
            return Ok(StoredPreference::default());
        }
        match read_preference(&target) {
            Ok(stored) => Ok(stored),
            Err(primary_error) => {
                let backup = self.root.join(POLICY_BACKUP_FILE);
                if backup.exists() {
                    read_preference(&backup).map_err(|_| primary_error)
                } else {
                    Err(primary_error)
                }
            }
        }
    }

    fn lock_storage(&self) -> Result<MutexGuard<'_, ()>, AiFallbackPreferenceError> {
        self.storage_lock.lock().map_err(|_| {
            AiFallbackPreferenceError::new(
                "AI_FALLBACK_PREFERENCE_LOCK_FAILED",
                "Local AI fallback settings are temporarily unavailable",
            )
        })
    }

    fn write_unlocked(&self, stored: &StoredPreference) -> Result<(), AiFallbackPreferenceError> {
        fs::create_dir_all(&self.root).map_err(|_| {
            AiFallbackPreferenceError::new(
                "AI_FALLBACK_PREFERENCE_DIR_FAILED",
                "Local AI fallback settings could not be prepared",
            )
        })?;
        let target = self.root.join(POLICY_FILE);
        let backup = self.root.join(POLICY_BACKUP_FILE);
        let temporary = self.root.join(POLICY_TEMP_FILE);
        if temporary.exists() {
            fs::remove_file(&temporary).map_err(|_| {
                AiFallbackPreferenceError::new(
                    "AI_FALLBACK_PREFERENCE_TEMP_FAILED",
                    "stale Local AI fallback settings could not be removed",
                )
            })?;
        }
        let payload = serde_json::to_vec_pretty(stored).map_err(|_| {
            AiFallbackPreferenceError::new(
                "AI_FALLBACK_PREFERENCE_SERIALIZE_FAILED",
                "Local AI fallback settings could not be encoded",
            )
        })?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| {
                AiFallbackPreferenceError::new(
                    "AI_FALLBACK_PREFERENCE_WRITE_FAILED",
                    "Local AI fallback settings could not be written",
                )
            })?;
        file.write_all(&payload)
            .and_then(|_| file.sync_all())
            .map_err(|_| {
                AiFallbackPreferenceError::new(
                    "AI_FALLBACK_PREFERENCE_WRITE_FAILED",
                    "Local AI fallback settings could not be written durably",
                )
            })?;
        drop(file);

        if backup.exists() {
            fs::remove_file(&backup).map_err(|_| {
                AiFallbackPreferenceError::new(
                    "AI_FALLBACK_PREFERENCE_BACKUP_FAILED",
                    "stale Local AI fallback settings backup could not be removed",
                )
            })?;
        }
        let had_target = target.exists();
        if had_target {
            fs::rename(&target, &backup).map_err(|_| {
                AiFallbackPreferenceError::new(
                    "AI_FALLBACK_PREFERENCE_BACKUP_FAILED",
                    "current Local AI fallback settings could not be backed up",
                )
            })?;
        }
        if fs::rename(&temporary, &target).is_err() {
            if had_target && backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(AiFallbackPreferenceError::new(
                "AI_FALLBACK_PREFERENCE_COMMIT_FAILED",
                "new Local AI fallback settings could not be committed",
            ));
        }
        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }
        Ok(())
    }
}

fn status_value(
    preference: AiFallbackPreference,
    state: &'static str,
    failure_code: Option<&'static str>,
) -> Value {
    json!({
        "implemented": true,
        "state": state,
        "preference": preference.id(),
        "userAuthorizationRequired": preference == AiFallbackPreference::AskFirst,
        "automaticFallback": preference == AiFallbackPreference::Automatic,
        "fallbackDisabled": preference == AiFallbackPreference::Never,
        "failureCode": failure_code,
        "localOnly": true,
        "cloudAi": false,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn read_preference(path: &Path) -> Result<StoredPreference, AiFallbackPreferenceError> {
    let metadata = fs::metadata(path).map_err(|_| {
        AiFallbackPreferenceError::new(
            "AI_FALLBACK_PREFERENCE_READ_FAILED",
            "Local AI fallback settings could not be read",
        )
    })?;
    if metadata.len() == 0 || metadata.len() > MAX_POLICY_BYTES {
        return Err(AiFallbackPreferenceError::new(
            "AI_FALLBACK_PREFERENCE_INVALID",
            "Local AI fallback settings have an invalid size",
        ));
    }
    let payload = fs::read(path).map_err(|_| {
        AiFallbackPreferenceError::new(
            "AI_FALLBACK_PREFERENCE_READ_FAILED",
            "Local AI fallback settings could not be read",
        )
    })?;
    let stored = serde_json::from_slice::<StoredPreference>(&payload).map_err(|_| {
        AiFallbackPreferenceError::new(
            "AI_FALLBACK_PREFERENCE_INVALID",
            "Local AI fallback settings are invalid",
        )
    })?;
    if stored.schema_version != POLICY_SCHEMA_VERSION {
        return Err(AiFallbackPreferenceError::new(
            "AI_FALLBACK_PREFERENCE_SCHEMA_UNSUPPORTED",
            "Local AI fallback settings use an unsupported schema",
        ));
    }
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "candor-ai-fallback-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn ask_first_is_the_safe_default() {
        let root = root("default");
        let service = AiFallbackPreferenceService::with_root(root.clone());
        let resolved = service
            .resolve_intent(AiJobIntent::Default)
            .expect("default policy");
        assert_eq!(resolved.mode, AiExecutionMode::LocalLlm);
        assert_eq!(resolved.fallback_policy, AiFallbackPolicy::RequireLocalLlm);
        assert_eq!(service.status()["preference"], "ask-first");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn automatic_and_never_preferences_persist() {
        let root = root("persist");
        let service = AiFallbackPreferenceService::with_root(root.clone());
        service
            .update(AiFallbackPreferenceUpdateParams {
                preference: AiFallbackPreference::Automatic,
            })
            .expect("save automatic");
        let automatic = service
            .resolve_intent(AiJobIntent::Default)
            .expect("automatic policy");
        assert_eq!(automatic.fallback_policy, AiFallbackPolicy::AllowDisclosed);

        service
            .update(AiFallbackPreferenceUpdateParams {
                preference: AiFallbackPreference::Never,
            })
            .expect("save never");
        assert_eq!(
            service
                .resolve_intent(AiJobIntent::ExplicitHeuristic)
                .unwrap_err()
                .code,
            "HEURISTIC_FALLBACK_DISABLED"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_preferences_fail_safe_to_ask_first() {
        let root = root("corrupt");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(POLICY_FILE), b"not-json").unwrap();
        let service = AiFallbackPreferenceService::with_root(root.clone());
        assert_eq!(
            service.preference_or_safe_default(),
            AiFallbackPreference::AskFirst
        );
        assert_eq!(service.status()["state"], "corrupt");
        assert_eq!(
            service
                .resolve_intent(AiJobIntent::Default)
                .expect("corrupt preference uses safe default")
                .fallback_policy,
            AiFallbackPolicy::RequireLocalLlm
        );
        let _ = fs::remove_dir_all(root);
    }
}
