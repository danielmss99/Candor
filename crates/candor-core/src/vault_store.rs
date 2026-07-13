use std::env;
#[cfg(feature = "sqlcipher-vault")]
use std::fs::{self, File, OpenOptions};
#[cfg(feature = "sqlcipher-vault")]
use std::io::{Read, Write};
#[cfg(feature = "sqlcipher-vault")]
use std::path::Path;
use std::path::PathBuf;
#[cfg(feature = "sqlcipher-vault")]
use std::time::{SystemTime, UNIX_EPOCH};

use crate::os_key_store;
#[cfg(feature = "sqlcipher-vault")]
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
#[cfg(feature = "sqlcipher-vault")]
use serde::Serialize;
use serde_json::{json, Value};
#[cfg(feature = "sqlcipher-vault")]
use sha2::{Digest, Sha256};

const VAULT_FILE: &str = "candor-v3.sqlcipher";
#[cfg(feature = "sqlcipher-vault")]
const PASSPHRASE_PROOF_VAULT_FILE: &str = "candor-v3-passphrase-proof.sqlcipher";
#[cfg(feature = "sqlcipher-vault")]
const MIN_PASSPHRASE_BYTES: usize = 12;
#[cfg(feature = "sqlcipher-vault")]
const CURRENT_VAULT_SCHEMA_VERSION: u32 = 2;
#[cfg(feature = "sqlcipher-vault")]
const V1_TO_V2_MIGRATION_ID: &str = "vault-schema-1-to-2";

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
    #[cfg(feature = "sqlcipher-vault")]
    launch_id: String,
    #[cfg(all(test, feature = "sqlcipher-vault"))]
    fail_v1_migration_after_receipt: bool,
}

#[cfg(feature = "sqlcipher-vault")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultMigrationReport {
    state: &'static str,
    from_schema_version: Option<u32>,
    to_schema_version: u32,
    backup_state: &'static str,
    journal_mode_at_backup: Option<String>,
}

#[cfg(feature = "sqlcipher-vault")]
struct OpenedVault {
    connection: Connection,
    created: bool,
    migration: VaultMigrationReport,
}

