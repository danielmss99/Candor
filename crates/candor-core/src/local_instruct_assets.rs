use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MANIFEST_SCHEMA_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "instruct-assets.json";
const DEFAULT_CONTEXT_TOKENS: u32 = 4096;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;
const MIN_RUNNER_BYTES: u64 = 100_000;
const MAX_RUNNER_BYTES: u64 = 512 * 1024 * 1024;
const MIN_MODEL_BYTES: u64 = 1024 * 1024;
const MAX_MODEL_BYTES: u64 = 16 * 1024 * 1024 * 1024;
static NEXT_IMPORT_SUFFIX: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub struct InstructAssetError {
    pub code: &'static str,
    pub message: String,
}

impl InstructAssetError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructAssetImportParams {
    pub asset_kind: String,
    pub source_path: String,
    pub expected_sha256: String,
    #[serde(default)]
    pub replace: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ManagedInstructConfig {
    pub binary_path: Option<PathBuf>,
    pub model_path: Option<PathBuf>,
    pub expected_binary_sha256: Option<String>,
    pub expected_model_sha256: Option<String>,
    pub verified_binary_sha256: Option<String>,
    pub verified_model_sha256: Option<String>,
    pub binary_fingerprint_verified: bool,
    pub model_fingerprint_verified: bool,
    pub context_tokens: Option<u32>,
    pub manifest_present: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AssetKind {
    Runner,
    Model,
}

impl AssetKind {
    fn parse(value: &str) -> Result<Self, InstructAssetError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "runner" => Ok(Self::Runner),
            "model" => Ok(Self::Model),
            _ => Err(InstructAssetError::new(
                "INSTRUCT_ASSET_KIND_INVALID",
                "asset kind must be runner or model",
            )),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Runner => "runner",
            Self::Model => "model",
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            Self::Runner => {
                if cfg!(windows) {
                    "llama-cli.exe"
                } else {
                    "llama-cli"
                }
            }
            Self::Model => "instruct-model.gguf",
        }
    }

    fn min_bytes(self) -> u64 {
        match self {
            Self::Runner => MIN_RUNNER_BYTES,
            Self::Model => MIN_MODEL_BYTES,
        }
    }

    fn max_bytes(self) -> u64 {
        match self {
            Self::Runner => MAX_RUNNER_BYTES,
            Self::Model => MAX_MODEL_BYTES,
        }
    }

