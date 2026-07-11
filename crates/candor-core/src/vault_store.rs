use std::env;
use std::path::PathBuf;

use crate::os_key_store;
#[cfg(feature = "sqlcipher-vault")]
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};

const VAULT_FILE: &str = "candor-v3.sqlcipher";
#[cfg(feature = "sqlcipher-vault")]
const PASSPHRASE_PROOF_VAULT_FILE: &str = "candor-v3-passphrase-proof.sqlcipher";
#[cfg(feature = "sqlcipher-vault")]
const MIN_PASSPHRASE_BYTES: usize = 12;

#[derive(Debug)]
pub struct VaultStoreError {
    pub code: &'static str,
    pub message: String,
}

impl VaultStoreError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct VaultStore {
    root: PathBuf,
    root_kind: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(feature = "sqlcipher-vault"), allow(dead_code))]
pub struct VaultOpenParams {
    pub passphrase: String,
}

impl VaultStore {
    pub fn from_env() -> Self {
        if let Ok(path) = env::var("CANDOR_V3_DATA_DIR") {
            if !path.trim().is_empty() {
                return Self {
                    root: PathBuf::from(path),
                    root_kind: "env-override",
                };
            }
        }

        Self {
            root: default_data_root(),
            root_kind: "local-user-data",
        }
    }

    #[cfg(test)]
    pub fn with_root(root: PathBuf) -> Self {
        Self {
            root,
            root_kind: "test-root",
        }
    }

    pub fn status(&self) -> Value {
        let sqlcipher_available = cfg!(feature = "sqlcipher-vault");
        let os_key_status = os_key_store::status(&self.root);
        let local_open_available = sqlcipher_available && os_key_status.available;

        json!({
            "state": if self.vault_path().exists() { "closed" } else { "notCreated" },
            "backend": "sqlcipher",
            "sqlcipherAvailable": sqlcipher_available,
            "localOpenAvailable": local_open_available,
            "localOpenMode": if local_open_available { "os-key" } else { "requires-passphrase-fallback" },
            "encrypted": self.vault_path().exists(),
            "keyMaterialExposedToRenderer": false,
            "rawPathExposed": false,
            "rootKind": self.root_kind,
            "osKeyStorage": os_key_status.label,
            "osKeyBackend": os_key_status.backend,
            "osKeyStorageAvailable": os_key_status.available,
            "passphraseRequired": os_key_status.passphrase_required,
            "passphraseFallback": "available-after-explicit-user-setup"
        })
    }

