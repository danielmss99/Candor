use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const RULE_STORE_SCHEMA_VERSION: u32 = 1;
const RULE_SET_SCHEMA_VERSION: u32 = 1;
const RULE_STORE_FILE: &str = "replacement-rules.json";
const RULE_STORE_BACKUP_FILE: &str = "replacement-rules.json.bak";
const RULE_STORE_TEMP_FILE: &str = "replacement-rules.json.tmp";
const MAX_RULE_STORE_BYTES: u64 = 1024 * 1024;
const MAX_CUSTOM_RULE_SETS: usize = 16;
const MAX_RULES_PER_SET: usize = 64;
const MAX_ID_BYTES: usize = 64;
const MAX_SET_NAME_BYTES: usize = 80;
const MAX_LITERAL_BYTES: usize = 128;
const MAX_REPLACEMENT_BYTES: usize = 512;
const MAX_INPUT_BYTES: usize = 256 * 1024;
const MAX_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_RULE_ORDER: u32 = 10_000;

static RULE_SET_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub struct ReplacementRuleError {
    pub code: &'static str,
    pub message: String,
}

impl ReplacementRuleError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReplacementMatchMode {
    Exact,
    WholeWord,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementRule {
    pub id: String,
    pub order: u32,
    pub match_mode: ReplacementMatchMode,
    pub literal: String,
    pub replacement: String,
    #[serde(default)]
    pub protected_term_review: bool,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementRuleSet {
    pub schema_version: u32,
    pub version: u32,
    pub id: String,
    pub name: String,
    pub rules: Vec<ReplacementRule>,
    pub built_in: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementRuleSetUpsertParams {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub expected_version: Option<u32>,
    pub name: String,
    #[serde(default)]
    pub rules: Vec<ReplacementRule>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementRuleSetGetParams {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementRuleSetDeleteParams {
    pub id: String,
    pub expected_version: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementPreviewParams {
    pub set_id: String,
    pub input: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementApplyParams {
    pub set_id: String,
    pub input: String,
    pub preview_token: String,
    #[serde(default)]
    pub approve_protected_terms: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementChange {
    pub rule_id: String,
    pub rule_order: u32,
    pub replacement_count: u32,
    pub protected_term_review: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplacementPreviewOutcome {
    pub normalized_text: String,
    pub preview_token: String,
    pub changes: Vec<ReplacementChange>,
    pub replacement_count: u32,
    pub protected_term_review_required: bool,
}

#[cfg(any(feature = "local-whisper", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TranscriptReplacementOutcome {
    pub(crate) normalized_text: String,
    pub(crate) automatic_changes: Vec<ReplacementChange>,
    pub(crate) protected_term_matches: Vec<ReplacementChange>,
    pub(crate) automatic_replacement_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProtectedTermApplication {
    pub(crate) normalized_text: String,
    pub(crate) changes: Vec<ReplacementChange>,
    pub(crate) replacement_count: u32,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRuleSets {
    schema_version: u32,
    custom_rule_sets: Vec<ReplacementRuleSet>,
}

impl StoredRuleSets {
    fn empty() -> Self {
        Self {
            schema_version: RULE_STORE_SCHEMA_VERSION,
            custom_rule_sets: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct ReplacementRuleService {
    root: PathBuf,
    storage_lock: Arc<Mutex<()>>,
}

impl ReplacementRuleService {
    pub fn with_root(root: PathBuf) -> Self {
        Self {
            root,
            storage_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn list(&self) -> Result<Value, ReplacementRuleError> {
        let stored = self.load()?;
        let mut rule_sets = built_in_rule_sets();
        rule_sets.extend(stored.custom_rule_sets);
        let rule_set_count = rule_sets.len();
        Ok(json!({
            "implemented": true,
            "schemaVersion": RULE_STORE_SCHEMA_VERSION,
            "ruleSets": rule_sets,
            "ruleSetCount": rule_set_count,
            "customRuleSetLimit": MAX_CUSTOM_RULE_SETS,
            "ruleLimitPerSet": MAX_RULES_PER_SET,
            "separateFromAsrVocabularyHints": true,
            "asrVocabularyHintsApplied": false,
            "localOnly": true,
            "networkAttempted": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn get(&self, params: ReplacementRuleSetGetParams) -> Result<Value, ReplacementRuleError> {
        let rule_set = self.resolve(&params.id)?;
        Ok(rule_set_response(rule_set))
    }

    pub fn resolve(&self, id: &str) -> Result<ReplacementRuleSet, ReplacementRuleError> {
        validate_safe_id(id, "replacement rule set")?;
        if let Some(rule_set) = built_in_rule_sets()
            .into_iter()
            .find(|rule_set| rule_set.id == id)
        {
            return Ok(rule_set);
        }
        self.load()?
            .custom_rule_sets
            .into_iter()
            .find(|rule_set| rule_set.id == id)
            .ok_or_else(|| {
                ReplacementRuleError::new(
                    "REPLACEMENT_RULE_SET_NOT_FOUND",
                    "the requested replacement rule set does not exist",
                )
            })
    }

    pub fn upsert_custom(
        &self,
        params: ReplacementRuleSetUpsertParams,
    ) -> Result<Value, ReplacementRuleError> {
        validate_rule_set_input(&params)?;
        let _guard = self.lock_storage()?;
        let mut stored = self.load_unlocked()?;
        let requested_id = params.id.as_deref();
        if requested_id.is_some_and(is_built_in_id) {
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_RULE_SET_BUILT_IN_IMMUTABLE",
                "built-in replacement rule sets cannot be changed",
            ));
        }
        let existing_index = requested_id.and_then(|id| {
            stored
                .custom_rule_sets
                .iter()
                .position(|rule_set| rule_set.id == id)
        });
        let (id, version) = if let Some(index) = existing_index {
            let existing = &stored.custom_rule_sets[index];
            if params.expected_version != Some(existing.version) {
                return Err(ReplacementRuleError::new(
                    "REPLACEMENT_RULE_SET_VERSION_CONFLICT",
                    "the replacement rule set changed before this update was saved",
                ));
            }
            (
                existing.id.clone(),
                existing.version.checked_add(1).ok_or_else(|| {
                    ReplacementRuleError::new(
                        "REPLACEMENT_RULE_SET_VERSION_LIMIT",
                        "the replacement rule set version limit was reached",
                    )
                })?,
            )
        } else {
            if params.expected_version.is_some() {
                return Err(ReplacementRuleError::new(
                    "REPLACEMENT_RULE_SET_NOT_FOUND",
                    "the replacement rule set to update does not exist",
                ));
            }
            if stored.custom_rule_sets.len() >= MAX_CUSTOM_RULE_SETS {
                return Err(ReplacementRuleError::new(
                    "REPLACEMENT_RULE_SET_LIMIT_REACHED",
                    format!("at most {MAX_CUSTOM_RULE_SETS} custom rule sets are allowed"),
                ));
            }
            let id = requested_id
                .map(str::to_string)
                .unwrap_or_else(|| next_rule_set_id(&stored));
            (id, 1)
        };

        let mut rules = params.rules;
        rules.sort_by(|left, right| {
            left.order
                .cmp(&right.order)
                .then_with(|| left.id.cmp(&right.id))
        });
        let rule_set = ReplacementRuleSet {
            schema_version: RULE_SET_SCHEMA_VERSION,
            version,
            id,
            name: params.name.trim().to_string(),
            rules,
            built_in: false,
        };
        validate_rule_set(&rule_set)?;
        if let Some(index) = existing_index {
            stored.custom_rule_sets[index] = rule_set.clone();
        } else {
            stored.custom_rule_sets.push(rule_set.clone());
        }
        stored
            .custom_rule_sets
            .sort_by(|left, right| left.id.cmp(&right.id));
        self.write_unlocked(&stored)?;
        Ok(rule_set_response(rule_set))
    }

    pub fn delete_custom(
        &self,
        params: ReplacementRuleSetDeleteParams,
    ) -> Result<Value, ReplacementRuleError> {
        validate_safe_id(&params.id, "replacement rule set")?;
        if is_built_in_id(&params.id) {
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_RULE_SET_BUILT_IN_IMMUTABLE",
                "built-in replacement rule sets cannot be deleted",
            ));
        }
        let _guard = self.lock_storage()?;
        let mut stored = self.load_unlocked()?;
        let index = stored
            .custom_rule_sets
            .iter()
            .position(|rule_set| rule_set.id == params.id)
            .ok_or_else(|| {
                ReplacementRuleError::new(
                    "REPLACEMENT_RULE_SET_NOT_FOUND",
                    "the replacement rule set to delete does not exist",
                )
            })?;
        if stored.custom_rule_sets[index].version != params.expected_version {
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_RULE_SET_VERSION_CONFLICT",
                "the replacement rule set changed before it could be deleted",
            ));
        }
        let removed = stored.custom_rule_sets.remove(index);
        self.write_unlocked(&stored)?;
        Ok(json!({
            "implemented": true,
            "deleted": true,
            "id": removed.id,
            "separateFromAsrVocabularyHints": true,
            "asrVocabularyHintsApplied": false,
            "localOnly": true,
            "networkAttempted": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn preview(&self, params: ReplacementPreviewParams) -> Result<Value, ReplacementRuleError> {
        let outcome = self.preview_outcome(&params.set_id, &params.input)?;
        Ok(preview_response(outcome, false))
    }

    pub fn apply(&self, params: ReplacementApplyParams) -> Result<Value, ReplacementRuleError> {
        if params.preview_token.len() != 64
            || !params
                .preview_token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_PREVIEW_REQUIRED",
                "a valid preview is required before replacements can be applied",
            ));
        }
        let outcome = self.preview_outcome(&params.set_id, &params.input)?;
        if outcome.preview_token != params.preview_token {
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_PREVIEW_REQUIRED",
                "the text or rule set changed after the replacement preview",
            ));
        }
        if outcome.protected_term_review_required && !params.approve_protected_terms {
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_PROTECTED_TERM_REVIEW_REQUIRED",
                "protected-term changes must be approved after preview",
            ));
        }
        Ok(preview_response(outcome, true))
    }

    pub fn preview_outcome(
        &self,
        set_id: &str,
        input: &str,
    ) -> Result<ReplacementPreviewOutcome, ReplacementRuleError> {
        validate_input(input)?;
        let rule_set = self.resolve(set_id)?;
        compute_preview(&rule_set, input)
    }

    fn load(&self) -> Result<StoredRuleSets, ReplacementRuleError> {
        let _guard = self.lock_storage()?;
        self.load_unlocked()
    }

    fn load_unlocked(&self) -> Result<StoredRuleSets, ReplacementRuleError> {
        let target = self.root.join(RULE_STORE_FILE);
        let backup = self.root.join(RULE_STORE_BACKUP_FILE);
        if !target.exists() {
            if backup.exists() {
                let stored = read_store(&backup)?;
                fs::rename(&backup, &target).map_err(|_| {
                    ReplacementRuleError::new(
                        "REPLACEMENT_RULE_BACKUP_FAILED",
                        "replacement rules could not be restored after an interrupted write",
                    )
                })?;
                return Ok(stored);
            }
            return Ok(StoredRuleSets::empty());
        }
        match read_store(&target) {
            Ok(stored) => Ok(stored),
            Err(primary_error) => {
                if backup.exists() {
                    read_store(&backup).map_err(|_| primary_error)
                } else {
                    Err(primary_error)
                }
            }
        }
    }

    fn lock_storage(&self) -> Result<MutexGuard<'_, ()>, ReplacementRuleError> {
        self.storage_lock.lock().map_err(|_| {
            ReplacementRuleError::new(
                "REPLACEMENT_RULE_LOCK_FAILED",
                "replacement rules are temporarily unavailable",
            )
        })
    }

    fn write_unlocked(&self, stored: &StoredRuleSets) -> Result<(), ReplacementRuleError> {
        validate_store(stored)?;
        let payload = serde_json::to_vec_pretty(stored).map_err(|_| {
            ReplacementRuleError::new(
                "REPLACEMENT_RULE_SERIALIZE_FAILED",
                "replacement rules could not be encoded",
            )
        })?;
        if payload.is_empty() || payload.len() as u64 > MAX_RULE_STORE_BYTES {
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_RULE_STORE_LIMIT",
                "replacement rules exceed the local storage limit",
            ));
        }
        fs::create_dir_all(&self.root).map_err(|_| {
            ReplacementRuleError::new(
                "REPLACEMENT_RULE_DIR_FAILED",
                "replacement rule storage could not be prepared",
            )
        })?;
        let target = self.root.join(RULE_STORE_FILE);
        let backup = self.root.join(RULE_STORE_BACKUP_FILE);
        let temporary = self.root.join(RULE_STORE_TEMP_FILE);
        if temporary.exists() {
            fs::remove_file(&temporary).map_err(|_| {
                ReplacementRuleError::new(
                    "REPLACEMENT_RULE_TEMP_FAILED",
                    "stale temporary replacement rules could not be removed",
                )
            })?;
        }
        let write_result = write_private_file(&temporary, &payload);
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        if backup.exists() {
            fs::remove_file(&backup).map_err(|_| {
                ReplacementRuleError::new(
                    "REPLACEMENT_RULE_BACKUP_FAILED",
                    "stale replacement rule backup could not be removed",
                )
            })?;
        }
        let had_target = target.exists();
        if had_target {
            fs::rename(&target, &backup).map_err(|_| {
                ReplacementRuleError::new(
                    "REPLACEMENT_RULE_BACKUP_FAILED",
                    "current replacement rules could not be backed up",
                )
            })?;
        }
        if fs::rename(&temporary, &target).is_err() {
            if had_target && backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            let _ = fs::remove_file(&temporary);
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_RULE_COMMIT_FAILED",
                "new replacement rules could not be committed",
            ));
        }
        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }
        Ok(())
    }
}

fn default_enabled() -> bool {
    true
}

fn write_private_file(path: &Path, payload: &[u8]) -> Result<(), ReplacementRuleError> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| {
        ReplacementRuleError::new(
            "REPLACEMENT_RULE_WRITE_FAILED",
            "replacement rules could not be written",
        )
    })?;
    file.write_all(payload)
        .and_then(|_| file.sync_all())
        .map_err(|_| {
            ReplacementRuleError::new(
                "REPLACEMENT_RULE_WRITE_FAILED",
                "replacement rules could not be written durably",
            )
        })
}

fn read_store(path: &Path) -> Result<StoredRuleSets, ReplacementRuleError> {
    let metadata = fs::metadata(path).map_err(|_| {
        ReplacementRuleError::new(
            "REPLACEMENT_RULE_READ_FAILED",
            "replacement rules could not be read",
        )
    })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_RULE_STORE_BYTES {
        return Err(ReplacementRuleError::new(
            "REPLACEMENT_RULE_STORE_INVALID",
            "replacement rule storage has an invalid size",
        ));
    }
    let payload = fs::read(path).map_err(|_| {
        ReplacementRuleError::new(
            "REPLACEMENT_RULE_READ_FAILED",
            "replacement rules could not be read",
        )
    })?;
    let stored = serde_json::from_slice::<StoredRuleSets>(&payload).map_err(|_| {
        ReplacementRuleError::new(
            "REPLACEMENT_RULE_STORE_INVALID",
            "replacement rule storage is invalid",
        )
    })?;
    validate_store(&stored)?;
    Ok(stored)
}

fn validate_store(stored: &StoredRuleSets) -> Result<(), ReplacementRuleError> {
    if stored.schema_version != RULE_STORE_SCHEMA_VERSION {
        return Err(ReplacementRuleError::new(
            "REPLACEMENT_RULE_SCHEMA_UNSUPPORTED",
            "replacement rule storage uses an unsupported schema",
        ));
    }
    if stored.custom_rule_sets.len() > MAX_CUSTOM_RULE_SETS {
        return Err(ReplacementRuleError::new(
            "REPLACEMENT_RULE_STORE_INVALID",
            "replacement rule storage contains too many custom rule sets",
        ));
    }
    let mut ids = HashSet::new();
    for rule_set in &stored.custom_rule_sets {
        validate_rule_set(rule_set)?;
        if rule_set.built_in || is_built_in_id(&rule_set.id) || !ids.insert(rule_set.id.as_str()) {
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_RULE_STORE_INVALID",
                "replacement rule storage contains an invalid or duplicate custom rule set",
            ));
        }
    }
    Ok(())
}

