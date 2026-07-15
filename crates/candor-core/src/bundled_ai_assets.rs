use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const BUNDLE_ROOT_ENV: &str = "CANDOR_AI_BUNDLE_ROOT";
const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_ASSETS: usize = 64;

#[derive(Debug)]
pub struct BundledAssetError {
    pub code: &'static str,
    pub message: String,
}

impl BundledAssetError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedBundledAsset {
    pub path: PathBuf,
    pub sha256: String,
    pub bytes: u64,
    pub model_id: Option<String>,
    pub context_tokens: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundledLanguageConfig {
    pub runtime: VerifiedBundledAsset,
    pub model: VerifiedBundledAsset,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedLanguageIdentity {
    pub model_id: String,
    pub model_sha256: String,
    pub runtime_sha256: String,
}

#[derive(Clone, Debug)]
struct CachedDigest {
    bytes: u64,
    modified_unix_ms: u64,
    sha256: String,
}

#[derive(Clone, Debug)]
pub struct BundledAiAssets {
    root: Option<PathBuf>,
    digest_cache: Arc<Mutex<HashMap<PathBuf, CachedDigest>>>,
}

impl Default for BundledAiAssets {
    fn default() -> Self {
        Self::from_env()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundledManifest {
    manifest_version: u32,
    bundle_version: String,
    release_ready: bool,
    fixture: bool,
    selection_status: String,
    #[serde(default)]
    package_profile: Option<String>,
    repair_policy: String,
    #[serde(default)]
    assets: Vec<BundledAssetRecord>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundledAssetRecord {
    id: String,
    capability: String,
    kind: String,
    engine: String,
    relative_path: String,
    sha256: String,
    bytes: u64,
    license_file: String,
    license_expression: String,
    source_url: String,
    revision: String,
    redistribution_approved: bool,
    required: bool,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    arch: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default)]
    model_card: Option<String>,
    #[serde(default)]
    context_tokens: Option<u32>,
}

#[derive(Clone, Debug)]
struct InspectedAsset {
    record: BundledAssetRecord,
    verified: Option<VerifiedBundledAsset>,
    state: &'static str,
    failure_code: Option<&'static str>,
}

#[derive(Clone, Debug)]
struct BundleSnapshot {
    manifest_version: Option<u32>,
    bundle_version: Option<String>,
    release_ready: bool,
    fixture: bool,
    selection_status: String,
    package_profile: Option<String>,
    state: &'static str,
    failure_code: Option<&'static str>,
    assets: Vec<InspectedAsset>,
}

impl BundleSnapshot {
    fn unavailable(state: &'static str, failure_code: &'static str) -> Self {
        Self {
            manifest_version: None,
            bundle_version: None,
            release_ready: false,
            fixture: false,
            selection_status: state.to_string(),
            package_profile: None,
            state,
            failure_code: Some(failure_code),
            assets: Vec::new(),
        }
    }
}

impl BundledAiAssets {
    pub fn from_env() -> Self {
        let root = env::var(BUNDLE_ROOT_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        Self::with_optional_root(root)
    }

    #[cfg(test)]
    pub fn disabled() -> Self {
        Self::with_optional_root(None)
    }

    #[cfg(test)]
    pub fn with_root(root: PathBuf) -> Self {
        Self::with_optional_root(Some(root))
    }

    fn with_optional_root(root: Option<PathBuf>) -> Self {
        Self {
            root,
            digest_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn status(&self) -> Value {
        let snapshot = self.inspect();
        let speech = capability_status(&snapshot, "speech");
        let language = capability_status(&snapshot, "language");
        let terminology = capability_status(&snapshot, "terminology");
        let terminology_required = snapshot.release_ready;
        let ready = speech["ready"] == true
            && language["ready"] == true
            && (!terminology_required || terminology["ready"] == true);
        let aggregate_state = if ready {
            "ready"
        } else if snapshot.state == "ready" {
            speech["state"]
                .as_str()
                .filter(|state| *state != "ready")
                .or_else(|| language["state"].as_str().filter(|state| *state != "ready"))
                .or_else(|| {
                    terminology_required
                        .then(|| terminology["state"].as_str())
                        .flatten()
                        .filter(|state| *state != "ready")
                })
                .unwrap_or("missing")
        } else {
            snapshot.state
        };
        let repair_required = matches!(
            aggregate_state,
            "missing" | "corrupt" | "incompatible" | "repair-required"
        ) && snapshot.selection_status != "no-default-selected";
        let failure_code = snapshot
            .failure_code
            .map(Value::from)
            .or_else(|| {
                speech
                    .get("failureCode")
                    .filter(|value| !value.is_null())
                    .cloned()
            })
            .or_else(|| {
                language
                    .get("failureCode")
                    .filter(|value| !value.is_null())
                    .cloned()
            })
            .or_else(|| {
                terminology_required
                    .then(|| terminology.get("failureCode"))
                    .flatten()
                    .filter(|value| !value.is_null())
                    .cloned()
            });

        json!({
            "implemented": true,
            "localOnly": true,
            "cloudAi": false,
            "manifestVersion": snapshot.manifest_version,
            "bundleVersion": snapshot.bundle_version,
            "releaseReady": snapshot.release_ready,
            "fixture": snapshot.fixture,
            "selectionStatus": snapshot.selection_status,
            "packageProfile": snapshot.package_profile,
            "state": aggregate_state,
            "ready": ready,
            "repairRequired": repair_required,
            "repairPolicy": "signed-installer-only",
            "repairAction": if repair_required { "reinstall-candor" } else { "none" },
            "failureCode": failure_code,
            "speech": speech,
            "language": language,
            "terminology": terminology,
            "requiredDownload": false,
            "backgroundDownloads": false,
            "runtimePathAcceptedFromRenderer": false,
            "rawPathExposed": false,
            "hashExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    pub fn speech_model(
        &self,
        model_id: &str,
    ) -> Result<Option<VerifiedBundledAsset>, BundledAssetError> {
        self.verified_asset("speech", "model", Some(model_id))
    }

    pub fn language_config(&self) -> Result<Option<BundledLanguageConfig>, BundledAssetError> {
        let runtime = self.verified_asset("language", "runtime", None)?;
        let model = self.verified_asset("language", "model", None)?;
        match (runtime, model) {
            (Some(runtime), Some(model)) => Ok(Some(BundledLanguageConfig { runtime, model })),
            (None, None) => Ok(None),
            _ => Err(BundledAssetError::new(
                "BUNDLED_AI_LANGUAGE_INCOMPLETE",
                "packaged language tools are incomplete; reinstall Candor to restore local summaries",
            )),
        }
    }

    pub fn required_language_identity(
        &self,
    ) -> Result<VerifiedLanguageIdentity, BundledAssetError> {
        let config = self.language_config()?.ok_or_else(|| {
            BundledAssetError::new(
                "BUNDLED_AI_LANGUAGE_IDENTITY_MISSING",
                "the packaged language model identity is unavailable; reinstall Candor to restore local summaries",
            )
        })?;
        let model_id = config
            .model
            .model_id
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                BundledAssetError::new(
                    "BUNDLED_AI_MODEL_ID_MISSING",
                    "the packaged language model has no verified identifier; reinstall Candor to restore local summaries",
                )
            })?;
        Ok(VerifiedLanguageIdentity {
            model_id,
            model_sha256: config.model.sha256,
            runtime_sha256: config.runtime.sha256,
        })
    }

    pub fn general_dictionary(&self) -> Result<Option<VerifiedBundledAsset>, BundledAssetError> {
        self.verified_asset("terminology", "data", None)
    }

    pub fn dictionary_publisher_key(
        &self,
    ) -> Result<Option<VerifiedBundledAsset>, BundledAssetError> {
        self.verified_asset("terminology", "public-key", None)
    }

    fn verified_asset(
        &self,
        capability: &str,
        kind: &str,
        model_id: Option<&str>,
    ) -> Result<Option<VerifiedBundledAsset>, BundledAssetError> {
        let snapshot = self.inspect();
        let matching = snapshot.assets.iter().find(|asset| {
            asset.record.capability == capability
                && asset.record.kind == kind
                && model_id.is_none_or(|id| asset.record.model_id.as_deref() == Some(id))
        });
        let Some(asset) = matching else {
            return Ok(None);
        };
        if let Some(verified) = &asset.verified {
            return Ok(Some(verified.clone()));
        }
        Err(BundledAssetError::new(
            asset.failure_code.unwrap_or("BUNDLED_AI_ASSET_UNAVAILABLE"),
            "packaged local AI files are unavailable; reinstall Candor to restore this feature",
        ))
    }

    fn inspect(&self) -> BundleSnapshot {
        let Some(root) = self.root.as_ref() else {
            return BundleSnapshot::unavailable("disabled", "BUNDLED_AI_ROOT_DISABLED");
        };
        if !root.is_absolute() {
            return BundleSnapshot::unavailable("corrupt", "BUNDLED_AI_ROOT_INVALID");
        }
        let manifest_path = root.join(MANIFEST_FILE);
        let Ok(metadata) = fs::symlink_metadata(&manifest_path) else {
            return BundleSnapshot::unavailable("missing", "BUNDLED_AI_MANIFEST_MISSING");
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() == 0
            || metadata.len() > MAX_MANIFEST_BYTES
        {
            return BundleSnapshot::unavailable("corrupt", "BUNDLED_AI_MANIFEST_INVALID");
        }
        let Ok(bytes) = fs::read(&manifest_path) else {
            return BundleSnapshot::unavailable("corrupt", "BUNDLED_AI_MANIFEST_UNREADABLE");
        };
        let Ok(manifest) = serde_json::from_slice::<BundledManifest>(&bytes) else {
            return BundleSnapshot::unavailable("corrupt", "BUNDLED_AI_MANIFEST_INVALID");
        };
        if manifest.manifest_version != MANIFEST_VERSION
            || manifest.bundle_version.trim().is_empty()
            || manifest.selection_status.trim().is_empty()
            || manifest
                .package_profile
                .as_deref()
                .is_some_and(|value| value.trim().is_empty())
            || manifest.repair_policy != "signed-installer-only"
            || manifest.assets.len() > MAX_ASSETS
            || (manifest.fixture && manifest.release_ready)
        {
            return BundleSnapshot::unavailable("corrupt", "BUNDLED_AI_MANIFEST_INVALID");
        }
        if manifest.assets.is_empty() {
            return BundleSnapshot {
                manifest_version: Some(manifest.manifest_version),
                bundle_version: Some(manifest.bundle_version),
                release_ready: manifest.release_ready,
                fixture: manifest.fixture,
                selection_status: manifest.selection_status,
                package_profile: manifest.package_profile,
                state: if manifest.release_ready {
                    "missing"
                } else {
                    "no-default-selected"
                },
                failure_code: if manifest.release_ready {
                    Some("BUNDLED_AI_ASSETS_MISSING")
                } else {
                    Some("BUNDLED_AI_NO_DEFAULT_SELECTED")
                },
                assets: Vec::new(),
            };
        }

        let Ok(canonical_root) = fs::canonicalize(root) else {
            return BundleSnapshot::unavailable("missing", "BUNDLED_AI_ROOT_MISSING");
        };
        let mut ids = HashSet::new();
        let mut selectors = HashSet::new();
        let mut assets = Vec::new();
        let mut manifest_invalid = false;
        for record in &manifest.assets {
            if !ids.insert(record.id.clone()) || !record_is_valid(record) {
                manifest_invalid = true;
                continue;
            }
            if !host_matches(record) {
                continue;
            }
            let selector = if record.kind == "model" {
                format!(
                    "{}:{}:{}",
                    record.capability,
                    record.kind,
                    record.model_id.as_deref().unwrap_or_default()
                )
            } else if record.kind == "library" {
                format!("{}:{}:{}", record.capability, record.kind, record.id)
            } else {
                format!("{}:{}", record.capability, record.kind)
            };
            if !selectors.insert(selector) {
                manifest_invalid = true;
                continue;
            }
            assets.push(self.inspect_asset(root, &canonical_root, record.clone()));
        }
        if manifest_invalid {
            return BundleSnapshot::unavailable("corrupt", "BUNDLED_AI_MANIFEST_INVALID");
        }
        if assets.is_empty() {
            return BundleSnapshot {
                manifest_version: Some(manifest.manifest_version),
                bundle_version: Some(manifest.bundle_version),
                release_ready: manifest.release_ready,
                fixture: manifest.fixture,
                selection_status: manifest.selection_status,
                package_profile: manifest.package_profile,
                state: "incompatible",
                failure_code: Some("BUNDLED_AI_PLATFORM_UNSUPPORTED"),
                assets,
            };
        }
        let failure = assets.iter().find(|asset| asset.verified.is_none());
        let state = failure.map_or("ready", |asset| asset.state);
        let failure_code = failure.and_then(|asset| asset.failure_code);
        BundleSnapshot {
            manifest_version: Some(manifest.manifest_version),
            bundle_version: Some(manifest.bundle_version),
            release_ready: manifest.release_ready,
            fixture: manifest.fixture,
            selection_status: manifest.selection_status,
            package_profile: manifest.package_profile,
            state,
            failure_code,
            assets,
        }
    }

    fn inspect_asset(
        &self,
        root: &Path,
        canonical_root: &Path,
        record: BundledAssetRecord,
    ) -> InspectedAsset {
        let Some(path) = contained_regular_file(root, canonical_root, &record.relative_path) else {
            return inspected_failure(record, "missing", "BUNDLED_AI_ASSET_MISSING");
        };
        if contained_regular_file(root, canonical_root, &record.license_file).is_none()
            || record.kind == "model"
                && record
                    .model_card
                    .as_deref()
                    .and_then(|value| contained_regular_file(root, canonical_root, value))
                    .is_none()
        {
            return inspected_failure(record, "repair-required", "BUNDLED_AI_NOTICE_MISSING");
        }
        let Ok(metadata) = fs::metadata(&path) else {
            return inspected_failure(record, "missing", "BUNDLED_AI_ASSET_MISSING");
        };
        if record.kind == "runtime" && !runtime_is_executable(&path, &metadata) {
            return inspected_failure(record, "incompatible", "BUNDLED_AI_RUNTIME_NOT_EXECUTABLE");
        }
        if metadata.len() != record.bytes {
            return inspected_failure(record, "corrupt", "BUNDLED_AI_ASSET_SIZE_MISMATCH");
        }
        let modified_unix_ms = metadata.modified().map(unix_ms).unwrap_or_default();
        let digest = match self.cached_sha256(&path, metadata.len(), modified_unix_ms) {
            Ok(value) => value,
            Err(_) => return inspected_failure(record, "corrupt", "BUNDLED_AI_ASSET_UNREADABLE"),
        };
        if !digest.eq_ignore_ascii_case(&record.sha256) {
            return inspected_failure(record, "corrupt", "BUNDLED_AI_ASSET_HASH_MISMATCH");
        }
        let verified = VerifiedBundledAsset {
            path,
            sha256: digest,
            bytes: record.bytes,
            model_id: record.model_id.clone(),
            context_tokens: record.context_tokens,
        };
        InspectedAsset {
            record,
            verified: Some(verified),
            state: "ready",
            failure_code: None,
        }
    }

    fn cached_sha256(
        &self,
        path: &Path,
        bytes: u64,
        modified_unix_ms: u64,
    ) -> Result<String, BundledAssetError> {
        if let Ok(cache) = self.digest_cache.lock() {
            if let Some(cached) = cache.get(path) {
                if cached.bytes == bytes && cached.modified_unix_ms == modified_unix_ms {
                    return Ok(cached.sha256.clone());
                }
            }
        }
        let digest = sha256_file(path)?;
        if let Ok(mut cache) = self.digest_cache.lock() {
            cache.insert(
                path.to_path_buf(),
                CachedDigest {
                    bytes,
                    modified_unix_ms,
                    sha256: digest.clone(),
                },
            );
        }
        Ok(digest)
    }
}

fn capability_status(snapshot: &BundleSnapshot, capability: &str) -> Value {
    let assets = snapshot
        .assets
        .iter()
        .filter(|asset| asset.record.capability == capability)
        .collect::<Vec<_>>();
    if assets.is_empty() {
        let state = if snapshot.state == "ready" {
            "missing"
        } else {
            snapshot.state
        };
        return json!({
            "state": state,
            "ready": false,
            "available": false,
            "requiredAssets": 0,
            "verifiedAssets": 0,
            "modelId": Value::Null,
            "failureCode": snapshot.failure_code
        });
    }
    let required_assets = assets.iter().filter(|asset| asset.record.required).count();
    let verified_assets = assets
        .iter()
        .filter(|asset| asset.verified.is_some())
        .count();
    let failure = assets.iter().find(|asset| asset.verified.is_none());
    let ready = failure.is_none()
        && required_assets > 0
        && assets
            .iter()
            .filter(|asset| asset.record.required)
            .all(|asset| asset.verified.is_some());
    let model_id = assets
        .iter()
        .find_map(|asset| asset.record.model_id.clone());
    json!({
        "state": if ready { "ready" } else { failure.map_or("missing", |asset| asset.state) },
        "ready": ready,
        "available": true,
        "requiredAssets": required_assets,
        "verifiedAssets": verified_assets,
        "modelId": model_id,
        "failureCode": failure.and_then(|asset| asset.failure_code)
    })
}

fn inspected_failure(
    record: BundledAssetRecord,
    state: &'static str,
    failure_code: &'static str,
) -> InspectedAsset {
    InspectedAsset {
        record,
        verified: None,
        state,
        failure_code: Some(failure_code),
    }
}

fn host_matches(record: &BundledAssetRecord) -> bool {
    let platform_matches =
        record
            .platform
            .as_deref()
            .is_none_or(|platform| match env::consts::OS {
                "windows" => matches!(platform, "windows" | "win32"),
                "macos" => matches!(platform, "macos" | "darwin"),
                current => platform == current,
            });
    let arch_matches = record
        .arch
        .as_deref()
        .is_none_or(|arch| match env::consts::ARCH {
            "x86_64" => matches!(arch, "x86_64" | "x64"),
            "aarch64" => matches!(arch, "aarch64" | "arm64"),
            current => arch == current,
        });
    platform_matches && arch_matches
}

fn record_is_valid(record: &BundledAssetRecord) -> bool {
    valid_id(&record.id)
        && matches!(
            record.capability.as_str(),
            "speech" | "language" | "terminology"
        )
        && matches!(
            record.kind.as_str(),
            "runtime" | "library" | "model" | "data" | "public-key"
        )
        && !record.engine.trim().is_empty()
        && valid_relative_path(&record.relative_path)
        && valid_sha256(&record.sha256)
        && record.bytes > 0
        && valid_relative_path(&record.license_file)
        && !record.license_expression.trim().is_empty()
        && record.source_url.starts_with("https://")
        && !record.revision.trim().is_empty()
        && record.redistribution_approved
        && record
            .platform
            .as_deref()
            .is_none_or(|value| !value.trim().is_empty())
        && record
            .arch
            .as_deref()
            .is_none_or(|value| !value.trim().is_empty())
        && (record.kind != "model" && record.model_id.is_none() && record.model_card.is_none()
            || record.kind == "model"
                && record
                    .model_id
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
                && record
                    .model_card
                    .as_deref()
                    .is_some_and(valid_relative_path))
        && record.context_tokens.is_none_or(|value| value > 0)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        && value.bytes().any(|byte| byte != b'0')
}

fn valid_relative_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 240 {
        return false;
    }
    if value.contains('\\')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
    {
        return false;
    }
    let path = Path::new(value);
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn contained_regular_file(root: &Path, canonical_root: &Path, relative: &str) -> Option<PathBuf> {
    if !valid_relative_path(relative) {
        return None;
    }
    let candidate = root.join(relative);
    let link_metadata = fs::symlink_metadata(&candidate).ok()?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return None;
    }
    let canonical = fs::canonicalize(candidate).ok()?;
    canonical.starts_with(canonical_root).then_some(canonical)
}

#[cfg(windows)]
fn runtime_is_executable(path: &Path, _metadata: &fs::Metadata) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}

#[cfg(unix)]
fn runtime_is_executable(_path: &Path, metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(any(windows, unix)))]
fn runtime_is_executable(_path: &Path, _metadata: &fs::Metadata) -> bool {
    true
}

fn sha256_file(path: &Path) -> Result<String, BundledAssetError> {
    let mut file = File::open(path).map_err(|_| {
        BundledAssetError::new(
            "BUNDLED_AI_ASSET_UNREADABLE",
            "packaged local AI file could not be read",
        )
    })?;
    let mut hasher = Sha256::new();
    // Keep the verification buffer off the Windows main-thread stack. The
    // default executable stack can be smaller than this buffer.
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| {
            BundledAssetError::new(
                "BUNDLED_AI_ASSET_UNREADABLE",
                "packaged local AI file could not be read",
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn unix_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process;

    fn temp_root(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        env::temp_dir().join(format!(
            "candor-bundled-ai-{label}-{}-{stamp}",
            process::id()
        ))
    }

    fn write_manifest(root: &Path, manifest: Value) {
        fs::create_dir_all(root.join("notices")).expect("create notices");
        fs::write(root.join("notices/license.txt"), b"fixture license\n").expect("write license");
        fs::write(root.join("notices/model.md"), b"# Fixture model\n").expect("write model card");
        fs::write(
            root.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).expect("serialize manifest"),
        )
        .expect("write manifest");
    }

    fn asset(root: &Path, id: &str, capability: &str, kind: &str, model_id: Option<&str>) -> Value {
        let extension = if kind == "runtime" && cfg!(windows) {
            "exe"
        } else {
            "bin"
        };
        let relative = format!("assets/{id}.{extension}");
        fs::create_dir_all(root.join("assets")).expect("create assets");
        let content = format!("fixture:{id}");
        let asset_path = root.join(&relative);
        fs::write(&asset_path, content.as_bytes()).expect("write asset");
        #[cfg(unix)]
        if kind == "runtime" {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&asset_path, fs::Permissions::from_mode(0o755))
                .expect("make runtime fixture executable");
        }
        json!({
            "id": id,
            "capability": capability,
            "kind": kind,
            "engine": if capability == "speech" { "whisper.cpp" } else { "llama.cpp" },
            "relativePath": relative,
            "sha256": format!("{:x}", Sha256::digest(content.as_bytes())),
            "bytes": content.len(),
            "licenseFile": "notices/license.txt",
            "licenseExpression": "MIT",
            "sourceUrl": "https://example.invalid/fixture",
            "revision": "fixture",
            "redistributionApproved": true,
            "required": true,
            "platform": env::consts::OS,
            "arch": env::consts::ARCH,
            "modelId": model_id,
            "modelCard": if kind == "model" { Some("notices/model.md") } else { None::<&str> },
            "contextTokens": if capability == "language" && kind == "model" { Some(2048) } else { None::<u32> }
        })
    }

    #[test]
    fn non_ready_empty_manifest_reports_no_default_without_paths() {
        let root = temp_root("empty");
        write_manifest(
            &root,
            json!({
                "manifestVersion": 1,
                "bundleVersion": "source-interface-1",
                "releaseReady": false,
                "fixture": false,
                "selectionStatus": "no-default-selected",
                "repairPolicy": "signed-installer-only",
                "assets": []
            }),
        );
        let status = BundledAiAssets::with_root(root.clone()).status();
        let serialized = serde_json::to_string(&status).expect("serialize status");
        assert_eq!(status["state"], "no-default-selected");
        assert_eq!(status["ready"], false);
        assert_eq!(status["repairRequired"], false);
        assert_eq!(status["rawPathExposed"], false);
        assert!(!serialized.contains(root.to_string_lossy().as_ref()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verified_fixture_resolves_speech_and_language_without_claiming_release_ready() {
        let root = temp_root("ready-fixture");
        let assets = vec![
            asset(&root, "speech-model", "speech", "model", Some("base.en")),
            asset(&root, "language-runtime", "language", "runtime", None),
            asset(
                &root,
                "language-model",
                "language",
                "model",
                Some("fixture-llm"),
            ),
        ];
        write_manifest(
            &root,
            json!({
                "manifestVersion": 1,
                "bundleVersion": "fixture-1",
                "releaseReady": false,
                "fixture": true,
                "selectionStatus": "fixture-selected",
                "repairPolicy": "signed-installer-only",
                "assets": assets.clone()
            }),
        );
        let bundle = BundledAiAssets::with_root(root.clone());
        let status = bundle.status();
        assert_eq!(status["state"], "ready");
        assert_eq!(status["fixture"], true);
        assert_eq!(status["releaseReady"], false);
        assert_eq!(status["speech"]["ready"], true);
        assert_eq!(status["language"]["ready"], true);
        assert!(bundle
            .speech_model("base.en")
            .expect("speech result")
            .is_some());
        assert!(bundle.language_config().expect("language result").is_some());
        let identity = bundle
            .required_language_identity()
            .expect("verified language identity");
        assert_eq!(identity.model_id, "fixture-llm");
        assert_eq!(identity.model_sha256.len(), 64);
        assert_eq!(identity.runtime_sha256.len(), 64);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verified_bundle_accepts_multiple_pinned_runtime_libraries() {
        let root = temp_root("runtime-libraries");
        let assets = vec![
            asset(&root, "speech-model", "speech", "model", Some("base.en")),
            asset(&root, "language-runtime", "language", "runtime", None),
            asset(&root, "language-library-core", "language", "library", None),
            asset(&root, "language-library-cpu", "language", "library", None),
            asset(
                &root,
                "language-model",
                "language",
                "model",
                Some("fixture-llm"),
            ),
        ];
        write_manifest(
            &root,
            json!({
                "manifestVersion": 1,
                "bundleVersion": "runtime-libraries-1",
                "releaseReady": false,
                "fixture": true,
                "selectionStatus": "fixture-selected",
                "repairPolicy": "signed-installer-only",
                "assets": assets
            }),
        );

        let status = BundledAiAssets::with_root(root.clone()).status();
        assert_eq!(status["state"], "ready");
        assert_eq!(status["language"]["ready"], true);
        assert_eq!(status["language"]["verifiedAssets"], 4);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn release_bundle_requires_general_dictionary_and_publisher_key() {
        let root = temp_root("release-terminology");
        let mut assets = vec![
            asset(
                &root,
                "speech-model",
                "speech",
                "model",
                Some("large-v3-turbo"),
            ),
            asset(&root, "language-runtime", "language", "runtime", None),
            asset(
                &root,
                "language-model",
                "language",
                "model",
                Some("qwen3-4b-q4-k-m"),
            ),
        ];
        write_manifest(
            &root,
            json!({
                "manifestVersion": 1,
                "bundleVersion": "release-1",
                "releaseReady": true,
                "fixture": false,
                "selectionStatus": "release-selected",
                "repairPolicy": "signed-installer-only",
                "assets": assets.clone()
            }),
        );
        let bundle = BundledAiAssets::with_root(root.clone());
        let incomplete = bundle.status();
        assert_eq!(incomplete["ready"], false);
        assert_eq!(incomplete["state"], "missing");
        assert_eq!(incomplete["terminology"]["ready"], false);

        assets.push(asset(
            &root,
            "general-dictionary",
            "terminology",
            "data",
            None,
        ));
        assets.push(asset(
            &root,
            "dictionary-publisher-key",
            "terminology",
            "public-key",
            None,
        ));
        write_manifest(
            &root,
            json!({
                "manifestVersion": 1,
                "bundleVersion": "release-1",
                "releaseReady": true,
                "fixture": false,
                "selectionStatus": "release-selected",
                "repairPolicy": "signed-installer-only",
                "assets": assets
            }),
        );
        let complete = bundle.status();
        assert_eq!(complete["ready"], true);
        assert_eq!(complete["state"], "ready");
        assert_eq!(complete["terminology"]["ready"], true);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn partial_release_bundle_reports_missing_and_requires_repair() {
        let root = temp_root("partial-release");
        let speech = asset(&root, "speech-model", "speech", "model", Some("base.en"));
        write_manifest(
            &root,
            json!({
                "manifestVersion": 1,
                "bundleVersion": "partial-1",
                "releaseReady": true,
                "fixture": false,
                "selectionStatus": "release-selected",
                "repairPolicy": "signed-installer-only",
                "assets": [speech]
            }),
        );
        let status = BundledAiAssets::with_root(root.clone()).status();
        assert_eq!(status["state"], "missing");
        assert_eq!(status["ready"], false);
        assert_eq!(status["repairRequired"], true);
        assert_eq!(status["speech"]["ready"], true);
        assert_eq!(status["language"]["ready"], false);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn hash_mismatch_is_pathless_and_requires_repair() {
        let root = temp_root("hash-mismatch");
        let mut speech = asset(&root, "speech-model", "speech", "model", Some("base.en"));
        speech["sha256"] = Value::String("f".repeat(64));
        write_manifest(
            &root,
            json!({
                "manifestVersion": 1,
                "bundleVersion": "broken-1",
                "releaseReady": true,
                "fixture": false,
                "selectionStatus": "selected",
                "repairPolicy": "signed-installer-only",
                "assets": [speech]
            }),
        );
        let bundle = BundledAiAssets::with_root(root.clone());
        let status = bundle.status();
        let serialized = serde_json::to_string(&status).expect("serialize status");
        assert_eq!(status["state"], "corrupt");
        assert_eq!(status["repairRequired"], true);
        assert_eq!(
            status["speech"]["failureCode"],
            "BUNDLED_AI_ASSET_HASH_MISMATCH"
        );
        assert!(bundle.speech_model("base.en").is_err());
        assert!(!serialized.contains(root.to_string_lossy().as_ref()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn traversal_and_release_ready_fixture_are_rejected() {
        let root = temp_root("manifest-guards");
        let mut speech = asset(&root, "speech-model", "speech", "model", Some("base.en"));
        speech["relativePath"] = Value::String("../outside.bin".to_string());
        write_manifest(
            &root,
            json!({
                "manifestVersion": 1,
                "bundleVersion": "fixture-1",
                "releaseReady": true,
                "fixture": true,
                "selectionStatus": "fixture-selected",
                "repairPolicy": "signed-installer-only",
                "assets": [speech]
            }),
        );
        let status = BundledAiAssets::with_root(root.clone()).status();
        assert_eq!(status["state"], "corrupt");
        assert_eq!(status["failureCode"], "BUNDLED_AI_MANIFEST_INVALID");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unsafe_or_ambiguous_packaged_assets_are_rejected() {
        let root = temp_root("portable-path-guards");
        let mut speech = asset(&root, "speech-model", "speech", "model", Some("base.en"));
        speech["relativePath"] = Value::String("assets/speech-model.bin:stream".to_string());
        write_manifest(
            &root,
            json!({
                "manifestVersion": 1,
                "bundleVersion": "guard-1",
                "releaseReady": false,
                "fixture": false,
                "selectionStatus": "candidate",
                "repairPolicy": "signed-installer-only",
                "assets": [speech]
            }),
        );
        let bundle = BundledAiAssets::with_root(root.clone());
        assert_eq!(
            bundle.status()["failureCode"],
            "BUNDLED_AI_MANIFEST_INVALID"
        );

        let mut unapproved = asset(
            &root,
            "speech-model-unapproved",
            "speech",
            "model",
            Some("base.en"),
        );
        unapproved["redistributionApproved"] = Value::Bool(false);
        write_manifest(
            &root,
            json!({
                "manifestVersion": 1,
                "bundleVersion": "guard-2",
                "releaseReady": false,
                "fixture": false,
                "selectionStatus": "candidate",
                "repairPolicy": "signed-installer-only",
                "assets": [unapproved]
            }),
        );
        assert_eq!(
            bundle.status()["failureCode"],
            "BUNDLED_AI_MANIFEST_INVALID"
        );

        let language_one = asset(
            &root,
            "language-model-one",
            "language",
            "model",
            Some("language-one"),
        );
        let language_two = asset(
            &root,
            "language-model-two",
            "language",
            "model",
            Some("language-one"),
        );
        write_manifest(
            &root,
            json!({
                "manifestVersion": 1,
                "bundleVersion": "guard-3",
                "releaseReady": false,
                "fixture": false,
                "selectionStatus": "candidate",
                "repairPolicy": "signed-installer-only",
                "assets": [language_one, language_two]
            }),
        );
        assert_eq!(
            bundle.status()["failureCode"],
            "BUNDLED_AI_MANIFEST_INVALID"
        );
        let _ = fs::remove_dir_all(root);
    }
}
