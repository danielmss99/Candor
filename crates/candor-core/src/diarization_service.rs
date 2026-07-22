use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};
use getrandom::getrandom;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::os_key_store;
use candor_core::diarization::{
    evaluate_diarization_gate, DiarizationBenchmark, DiarizationGateStatus, SpeakerNameAssignments,
    VerifiedDiarizationLicenseEvidence, VerifiedLocalDiarizationModel, MAX_SPEAKER_ASSIGNMENTS,
};

const STORE_SCHEMA_VERSION: u32 = 1;
const STORE_FILE: &str = "diarization-store.bin";
const STORE_BACKUP_FILE: &str = "diarization-store.bin.bak";
const STORE_TEMP_FILE: &str = "diarization-store.bin.tmp";
const STORE_MAGIC: &[u8] = b"candor-diarization-v1\0";
const STORE_AAD: &[u8] = b"candor-diarization-store-v1";
const STORE_KEY_LABEL: &[u8] = b"candor-diarization-store-v1";
const NONCE_BYTES: usize = 12;
const MAX_STORE_BYTES: u64 = 1024 * 1024;
const MAX_RECORDING_ASSIGNMENT_SETS: usize = 128;
const MAX_RECORDING_ID_BYTES: usize = 96;

#[derive(Debug)]
pub struct DiarizationServiceError {
    pub code: &'static str,
    pub message: String,
}