fn validate_rule_set_input(
    params: &ReplacementRuleSetUpsertParams,
) -> Result<(), ReplacementRuleError> {
    if let Some(id) = &params.id {
        validate_safe_id(id, "replacement rule set")?;
    }
    validate_set_name(&params.name)?;
    validate_rules(&params.rules)
}

fn validate_rule_set(rule_set: &ReplacementRuleSet) -> Result<(), ReplacementRuleError> {
    if rule_set.schema_version != RULE_SET_SCHEMA_VERSION || rule_set.version == 0 {
        return Err(ReplacementRuleError::new(
            "REPLACEMENT_RULE_SET_INVALID",
            "a replacement rule set has an invalid version",
        ));
    }
    validate_safe_id(&rule_set.id, "replacement rule set")?;
    validate_set_name(&rule_set.name)?;
    validate_rules(&rule_set.rules)
}

pub(crate) fn validate_snapshot_rule_set(
    rule_set: &ReplacementRuleSet,
) -> Result<(), ReplacementRuleError> {
    validate_rule_set(rule_set)
}

fn validate_set_name(name: &str) -> Result<(), ReplacementRuleError> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_SET_NAME_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return Err(ReplacementRuleError::new(
            "REPLACEMENT_RULE_SET_NAME_INVALID",
            format!("rule set names must be 1 to {MAX_SET_NAME_BYTES} safe bytes"),
        ));
    }
    Ok(())
}