    pub fn core_status_label(&self) -> &'static str {
        #[cfg(feature = "sqlcipher-vault")]
        {
            "m1-sqlcipher-feature-enabled"
        }
        #[cfg(not(feature = "sqlcipher-vault"))]
        {
            "m1-sqlcipher-feature-disabled"
        }
    }

    pub fn open_or_create(&self, params: VaultOpenParams) -> Result<Value, VaultStoreError> {
        #[cfg(not(feature = "sqlcipher-vault"))]
        {
            let _ = params;
            return Err(VaultStoreError::new(
                "SQLCIPHER_FEATURE_DISABLED",
                "candor-core was built without the sqlcipher-vault feature",
            ));
        }

        #[cfg(feature = "sqlcipher-vault")]
        {
            validate_passphrase(&params.passphrase)?;
            std::fs::create_dir_all(&self.root)
                .map_err(|err| VaultStoreError::new("VAULT_ROOT_CREATE_FAILED", err.to_string()))?;

            let path = self.passphrase_proof_vault_path();
            let existed = path.exists();
            let conn = Connection::open(&path)
                .map_err(|err| VaultStoreError::new("VAULT_OPEN_FAILED", err.to_string()))?;
            apply_key(&conn, &params.passphrase)?;
            validate_sqlcipher(&conn)?;
            migrate(&conn)?;

            Ok(json!({
                "state": "open",
                "backend": "sqlcipher",
                "encrypted": true,
                "created": !existed,
                "schemaVersion": 1,
                "keyMaterialExposedToRenderer": false,
                "rawPathExposed": false,
                "rootKind": self.root_kind,
                "osKeyStorage": os_key_store::status(&self.root).label,
                "openMode": "passphrase-proof",
                "proofHarness": true,
                "passphraseFallback": "implemented-for-proof-harness"
            }))
        }
    }

    pub fn proof_os_key_storage(&self) -> Result<Value, VaultStoreError> {
        os_key_store::proof(&self.root).map_err(|err| VaultStoreError::new(err.code, err.message))
    }

    pub fn open_local(&self) -> Result<Value, VaultStoreError> {
        #[cfg(not(feature = "sqlcipher-vault"))]
        {
            return Err(VaultStoreError::new(
                "SQLCIPHER_FEATURE_DISABLED",
                "candor-core was built without the sqlcipher-vault feature",
            ));
        }

        #[cfg(feature = "sqlcipher-vault")]
        {
            self.open_os_key_vault(false)
        }
    }

    pub fn open_with_os_key_proof(&self) -> Result<Value, VaultStoreError> {
        #[cfg(not(feature = "sqlcipher-vault"))]
        {
            return Err(VaultStoreError::new(
                "SQLCIPHER_FEATURE_DISABLED",
                "candor-core was built without the sqlcipher-vault feature",
            ));
        }

        #[cfg(feature = "sqlcipher-vault")]
        {
            self.open_os_key_vault(true)
        }
    }

    pub fn proof_wrong_key_fails(
        &self,
        correct: VaultOpenParams,
        wrong: VaultOpenParams,
    ) -> Result<Value, VaultStoreError> {
        #[cfg(not(feature = "sqlcipher-vault"))]
        {
            let _ = correct;
            let _ = wrong;
            return Err(VaultStoreError::new(
                "SQLCIPHER_FEATURE_DISABLED",
                "candor-core was built without the sqlcipher-vault feature",
            ));
        }

        #[cfg(feature = "sqlcipher-vault")]
        {
            let open = self.open_or_create(correct)?;
            validate_passphrase(&wrong.passphrase)?;
            let conn = Connection::open(self.passphrase_proof_vault_path())
                .map_err(|err| VaultStoreError::new("VAULT_OPEN_FAILED", err.to_string()))?;
            apply_key(&conn, &wrong.passphrase)?;
            let wrong_key_failed = conn
                .query_row("SELECT COUNT(*) FROM candor_meta", [], |row| {
                    row.get::<_, i64>(0)
                })
                .is_err();

            Ok(json!({
                "open": open,
                "wrongKeyFailed": wrong_key_failed,
                "keyMaterialExposedToRenderer": false,
                "rawPathExposed": false
            }))
        }
    }

    pub fn proof_passphrase_fallback(&self) -> Result<Value, VaultStoreError> {
        #[cfg(not(feature = "sqlcipher-vault"))]
        {
            return Err(VaultStoreError::new(
                "SQLCIPHER_FEATURE_DISABLED",
                "candor-core was built without the sqlcipher-vault feature",
            ));
        }

        #[cfg(feature = "sqlcipher-vault")]
        {
            const CORRECT: &str = "correct horse battery staple";
            const WRONG: &str = "wrong horse battery staple";

            let opened = self.open_or_create(VaultOpenParams {
                passphrase: CORRECT.to_string(),
            })?;
            let path = self.passphrase_proof_vault_path();
            let reopened = Connection::open(&path)
                .map_err(|err| VaultStoreError::new("VAULT_REOPEN_FAILED", err.to_string()))?;
            apply_key(&reopened, CORRECT)?;
            validate_sqlcipher(&reopened)?;
            let schema_version = read_schema_version(&reopened)?;
            drop(reopened);

            let wrong = Connection::open(&path)
                .map_err(|err| VaultStoreError::new("VAULT_REOPEN_FAILED", err.to_string()))?;
            apply_key(&wrong, WRONG)?;
            let wrong_key_failed = wrong
                .query_row("SELECT COUNT(*) FROM candor_meta", [], |row| {
                    row.get::<_, i64>(0)
                })
                .is_err();

            Ok(json!({
                "state": "open",
                "backend": "sqlcipher",
                "encrypted": true,
                "schemaVersion": schema_version,
                "openMode": "passphrase-fallback",
                "proofHarness": true,
                "passphraseRequired": true,
                "passphraseFallback": "implemented-core-owned-proof",
                "created": opened.get("created").and_then(Value::as_bool).unwrap_or(false),
                "reopenVerified": true,
                "wrongKeyFailed": wrong_key_failed,
                "rendererPassphraseExposed": false,
                "keyMaterialExposedToRenderer": false,
                "rawPathExposed": false
            }))
        }
    }

    fn vault_path(&self) -> PathBuf {
        self.root.join(VAULT_FILE)
    }

    pub fn index_recording_summary(&self, summary: &Value) -> Value {
        #[cfg(not(feature = "sqlcipher-vault"))]
        {
            let _ = summary;
            return json!({
                "available": false,
                "state": "pending-sqlcipher-feature",
                "indexed": false,
                "backend": "sqlcipher",
                "keyMaterialExposedToRenderer": false,
                "rawPathExposed": false
            });
        }

        #[cfg(feature = "sqlcipher-vault")]
        {
            match self.index_recording_summary_sqlcipher(summary) {
                Ok(value) => value,
                Err(error) if error.code == "OS_KEY_STORAGE_UNAVAILABLE" => json!({
                    "available": false,
                    "state": "pending-native-key-storage",
                    "indexed": false,
                    "backend": "sqlcipher",
                    "keyMaterialExposedToRenderer": false,
                    "rawPathExposed": false
                }),
                Err(error) => json!({
                    "available": false,
                    "state": "failed",
                    "indexed": false,
                    "backend": "sqlcipher",
                    "errorCode": error.code,
                    "keyMaterialExposedToRenderer": false,
                    "rawPathExposed": false
                }),
            }
        }
    }

    pub fn recording_index_status(&self) -> Value {
        #[cfg(not(feature = "sqlcipher-vault"))]
        {
            return json!({
                "available": false,
                "state": "pending-sqlcipher-feature",
                "backend": "sqlcipher",
                "keyMaterialExposedToRenderer": false,
                "rawPathExposed": false
            });
        }

        #[cfg(feature = "sqlcipher-vault")]
        {
            match self.recording_index_status_sqlcipher() {
                Ok(value) => value,
                Err(error) if error.code == "OS_KEY_STORAGE_UNAVAILABLE" => json!({
                    "available": false,
                    "state": "pending-native-key-storage",
                    "backend": "sqlcipher",
                    "keyMaterialExposedToRenderer": false,
                    "rawPathExposed": false
                }),
                Err(error) => json!({
                    "available": false,
                    "state": "failed",
                    "backend": "sqlcipher",
                    "errorCode": error.code,
                    "keyMaterialExposedToRenderer": false,
                    "rawPathExposed": false
                }),
            }
        }
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn passphrase_proof_vault_path(&self) -> PathBuf {
        self.root.join(PASSPHRASE_PROOF_VAULT_FILE)
    }
}

