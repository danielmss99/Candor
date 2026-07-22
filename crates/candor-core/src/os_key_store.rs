use std::path::Path;

use sha2::{Digest, Sha256};

pub struct OsKey {
    bytes: Vec<u8>,
    created: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct OsKeyStoreStatus {
    pub label: &'static str,
    pub backend: &'static str,
    pub available: bool,
    pub passphrase_required: bool,
}

impl OsKey {
    #[cfg(feature = "sqlcipher-vault")]
    pub fn created(&self) -> bool {
        self.created
    }

    #[cfg(feature = "sqlcipher-vault")]
    pub(crate) fn sqlcipher_passphrase(&self) -> String {
        hex_lower(&self.bytes)
    }

    pub(crate) fn same_material(&self, other: &Self) -> bool {
        self.bytes == other.bytes
    }

    pub(crate) fn derive_key(&self, label: &[u8]) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"candor-v3-key-derivation");
        hasher.update((label.len() as u64).to_le_bytes());
        hasher.update(label);
        hasher.update(&self.bytes);
        hasher.finalize().into()
    }
}

#[derive(Debug)]
pub struct OsKeyStoreError {
    pub code: &'static str,
    pub message: String,
}

impl OsKeyStoreError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[cfg(any(feature = "sqlcipher-vault", not(windows)))]
fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(windows)]
mod platform {
    use super::{OsKey, OsKeyStoreError, OsKeyStoreStatus};
    use serde_json::{json, Value};
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};
    use std::slice;
    use std::sync::{Mutex, MutexGuard};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        BCryptGenRandom, CryptProtectData, CryptUnprotectData, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    const KEY_BYTES: usize = 32;
    const KEY_FILE: &str = "vault-key.dpapi";
    // Capture and the encrypted-search backfill can initialize the same root
    // concurrently. Keep the first DPAPI key creation and all reads atomic
    // within the single core process so no caller retains a losing key.
    static KEY_STORE_LOCK: Mutex<()> = Mutex::new(());

    pub fn status(_root: &Path) -> OsKeyStoreStatus {
        OsKeyStoreStatus {
            label: "dpapi-proof-available",
            backend: "dpapi",
            available: true,
            passphrase_required: false,
        }
    }

    pub fn proof(root: &Path) -> Result<Value, OsKeyStoreError> {
        let first = get_or_create_key(root)?;
        let second = get_or_create_key(root)?;
        let stable_after_reopen = first.same_material(&second);
        let round_trip = unprotect(&protect(&first.bytes)?)? == first.bytes;
        let created = first.created;

        Ok(json!({
            "backend": "dpapi",
            "available": true,
            "state": "stored",
            "created": created,
            "persisted": true,
            "roundTrip": round_trip,
            "stableAfterReopen": stable_after_reopen,
            "keyBytes": KEY_BYTES,
            "keyMaterialExposedToRenderer": false,
            "rawPathExposed": false,
            "passphraseRequired": false
        }))
    }

    fn key_path(root: &Path) -> PathBuf {
        root.join("keys").join(KEY_FILE)
    }

    pub fn get_or_create_key(root: &Path) -> Result<OsKey, OsKeyStoreError> {
        let _guard = key_store_guard();
        let path = key_path(root);
        if path.exists() {
            return get_existing_key_unlocked(root);
        }

        let parent = path.parent().ok_or_else(|| {
            OsKeyStoreError::new("OS_KEY_PATH_FAILED", "key path did not have a parent")
        })?;
        fs::create_dir_all(parent)
            .map_err(|err| OsKeyStoreError::new("OS_KEY_DIR_CREATE_FAILED", err.to_string()))?;

        let bytes = generate_key()?;
        let protected = protect(&bytes)?;
        fs::write(&path, protected)
            .map_err(|err| OsKeyStoreError::new("OS_KEY_WRITE_FAILED", err.to_string()))?;

        Ok(OsKey {
            bytes,
            created: true,
        })
    }

    pub fn get_existing_key(root: &Path) -> Result<OsKey, OsKeyStoreError> {
        let _guard = key_store_guard();
        get_existing_key_unlocked(root)
    }

    fn get_existing_key_unlocked(root: &Path) -> Result<OsKey, OsKeyStoreError> {
        let path = key_path(root);
        if !path.is_file() {
            return Err(OsKeyStoreError::new(
                "OS_KEY_NOT_FOUND",
                "the existing local encryption key was not found",
            ));
        }
        let protected = fs::read(&path)
            .map_err(|err| OsKeyStoreError::new("OS_KEY_READ_FAILED", err.to_string()))?;
        let bytes = unprotect(&protected)?;
        if bytes.len() != KEY_BYTES {
            return Err(OsKeyStoreError::new(
                "OS_KEY_INVALID_LENGTH",
                "stored DPAPI key had an unexpected length",
            ));
        }
        Ok(OsKey {
            bytes,
            created: false,
        })
    }

    fn key_store_guard() -> MutexGuard<'static, ()> {
        KEY_STORE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn generate_key() -> Result<Vec<u8>, OsKeyStoreError> {
        let mut key = vec![0_u8; KEY_BYTES];
        let status = unsafe {
            BCryptGenRandom(
                0 as _,
                key.as_mut_ptr(),
                key.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status < 0 {
            return Err(OsKeyStoreError::new(
                "OS_KEY_RANDOM_FAILED",
                format!("BCryptGenRandom failed with status {status}"),
            ));
        }
        Ok(key)
    }

    fn protect(bytes: &[u8]) -> Result<Vec<u8>, OsKeyStoreError> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };

        let ok = unsafe {
            CryptProtectData(
                &input,
                null(),
                null(),
                null_mut(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(OsKeyStoreError::new(
                "OS_KEY_PROTECT_FAILED",
                io::Error::last_os_error().to_string(),
            ));
        }
        copy_and_free_blob(output, "OS_KEY_PROTECT_EMPTY")
    }

    fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, OsKeyStoreError> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };

        let ok = unsafe {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null_mut(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(OsKeyStoreError::new(
                "OS_KEY_UNPROTECT_FAILED",
                io::Error::last_os_error().to_string(),
            ));
        }
        copy_and_free_blob(output, "OS_KEY_UNPROTECT_EMPTY")
    }

    fn copy_and_free_blob(
        blob: CRYPT_INTEGER_BLOB,
        empty_code: &'static str,
    ) -> Result<Vec<u8>, OsKeyStoreError> {
        if blob.pbData.is_null() || blob.cbData == 0 {
            return Err(OsKeyStoreError::new(
                empty_code,
                "DPAPI returned an empty blob",
            ));
        }

        let bytes = unsafe { slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() };
        unsafe {
            let _ = LocalFree(blob.pbData as _);
        }
        Ok(bytes)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{hex_lower, OsKey, OsKeyStoreError, OsKeyStoreStatus};
    use getrandom::getrandom;
    use keyring::{Entry, Error as KeyringError};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::path::Path;

    const KEY_BYTES: usize = 32;
    const SERVICE: &str = "com.candor.v3.local-vault";

    pub fn status(root: &Path) -> OsKeyStoreStatus {
        match entry(root) {
            Ok(_) => OsKeyStoreStatus {
                label: available_label(),
                backend: backend(),
                available: true,
                passphrase_required: false,
            },
            Err(_) => OsKeyStoreStatus {
                label: unavailable_label(),
                backend: backend(),
                available: false,
                passphrase_required: true,
            },
        }
    }

    pub fn proof(root: &Path) -> Result<Value, OsKeyStoreError> {
        if let Err(error) = entry(root) {
            let mapped = map_keyring_error("OS_KEY_STORAGE_UNAVAILABLE", error);
            return Ok(json!({
                "backend": backend(),
                "available": false,
                "state": "unavailable",
                "errorCode": mapped.code,
                "errorMessage": mapped.message,
                "keyMaterialExposedToRenderer": false,
                "rawPathExposed": false,
                "passphraseRequired": true
            }));
        }

        let first = get_or_create_key(root)?;
        let second = get_or_create_key(root)?;
        let stable_after_reopen = first.same_material(&second);
        let created = first.created;

        Ok(json!({
            "backend": backend(),
            "available": true,
            "state": "stored",
            "created": created,
            "persisted": true,
            "stableAfterReopen": stable_after_reopen,
            "keyBytes": KEY_BYTES,
            "keyMaterialExposedToRenderer": false,
            "rawPathExposed": false,
            "passphraseRequired": false
        }))
    }

    pub fn get_or_create_key(root: &Path) -> Result<OsKey, OsKeyStoreError> {
        let entry =
            entry(root).map_err(|err| map_keyring_error("OS_KEY_STORAGE_UNAVAILABLE", err))?;
        match entry.get_secret() {
            Ok(bytes) => {
                if bytes.len() != KEY_BYTES {
                    return Err(OsKeyStoreError::new(
                        "OS_KEY_INVALID_LENGTH",
                        "stored native key had an unexpected length",
                    ));
                }
                Ok(OsKey {
                    bytes,
                    created: false,
                })
            }
            Err(KeyringError::NoEntry) => {
                let bytes = generate_key()?;
                entry
                    .set_secret(&bytes)
                    .map_err(|err| map_keyring_error("OS_KEY_WRITE_FAILED", err))?;
                Ok(OsKey {
                    bytes,
                    created: true,
                })
            }
            Err(error) => Err(map_keyring_error("OS_KEY_READ_FAILED", error)),
        }
    }

    pub fn get_existing_key(root: &Path) -> Result<OsKey, OsKeyStoreError> {
        let entry =
            entry(root).map_err(|err| map_keyring_error("OS_KEY_STORAGE_UNAVAILABLE", err))?;
        match entry.get_secret() {
            Ok(bytes) => {
                if bytes.len() != KEY_BYTES {
                    return Err(OsKeyStoreError::new(
                        "OS_KEY_INVALID_LENGTH",
                        "stored native key had an unexpected length",
                    ));
                }
                Ok(OsKey {
                    bytes,
                    created: false,
                })
            }
            Err(KeyringError::NoEntry) => Err(OsKeyStoreError::new(
                "OS_KEY_NOT_FOUND",
                "the existing local encryption key was not found",
            )),
            Err(error) => Err(map_keyring_error("OS_KEY_READ_FAILED", error)),
        }
    }

    fn entry(root: &Path) -> Result<Entry, KeyringError> {
        Entry::new(SERVICE, &credential_name(root))
    }

    fn credential_name(root: &Path) -> String {
        let digest = Sha256::digest(root.to_string_lossy().as_bytes());
        format!("vault-key-{}", hex_lower(&digest[..16]))
    }

    fn generate_key() -> Result<Vec<u8>, OsKeyStoreError> {
        let mut key = vec![0_u8; KEY_BYTES];
        getrandom(&mut key)
            .map_err(|err| OsKeyStoreError::new("OS_KEY_RANDOM_FAILED", err.to_string()))?;
        Ok(key)
    }

    fn map_keyring_error(default_code: &'static str, error: KeyringError) -> OsKeyStoreError {
        let code = match error {
            KeyringError::NoDefaultStore | KeyringError::NoStorageAccess(_) => {
                "OS_KEY_STORAGE_UNAVAILABLE"
            }
            KeyringError::Ambiguous(_) => "OS_KEY_AMBIGUOUS_ENTRY",
            KeyringError::BadDataFormat(_, _) | KeyringError::BadEncoding(_) => {
                "OS_KEY_CORRUPT_ENTRY"
            }
            KeyringError::NoEntry => "OS_KEY_NOT_FOUND",
            _ => default_code,
        };
        OsKeyStoreError::new(code, error.to_string())
    }

    #[cfg(target_os = "macos")]
    fn backend() -> &'static str {
        "keychain"
    }

    #[cfg(not(target_os = "macos"))]
    fn backend() -> &'static str {
        "secret-service"
    }

    #[cfg(target_os = "macos")]
    fn available_label() -> &'static str {
        "keychain-proof-available"
    }

    #[cfg(not(target_os = "macos"))]
    fn available_label() -> &'static str {
        "secret-service-proof-available"
    }

    #[cfg(target_os = "macos")]
    fn unavailable_label() -> &'static str {
        "keychain-unavailable"
    }

    #[cfg(not(target_os = "macos"))]
    fn unavailable_label() -> &'static str {
        "secret-service-unavailable"
    }
}