#[cfg(feature = "sqlcipher-vault")]
#[derive(Clone, Debug, PartialEq, Eq)]
struct VaultInvariants {
    recording_count: i64,
    kdf_iter: String,
    cipher_page_size: String,
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
                    #[cfg(feature = "sqlcipher-vault")]
                    launch_id: new_launch_id(),
                    #[cfg(all(test, feature = "sqlcipher-vault"))]
                    fail_v1_migration_after_receipt: false,
                };
            }
        }

        Self {
            root: default_data_root(),
            root_kind: "local-user-data",
            #[cfg(feature = "sqlcipher-vault")]
            launch_id: new_launch_id(),
            #[cfg(all(test, feature = "sqlcipher-vault"))]
            fail_v1_migration_after_receipt: false,
        }
    }

    #[cfg(test)]
    pub fn with_root(root: PathBuf) -> Self {
        Self {
            root,
            root_kind: "test-root",
            #[cfg(feature = "sqlcipher-vault")]
            launch_id: new_launch_id(),
            #[cfg(all(test, feature = "sqlcipher-vault"))]
            fail_v1_migration_after_receipt: false,
        }
    }

    #[cfg(all(test, feature = "sqlcipher-vault"))]
    fn with_root_and_launch_id(root: PathBuf, launch_id: &str) -> Self {
        Self {
            root,
            root_kind: "test-root",
            launch_id: launch_id.to_string(),
            fail_v1_migration_after_receipt: false,
        }
    }

    #[cfg(all(test, feature = "sqlcipher-vault"))]
    fn with_forced_migration_failure(mut self) -> Self {
        self.fail_v1_migration_after_receipt = true;
        self
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
            let opened = self.open_keyed_vault(&path, &params.passphrase)?;
            let schema_version = read_schema_version(&opened.connection)?;

            Ok(json!({
                "state": "open",
                "backend": "sqlcipher",
                "encrypted": true,
                "created": opened.created,
                "schemaVersion": schema_version,
                "migration": opened.migration,
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
    fn open_keyed_vault(
        &self,
        path: &Path,
        passphrase: &str,
    ) -> Result<OpenedVault, VaultStoreError> {
        let mut conn = open_keyed_connection(path, passphrase)?;
        let schema_version = detect_schema_version(&conn)?;
        let created = schema_version.is_none();

        let migration = match schema_version {
            None => {
                create_current_schema(&mut conn)?;
                VaultMigrationReport {
                    state: "created",
                    from_schema_version: None,
                    to_schema_version: CURRENT_VAULT_SCHEMA_VERSION,
                    backup_state: "not-required",
                    journal_mode_at_backup: None,
                }
            }
            Some(CURRENT_VAULT_SCHEMA_VERSION) => {
                let invariants = verify_current_schema(&conn, None)?;
                reconcile_retained_backup(&conn, path, &self.launch_id, &invariants)?
            }
            Some(1) => {
                let before = collect_vault_invariants(&conn)?;
                let journal_mode = prepare_for_raw_backup(&conn)?;
                let backup_path = vault_backup_path(path);
                let migration_result = migrate_v1_to_v2(
                    &mut conn,
                    path,
                    &backup_path,
                    &self.launch_id,
                    &before,
                    &journal_mode,
                    self.should_fail_migration_for_test(),
                );
                if let Err(error) = migration_result {
                    verify_legacy_v1_after_failed_migration(&conn, &before)?;
                    return Err(error);
                }
                verify_current_schema(&conn, Some(&before))?;

                VaultMigrationReport {
                    state: "migrated",
                    from_schema_version: Some(1),
                    to_schema_version: CURRENT_VAULT_SCHEMA_VERSION,
                    backup_state: "retained-until-next-launch",
                    journal_mode_at_backup: Some(journal_mode),
                }
            }
            Some(version) if version > CURRENT_VAULT_SCHEMA_VERSION => {
                return Err(VaultStoreError::new(
                    "VAULT_SCHEMA_TOO_NEW",
                    format!(
                        "vault schema {version} is newer than supported schema {CURRENT_VAULT_SCHEMA_VERSION}"
                    ),
                ));
            }
            Some(version) => {
                return Err(VaultStoreError::new(
                    "VAULT_SCHEMA_UNSUPPORTED",
                    format!("vault schema {version} cannot be upgraded by this build"),
                ));
            }
        };

        Ok(OpenedVault {
            connection: conn,
            created,
            migration,
        })
    }

    #[cfg(test)]
    fn should_fail_migration_for_test(&self) -> bool {
        self.fail_v1_migration_after_receipt
    }

    #[cfg(not(test))]
    fn should_fail_migration_for_test(&self) -> bool {
        false
    }

    fn open_os_key_connection(&self) -> Result<OpenedVault, VaultStoreError> {
        std::fs::create_dir_all(&self.root)
            .map_err(|err| VaultStoreError::new("VAULT_ROOT_CREATE_FAILED", err.to_string()))?;

        let key = os_key_store::get_or_create_key(&self.root)
            .map_err(|err| VaultStoreError::new(err.code, err.message))?;
        let path = self.vault_path();
        let passphrase = key.sqlcipher_passphrase();
        self.open_keyed_vault(&path, &passphrase)
    }

    fn open_os_key_vault(&self, verify_reopen: bool) -> Result<Value, VaultStoreError> {
        let key = os_key_store::get_or_create_key(&self.root)
            .map_err(|err| VaultStoreError::new(err.code, err.message))?;
        let opened = self.open_os_key_connection()?;
        let schema_version = read_schema_version(&opened.connection)?;
        let created = opened.created;
        let migration = opened.migration;
        drop(opened.connection);

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
            "migration": migration,
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
        let opened = self.open_os_key_connection()?;
        let conn = opened.connection;
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
        let opened = self.open_os_key_connection()?;
        let conn = opened.connection;
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
fn open_keyed_connection(path: &Path, passphrase: &str) -> Result<Connection, VaultStoreError> {
    let conn = Connection::open(path)
        .map_err(|err| VaultStoreError::new("VAULT_OPEN_FAILED", err.to_string()))?;
    apply_key(&conn, passphrase)?;
    validate_sqlcipher(&conn)?;
    Ok(conn)
}

#[cfg(feature = "sqlcipher-vault")]
fn detect_schema_version(conn: &Connection) -> Result<Option<u32>, VaultStoreError> {
    if !table_exists(conn, "candor_meta")? {
        let application_tables = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|err| VaultStoreError::new("VAULT_SCHEMA_READ_FAILED", err.to_string()))?;
        if application_tables > 0 {
            return Err(VaultStoreError::new(
                "VAULT_SCHEMA_METADATA_MISSING",
                "vault contains application tables but no schema metadata",
            ));
        }
        return Ok(None);
    }

    read_schema_version(conn).map(Some)
}

#[cfg(feature = "sqlcipher-vault")]
fn create_current_schema(conn: &mut Connection) -> Result<(), VaultStoreError> {
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| VaultStoreError::new("VAULT_MIGRATION_FAILED", err.to_string()))?;
    transaction
        .execute_batch(&format!(
            "
            CREATE TABLE candor_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE candor_recordings (
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
            CREATE TABLE candor_migrations (
                migration_id TEXT PRIMARY KEY,
                from_version INTEGER NOT NULL,
                to_version INTEGER NOT NULL,
                migration_launch_id TEXT NOT NULL,
                confirmed_launch_id TEXT,
                recording_count INTEGER NOT NULL,
                kdf_iter TEXT NOT NULL,
                cipher_page_size TEXT NOT NULL,
                journal_mode_at_backup TEXT NOT NULL,
                backup_state TEXT NOT NULL,
                migrated_at_ms INTEGER NOT NULL
            );
            INSERT INTO candor_meta(key, value)
            VALUES ('schemaVersion', '{CURRENT_VAULT_SCHEMA_VERSION}');
            "
        ))
        .map_err(|err| VaultStoreError::new("VAULT_MIGRATION_FAILED", err.to_string()))?;
    transaction
        .commit()
        .map_err(|err| VaultStoreError::new("VAULT_MIGRATION_FAILED", err.to_string()))?;
    verify_current_schema(conn, None)?;
    Ok(())
}

#[cfg(feature = "sqlcipher-vault")]
fn migrate_v1_to_v2(
    conn: &mut Connection,
    vault_path: &Path,
    backup_path: &Path,
    launch_id: &str,
    before: &VaultInvariants,
    journal_mode_at_backup: &str,
    force_failure: bool,
) -> Result<(), VaultStoreError> {
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Exclusive)
        .map_err(|err| VaultStoreError::new("VAULT_MIGRATION_FAILED", err.to_string()))?;

    if let Err(error) = create_durable_verified_backup(vault_path, backup_path) {
        transaction.rollback().map_err(|rollback_error| {
            VaultStoreError::new(
                "VAULT_MIGRATION_ROLLBACK_FAILED",
                rollback_error.to_string(),
            )
        })?;
        return Err(error);
    }

    transaction
        .execute_batch(
            "
            CREATE TABLE candor_migrations (
                migration_id TEXT PRIMARY KEY,
                from_version INTEGER NOT NULL,
                to_version INTEGER NOT NULL,
                migration_launch_id TEXT NOT NULL,
                confirmed_launch_id TEXT,
                recording_count INTEGER NOT NULL,
                kdf_iter TEXT NOT NULL,
                cipher_page_size TEXT NOT NULL,
                journal_mode_at_backup TEXT NOT NULL,
                backup_state TEXT NOT NULL,
                migrated_at_ms INTEGER NOT NULL
            );
            ",
        )
        .map_err(|err| VaultStoreError::new("VAULT_MIGRATION_FAILED", err.to_string()))?;
    transaction
        .execute(
            "
            INSERT INTO candor_migrations (
                migration_id, from_version, to_version, migration_launch_id,
                recording_count, kdf_iter, cipher_page_size,
                journal_mode_at_backup, backup_state, migrated_at_ms
            ) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, 'retained', ?8)
            ",
            (
                V1_TO_V2_MIGRATION_ID,
                CURRENT_VAULT_SCHEMA_VERSION,
                launch_id,
                before.recording_count,
                before.kdf_iter.as_str(),
                before.cipher_page_size.as_str(),
                journal_mode_at_backup,
                unix_time_ms(),
            ),
        )
        .map_err(|err| VaultStoreError::new("VAULT_MIGRATION_FAILED", err.to_string()))?;

    if force_failure {
        transaction.rollback().map_err(|err| {
            VaultStoreError::new("VAULT_MIGRATION_ROLLBACK_FAILED", err.to_string())
        })?;
        return Err(VaultStoreError::new(
            "VAULT_MIGRATION_FAILED",
            "injected migration failure after receipt creation",
        ));
    }

    let updated = transaction
        .execute(
            "UPDATE candor_meta SET value = ?1 WHERE key = 'schemaVersion' AND value = '1'",
            [CURRENT_VAULT_SCHEMA_VERSION.to_string()],
        )
        .map_err(|err| VaultStoreError::new("VAULT_MIGRATION_FAILED", err.to_string()))?;
    if updated != 1 {
        transaction.rollback().map_err(|err| {
            VaultStoreError::new("VAULT_MIGRATION_ROLLBACK_FAILED", err.to_string())
        })?;
        return Err(VaultStoreError::new(
            "VAULT_MIGRATION_PRECONDITION_FAILED",
            "schema version changed before migration commit",
        ));
    }

    transaction
        .commit()
        .map_err(|err| VaultStoreError::new("VAULT_MIGRATION_FAILED", err.to_string()))
}

#[cfg(feature = "sqlcipher-vault")]
fn prepare_for_raw_backup(conn: &Connection) -> Result<String, VaultStoreError> {
    let initial_mode = query_journal_mode(conn)?;
    if initial_mode == "wal" {
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|err| {
                VaultStoreError::new("VAULT_BACKUP_CHECKPOINT_FAILED", err.to_string())
            })?;
    }

    let selected_mode = conn
        .query_row("PRAGMA journal_mode=DELETE", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| VaultStoreError::new("VAULT_BACKUP_MODE_FAILED", err.to_string()))?
        .to_ascii_lowercase();
    let verified_mode = query_journal_mode(conn)?;
    if selected_mode != "delete" || verified_mode != "delete" {
        return Err(VaultStoreError::new(
            "VAULT_BACKUP_MODE_FAILED",
            "vault could not enter rollback-journal mode before backup",
        ));
    }
    Ok(verified_mode)
}

#[cfg(feature = "sqlcipher-vault")]
fn create_durable_verified_backup(source: &Path, backup: &Path) -> Result<(), VaultStoreError> {
    if backup.exists() {
        if files_match(source, backup)? {
            return Ok(());
        }
        return Err(VaultStoreError::new(
            "VAULT_BACKUP_CONFLICT",
            "an existing migration backup does not match the current vault",
        ));
    }

    let partial = vault_partial_backup_path(backup);
    if partial.exists() {
        fs::remove_file(&partial).map_err(|err| {
            VaultStoreError::new("VAULT_BACKUP_PARTIAL_CLEANUP_FAILED", err.to_string())
        })?;
    }

    let mut source_file = File::open(source)
        .map_err(|err| VaultStoreError::new("VAULT_BACKUP_READ_FAILED", err.to_string()))?;
    let mut backup_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(|err| VaultStoreError::new("VAULT_BACKUP_CREATE_FAILED", err.to_string()))?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = source_file
            .read(&mut buffer)
            .map_err(|err| VaultStoreError::new("VAULT_BACKUP_READ_FAILED", err.to_string()))?;
        if read == 0 {
            break;
        }
        backup_file
            .write_all(&buffer[..read])
            .map_err(|err| VaultStoreError::new("VAULT_BACKUP_WRITE_FAILED", err.to_string()))?;
    }
    backup_file
        .sync_all()
        .map_err(|err| VaultStoreError::new("VAULT_BACKUP_SYNC_FAILED", err.to_string()))?;
    drop(backup_file);

    if !files_match(source, &partial)? {
        let _ = fs::remove_file(&partial);
        return Err(VaultStoreError::new(
            "VAULT_BACKUP_VERIFY_FAILED",
            "encrypted migration backup did not match the source vault",
        ));
    }

    fs::rename(&partial, backup)
        .map_err(|err| VaultStoreError::new("VAULT_BACKUP_COMMIT_FAILED", err.to_string()))?;
    if !files_match(source, backup)? {
        return Err(VaultStoreError::new(
            "VAULT_BACKUP_VERIFY_FAILED",
            "committed encrypted migration backup did not match the source vault",
        ));
    }
    Ok(())
}