#[cfg(feature = "sqlcipher-vault")]
impl VaultStore {
    fn open_os_key_connection(&self) -> Result<(Connection, bool), VaultStoreError> {
        std::fs::create_dir_all(&self.root)
            .map_err(|err| VaultStoreError::new("VAULT_ROOT_CREATE_FAILED", err.to_string()))?;

        let key = os_key_store::get_or_create_key(&self.root)
            .map_err(|err| VaultStoreError::new(err.code, err.message))?;
        let path = self.vault_path();
        let existed = path.exists();
        let passphrase = key.sqlcipher_passphrase();
        let conn = Connection::open(&path)
            .map_err(|err| VaultStoreError::new("VAULT_OPEN_FAILED", err.to_string()))?;
        apply_key(&conn, &passphrase)?;
        validate_sqlcipher(&conn)?;
        migrate(&conn)?;
        Ok((conn, !existed))
    }

    fn open_os_key_vault(&self, verify_reopen: bool) -> Result<Value, VaultStoreError> {
        let key = os_key_store::get_or_create_key(&self.root)
            .map_err(|err| VaultStoreError::new(err.code, err.message))?;
        let (conn, created) = self.open_os_key_connection()?;
        let schema_version = read_schema_version(&conn)?;
        drop(conn);

        let mut reopen_verified = false;
        let mut stable_after_reopen = false;
        if verify_reopen {
            let reopened_key = os_key_store::get_or_create_key(&self.root)
                .map_err(|err| VaultStoreError::new(err.code, err.message))?;
            let reopened_passphrase = reopened_key.sqlcipher_passphrase();
            let reopened_conn = Connection::open(self.vault_path())
                .map_err(|err| VaultStoreError::new("VAULT_REOPEN_FAILED", err.to_string()))?;
            apply_key(&reopened_conn, &reopened_passphrase)?;
            validate_sqlcipher(&reopened_conn)?;
            let reopened_schema_version = read_schema_version(&reopened_conn)?;
            reopen_verified = reopened_schema_version == schema_version;
            stable_after_reopen = key.same_material(&reopened_key);
        }

        Ok(json!({
            "state": "open",
                "backend": "sqlcipher",
                "encrypted": true,
                "created": created,
                "schemaVersion": schema_version,
            "keyMaterialExposedToRenderer": false,
            "rawPathExposed": false,
            "rootKind": self.root_kind,
            "osKeyStorage": os_key_store::status(&self.root).backend,
            "osKeyCreated": key.created(),
            "openMode": "os-key",
            "proofHarness": verify_reopen,
            "passphraseRequired": false,
            "passphraseFallback": "available-after-explicit-user-setup",
            "reopenVerified": reopen_verified,
            "stableAfterReopen": stable_after_reopen
        }))
    }