impl DiarizationServiceError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiarizationPreferenceParams {
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiarizationRecordingParams {
    pub recording_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiarizationAssignSpeakerNameParams {
    pub recording_id: String,
    pub anonymous_speaker_id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiarizationRemoveSpeakerNameParams {
    pub recording_id: String,
    pub anonymous_speaker_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSpeakerName {
    anonymous_speaker_id: String,
    display_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRecordingNames {
    recording_id: String,
    assignments: Vec<StoredSpeakerName>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiarizationDocument {
    schema_version: u32,
    enabled_by_user: bool,
    recording_names: Vec<StoredRecordingNames>,
}

impl Default for DiarizationDocument {
    fn default() -> Self {
        Self {
            schema_version: STORE_SCHEMA_VERSION,
            enabled_by_user: false,
            recording_names: Vec::new(),
        }
    }
}

/// Core-owned diarization state.
///
/// Renderer input can change only the opt-in preference and explicit display names.
/// Model and benchmark evidence can be supplied only through the trusted constructor.
#[derive(Clone)]
pub struct DiarizationService {
    root: PathBuf,
    key_root: PathBuf,
    engine_available: bool,
    verified_model: Option<VerifiedLocalDiarizationModel>,
    license_evidence: Option<VerifiedDiarizationLicenseEvidence>,
    benchmark: Option<DiarizationBenchmark>,
    storage_lock: Arc<Mutex<()>>,
    #[cfg(test)]
    test_encryption_key: Option<[u8; 32]>,
}

impl DiarizationService {
    pub fn with_roots(root: PathBuf, key_root: PathBuf) -> Self {
        Self::with_trusted_runtime(root, key_root, false, None, None, None)
    }

    /// Future local engines must enter through this core-only evidence boundary.
    /// A renderer value must never be promoted into either proof type.
    #[allow(dead_code)]
    pub(crate) fn with_trusted_runtime(
        root: PathBuf,
        key_root: PathBuf,
        engine_available: bool,
        verified_model: Option<VerifiedLocalDiarizationModel>,
        license_evidence: Option<VerifiedDiarizationLicenseEvidence>,
        benchmark: Option<DiarizationBenchmark>,
    ) -> Self {
        Self {
            root,
            key_root,
            engine_available,
            verified_model,
            license_evidence,
            benchmark,
            storage_lock: Arc::new(Mutex::new(())),
            #[cfg(test)]
            test_encryption_key: None,
        }
    }

    #[cfg(test)]
    fn with_test_runtime(
        root: PathBuf,
        engine_available: bool,
        verified_model: Option<VerifiedLocalDiarizationModel>,
        license_evidence: Option<VerifiedDiarizationLicenseEvidence>,
        benchmark: Option<DiarizationBenchmark>,
    ) -> Self {
        Self {
            key_root: root.join("keys"),
            root,
            engine_available,
            verified_model,
            license_evidence,
            benchmark,
            storage_lock: Arc::new(Mutex::new(())),
            test_encryption_key: Some([0x6d; 32]),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_roots(root: PathBuf, key_root: PathBuf) -> Self {
        Self {
            root,
            key_root,
            engine_available: false,
            verified_model: None,
            license_evidence: None,
            benchmark: None,
            storage_lock: Arc::new(Mutex::new(())),
            test_encryption_key: Some([0x6d; 32]),
        }
    }

    pub fn status(&self) -> Result<Value, DiarizationServiceError> {
        let document = self.load_document()?;
        Ok(self.status_for(&document, false))
    }

    pub fn update_preference(
        &self,
        params: DiarizationPreferenceParams,
    ) -> Result<Value, DiarizationServiceError> {
        let _guard = self.lock_storage()?;
        let mut document = self.load_document_unlocked()?;
        document.enabled_by_user = params.enabled;
        self.write_document_unlocked(&document)?;
        Ok(self.status_for(&document, true))
    }

    pub fn list_speaker_names(
        &self,
        params: DiarizationRecordingParams,
    ) -> Result<Value, DiarizationServiceError> {
        validate_recording_id(&params.recording_id)?;
        let document = self.load_document()?;
        let assignments = document
            .recording_names
            .iter()
            .find(|entry| entry.recording_id == params.recording_id)
            .map(|entry| validated_assignments(&entry.assignments))
            .transpose()?
            .unwrap_or_default()
            .list();
        Ok(speaker_names_response(params.recording_id, assignments))
    }

    pub fn assign_speaker_name(
        &self,
        params: DiarizationAssignSpeakerNameParams,
    ) -> Result<Value, DiarizationServiceError> {
        validate_recording_id(&params.recording_id)?;
        let _guard = self.lock_storage()?;
        let mut document = self.load_document_unlocked()?;
        let recording_index = match document
            .recording_names
            .iter()
            .position(|entry| entry.recording_id == params.recording_id)
        {
            Some(index) => index,
            None => {
                if document.recording_names.len() >= MAX_RECORDING_ASSIGNMENT_SETS {
                    return Err(DiarizationServiceError::new(
                        "DIARIZATION_RECORDING_LIMIT",
                        "speaker names have reached the local recording limit",
                    ));
                }
                document.recording_names.push(StoredRecordingNames {
                    recording_id: params.recording_id.clone(),
                    assignments: Vec::new(),
                });
                document.recording_names.len() - 1
            }
        };
        let recording_names = &mut document.recording_names[recording_index];
        let mut assignments = validated_assignments(&recording_names.assignments)?;
        assignments
            .assign(params.anonymous_speaker_id, params.display_name)
            .map_err(diarization_foundation_error)?;
        recording_names.assignments = assignments
            .list()
            .into_iter()
            .map(|assignment| StoredSpeakerName {
                anonymous_speaker_id: assignment.anonymous_speaker_id,
                display_name: assignment.display_name,
            })
            .collect();
        document
            .recording_names
            .sort_by(|left, right| left.recording_id.cmp(&right.recording_id));
        self.write_document_unlocked(&document)?;
        let assignments = document
            .recording_names
            .iter()
            .find(|entry| entry.recording_id == params.recording_id)
            .map(|entry| validated_assignments(&entry.assignments))
            .transpose()?
            .unwrap_or_default()
            .list();
        Ok(speaker_names_response(params.recording_id, assignments))
    }

    pub fn remove_speaker_name(
        &self,
        params: DiarizationRemoveSpeakerNameParams,
    ) -> Result<Value, DiarizationServiceError> {
        validate_recording_id(&params.recording_id)?;
        let _guard = self.lock_storage()?;
        let mut document = self.load_document_unlocked()?;
        let mut removed = false;
        if let Some(recording_names) = document
            .recording_names
            .iter_mut()
            .find(|entry| entry.recording_id == params.recording_id)
        {
            let mut assignments = validated_assignments(&recording_names.assignments)?;
            removed = assignments
                .remove(&params.anonymous_speaker_id)
                .map_err(diarization_foundation_error)?
                .is_some();
            recording_names.assignments = assignments
                .list()
                .into_iter()
                .map(|assignment| StoredSpeakerName {
                    anonymous_speaker_id: assignment.anonymous_speaker_id,
                    display_name: assignment.display_name,
                })
                .collect();
        } else {
            let mut assignments = SpeakerNameAssignments::default();
            assignments
                .remove(&params.anonymous_speaker_id)
                .map_err(diarization_foundation_error)?;
        }
        document
            .recording_names
            .retain(|entry| !entry.assignments.is_empty());
        self.write_document_unlocked(&document)?;
        let assignments = document
            .recording_names
            .iter()
            .find(|entry| entry.recording_id == params.recording_id)
            .map(|entry| validated_assignments(&entry.assignments))
            .transpose()?
            .unwrap_or_default()
            .list();
        let mut response = speaker_names_response(params.recording_id, assignments);
        response["removed"] = json!(removed);
        Ok(response)
    }

    pub fn remove_recording(&self, recording_id: &str) -> Result<(), DiarizationServiceError> {
        validate_recording_id(recording_id)?;
        let _guard = self.lock_storage()?;
        let mut document = self.load_document_unlocked()?;
        document
            .recording_names
            .retain(|entry| entry.recording_id != recording_id);
        // Always rewrite during deletion so a fallback-only backup is promoted
        // as sanitized primary state before the old backup is removed.
        self.write_document_unlocked(&document)?;
        Ok(())
    }

    fn status_for(&self, document: &DiarizationDocument, saved_locally: bool) -> Value {
        let evaluation = evaluate_diarization_gate(
            document.enabled_by_user,
            self.verified_model.as_ref(),
            self.license_evidence.as_ref(),
            self.benchmark.as_ref(),
        );
        let gate_ready = evaluation.decision.status == DiarizationGateStatus::Ready;
        let available = self.engine_available && gate_ready;
        let (state, reason_code) = if !document.enabled_by_user {
            ("disabled", evaluation.decision.reason_code)
        } else if !self.engine_available {
            ("engine-unavailable", "DIARIZATION_ENGINE_UNAVAILABLE")
        } else if available {
            ("ready", evaluation.decision.reason_code)
        } else {
            ("gated", evaluation.decision.reason_code)
        };
        json!({
            "implemented": true,
            "schemaVersion": STORE_SCHEMA_VERSION,
            "state": state,
            "reasonCode": reason_code,
            "enabledByUser": document.enabled_by_user,
            "savedLocally": saved_locally,
            "engineAvailable": self.engine_available,
            "diarizationAvailable": available,
            "diarizationRunning": false,
            "modelVerified": self.verified_model.is_some(),
            "licenseEvidenceVerified": evaluation.decision.license_evidence_verified,
            "redistributionAllowed": evaluation.decision.redistribution_allowed,
            "benchmarkPassed": gate_ready,
            "benchmarkRequired": evaluation.decision.benchmark_required,
            "gate": evaluation.decision,
            "speakerNamingAvailable": true,
            "anonymousSpeakerLabelsOnly": true,
            "identityInferred": false,
            "biometricIdentityClaimed": false,
            "encryptedAtRest": true,
            "localOnly": true,
            "networkAttempted": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    fn load_document(&self) -> Result<DiarizationDocument, DiarizationServiceError> {
        let _guard = self.lock_storage()?;
        self.load_document_unlocked()
    }

    fn load_document_unlocked(&self) -> Result<DiarizationDocument, DiarizationServiceError> {
        let target = self.root.join(STORE_FILE);
        let backup = self.root.join(STORE_BACKUP_FILE);
        if target.exists() {
            return self.read_encrypted_document(&target);
        }
        if backup.exists() {
            return self.read_encrypted_document(&backup);
        }
        Ok(DiarizationDocument::default())
    }

    fn read_encrypted_document(
        &self,
        path: &Path,
    ) -> Result<DiarizationDocument, DiarizationServiceError> {
        let metadata = fs::symlink_metadata(path).map_err(|_| {
            DiarizationServiceError::new(
                "DIARIZATION_STORE_READ_FAILED",
                "encrypted speaker names could not be read",
            )
        })?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() == 0
            || metadata.len() > MAX_STORE_BYTES
        {
            return Err(DiarizationServiceError::new(
                "DIARIZATION_STORE_CORRUPT",
                "encrypted speaker names are invalid and were not changed",
            ));
        }
        let file = File::open(path).map_err(|_| {
            DiarizationServiceError::new(
                "DIARIZATION_STORE_READ_FAILED",
                "encrypted speaker names could not be read",
            )
        })?;
        let mut bytes = Vec::new();
        file.take(MAX_STORE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| {
                DiarizationServiceError::new(
                    "DIARIZATION_STORE_READ_FAILED",
                    "encrypted speaker names could not be read",
                )
            })?;
        if bytes.len() <= STORE_MAGIC.len() + NONCE_BYTES
            || bytes.len() as u64 > MAX_STORE_BYTES
            || !bytes.starts_with(STORE_MAGIC)
        {
            return Err(DiarizationServiceError::new(
                "DIARIZATION_STORE_CORRUPT",
                "encrypted speaker names are invalid and were not changed",
            ));
        }
        let nonce_start = STORE_MAGIC.len();
        let payload_start = nonce_start + NONCE_BYTES;
        let key = self.encryption_key()?;
        let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| {
            DiarizationServiceError::new(
                "DIARIZATION_KEY_INVALID",
                "speaker-name encryption could not be initialized",
            )
        })?;
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&bytes[nonce_start..payload_start]),
                Payload {
                    msg: &bytes[payload_start..],
                    aad: STORE_AAD,
                },
            )
            .map_err(|_| {
                DiarizationServiceError::new(
                    "DIARIZATION_STORE_CORRUPT",
                    "encrypted speaker names are invalid and were not changed",
                )
            })?;
        let document = serde_json::from_slice::<DiarizationDocument>(&plaintext).map_err(|_| {
            DiarizationServiceError::new(
                "DIARIZATION_STORE_CORRUPT",
                "encrypted speaker names are invalid and were not changed",
            )
        })?;
        validate_document(&document)?;
        Ok(document)
    }

    fn lock_storage(&self) -> Result<MutexGuard<'_, ()>, DiarizationServiceError> {
        self.storage_lock.lock().map_err(|_| {
            DiarizationServiceError::new(
                "DIARIZATION_STORE_LOCK_FAILED",
                "speaker names are temporarily unavailable",
            )
        })
    }

    fn write_document_unlocked(
        &self,
        document: &DiarizationDocument,
    ) -> Result<(), DiarizationServiceError> {
        validate_document(document)?;
        fs::create_dir_all(&self.root).map_err(|_| {
            DiarizationServiceError::new(
                "DIARIZATION_STORE_DIR_FAILED",
                "speaker-name storage could not be prepared",
            )
        })?;
        let plaintext = serde_json::to_vec(document).map_err(|_| {
            DiarizationServiceError::new(
                "DIARIZATION_STORE_SERIALIZE_FAILED",
                "speaker names could not be encoded",
            )
        })?;
        let mut nonce = [0_u8; NONCE_BYTES];
        getrandom(&mut nonce).map_err(|_| {
            DiarizationServiceError::new(
                "DIARIZATION_RANDOM_FAILED",
                "speaker-name encryption could not obtain secure randomness",
            )
        })?;
        let key = self.encryption_key()?;
        let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| {
            DiarizationServiceError::new(
                "DIARIZATION_KEY_INVALID",
                "speaker-name encryption could not be initialized",
            )
        })?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: STORE_AAD,
                },
            )
            .map_err(|_| {
                DiarizationServiceError::new(
                    "DIARIZATION_ENCRYPT_FAILED",
                    "speaker names could not be encrypted",
                )
            })?;
        let total_bytes = STORE_MAGIC
            .len()
            .saturating_add(NONCE_BYTES)
            .saturating_add(ciphertext.len());
        if total_bytes as u64 > MAX_STORE_BYTES {
            return Err(DiarizationServiceError::new(
                "DIARIZATION_STORE_LIMIT",
                "speaker names exceed the encrypted local storage limit",
            ));
        }

        let target = self.root.join(STORE_FILE);
        let backup = self.root.join(STORE_BACKUP_FILE);
        let temporary = self.root.join(STORE_TEMP_FILE);
        ensure_regular_or_missing(&target)?;
        ensure_regular_or_missing(&backup)?;
        ensure_regular_or_missing(&temporary)?;
        if temporary.exists() {
            fs::remove_file(&temporary).map_err(|_| {
                DiarizationServiceError::new(
                    "DIARIZATION_STORE_TEMP_FAILED",
                    "a stale speaker-name update could not be removed",
                )
            })?;
        }
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| {
            DiarizationServiceError::new(
                "DIARIZATION_STORE_WRITE_FAILED",
                "encrypted speaker names could not be written",
            )
        })?;
        file.write_all(STORE_MAGIC)
            .and_then(|_| file.write_all(&nonce))
            .and_then(|_| file.write_all(&ciphertext))
            .and_then(|_| file.sync_all())
            .map_err(|_| {
                DiarizationServiceError::new(
                    "DIARIZATION_STORE_WRITE_FAILED",
                    "encrypted speaker names could not be written durably",
                )
            })?;
        drop(file);

        if backup.exists() {
            fs::remove_file(&backup).map_err(|_| {
                DiarizationServiceError::new(
                    "DIARIZATION_STORE_BACKUP_FAILED",
                    "the prior speaker-name backup could not be rotated",
                )
            })?;
        }
        let had_target = target.exists();
        if had_target {
            fs::rename(&target, &backup).map_err(|_| {
                DiarizationServiceError::new(
                    "DIARIZATION_STORE_BACKUP_FAILED",
                    "current speaker names could not be backed up",
                )
            })?;
        }
        if fs::rename(&temporary, &target).is_err() {
            if had_target && backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            let _ = fs::remove_file(&temporary);
            return Err(DiarizationServiceError::new(
                "DIARIZATION_STORE_COMMIT_FAILED",
                "new speaker names could not be committed",
            ));
        }
        if backup.exists() {
            fs::remove_file(&backup).map_err(|_| {
                DiarizationServiceError::new(
                    "DIARIZATION_STORE_BACKUP_CLEANUP_FAILED",
                    "the prior speaker-name backup could not be removed after commit",
                )
            })?;
        }
        Ok(())
    }

    fn encryption_key(&self) -> Result<[u8; 32], DiarizationServiceError> {
        #[cfg(test)]
        if let Some(key) = self.test_encryption_key {
            return Ok(key);
        }
        let key = os_key_store::get_or_create_key(&self.key_root).map_err(|_| {
            DiarizationServiceError::new(
                "DIARIZATION_KEY_UNAVAILABLE",
                "encrypted speaker-name storage is unavailable",
            )
        })?;
        Ok(key.derive_key(STORE_KEY_LABEL))
    }
}

fn validate_document(document: &DiarizationDocument) -> Result<(), DiarizationServiceError> {
    if document.schema_version != STORE_SCHEMA_VERSION
        || document.recording_names.len() > MAX_RECORDING_ASSIGNMENT_SETS
    {
        return Err(DiarizationServiceError::new(
            "DIARIZATION_STORE_CORRUPT",
            "encrypted speaker names are invalid and were not changed",
        ));
    }
    let mut recording_ids = std::collections::HashSet::new();
    for entry in &document.recording_names {
        validate_recording_id(&entry.recording_id)?;
        if !recording_ids.insert(entry.recording_id.as_str())
            || entry.assignments.is_empty()
            || entry.assignments.len() > MAX_SPEAKER_ASSIGNMENTS
        {
            return Err(DiarizationServiceError::new(
                "DIARIZATION_STORE_CORRUPT",
                "encrypted speaker names are invalid and were not changed",
            ));
        }
        validated_assignments(&entry.assignments)?;
    }
    Ok(())
}

fn validated_assignments(
    stored: &[StoredSpeakerName],
) -> Result<SpeakerNameAssignments, DiarizationServiceError> {
    let mut assignments = SpeakerNameAssignments::default();
    for entry in stored {
        assignments
            .assign(
                entry.anonymous_speaker_id.clone(),
                entry.display_name.clone(),
            )
            .map_err(diarization_foundation_error)?;
    }
    if assignments.list().len() != stored.len() {
        return Err(DiarizationServiceError::new(
            "DIARIZATION_STORE_CORRUPT",
            "encrypted speaker names contain duplicate anonymous speakers",
        ));
    }
    Ok(assignments)
}

fn validate_recording_id(value: &str) -> Result<(), DiarizationServiceError> {
    if value.is_empty()
        || value.len() > MAX_RECORDING_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(DiarizationServiceError::new(
            "DIARIZATION_RECORDING_ID_INVALID",
            "recording identifier is invalid",
        ));
    }
    Ok(())
}

fn diarization_foundation_error(
    error: candor_core::diarization::DiarizationError,
) -> DiarizationServiceError {
    DiarizationServiceError::new(error.code, error.message)
}

fn ensure_regular_or_missing(path: &Path) -> Result<(), DiarizationServiceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(DiarizationServiceError::new(
                "DIARIZATION_STORE_UNSAFE_PATH",
                "speaker-name storage must use a regular local file",
            ))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(DiarizationServiceError::new(
            "DIARIZATION_STORE_READ_FAILED",
            "speaker-name storage could not be inspected",
        )),
    }
}

