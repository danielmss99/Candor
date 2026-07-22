use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::replacement_rules::{ReplacementRuleService, ReplacementRuleSet};

const PROFILE_STORE_SCHEMA_VERSION: u32 = 2;
const PROFILE_RECORD_SCHEMA_VERSION: u32 = 2;
const PROFILE_FILE: &str = "meeting-profiles.json";
const PROFILE_BACKUP_FILE: &str = "meeting-profiles.json.bak";
const PROFILE_TEMP_FILE: &str = "meeting-profiles.json.tmp";
const MAX_PROFILE_STORE_BYTES: u64 = 256 * 1024;
const MAX_CUSTOM_PROFILES: usize = 24;
const MAX_PROFILE_ID_BYTES: usize = 64;
const MAX_PROFILE_NAME_BYTES: usize = 80;
const MAX_LANGUAGE_BYTES: usize = 35;
const MAX_DICTIONARY_IDS: usize = 16;
const MAX_RECAP_TEMPLATE_BYTES: usize = 4 * 1024;
const MAX_PROFILE_MIGRATIONS: usize = 8;
pub(crate) const PROCESSING_PROFILE_SCHEMA_VERSION: u32 = 2;
const DEFAULT_TEXT_MODEL_ID: &str = "qwen3-4b-official-q4_k_m";
const PARAKEET_MODEL_ID: &str = "parakeet-tdt-0.6b-v3-int8";

static PROFILE_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn default_active_profile_id() -> String {
    "general".to_string()
}

#[derive(Debug)]
pub struct MeetingProfileError {
    pub code: &'static str,
    pub message: String,
}

impl MeetingProfileError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileCaptureSource {
    Microphone,
    SystemAudio,
    Combined,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProfileModelTier {
    Fast,
    Balanced,
    Maximum,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeetingProfile {
    pub schema_version: u32,
    pub version: u32,
    pub id: String,
    pub name: String,
    pub capture_source: ProfileCaptureSource,
    pub language: String,
    pub local_model_tier: ProfileModelTier,
    #[serde(default)]
    pub speech_model_id: String,
    #[serde(default)]
    pub cleanup_model_id: Option<String>,
    #[serde(default)]
    pub summary_model_id: Option<String>,
    pub dictionary_ids: Vec<String>,
    pub replacement_rule_set_id: Option<String>,
    pub recap_template: String,
    pub live_transcription: bool,
    pub built_in: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MeetingProcessingProfileSnapshot {
    pub(crate) schema_version: u32,
    pub(crate) profile_id: String,
    pub(crate) profile_version: u32,
    pub(crate) capture_source: ProfileCaptureSource,
    pub(crate) model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) speech_model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cleanup_model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) summary_model_id: Option<String>,
    pub(crate) language: String,
    pub(crate) transcription_language: String,
    pub(crate) dictionary_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) replacement_rule_set: Option<ReplacementRuleSet>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) recap_template: Option<String>,
    pub(crate) live_transcription: bool,
}

impl MeetingProcessingProfileSnapshot {
    pub(crate) fn validate(&self) -> Result<(), MeetingProfileError> {
        if !matches!(self.schema_version, 1 | PROCESSING_PROFILE_SCHEMA_VERSION)
            || self.profile_version == 0
        {
            return Err(MeetingProfileError::new(
                "MEETING_PROCESSING_PROFILE_INVALID",
                "the recording processing profile has an invalid version",
            ));
        }
        validate_safe_id(&self.profile_id, "recording profile")?;
        validate_language(&self.language)?;
        if self.transcription_language != transcription_language(&self.language) {
            return Err(MeetingProfileError::new(
                "MEETING_PROCESSING_PROFILE_INVALID",
                "the recording processing profile has an invalid transcription language",
            ));
        }
        validate_dictionary_ids(&self.dictionary_ids)?;
        validate_recap_template(self.recap_template.as_deref().unwrap_or_default())?;
        if self.schema_version == PROCESSING_PROFILE_SCHEMA_VERSION {
            validate_speech_model_id(&self.model_id)?;
        }
        let expected_model_id =
            model_id_for_profile(self.capture_source, self.model_tier(), &self.language);
        if self.model_id != expected_model_id && self.model_id != PARAKEET_MODEL_ID {
            return Err(MeetingProfileError::new(
                "MEETING_PROCESSING_PROFILE_INVALID",
                "the recording processing profile model does not match its bounded tier",
            ));
        }
        if self.schema_version == PROCESSING_PROFILE_SCHEMA_VERSION {
            if self.speech_model_id.as_deref() != Some(self.model_id.as_str()) {
                return Err(MeetingProfileError::new(
                    "MEETING_PROCESSING_PROFILE_INVALID",
                    "the recording processing profile speech model is inconsistent",
                ));
            }
            validate_text_model_id(self.cleanup_model_id.as_deref(), "cleanup")?;
            validate_text_model_id(self.summary_model_id.as_deref(), "summary")?;
        }
        if let Some(rule_set) = &self.replacement_rule_set {
            crate::replacement_rules::validate_snapshot_rule_set(rule_set)
                .map_err(|error| MeetingProfileError::new(error.code, error.message))?;
        }
        Ok(())
    }