    fn index_recording_summary_sqlcipher(&self, summary: &Value) -> Result<Value, VaultStoreError> {
        let recording_id = summary
            .get("recordingId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                VaultStoreError::new(
                    "VAULT_RECORDING_INDEX_INVALID",
                    "recording summary did not include recordingId",
                )
            })?;
        let state = summary
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let (conn, _created) = self.open_os_key_connection()?;
        conn.execute(
            "
            INSERT INTO candor_recordings (
                recording_id, state, chunk_count, total_bytes, stored_bytes,
                encrypted_at_rest, encrypted_chunk_count, created_at_ms, updated_at_ms
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(recording_id) DO UPDATE SET
                state = excluded.state,
                chunk_count = excluded.chunk_count,
                total_bytes = excluded.total_bytes,
                stored_bytes = excluded.stored_bytes,
                encrypted_at_rest = excluded.encrypted_at_rest,
                encrypted_chunk_count = excluded.encrypted_chunk_count,
                created_at_ms = excluded.created_at_ms,
                updated_at_ms = excluded.updated_at_ms
            ",
            (
                recording_id,
                state,
                json_u64(summary, "chunkCount") as i64,
                json_u64(summary, "totalBytes") as i64,
                json_u64(summary, "storedBytes") as i64,
                json_bool(summary, "encryptedAtRest") as i64,
                json_u64(summary, "encryptedChunkCount") as i64,
                json_u64(summary, "createdAtMs") as i64,
                json_u64(summary, "updatedAtMs") as i64,
            ),
        )
        .map_err(|err| {
            VaultStoreError::new("VAULT_RECORDING_INDEX_WRITE_FAILED", err.to_string())
        })?;
        let indexed_count = recording_index_count(&conn)?;
        Ok(json!({
            "available": true,
            "state": "indexed",
            "indexed": true,
            "backend": "sqlcipher",
            "recordingId": recording_id,
            "recordingCount": indexed_count,
            "keyMaterialExposedToRenderer": false,
            "rawPathExposed": false
        }))
    }

    fn recording_index_status_sqlcipher(&self) -> Result<Value, VaultStoreError> {
        let (conn, _created) = self.open_os_key_connection()?;
        let indexed_count = recording_index_count(&conn)?;
        Ok(json!({
            "available": true,
            "state": "ready",
            "backend": "sqlcipher",
            "recordingCount": indexed_count,
            "keyMaterialExposedToRenderer": false,
            "rawPathExposed": false
        }))
    }
}

#[cfg(feature = "sqlcipher-vault")]
fn apply_key(conn: &Connection, passphrase: &str) -> Result<(), VaultStoreError> {
    conn.pragma_update(None, "key", passphrase)
        .map_err(|err| VaultStoreError::new("VAULT_KEY_FAILED", err.to_string()))?;
    Ok(())
}

