use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};
use getrandom::getrandom;
use sha2::{Digest, Sha256};

use crate::os_key_store;

const STAGING_MAGIC: &[u8] = b"candor-dictionary-stage-v1\0";
const STAGING_AAD: &[u8] = b"candor-dictionary-staging-v1";
const STAGING_KEY_LABEL: &[u8] = b"candor-dictionary-staging-v1";
const NONCE_BYTES: usize = 12;
const MAX_ARCHIVE_BYTES: usize = 2_500_000;
const MAX_BASE64_CHARACTERS: usize = MAX_ARCHIVE_BYTES * 4 / 3 + 16;
const ORPHAN_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Debug)]
pub struct DictionaryStaging {
    root: PathBuf,
    key_root: PathBuf,
    #[cfg(test)]
    test_key: Option<[u8; 32]>,
}

#[derive(Clone, Debug)]
pub struct StagedDictionary {
    pub staging_token: String,
    pub expected_sha256: String,
    pub original_display_name: String,
    pub bytes: u64,
}

#[derive(Clone, Debug)]
pub struct DictionaryStagingError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl DictionaryStagingError {
    fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
}

impl DictionaryStaging {
    pub fn with_roots(root: PathBuf, key_root: PathBuf) -> Self {
        Self {
            root,
            key_root,
            #[cfg(test)]
            test_key: None,
        }
    }

    #[cfg(test)]
    pub fn with_test_roots(root: PathBuf, key_root: PathBuf) -> Self {
        Self {
            root,
            key_root,
            test_key: Some([0x4d; 32]),
        }
    }

    pub fn stage_base64(
        &self,
        display_name: &str,
        archive_base64: &str,
    ) -> Result<StagedDictionary, DictionaryStagingError> {
        validate_display_name(display_name)?;
        if archive_base64.len() > MAX_BASE64_CHARACTERS {
            return Err(DictionaryStagingError::new(
                "DICTIONARY_ARCHIVE_TOO_LARGE",
                "the dictionary package exceeds the compressed size limit",
                false,
            ));
        }
        let bytes = STANDARD.decode(archive_base64).map_err(|_| {
            DictionaryStagingError::new(
                "DICTIONARY_ARCHIVE_INVALID",
                "the dictionary package is not valid encoded data",
                false,
            )
        })?;
        self.stage_bytes(display_name, &bytes)
    }

