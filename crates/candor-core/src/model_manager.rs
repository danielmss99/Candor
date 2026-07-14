use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::bundled_ai_assets::{BundledAiAssets, VerifiedBundledAsset};
use crate::recording_store::RecordingStore;

const DEFAULT_MODEL_ID: &str = "base.en";
const SYNTHETIC_PROOF_BYTES: &[u8] = b"candor synthetic model proof, not a real whisper model\n";
const MAX_MODEL_IMPORT_CHUNK_BYTES: usize = 512 * 1024;
static NEXT_MODEL_IMPORT_ID_SUFFIX: AtomicU64 = AtomicU64::new(1);
const HASH_TINY_EN: &str = match option_env!("CANDOR_SHA256_TINY_EN") {
    Some(value) => value,
    None => "921E4CF8686FDD993DCD081A5DA5B6C365BFDE1162E72B08D75AC75289920B1F",
};
const HASH_TINY: &str = match option_env!("CANDOR_SHA256_TINY") {
    Some(value) => value,
    None => "BE07E048E1E599AD46341C8D2A135645097A538221678B7ACDD1B1919C6E1B21",
};
const HASH_BASE_EN: &str = match option_env!("CANDOR_SHA256_BASE_EN") {
    Some(value) => value,
    None => "A03779C86DF3323075F5E796CB2CE5029F00EC8869EEE3FDFB897AFE36C6D002",
};
const HASH_SMALL_EN: &str = match option_env!("CANDOR_SHA256_SMALL_EN") {
    Some(value) => value,
    None => "C6138D6D58ECC8322097E0F987C32F1BE8BB0A18532A3F88F734D1BBF9C41E5D",
};
const HASH_SMALL_EN_TDRZ: &str = match option_env!("CANDOR_SHA256_SMALL_EN_TDRZ") {
    Some(value) => value,
    None => "CEAC3EC06D1D98EF71AEC665283564631055FD6129B79D8E1BE4F9CC33CC54B4",
};
const HASH_MEDIUM_EN: &str = match option_env!("CANDOR_SHA256_MEDIUM_EN") {
    Some(value) => value,
    None => "CC37E93478338EC7700281A7AC30A10128929EB8F427DDA2E865FAA8F6DA4356",
};
const HASH_BASE: &str = match option_env!("CANDOR_SHA256_BASE") {
    Some(value) => value,
    None => "60ED5BC3DD14EEA856493D334349B405782DDCAF0028D4B5DF4088345FBA2EFE",
};
const HASH_SMALL: &str = match option_env!("CANDOR_SHA256_SMALL") {
    Some(value) => value,
    None => "1BE3A9B2063867B937E64E2EC7483364A79917E157FA98C5D94B5C1FFFEA987B",
};
const HASH_MEDIUM: &str = match option_env!("CANDOR_SHA256_MEDIUM") {
    Some(value) => value,
    None => "6C14D5ADEE5F86394037B4E4E8B59F1673B6CEE10E3CF0B11BBDBEE79C156208",
};
const HASH_LARGE_V3_TURBO: &str = match option_env!("CANDOR_SHA256_LARGE_V3_TURBO") {
    Some(value) => value,
    None => "1FC70F774D38EB169993AC391EEA357EF47C88757EF72EE5943879B7E8E2BC69",
};
const HASH_LARGE_V3: &str = match option_env!("CANDOR_SHA256_LARGE_V3") {
    Some(value) => value,
    None => "64D182B440B98D5203C4F9BD541544D84C605196C4F7B845DFA11FB23594D1E2",
};

const MODEL_SPECS: [ModelSpec; 11] = [
    ModelSpec {
        id: "tiny.en",
        expected_sha256: HASH_TINY_EN,
        language: "english",
        role: "fast-captions",
    },
    ModelSpec {
        id: "tiny",
        expected_sha256: HASH_TINY,
        language: "multilingual",
        role: "fast-captions",
    },
    ModelSpec {
        id: "base.en",
        expected_sha256: HASH_BASE_EN,
        language: "english",
        role: "default-transcription",
    },
    ModelSpec {
        id: "small.en",
        expected_sha256: HASH_SMALL_EN,
        language: "english",
        role: "higher-quality-transcription",
    },
    ModelSpec {
        id: "small.en-tdrz",
        expected_sha256: HASH_SMALL_EN_TDRZ,
        language: "english",
        role: "deferred-diarization",
    },
    ModelSpec {
        id: "medium.en",
        expected_sha256: HASH_MEDIUM_EN,
        language: "english",
        role: "higher-quality-transcription",
    },
    ModelSpec {
        id: "base",
        expected_sha256: HASH_BASE,
        language: "multilingual",
        role: "default-transcription",
    },
    ModelSpec {
        id: "small",
        expected_sha256: HASH_SMALL,
        language: "multilingual",
        role: "higher-quality-transcription",
    },
    ModelSpec {
        id: "medium",
        expected_sha256: HASH_MEDIUM,
        language: "multilingual",
        role: "higher-quality-transcription",
    },
    ModelSpec {
        id: "large-v3-turbo",
        expected_sha256: HASH_LARGE_V3_TURBO,
        language: "multilingual",
        role: "large-local-transcription",
    },
    ModelSpec {
        id: "large-v3",
        expected_sha256: HASH_LARGE_V3,
        language: "multilingual",
        role: "large-local-transcription",
    },
];