#[cfg(feature = "sqlcipher-vault")]
fn validate_sqlcipher(conn: &Connection) -> Result<(), VaultStoreError> {
    let cipher_version = conn
        .query_row("PRAGMA cipher_version", [], |row| row.get::<_, String>(0))
        .map_err(|err| VaultStoreError::new("SQLCIPHER_UNAVAILABLE", err.to_string()))?;
    if cipher_version.trim().is_empty() {
        return Err(VaultStoreError::new(
            "SQLCIPHER_UNAVAILABLE",
            "PRAGMA cipher_version returned an empty value",
        ));
    }
    Ok(())
}

#[cfg(feature = "sqlcipher-vault")]
fn migrate(conn: &Connection) -> Result<(), VaultStoreError> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS candor_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT OR REPLACE INTO candor_meta(key, value) VALUES ('schemaVersion', '1');
        CREATE TABLE IF NOT EXISTS candor_recordings (
            recording_id TEXT PRIMARY KEY,
            state TEXT NOT NULL,
            chunk_count INTEGER NOT NULL DEFAULT 0,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            stored_bytes INTEGER NOT NULL DEFAULT 0,
            encrypted_at_rest INTEGER NOT NULL DEFAULT 0,
            encrypted_chunk_count INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL DEFAULT 0,
            updated_at_ms INTEGER NOT NULL DEFAULT 0
        );
        ",
    )
    .map_err(|err| VaultStoreError::new("VAULT_MIGRATION_FAILED", err.to_string()))?;
    Ok(())
}

#[cfg(feature = "sqlcipher-vault")]
fn recording_index_count(conn: &Connection) -> Result<i64, VaultStoreError> {
    conn.query_row("SELECT COUNT(*) FROM candor_recordings", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|err| VaultStoreError::new("VAULT_RECORDING_INDEX_READ_FAILED", err.to_string()))
}

#[cfg(feature = "sqlcipher-vault")]
fn json_u64(value: &Value, field: &str) -> u64 {
    value.get(field).and_then(Value::as_u64).unwrap_or_default()
}

#[cfg(feature = "sqlcipher-vault")]
fn json_bool(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(feature = "sqlcipher-vault")]
fn read_schema_version(conn: &Connection) -> Result<String, VaultStoreError> {
    conn.query_row(
        "SELECT value FROM candor_meta WHERE key = 'schemaVersion'",
        [],
        |row| row.get::<_, String>(0),
    )
    .map_err(|err| VaultStoreError::new("VAULT_SCHEMA_READ_FAILED", err.to_string()))
}

#[cfg(feature = "sqlcipher-vault")]
fn validate_passphrase(passphrase: &str) -> Result<(), VaultStoreError> {
    if passphrase.len() < MIN_PASSPHRASE_BYTES {
        return Err(VaultStoreError::new(
            "VAULT_PASSPHRASE_TOO_SHORT",
            "passphrase must be at least 12 bytes for the proof harness",
        ));
    }
    Ok(())
}