#[cfg(feature = "sqlcipher-vault")]
fn files_match(left: &Path, right: &Path) -> Result<bool, VaultStoreError> {
    let left_metadata = fs::metadata(left)
        .map_err(|err| VaultStoreError::new("VAULT_BACKUP_VERIFY_FAILED", err.to_string()))?;
    let right_metadata = fs::metadata(right)
        .map_err(|err| VaultStoreError::new("VAULT_BACKUP_VERIFY_FAILED", err.to_string()))?;
    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }
    Ok(file_digest(left)? == file_digest(right)?)
}

#[cfg(feature = "sqlcipher-vault")]
fn file_digest(path: &Path) -> Result<[u8; 32], VaultStoreError> {
    let mut file = File::open(path)
        .map_err(|err| VaultStoreError::new("VAULT_BACKUP_VERIFY_FAILED", err.to_string()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| VaultStoreError::new("VAULT_BACKUP_VERIFY_FAILED", err.to_string()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest.finalize().into())
}

#[cfg(feature = "sqlcipher-vault")]
fn verify_current_schema(
    conn: &Connection,
    expected: Option<&VaultInvariants>,
) -> Result<VaultInvariants, VaultStoreError> {
    let version = read_schema_version(conn)?;
    if version != CURRENT_VAULT_SCHEMA_VERSION {
        return Err(VaultStoreError::new(
            "VAULT_MIGRATION_VERIFY_FAILED",
            format!("expected schema {CURRENT_VAULT_SCHEMA_VERSION}, found {version}"),
        ));
    }
    validate_sqlcipher(conn)?;
    verify_table_columns(conn, "candor_meta", &["key", "value"])?;
    verify_table_columns(
        conn,
        "candor_recordings",
        &[
            "recording_id",
            "state",
            "chunk_count",
            "total_bytes",
            "stored_bytes",
            "encrypted_at_rest",
            "encrypted_chunk_count",
            "created_at_ms",
            "updated_at_ms",
        ],
    )?;
    verify_table_columns(
        conn,
        "candor_migrations",
        &[
            "migration_id",
            "from_version",
            "to_version",
            "migration_launch_id",
            "confirmed_launch_id",
            "recording_count",
            "kdf_iter",
            "cipher_page_size",
            "journal_mode_at_backup",
            "backup_state",
            "migrated_at_ms",
        ],
    )?;

    let actual = collect_vault_invariants(conn)?;
    if let Some(expected) = expected {
        if actual != *expected {
            return Err(VaultStoreError::new(
                "VAULT_MIGRATION_VERIFY_FAILED",
                "vault record count or SQLCipher settings changed during migration",
            ));
        }
    }
    Ok(actual)
}

#[cfg(feature = "sqlcipher-vault")]
fn verify_legacy_v1_after_failed_migration(
    conn: &Connection,
    expected: &VaultInvariants,
) -> Result<(), VaultStoreError> {
    if read_schema_version(conn)? != 1 || collect_vault_invariants(conn)? != *expected {
        return Err(VaultStoreError::new(
            "VAULT_MIGRATION_ROLLBACK_FAILED",
            "failed migration did not preserve the original vault invariants",
        ));
    }
    Ok(())
}

#[cfg(feature = "sqlcipher-vault")]
fn reconcile_retained_backup(
    conn: &Connection,
    vault_path: &Path,
    launch_id: &str,
    actual: &VaultInvariants,
) -> Result<VaultMigrationReport, VaultStoreError> {
    let receipt = conn
        .query_row(
            "
            SELECT migration_launch_id, recording_count, kdf_iter,
                   cipher_page_size, journal_mode_at_backup, backup_state
            FROM candor_migrations WHERE migration_id = ?1
            ",
            [V1_TO_V2_MIGRATION_ID],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|err| {
            VaultStoreError::new("VAULT_MIGRATION_RECEIPT_READ_FAILED", err.to_string())
        })?;

    let Some((
        migration_launch_id,
        recording_count,
        kdf_iter,
        cipher_page_size,
        journal_mode,
        backup_state,
    )) = receipt
    else {
        return Ok(VaultMigrationReport {
            state: "current",
            from_schema_version: Some(CURRENT_VAULT_SCHEMA_VERSION),
            to_schema_version: CURRENT_VAULT_SCHEMA_VERSION,
            backup_state: "not-required",
            journal_mode_at_backup: None,
        });
    };

    if actual.recording_count < recording_count
        || actual.kdf_iter != kdf_iter
        || actual.cipher_page_size != cipher_page_size
    {
        return Err(VaultStoreError::new(
            "VAULT_MIGRATION_VERIFY_FAILED",
            "vault lost indexed records or changed SQLCipher settings after migration",
        ));
    }

    if backup_state == "confirmed-removed" {
        return Ok(VaultMigrationReport {
            state: "current",
            from_schema_version: Some(CURRENT_VAULT_SCHEMA_VERSION),
            to_schema_version: CURRENT_VAULT_SCHEMA_VERSION,
            backup_state: "confirmed-removed",
            journal_mode_at_backup: Some(journal_mode),
        });
    }

    if migration_launch_id == launch_id {
        return Ok(VaultMigrationReport {
            state: "current",
            from_schema_version: Some(CURRENT_VAULT_SCHEMA_VERSION),
            to_schema_version: CURRENT_VAULT_SCHEMA_VERSION,
            backup_state: "retained-until-next-launch",
            journal_mode_at_backup: Some(journal_mode),
        });
    }

    let backup_path = vault_backup_path(vault_path);
    if !backup_path.exists() {
        return Ok(VaultMigrationReport {
            state: "current",
            from_schema_version: Some(CURRENT_VAULT_SCHEMA_VERSION),
            to_schema_version: CURRENT_VAULT_SCHEMA_VERSION,
            backup_state: "missing-after-migration",
            journal_mode_at_backup: Some(journal_mode),
        });
    }

    conn.execute(
        "
        UPDATE candor_migrations
        SET backup_state = 'verified-pending-removal', confirmed_launch_id = ?1
        WHERE migration_id = ?2
        ",
        (launch_id, V1_TO_V2_MIGRATION_ID),
    )
    .map_err(|err| VaultStoreError::new("VAULT_MIGRATION_RECEIPT_WRITE_FAILED", err.to_string()))?;

    if fs::remove_file(&backup_path).is_err() {
        return Ok(VaultMigrationReport {
            state: "current",
            from_schema_version: Some(CURRENT_VAULT_SCHEMA_VERSION),
            to_schema_version: CURRENT_VAULT_SCHEMA_VERSION,
            backup_state: "retained-removal-failed",
            journal_mode_at_backup: Some(journal_mode),
        });
    }

    conn.execute(
        "UPDATE candor_migrations SET backup_state = 'confirmed-removed' WHERE migration_id = ?1",
        [V1_TO_V2_MIGRATION_ID],
    )
    .map_err(|err| VaultStoreError::new("VAULT_MIGRATION_RECEIPT_WRITE_FAILED", err.to_string()))?;

    Ok(VaultMigrationReport {
        state: "current",
        from_schema_version: Some(CURRENT_VAULT_SCHEMA_VERSION),
        to_schema_version: CURRENT_VAULT_SCHEMA_VERSION,
        backup_state: "confirmed-removed",
        journal_mode_at_backup: Some(journal_mode),
    })
}

#[cfg(feature = "sqlcipher-vault")]
fn collect_vault_invariants(conn: &Connection) -> Result<VaultInvariants, VaultStoreError> {
    Ok(VaultInvariants {
        recording_count: recording_index_count(conn)?,
        kdf_iter: query_pragma_string(conn, "PRAGMA kdf_iter")?,
        cipher_page_size: query_pragma_string(conn, "PRAGMA cipher_page_size")?,
    })
}

#[cfg(feature = "sqlcipher-vault")]
fn query_pragma_string(conn: &Connection, pragma: &str) -> Result<String, VaultStoreError> {
    conn.query_row(pragma, [], |row| row.get::<_, String>(0))
        .map_err(|err| VaultStoreError::new("VAULT_INVARIANT_READ_FAILED", err.to_string()))
}

#[cfg(feature = "sqlcipher-vault")]
fn query_journal_mode(conn: &Connection) -> Result<String, VaultStoreError> {
    conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
        .map(|mode| mode.to_ascii_lowercase())
        .map_err(|err| VaultStoreError::new("VAULT_BACKUP_MODE_FAILED", err.to_string()))
}

#[cfg(feature = "sqlcipher-vault")]
fn verify_table_columns(
    conn: &Connection,
    table: &str,
    expected: &[&str],
) -> Result<(), VaultStoreError> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|err| VaultStoreError::new("VAULT_SCHEMA_VERIFY_FAILED", err.to_string()))?;
    let actual = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| VaultStoreError::new("VAULT_SCHEMA_VERIFY_FAILED", err.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| VaultStoreError::new("VAULT_SCHEMA_VERIFY_FAILED", err.to_string()))?;
    if actual != expected {
        return Err(VaultStoreError::new(
            "VAULT_SCHEMA_VERIFY_FAILED",
            format!("vault table {table} does not match the expected schema"),
        ));
    }
    Ok(())
}