    pub fn stage_bytes(
        &self,
        display_name: &str,
        bytes: &[u8],
    ) -> Result<StagedDictionary, DictionaryStagingError> {
        validate_display_name(display_name)?;
        if bytes.is_empty() || bytes.len() > MAX_ARCHIVE_BYTES {
            return Err(DictionaryStagingError::new(
                "DICTIONARY_ARCHIVE_TOO_LARGE",
                "the dictionary package exceeds the compressed size limit",
                false,
            ));
        }
        fs::create_dir_all(&self.root).map_err(|_| {
            DictionaryStagingError::new(
                "DICTIONARY_STAGING_WRITE_FAILED",
                "secure dictionary staging could not be created",
                true,
            )
        })?;
        let token = random_token()?;
        let key = self.encryption_key()?;
        let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| {
            DictionaryStagingError::new(
                "DICTIONARY_STAGING_KEY_FAILED",
                "secure dictionary staging could not start",
                true,
            )
        })?;
        let mut nonce = [0_u8; NONCE_BYTES];
        getrandom(&mut nonce).map_err(|_| {
            DictionaryStagingError::new(
                "DICTIONARY_STAGING_WRITE_FAILED",
                "secure dictionary staging could not create a nonce",
                true,
            )
        })?;
        let aad = staging_aad(&token);
        let encrypted = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: bytes,
                    aad: &aad,
                },
            )
            .map_err(|_| {
                DictionaryStagingError::new(
                    "DICTIONARY_STAGING_WRITE_FAILED",
                    "the dictionary package could not be encrypted",
                    true,
                )
            })?;
        let temporary = self.root.join(format!(".{token}.tmp"));
        let target = self.path_for_token(&token)?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| {
                DictionaryStagingError::new(
                    "DICTIONARY_STAGING_WRITE_FAILED",
                    "the encrypted dictionary package could not be staged",
                    true,
                )
            })?;
        let write_result = file
            .write_all(STAGING_MAGIC)
            .and_then(|_| file.write_all(&nonce))
            .and_then(|_| file.write_all(&encrypted))
            .and_then(|_| file.sync_all());
        drop(file);
        if write_result.is_err() || fs::rename(&temporary, &target).is_err() {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(&target);
            return Err(DictionaryStagingError::new(
                "DICTIONARY_STAGING_WRITE_FAILED",
                "the encrypted dictionary package could not be committed",
                true,
            ));
        }
        Ok(StagedDictionary {
            staging_token: token,
            expected_sha256: hex_sha256(bytes),
            original_display_name: display_name.to_string(),
            bytes: bytes.len() as u64,
        })
    }

    pub fn read_verified(
        &self,
        token: &str,
        expected_sha256: &str,
        expected_bytes: u64,
        display_name: &str,
    ) -> Result<Vec<u8>, DictionaryStagingError> {
        self.validate_descriptor(token, expected_sha256, expected_bytes, display_name)?;
        let path = self.path_for_token(token)?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| {
            DictionaryStagingError::new(
                "DICTIONARY_STAGING_MISSING",
                "the staged dictionary package is no longer available",
                false,
            )
        })?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(DictionaryStagingError::new(
                "DICTIONARY_STAGING_TAMPERED",
                "the staged dictionary package failed its file safety check",
                false,
            ));
        }
        let canonical_root = self.root.canonicalize().map_err(|_| {
            DictionaryStagingError::new(
                "DICTIONARY_STAGING_UNAVAILABLE",
                "secure dictionary staging is unavailable",
                true,
            )
        })?;
        let canonical_path = path.canonicalize().map_err(|_| {
            DictionaryStagingError::new(
                "DICTIONARY_STAGING_TAMPERED",
                "the staged dictionary package failed its containment check",
                false,
            )
        })?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err(DictionaryStagingError::new(
                "DICTIONARY_STAGING_TAMPERED",
                "the staged dictionary package escaped secure local staging",
                false,
            ));
        }
        let encrypted = fs::read(&canonical_path).map_err(|_| {
            DictionaryStagingError::new(
                "DICTIONARY_STAGING_READ_FAILED",
                "the staged dictionary package could not be read",
                true,
            )
        })?;
        if encrypted.len() <= STAGING_MAGIC.len() + NONCE_BYTES
            || encrypted.len() > STAGING_MAGIC.len() + NONCE_BYTES + MAX_ARCHIVE_BYTES + 32
            || !encrypted.starts_with(STAGING_MAGIC)
        {
            return Err(DictionaryStagingError::new(
                "DICTIONARY_STAGING_TAMPERED",
                "the staged dictionary package failed its encrypted format check",
                false,
            ));
        }
        let nonce_start = STAGING_MAGIC.len();
        let payload_start = nonce_start + NONCE_BYTES;
        let cipher = ChaCha20Poly1305::new_from_slice(&self.encryption_key()?).map_err(|_| {
            DictionaryStagingError::new(
                "DICTIONARY_STAGING_KEY_FAILED",
                "secure dictionary staging could not start",
                true,
            )
        })?;
        let aad = staging_aad(token);
        let bytes = cipher
            .decrypt(
                Nonce::from_slice(&encrypted[nonce_start..payload_start]),
                Payload {
                    msg: &encrypted[payload_start..],
                    aad: &aad,
                },
            )
            .map_err(|_| {
                DictionaryStagingError::new(
                    "DICTIONARY_STAGING_TAMPERED",
                    "the staged dictionary package failed authentication",
                    false,
                )
            })?;
        if bytes.len() as u64 != expected_bytes
            || !hex_sha256(&bytes).eq_ignore_ascii_case(expected_sha256)
        {
            return Err(DictionaryStagingError::new(
                "DICTIONARY_STAGING_TAMPERED",
                "the staged dictionary package failed its integrity check",
                false,
            ));
        }
        Ok(bytes)
    }

    pub fn validate_descriptor(
        &self,
        token: &str,
        expected_sha256: &str,
        expected_bytes: u64,
        display_name: &str,
    ) -> Result<(), DictionaryStagingError> {
        validate_display_name(display_name)?;
        if !valid_token(token)
            || !is_sha256(expected_sha256)
            || expected_bytes == 0
            || expected_bytes > MAX_ARCHIVE_BYTES as u64
        {
            return Err(DictionaryStagingError::new(
                "DICTIONARY_STAGING_DESCRIPTOR_INVALID",
                "the saved dictionary staging descriptor is invalid",
                false,
            ));
        }
        Ok(())
    }

    pub fn delete(&self, token: &str) -> Result<(), DictionaryStagingError> {
        let path = self.path_for_token(token)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(DictionaryStagingError::new(
                "DICTIONARY_STAGING_DELETE_FAILED",
                "the staged dictionary package could not be removed",
                true,
            )),
        }
    }

    pub fn cleanup_orphans(
        &self,
        referenced_tokens: &HashSet<String>,
    ) -> Result<u64, DictionaryStagingError> {
        self.cleanup_orphans_older_than(referenced_tokens, ORPHAN_RETENTION)
    }

    fn cleanup_orphans_older_than(
        &self,
        referenced_tokens: &HashSet<String>,
        retention: Duration,
    ) -> Result<u64, DictionaryStagingError> {
        if !self.root.exists() {
            return Ok(0);
        }
        let now = SystemTime::now();
        let mut removed = 0_u64;
        for entry in fs::read_dir(&self.root).map_err(|_| {
            DictionaryStagingError::new(
                "DICTIONARY_STAGING_READ_FAILED",
                "secure dictionary staging could not be inspected",
                true,
            )
        })? {
            let Ok(entry) = entry else { continue };
            let name = entry.file_name().to_string_lossy().to_string();
            let (token, temporary) = if let Some(token) = name.strip_suffix(".stage") {
                (token, false)
            } else if let Some(token) = name
                .strip_prefix('.')
                .and_then(|value| value.strip_suffix(".tmp"))
            {
                (token, true)
            } else {
                continue;
            };
            if !valid_token(token) || (!temporary && referenced_tokens.contains(token)) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() || file_type.is_symlink() {
                continue;
            }
            let old_enough = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age >= retention);
            let deleted = if !old_enough {
                false
            } else if temporary {
                fs::remove_file(entry.path()).is_ok()
            } else {
                self.delete(token).is_ok()
            };
            if deleted {
                removed = removed.saturating_add(1);
            }
        }
        Ok(removed)
    }

    fn path_for_token(&self, token: &str) -> Result<PathBuf, DictionaryStagingError> {
        if !valid_token(token) {
            return Err(DictionaryStagingError::new(
                "DICTIONARY_STAGING_TOKEN_INVALID",
                "the dictionary staging token is invalid",
                false,
            ));
        }
        Ok(self.root.join(format!("{token}.stage")))
    }

    fn encryption_key(&self) -> Result<[u8; 32], DictionaryStagingError> {
        #[cfg(test)]
        if let Some(key) = self.test_key {
            return Ok(key);
        }
        os_key_store::get_or_create_key(&self.key_root)
            .map(|key| key.derive_key(STAGING_KEY_LABEL))
            .map_err(|_| {
                DictionaryStagingError::new(
                    "DICTIONARY_STAGING_KEY_FAILED",
                    "the operating-system key store is unavailable",
                    true,
                )
            })
    }
}