fn validate_rules(rules: &[ReplacementRule]) -> Result<(), ReplacementRuleError> {
    if rules.len() > MAX_RULES_PER_SET {
        return Err(ReplacementRuleError::new(
            "REPLACEMENT_RULE_LIMIT_REACHED",
            format!("a rule set may contain at most {MAX_RULES_PER_SET} rules"),
        ));
    }
    let mut ids = HashSet::new();
    let mut orders = HashSet::new();
    for rule in rules {
        validate_safe_id(&rule.id, "replacement rule")?;
        if !ids.insert(rule.id.as_str()) {
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_RULE_DUPLICATE_ID",
                "replacement rule IDs must be unique within a rule set",
            ));
        }
        if rule.order > MAX_RULE_ORDER || !orders.insert(rule.order) {
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_RULE_ORDER_INVALID",
                "replacement rule order values must be unique and bounded",
            ));
        }
        if rule.literal.is_empty()
            || rule.literal.len() > MAX_LITERAL_BYTES
            || rule.literal.contains('\0')
        {
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_RULE_LITERAL_INVALID",
                format!("replacement literals must be 1 to {MAX_LITERAL_BYTES} bytes"),
            ));
        }
        if rule.replacement.len() > MAX_REPLACEMENT_BYTES || rule.replacement.contains('\0') {
            return Err(ReplacementRuleError::new(
                "REPLACEMENT_RULE_VALUE_INVALID",
                format!("replacement values may contain at most {MAX_REPLACEMENT_BYTES} bytes"),
            ));
        }
    }
    Ok(())
}