    fn model_tier(&self) -> ProfileModelTier {
        match self.model_id.as_str() {
            "large-v3" => ProfileModelTier::Maximum,
            "large-v3-turbo" => ProfileModelTier::Balanced,
            _ => ProfileModelTier::Fast,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeetingProfileUpsertParams {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub expected_version: Option<u32>,
    pub name: String,
    pub capture_source: ProfileCaptureSource,
    pub language: String,
    pub local_model_tier: ProfileModelTier,
    #[serde(default)]
    pub speech_model_id: Option<String>,
    #[serde(default)]
    pub cleanup_model_id: Option<String>,
    #[serde(default)]
    pub summary_model_id: Option<String>,
    #[serde(default)]
    pub dictionary_ids: Vec<String>,
    #[serde(default)]
    pub replacement_rule_set_id: Option<String>,
    pub recap_template: String,
    pub live_transcription: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeetingProfileGetParams {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeetingProfileDeleteParams {
    pub id: String,
    pub expected_version: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeetingProfileSelectParams {
    pub id: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileMigrationRecord {
    from_schema_version: u32,
    to_schema_version: u32,
    migrated_profile_count: u32,
    migrated_at_ms: u128,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProfiles {
    schema_version: u32,
    #[serde(default = "default_active_profile_id")]
    active_profile_id: String,
    custom_profiles: Vec<MeetingProfile>,
    #[serde(default)]
    migrations: Vec<ProfileMigrationRecord>,
}

impl StoredProfiles {
    fn empty() -> Self {
        Self {
            schema_version: PROFILE_STORE_SCHEMA_VERSION,
            active_profile_id: default_active_profile_id(),
            custom_profiles: Vec::new(),
            migrations: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct MeetingProfileService {
    root: PathBuf,
    storage_lock: Arc<Mutex<()>>,
}

impl MeetingProfileService {
    pub fn with_root(root: PathBuf) -> Self {
        Self {
            root,
            storage_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn list(&self) -> Result<Value, MeetingProfileError> {
        let stored = self.load()?;
        let mut profiles = built_in_profiles();
        profiles.extend(stored.custom_profiles);
        let profile_count = profiles.len();
        Ok(json!({
            "implemented": true,
            "schemaVersion": PROFILE_STORE_SCHEMA_VERSION,
            "profiles": profiles,
            "activeProfileId": stored.active_profile_id,
            "profileCount": profile_count,
            "customProfileLimit": MAX_CUSTOM_PROFILES,
            "localOnly": true,
            "networkAttempted": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn active_profile(&self) -> Result<MeetingProfile, MeetingProfileError> {
        let stored = self.load()?;
        let active_profile_id = stored.active_profile_id;
        built_in_profiles()
            .into_iter()
            .chain(stored.custom_profiles)
            .find(|profile| profile.id == active_profile_id)
            .ok_or_else(|| {
                MeetingProfileError::new(
                    "MEETING_PROFILE_ACTIVE_NOT_FOUND",
                    "the active meeting profile could not be resolved",
                )
            })
    }

    pub(crate) fn active_processing_snapshot_for_capture(
        &self,
        capture_source: ProfileCaptureSource,
        replacements: &ReplacementRuleService,
    ) -> Result<MeetingProcessingProfileSnapshot, MeetingProfileError> {
        let profile = self.active_profile()?;
        if profile.capture_source != capture_source {
            return Err(MeetingProfileError::new(
                "MEETING_PROFILE_CAPTURE_SOURCE_MISMATCH",
                "the active meeting profile does not match the requested capture source",
            ));
        }
        self.processing_snapshot_from_profile(profile, replacements)
    }

    pub(crate) fn processing_snapshot_for_capture(
        &self,
        profile_id: &str,
        profile_version: u32,
        capture_source: ProfileCaptureSource,
        replacements: &ReplacementRuleService,
    ) -> Result<MeetingProcessingProfileSnapshot, MeetingProfileError> {
        let profile = self.resolve(profile_id)?;
        if profile.version != profile_version {
            return Err(MeetingProfileError::new(
                "MEETING_PROFILE_VERSION_CONFLICT",
                "the selected meeting profile changed before capture started",
            ));
        }
        if profile.capture_source != capture_source {
            return Err(MeetingProfileError::new(
                "MEETING_PROFILE_CAPTURE_SOURCE_MISMATCH",
                "the selected meeting profile does not match the requested capture source",
            ));
        }
        self.processing_snapshot_from_profile(profile, replacements)
    }

    fn processing_snapshot_from_profile(
        &self,
        profile: MeetingProfile,
        replacements: &ReplacementRuleService,
    ) -> Result<MeetingProcessingProfileSnapshot, MeetingProfileError> {
        let replacement_rule_set = match profile.replacement_rule_set_id.as_deref() {
            Some(id) => Some(
                replacements
                    .resolve(id)
                    .map_err(|error| MeetingProfileError::new(error.code, error.message))?,
            ),
            None => None,
        };
        let recap_template =
            (!profile.recap_template.trim().is_empty()).then(|| profile.recap_template.clone());
        let effective_transcription_language = transcription_language(&profile.language);
        let speech_model_id = profile.speech_model_id.clone();
        let snapshot = MeetingProcessingProfileSnapshot {
            schema_version: PROCESSING_PROFILE_SCHEMA_VERSION,
            profile_id: profile.id,
            profile_version: profile.version,
            capture_source: profile.capture_source,
            model_id: speech_model_id.clone(),
            speech_model_id: Some(speech_model_id),
            cleanup_model_id: profile.cleanup_model_id,
            summary_model_id: profile.summary_model_id,
            language: profile.language,
            transcription_language: effective_transcription_language,
            dictionary_ids: profile.dictionary_ids,
            replacement_rule_set,
            recap_template,
            live_transcription: profile.live_transcription,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    pub fn get(&self, params: MeetingProfileGetParams) -> Result<Value, MeetingProfileError> {
        let profile = self.resolve(&params.id)?;
        Ok(profile_response(profile))
    }

    pub fn resolve(&self, id: &str) -> Result<MeetingProfile, MeetingProfileError> {
        validate_safe_id(id, "profile")?;
        if let Some(profile) = built_in_profiles()
            .into_iter()
            .find(|profile| profile.id == id)
        {
            return Ok(profile);
        }
        self.load()?
            .custom_profiles
            .into_iter()
            .find(|profile| profile.id == id)
            .ok_or_else(|| {
                MeetingProfileError::new(
                    "MEETING_PROFILE_NOT_FOUND",
                    "the requested meeting profile does not exist",
                )
            })
    }

    pub fn upsert_custom(
        &self,
        params: MeetingProfileUpsertParams,
    ) -> Result<Value, MeetingProfileError> {
        validate_profile_input(&params)?;
        let _guard = self.lock_storage()?;
        let mut stored = self.load_unlocked()?;
        let requested_id = params.id.as_deref();
        if requested_id.is_some_and(is_built_in_id) {
            return Err(MeetingProfileError::new(
                "MEETING_PROFILE_BUILT_IN_IMMUTABLE",
                "built-in meeting profiles cannot be changed",
            ));
        }

        let existing_index = requested_id.and_then(|id| {
            stored
                .custom_profiles
                .iter()
                .position(|profile| profile.id == id)
        });
        let (id, version) = if let Some(index) = existing_index {
            let existing = &stored.custom_profiles[index];
            if params.expected_version != Some(existing.version) {
                return Err(MeetingProfileError::new(
                    "MEETING_PROFILE_VERSION_CONFLICT",
                    "the meeting profile changed before this update was saved",
                ));
            }
            (
                existing.id.clone(),
                existing.version.checked_add(1).ok_or_else(|| {
                    MeetingProfileError::new(
                        "MEETING_PROFILE_VERSION_LIMIT",
                        "the meeting profile version limit was reached",
                    )
                })?,
            )
        } else {
            if params.expected_version.is_some() {
                return Err(MeetingProfileError::new(
                    "MEETING_PROFILE_NOT_FOUND",
                    "the meeting profile to update does not exist",
                ));
            }
            if stored.custom_profiles.len() >= MAX_CUSTOM_PROFILES {
                return Err(MeetingProfileError::new(
                    "MEETING_PROFILE_LIMIT_REACHED",
                    format!("at most {MAX_CUSTOM_PROFILES} custom meeting profiles are allowed"),
                ));
            }
            let id = match requested_id {
                Some(id) => id.to_string(),
                None => next_profile_id(&stored),
            };
            (id, 1)
        };

        let profile = MeetingProfile {
            schema_version: PROFILE_RECORD_SCHEMA_VERSION,
            version,
            id,
            name: params.name.trim().to_string(),
            capture_source: params.capture_source,
            language: normalize_language(&params.language),
            local_model_tier: params.local_model_tier,
            speech_model_id: params.speech_model_id.unwrap_or_else(|| {
                model_id_for_profile(
                    params.capture_source,
                    params.local_model_tier,
                    &params.language,
                )
            }),
            cleanup_model_id: Some(
                params
                    .cleanup_model_id
                    .unwrap_or_else(|| DEFAULT_TEXT_MODEL_ID.to_string()),
            ),
            summary_model_id: Some(
                params
                    .summary_model_id
                    .unwrap_or_else(|| DEFAULT_TEXT_MODEL_ID.to_string()),
            ),
            dictionary_ids: params.dictionary_ids,
            replacement_rule_set_id: params.replacement_rule_set_id,
            recap_template: params.recap_template,
            live_transcription: params.live_transcription,
            built_in: false,
        };
        validate_profile(&profile)?;
        if let Some(index) = existing_index {
            stored.custom_profiles[index] = profile.clone();
        } else {
            stored.custom_profiles.push(profile.clone());
        }
        stored
            .custom_profiles
            .sort_by(|left, right| left.id.cmp(&right.id));
        self.write_unlocked(&stored)?;
        Ok(profile_response(profile))
    }

    pub fn delete_custom(
        &self,
        params: MeetingProfileDeleteParams,
    ) -> Result<Value, MeetingProfileError> {
        validate_safe_id(&params.id, "profile")?;
        if is_built_in_id(&params.id) {
            return Err(MeetingProfileError::new(
                "MEETING_PROFILE_BUILT_IN_IMMUTABLE",
                "built-in meeting profiles cannot be deleted",
            ));
        }
        let _guard = self.lock_storage()?;
        let mut stored = self.load_unlocked()?;
        let index = stored
            .custom_profiles
            .iter()
            .position(|profile| profile.id == params.id)
            .ok_or_else(|| {
                MeetingProfileError::new(
                    "MEETING_PROFILE_NOT_FOUND",
                    "the meeting profile to delete does not exist",
                )
            })?;
        if stored.custom_profiles[index].version != params.expected_version {
            return Err(MeetingProfileError::new(
                "MEETING_PROFILE_VERSION_CONFLICT",
                "the meeting profile changed before it could be deleted",
            ));
        }
        let removed = stored.custom_profiles.remove(index);
        if stored.active_profile_id == removed.id {
            stored.active_profile_id = default_active_profile_id();
        }
        self.write_unlocked(&stored)?;
        Ok(json!({
            "implemented": true,
            "deleted": true,
            "id": removed.id,
            "localOnly": true,
            "networkAttempted": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn select(&self, params: MeetingProfileSelectParams) -> Result<Value, MeetingProfileError> {
        validate_safe_id(&params.id, "profile")?;
        let _guard = self.lock_storage()?;
        let mut stored = self.load_unlocked()?;
        let exists = is_built_in_id(&params.id)
            || stored
                .custom_profiles
                .iter()
                .any(|profile| profile.id == params.id);
        if !exists {
            return Err(MeetingProfileError::new(
                "MEETING_PROFILE_NOT_FOUND",
                "the requested meeting profile does not exist",
            ));
        }
        stored.active_profile_id = params.id.clone();
        self.write_unlocked(&stored)?;
        Ok(json!({
            "implemented": true,
            "activeProfileId": params.id,
            "savedLocally": true,
            "localOnly": true,
            "networkAttempted": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    fn load(&self) -> Result<StoredProfiles, MeetingProfileError> {
        let _guard = self.lock_storage()?;
        self.load_unlocked()
    }

    fn load_unlocked(&self) -> Result<StoredProfiles, MeetingProfileError> {
        let target = self.root.join(PROFILE_FILE);
        let backup = self.root.join(PROFILE_BACKUP_FILE);
        if !target.exists() {
            if backup.exists() {
                let (stored, migrated) = read_store(&backup)?;
                fs::rename(&backup, &target).map_err(|_| {
                    MeetingProfileError::new(
                        "MEETING_PROFILE_BACKUP_FAILED",
                        "meeting profiles could not be restored after an interrupted write",
                    )
                })?;
                if migrated {
                    self.write_unlocked(&stored)?;
                }
                return Ok(stored);
            }
            return Ok(StoredProfiles::empty());
        }
        match read_store(&target) {
            Ok((stored, migrated)) => {
                if migrated {
                    self.write_unlocked(&stored)?;
                }
                Ok(stored)
            }
            Err(primary_error) => {
                if backup.exists() {
                    read_store(&backup)
                        .map(|(stored, _)| stored)
                        .map_err(|_| primary_error)
                } else {
                    Err(primary_error)
                }
            }
        }
    }

    fn lock_storage(&self) -> Result<MutexGuard<'_, ()>, MeetingProfileError> {
        self.storage_lock.lock().map_err(|_| {
            MeetingProfileError::new(
                "MEETING_PROFILE_LOCK_FAILED",
                "meeting profiles are temporarily unavailable",
            )
        })
    }

    fn write_unlocked(&self, stored: &StoredProfiles) -> Result<(), MeetingProfileError> {
        validate_store(stored)?;
        let payload = serde_json::to_vec_pretty(stored).map_err(|_| {
            MeetingProfileError::new(
                "MEETING_PROFILE_SERIALIZE_FAILED",
                "meeting profiles could not be encoded",
            )
        })?;
        if payload.is_empty() || payload.len() as u64 > MAX_PROFILE_STORE_BYTES {
            return Err(MeetingProfileError::new(
                "MEETING_PROFILE_STORE_LIMIT",
                "meeting profiles exceed the local storage limit",
            ));
        }
        fs::create_dir_all(&self.root).map_err(|_| {
            MeetingProfileError::new(
                "MEETING_PROFILE_DIR_FAILED",
                "meeting profile storage could not be prepared",
            )
        })?;
        let target = self.root.join(PROFILE_FILE);
        let backup = self.root.join(PROFILE_BACKUP_FILE);
        let temporary = self.root.join(PROFILE_TEMP_FILE);
        if temporary.exists() {
            fs::remove_file(&temporary).map_err(|_| {
                MeetingProfileError::new(
                    "MEETING_PROFILE_TEMP_FAILED",
                    "stale temporary meeting profile data could not be removed",
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
                MeetingProfileError::new(
                    "MEETING_PROFILE_BACKUP_FAILED",
                    "stale meeting profile backup could not be removed",
                )
            })?;
        }
        let had_target = target.exists();
        if had_target {
            fs::rename(&target, &backup).map_err(|_| {
                MeetingProfileError::new(
                    "MEETING_PROFILE_BACKUP_FAILED",
                    "current meeting profiles could not be backed up",
                )
            })?;
        }
        if fs::rename(&temporary, &target).is_err() {
            if had_target && backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            let _ = fs::remove_file(&temporary);
            return Err(MeetingProfileError::new(
                "MEETING_PROFILE_COMMIT_FAILED",
                "new meeting profiles could not be committed",
            ));
        }
        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }
        Ok(())
    }
}

fn write_private_file(path: &Path, payload: &[u8]) -> Result<(), MeetingProfileError> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| {
        MeetingProfileError::new(
            "MEETING_PROFILE_WRITE_FAILED",
            "meeting profiles could not be written",
        )
    })?;
    file.write_all(payload)
        .and_then(|_| file.sync_all())
        .map_err(|_| {
            MeetingProfileError::new(
                "MEETING_PROFILE_WRITE_FAILED",
                "meeting profiles could not be written durably",
            )
        })
}

fn read_store(path: &Path) -> Result<(StoredProfiles, bool), MeetingProfileError> {
    let metadata = fs::metadata(path).map_err(|_| {
        MeetingProfileError::new(
            "MEETING_PROFILE_READ_FAILED",
            "meeting profiles could not be read",
        )
    })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_PROFILE_STORE_BYTES {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_STORE_INVALID",
            "meeting profile storage has an invalid size",
        ));
    }
    let payload = fs::read(path).map_err(|_| {
        MeetingProfileError::new(
            "MEETING_PROFILE_READ_FAILED",
            "meeting profiles could not be read",
        )
    })?;
    let stored = serde_json::from_slice::<StoredProfiles>(&payload).map_err(|_| {
        MeetingProfileError::new(
            "MEETING_PROFILE_STORE_INVALID",
            "meeting profile storage is invalid",
        )
    })?;
    let (stored, migrated) = migrate_store(stored)?;
    validate_store(&stored)?;
    Ok((stored, migrated))
}

fn migrate_store(
    mut stored: StoredProfiles,
) -> Result<(StoredProfiles, bool), MeetingProfileError> {
    match stored.schema_version {
        PROFILE_STORE_SCHEMA_VERSION => Ok((stored, false)),
        1 => {
            let migrated_profile_count =
                u32::try_from(stored.custom_profiles.len()).unwrap_or(u32::MAX);
            for profile in &mut stored.custom_profiles {
                validate_legacy_profile(profile)?;
                profile.schema_version = PROFILE_RECORD_SCHEMA_VERSION;
                profile.speech_model_id = model_id_for_profile(
                    profile.capture_source,
                    profile.local_model_tier,
                    &profile.language,
                );
                profile.cleanup_model_id = Some(DEFAULT_TEXT_MODEL_ID.to_string());
                profile.summary_model_id = Some(DEFAULT_TEXT_MODEL_ID.to_string());
            }
            stored.schema_version = PROFILE_STORE_SCHEMA_VERSION;
            stored.migrations.push(ProfileMigrationRecord {
                from_schema_version: 1,
                to_schema_version: PROFILE_STORE_SCHEMA_VERSION,
                migrated_profile_count,
                migrated_at_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis(),
            });
            Ok((stored, true))
        }
        _ => Err(MeetingProfileError::new(
            "MEETING_PROFILE_SCHEMA_UNSUPPORTED",
            "meeting profile storage uses an unsupported schema",
        )),
    }
}

fn validate_legacy_profile(profile: &MeetingProfile) -> Result<(), MeetingProfileError> {
    if profile.schema_version != 1 || profile.version == 0 {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_RECORD_INVALID",
            "a legacy meeting profile record has an invalid version",
        ));
    }
    validate_safe_id(&profile.id, "profile")?;
    validate_name(&profile.name)?;
    validate_language(&profile.language)?;
    validate_dictionary_ids(&profile.dictionary_ids)?;
    if let Some(rule_set_id) = &profile.replacement_rule_set_id {
        validate_safe_id(rule_set_id, "replacement rule set")?;
    }
    validate_recap_template(&profile.recap_template)
}

fn validate_store(stored: &StoredProfiles) -> Result<(), MeetingProfileError> {
    if stored.schema_version != PROFILE_STORE_SCHEMA_VERSION {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_SCHEMA_UNSUPPORTED",
            "meeting profile storage uses an unsupported schema",
        ));
    }
    if stored.custom_profiles.len() > MAX_CUSTOM_PROFILES {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_STORE_INVALID",
            "meeting profile storage contains too many custom profiles",
        ));
    }
    if stored.migrations.len() > MAX_PROFILE_MIGRATIONS
        || stored.migrations.iter().any(|migration| {
            migration.from_schema_version == 0
                || migration.to_schema_version != PROFILE_STORE_SCHEMA_VERSION
                || migration.from_schema_version >= migration.to_schema_version
                || migration.migrated_profile_count > MAX_CUSTOM_PROFILES as u32
                || migration.migrated_at_ms == 0
        })
    {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_MIGRATION_INVALID",
            "meeting profile migration history is invalid",
        ));
    }
    let mut ids = HashSet::new();
    for profile in &stored.custom_profiles {
        validate_profile(profile)?;
        if profile.built_in || is_built_in_id(&profile.id) || !ids.insert(profile.id.as_str()) {
            return Err(MeetingProfileError::new(
                "MEETING_PROFILE_STORE_INVALID",
                "meeting profile storage contains an invalid or duplicate custom profile",
            ));
        }
    }
    validate_safe_id(&stored.active_profile_id, "active profile")?;
    if !is_built_in_id(&stored.active_profile_id)
        && !stored
            .custom_profiles
            .iter()
            .any(|profile| profile.id == stored.active_profile_id)
    {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_STORE_INVALID",
            "meeting profile storage references a missing active profile",
        ));
    }
    Ok(())
}

fn validate_profile_input(params: &MeetingProfileUpsertParams) -> Result<(), MeetingProfileError> {
    if let Some(id) = &params.id {
        validate_safe_id(id, "profile")?;
    }
    validate_name(&params.name)?;
    validate_language(&params.language)?;
    validate_dictionary_ids(&params.dictionary_ids)?;
    if let Some(rule_set_id) = &params.replacement_rule_set_id {
        validate_safe_id(rule_set_id, "replacement rule set")?;
    }
    if let Some(model_id) = params.speech_model_id.as_deref() {
        validate_speech_model_id(model_id)?;
        let expected = model_id_for_profile(
            params.capture_source,
            params.local_model_tier,
            &params.language,
        );
        if model_id != expected && model_id != PARAKEET_MODEL_ID {
            return Err(MeetingProfileError::new(
                "MEETING_PROFILE_MODEL_TIER_MISMATCH",
                "the selected speech model does not match the profile tier",
            ));
        }
    }
    validate_text_model_id(params.cleanup_model_id.as_deref(), "cleanup")?;
    validate_text_model_id(params.summary_model_id.as_deref(), "summary")?;
    validate_recap_template(&params.recap_template)
}

fn validate_profile(profile: &MeetingProfile) -> Result<(), MeetingProfileError> {
    if profile.schema_version != PROFILE_RECORD_SCHEMA_VERSION || profile.version == 0 {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_RECORD_INVALID",
            "a meeting profile record has an invalid version",
        ));
    }
    validate_safe_id(&profile.id, "profile")?;
    validate_name(&profile.name)?;
    validate_language(&profile.language)?;
    validate_speech_model_id(&profile.speech_model_id)?;
    if profile.speech_model_id != PARAKEET_MODEL_ID
        && profile.speech_model_id
            != model_id_for_profile(
                profile.capture_source,
                profile.local_model_tier,
                &profile.language,
            )
    {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_MODEL_TIER_MISMATCH",
            "the selected speech model does not match the profile tier",
        ));
    }
    validate_text_model_id(profile.cleanup_model_id.as_deref(), "cleanup")?;
    validate_text_model_id(profile.summary_model_id.as_deref(), "summary")?;
    validate_dictionary_ids(&profile.dictionary_ids)?;
    if let Some(rule_set_id) = &profile.replacement_rule_set_id {
        validate_safe_id(rule_set_id, "replacement rule set")?;
    }
    validate_recap_template(&profile.recap_template)
}

fn validate_name(name: &str) -> Result<(), MeetingProfileError> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_PROFILE_NAME_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_NAME_INVALID",
            format!("profile names must be 1 to {MAX_PROFILE_NAME_BYTES} safe bytes"),
        ));
    }
    Ok(())
}

fn validate_language(language: &str) -> Result<(), MeetingProfileError> {
    let language = language.trim();
    let valid = language == "auto"
        || (!language.is_empty()
            && language.len() <= MAX_LANGUAGE_BYTES
            && language
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && language.as_bytes()[0].is_ascii_alphabetic()
            && language.as_bytes()[language.len() - 1].is_ascii_alphanumeric()
            && !language.contains("--"));
    if !valid {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_LANGUAGE_INVALID",
            "profile language must be auto or a bounded language tag",
        ));
    }
    Ok(())
}

fn normalize_language(language: &str) -> String {
    let language = language.trim();
    if language.eq_ignore_ascii_case("auto") {
        "auto".to_string()
    } else {
        language.to_string()
    }
}

fn transcription_language(language: &str) -> String {
    if language.eq_ignore_ascii_case("auto") {
        "auto".to_string()
    } else {
        language
            .split('-')
            .next()
            .unwrap_or(language)
            .to_ascii_lowercase()
    }
}

fn model_id_for_profile(
    _capture_source: ProfileCaptureSource,
    tier: ProfileModelTier,
    language: &str,
) -> String {
    match tier {
        ProfileModelTier::Fast
            if language.eq_ignore_ascii_case("en")
                || language.to_ascii_lowercase().starts_with("en-") =>
        {
            "small.en".to_string()
        }
        ProfileModelTier::Fast => "small".to_string(),
        ProfileModelTier::Balanced => "large-v3-turbo".to_string(),
        ProfileModelTier::Maximum => "large-v3".to_string(),
    }
}

fn validate_speech_model_id(model_id: &str) -> Result<(), MeetingProfileError> {
    if !matches!(
        model_id,
        "small.en" | "small" | "large-v3-turbo" | "large-v3" | PARAKEET_MODEL_ID
    ) {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_SPEECH_MODEL_INVALID",
            "the selected speech model is not in Candor's verified local catalog",
        ));
    }
    Ok(())
}