    fn expected_format(self) -> &'static str {
        match self {
            Self::Model => "gguf",
            Self::Runner if cfg!(windows) => "pe",
            Self::Runner if cfg!(target_os = "macos") => "mach-o",
            Self::Runner => "elf",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetRecord {
    expected_sha256: String,
    actual_sha256: String,
    bytes: u64,
    modified_unix_ms: u64,
    imported_at_unix_ms: u64,
    format: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetManifest {
    schema_version: u32,
    context_tokens: u32,
    runner: Option<AssetRecord>,
    model: Option<AssetRecord>,
}

impl Default for AssetManifest {
    fn default() -> Self {
        Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            context_tokens: DEFAULT_CONTEXT_TOKENS,
            runner: None,
            model: None,
        }
    }
}

#[derive(Clone, Debug)]
struct AssetState {
    configured: bool,
    exists: bool,
    bytes: u64,
    expected_sha256: Option<String>,
    actual_sha256: Option<String>,
    hash_pinned: bool,
    fingerprint_matched: bool,
    format_verified: bool,
    verified: bool,
    failure_code: Option<&'static str>,
    failure_message: Option<&'static str>,
}

pub struct LocalInstructAssetManager {
    root: PathBuf,
}

impl LocalInstructAssetManager {
    pub fn with_root(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn status(&self) -> Value {
        let manifest_result = read_manifest(&self.root);
        let manifest_present = manifest_path(&self.root).is_file();
        let (manifest, manifest_error) = match manifest_result {
            Ok(manifest) => (manifest, None),
            Err(error) => (AssetManifest::default(), Some(error)),
        };
        let runner = asset_state(&self.root, AssetKind::Runner, manifest.runner.as_ref());
        let model = asset_state(&self.root, AssetKind::Model, manifest.model.as_ref());
        let ready = manifest_error.is_none() && runner.verified && model.verified;

        json!({
            "implemented": true,
            "localOnly": true,
            "cloudAi": false,
            "managed": true,
            "manifestPresent": manifest_present,
            "manifestReadable": manifest_error.is_none(),
            "manifestFailureCode": manifest_error.as_ref().map(|error| error.code),
            "manualImportOnly": true,
            "manualImportMethod": "native-picker-core-copy",
            "backgroundDownloads": false,
            "networkAttempted": false,
            "downloadsAttempted": false,
            "expectedSha256Required": true,
            "integrityPolicy": "user-supplied-sha256-verified-before-commit",
            "publisherAuthenticity": "user-supplied-hash",
            "contextTokens": manifest.context_tokens,
            "ready": ready,
            "runner": asset_state_value(AssetKind::Runner, &runner),
            "model": asset_state_value(AssetKind::Model, &model),
            "diskBudget": {
                "runnerMaxBytes": MAX_RUNNER_BYTES,
                "modelMaxBytes": MAX_MODEL_BYTES,
                "combinedMaxBytes": MAX_RUNNER_BYTES + MAX_MODEL_BYTES
            },
            "sourcePathAcceptedFromRenderer": false,
            "managedPathExposed": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    pub fn import_from_path(
        &self,
        params: InstructAssetImportParams,
    ) -> Result<Value, InstructAssetError> {
        let kind = AssetKind::parse(&params.asset_kind)?;
        let expected_sha256 = normalize_sha256(&params.expected_sha256)?;
        let source = normalize_source_path(&params.source_path)?;
        let source_metadata = fs::metadata(&source).map_err(|_| {
            InstructAssetError::new(
                "INSTRUCT_ASSET_SOURCE_UNREADABLE",
                "selected local asset could not be read",
            )
        })?;
        if !source_metadata.is_file() {
            return Err(InstructAssetError::new(
                "INSTRUCT_ASSET_SOURCE_INVALID",
                "selected local asset must be a file",
            ));
        }
        validate_size(kind, source_metadata.len())?;

        fs::create_dir_all(&self.root).map_err(|_| {
            InstructAssetError::new(
                "INSTRUCT_ASSET_ROOT_CREATE_FAILED",
                "managed local instruct directory could not be created",
            )
        })?;
        let target = asset_path(&self.root, kind);
        if target.exists() && !params.replace {
            return Err(InstructAssetError::new(
                "INSTRUCT_ASSET_ALREADY_INSTALLED",
                "managed local instruct asset already exists; enable replace to overwrite it",
            ));
        }
        if canonical_paths_equal(&source, &target) {
            return Err(InstructAssetError::new(
                "INSTRUCT_ASSET_SOURCE_IS_MANAGED_TARGET",
                "selected asset is already the managed local asset",
            ));
        }

        let part = import_part_path(&self.root, kind);
        let copy_result = copy_and_hash(&source, &part, kind.max_bytes());
        let (bytes, actual_sha256) = match copy_result {
            Ok(result) => result,
            Err(error) => {
                let _ = fs::remove_file(&part);
                return Err(error);
            }
        };
        if bytes != source_metadata.len() {
            let _ = fs::remove_file(&part);
            return Err(InstructAssetError::new(
                "INSTRUCT_ASSET_SOURCE_CHANGED",
                "selected local asset changed while it was being imported",
            ));
        }
        validate_size(kind, bytes)?;
        if !actual_sha256.eq_ignore_ascii_case(&expected_sha256) {
            let _ = fs::remove_file(&part);
            return Err(InstructAssetError::new(
                "INSTRUCT_ASSET_HASH_MISMATCH",
                "selected local asset did not match the expected SHA-256",
            ));
        }
        if let Err(error) = validate_format(kind, &part) {
            let _ = fs::remove_file(&part);
            return Err(error);
        }

        let mut manifest = read_manifest(&self.root)?;
        let backup = backup_path(&self.root, kind);
        let had_existing = target.is_file();
        if backup.exists() {
            fs::remove_file(&backup).map_err(|_| {
                InstructAssetError::new(
                    "INSTRUCT_ASSET_BACKUP_CLEAN_FAILED",
                    "stale managed asset backup could not be removed",
                )
            })?;
        }
        if had_existing {
            fs::rename(&target, &backup).map_err(|_| {
                InstructAssetError::new(
                    "INSTRUCT_ASSET_BACKUP_FAILED",
                    "existing managed asset could not be staged for replacement",
                )
            })?;
        }
        if fs::rename(&part, &target).is_err() {
            if had_existing {
                let _ = fs::rename(&backup, &target);
            }
            let _ = fs::remove_file(&part);
            return Err(InstructAssetError::new(
                "INSTRUCT_ASSET_COMMIT_FAILED",
                "verified local asset could not be committed",
            ));
        }
        set_asset_permissions(kind, &target)?;
        let modified_unix_ms = fs::metadata(&target)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(unix_ms)
            .unwrap_or_default();
        let record = AssetRecord {
            expected_sha256: expected_sha256.clone(),
            actual_sha256: actual_sha256.clone(),
            bytes,
            modified_unix_ms,
            imported_at_unix_ms: now_unix_ms(),
            format: kind.expected_format().to_string(),
        };
        match kind {
            AssetKind::Runner => manifest.runner = Some(record),
            AssetKind::Model => manifest.model = Some(record),
        }

        if let Err(error) = write_manifest(&self.root, &manifest) {
            let _ = fs::remove_file(&target);
            if had_existing {
                let _ = fs::rename(&backup, &target);
            }
            return Err(error);
        }
        if had_existing {
            let _ = fs::remove_file(&backup);
        }
        let state = asset_state(
            &self.root,
            kind,
            match kind {
                AssetKind::Runner => manifest.runner.as_ref(),
                AssetKind::Model => manifest.model.as_ref(),
            },
        );

        Ok(json!({
            "imported": true,
            "rejected": false,
            "assetKind": kind.id(),
            "bytes": bytes,
            "format": kind.expected_format(),
            "expectedSha256": expected_sha256,
            "actualSha256": actual_sha256,
            "integrityVerified": state.verified,
            "managed": true,
            "localOnly": true,
            "cloudAi": false,
            "networkAttempted": false,
            "downloadsAttempted": false,
            "sourcePathExposed": false,
            "managedPathExposed": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }
}

pub fn load_runtime_config(root: &Path) -> ManagedInstructConfig {
    let manifest_path = manifest_path(root);
    let Ok(manifest) = read_manifest(root) else {
        return ManagedInstructConfig {
            manifest_present: manifest_path.is_file(),
            ..ManagedInstructConfig::default()
        };
    };
    let runner_state = asset_state(root, AssetKind::Runner, manifest.runner.as_ref());
    let model_state = asset_state(root, AssetKind::Model, manifest.model.as_ref());
    ManagedInstructConfig {
        binary_path: manifest
            .runner
            .as_ref()
            .map(|_| asset_path(root, AssetKind::Runner)),
        model_path: manifest
            .model
            .as_ref()
            .map(|_| asset_path(root, AssetKind::Model)),
        expected_binary_sha256: manifest
            .runner
            .as_ref()
            .map(|record| record.expected_sha256.clone()),
        expected_model_sha256: manifest
            .model
            .as_ref()
            .map(|record| record.expected_sha256.clone()),
        verified_binary_sha256: manifest
            .runner
            .as_ref()
            .map(|record| record.actual_sha256.clone()),
        verified_model_sha256: manifest
            .model
            .as_ref()
            .map(|record| record.actual_sha256.clone()),
        binary_fingerprint_verified: runner_state.verified,
        model_fingerprint_verified: model_state.verified,
        context_tokens: Some(manifest.context_tokens),
        manifest_present: manifest_path.is_file(),
    }
}

fn asset_state(root: &Path, kind: AssetKind, record: Option<&AssetRecord>) -> AssetState {
    let Some(record) = record else {
        return AssetState {
            configured: false,
            exists: false,
            bytes: 0,
            expected_sha256: None,
            actual_sha256: None,
            hash_pinned: false,
            fingerprint_matched: false,
            format_verified: false,
            verified: false,
            failure_code: Some("INSTRUCT_ASSET_NOT_INSTALLED"),
            failure_message: Some("managed local instruct asset is not installed"),
        };
    };
    let path = asset_path(root, kind);
    let Some((bytes, modified_unix_ms)) = file_fingerprint(&path) else {
        return AssetState {
            configured: true,
            exists: false,
            bytes: 0,
            expected_sha256: Some(record.expected_sha256.clone()),
            actual_sha256: Some(record.actual_sha256.clone()),
            hash_pinned: true,
            fingerprint_matched: false,
            format_verified: false,
            verified: false,
            failure_code: Some("INSTRUCT_ASSET_MANAGED_FILE_MISSING"),
            failure_message: Some("managed local instruct asset file is missing"),
        };
    };
    let hash_pinned = record
        .expected_sha256
        .eq_ignore_ascii_case(&record.actual_sha256);
    let fingerprint_matched = bytes == record.bytes && modified_unix_ms == record.modified_unix_ms;
    let format_verified = validate_format(kind, &path).is_ok();
    let verified = hash_pinned && fingerprint_matched && format_verified;
    let (failure_code, failure_message) = if !hash_pinned {
        (
            Some("INSTRUCT_ASSET_MANIFEST_HASH_INVALID"),
            Some("managed asset manifest hash pin is invalid"),
        )
    } else if !fingerprint_matched {
        (
            Some("INSTRUCT_ASSET_FINGERPRINT_CHANGED"),
            Some("managed local instruct asset changed after import"),
        )
    } else if !format_verified {
        (
            Some("INSTRUCT_ASSET_FORMAT_CHANGED"),
            Some("managed local instruct asset format is no longer valid"),
        )
    } else {
        (None, None)
    };
    AssetState {
        configured: true,
        exists: true,
        bytes,
        expected_sha256: Some(record.expected_sha256.clone()),
        actual_sha256: Some(record.actual_sha256.clone()),
        hash_pinned,
        fingerprint_matched,
        format_verified,
        verified,
        failure_code,
        failure_message,
    }
}

fn asset_state_value(kind: AssetKind, state: &AssetState) -> Value {
    json!({
        "assetKind": kind.id(),
        "configured": state.configured,
        "exists": state.exists,
        "bytes": state.bytes,
        "expectedSha256": state.expected_sha256,
        "actualSha256": state.actual_sha256,
        "hashPinned": state.hash_pinned,
        "fingerprintMatched": state.fingerprint_matched,
        "format": kind.expected_format(),
        "formatVerified": state.format_verified,
        "verified": state.verified,
        "failureCode": state.failure_code,
        "failureMessage": state.failure_message,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn normalize_source_path(value: &str) -> Result<PathBuf, InstructAssetError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 32 * 1024 {
        return Err(InstructAssetError::new(
            "INSTRUCT_ASSET_SOURCE_INVALID",
            "selected local asset path is invalid",
        ));
    }
    Ok(PathBuf::from(trimmed))
}

fn normalize_sha256(value: &str) -> Result<String, InstructAssetError> {
    let trimmed = value.trim();
    if trimmed.len() != 64 || !trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(InstructAssetError::new(
            "INSTRUCT_ASSET_SHA256_INVALID",
            "expected SHA-256 must contain exactly 64 hexadecimal characters",
        ));
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn validate_size(kind: AssetKind, bytes: u64) -> Result<(), InstructAssetError> {
    if bytes < kind.min_bytes() {
        return Err(InstructAssetError::new(
            "INSTRUCT_ASSET_TOO_SMALL",
            format!(
                "{} asset is below the {} byte minimum",
                kind.id(),
                kind.min_bytes()
            ),
        ));
    }
    if bytes > kind.max_bytes() {
        return Err(InstructAssetError::new(
            "INSTRUCT_ASSET_DISK_BUDGET_EXCEEDED",
            format!(
                "{} asset exceeds the {} byte managed disk budget",
                kind.id(),
                kind.max_bytes()
            ),
        ));
    }
    Ok(())
}

fn validate_format(kind: AssetKind, path: &Path) -> Result<(), InstructAssetError> {
    let mut file = File::open(path).map_err(|_| {
        InstructAssetError::new(
            "INSTRUCT_ASSET_FORMAT_READ_FAILED",
            "local instruct asset header could not be read",
        )
    })?;
    let mut header = vec![0_u8; 64 * 1024];
    let read = file.read(&mut header).map_err(|_| {
        InstructAssetError::new(
            "INSTRUCT_ASSET_FORMAT_READ_FAILED",
            "local instruct asset header could not be read",
        )
    })?;
    header.truncate(read);
    let valid = match kind {
        AssetKind::Model => header.starts_with(b"GGUF"),
        AssetKind::Runner => runner_header_valid(&header),
    };
    if valid {
        Ok(())
    } else {
        Err(InstructAssetError::new(
            "INSTRUCT_ASSET_FORMAT_INVALID",
            format!(
                "selected {} asset is not a valid {} file",
                kind.id(),
                kind.expected_format()
            ),
        ))
    }
}

#[cfg(windows)]
fn runner_header_valid(header: &[u8]) -> bool {
    if header.len() < 0x40 || !header.starts_with(b"MZ") {
        return false;
    }
    let offset =
        u32::from_le_bytes([header[0x3c], header[0x3d], header[0x3e], header[0x3f]]) as usize;
    offset
        .checked_add(4)
        .is_some_and(|end| end <= header.len() && &header[offset..end] == b"PE\0\0")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn runner_header_valid(header: &[u8]) -> bool {
    header.len() >= 7
        && header.starts_with(b"\x7fELF")
        && matches!(header[4], 1 | 2)
        && matches!(header[5], 1 | 2)
        && header[6] == 1
}

#[cfg(target_os = "macos")]
fn runner_header_valid(header: &[u8]) -> bool {
    if header.len() < 4 {
        return false;
    }
    matches!(
        [header[0], header[1], header[2], header[3]],
        [0xfe, 0xed, 0xfa, 0xce]
            | [0xfe, 0xed, 0xfa, 0xcf]
            | [0xce, 0xfa, 0xed, 0xfe]
            | [0xcf, 0xfa, 0xed, 0xfe]
            | [0xca, 0xfe, 0xba, 0xbe]
            | [0xbe, 0xba, 0xfe, 0xca]
    )
}

#[cfg(not(any(windows, unix)))]
fn runner_header_valid(_header: &[u8]) -> bool {
    false
}

fn copy_and_hash(
    source: &Path,
    target: &Path,
    max_bytes: u64,
) -> Result<(u64, String), InstructAssetError> {
    let mut input = File::open(source).map_err(|_| {
        InstructAssetError::new(
            "INSTRUCT_ASSET_SOURCE_UNREADABLE",
            "selected local asset could not be opened",
        )
    })?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(|_| {
            InstructAssetError::new(
                "INSTRUCT_ASSET_IMPORT_CREATE_FAILED",
                "temporary managed asset could not be created",
            )
        })?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut bytes = 0_u64;
    let mut hasher = Sha256::new();
    loop {
        let read = input.read(&mut buffer).map_err(|_| {
            InstructAssetError::new(
                "INSTRUCT_ASSET_IMPORT_READ_FAILED",
                "selected local asset could not be read during import",
            )
        })?;
        if read == 0 {
            break;
        }
        bytes = bytes.saturating_add(read as u64);
        if bytes > max_bytes {
            return Err(InstructAssetError::new(
                "INSTRUCT_ASSET_DISK_BUDGET_EXCEEDED",
                "selected local asset exceeded its managed disk budget during import",
            ));
        }
        output.write_all(&buffer[..read]).map_err(|_| {
            InstructAssetError::new(
                "INSTRUCT_ASSET_IMPORT_WRITE_FAILED",
                "managed local asset could not be written",
            )
        })?;
        hasher.update(&buffer[..read]);
    }
    output.sync_all().map_err(|_| {
        InstructAssetError::new(
            "INSTRUCT_ASSET_IMPORT_FLUSH_FAILED",
            "managed local asset could not be flushed to disk",
        )
    })?;
    Ok((bytes, format!("{:x}", hasher.finalize())))
}

fn read_manifest(root: &Path) -> Result<AssetManifest, InstructAssetError> {
    let path = manifest_path(root);
    if !path.exists() {
        return Ok(AssetManifest::default());
    }
    let content = fs::read_to_string(path).map_err(|_| {
        InstructAssetError::new(
            "INSTRUCT_ASSET_MANIFEST_READ_FAILED",
            "managed instruct asset manifest could not be read",
        )
    })?;
    let manifest: AssetManifest = serde_json::from_str(&content).map_err(|_| {
        InstructAssetError::new(
            "INSTRUCT_ASSET_MANIFEST_INVALID",
            "managed instruct asset manifest is invalid",
        )
    })?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(InstructAssetError::new(
            "INSTRUCT_ASSET_MANIFEST_VERSION_UNSUPPORTED",
            "managed instruct asset manifest version is unsupported",
        ));
    }
    Ok(manifest)
}

fn write_manifest(root: &Path, manifest: &AssetManifest) -> Result<(), InstructAssetError> {
    fs::create_dir_all(root).map_err(|_| {
        InstructAssetError::new(
            "INSTRUCT_ASSET_ROOT_CREATE_FAILED",
            "managed local instruct directory could not be created",
        )
    })?;
    let content = serde_json::to_vec_pretty(manifest).map_err(|_| {
        InstructAssetError::new(
            "INSTRUCT_ASSET_MANIFEST_SERIALIZE_FAILED",
            "managed instruct asset manifest could not be encoded",
        )
    })?;
    let suffix = NEXT_IMPORT_SUFFIX.fetch_add(1, Ordering::Relaxed);
    let temporary = root.join(format!(
        ".instruct-assets-{}-{suffix}.json.tmp",
        process::id()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| {
            InstructAssetError::new(
                "INSTRUCT_ASSET_MANIFEST_WRITE_FAILED",
                "temporary instruct asset manifest could not be created",
            )
        })?;
    file.write_all(&content).map_err(|_| {
        InstructAssetError::new(
            "INSTRUCT_ASSET_MANIFEST_WRITE_FAILED",
            "managed instruct asset manifest could not be written",
        )
    })?;
    file.sync_all().map_err(|_| {
        InstructAssetError::new(
            "INSTRUCT_ASSET_MANIFEST_FLUSH_FAILED",
            "managed instruct asset manifest could not be flushed",
        )
    })?;

    let target = manifest_path(root);
    let backup = root.join(".instruct-assets.json.backup");
    if backup.exists() {
        fs::remove_file(&backup).map_err(|_| {
            InstructAssetError::new(
                "INSTRUCT_ASSET_MANIFEST_BACKUP_FAILED",
                "stale instruct asset manifest backup could not be removed",
            )
        })?;
    }
    let had_target = target.is_file();
    if had_target {
        fs::rename(&target, &backup).map_err(|_| {
            InstructAssetError::new(
                "INSTRUCT_ASSET_MANIFEST_BACKUP_FAILED",
                "existing instruct asset manifest could not be staged",
            )
        })?;
    }
    if fs::rename(&temporary, &target).is_err() {
        if had_target {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_file(&temporary);
        return Err(InstructAssetError::new(
            "INSTRUCT_ASSET_MANIFEST_COMMIT_FAILED",
            "managed instruct asset manifest could not be committed",
        ));
    }
    if had_target {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

fn asset_path(root: &Path, kind: AssetKind) -> PathBuf {
    root.join(kind.file_name())
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join(MANIFEST_FILE)
}

fn import_part_path(root: &Path, kind: AssetKind) -> PathBuf {
    let suffix = NEXT_IMPORT_SUFFIX.fetch_add(1, Ordering::Relaxed);
    root.join(format!(
        ".{}-{}-{suffix}.import.part",
        kind.id(),
        process::id()
    ))
}

fn backup_path(root: &Path, kind: AssetKind) -> PathBuf {
    root.join(format!(".{}.replace.backup", kind.id()))
}

fn canonical_paths_equal(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn file_fingerprint(path: &Path) -> Option<(u64, u64)> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some((
        metadata.len(),
        metadata.modified().map(unix_ms).unwrap_or_default(),
    ))
}

#[cfg(unix)]
fn set_asset_permissions(kind: AssetKind, path: &Path) -> Result<(), InstructAssetError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if kind == AssetKind::Runner {
        0o700
    } else {
        0o600
    };
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|_| {
        InstructAssetError::new(
            "INSTRUCT_ASSET_PERMISSION_FAILED",
            "managed local instruct asset permissions could not be restricted",
        )
    })
}

#[cfg(not(unix))]
fn set_asset_permissions(_kind: AssetKind, _path: &Path) -> Result<(), InstructAssetError> {
    Ok(())
}

fn unix_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

fn now_unix_ms() -> u64 {
    unix_ms(SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let suffix = NEXT_IMPORT_SUFFIX.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "candor-instruct-assets-{label}-{}-{suffix}",
            process::id()
        ))
    }

    fn sha256_bytes(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn model_fixture() -> Vec<u8> {
        let mut bytes = vec![0_u8; MIN_MODEL_BYTES as usize];
        bytes[..4].copy_from_slice(b"GGUF");
        bytes
    }

    fn runner_fixture() -> Vec<u8> {
        let mut bytes = vec![0_u8; MIN_RUNNER_BYTES as usize];
        #[cfg(windows)]
        {
            bytes[..2].copy_from_slice(b"MZ");
            bytes[0x3c..0x40].copy_from_slice(&(0x80_u32).to_le_bytes());
            bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        }
        #[cfg(target_os = "macos")]
        {
            bytes[..4].copy_from_slice(&[0xfe, 0xed, 0xfa, 0xcf]);
        }
        bytes
    }

    fn import_fixture(
        manager: &LocalInstructAssetManager,
        root: &Path,
        kind: &str,
        bytes: &[u8],
    ) -> Value {
        let source = root.join(format!("source-{kind}"));
        fs::create_dir_all(root).expect("create fixture root");
        fs::write(&source, bytes).expect("write fixture");
        manager
            .import_from_path(InstructAssetImportParams {
                asset_kind: kind.to_string(),
                source_path: source.to_string_lossy().to_string(),
                expected_sha256: sha256_bytes(bytes),
                replace: true,
            })
            .expect("import fixture")
    }

    #[test]
    fn imports_hash_pinned_assets_and_returns_pathless_status() {
        let root = temp_root("pathless");
        let manager = LocalInstructAssetManager::with_root(root.join("managed"));
        let runner = runner_fixture();
        let model = model_fixture();
        let runner_result = import_fixture(&manager, &root, "runner", &runner);
        let model_result = import_fixture(&manager, &root, "model", &model);
        let status = manager.status();
        let serialized = serde_json::to_string(&status).expect("serialize status");

        assert_eq!(runner_result["integrityVerified"], true);
        assert_eq!(model_result["integrityVerified"], true);
        assert_eq!(status["ready"], true);
        assert_eq!(status["runner"]["verified"], true);
        assert_eq!(status["model"]["verified"], true);
        assert_eq!(status["sourcePathAcceptedFromRenderer"], false);
        assert_eq!(status["rawPathExposed"], false);
        assert!(!serialized.contains(&root.to_string_lossy().to_string()));

        let runtime = load_runtime_config(&manager.root);
        assert!(runtime.binary_fingerprint_verified);
        assert!(runtime.model_fingerprint_verified);
        assert_eq!(runtime.context_tokens, Some(DEFAULT_CONTEXT_TOKENS));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn hash_mismatch_is_rejected_without_committing_asset() {
        let root = temp_root("hash-mismatch");
        let manager = LocalInstructAssetManager::with_root(root.join("managed"));
        let source = root.join("bad-model.gguf");
        fs::create_dir_all(&root).expect("create root");
        fs::write(&source, model_fixture()).expect("write model");
        let error = manager
            .import_from_path(InstructAssetImportParams {
                asset_kind: "model".to_string(),
                source_path: source.to_string_lossy().to_string(),
                expected_sha256: "0".repeat(64),
                replace: false,
            })
            .expect_err("hash mismatch must fail");

        assert_eq!(error.code, "INSTRUCT_ASSET_HASH_MISMATCH");
        assert!(!asset_path(&manager.root, AssetKind::Model).exists());
        assert_eq!(manager.status()["model"]["verified"], false);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_model_format_is_rejected_after_hash_verification() {
        let root = temp_root("format");
        let manager = LocalInstructAssetManager::with_root(root.join("managed"));
        let source = root.join("not-gguf.bin");
        let bytes = vec![7_u8; MIN_MODEL_BYTES as usize];
        fs::create_dir_all(&root).expect("create root");
        fs::write(&source, &bytes).expect("write invalid model");
        let error = manager
            .import_from_path(InstructAssetImportParams {
                asset_kind: "model".to_string(),
                source_path: source.to_string_lossy().to_string(),
                expected_sha256: sha256_bytes(&bytes),
                replace: false,
            })
            .expect_err("invalid GGUF must fail");

        assert_eq!(error.code, "INSTRUCT_ASSET_FORMAT_INVALID");
        assert!(!asset_path(&manager.root, AssetKind::Model).exists());
        let _ = fs::remove_dir_all(root);
    }
}