fn valid_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_display_name(value: &str) -> Result<(), DictionaryStagingError> {
    if value.is_empty()
        || value.len() > 180
        || value.trim() != value
        || value.chars().any(char::is_control)
        || value.contains('/')
        || value.contains('\\')
        || !value.to_ascii_lowercase().ends_with(".candordict")
    {
        return Err(DictionaryStagingError::new(
            "DICTIONARY_FILE_NAME_INVALID",
            "the dictionary package name is invalid",
            false,
        ));
    }
    Ok(())
}

fn random_token() -> Result<String, DictionaryStagingError> {
    let mut bytes = [0_u8; 32];
    getrandom(&mut bytes).map_err(|_| {
        DictionaryStagingError::new(
            "DICTIONARY_STAGING_TOKEN_FAILED",
            "secure dictionary staging could not create a token",
            true,
        )
    })?;
    Ok(hex_bytes(&bytes))
}

fn staging_aad(token: &str) -> Vec<u8> {
    let mut value = Vec::with_capacity(STAGING_AAD.len() + token.len());
    value.extend_from_slice(STAGING_AAD);
    value.extend_from_slice(token.as_bytes());
    value
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hex_sha256(bytes: &[u8]) -> String {
    hex_bytes(&Sha256::digest(bytes))
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "candor-dictionary-staging-{label}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn encrypted_stage_round_trips_and_rejects_tampering() {
        let root = test_root("round-trip");
        let _ = fs::remove_dir_all(&root);
        let staging = DictionaryStaging::with_test_roots(root.join("stage"), root.join("keys"));
        let staged = staging
            .stage_bytes("pharma.candordict", b"dictionary bytes")
            .expect("stage");
        let restored = staging
            .read_verified(
                &staged.staging_token,
                &staged.expected_sha256,
                staged.bytes,
                &staged.original_display_name,
            )
            .expect("restore");
        assert_eq!(restored, b"dictionary bytes");
        let path = staging.path_for_token(&staged.staging_token).expect("path");
        let mut encrypted = fs::read(&path).expect("read encrypted");
        *encrypted.last_mut().expect("ciphertext") ^= 1;
        fs::write(&path, encrypted).expect("tamper");
        let error = staging
            .read_verified(
                &staged.staging_token,
                &staged.expected_sha256,
                staged.bytes,
                &staged.original_display_name,
            )
            .expect_err("tampering rejected");
        assert_eq!(error.code, "DICTIONARY_STAGING_TAMPERED");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn staging_rejects_unsafe_display_names() {
        let root = test_root("unsafe-name");
        let _ = fs::remove_dir_all(&root);
        let staging = DictionaryStaging::with_test_roots(root.join("stage"), root.join("keys"));

        for name in [
            " terms.candordict",
            "terms.candordict ",
            "terms.candordict\n",
            "folder/terms.candordict",
        ] {
            let error = staging
                .stage_bytes(name, b"dictionary bytes")
                .expect_err("unsafe display name rejected");
            assert_eq!(error.code, "DICTIONARY_FILE_NAME_INVALID");
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_reports_a_retryable_failure_instead_of_claiming_cleanup() {
        let root = test_root("delete-failure");
        let _ = fs::remove_dir_all(&root);
        let staging = DictionaryStaging::with_test_roots(root.join("stage"), root.join("keys"));
        let staged = staging
            .stage_bytes("cleanup.candordict", b"dictionary bytes")
            .expect("stage");
        let path = staging.path_for_token(&staged.staging_token).expect("path");
        fs::remove_file(&path).expect("remove encrypted fixture");
        fs::create_dir(&path).expect("replace fixture with directory");

        let error = staging
            .delete(&staged.staging_token)
            .expect_err("directory cannot be reported as deleted");

        assert_eq!(error.code, "DICTIONARY_STAGING_DELETE_FAILED");
        assert!(error.retryable);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn orphan_cleanup_removes_committed_and_temporary_files_without_touching_references() {
        let root = test_root("orphan-cleanup");
        let _ = fs::remove_dir_all(&root);
        let staging = DictionaryStaging::with_test_roots(root.join("stage"), root.join("keys"));
        let referenced = staging
            .stage_bytes("referenced.candordict", b"referenced dictionary")
            .expect("referenced stage");
        let orphan = staging
            .stage_bytes("orphan.candordict", b"orphan dictionary")
            .expect("orphan stage");
        let temporary_token = "a".repeat(64);
        let temporary = staging.root.join(format!(".{temporary_token}.tmp"));
        fs::write(&temporary, b"interrupted encrypted staging write").expect("temporary stage");
        let referenced_tokens = HashSet::from([referenced.staging_token.clone()]);

        let removed = staging
            .cleanup_orphans_older_than(&referenced_tokens, Duration::ZERO)
            .expect("cleanup");

        assert_eq!(removed, 2);
        assert!(staging
            .path_for_token(&referenced.staging_token)
            .expect("referenced path")
            .exists());
        assert!(!staging
            .path_for_token(&orphan.staging_token)
            .expect("orphan path")
            .exists());
        assert!(!temporary.exists());
        let _ = fs::remove_dir_all(root);
    }
}