fn validate_text_model_id(model_id: Option<&str>, stage: &str) -> Result<(), MeetingProfileError> {
    if model_id.is_some_and(|model_id| model_id != DEFAULT_TEXT_MODEL_ID) {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_TEXT_MODEL_INVALID",
            format!("the selected {stage} model is not in Candor's verified local catalog"),
        ));
    }
    Ok(())
}

fn validate_dictionary_ids(ids: &[String]) -> Result<(), MeetingProfileError> {
    if ids.len() > MAX_DICTIONARY_IDS {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_DICTIONARY_LIMIT",
            format!("a profile may reference at most {MAX_DICTIONARY_IDS} dictionaries"),
        ));
    }
    let mut unique = HashSet::new();
    for id in ids {
        validate_safe_id(id, "dictionary")?;
        if !unique.insert(id.as_str()) {
            return Err(MeetingProfileError::new(
                "MEETING_PROFILE_DICTIONARY_DUPLICATE",
                "a profile cannot reference the same dictionary more than once",
            ));
        }
    }
    Ok(())
}

fn validate_recap_template(template: &str) -> Result<(), MeetingProfileError> {
    if template.len() > MAX_RECAP_TEMPLATE_BYTES || template.contains('\0') {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_RECAP_TEMPLATE_INVALID",
            format!("recap templates may contain at most {MAX_RECAP_TEMPLATE_BYTES} bytes"),
        ));
    }
    Ok(())
}