fn speaker_names_response(
    recording_id: String,
    assignments: Vec<candor_core::diarization::SpeakerNameAssignment>,
) -> Value {
    json!({
        "implemented": true,
        "recordingId": recording_id,
        "assignmentCount": assignments.len(),
        "assignments": assignments,
        "userControlled": true,
        "identityInferred": false,
        "biometricIdentityClaimed": false,
        "anonymousSpeakerLabelsOnly": true,
        "encryptedAtRest": true,
        "localOnly": true,
        "networkAttempted": false,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use candor_core::diarization::{
        DIARIZATION_BENCHMARK_SCHEMA_VERSION, DIARIZATION_LICENSE_EVIDENCE_SCHEMA_VERSION,
        MIN_BENCHMARK_SAMPLE_DURATION_MS,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn license() -> VerifiedDiarizationLicenseEvidence {
        VerifiedDiarizationLicenseEvidence::from_reviewed_license(
            DIARIZATION_LICENSE_EVIDENCE_SCHEMA_VERSION,
            "diarization-small",
            DIGEST,
            "mpl-2-0",
            true,
            true,
        )
        .unwrap()
    }

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "candor-diarization-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn default_status_is_honestly_disabled_and_engine_unavailable() {
        let root = root("default");
        let service = DiarizationService::with_test_runtime(root.clone(), false, None, None, None);
        let status = service.status().unwrap();
        assert_eq!(status["state"], "disabled");
        assert_eq!(status["engineAvailable"], false);
        assert_eq!(status["diarizationAvailable"], false);
        assert_eq!(status["biometricIdentityClaimed"], false);
        assert_eq!(status["networkAttempted"], false);

        let enabled = service
            .update_preference(DiarizationPreferenceParams { enabled: true })
            .unwrap();
        assert_eq!(enabled["state"], "engine-unavailable");
        assert_eq!(enabled["reasonCode"], "DIARIZATION_ENGINE_UNAVAILABLE");
        assert_eq!(enabled["gate"]["status"], "model-not-verified");
        assert_eq!(enabled["savedLocally"], true);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verified_model_and_benchmark_still_require_an_engine() {
        let root = root("gate");
        let model = VerifiedLocalDiarizationModel::from_verified_local_artifact(
            "diarization-small",
            DIGEST,
        )
        .unwrap();
        let benchmark = DiarizationBenchmark::new(
            DIARIZATION_BENCHMARK_SCHEMA_VERSION,
            "diarization-small",
            DIGEST,
            MIN_BENCHMARK_SAMPLE_DURATION_MS,
            500,
            512 * 1024 * 1024,
            true,
            true,
        )
        .unwrap();
        let service = DiarizationService::with_test_runtime(
            root.clone(),
            false,
            Some(model),
            Some(license()),
            Some(benchmark),
        );
        let status = service
            .update_preference(DiarizationPreferenceParams { enabled: true })
            .unwrap();
        assert_eq!(status["benchmarkPassed"], true);
        assert_eq!(status["engineAvailable"], false);
        assert_eq!(status["diarizationAvailable"], false);
        assert_eq!(status["state"], "engine-unavailable");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn speaker_names_are_encrypted_persistent_and_user_controlled() {
        let root = root("names");
        let service = DiarizationService::with_test_runtime(root.clone(), false, None, None, None);
        let assigned = service
            .assign_speaker_name(DiarizationAssignSpeakerNameParams {
                recording_id: "recording_1".to_string(),
                anonymous_speaker_id: "speaker-1".to_string(),
                display_name: "Avery".to_string(),
            })
            .unwrap();
        assert_eq!(assigned["assignments"][0]["displayName"], "Avery");
        assert_eq!(assigned["assignments"][0]["identityInferred"], false);
        assert_eq!(assigned["encryptedAtRest"], true);

        let bytes = fs::read(root.join(STORE_FILE)).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("Avery"));
        assert!(!String::from_utf8_lossy(&bytes).contains("recording_1"));

        let reopened = DiarizationService::with_test_runtime(root.clone(), false, None, None, None);
        let listed = reopened
            .list_speaker_names(DiarizationRecordingParams {
                recording_id: "recording_1".to_string(),
            })
            .unwrap();
        assert_eq!(listed["assignmentCount"], 1);
        assert_eq!(listed["assignments"][0]["source"], "user");

        let removed = reopened
            .remove_speaker_name(DiarizationRemoveSpeakerNameParams {
                recording_id: "recording_1".to_string(),
                anonymous_speaker_id: "speaker-1".to_string(),
            })
            .unwrap();
        assert_eq!(removed["removed"], true);
        assert_eq!(removed["assignmentCount"], 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recording_deletion_rewrites_sanitized_names_and_removes_prior_backup() {
        let root = root("delete-names");
        let service = DiarizationService::with_test_runtime(root.clone(), false, None, None, None);
        for (recording_id, display_name) in [
            ("recording_delete", "Private deleted speaker"),
            ("recording_keep", "Retained speaker"),
        ] {
            service
                .assign_speaker_name(DiarizationAssignSpeakerNameParams {
                    recording_id: recording_id.to_string(),
                    anonymous_speaker_id: "speaker-1".to_string(),
                    display_name: display_name.to_string(),
                })
                .expect("seed speaker name");
        }
        fs::copy(root.join(STORE_FILE), root.join(STORE_BACKUP_FILE))
            .expect("seed prior-state speaker backup");

        service
            .remove_recording("recording_delete")
            .expect("remove recording speaker metadata");
        assert!(!root.join(STORE_BACKUP_FILE).exists());
        assert_eq!(
            service
                .list_speaker_names(DiarizationRecordingParams {
                    recording_id: "recording_delete".to_string(),
                })
                .expect("deleted recording names")["assignmentCount"],
            0
        );
        assert_eq!(
            service
                .list_speaker_names(DiarizationRecordingParams {
                    recording_id: "recording_keep".to_string(),
                })
                .expect("retained recording names")["assignments"][0]["displayName"],
            "Retained speaker"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_names_and_ids_fail_without_changing_the_store() {
        let root = root("invalid");
        let service = DiarizationService::with_test_runtime(root.clone(), false, None, None, None);
        let error = service
            .assign_speaker_name(DiarizationAssignSpeakerNameParams {
                recording_id: "../recording".to_string(),
                anonymous_speaker_id: "speaker-1".to_string(),
                display_name: "Avery".to_string(),
            })
            .unwrap_err();
        assert_eq!(error.code, "DIARIZATION_RECORDING_ID_INVALID");
        let error = service
            .assign_speaker_name(DiarizationAssignSpeakerNameParams {
                recording_id: "recording_1".to_string(),
                anonymous_speaker_id: "Avery".to_string(),
                display_name: "Avery".to_string(),
            })
            .unwrap_err();
        assert_eq!(error.code, "DIARIZATION_SPEAKER_ID_INVALID");
        assert!(!root.join(STORE_FILE).exists());
        let _ = fs::remove_dir_all(root);
    }
}