fn validate_input(input: &str) -> Result<(), ReplacementRuleError> {
    if input.len() > MAX_INPUT_BYTES || input.contains('\0') {
        return Err(ReplacementRuleError::new(
            "REPLACEMENT_INPUT_INVALID",
            format!("replacement input may contain at most {MAX_INPUT_BYTES} safe bytes"),
        ));
    }
    Ok(())
}

fn validate_safe_id(id: &str, kind: &str) -> Result<(), ReplacementRuleError> {
    let valid = !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && id.as_bytes()[0].is_ascii_lowercase()
        && id.as_bytes()[id.len() - 1].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !id.contains("--");
    if !valid {
        return Err(ReplacementRuleError::new(
            "REPLACEMENT_RULE_ID_INVALID",
            format!("{kind} IDs must be bounded lowercase identifiers"),
        ));
    }
    Ok(())
}

fn compute_preview(
    rule_set: &ReplacementRuleSet,
    input: &str,
) -> Result<ReplacementPreviewOutcome, ReplacementRuleError> {
    let mut output = input.to_string();
    let mut changes = Vec::new();
    let mut replacement_count = 0_u32;
    let mut protected_term_review_required = false;
    for rule in rule_set.rules.iter().filter(|rule| rule.enabled) {
        let (next, count) = apply_rule(&output, rule)?;
        if count > 0 {
            replacement_count = replacement_count.saturating_add(count);
            protected_term_review_required |= rule.protected_term_review;
            changes.push(ReplacementChange {
                rule_id: rule.id.clone(),
                rule_order: rule.order,
                replacement_count: count,
                protected_term_review: rule.protected_term_review,
            });
            output = next;
        }
    }
    let preview_token = preview_token(rule_set, input, &output, &changes);
    Ok(ReplacementPreviewOutcome {
        normalized_text: output,
        preview_token,
        changes,
        replacement_count,
        protected_term_review_required,
    })
}