pub fn status(root: &Path) -> OsKeyStoreStatus {
    platform::status(root)
}

pub fn proof(root: &Path) -> Result<serde_json::Value, OsKeyStoreError> {
    platform::proof(root)
}

pub fn get_or_create_key(root: &Path) -> Result<OsKey, OsKeyStoreError> {
    platform::get_or_create_key(root)
}

pub fn get_existing_key(root: &Path) -> Result<OsKey, OsKeyStoreError> {
    platform::get_existing_key(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    #[cfg(windows)]
    use std::sync::{Arc, Barrier};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        env::temp_dir().join(format!("candor-os-key-test-{stamp}"))
    }

    #[test]
    fn proof_never_exposes_key_material_or_paths() {
        let root = temp_root();
        let proof = proof(&root).expect("os key proof");

        assert_eq!(proof["keyMaterialExposedToRenderer"], false);
        assert_eq!(proof["rawPathExposed"], false);
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_key_persists_and_reopens() {
        let root = temp_root();
        let proof = proof(&root).expect("dpapi proof");

        assert_eq!(proof["backend"], "dpapi");
        assert_eq!(proof["available"], true);
        assert_eq!(proof["persisted"], true);
        assert_eq!(proof["roundTrip"], true);
        assert_eq!(proof["stableAfterReopen"], true);
        assert_eq!(proof["keyBytes"], 32);
    }

    #[cfg(windows)]
    #[test]
    fn concurrent_dpapi_initialization_returns_one_key_identity() {
        const CALLERS: usize = 8;
        let root = temp_root();
        let barrier = Arc::new(Barrier::new(CALLERS));
        let handles = (0..CALLERS)
            .map(|_| {
                let root = root.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    get_or_create_key(&root).expect("initialize shared DPAPI key")
                })
            })
            .collect::<Vec<_>>();
        let keys = handles
            .into_iter()
            .map(|handle| handle.join().expect("join DPAPI initializer"))
            .collect::<Vec<_>>();
        let first = keys.first().expect("at least one initialized key");

        assert!(keys.iter().all(|key| key.same_material(first)));
    }

    #[cfg(windows)]
    #[test]
    fn existing_key_lookup_never_creates_storage() {
        let root = temp_root();
        let error = match get_existing_key(&root) {
            Err(error) => error,
            Ok(_) => panic!("missing key must fail closed"),
        };

        assert_eq!(error.code, "OS_KEY_NOT_FOUND");
        assert!(!root.exists());
    }
}