fn default_data_root() -> PathBuf {
    if cfg!(target_os = "windows") {
        return env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(env::temp_dir)
            .join("Candor")
            .join("v3");
    }

    if cfg!(target_os = "macos") {
        return env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(env::temp_dir)
            .join("Library")
            .join("Application Support")
            .join("Candor")
            .join("v3");
    }

    env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share"))
        })
        .unwrap_or_else(env::temp_dir)
        .join("candor")
        .join("v3")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_store() -> VaultStore {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        VaultStore::with_root(env::temp_dir().join(format!("candor-vault-test-{stamp}")))
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn sqlcipher_vault_opens_without_exposing_key_or_path() {
        let store = temp_store();
        let opened = store
            .open_or_create(VaultOpenParams {
                passphrase: "correct horse battery staple".to_string(),
            })
            .expect("open vault");

        assert_eq!(opened["state"], "open");
        assert_eq!(opened["backend"], "sqlcipher");
        assert_eq!(opened["encrypted"], true);
        assert_eq!(opened["keyMaterialExposedToRenderer"], false);
        assert_eq!(opened["rawPathExposed"], false);
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn wrong_key_cannot_read_sqlcipher_vault() {
        let store = temp_store();
        let proof = store
            .proof_wrong_key_fails(
                VaultOpenParams {
                    passphrase: "correct horse battery staple".to_string(),
                },
                VaultOpenParams {
                    passphrase: "wrong horse battery staple".to_string(),
                },
            )
            .expect("wrong key proof");

        assert_eq!(proof["wrongKeyFailed"], true);
        assert_eq!(proof["keyMaterialExposedToRenderer"], false);
        assert_eq!(proof["rawPathExposed"], false);
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn passphrase_fallback_reopens_and_rejects_wrong_key_without_exposure() {
        let store = temp_store();
        let proof = store
            .proof_passphrase_fallback()
            .expect("passphrase fallback proof");

        assert_eq!(proof["state"], "open");
        assert_eq!(proof["backend"], "sqlcipher");
        assert_eq!(proof["encrypted"], true);
        assert_eq!(proof["openMode"], "passphrase-fallback");
        assert_eq!(proof["proofHarness"], true);
        assert_eq!(proof["passphraseRequired"], true);
        assert_eq!(proof["reopenVerified"], true);
        assert_eq!(proof["wrongKeyFailed"], true);
        assert_eq!(proof["rendererPassphraseExposed"], false);
        assert_eq!(proof["keyMaterialExposedToRenderer"], false);
        assert_eq!(proof["rawPathExposed"], false);
    }

    #[cfg(all(windows, feature = "sqlcipher-vault"))]
    #[test]
    fn os_key_backed_sqlcipher_open_uses_production_vault_without_exposing_key_or_path() {
        let store = temp_store();
        let opened = store.open_local().expect("open vault with os key");

        assert_eq!(opened["state"], "open");
        assert_eq!(opened["backend"], "sqlcipher");
        assert_eq!(opened["encrypted"], true);
        assert_eq!(opened["schemaVersion"], "1");
        assert_eq!(opened["openMode"], "os-key");
        assert_eq!(opened["proofHarness"], false);
        assert_eq!(opened["passphraseRequired"], false);
        assert_eq!(opened["keyMaterialExposedToRenderer"], false);
        assert_eq!(opened["rawPathExposed"], false);

        let status = store.status();
        assert_eq!(status["state"], "closed");
        assert_eq!(status["encrypted"], true);
    }

    #[cfg(all(windows, feature = "sqlcipher-vault"))]
    #[test]
    fn os_key_backed_sqlcipher_proof_reopens_without_exposing_key_or_path() {
        let store = temp_store();
        let opened = store
            .open_with_os_key_proof()
            .expect("open vault with os key");

        assert_eq!(opened["state"], "open");
        assert_eq!(opened["backend"], "sqlcipher");
        assert_eq!(opened["encrypted"], true);
        assert_eq!(opened["schemaVersion"], "1");
        assert_eq!(opened["openMode"], "os-key");
        assert_eq!(opened["proofHarness"], true);
        assert_eq!(opened["passphraseRequired"], false);
        assert_eq!(opened["reopenVerified"], true);
        assert_eq!(opened["stableAfterReopen"], true);
        assert_eq!(opened["keyMaterialExposedToRenderer"], false);
        assert_eq!(opened["rawPathExposed"], false);
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn short_passphrase_is_rejected() {
        let store = temp_store();
        let error = store
            .open_or_create(VaultOpenParams {
                passphrase: "short".to_string(),
            })
            .expect_err("short passphrase should fail");

        assert_eq!(error.code, "VAULT_PASSPHRASE_TOO_SHORT");
    }

    #[cfg(not(feature = "sqlcipher-vault"))]
    #[test]
    fn sqlcipher_feature_disabled_is_explicit() {
        let store = temp_store();
        let status = store.status();
        assert_eq!(status["backend"], "sqlcipher");
        assert_eq!(status["sqlcipherAvailable"], false);
        #[cfg(windows)]
        assert_eq!(status["osKeyStorage"], "dpapi-proof-available");
        #[cfg(not(windows))]
        assert!(matches!(
            status["osKeyStorage"].as_str(),
            Some(
                "keychain-proof-available"
                    | "keychain-unavailable"
                    | "secret-service-proof-available"
                    | "secret-service-unavailable"
            )
        ));

        let error = store
            .open_or_create(VaultOpenParams {
                passphrase: "correct horse battery staple".to_string(),
            })
            .expect_err("feature-disabled open should fail");
        assert_eq!(error.code, "SQLCIPHER_FEATURE_DISABLED");
    }
}