fn validate_safe_id(id: &str, kind: &str) -> Result<(), MeetingProfileError> {
    let valid = !id.is_empty()
        && id.len() <= MAX_PROFILE_ID_BYTES
        && id.as_bytes()[0].is_ascii_lowercase()
        && id.as_bytes()[id.len() - 1].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !id.contains("--");
    if !valid {
        return Err(MeetingProfileError::new(
            "MEETING_PROFILE_ID_INVALID",
            format!("{kind} IDs must be bounded lowercase identifiers"),
        ));
    }
    Ok(())
}

fn next_profile_id(stored: &StoredProfiles) -> String {
    loop {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let sequence = PROFILE_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = format!("custom-{now:x}-{sequence:x}");
        if !stored
            .custom_profiles
            .iter()
            .any(|profile| profile.id == candidate)
        {
            return candidate;
        }
    }
}

fn profile_response(profile: MeetingProfile) -> Value {
    json!({
        "implemented": true,
        "profile": profile,
        "localOnly": true,
        "networkAttempted": false,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn is_built_in_id(id: &str) -> bool {
    matches!(
        id,
        "general" | "one-on-one" | "interview" | "standup" | "lecture"
    )
}

fn built_in_profiles() -> Vec<MeetingProfile> {
    vec![
        built_in(
            "general",
            "General",
            ProfileCaptureSource::Microphone,
            "auto",
            ProfileModelTier::Balanced,
            "Summarize the discussion, decisions, action items, and open questions.",
            true,
        ),
        built_in(
            "one-on-one",
            "1:1",
            ProfileCaptureSource::Combined,
            "auto",
            ProfileModelTier::Balanced,
            "Summarize updates, feedback, commitments, and follow-up topics.",
            true,
        ),
        built_in(
            "interview",
            "Interview",
            ProfileCaptureSource::Combined,
            "auto",
            ProfileModelTier::Maximum,
            "Summarize questions, evidence, strengths, concerns, and follow-ups without making a hiring decision.",
            false,
        ),
        built_in(
            "standup",
            "Standup",
            ProfileCaptureSource::Combined,
            "auto",
            ProfileModelTier::Fast,
            "Summarize progress, next steps, blockers, and owners.",
            true,
        ),
        built_in(
            "lecture",
            "Lecture",
            ProfileCaptureSource::SystemAudio,
            "auto",
            ProfileModelTier::Maximum,
            "Create structured notes with main ideas, definitions, examples, and review questions.",
            false,
        ),
    ]
}

fn built_in(
    id: &str,
    name: &str,
    capture_source: ProfileCaptureSource,
    language: &str,
    local_model_tier: ProfileModelTier,
    recap_template: &str,
    live_transcription: bool,
) -> MeetingProfile {
    let speech_model_id = model_id_for_profile(capture_source, local_model_tier, language);
    MeetingProfile {
        schema_version: PROFILE_RECORD_SCHEMA_VERSION,
        version: 1,
        id: id.to_string(),
        name: name.to_string(),
        capture_source,
        language: language.to_string(),
        local_model_tier,
        speech_model_id,
        cleanup_model_id: Some(DEFAULT_TEXT_MODEL_ID.to_string()),
        summary_model_id: Some(DEFAULT_TEXT_MODEL_ID.to_string()),
        dictionary_ids: Vec::new(),
        replacement_rule_set_id: None,
        recap_template: recap_template.to_string(),
        live_transcription,
        built_in: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording_store::{RecordingStore, StartRecordingParams};
    use crate::replacement_rules::{
        ReplacementMatchMode, ReplacementRule, ReplacementRuleService,
        ReplacementRuleSetUpsertParams,
    };

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "candor-meeting-profiles-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn custom_params(id: Option<&str>, name: &str) -> MeetingProfileUpsertParams {
        MeetingProfileUpsertParams {
            id: id.map(str::to_string),
            expected_version: None,
            name: name.to_string(),
            capture_source: ProfileCaptureSource::Combined,
            language: "en-US".to_string(),
            local_model_tier: ProfileModelTier::Balanced,
            speech_model_id: None,
            cleanup_model_id: None,
            summary_model_id: None,
            dictionary_ids: vec!["product-terms".to_string()],
            replacement_rule_set_id: Some("product-corrections".to_string()),
            recap_template: "Summarize decisions and action items.".to_string(),
            live_transcription: true,
        }
    }

    fn replacement_params(
        expected_version: Option<u32>,
        replacement: &str,
    ) -> ReplacementRuleSetUpsertParams {
        ReplacementRuleSetUpsertParams {
            id: Some("product-corrections".to_string()),
            expected_version,
            name: "Product corrections".to_string(),
            rules: vec![ReplacementRule {
                id: "company".to_string(),
                order: 0,
                match_mode: ReplacementMatchMode::WholeWord,
                literal: "acmi".to_string(),
                replacement: replacement.to_string(),
                protected_term_review: false,
                enabled: true,
            }],
        }
    }

    #[test]
    fn built_ins_are_complete_and_immutable() {
        let root = root("built-ins");
        let service = MeetingProfileService::with_root(root.clone());
        let list = service.list().expect("list built-ins");
        assert_eq!(list["profileCount"], 5);
        assert_eq!(list["profiles"][0]["id"], "general");
        assert_eq!(list["profiles"][0]["captureSource"], "microphone");
        assert_eq!(list["profiles"][1]["name"], "1:1");
        assert_eq!(list["profiles"][4]["captureSource"], "system-audio");
        assert_eq!(list["rawPathExposed"], false);

        let error = service
            .upsert_custom(custom_params(Some("general"), "Changed"))
            .unwrap_err();
        assert_eq!(error.code, "MEETING_PROFILE_BUILT_IN_IMMUTABLE");
        let delete_error = service
            .delete_custom(MeetingProfileDeleteParams {
                id: "lecture".to_string(),
                expected_version: 1,
            })
            .unwrap_err();
        assert_eq!(delete_error.code, "MEETING_PROFILE_BUILT_IN_IMMUTABLE");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn custom_profiles_persist_atomically_and_ignore_stale_temp_data() {
        let root = root("atomic");
        let service = MeetingProfileService::with_root(root.clone());
        let saved = service
            .upsert_custom(custom_params(Some("customer-call"), "Customer call"))
            .expect("save custom profile");
        assert_eq!(saved["profile"]["version"], 1);
        fs::write(root.join(PROFILE_TEMP_FILE), b"interrupted write").unwrap();

        let reopened = MeetingProfileService::with_root(root.clone());
        let resolved = reopened
            .resolve("customer-call")
            .expect("read committed profile");
        assert_eq!(resolved.name, "Customer call");
        let mut update = custom_params(Some("customer-call"), "Customer review");
        update.expected_version = Some(1);
        let updated = reopened.upsert_custom(update).expect("atomic replacement");
        assert_eq!(updated["profile"]["version"], 2);
        assert!(!root.join(PROFILE_TEMP_FILE).exists());
        assert!(!root.join(PROFILE_BACKUP_FILE).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn schema_one_profiles_migrate_atomically_to_explicit_stage_models() {
        let root = root("schema-one-migration");
        fs::create_dir_all(&root).expect("profile directory");
        fs::write(
            root.join(PROFILE_FILE),
            serde_json::to_vec_pretty(&json!({
                "schemaVersion": 1,
                "activeProfileId": "legacy-profile",
                "customProfiles": [{
                    "schemaVersion": 1,
                    "version": 3,
                    "id": "legacy-profile",
                    "name": "Legacy profile",
                    "captureSource": "combined",
                    "language": "en-US",
                    "localModelTier": "balanced",
                    "dictionaryIds": [],
                    "replacementRuleSetId": null,
                    "recapTemplate": "Summarize the meeting.",
                    "liveTranscription": true,
                    "builtIn": false
                }]
            }))
            .expect("legacy JSON"),
        )
        .expect("legacy profile store");

        let service = MeetingProfileService::with_root(root.clone());
        let migrated = service.resolve("legacy-profile").expect("migrated profile");
        assert_eq!(migrated.schema_version, 2);
        assert_eq!(migrated.version, 3);
        assert_eq!(migrated.speech_model_id, "large-v3-turbo");
        assert_eq!(
            migrated.cleanup_model_id.as_deref(),
            Some(DEFAULT_TEXT_MODEL_ID)
        );
        assert_eq!(
            migrated.summary_model_id.as_deref(),
            Some(DEFAULT_TEXT_MODEL_ID)
        );

        let persisted: Value = serde_json::from_slice(
            &fs::read(root.join(PROFILE_FILE)).expect("persisted migrated store"),
        )
        .expect("persisted migrated JSON");
        assert_eq!(persisted["schemaVersion"], 2);
        assert_eq!(persisted["customProfiles"][0]["schemaVersion"], 2);
        assert_eq!(
            persisted["customProfiles"][0]["speechModelId"],
            "large-v3-turbo"
        );
        assert_eq!(persisted["migrations"][0]["fromSchemaVersion"], 1);
        assert_eq!(persisted["migrations"][0]["toSchemaVersion"], 2);
        assert_eq!(persisted["migrations"][0]["migratedProfileCount"], 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parakeet_selection_is_a_valid_explicit_engine_override() {
        let root = root("parakeet-gate");
        let service = MeetingProfileService::with_root(root.clone());
        let replacements = ReplacementRuleService::with_root(root.clone());
        let mut params = custom_params(Some("parakeet-profile"), "Parakeet attempt");
        params.local_model_tier = ProfileModelTier::Fast;
        params.speech_model_id = Some(PARAKEET_MODEL_ID.to_string());
        params.dictionary_ids = Vec::new();
        params.replacement_rule_set_id = None;
        let created = service
            .upsert_custom(params)
            .expect("Parakeet can be selected after the model library verifies it");
        assert_eq!(created["profile"]["speechModelId"], PARAKEET_MODEL_ID);
        let snapshot = service
            .processing_snapshot_for_capture(
                "parakeet-profile",
                1,
                ProfileCaptureSource::Combined,
                &replacements,
            )
            .expect("Parakeet profile binds to an immutable capture snapshot");
        assert_eq!(snapshot.model_id, PARAKEET_MODEL_ID);
        assert_eq!(snapshot.speech_model_id.as_deref(), Some(PARAKEET_MODEL_ID));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recording_keeps_capture_start_profile_after_profile_and_rules_change() {
        let root = root("capture-binding");
        let settings_root = root.join("settings");
        let profile_service = MeetingProfileService::with_root(settings_root.clone());
        let replacement_service = ReplacementRuleService::with_root(settings_root);
        replacement_service
            .upsert_custom(replacement_params(None, "Acme"))
            .expect("save initial rules");
        profile_service
            .upsert_custom(custom_params(Some("customer-call"), "Customer call"))
            .expect("save initial profile");
        profile_service
            .select(MeetingProfileSelectParams {
                id: "customer-call".to_string(),
            })
            .expect("select profile");
        assert_eq!(
            profile_service
                .processing_snapshot_for_capture(
                    "customer-call",
                    1,
                    ProfileCaptureSource::Microphone,
                    &replacement_service,
                )
                .unwrap_err()
                .code,
            "MEETING_PROFILE_CAPTURE_SOURCE_MISMATCH"
        );

        let captured = profile_service
            .active_processing_snapshot_for_capture(
                ProfileCaptureSource::Combined,
                &replacement_service,
            )
            .expect("capture profile snapshot");
        let store = RecordingStore::with_root(root.join("vault"));
        let started = store
            .start_with_processing_profile(
                StartRecordingParams {
                    label: Some("Bound meeting".to_string()),
                },
                Some(captured),
            )
            .expect("start bound recording");
        let recording_id = started["recordingId"].as_str().unwrap().to_string();

        replacement_service
            .upsert_custom(replacement_params(Some(1), "Acme Corporation"))
            .expect("change rules during capture");
        let mut changed = custom_params(Some("customer-call"), "Customer review");
        changed.expected_version = Some(1);
        changed.language = "fr".to_string();
        changed.local_model_tier = ProfileModelTier::Maximum;
        changed.recap_template = "Use the new template.".to_string();
        profile_service
            .upsert_custom(changed)
            .expect("change profile during capture");
        assert_eq!(
            profile_service
                .processing_snapshot_for_capture(
                    "customer-call",
                    1,
                    ProfileCaptureSource::Combined,
                    &replacement_service,
                )
                .unwrap_err()
                .code,
            "MEETING_PROFILE_VERSION_CONFLICT"
        );

        let stored = store
            .processing_profile(&recording_id)
            .expect("read bound profile")
            .expect("profile present");
        assert_eq!(stored.profile_id, "customer-call");
        assert_eq!(stored.profile_version, 1);
        assert_eq!(stored.model_id, "large-v3-turbo");
        assert_eq!(stored.language, "en-US");
        assert_eq!(stored.transcription_language, "en");
        assert_eq!(
            stored.recap_template.as_deref(),
            Some("Summarize decisions and action items.")
        );
        let stored_rules = stored.replacement_rule_set.expect("rules bound");
        assert_eq!(stored_rules.version, 1);
        assert_eq!(stored_rules.rules[0].replacement, "Acme");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_store_is_rejected_and_valid_backup_is_recoverable() {
        let root = root("corrupt");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(PROFILE_FILE), b"not-json").unwrap();
        let service = MeetingProfileService::with_root(root.clone());
        assert_eq!(
            service.list().unwrap_err().code,
            "MEETING_PROFILE_STORE_INVALID"
        );

        let backup = StoredProfiles {
            schema_version: PROFILE_STORE_SCHEMA_VERSION,
            active_profile_id: default_active_profile_id(),
            migrations: Vec::new(),
            custom_profiles: vec![MeetingProfile {
                schema_version: PROFILE_RECORD_SCHEMA_VERSION,
                version: 1,
                id: "recovered".to_string(),
                name: "Recovered".to_string(),
                capture_source: ProfileCaptureSource::Microphone,
                language: "en".to_string(),
                local_model_tier: ProfileModelTier::Fast,
                speech_model_id: "small.en".to_string(),
                cleanup_model_id: Some(DEFAULT_TEXT_MODEL_ID.to_string()),
                summary_model_id: Some(DEFAULT_TEXT_MODEL_ID.to_string()),
                dictionary_ids: Vec::new(),
                replacement_rule_set_id: None,
                recap_template: String::new(),
                live_transcription: false,
                built_in: false,
            }],
        };
        fs::write(
            root.join(PROFILE_BACKUP_FILE),
            serde_json::to_vec(&backup).unwrap(),
        )
        .unwrap();
        assert_eq!(service.resolve("recovered").unwrap().name, "Recovered");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_primary_promotes_valid_backup_after_interrupted_commit() {
        let root = root("backup-promotion");
        let service = MeetingProfileService::with_root(root.clone());
        service
            .upsert_custom(custom_params(Some("recovered"), "Recovered"))
            .expect("seed custom profile");
        fs::rename(root.join(PROFILE_FILE), root.join(PROFILE_BACKUP_FILE))
            .expect("simulate interrupted commit");

        let reopened = MeetingProfileService::with_root(root.clone());
        assert_eq!(reopened.resolve("recovered").unwrap().name, "Recovered");
        assert!(root.join(PROFILE_FILE).is_file());
        assert!(!root.join(PROFILE_BACKUP_FILE).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn active_profile_selection_persists_and_falls_back_when_deleted() {
        let root = root("active");
        let service = MeetingProfileService::with_root(root.clone());
        let saved = service
            .upsert_custom(custom_params(Some("customer-call"), "Customer call"))
            .expect("save custom profile");
        assert_eq!(
            service
                .select(MeetingProfileSelectParams {
                    id: "customer-call".to_string(),
                })
                .expect("select custom profile")["activeProfileId"],
            "customer-call"
        );
        assert_eq!(service.list().unwrap()["activeProfileId"], "customer-call");
        assert_eq!(service.active_profile().unwrap().id, "customer-call");
        service
            .delete_custom(MeetingProfileDeleteParams {
                id: "customer-call".to_string(),
                expected_version: saved["profile"]["version"].as_u64().unwrap() as u32,
            })
            .expect("delete selected custom profile");
        assert_eq!(service.list().unwrap()["activeProfileId"], "general");
        assert_eq!(service.active_profile().unwrap().id, "general");
        assert_eq!(
            MeetingProfileService::with_root(root.clone())
                .list()
                .unwrap()["activeProfileId"],
            "general"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_boundaries_and_safe_ids_are_enforced() {
        let root = root("bounds");
        let service = MeetingProfileService::with_root(root.clone());
        let mut too_long = custom_params(None, &"x".repeat(MAX_PROFILE_NAME_BYTES + 1));
        assert_eq!(
            service.upsert_custom(too_long.clone()).unwrap_err().code,
            "MEETING_PROFILE_NAME_INVALID"
        );
        too_long.name = "Valid".to_string();
        too_long.id = Some("../unsafe".to_string());
        assert_eq!(
            service.upsert_custom(too_long).unwrap_err().code,
            "MEETING_PROFILE_ID_INVALID"
        );

        for index in 0..MAX_CUSTOM_PROFILES {
            service
                .upsert_custom(custom_params(
                    Some(&format!("custom-{index}")),
                    &format!("Custom {index}"),
                ))
                .unwrap();
        }
        assert_eq!(
            service
                .upsert_custom(custom_params(Some("one-too-many"), "One too many"))
                .unwrap_err()
                .code,
            "MEETING_PROFILE_LIMIT_REACHED"
        );
        let _ = fs::remove_dir_all(root);
    }
}