#[cfg(feature = "sqlcipher-vault")]
fn table_exists(conn: &Connection, table: &str) -> Result<bool, VaultStoreError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|err| VaultStoreError::new("VAULT_SCHEMA_READ_FAILED", err.to_string()))
}

#[cfg(feature = "sqlcipher-vault")]
fn vault_backup_path(path: &Path) -> PathBuf {
    let mut backup_name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "candor-vault".into());
    backup_name.push(".pre-v2.bak");
    path.with_file_name(backup_name)
}

#[cfg(feature = "sqlcipher-vault")]
fn vault_partial_backup_path(backup: &Path) -> PathBuf {
    let mut partial_name = backup
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "candor-vault-backup".into());
    partial_name.push(".partial");
    backup.with_file_name(partial_name)
}

#[cfg(feature = "sqlcipher-vault")]
fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

#[cfg(feature = "sqlcipher-vault")]
fn new_launch_id() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        return format!("fallback-{}-{}", std::process::id(), unix_time_ms());
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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
fn read_schema_version(conn: &Connection) -> Result<u32, VaultStoreError> {
    let value = conn
        .query_row(
            "SELECT value FROM candor_meta WHERE key = 'schemaVersion'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|err| VaultStoreError::new("VAULT_SCHEMA_READ_FAILED", err.to_string()))?;
    value.parse::<u32>().map_err(|_| {
        VaultStoreError::new(
            "VAULT_SCHEMA_INVALID",
            "vault schema metadata is not a supported integer",
        )
    })
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

    #[cfg(feature = "sqlcipher-vault")]
    const TEST_PASSPHRASE: &str = "correct horse battery staple";

    fn temp_store() -> VaultStore {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        VaultStore::with_root(env::temp_dir().join(format!("candor-vault-test-{stamp}")))
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn create_legacy_v1_vault(store: &VaultStore, journal_mode: Option<&str>) -> PathBuf {
        fs::create_dir_all(&store.root).expect("create test vault root");
        let path = store.passphrase_proof_vault_path();
        let conn = open_keyed_connection(&path, TEST_PASSPHRASE).expect("open legacy vault");
        conn.execute_batch(
            "
            CREATE TABLE candor_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT INTO candor_meta(key, value) VALUES ('schemaVersion', '1');
            CREATE TABLE candor_recordings (
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
            INSERT INTO candor_recordings (
                recording_id, state, chunk_count, total_bytes, stored_bytes,
                encrypted_at_rest, encrypted_chunk_count, created_at_ms, updated_at_ms
            ) VALUES ('legacy-recording', 'finished', 2, 32, 64, 1, 2, 1, 2);
            ",
        )
        .expect("create legacy schema");
        if let Some(mode) = journal_mode {
            let selected = conn
                .query_row(&format!("PRAGMA journal_mode={mode}"), [], |row| {
                    row.get::<_, String>(0)
                })
                .expect("set legacy journal mode");
            assert_eq!(selected.to_ascii_lowercase(), mode.to_ascii_lowercase());
            conn.execute(
                "UPDATE candor_recordings SET updated_at_ms = 3 WHERE recording_id = 'legacy-recording'",
                [],
            )
            .expect("write through requested journal mode");
        }
        drop(conn);
        path
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn open_test_vault(store: &VaultStore) -> Result<Value, VaultStoreError> {
        store.open_or_create(VaultOpenParams {
            passphrase: TEST_PASSPHRASE.to_string(),
        })
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn sqlcipher_vault_opens_without_exposing_key_or_path() {
        let store = temp_store();
        let opened = open_test_vault(&store).expect("open vault");

        assert_eq!(opened["state"], "open");
        assert_eq!(opened["backend"], "sqlcipher");
        assert_eq!(opened["encrypted"], true);
        assert_eq!(opened["schemaVersion"], CURRENT_VAULT_SCHEMA_VERSION);
        assert_eq!(opened["migration"]["state"], "created");
        assert_eq!(opened["keyMaterialExposedToRenderer"], false);
        assert_eq!(opened["rawPathExposed"], false);
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn v1_migration_creates_a_verified_encrypted_backup_and_preserves_invariants() {
        let store = temp_store();
        let path = create_legacy_v1_vault(&store, None);
        let before_digest = file_digest(&path).expect("digest legacy vault");
        let before_conn = open_keyed_connection(&path, TEST_PASSPHRASE).expect("open legacy vault");
        let before = collect_vault_invariants(&before_conn).expect("legacy invariants");
        drop(before_conn);

        let opened = open_test_vault(&store).expect("migrate legacy vault");
        let backup = vault_backup_path(&path);
        assert_eq!(opened["schemaVersion"], CURRENT_VAULT_SCHEMA_VERSION);
        assert_eq!(opened["migration"]["state"], "migrated");
        assert_eq!(
            opened["migration"]["backupState"],
            "retained-until-next-launch"
        );
        assert!(backup.exists());
        assert_eq!(file_digest(&backup).expect("digest backup"), before_digest);

        let migrated_conn =
            open_keyed_connection(&path, TEST_PASSPHRASE).expect("open migrated vault");
        assert_eq!(
            verify_current_schema(&migrated_conn, Some(&before)).expect("verify migration"),
            before
        );
        drop(migrated_conn);

        let backup_conn =
            open_keyed_connection(&backup, TEST_PASSPHRASE).expect("open encrypted backup");
        assert_eq!(read_schema_version(&backup_conn).expect("backup schema"), 1);
        assert_eq!(
            recording_index_count(&backup_conn).expect("backup row count"),
            1
        );
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn current_schema_reopens_without_downgrade_or_backup() {
        let store = temp_store();
        let first = open_test_vault(&store).expect("create current vault");
        let second = open_test_vault(&store).expect("reopen current vault");

        assert_eq!(first["schemaVersion"], CURRENT_VAULT_SCHEMA_VERSION);
        assert_eq!(second["schemaVersion"], CURRENT_VAULT_SCHEMA_VERSION);
        assert_eq!(second["migration"]["state"], "current");
        assert_eq!(second["migration"]["backupState"], "not-required");
        assert!(!vault_backup_path(&store.passphrase_proof_vault_path()).exists());
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn future_schema_is_rejected_without_rewrite_or_backup() {
        let store = temp_store();
        let path = create_legacy_v1_vault(&store, None);
        let conn = open_keyed_connection(&path, TEST_PASSPHRASE).expect("open future vault");
        conn.execute(
            "UPDATE candor_meta SET value = '99' WHERE key = 'schemaVersion'",
            [],
        )
        .expect("set future schema");
        drop(conn);
        let before = file_digest(&path).expect("future digest before open");

        let error = open_test_vault(&store).expect_err("future schema must fail closed");

        assert_eq!(error.code, "VAULT_SCHEMA_TOO_NEW");
        assert_eq!(
            file_digest(&path).expect("future digest after open"),
            before
        );
        assert!(!vault_backup_path(&path).exists());
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn failed_migration_rolls_back_and_retains_the_verified_backup() {
        let base_store = temp_store();
        let path = create_legacy_v1_vault(&base_store, None);
        let before = file_digest(&path).expect("legacy digest");
        let failing_store =
            VaultStore::with_root_and_launch_id(base_store.root.clone(), "launch-a")
                .with_forced_migration_failure();

        let error = open_test_vault(&failing_store).expect_err("injected migration must fail");

        assert_eq!(error.code, "VAULT_MIGRATION_FAILED");
        let conn = open_keyed_connection(&path, TEST_PASSPHRASE).expect("reopen rolled back vault");
        assert_eq!(read_schema_version(&conn).expect("rolled back schema"), 1);
        assert_eq!(recording_index_count(&conn).expect("rolled back rows"), 1);
        assert!(!table_exists(&conn, "candor_migrations").expect("migration table check"));
        drop(conn);
        let backup = vault_backup_path(&path);
        assert!(backup.exists());
        assert_eq!(file_digest(&backup).expect("backup digest"), before);
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn abandoned_partial_backup_is_replaced_before_migration() {
        let store = temp_store();
        let path = create_legacy_v1_vault(&store, None);
        let backup = vault_backup_path(&path);
        let partial = vault_partial_backup_path(&backup);
        fs::write(&partial, b"incomplete-backup").expect("seed abandoned partial backup");

        let opened = open_test_vault(&store).expect("migrate after partial backup");

        assert_eq!(opened["schemaVersion"], CURRENT_VAULT_SCHEMA_VERSION);
        assert!(!partial.exists());
        assert!(backup.exists());
        let backup_conn =
            open_keyed_connection(&backup, TEST_PASSPHRASE).expect("open recovered backup");
        assert_eq!(read_schema_version(&backup_conn).expect("backup schema"), 1);
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn backup_survives_migration_launch_and_is_removed_after_next_launch_verification() {
        let root = temp_store().root;
        let first_launch = VaultStore::with_root_and_launch_id(root.clone(), "launch-a");
        let path = create_legacy_v1_vault(&first_launch, None);
        let backup = vault_backup_path(&path);

        open_test_vault(&first_launch).expect("migrate on first launch");
        assert!(backup.exists());
        open_test_vault(&first_launch).expect("reopen on migration launch");
        assert!(backup.exists());

        let second_launch = VaultStore::with_root_and_launch_id(root, "launch-b");
        let opened = open_test_vault(&second_launch).expect("verify on second launch");
        assert_eq!(opened["migration"]["backupState"], "confirmed-removed");
        assert!(!backup.exists());
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn next_launch_allows_new_rows_while_rejecting_record_loss() {
        let root = temp_store().root;
        let first_launch = VaultStore::with_root_and_launch_id(root.clone(), "launch-a");
        let path = create_legacy_v1_vault(&first_launch, None);
        open_test_vault(&first_launch).expect("migrate first launch");
        let conn = open_keyed_connection(&path, TEST_PASSPHRASE).expect("open migrated vault");
        conn.execute(
            "
            INSERT INTO candor_recordings (
                recording_id, state, chunk_count, total_bytes, stored_bytes,
                encrypted_at_rest, encrypted_chunk_count, created_at_ms, updated_at_ms
            ) VALUES ('after-migration', 'finished', 1, 1, 1, 1, 1, 3, 3)
            ",
            [],
        )
        .expect("add post-migration recording");
        drop(conn);

        let second_launch = VaultStore::with_root_and_launch_id(root, "launch-b");
        let opened = open_test_vault(&second_launch).expect("verify increased row count");
        assert_eq!(opened["migration"]["backupState"], "confirmed-removed");
    }

    #[cfg(feature = "sqlcipher-vault")]
    #[test]
    fn wal_vault_is_checkpointed_and_backed_up_in_delete_mode() {
        let store = temp_store();
        let path = create_legacy_v1_vault(&store, Some("wal"));
        let mode_before = {
            let conn = open_keyed_connection(&path, TEST_PASSPHRASE).expect("open WAL vault");
            query_journal_mode(&conn).expect("read WAL mode")
        };
        assert_eq!(mode_before, "wal");

        let opened = open_test_vault(&store).expect("migrate WAL vault");
        assert_eq!(opened["migration"]["journalModeAtBackup"], "delete");
        let backup = vault_backup_path(&path);
        let backup_conn =
            open_keyed_connection(&backup, TEST_PASSPHRASE).expect("open WAL-safe backup");
        assert_eq!(
            query_journal_mode(&backup_conn).expect("backup journal mode"),
            "delete"
        );
        assert_eq!(
            recording_index_count(&backup_conn).expect("backup row count"),
            1
        );
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
        assert_eq!(opened["schemaVersion"], CURRENT_VAULT_SCHEMA_VERSION);
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
        assert_eq!(opened["schemaVersion"], CURRENT_VAULT_SCHEMA_VERSION);
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