#[cfg(any(feature = "local-whisper", test))]
pub(crate) fn normalize_transcript_text(
    rule_set: &ReplacementRuleSet,
    input: &str,
) -> Result<TranscriptReplacementOutcome, ReplacementRuleError> {
    validate_input(input)?;
    validate_rule_set(rule_set)?;
    let mut rules = rule_set
        .rules
        .iter()
        .filter(|rule| rule.enabled)
        .collect::<Vec<_>>();
    rules.sort_by(|left, right| {
        left.order
            .cmp(&right.order)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut normalized_text = input.to_string();
    let mut automatic_changes = Vec::new();
    let mut protected_term_matches = Vec::new();
    let mut automatic_replacement_count = 0_u32;
    for rule in rules {
        if rule.protected_term_review {
            let count = count_rule_matches(&normalized_text, rule);
            if count > 0 {
                protected_term_matches.push(ReplacementChange {
                    rule_id: rule.id.clone(),
                    rule_order: rule.order,
                    replacement_count: count,
                    protected_term_review: true,
                });
            }
            continue;
        }
        let (next, count) = apply_rule(&normalized_text, rule)?;
        if count > 0 {
            automatic_replacement_count = automatic_replacement_count.saturating_add(count);
            automatic_changes.push(ReplacementChange {
                rule_id: rule.id.clone(),
                rule_order: rule.order,
                replacement_count: count,
                protected_term_review: false,
            });
            normalized_text = next;
        }
    }
    Ok(TranscriptReplacementOutcome {
        normalized_text,
        automatic_changes,
        protected_term_matches,
        automatic_replacement_count,
    })
}

/// Applies only rules that were explicitly marked for protected-term review.
/// The caller must bind approval to a core-computed preview token before using
/// this result to create a durable transcript revision.
pub(crate) fn apply_reviewed_protected_terms(
    rule_set: &ReplacementRuleSet,
    input: &str,
) -> Result<ProtectedTermApplication, ReplacementRuleError> {
    validate_input(input)?;
    validate_rule_set(rule_set)?;
    let mut rules = rule_set
        .rules
        .iter()
        .filter(|rule| rule.enabled && rule.protected_term_review)
        .collect::<Vec<_>>();
    rules.sort_by(|left, right| {
        left.order
            .cmp(&right.order)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut normalized_text = input.to_string();
    let mut changes = Vec::new();
    let mut replacement_count = 0_u32;
    for rule in rules {
        let (next, count) = apply_rule(&normalized_text, rule)?;
        if count == 0 {
            continue;
        }
        replacement_count = replacement_count.saturating_add(count);
        changes.push(ReplacementChange {
            rule_id: rule.id.clone(),
            rule_order: rule.order,
            replacement_count: count,
            protected_term_review: true,
        });
        normalized_text = next;
    }
    Ok(ProtectedTermApplication {
        normalized_text,
        changes,
        replacement_count,
    })
}

#[cfg(any(feature = "local-whisper", test))]
fn count_rule_matches(input: &str, rule: &ReplacementRule) -> u32 {
    input
        .match_indices(&rule.literal)
        .filter(|(start, matched)| {
            let end = *start + matched.len();
            rule.match_mode != ReplacementMatchMode::WholeWord
                || (word_boundary_before(input, *start) && word_boundary_after(input, end))
        })
        .fold(0_u32, |count, _| count.saturating_add(1))
}

fn apply_rule(input: &str, rule: &ReplacementRule) -> Result<(String, u32), ReplacementRuleError> {
    let mut output = String::with_capacity(input.len().min(MAX_OUTPUT_BYTES));
    let mut cursor = 0;
    let mut count = 0_u32;
    for (start, matched) in input.match_indices(&rule.literal) {
        let end = start + matched.len();
        if rule.match_mode == ReplacementMatchMode::WholeWord
            && (!word_boundary_before(input, start) || !word_boundary_after(input, end))
        {
            continue;
        }
        output.push_str(&input[cursor..start]);
        output.push_str(&rule.replacement);
        if output.len() > MAX_OUTPUT_BYTES {
            return Err(output_limit_error());
        }
        cursor = end;
        count = count.saturating_add(1);
    }
    if count == 0 {
        return Ok((input.to_string(), 0));
    }
    output.push_str(&input[cursor..]);
    if output.len() > MAX_OUTPUT_BYTES {
        return Err(output_limit_error());
    }
    Ok((output, count))
}

fn word_boundary_before(input: &str, start: usize) -> bool {
    input[..start]
        .chars()
        .next_back()
        .is_none_or(|character| !is_word_character(character))
}

fn word_boundary_after(input: &str, end: usize) -> bool {
    input[end..]
        .chars()
        .next()
        .is_none_or(|character| !is_word_character(character))
}

fn is_word_character(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

fn output_limit_error() -> ReplacementRuleError {
    ReplacementRuleError::new(
        "REPLACEMENT_OUTPUT_LIMIT",
        format!("replacement output exceeds the {MAX_OUTPUT_BYTES} byte limit"),
    )
}

fn preview_token(
    rule_set: &ReplacementRuleSet,
    input: &str,
    output: &str,
    changes: &[ReplacementChange],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"candor-replacement-preview-v1\0");
    hasher.update(rule_set.id.as_bytes());
    hasher.update([0]);
    hasher.update(rule_set.version.to_le_bytes());
    hasher.update((input.len() as u64).to_le_bytes());
    hasher.update(input.as_bytes());
    hasher.update((output.len() as u64).to_le_bytes());
    hasher.update(output.as_bytes());
    for change in changes {
        hasher.update(change.rule_id.as_bytes());
        hasher.update(change.rule_order.to_le_bytes());
        hasher.update(change.replacement_count.to_le_bytes());
        hasher.update([u8::from(change.protected_term_review)]);
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn preview_response(outcome: ReplacementPreviewOutcome, applied: bool) -> Value {
    let changed = outcome.replacement_count > 0;
    json!({
        "implemented": true,
        "applied": applied,
        "changed": changed,
        "previewText": outcome.normalized_text,
        "previewToken": outcome.preview_token,
        "changes": outcome.changes,
        "replacementCount": outcome.replacement_count,
        "protectedTermReviewRequired": outcome.protected_term_review_required,
        "previewRequiredBeforeApply": true,
        "rulesAreOrdered": true,
        "rendererRegexAccepted": false,
        "separateFromAsrVocabularyHints": true,
        "asrVocabularyHintsApplied": false,
        "localOnly": true,
        "networkAttempted": false,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn rule_set_response(rule_set: ReplacementRuleSet) -> Value {
    json!({
        "implemented": true,
        "ruleSet": rule_set,
        "separateFromAsrVocabularyHints": true,
        "asrVocabularyHintsApplied": false,
        "localOnly": true,
        "networkAttempted": false,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn next_rule_set_id(stored: &StoredRuleSets) -> String {
    loop {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let sequence = RULE_SET_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = format!("rules-{now:x}-{sequence:x}");
        if !stored
            .custom_rule_sets
            .iter()
            .any(|rule_set| rule_set.id == candidate)
        {
            return candidate;
        }
    }
}

fn is_built_in_id(id: &str) -> bool {
    id == "none"
}

fn built_in_rule_sets() -> Vec<ReplacementRuleSet> {
    vec![ReplacementRuleSet {
        schema_version: RULE_SET_SCHEMA_VERSION,
        version: 1,
        id: "none".to_string(),
        name: "No replacements".to_string(),
        rules: Vec::new(),
        built_in: true,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "candor-replacement-rules-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn rule(
        id: &str,
        order: u32,
        mode: ReplacementMatchMode,
        literal: &str,
        replacement: &str,
    ) -> ReplacementRule {
        ReplacementRule {
            id: id.to_string(),
            order,
            match_mode: mode,
            literal: literal.to_string(),
            replacement: replacement.to_string(),
            protected_term_review: false,
            enabled: true,
        }
    }

    fn rule_set_params(id: &str, rules: Vec<ReplacementRule>) -> ReplacementRuleSetUpsertParams {
        ReplacementRuleSetUpsertParams {
            id: Some(id.to_string()),
            expected_version: None,
            name: "Deterministic corrections".to_string(),
            rules,
        }
    }

    #[test]
    fn ordered_rules_and_whole_word_boundaries_are_deterministic() {
        let root = root("ordered");
        let service = ReplacementRuleService::with_root(root.clone());
        service
            .upsert_custom(rule_set_params(
                "ordered",
                vec![
                    rule(
                        "dog-to-wolf",
                        20,
                        ReplacementMatchMode::Exact,
                        "dog",
                        "wolf",
                    ),
                    rule(
                        "cat-to-dog",
                        10,
                        ReplacementMatchMode::WholeWord,
                        "cat",
                        "dog",
                    ),
                ],
            ))
            .unwrap();
        let first = service
            .preview_outcome("ordered", "cat scatter cat")
            .unwrap();
        let second = service
            .preview_outcome("ordered", "cat scatter cat")
            .unwrap();
        assert_eq!(first.normalized_text, "wolf scatter wolf");
        assert_eq!(first, second);
        assert_eq!(first.changes[0].rule_id, "cat-to-dog");
        assert_eq!(first.changes[1].rule_id, "dog-to-wolf");
        assert_eq!(first.replacement_count, 4);
        let response = service
            .preview(ReplacementPreviewParams {
                set_id: "ordered".to_string(),
                input: "cat".to_string(),
            })
            .unwrap();
        assert_eq!(response["separateFromAsrVocabularyHints"], true);
        assert_eq!(response["asrVocabularyHintsApplied"], false);
        assert_eq!(response["rendererRegexAccepted"], false);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn protected_terms_require_matching_preview_and_explicit_approval() {
        let root = root("protected");
        let service = ReplacementRuleService::with_root(root.clone());
        let mut protected = rule(
            "candor-name",
            1,
            ReplacementMatchMode::WholeWord,
            "cander",
            "Candor",
        );
        protected.protected_term_review = true;
        service
            .upsert_custom(rule_set_params("protected", vec![protected]))
            .unwrap();
        let preview = service
            .preview_outcome("protected", "cander notes")
            .unwrap();
        assert!(preview.protected_term_review_required);
        assert_eq!(preview.normalized_text, "Candor notes");

        let rejected = service
            .apply(ReplacementApplyParams {
                set_id: "protected".to_string(),
                input: "cander notes".to_string(),
                preview_token: preview.preview_token.clone(),
                approve_protected_terms: false,
            })
            .unwrap_err();
        assert_eq!(rejected.code, "REPLACEMENT_PROTECTED_TERM_REVIEW_REQUIRED");
        let stale = service
            .apply(ReplacementApplyParams {
                set_id: "protected".to_string(),
                input: "changed input".to_string(),
                preview_token: preview.preview_token.clone(),
                approve_protected_terms: true,
            })
            .unwrap_err();
        assert_eq!(stale.code, "REPLACEMENT_PREVIEW_REQUIRED");
        let applied = service
            .apply(ReplacementApplyParams {
                set_id: "protected".to_string(),
                input: "cander notes".to_string(),
                preview_token: preview.preview_token,
                approve_protected_terms: true,
            })
            .unwrap();
        assert_eq!(applied["applied"], true);
        assert_eq!(applied["previewText"], "Candor notes");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn transcript_normalization_applies_ordered_safe_rules_and_only_reports_protected_matches() {
        let mut protected = rule(
            "protected-name",
            2,
            ReplacementMatchMode::WholeWord,
            "jane",
            "Jane Doe",
        );
        protected.protected_term_review = true;
        let rule_set = ReplacementRuleSet {
            schema_version: RULE_SET_SCHEMA_VERSION,
            version: 7,
            id: "transcript-normalization".to_string(),
            name: "Transcript normalization".to_string(),
            rules: vec![
                rule(
                    "second",
                    1,
                    ReplacementMatchMode::Exact,
                    "ACME",
                    "Acme Corp",
                ),
                protected,
                rule("first", 0, ReplacementMatchMode::WholeWord, "acmi", "ACME"),
            ],
            built_in: false,
        };

        let outcome =
            normalize_transcript_text(&rule_set, "acmi met jane at ACME").expect("normalize");
        assert_eq!(outcome.normalized_text, "Acme Corp met jane at Acme Corp");
        assert_eq!(outcome.automatic_replacement_count, 3);
        assert_eq!(
            outcome
                .automatic_changes
                .iter()
                .map(|change| change.rule_id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert_eq!(outcome.protected_term_matches.len(), 1);
        assert_eq!(outcome.protected_term_matches[0].rule_id, "protected-name");
        assert!(outcome.normalized_text.contains("jane"));
        assert!(!outcome.normalized_text.contains("Jane Doe"));
    }

    #[test]
    fn renderer_cannot_supply_regex_rules() {
        let payload = json!({
            "id": "bad",
            "order": 1,
            "matchMode": "exact",
            "literal": "(secret)+",
            "replacement": "redacted",
            "regex": true,
            "enabled": true
        });
        assert!(serde_json::from_value::<ReplacementRule>(payload).is_err());
    }

    #[test]
    fn input_output_and_rule_boundaries_are_enforced() {
        let root = root("bounds");
        let service = ReplacementRuleService::with_root(root.clone());
        assert_eq!(
            service
                .preview_outcome("none", &"x".repeat(MAX_INPUT_BYTES + 1))
                .unwrap_err()
                .code,
            "REPLACEMENT_INPUT_INVALID"
        );

        let expanding = rule(
            "expand",
            1,
            ReplacementMatchMode::Exact,
            "x",
            &"y".repeat(MAX_REPLACEMENT_BYTES),
        );
        service
            .upsert_custom(rule_set_params("expanding", vec![expanding]))
            .unwrap();
        assert_eq!(
            service
                .preview_outcome("expanding", &"x".repeat(MAX_INPUT_BYTES))
                .unwrap_err()
                .code,
            "REPLACEMENT_OUTPUT_LIMIT"
        );

        let too_many = (0..=MAX_RULES_PER_SET)
            .map(|index| {
                rule(
                    &format!("rule-{index}"),
                    index as u32,
                    ReplacementMatchMode::Exact,
                    "a",
                    "b",
                )
            })
            .collect();
        assert_eq!(
            service
                .upsert_custom(rule_set_params("too-many", too_many))
                .unwrap_err()
                .code,
            "REPLACEMENT_RULE_LIMIT_REACHED"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn storage_is_atomic_corruption_aware_and_built_ins_are_immutable() {
        let root = root("storage");
        let service = ReplacementRuleService::with_root(root.clone());
        service
            .upsert_custom(rule_set_params(
                "saved",
                vec![rule("fix", 1, ReplacementMatchMode::Exact, "teh", "the")],
            ))
            .unwrap();
        fs::write(root.join(RULE_STORE_TEMP_FILE), b"interrupted write").unwrap();
        assert_eq!(service.resolve("saved").unwrap().version, 1);
        let mut update = rule_set_params(
            "saved",
            vec![rule("fix", 1, ReplacementMatchMode::Exact, "teh", "the")],
        );
        update.expected_version = Some(1);
        service.upsert_custom(update).unwrap();
        assert!(!root.join(RULE_STORE_TEMP_FILE).exists());
        assert!(!root.join(RULE_STORE_BACKUP_FILE).exists());

        assert_eq!(
            service
                .upsert_custom(rule_set_params("none", Vec::new()))
                .unwrap_err()
                .code,
            "REPLACEMENT_RULE_SET_BUILT_IN_IMMUTABLE"
        );

        fs::write(root.join(RULE_STORE_FILE), b"corrupt").unwrap();
        assert_eq!(
            service.list().unwrap_err().code,
            "REPLACEMENT_RULE_STORE_INVALID"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_primary_promotes_valid_backup_after_interrupted_commit() {
        let root = root("backup-promotion");
        let service = ReplacementRuleService::with_root(root.clone());
        service
            .upsert_custom(rule_set_params(
                "recovered",
                vec![rule("fix", 1, ReplacementMatchMode::Exact, "teh", "the")],
            ))
            .expect("seed replacement rules");
        fs::rename(
            root.join(RULE_STORE_FILE),
            root.join(RULE_STORE_BACKUP_FILE),
        )
        .expect("simulate interrupted commit");

        let reopened = ReplacementRuleService::with_root(root.clone());
        assert_eq!(
            reopened.resolve("recovered").unwrap().name,
            "Deterministic corrections"
        );
        assert!(root.join(RULE_STORE_FILE).is_file());
        assert!(!root.join(RULE_STORE_BACKUP_FILE).exists());
        let _ = fs::remove_dir_all(root);
    }
}
