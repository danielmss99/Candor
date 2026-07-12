use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CONSENT_DIR: &str = "consent";
const CONSENT_FILE: &str = "consent.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug)]
pub struct ConsentError {
    pub code: &'static str,
    pub message: String,
}

impl ConsentError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentAcknowledgeParams {
    pub items: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ConsentStore {
    root: PathBuf,
    root_kind: &'static str,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ConsentDocument {
    schema_version: u32,
    acknowledged: BTreeMap<String, u128>,
    updated_at_ms: u128,
}

#[derive(Debug)]
struct ConsentItem {
    id: &'static str,
    label: &'static str,
    required_for_mic: bool,
    required_for_system_audio: bool,
}

impl ConsentStore {
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

    pub fn status(&self) -> Result<Value, ConsentError> {
        let document = self.read_document()?;
        Ok(self.status_from_document(&document))
    }

    pub fn acknowledge(&self, params: ConsentAcknowledgeParams) -> Result<Value, ConsentError> {
        let allowed = allowed_item_ids();
        let mut document = self.read_document()?;
        let now = now_ms();
        let mut changed = Vec::new();

        for item in params.items {
            let item = item.trim();
            if item.is_empty() {
                continue;
            }
            if !allowed.contains(item) {
                return Err(ConsentError::new(
                    "CONSENT_ITEM_UNKNOWN",
                    format!("consent item is not allowlisted: {item}"),
                ));
            }
            document.acknowledged.insert(item.to_string(), now);
            changed.push(item.to_string());
        }

        document.schema_version = SCHEMA_VERSION;
        document.updated_at_ms = now;
        self.write_document(&document)?;

        let mut status = self.status_from_document(&document);
        if let Some(object) = status.as_object_mut() {
            object.insert("acknowledgedNow".to_string(), json!(changed));
        }
        Ok(status)
    }

    pub fn require_mic_recording(&self) -> Result<(), ConsentError> {
        let document = self.read_document()?;
        let required_for_mic = consent_items()
            .iter()
            .filter(|item| item.required_for_mic)
            .map(|item| item.id)
            .collect::<Vec<_>>();

        if all_acknowledged(&document.acknowledged, &required_for_mic) {
            Ok(())
        } else {
            Err(ConsentError::new(
                "CONSENT_REQUIRED",
                "local storage and microphone recording consent are required before capture starts",
            ))
        }
    }

    pub fn require_system_audio_recording(&self) -> Result<(), ConsentError> {
        let document = self.read_document()?;
        let required_for_system_audio = consent_items()
            .iter()
            .filter(|item| item.required_for_system_audio)
            .map(|item| item.id)
            .collect::<Vec<_>>();

        if all_acknowledged(&document.acknowledged, &required_for_system_audio) {
            Ok(())
        } else {
            Err(ConsentError::new(
                "CONSENT_REQUIRED",
                "local storage and system audio recording consent are required before system capture starts",
            ))
        }
    }

    pub fn require_mic_and_system_audio_recording(&self) -> Result<(), ConsentError> {
        let document = self.read_document()?;
        let required_for_mic_and_system_audio = consent_items()
            .iter()
            .filter(|item| item.required_for_mic || item.required_for_system_audio)
            .map(|item| item.id)
            .collect::<Vec<_>>();

        if all_acknowledged(&document.acknowledged, &required_for_mic_and_system_audio) {
            Ok(())
        } else {
            Err(ConsentError::new(
                "CONSENT_REQUIRED",
                "local storage, microphone recording, and system audio recording consent are required before combined capture starts",
            ))
        }
    }