#[derive(Copy, Clone, Debug)]
pub(crate) struct ModelSpec {
    pub(crate) id: &'static str,
    pub(crate) expected_sha256: &'static str,
    pub(crate) language: &'static str,
    pub(crate) role: &'static str,
}

#[derive(Debug)]
pub struct ModelManagerError {
    pub code: &'static str,
    pub message: String,
}

impl ModelManagerError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelIdParams {
    #[serde(default)]
    pub model_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProofParams {
    #[serde(default)]
    pub model_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImportStartParams {
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub expected_bytes: Option<u64>,
    #[serde(default)]
    pub replace: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImportChunkParams {
    pub import_id: String,
    pub data_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImportFinishParams {
    pub import_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImportAbortParams {
    pub import_id: String,
}

#[cfg(feature = "local-whisper")]
#[derive(Debug)]
pub(crate) struct VerifiedModel {
    pub(crate) model_id: String,
    pub(crate) path: PathBuf,
    pub(crate) sha256: String,
    pub(crate) bytes: u64,
    pub(crate) modified_unix_ms: u64,
    pub(crate) source: &'static str,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelVerifyCache {
    model_id: String,
    expected_sha256: String,
    actual_sha256: String,
    size: u64,
    modified_unix_ms: u64,
    verified_at_unix_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelImportManifest {
    schema_version: u32,
    import_id: String,
    model_id: String,
    expected_bytes: Option<u64>,
    replace: bool,
    bytes_written: u64,
    created_at_ms: u128,
    updated_at_ms: u128,
}

#[derive(Clone, Default)]
pub struct ModelManager {
    bundled_assets: BundledAiAssets,
}

impl ModelManager {
    pub fn with_bundled_assets(bundled_assets: BundledAiAssets) -> Self {
        Self { bundled_assets }
    }

    pub fn status(&self, store: &RecordingStore) -> Value {
        let models = self.model_states(store, false);
        let installed_model_count = models
            .iter()
            .filter(|model| {
                model
                    .get("installed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
            .count();
        let verified_model_count = models
            .iter()
            .filter(|model| {
                model
                    .get("verified")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
            .count();
        let bundled_assets = self.bundled_assets_status();
        let bundled_speech_ready = bundled_assets
            .get("speech")
            .and_then(Value::as_object)
            .and_then(|speech| speech.get("ready"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let selected_default_model = bundled_default_model_id(&bundled_assets)
            .unwrap_or(DEFAULT_MODEL_ID)
            .to_string();

        json!({
            "implemented": true,
            "localOnly": true,
            "cloudAi": false,
            "modelRootKind": store.root_kind(),
            "modelPathAcceptedFromRenderer": false,
            "manualInstallOnly": !bundled_speech_ready,
            "manualImportAvailable": true,
            "manualImportMethod": "native-file-picker-streamed-to-core",
            "bundledDefaultsSupported": true,
            "bundledAssets": bundled_assets,
            "backgroundDownloads": false,
            "downloadPolicy": "network-download-not-implemented-in-m2",
            "defaultModelId": selected_default_model,
            "supportedModelCount": MODEL_SPECS.len(),
            "installedModelCount": installed_model_count,
            "verifiedModelCount": verified_model_count,
            "models": models,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    pub fn bundled_assets_status(&self) -> Value {
        let mut status = self.bundled_assets.status();
        let Some(failure_code) = self.bundled_speech_trust_failure(&status) else {
            return status;
        };

        if let Some(speech) = status.get_mut("speech").and_then(Value::as_object_mut) {
            speech.insert("state".to_string(), Value::String("corrupt".to_string()));
            speech.insert("ready".to_string(), Value::Bool(false));
            speech.insert("verifiedAssets".to_string(), Value::from(0));
            speech.insert(
                "failureCode".to_string(),
                Value::String(failure_code.to_string()),
            );
        }
        let repair_required = status
            .get("selectionStatus")
            .and_then(Value::as_str)
            .is_some_and(|selection| selection != "no-default-selected");
        if let Some(root) = status.as_object_mut() {
            root.insert("state".to_string(), Value::String("corrupt".to_string()));
            root.insert("ready".to_string(), Value::Bool(false));
            root.insert("repairRequired".to_string(), Value::Bool(repair_required));
            root.insert(
                "repairAction".to_string(),
                Value::String(
                    if repair_required {
                        "reinstall-candor"
                    } else {
                        "none"
                    }
                    .to_string(),
                ),
            );
            root.insert(
                "failureCode".to_string(),
                Value::String(failure_code.to_string()),
            );
        }
        status
    }

    fn bundled_speech_trust_failure(&self, status: &Value) -> Option<&'static str> {
        let speech = status.get("speech")?.as_object()?;
        if !speech.get("ready")?.as_bool()? {
            return None;
        }
        let Some(model_id) = speech.get("modelId").and_then(Value::as_str) else {
            return Some("BUNDLED_AI_SPEECH_MODEL_UNSUPPORTED");
        };
        let Ok(spec) = model_spec(model_id) else {
            return Some("BUNDLED_AI_SPEECH_MODEL_UNSUPPORTED");
        };
        match self.bundled_assets.speech_model(model_id) {
            Ok(Some(asset)) if bundled_model_is_trusted(&spec, &asset) => None,
            Ok(Some(_)) => Some("BUNDLED_AI_MODEL_TRUST_MISMATCH"),
            Ok(None) => Some("BUNDLED_AI_SPEECH_MODEL_MISSING"),
            Err(_) => Some("BUNDLED_AI_SPEECH_MODEL_UNAVAILABLE"),
        }
    }

    pub fn list_local(&self, store: &RecordingStore) -> Value {
        let models = self.model_states(store, false);
        let installed_models = models
            .iter()
            .filter(|model| {
                model
                    .get("installed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
            .cloned()
            .collect::<Vec<_>>();

        json!({
            "localOnly": true,
            "cloudAi": false,
            "modelRootKind": store.root_kind(),
            "modelPathAcceptedFromRenderer": false,
            "installedModelCount": installed_models.len(),
            "models": installed_models,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    pub fn verify_local(
        &self,
        store: &RecordingStore,
        params: ModelIdParams,
    ) -> Result<Value, ModelManagerError> {
        let model_id = normalize_model_id(params.model_id)?;
        let spec = model_spec(&model_id)?;
        let path = model_path_for_store(store, spec.id);
        let managed = verify_model_path(&path, &spec)?;
        if managed.bytes > 0 {
            return Ok(model_value(
                &spec,
                true,
                managed.verified,
                managed.bytes,
                managed.modified_unix_ms,
                managed.actual_sha256,
                false,
                managed.failure_code,
                managed.failure_message.as_deref(),
            ));
        }
        match self.bundled_assets.speech_model(spec.id) {
            Ok(Some(asset)) => Ok(bundled_model_value(&spec, asset)),
            Ok(None) => Ok(verify_model_path_value(&path, spec)),
            Err(error) => Err(ModelManagerError::new(error.code, error.message)),
        }
    }

    pub fn import_start(
        &self,
        store: &RecordingStore,
        params: ModelImportStartParams,
    ) -> Result<Value, ModelManagerError> {
        let model_id = normalize_model_id(params.model_id)?;
        let spec = model_spec(&model_id)?;
        if let Some(expected_bytes) = params.expected_bytes {
            if expected_bytes == 0 {
                return Err(ModelManagerError::new(
                    "MODEL_IMPORT_SIZE_INVALID",
                    "model import expected bytes must be greater than zero",
                ));
            }
        }

        let root = store.models_root_for_core();
        fs::create_dir_all(&root)
            .map_err(|err| ModelManagerError::new("MODEL_STORE_CREATE_FAILED", err.to_string()))?;
        let target = model_path_for_store(store, spec.id);
        if target.exists() && !params.replace {
            return Err(ModelManagerError::new(
                "MODEL_ALREADY_INSTALLED",
                "local model already exists; set replace to true to overwrite it",
            ));
        }

        let import_id = new_import_id();
        let manifest = ModelImportManifest {
            schema_version: 1,
            import_id: import_id.clone(),
            model_id: spec.id.to_string(),
            expected_bytes: params.expected_bytes,
            replace: params.replace,
            bytes_written: 0,
            created_at_ms: now_ms(),
            updated_at_ms: now_ms(),
        };
        let part_path = import_part_path(&root, &import_id)?;
        File::options()
            .create_new(true)
            .write(true)
            .open(&part_path)
            .map_err(|err| ModelManagerError::new("MODEL_IMPORT_CREATE_FAILED", err.to_string()))?
            .sync_all()
            .map_err(|err| ModelManagerError::new("MODEL_IMPORT_FLUSH_FAILED", err.to_string()))?;
        write_import_manifest(&root, &manifest)?;

        Ok(json!({
            "importId": import_id,
            "modelId": spec.id,
            "fileName": model_file_name(spec.id),
            "expectedBytes": params.expected_bytes,
            "replace": params.replace,
            "chunkBytesMax": MAX_MODEL_IMPORT_CHUNK_BYTES,
            "localOnly": true,
            "cloudAi": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn import_chunk(
        &self,
        store: &RecordingStore,
        params: ModelImportChunkParams,
    ) -> Result<Value, ModelManagerError> {
        validate_import_id(&params.import_id)?;
        let root = store.models_root_for_core();
        let mut manifest = read_import_manifest(&root, &params.import_id)?;
        let bytes = BASE64_STANDARD.decode(params.data_base64).map_err(|_| {
            ModelManagerError::new(
                "MODEL_IMPORT_BASE64_INVALID",
                "model import chunk must be valid base64",
            )
        })?;
        if bytes.is_empty() {
            return Err(ModelManagerError::new(
                "MODEL_IMPORT_CHUNK_EMPTY",
                "model import chunks must not be empty",
            ));
        }
        if bytes.len() > MAX_MODEL_IMPORT_CHUNK_BYTES {
            return Err(ModelManagerError::new(
                "MODEL_IMPORT_CHUNK_TOO_LARGE",
                format!(
                    "model import chunk exceeds {} byte limit",
                    MAX_MODEL_IMPORT_CHUNK_BYTES
                ),
            ));
        }
        if let Some(expected_bytes) = manifest.expected_bytes {
            let next = manifest.bytes_written.saturating_add(bytes.len() as u64);
            if next > expected_bytes {
                return Err(ModelManagerError::new(
                    "MODEL_IMPORT_SIZE_EXCEEDED",
                    "model import wrote more bytes than expected",
                ));
            }
        }

        let part_path = import_part_path(&root, &params.import_id)?;
        let mut file = OpenOptions::new()
            .append(true)
            .open(&part_path)
            .map_err(|err| ModelManagerError::new("MODEL_IMPORT_WRITE_FAILED", err.to_string()))?;
        file.write_all(&bytes)
            .map_err(|err| ModelManagerError::new("MODEL_IMPORT_WRITE_FAILED", err.to_string()))?;
        file.sync_all()
            .map_err(|err| ModelManagerError::new("MODEL_IMPORT_FLUSH_FAILED", err.to_string()))?;

        manifest.bytes_written = manifest.bytes_written.saturating_add(bytes.len() as u64);
        manifest.updated_at_ms = now_ms();
        write_import_manifest(&root, &manifest)?;

        Ok(json!({
            "importId": manifest.import_id,
            "modelId": manifest.model_id,
            "bytesWritten": manifest.bytes_written,
            "expectedBytes": manifest.expected_bytes,
            "complete": manifest.expected_bytes == Some(manifest.bytes_written),
            "localOnly": true,
            "cloudAi": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn import_finish(
        &self,
        store: &RecordingStore,
        params: ModelImportFinishParams,
    ) -> Result<Value, ModelManagerError> {
        validate_import_id(&params.import_id)?;
        let root = store.models_root_for_core();
        let manifest = read_import_manifest(&root, &params.import_id)?;
        if manifest.bytes_written == 0 {
            return Err(ModelManagerError::new(
                "MODEL_IMPORT_EMPTY",
                "model import cannot finish without bytes",
            ));
        }
        if let Some(expected_bytes) = manifest.expected_bytes {
            if manifest.bytes_written != expected_bytes {
                return Err(ModelManagerError::new(
                    "MODEL_IMPORT_INCOMPLETE",
                    "model import byte count does not match the expected file size",
                ));
            }
        }

        let spec = model_spec(&manifest.model_id)?;
        let part_path = import_part_path(&root, &manifest.import_id)?;
        let verification = verify_model_path_value(&part_path, spec);
        let verified = verification
            .get("verified")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !verified {
            cleanup_import_files(&root, &manifest.import_id);
            return Ok(json!({
                "importId": manifest.import_id,
                "modelId": spec.id,
                "imported": false,
                "rejected": true,
                "verification": verification,
                "localOnly": true,
                "cloudAi": false,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            }));
        }

        let target = model_path_for_store(store, spec.id);
        if target.exists() {
            if !manifest.replace {
                return Err(ModelManagerError::new(
                    "MODEL_ALREADY_INSTALLED",
                    "local model already exists; start the import with replace true",
                ));
            }
            fs::remove_file(&target).map_err(|err| {
                ModelManagerError::new("MODEL_IMPORT_REPLACE_FAILED", err.to_string())
            })?;
            let cache_path = model_verify_cache_path(&target);
            if cache_path.exists() {
                fs::remove_file(cache_path).map_err(|err| {
                    ModelManagerError::new("MODEL_IMPORT_REPLACE_FAILED", err.to_string())
                })?;
            }
        }
        fs::rename(&part_path, &target)
            .map_err(|err| ModelManagerError::new("MODEL_IMPORT_COMMIT_FAILED", err.to_string()))?;
        remove_import_manifest(&root, &manifest.import_id)?;
        let installed = verify_model_path_value(&target, spec);

        Ok(json!({
            "importId": manifest.import_id,
            "modelId": spec.id,
            "imported": true,
            "rejected": false,
            "verification": installed,
            "localOnly": true,
            "cloudAi": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn import_abort(
        &self,
        store: &RecordingStore,
        params: ModelImportAbortParams,
    ) -> Result<Value, ModelManagerError> {
        validate_import_id(&params.import_id)?;
        let root = store.models_root_for_core();
        cleanup_import_files(&root, &params.import_id);
        Ok(json!({
            "importId": params.import_id,
            "aborted": true,
            "localOnly": true,
            "cloudAi": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn proof_synthetic(
        &self,
        store: &RecordingStore,
        params: ModelProofParams,
    ) -> Result<Value, ModelManagerError> {
        let model_id = normalize_model_id(params.model_id.or_else(|| Some("tiny.en".to_string())))?;
        let spec = model_spec(&model_id)?;
        let root = store.models_root_for_core();
        fs::create_dir_all(&root)
            .map_err(|err| ModelManagerError::new("MODEL_STORE_CREATE_FAILED", err.to_string()))?;
        let path = model_path_for_store(store, spec.id);
        let mut file = File::options()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|err| {
                if path.exists() {
                    ModelManagerError::new(
                        "MODEL_PROOF_TARGET_EXISTS",
                        "synthetic proof will not overwrite an existing model file",
                    )
                } else {
                    ModelManagerError::new("MODEL_PROOF_WRITE_FAILED", err.to_string())
                }
            })?;
        file.write_all(SYNTHETIC_PROOF_BYTES)
            .map_err(|err| ModelManagerError::new("MODEL_PROOF_WRITE_FAILED", err.to_string()))?;
        file.sync_all()
            .map_err(|err| ModelManagerError::new("MODEL_PROOF_FLUSH_FAILED", err.to_string()))?;

        let verification = verify_model_path_value(&path, spec);
        Ok(json!({
            "proof": {
                "synthetic": true,
                "modelId": spec.id,
                "fileName": model_file_name(spec.id),
                "expectedMismatch": true,
                "tamperedModelBlocked": verification.get("verified").and_then(Value::as_bool) == Some(false),
                "localOnly": true,
                "cloudAi": false,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            },
            "verification": verification,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    fn model_states(&self, store: &RecordingStore, verify_uncached: bool) -> Vec<Value> {
        MODEL_SPECS
            .iter()
            .map(|spec| {
                let path = model_path_for_store(store, spec.id);
                let managed = if verify_uncached {
                    verify_model_path_value(&path, *spec)
                } else {
                    quick_model_state(&path, spec)
                };
                if managed
                    .get("installed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return managed;
                }
                match self.bundled_assets.speech_model(spec.id) {
                    Ok(Some(asset)) => bundled_model_value(spec, asset),
                    _ => managed,
                }
            })
            .collect()
    }

    #[cfg(feature = "local-whisper")]
    pub(crate) fn verified_model_path(
        &self,
        store: &RecordingStore,
        model_id: &str,
    ) -> Result<VerifiedModel, ModelManagerError> {
        let spec = model_spec(model_id)?;
        let path = model_path_for_store(store, spec.id);
        let verification = verify_model_path(&path, &spec)?;
        if verification.verified {
            return Ok(VerifiedModel {
                model_id: spec.id.to_string(),
                path,
                sha256: verification.actual_sha256.unwrap_or_default(),
                bytes: verification.bytes,
                modified_unix_ms: verification.modified_unix_ms,
                source: "managed-local",
            });
        }
        if managed_override_blocks_bundle_fallback(&verification) {
            return Err(ModelManagerError::new(
                verification.failure_code.unwrap_or("MODEL_VERIFY_FAILED"),
                verification
                    .failure_message
                    .unwrap_or_else(|| "local Whisper model failed verification".to_string()),
            ));
        }
        match self.bundled_assets.speech_model(spec.id) {
            Ok(Some(asset)) if bundled_model_is_trusted(&spec, &asset) => Ok(VerifiedModel {
                model_id: spec.id.to_string(),
                path: asset.path,
                sha256: asset.sha256,
                bytes: asset.bytes,
                modified_unix_ms: 0,
                source: "bundled-package",
            }),
            Ok(Some(_)) => Err(ModelManagerError::new(
                "BUNDLED_AI_MODEL_TRUST_MISMATCH",
                "packaged Whisper model does not match Candor's trusted model digest",
            )),
            Ok(None) => Err(ModelManagerError::new(
                verification.failure_code.unwrap_or("MODEL_VERIFY_FAILED"),
                verification
                    .failure_message
                    .unwrap_or_else(|| "local Whisper model failed verification".to_string()),
            )),
            Err(error) => Err(ModelManagerError::new(error.code, error.message)),
        }
    }

    pub(crate) fn resolve_model_id(
        &self,
        requested: Option<String>,
    ) -> Result<String, ModelManagerError> {
        if requested.is_some() {
            return normalize_model_id(requested);
        }
        let bundled_status = self.bundled_assets_status();
        normalize_model_id(Some(
            bundled_default_model_id(&bundled_status)
                .unwrap_or(DEFAULT_MODEL_ID)
                .to_string(),
        ))
    }

    pub(crate) fn selected_default_model_id(&self) -> String {
        let bundled_status = self.bundled_assets_status();
        bundled_default_model_id(&bundled_status)
            .unwrap_or(DEFAULT_MODEL_ID)
            .to_string()
    }
}

fn bundled_default_model_id(status: &Value) -> Option<&str> {
    let speech = status.get("speech")?.as_object()?;
    if speech.get("ready")?.as_bool()? {
        speech.get("modelId")?.as_str()
    } else {
        None
    }
}

pub(crate) fn valid_model_ids() -> Vec<&'static str> {
    MODEL_SPECS.iter().map(|spec| spec.id).collect()
}

pub(crate) fn trusted_model_sha256(model_id: &str) -> Option<&'static str> {
    MODEL_SPECS
        .iter()
        .find(|spec| spec.id == model_id)
        .map(|spec| spec.expected_sha256)
}

pub(crate) fn normalize_model_id(value: Option<String>) -> Result<String, ModelManagerError> {
    let model_id = value.unwrap_or_else(|| DEFAULT_MODEL_ID.to_string());
    let model_id = model_id.trim();
    if MODEL_SPECS.iter().any(|spec| spec.id == model_id) {
        Ok(model_id.to_string())
    } else {
        Err(ModelManagerError::new(
            "MODEL_ID_INVALID",
            "model id is not in the local Whisper allowlist",
        ))
    }
}

#[cfg(feature = "local-whisper")]
impl VerifiedModel {
    pub(crate) fn public_value(&self) -> Value {
        json!({
            "modelId": self.model_id,
            "sha256": self.sha256,
            "bytes": self.bytes,
            "modifiedUnixMs": self.modified_unix_ms,
            "source": self.source,
            "rawPathExposed": false
        })
    }
}

#[derive(Debug)]
struct ModelVerification {
    verified: bool,
    bytes: u64,
    modified_unix_ms: u64,
    actual_sha256: Option<String>,
    failure_code: Option<&'static str>,
    failure_message: Option<String>,
}

#[cfg(any(feature = "local-whisper", test))]
fn managed_override_blocks_bundle_fallback(verification: &ModelVerification) -> bool {
    verification.bytes > 0 && !verification.verified
}

fn model_spec(model_id: &str) -> Result<ModelSpec, ModelManagerError> {
    MODEL_SPECS
        .iter()
        .copied()
        .find(|spec| spec.id == model_id)
        .ok_or_else(|| {
            ModelManagerError::new(
                "MODEL_ID_INVALID",
                "model id is not in the local Whisper allowlist",
            )
        })
}

fn model_path_for_store(store: &RecordingStore, model_id: &str) -> PathBuf {
    store.models_root_for_core().join(model_file_name(model_id))
}

fn model_file_name(model_id: &str) -> String {
    format!("ggml-{model_id}.bin")
}

fn bundled_model_value(spec: &ModelSpec, asset: VerifiedBundledAsset) -> Value {
    if !bundled_model_is_trusted(spec, &asset) {
        return model_value(
            spec,
            true,
            false,
            asset.bytes,
            0,
            Some(asset.sha256),
            false,
            Some("BUNDLED_AI_MODEL_TRUST_MISMATCH"),
            Some("packaged Whisper model does not match Candor's trusted model digest"),
        );
    }
    json!({
        "modelId": spec.id,
        "fileName": model_file_name(spec.id),
        "language": spec.language,
        "role": spec.role,
        "expectedSha256": spec.expected_sha256,
        "installed": true,
        "verified": true,
        "bytes": asset.bytes,
        "modifiedUnixMs": 0,
        "actualSha256": asset.sha256,
        "verificationRequired": false,
        "failureCode": Value::Null,
        "failureMessage": Value::Null,
        "source": "bundled-package",
        "rawPathExposed": false
    })
}

fn bundled_model_is_trusted(spec: &ModelSpec, asset: &VerifiedBundledAsset) -> bool {
    asset.sha256.eq_ignore_ascii_case(spec.expected_sha256)
}

fn new_import_id() -> String {
    let suffix = NEXT_MODEL_IMPORT_ID_SUFFIX.fetch_add(1, Ordering::SeqCst);
    format!("import-{}-{}-{suffix}", process::id(), now_ms())
}

fn validate_import_id(value: &str) -> Result<(), ModelManagerError> {
    let valid = !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err(ModelManagerError::new(
            "MODEL_IMPORT_ID_INVALID",
            "model import id must be ASCII alphanumeric, dash, or underscore",
        ))
    }
}

fn import_part_path(root: &Path, import_id: &str) -> Result<PathBuf, ModelManagerError> {
    validate_import_id(import_id)?;
    Ok(root.join(format!("{import_id}.part")))
}

fn import_manifest_path(root: &Path, import_id: &str) -> Result<PathBuf, ModelManagerError> {
    validate_import_id(import_id)?;
    Ok(root.join(format!("{import_id}.json")))
}

fn read_import_manifest(
    root: &Path,
    import_id: &str,
) -> Result<ModelImportManifest, ModelManagerError> {
    let path = import_manifest_path(root, import_id)?;
    let content = fs::read_to_string(path)
        .map_err(|err| ModelManagerError::new("MODEL_IMPORT_READ_FAILED", err.to_string()))?;
    let manifest = serde_json::from_str::<ModelImportManifest>(&content)
        .map_err(|err| ModelManagerError::new("MODEL_IMPORT_PARSE_FAILED", err.to_string()))?;
    if manifest.import_id != import_id {
        return Err(ModelManagerError::new(
            "MODEL_IMPORT_MANIFEST_INVALID",
            "model import manifest id did not match the requested import",
        ));
    }
    Ok(manifest)
}

fn write_import_manifest(
    root: &Path,
    manifest: &ModelImportManifest,
) -> Result<(), ModelManagerError> {
    validate_import_id(&manifest.import_id)?;
    let path = import_manifest_path(root, &manifest.import_id)?;
    let tmp_path = root.join(format!("{}.json.tmp", manifest.import_id));
    let content = serde_json::to_vec_pretty(manifest)
        .map_err(|err| ModelManagerError::new("MODEL_IMPORT_SERIALIZE_FAILED", err.to_string()))?;
    {
        let mut file = File::create(&tmp_path)
            .map_err(|err| ModelManagerError::new("MODEL_IMPORT_WRITE_FAILED", err.to_string()))?;
        file.write_all(&content)
            .map_err(|err| ModelManagerError::new("MODEL_IMPORT_WRITE_FAILED", err.to_string()))?;
        file.sync_all()
            .map_err(|err| ModelManagerError::new("MODEL_IMPORT_FLUSH_FAILED", err.to_string()))?;
    }
    if path.exists() {
        fs::remove_file(&path).map_err(|err| {
            ModelManagerError::new("MODEL_IMPORT_REPLACE_FAILED", err.to_string())
        })?;
    }
    fs::rename(&tmp_path, path)
        .map_err(|err| ModelManagerError::new("MODEL_IMPORT_REPLACE_FAILED", err.to_string()))?;
    Ok(())
}

fn remove_import_manifest(root: &Path, import_id: &str) -> Result<(), ModelManagerError> {
    let path = import_manifest_path(root, import_id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|err| {
            ModelManagerError::new("MODEL_IMPORT_CLEANUP_FAILED", err.to_string())
        })?;
    }
    Ok(())
}

fn cleanup_import_files(root: &Path, import_id: &str) {
    if let Ok(path) = import_part_path(root, import_id) {
        let _ = fs::remove_file(path);
    }
    if let Ok(path) = import_manifest_path(root, import_id) {
        let _ = fs::remove_file(path);
    }
}

fn quick_model_state(path: &Path, spec: &ModelSpec) -> Value {
    let Some((bytes, modified_unix_ms)) = model_fingerprint(path) else {
        return model_value(
            spec,
            false,
            false,
            0,
            0,
            None,
            false,
            Some("MODEL_NOT_INSTALLED"),
            Some("local model is not installed"),
        );
    };

    if let Some(cache) = read_model_verify_cache(path) {
        if cache.model_id == spec.id
            && cache
                .expected_sha256
                .eq_ignore_ascii_case(spec.expected_sha256)
            && cache
                .actual_sha256
                .eq_ignore_ascii_case(spec.expected_sha256)
            && cache.size == bytes
            && cache.modified_unix_ms == modified_unix_ms
        {
            return model_value(
                spec,
                true,
                true,
                bytes,
                modified_unix_ms,
                Some(cache.actual_sha256),
                false,
                None,
                None,
            );
        }
    }

    model_value(
        spec,
        true,
        false,
        bytes,
        modified_unix_ms,
        None,
        true,
        Some("MODEL_VERIFICATION_REQUIRED"),
        Some("local model needs hash verification"),
    )
}

fn verify_model_path_value(path: &Path, spec: ModelSpec) -> Value {
    match verify_model_path(path, &spec) {
        Ok(verification) => model_value(
            &spec,
            verification.bytes > 0,
            verification.verified,
            verification.bytes,
            verification.modified_unix_ms,
            verification.actual_sha256,
            false,
            verification.failure_code,
            verification.failure_message.as_deref(),
        ),
        Err(error) => model_value(
            &spec,
            false,
            false,
            0,
            0,
            None,
            false,
            Some(error.code),
            Some(error.message.as_str()),
        ),
    }
}

fn verify_model_path(
    path: &Path,
    spec: &ModelSpec,
) -> Result<ModelVerification, ModelManagerError> {
    let Some((bytes, modified_unix_ms)) = model_fingerprint(path) else {
        return Ok(ModelVerification {
            verified: false,
            bytes: 0,
            modified_unix_ms: 0,
            actual_sha256: None,
            failure_code: Some("MODEL_NOT_INSTALLED"),
            failure_message: Some("local model is not installed".to_string()),
        });
    };

    if let Some(cache) = read_model_verify_cache(path) {
        if cache.model_id == spec.id
            && cache
                .expected_sha256
                .eq_ignore_ascii_case(spec.expected_sha256)
            && cache
                .actual_sha256
                .eq_ignore_ascii_case(spec.expected_sha256)
            && cache.size == bytes
            && cache.modified_unix_ms == modified_unix_ms
        {
            return Ok(ModelVerification {
                verified: true,
                bytes,
                modified_unix_ms,
                actual_sha256: Some(cache.actual_sha256),
                failure_code: None,
                failure_message: None,
            });
        }
    }

    let actual_sha256 = sha256_file(path)?;
    if actual_sha256.eq_ignore_ascii_case(spec.expected_sha256) {
        write_model_verify_cache(
            path,
            &ModelVerifyCache {
                model_id: spec.id.to_string(),
                expected_sha256: spec.expected_sha256.to_string(),
                actual_sha256: actual_sha256.clone(),
                size: bytes,
                modified_unix_ms,
                verified_at_unix_ms: now_unix_ms(),
            },
        );
        Ok(ModelVerification {
            verified: true,
            bytes,
            modified_unix_ms,
            actual_sha256: Some(actual_sha256),
            failure_code: None,
            failure_message: None,
        })
    } else {
        Ok(ModelVerification {
            verified: false,
            bytes,
            modified_unix_ms,
            actual_sha256: Some(actual_sha256),
            failure_code: Some("MODEL_HASH_MISMATCH"),
            failure_message: Some("local model failed the trusted SHA-256 check".to_string()),
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn model_value(
    spec: &ModelSpec,
    installed: bool,
    verified: bool,
    bytes: u64,
    modified_unix_ms: u64,
    actual_sha256: Option<String>,
    verification_required: bool,
    failure_code: Option<&'static str>,
    failure_message: Option<&str>,
) -> Value {
    json!({
        "modelId": spec.id,
        "fileName": model_file_name(spec.id),
        "language": spec.language,
        "role": spec.role,
        "expectedSha256": spec.expected_sha256,
        "installed": installed,
        "verified": verified,
        "bytes": bytes,
        "modifiedUnixMs": modified_unix_ms,
        "actualSha256": actual_sha256,
        "verificationRequired": verification_required,
        "failureCode": failure_code,
        "failureMessage": failure_message,
        "rawPathExposed": false
    })
}

fn model_fingerprint(path: &Path) -> Option<(u64, u64)> {
    let metadata = fs::metadata(path).ok()?;
    Some((
        metadata.len(),
        metadata.modified().map(unix_ms).unwrap_or_default(),
    ))
}

fn sha256_file(path: &Path) -> Result<String, ModelManagerError> {
    let mut file = File::open(path)
        .map_err(|err| ModelManagerError::new("MODEL_FILE_READ_FAILED", err.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| ModelManagerError::new("MODEL_FILE_READ_FAILED", err.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn model_verify_cache_path(path: &Path) -> PathBuf {
    let mut cache = path.to_path_buf();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("model");
    cache.set_file_name(format!("{file_name}.sha256.json"));
    cache
}

fn read_model_verify_cache(path: &Path) -> Option<ModelVerifyCache> {
    let content = fs::read_to_string(model_verify_cache_path(path)).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_model_verify_cache(path: &Path, cache: &ModelVerifyCache) {
    if let Ok(content) = serde_json::to_string(cache) {
        let _ = fs::write(model_verify_cache_path(path), content);
    }
}

fn unix_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

fn now_unix_ms() -> u64 {
    unix_ms(SystemTime::now())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundled_test_root(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "candor-model-manager-{label}-{}-{stamp}",
            process::id()
        ))
    }

    #[test]
    fn bundled_default_uses_only_a_ready_selected_speech_model() {
        let ready = json!({
            "speech": {
                "ready": true,
                "modelId": "small.en"
            }
        });
        let unavailable = json!({
            "speech": {
                "ready": false,
                "modelId": "small.en"
            }
        });
        assert_eq!(bundled_default_model_id(&ready), Some("small.en"));
        assert_eq!(bundled_default_model_id(&unavailable), None);
    }

    #[test]
    fn packaged_speech_model_must_match_the_compiled_trust_anchor() {
        let spec = model_spec("base.en").expect("base model spec");
        let trusted = VerifiedBundledAsset {
            path: PathBuf::from("unused"),
            sha256: spec.expected_sha256.to_lowercase(),
            bytes: 1,
            context_tokens: None,
        };
        let mut mismatched = trusted.clone();
        mismatched.sha256 = "f".repeat(64);
        assert!(bundled_model_is_trusted(&spec, &trusted));
        assert!(!bundled_model_is_trusted(&spec, &mismatched));
        assert_eq!(
            bundled_model_value(&spec, mismatched)["failureCode"],
            "BUNDLED_AI_MODEL_TRUST_MISMATCH"
        );
    }

    #[test]
    fn corrupt_managed_override_blocks_silent_package_fallback() {
        let corrupt = ModelVerification {
            verified: false,
            bytes: 64,
            modified_unix_ms: 0,
            actual_sha256: Some("f".repeat(64)),
            failure_code: Some("MODEL_HASH_MISMATCH"),
            failure_message: Some("local model failed verification".to_string()),
        };
        let missing = ModelVerification {
            verified: false,
            bytes: 0,
            modified_unix_ms: 0,
            actual_sha256: None,
            failure_code: Some("MODEL_NOT_INSTALLED"),
            failure_message: Some("local model is not installed".to_string()),
        };

        assert!(managed_override_blocks_bundle_fallback(&corrupt));
        assert!(!managed_override_blocks_bundle_fallback(&missing));
    }

    #[test]
    fn bundled_readiness_rejects_a_self_consistent_but_untrusted_manifest_digest() {
        let root = bundled_test_root("untrusted-bundle");
        fs::create_dir_all(root.join("assets")).expect("create assets");
        fs::create_dir_all(root.join("notices")).expect("create notices");
        let content = b"not a trusted whisper model";
        let digest = format!("{:x}", Sha256::digest(content));
        fs::write(root.join("assets/speech.bin"), content).expect("write speech fixture");
        fs::write(root.join("notices/license.txt"), b"fixture license\n").expect("write license");
        fs::write(root.join("notices/model.md"), b"# Fixture model\n").expect("write model card");
        let manifest = json!({
            "manifestVersion": 1,
            "bundleVersion": "untrusted-test",
            "releaseReady": true,
            "fixture": false,
            "selectionStatus": "release-selected",
            "repairPolicy": "signed-installer-only",
            "assets": [{
                "id": "speech-model",
                "capability": "speech",
                "kind": "model",
                "engine": "whisper.cpp",
                "relativePath": "assets/speech.bin",
                "sha256": digest,
                "bytes": content.len(),
                "licenseFile": "notices/license.txt",
                "licenseExpression": "MIT",
                "sourceUrl": "https://example.invalid/model",
                "revision": "fixture",
                "redistributionApproved": true,
                "required": true,
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "modelId": "small.en",
                "modelCard": "notices/model.md"
            }]
        });
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).expect("serialize manifest"),
        )
        .expect("write manifest");

        let manager = ModelManager::with_bundled_assets(BundledAiAssets::with_root(root.clone()));
        let status = manager.bundled_assets_status();
        assert_eq!(status["speech"]["state"], "corrupt");
        assert_eq!(status["speech"]["ready"], false);
        assert_eq!(
            status["speech"]["failureCode"],
            "BUNDLED_AI_MODEL_TRUST_MISMATCH"
        );
        assert_eq!(status["ready"], false);
        assert_eq!(status["repairRequired"], true);
        assert_eq!(manager.selected_default_model_id(), DEFAULT_MODEL_ID);
        let _ = fs::remove_dir_all(root);
    }
}