    fn status_from_document(&self, document: &ConsentDocument) -> Value {
        let items = consent_items();
        let required_for_mic = items
            .iter()
            .filter(|item| item.required_for_mic)
            .map(|item| item.id)
            .collect::<Vec<_>>();
        let required_for_system_audio = items
            .iter()
            .filter(|item| item.required_for_system_audio)
            .map(|item| item.id)
            .collect::<Vec<_>>();
        let required_for_mic_and_system_audio = items
            .iter()
            .filter(|item| item.required_for_mic || item.required_for_system_audio)
            .map(|item| item.id)
            .collect::<Vec<_>>();
        let acknowledged_items = items
            .iter()
            .map(|item| {
                let acknowledged_at_ms = document.acknowledged.get(item.id).copied();
                json!({
                    "id": item.id,
                    "label": item.label,
                    "acknowledged": acknowledged_at_ms.is_some(),
                    "acknowledgedAtMs": acknowledged_at_ms,
                    "requiredForMic": item.required_for_mic,
                    "requiredForSystemAudio": item.required_for_system_audio
                })
            })
            .collect::<Vec<_>>();

        json!({
            "schemaVersion": SCHEMA_VERSION,
            "rootKind": self.root_kind,
            "policy": "explicit-local-recording-consent",
            "items": acknowledged_items,
            "requiredForMic": required_for_mic,
            "requiredForSystemAudio": required_for_system_audio,
            "requiredForMicAndSystemAudio": required_for_mic_and_system_audio,
            "readyForMicRecording": all_acknowledged(&document.acknowledged, &required_for_mic),
            "readyForSystemAudioRecording": all_acknowledged(&document.acknowledged, &required_for_system_audio),
            "readyForMicAndSystemAudioRecording": all_acknowledged(&document.acknowledged, &required_for_mic_and_system_audio),
            "updatedAtMs": document.updated_at_ms,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    fn read_document(&self) -> Result<ConsentDocument, ConsentError> {
        let path = self.document_path();
        if !path.exists() {
            return Ok(ConsentDocument {
                schema_version: SCHEMA_VERSION,
                acknowledged: BTreeMap::new(),
                updated_at_ms: 0,
            });
        }
        let bytes = fs::read(&path).map_err(io_error("CONSENT_READ_FAILED"))?;
        let mut document = serde_json::from_slice::<ConsentDocument>(&bytes)
            .map_err(|err| ConsentError::new("CONSENT_PARSE_FAILED", err.to_string()))?;
        document
            .acknowledged
            .retain(|item, _| allowed_item_ids().contains(item.as_str()));
        if document.schema_version == 0 {
            document.schema_version = SCHEMA_VERSION;
        }
        Ok(document)
    }

    fn write_document(&self, document: &ConsentDocument) -> Result<(), ConsentError> {
        let dir = self.root.join(CONSENT_DIR);
        fs::create_dir_all(&dir).map_err(io_error("CONSENT_CREATE_FAILED"))?;
        let path = dir.join(CONSENT_FILE);
        let bytes = serde_json::to_vec_pretty(document)
            .map_err(|err| ConsentError::new("CONSENT_SERIALIZE_FAILED", err.to_string()))?;
        fs::write(path, bytes).map_err(io_error("CONSENT_WRITE_FAILED"))
    }

    fn document_path(&self) -> PathBuf {
        self.root.join(CONSENT_DIR).join(CONSENT_FILE)
    }
}

fn all_acknowledged(acknowledged: &BTreeMap<String, u128>, required: &[&str]) -> bool {
    required.iter().all(|item| acknowledged.contains_key(*item))
}

fn allowed_item_ids() -> BTreeSet<&'static str> {
    consent_items().iter().map(|item| item.id).collect()
}

fn consent_items() -> Vec<ConsentItem> {
    let mut items = vec![
        ConsentItem {
            id: "localOnlyStorage",
            label: "Recordings and indexes stay on this machine.",
            required_for_mic: true,
            required_for_system_audio: true,
        },
        ConsentItem {
            id: "micRecording",
            label: "Microphone recording is explicit and user initiated.",
            required_for_mic: true,
            required_for_system_audio: false,
        },
        ConsentItem {
            id: "systemAudioRecording",
            label: "System audio recording is explicit and user initiated.",
            required_for_mic: false,
            required_for_system_audio: true,
        },
    ];

    if cfg!(target_os = "macos") {
        items.push(ConsentItem {
            id: "macosScreenCaptureSystemAudio",
            label: "macOS requires Screen & System Audio Recording permission for system audio.",
            required_for_mic: false,
            required_for_system_audio: true,
        });
    }

    items
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
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

fn io_error(code: &'static str) -> impl Fn(std::io::Error) -> ConsentError {
    move |err| ConsentError::new(code, err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    fn temp_store() -> ConsentStore {
        let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        ConsentStore::with_root(
            env::temp_dir().join(format!("candor-consent-test-{}-{id}", now_ms())),
        )
    }

    fn required_item_ids(predicate: impl Fn(&ConsentItem) -> bool) -> Vec<String> {
        consent_items()
            .iter()
            .filter(|item| predicate(item))
            .map(|item| item.id.to_string())
            .collect()
    }

    #[test]
    fn consent_status_and_acknowledge_are_pathless() {
        let store = temp_store();
        let before = store.status().expect("status");
        assert_eq!(before["readyForMicRecording"], false);
        assert_eq!(before["rawPathExposed"], false);

        let after = store
            .acknowledge(ConsentAcknowledgeParams {
                items: vec!["localOnlyStorage".to_string(), "micRecording".to_string()],
            })
            .expect("acknowledge");

        assert_eq!(after["readyForMicRecording"], true);
        assert_eq!(after["readyForSystemAudioRecording"], false);
        assert_eq!(after["rawPathExposed"], false);
        assert_eq!(after["keyMaterialExposedToRenderer"], false);

        let reopened = store.status().expect("reopen status");
        assert_eq!(reopened["readyForMicRecording"], true);
    }

    #[test]
    fn unknown_consent_items_are_denied() {
        let store = temp_store();
        let error = store
            .acknowledge(ConsentAcknowledgeParams {
                items: vec!["rawFilesystemAccess".to_string()],
            })
            .expect_err("unknown item should fail");
        assert_eq!(error.code, "CONSENT_ITEM_UNKNOWN");
    }

    #[test]
    fn mic_capture_requires_consent() {
        let store = temp_store();
        let error = store
            .require_mic_recording()
            .expect_err("mic consent should be required");
        assert_eq!(error.code, "CONSENT_REQUIRED");

        store
            .acknowledge(ConsentAcknowledgeParams {
                items: vec!["localOnlyStorage".to_string(), "micRecording".to_string()],
            })
            .expect("acknowledge");
        store
            .require_mic_recording()
            .expect("mic consent should be satisfied");
    }

    #[test]
    fn system_audio_capture_requires_system_consent() {
        let store = temp_store();
        let error = store
            .require_system_audio_recording()
            .expect_err("system audio consent should be required");
        assert_eq!(error.code, "CONSENT_REQUIRED");

        store
            .acknowledge(ConsentAcknowledgeParams {
                items: required_item_ids(|item| item.required_for_system_audio),
            })
            .expect("acknowledge system audio");
        store
            .require_system_audio_recording()
            .expect("system audio consent should be satisfied");
    }

    #[test]
    fn combined_capture_requires_mic_and_system_consent() {
        let store = temp_store();
        store
            .acknowledge(ConsentAcknowledgeParams {
                items: vec!["localOnlyStorage".to_string(), "micRecording".to_string()],
            })
            .expect("acknowledge mic only");
        let error = store
            .require_mic_and_system_audio_recording()
            .expect_err("system audio consent should still be required");
        assert_eq!(error.code, "CONSENT_REQUIRED");

        store
            .acknowledge(ConsentAcknowledgeParams {
                items: required_item_ids(|item| item.required_for_system_audio),
            })
            .expect("acknowledge system audio");
        store
            .require_mic_and_system_audio_recording()
            .expect("combined consent should be satisfied");
    }
}
