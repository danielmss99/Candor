use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::os_key_store;
use crate::report_export::{
    render_docx, render_markdown as render_report_markdown, render_pdf, ExportDocumentOptions,
    ExportReportInput, PreparedReport, ReportTranscriptSegment,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MANIFEST_FILE: &str = "manifest.json";
const RECORDINGS_DIR: &str = "recordings";
const QUARANTINE_RECEIPTS_DIR: &str = "recovery/quarantine";
const DELETION_DATA_DIR: &str = "deletions/data";
const DELETION_PENDING_DIR: &str = "deletions/pending";
const CURRENT_MANIFEST_SCHEMA_VERSION: u32 = 2;
const ENCRYPTED_CHUNK_MAGIC: &[u8] = b"CANDORCHUNK1\n";
const ENCRYPTED_CHUNK_EXT: &str = ".cchunk";
const PLAINTEXT_CHUNK_EXT: &str = ".raw";
const RECORDING_CHUNK_KEY_LABEL: &[u8] = b"recording-chunk-v1";
const MAX_DURABLE_CHUNK_BYTES: usize = 512 * 1024;
const MAX_NOTES_MARKDOWN_BYTES: usize = 512 * 1024;
const MAX_DOCUMENT_EXPORT_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT: u64 = 50;
const MAX_PAGE_LIMIT: u64 = 500;
const LOW_DISK_THRESHOLD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const CAPTURE_START_RESERVE_BYTES: u64 = 512 * 1024 * 1024;
const CHUNK_WRITE_RESERVE_BYTES: u64 = 64 * 1024 * 1024;
const MANIFEST_WRITE_HEADROOM_BYTES: u64 = 1024 * 1024;
static NEXT_RECORDING_ID_SUFFIX: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub struct RecordingStoreError {
    pub code: &'static str,
    pub message: String,
}

impl RecordingStoreError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct RecordingStore {
    root: PathBuf,
    root_kind: &'static str,
    #[cfg(test)]
    available_space_override: Option<u64>,
    #[cfg(test)]
    fail_space_probe: bool,
    #[cfg(test)]
    fail_tombstone_removal: bool,
}

#[cfg_attr(not(feature = "local-whisper"), allow(dead_code))]
#[derive(Debug)]
pub(crate) struct PcmTrack {
    pub(crate) channel: String,
    pub(crate) sample_rate_hz: u32,
    pub(crate) channel_count: u16,
    pub(crate) bits_per_sample: u16,
    pub(crate) duration_ms: u64,
    pub(crate) pcm: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingParams {
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteChunkParams {
    pub recording_id: String,
    #[serde(default = "default_channel")]
    pub channel: String,
    pub data_utf8: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTranscriptSegmentParams {
    pub recording_id: String,
    #[serde(default = "default_channel")]
    pub channel: String,
    #[serde(default)]
    pub speaker: Option<String>,
    pub text: String,
    pub start_ms: u64,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub end_ms: Option<u64>,
    #[serde(default)]
    pub confidence: Option<f32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteAudioChunkParams {
    pub recording_id: String,
    #[serde(default = "default_channel")]
    pub channel: String,
    pub data_base64: String,
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub bits_per_sample: u16,
    #[serde(default)]
    pub start_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingIdParams {
    pub recording_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingPageParams {
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "default_page_limit")]
    pub limit: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptPageParams {
    pub recording_id: String,
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "default_page_limit")]
    pub limit: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveNotesParams {
    pub recording_id: String,
    pub markdown: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunkParams {
    pub recording_id: String,
    pub index: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRecordingsParams {
    pub query: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRecordingParams {
    pub recording_id: String,
    #[serde(default = "default_export_format")]
    pub format: String,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub report: Option<ExportReportInput>,
    #[serde(default)]
    pub options: ExportDocumentOptions,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DurableChunk {
    index: u32,
    #[serde(default = "default_chunk_kind")]
    kind: DurableChunkKind,
    file_name: String,
    channel: String,
    bytes: u64,
    #[serde(default)]
    stored_bytes: u64,
    #[serde(default)]
    encrypted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cipher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    confidence: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sample_rate_hz: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    channel_count: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bits_per_sample: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    start_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    created_at_ms: u128,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum DurableChunkKind {
    TranscriptText,
    TranscriptSegment,
    AudioPcm16le,
    NotesMarkdown,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RecordingManifest {
    schema_version: u32,
    recording_id: String,
    label: Option<String>,
    state: RecordingState,
    created_at_ms: u128,
    updated_at_ms: u128,
    chunks: Vec<DurableChunk>,
    #[serde(default)]
    privacy_events: Vec<PrivacyEvent>,
}

#[derive(Debug)]
struct RecordingManifestCollection {
    items: Vec<(RecordingManifest, PathBuf)>,
    quarantined: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PrivacyEvent {
    event_type: String,
    engine: Option<String>,
    model_id: Option<String>,
    sha256: Option<String>,
    format: Option<String>,
    bytes: Option<u64>,
    created_at_ms: u128,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum RecordingState {
    Recording,
    NeedsRecovery,
    Finished,
}

impl RecordingStore {
    pub fn from_env() -> Self {
        if let Ok(path) = env::var("CANDOR_V3_DATA_DIR") {
            if !path.trim().is_empty() {
                return Self {
                    root: PathBuf::from(path),
                    root_kind: "env-override",
                    #[cfg(test)]
                    available_space_override: None,
                    #[cfg(test)]
                    fail_space_probe: false,
                    #[cfg(test)]
                    fail_tombstone_removal: false,
                };
            }
        }

        Self {
            root: default_data_root(),
            root_kind: "local-user-data",
            #[cfg(test)]
            available_space_override: None,
            #[cfg(test)]
            fail_space_probe: false,
            #[cfg(test)]
            fail_tombstone_removal: false,
        }
    }

    #[cfg(test)]
    pub fn with_root(root: PathBuf) -> Self {
        Self {
            root,
            root_kind: "test-root",
            available_space_override: Some(u64::MAX),
            fail_space_probe: false,
            fail_tombstone_removal: false,
        }
    }

    #[cfg(test)]
    fn with_available_space(mut self, available_bytes: u64) -> Self {
        self.available_space_override = Some(available_bytes);
        self
    }

    #[cfg(test)]
    fn with_failed_space_probe(mut self) -> Self {
        self.fail_space_probe = true;
        self
    }

    #[cfg(test)]
    fn with_failed_tombstone_removal(mut self) -> Self {
        self.fail_tombstone_removal = true;
        self
    }

    pub fn status(&self) -> Result<Value, RecordingStoreError> {
        let recordings_root = self.recordings_root();
        let recording_count = if recordings_root.exists() {
            fs::read_dir(&recordings_root)
                .map_err(io_error("RECORDING_STORE_READ_FAILED"))?
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .count()
        } else {
            0
        };
        let encryption = self.chunk_encryption_status();
        let storage_health = self.storage_health();

        Ok(json!({
            "rootKind": self.root_kind,
            "durableChunks": true,
            "durableAudioChunks": true,
            "acceptedAudioFormat": "pcm_s16le",
            "audioChunkReadMethod": "recording.durable.readAudioChunk",
            "structuredTranscriptSegments": true,
            "transcriptReadMethod": "recording.durable.transcript",
            "chunkEncryptionAvailable": encryption.available,
            "chunkEncryption": encryption.label,
            "chunkCipher": encryption.cipher,
            "chunkFlushPolicy": "write_all+sync_all-per-chunk",
            "manifestPolicy": "json-manifest-rewritten-after-each-chunk",
            "recordingCount": recording_count,
            "storageHealth": storage_health,
            "rawPathExposed": false
        }))
    }

    pub fn storage_health(&self) -> Value {
        match self.available_space_bytes() {
            Ok(available_bytes) => {
                let level = if available_bytes < CAPTURE_START_RESERVE_BYTES {
                    "blocking"
                } else if available_bytes < LOW_DISK_THRESHOLD_BYTES {
                    "low"
                } else {
                    "ok"
                };
                json!({
                    "level": level,
                    "availableBytes": available_bytes,
                    "lowThresholdBytes": LOW_DISK_THRESHOLD_BYTES,
                    "captureStartReserveBytes": CAPTURE_START_RESERVE_BYTES,
                    "chunkWriteReserveBytes": CHUNK_WRITE_RESERVE_BYTES,
                    "canStartRecording": available_bytes >= CAPTURE_START_RESERVE_BYTES,
                    "canContinueCapture": available_bytes >= CHUNK_WRITE_RESERVE_BYTES
                        .saturating_add(MAX_DURABLE_CHUNK_BYTES as u64)
                        .saturating_add(MANIFEST_WRITE_HEADROOM_BYTES),
                    "measuredAtMs": now_ms(),
                    "rawPathExposed": false
                })
            }
            Err(error) => json!({
                "level": "unavailable",
                "availableBytes": null,
                "lowThresholdBytes": LOW_DISK_THRESHOLD_BYTES,
                "captureStartReserveBytes": CAPTURE_START_RESERVE_BYTES,
                "chunkWriteReserveBytes": CHUNK_WRITE_RESERVE_BYTES,
                "canStartRecording": false,
                "canContinueCapture": false,
                "errorCode": error.code,
                "measuredAtMs": now_ms(),
                "rawPathExposed": false
            }),
        }
    }

    fn available_space_bytes(&self) -> Result<u64, RecordingStoreError> {
        #[cfg(test)]
        {
            if self.fail_space_probe {
                return Err(RecordingStoreError::new(
                    "RECORDING_STORAGE_PROBE_FAILED",
                    "available local storage could not be measured",
                ));
            }
            if let Some(available_bytes) = self.available_space_override {
                return Ok(available_bytes);
            }
        }

        fs::create_dir_all(&self.root).map_err(io_error("RECORDING_STORE_CREATE_FAILED"))?;
        fs2::available_space(&self.root).map_err(|_| {
            RecordingStoreError::new(
                "RECORDING_STORAGE_PROBE_FAILED",
                "available local storage could not be measured",
            )
        })
    }

    fn ensure_capture_start_space(&self) -> Result<(), RecordingStoreError> {
        let available_bytes = self.available_space_bytes()?;
        if available_bytes < CAPTURE_START_RESERVE_BYTES {
            return Err(RecordingStoreError::new(
                "RECORDING_STORAGE_START_BLOCKED",
                "free local storage is below the reserve required to start recording",
            ));
        }
        Ok(())
    }

    fn ensure_chunk_write_space(&self, payload_bytes: usize) -> Result<(), RecordingStoreError> {
        let required_bytes = CHUNK_WRITE_RESERVE_BYTES
            .saturating_add(payload_bytes as u64)
            .saturating_add(MANIFEST_WRITE_HEADROOM_BYTES);
        if self.available_space_bytes()? < required_bytes {
            return Err(RecordingStoreError::new(
                "RECORDING_STORAGE_WRITE_BLOCKED",
                "free local storage is below the reserve required for another durable chunk",
            ));
        }
        Ok(())
    }

    pub fn retention_status(&self) -> Result<Value, RecordingStoreError> {
        let recording_count = self.all_recording_summaries()?.len();
        Ok(json!({
            "implemented": true,
            "policy": "manual-delete-only",
            "automaticDeletion": false,
            "defaultRetentionDays": null,
            "recordingCount": recording_count,
            "retentionOwner": "candor-core",
            "settingsStorage": "local-user-data",
            "notesSavedWithRecording": true,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub(crate) fn root_kind(&self) -> &'static str {
        self.root_kind
    }

    pub(crate) fn models_root_for_core(&self) -> PathBuf {
        self.root.join("models")
    }

    pub(crate) fn settings_root_for_core(&self) -> PathBuf {
        self.root.join("settings")
    }

    pub(crate) fn key_root_for_core(&self) -> PathBuf {
        self.root.clone()
    }

    #[cfg(test)]
    pub(crate) fn local_data_root_for_core(&self) -> PathBuf {
        self.root.clone()
    }

    pub fn start(&self, params: StartRecordingParams) -> Result<Value, RecordingStoreError> {
        self.ensure_capture_start_space()?;
        let recording_id = new_recording_id();
        let dir = self.recording_dir(&recording_id)?;
        fs::create_dir_all(&dir).map_err(io_error("RECORDING_STORE_CREATE_FAILED"))?;

        let now = now_ms();
        let manifest = RecordingManifest {
            schema_version: CURRENT_MANIFEST_SCHEMA_VERSION,
            recording_id: recording_id.clone(),
            label: params.label,
            state: RecordingState::Recording,
            created_at_ms: now,
            updated_at_ms: now,
            chunks: Vec::new(),
            privacy_events: Vec::new(),
        };
        write_manifest(&dir, &manifest)?;

        Ok(recording_summary(&manifest, self.root_kind))
    }

    pub fn write_text_chunk(&self, params: WriteChunkParams) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        validate_channel(&params.channel)?;
        let bytes = params.data_utf8.as_bytes();
        if bytes.is_empty() {
            return Err(RecordingStoreError::new(
                "RECORDING_CHUNK_EMPTY",
                "durable recording chunks must not be empty",
            ));
        }
        if bytes.len() > MAX_DURABLE_CHUNK_BYTES {
            return Err(RecordingStoreError::new(
                "RECORDING_CHUNK_TOO_LARGE",
                format!(
                    "durable recording chunk exceeds {} byte limit",
                    MAX_DURABLE_CHUNK_BYTES
                ),
            ));
        }

        let dir = self.recording_dir(&params.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        if manifest.state != RecordingState::Recording {
            return Err(RecordingStoreError::new(
                "RECORDING_NOT_OPEN",
                "chunks can only be written while a recording is open",
            ));
        }

        let index = manifest.chunks.len() as u32;
        let encrypted_payload =
            self.encrypt_chunk_if_available(&params.recording_id, index, bytes)?;
        let (file_name, stored_bytes, encrypted, cipher, payload) = match encrypted_payload {
            Some(payload) => {
                let stored_bytes = payload.len() as u64;
                (
                    format!("chunk-{index:06}.cchunk"),
                    stored_bytes,
                    true,
                    Some("chacha20poly1305".to_string()),
                    payload,
                )
            }
            None => (
                format!("chunk-{index:06}.raw"),
                bytes.len() as u64,
                false,
                None,
                bytes.to_vec(),
            ),
        };
        let chunk_path = dir.join(&file_name);
        self.ensure_chunk_write_space(payload.len())?;
        write_durable_chunk_file(&chunk_path, &payload)?;

        manifest.chunks.push(DurableChunk {
            index,
            kind: DurableChunkKind::TranscriptText,
            file_name,
            channel: params.channel,
            bytes: bytes.len() as u64,
            stored_bytes,
            encrypted,
            cipher,
            speaker: None,
            confidence: None,
            sample_rate_hz: None,
            channel_count: None,
            bits_per_sample: None,
            start_ms: None,
            duration_ms: None,
            created_at_ms: now_ms(),
        });
        manifest.updated_at_ms = now_ms();
        write_manifest(&dir, &manifest)?;

        Ok(recording_summary(&manifest, self.root_kind))
    }

    pub fn write_transcript_segment(
        &self,
        params: WriteTranscriptSegmentParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        validate_channel(&params.channel)?;
        let text = params.text.trim();
        if text.is_empty() {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_SEGMENT_EMPTY",
                "transcript segment text must not be empty",
            ));
        }
        let bytes = text.as_bytes();
        if bytes.len() > MAX_DURABLE_CHUNK_BYTES {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_SEGMENT_TOO_LARGE",
                format!(
                    "transcript segment exceeds {} byte limit",
                    MAX_DURABLE_CHUNK_BYTES
                ),
            ));
        }
        let speaker = normalize_optional_label(params.speaker, 80)?;
        let confidence = normalize_confidence(params.confidence)?;
        let duration_ms =
            transcript_duration_ms(params.start_ms, params.duration_ms, params.end_ms)?;

        let dir = self.recording_dir(&params.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        if manifest.state == RecordingState::NeedsRecovery {
            return Err(RecordingStoreError::new(
                "RECORDING_NEEDS_RECOVERY",
                "recording must be recovered before transcript segments can be written",
            ));
        }

        let index = manifest.chunks.len() as u32;
        let encrypted_payload =
            self.encrypt_chunk_if_available(&params.recording_id, index, bytes)?;
        let (file_name, stored_bytes, encrypted, cipher, payload) = match encrypted_payload {
            Some(payload) => {
                let stored_bytes = payload.len() as u64;
                (
                    format!("chunk-{index:06}.cchunk"),
                    stored_bytes,
                    true,
                    Some("chacha20poly1305".to_string()),
                    payload,
                )
            }
            None => (
                format!("chunk-{index:06}.raw"),
                bytes.len() as u64,
                false,
                None,
                bytes.to_vec(),
            ),
        };
        let chunk_path = dir.join(&file_name);
        self.ensure_chunk_write_space(payload.len())?;
        write_durable_chunk_file(&chunk_path, &payload)?;

        manifest.chunks.push(DurableChunk {
            index,
            kind: DurableChunkKind::TranscriptSegment,
            file_name,
            channel: params.channel,
            bytes: bytes.len() as u64,
            stored_bytes,
            encrypted,
            cipher,
            speaker,
            confidence,
            sample_rate_hz: None,
            channel_count: None,
            bits_per_sample: None,
            start_ms: Some(params.start_ms),
            duration_ms: Some(duration_ms),
            created_at_ms: now_ms(),
        });
        manifest.updated_at_ms = now_ms();
        write_manifest(&dir, &manifest)?;

        Ok(recording_summary(&manifest, self.root_kind))
    }

    pub fn write_audio_chunk(
        &self,
        params: WriteAudioChunkParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        validate_channel(&params.channel)?;
        validate_audio_format(
            params.sample_rate_hz,
            params.channel_count,
            params.bits_per_sample,
        )?;
        let bytes = decode_audio_base64(&params.data_base64)?;
        if bytes.is_empty() {
            return Err(RecordingStoreError::new(
                "RECORDING_CHUNK_EMPTY",
                "durable audio chunks must not be empty",
            ));
        }
        if bytes.len() > MAX_DURABLE_CHUNK_BYTES {
            return Err(RecordingStoreError::new(
                "RECORDING_CHUNK_TOO_LARGE",
                format!(
                    "durable audio chunk exceeds {} byte limit",
                    MAX_DURABLE_CHUNK_BYTES
                ),
            ));
        }
        let frame_bytes = audio_frame_bytes(params.channel_count, params.bits_per_sample)?;
        if bytes.len() % frame_bytes != 0 {
            return Err(RecordingStoreError::new(
                "RECORDING_AUDIO_FRAME_INVALID",
                "audio chunk bytes must align to whole PCM frames",
            ));
        }

        let dir = self.recording_dir(&params.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        if manifest.state != RecordingState::Recording {
            return Err(RecordingStoreError::new(
                "RECORDING_NOT_OPEN",
                "chunks can only be written while a recording is open",
            ));
        }

        let index = manifest.chunks.len() as u32;
        let encrypted_payload =
            self.encrypt_chunk_if_available(&params.recording_id, index, &bytes)?;
        let (file_name, stored_bytes, encrypted, cipher, payload) = match encrypted_payload {
            Some(payload) => {
                let stored_bytes = payload.len() as u64;
                (
                    format!("chunk-{index:06}.cchunk"),
                    stored_bytes,
                    true,
                    Some("chacha20poly1305".to_string()),
                    payload,
                )
            }
            None => (
                format!("chunk-{index:06}.raw"),
                bytes.len() as u64,
                false,
                None,
                bytes.clone(),
            ),
        };
        let chunk_path = dir.join(&file_name);
        self.ensure_chunk_write_space(payload.len())?;
        write_durable_chunk_file(&chunk_path, &payload)?;

        let duration_ms = audio_duration_ms(
            bytes.len() as u64,
            params.sample_rate_hz,
            params.channel_count,
            params.bits_per_sample,
        )?;
        let start_ms = params
            .start_ms
            .unwrap_or_else(|| next_audio_start_ms(&manifest));
        manifest.chunks.push(DurableChunk {
            index,
            kind: DurableChunkKind::AudioPcm16le,
            file_name,
            channel: params.channel,
            bytes: bytes.len() as u64,
            stored_bytes,
            encrypted,
            cipher,
            speaker: None,
            confidence: None,
            sample_rate_hz: Some(params.sample_rate_hz),
            channel_count: Some(params.channel_count),
            bits_per_sample: Some(params.bits_per_sample),
            start_ms: Some(start_ms),
            duration_ms: Some(duration_ms),
            created_at_ms: now_ms(),
        });
        manifest.updated_at_ms = now_ms();
        write_manifest(&dir, &manifest)?;

        Ok(recording_summary(&manifest, self.root_kind))
    }

    pub fn finish(&self, params: RecordingIdParams) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let dir = self.recording_dir(&params.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        if manifest.state == RecordingState::Finished {
            return Ok(recording_summary(&manifest, self.root_kind));
        }
        manifest.state = RecordingState::Finished;
        manifest.updated_at_ms = now_ms();
        write_manifest(&dir, &manifest)?;
        Ok(recording_summary(&manifest, self.root_kind))
    }

    pub(crate) fn mark_needs_recovery(
        &self,
        params: RecordingIdParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let dir = self.recording_dir(&params.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        if manifest.state != RecordingState::Finished {
            manifest.state = RecordingState::NeedsRecovery;
            manifest.updated_at_ms = now_ms();
            write_manifest(&dir, &manifest)?;
        }
        Ok(recording_summary(&manifest, self.root_kind))
    }

    pub fn delete_finished(&self, params: RecordingIdParams) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let recording_id = params.recording_id;
        let active_dir = self.recording_dir(&recording_id)?;
        let tombstone_dir = self.deletion_tombstone_dir(&recording_id)?;
        let pending_marker = self.deletion_pending_marker(&recording_id)?;

        if active_dir.exists() {
            if tombstone_dir.exists() {
                return Err(RecordingStoreError::new(
                    "RECORDING_DELETE_TOMBSTONE_CONFLICT",
                    "active recording and deletion tombstone both exist",
                ));
            }
            let manifest = read_manifest(&active_dir)?;
            if manifest.state != RecordingState::Finished {
                return Err(RecordingStoreError::new(
                    "RECORDING_DELETE_NOT_FINALIZED",
                    "only a durably finished recording can be permanently deleted",
                ));
            }
            self.write_deletion_intent(&recording_id, &pending_marker)?;
            let tombstone_root = self.root.join(DELETION_DATA_DIR);
            fs::create_dir_all(&tombstone_root)
                .map_err(io_error("RECORDING_DELETE_TOMBSTONE_CREATE_FAILED"))?;
            fs::rename(&active_dir, &tombstone_dir)
                .map_err(io_error("RECORDING_DELETE_RENAME_FAILED"))?;
        } else if tombstone_dir.exists() {
            let manifest = read_manifest(&tombstone_dir)?;
            if manifest.state != RecordingState::Finished {
                return Err(RecordingStoreError::new(
                    "RECORDING_DELETE_NOT_FINALIZED",
                    "deletion tombstone did not contain a finished recording",
                ));
            }
            if !pending_marker.exists() {
                self.write_deletion_intent(&recording_id, &pending_marker)?;
            }
        } else if !pending_marker.exists() {
            return Err(RecordingStoreError::new(
                "RECORDING_NOT_FOUND",
                "recording was not found in the local store",
            ));
        }

        self.remove_deletion_tombstone(&recording_id, &tombstone_dir)
    }

    pub fn complete_deletion_metadata(
        &self,
        params: RecordingIdParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let recording_id = params.recording_id;
        let active_dir = self.recording_dir(&recording_id)?;
        let tombstone_dir = self.deletion_tombstone_dir(&recording_id)?;
        if active_dir.exists() || tombstone_dir.exists() {
            return Err(RecordingStoreError::new(
                "RECORDING_DELETE_DATA_REMAINS",
                "deletion metadata cannot be cleared while recording data remains",
            ));
        }

        let quarantine_receipt = self
            .root
            .join(QUARANTINE_RECEIPTS_DIR)
            .join(format!("{recording_id}.json"));
        if quarantine_receipt.exists() {
            fs::remove_file(&quarantine_receipt)
                .map_err(io_error("RECORDING_DELETE_METADATA_CLEANUP_FAILED"))?;
        }
        let pending_marker = self.deletion_pending_marker(&recording_id)?;
        if pending_marker.exists() {
            fs::remove_file(&pending_marker)
                .map_err(io_error("RECORDING_DELETE_METADATA_CLEANUP_FAILED"))?;
        }

        Ok(json!({
            "recordingId": recording_id,
            "state": "deleted",
            "deleted": true,
            "recordingDataRemoved": true,
            "metadataCleanupComplete": true,
            "permanent": true,
            "rawPathExposed": false
        }))
    }

    fn deletion_tombstone_dir(&self, recording_id: &str) -> Result<PathBuf, RecordingStoreError> {
        validate_id(recording_id)?;
        Ok(self.root.join(DELETION_DATA_DIR).join(recording_id))
    }

    fn deletion_pending_marker(&self, recording_id: &str) -> Result<PathBuf, RecordingStoreError> {
        validate_id(recording_id)?;
        Ok(self
            .root
            .join(DELETION_PENDING_DIR)
            .join(format!("{recording_id}.json")))
    }

    fn write_deletion_intent(
        &self,
        recording_id: &str,
        marker_path: &Path,
    ) -> Result<(), RecordingStoreError> {
        if marker_path.exists() {
            return Ok(());
        }
        let pending_root = self.root.join(DELETION_PENDING_DIR);
        fs::create_dir_all(&pending_root)
            .map_err(io_error("RECORDING_DELETE_INTENT_WRITE_FAILED"))?;
        let temporary_path = pending_root.join(format!("{recording_id}.json.tmp"));
        let bytes = serde_json::to_vec_pretty(&json!({
            "intentVersion": 1,
            "recordingId": recording_id,
            "confirmedAtMs": now_ms(),
            "permanent": true,
            "contentIncluded": false,
            "rawPathExposed": false
        }))
        .map_err(|err| {
            RecordingStoreError::new("RECORDING_DELETE_INTENT_WRITE_FAILED", err.to_string())
        })?;
        {
            let mut file = File::create(&temporary_path)
                .map_err(io_error("RECORDING_DELETE_INTENT_WRITE_FAILED"))?;
            file.write_all(&bytes)
                .map_err(io_error("RECORDING_DELETE_INTENT_WRITE_FAILED"))?;
            file.sync_all()
                .map_err(io_error("RECORDING_DELETE_INTENT_WRITE_FAILED"))?;
        }
        fs::rename(&temporary_path, marker_path)
            .map_err(io_error("RECORDING_DELETE_INTENT_WRITE_FAILED"))
    }

    fn remove_deletion_tombstone(
        &self,
        recording_id: &str,
        tombstone_dir: &Path,
    ) -> Result<Value, RecordingStoreError> {
        #[cfg(test)]
        if self.fail_tombstone_removal && tombstone_dir.exists() {
            return Ok(deletion_incomplete_result(
                recording_id,
                "RECORDING_DELETE_REMOVE_FAILED",
            ));
        }

        if tombstone_dir.exists() && fs::remove_dir_all(tombstone_dir).is_err() {
            return Ok(deletion_incomplete_result(
                recording_id,
                "RECORDING_DELETE_REMOVE_FAILED",
            ));
        }
        Ok(json!({
            "recordingId": recording_id,
            "state": "metadataCleanupPending",
            "deleted": false,
            "recordingDataRemoved": true,
            "activeLibraryRemoved": true,
            "tombstoneRemoved": true,
            "metadataCleanupComplete": false,
            "retryRequired": true,
            "permanent": true,
            "rawPathExposed": false
        }))
    }

    fn recover_pending_deletions(&self) -> Result<Value, RecordingStoreError> {
        let pending_root = self.root.join(DELETION_PENDING_DIR);
        if !pending_root.exists() {
            return Ok(json!({
                "completedDeletionIds": [],
                "completedDeletionCount": 0,
                "pendingDeletionCount": 0,
                "rawPathExposed": false
            }));
        }

        let mut completed = Vec::new();
        let mut pending = 0_u64;
        for entry in fs::read_dir(&pending_root)
            .map_err(io_error("RECORDING_DELETE_RECOVERY_READ_FAILED"))?
        {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    pending = pending.saturating_add(1);
                    continue;
                }
            };
            let Some(recording_id) = entry
                .path()
                .file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_string)
            else {
                pending = pending.saturating_add(1);
                continue;
            };
            if validate_id(&recording_id).is_err() {
                pending = pending.saturating_add(1);
                continue;
            }
            match self.delete_finished(RecordingIdParams {
                recording_id: recording_id.clone(),
            }) {
                Ok(result)
                    if result
                        .get("recordingDataRemoved")
                        .and_then(Value::as_bool)
                        .unwrap_or(false) =>
                {
                    completed.push(recording_id);
                }
                _ => pending = pending.saturating_add(1),
            }
        }

        Ok(json!({
            "completedDeletionCount": completed.len(),
            "completedDeletionIds": completed,
            "pendingDeletionCount": pending,
            "rawPathExposed": false
        }))
    }

    pub fn recover(&self) -> Result<Value, RecordingStoreError> {
        let deletion_recovery = self.recover_pending_deletions()?;
        let recordings_root = self.recordings_root();
        fs::create_dir_all(&recordings_root).map_err(io_error("RECORDING_STORE_CREATE_FAILED"))?;

        let mut recovered = Vec::new();
        let mut quarantined = Vec::new();
        for entry in
            fs::read_dir(&recordings_root).map_err(io_error("RECORDING_STORE_READ_FAILED"))?
        {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            if !entry.path().is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if validate_id(&id).is_err() {
                continue;
            }
            let recovery_result = (|| -> Result<Option<Value>, RecordingStoreError> {
                let mut manifest = self.load_or_rebuild_manifest(&id, &entry.path())?;
                let scanned_chunks = self.scan_chunks(&id, &entry.path())?;
                if scanned_chunks.len() > manifest.chunks.len() {
                    manifest.chunks = scanned_chunks;
                }
                if manifest.state == RecordingState::Recording {
                    manifest.state = RecordingState::NeedsRecovery;
                }
                manifest.updated_at_ms = now_ms();
                write_manifest(&entry.path(), &manifest)?;
                Ok((manifest.state == RecordingState::NeedsRecovery)
                    .then(|| recording_summary(&manifest, self.root_kind)))
            })();
            match recovery_result {
                Ok(Some(summary)) => recovered.push(summary),
                Ok(None) => {}
                Err(error) => quarantined.push(self.quarantine_summary(&id, error.code)),
            }
        }

        Ok(json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "recoveredRecordings": recovered,
            "recoveredCount": recovered.len(),
            "quarantinedRecordings": quarantined,
            "quarantinedCount": quarantined.len(),
            "completedDeletionIds": deletion_recovery["completedDeletionIds"],
            "completedDeletionCount": deletion_recovery["completedDeletionCount"],
            "pendingDeletionCount": deletion_recovery["pendingDeletionCount"]
        }))
    }

    pub fn list(&self) -> Result<Value, RecordingStoreError> {
        let collection = self.collect_recording_manifests()?;
        let mut recordings = collection
            .items
            .into_iter()
            .map(|(manifest, _dir)| recording_summary(&manifest, self.root_kind))
            .collect::<Vec<_>>();
        recordings.sort_by_key(|value| {
            std::cmp::Reverse(
                value
                    .get("updatedAtMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
        });
        Ok(json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "recordingCount": recordings.len(),
            "recordings": recordings,
            "quarantinedCount": collection.quarantined.len(),
            "quarantinedRecordings": collection.quarantined
        }))
    }

    pub fn list_page(&self, params: RecordingPageParams) -> Result<Value, RecordingStoreError> {
        let (offset, limit) = page_bounds(params.offset, params.limit)?;
        let collection = self.collect_recording_manifests()?;
        let mut recordings = collection
            .items
            .into_iter()
            .map(|(manifest, _dir)| recording_summary(&manifest, self.root_kind))
            .collect::<Vec<_>>();
        recordings.sort_by_key(|value| {
            std::cmp::Reverse(
                value
                    .get("updatedAtMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
        });
        let total_count = recordings.len();
        let page = recordings
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        Ok(json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "offset": offset,
            "limit": limit,
            "totalCount": total_count,
            "hasMore": offset.saturating_add(page.len()) < total_count,
            "recordings": page,
            "quarantinedCount": collection.quarantined.len(),
            "quarantinedRecordings": collection.quarantined
        }))
    }

    pub fn read(&self, params: RecordingIdParams) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        let chunks = self.read_manifest_chunks(&manifest, &dir)?;
        Ok(json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "summary": recording_summary(&manifest, self.root_kind),
            "chunks": chunks,
            "chunkCount": chunks.len()
        }))
    }

    pub fn replay_manifest(&self, params: RecordingIdParams) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        let audio_chunks = audio_replay_chunks(&manifest);
        let duration_ms = audio_chunks
            .iter()
            .filter_map(|chunk| chunk.get("endMs").and_then(Value::as_u64))
            .max()
            .unwrap_or(0);
        let mut tracks = Vec::<String>::new();
        for chunk in &manifest.chunks {
            if chunk.kind == DurableChunkKind::AudioPcm16le && !tracks.contains(&chunk.channel) {
                tracks.push(chunk.channel.clone());
            }
        }
        Ok(json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "recordingId": manifest.recording_id.as_str(),
            "label": manifest.label.as_deref(),
            "state": recording_state_label(&manifest.state),
            "durationMs": duration_ms,
            "tracks": tracks,
            "audioChunkCount": audio_chunks.len(),
            "audioChunks": audio_chunks,
            "readMethod": "recording.durable.readAudioChunk",
            "transcriptReadMethod": "recording.durable.transcript"
        }))
    }

    pub fn transcript(&self, params: RecordingIdParams) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        let segments = self.transcript_segments(&manifest, &dir)?;
        let duration_ms = segments
            .iter()
            .filter_map(|segment| segment.get("endMs").and_then(Value::as_u64))
            .max()
            .unwrap_or_default();
        Ok(json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "recordingId": manifest.recording_id.as_str(),
            "label": manifest.label.as_deref(),
            "state": recording_state_label(&manifest.state),
            "segmentCount": segments.len(),
            "durationMs": duration_ms,
            "segments": segments
        }))
    }

    pub fn transcript_page(
        &self,
        params: TranscriptPageParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let (offset, limit) = page_bounds(params.offset, params.limit)?;
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        let segments = self.transcript_segments(&manifest, &dir)?;
        let duration_ms = segments
            .iter()
            .filter_map(|segment| segment.get("endMs").and_then(Value::as_u64))
            .max()
            .unwrap_or_default();
        let total_count = segments.len();
        let page = segments
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        Ok(json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "recordingId": manifest.recording_id.as_str(),
            "label": manifest.label.as_deref(),
            "state": recording_state_label(&manifest.state),
            "offset": offset,
            "limit": limit,
            "segmentCount": total_count,
            "hasMore": offset.saturating_add(page.len()) < total_count,
            "durationMs": duration_ms,
            "segments": page
        }))
    }

    pub fn record_processing_fact(
        &self,
        recording_id: &str,
        event_type: &str,
        engine: &str,
        model_id: Option<&str>,
        sha256: Option<&str>,
    ) -> Result<(), RecordingStoreError> {
        if !matches!(
            event_type,
            "transcription" | "local-ai-recap" | "local-ai-ask"
        ) {
            return Err(RecordingStoreError::new(
                "PRIVACY_EVENT_TYPE_INVALID",
                "processing privacy event type was not allowed",
            ));
        }
        if let Some(hash) = sha256 {
            if !is_sha256_hex(hash) {
                return Err(RecordingStoreError::new(
                    "PRIVACY_EVENT_HASH_INVALID",
                    "processing privacy event hash was invalid",
                ));
            }
        }
        self.append_privacy_event(
            recording_id,
            PrivacyEvent {
                event_type: event_type.to_string(),
                engine: Some(engine.to_string()),
                model_id: model_id.map(str::to_string),
                sha256: sha256.map(|value| value.to_ascii_lowercase()),
                format: None,
                bytes: None,
                created_at_ms: now_ms(),
            },
        )
    }

    pub fn privacy_receipt(&self, params: RecordingIdParams) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        let audio_chunks = manifest
            .chunks
            .iter()
            .filter(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le)
            .collect::<Vec<_>>();
        let transcript_segment_count = manifest
            .chunks
            .iter()
            .filter(|chunk| chunk.kind == DurableChunkKind::TranscriptSegment)
            .count();
        let notes_saved = manifest
            .chunks
            .iter()
            .any(|chunk| chunk.kind == DurableChunkKind::NotesMarkdown);
        let mut channels = Vec::<String>::new();
        for chunk in &audio_chunks {
            if !channels.contains(&chunk.channel) {
                channels.push(chunk.channel.clone());
            }
        }
        let encrypted_audio_chunks = audio_chunks.iter().filter(|chunk| chunk.encrypted).count();
        let processing = manifest
            .privacy_events
            .iter()
            .filter(|event| event.event_type != "export")
            .cloned()
            .collect::<Vec<_>>();
        let exports = manifest
            .privacy_events
            .iter()
            .filter(|event| event.event_type == "export")
            .cloned()
            .collect::<Vec<_>>();

        Ok(json!({
            "proofKind": "meeting-privacy-receipt",
            "receiptVersion": 1,
            "generatedAtMs": now_ms(),
            "recording": {
                "recordingId": manifest.recording_id,
                "label": manifest.label,
                "state": recording_state_label(&manifest.state),
                "createdAtMs": manifest.created_at_ms,
                "updatedAtMs": manifest.updated_at_ms,
                "deletionStatus": "present"
            },
            "capture": {
                "channels": channels,
                "audioChunkCount": audio_chunks.len(),
                "channelAttribution": true
            },
            "storage": {
                "rootKind": self.root_kind,
                "encryptedAudioChunkCount": encrypted_audio_chunks,
                "allAudioEncrypted": !audio_chunks.is_empty() && encrypted_audio_chunks == audio_chunks.len(),
                "cipher": audio_chunks.iter().find_map(|chunk| chunk.cipher.as_deref()),
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            },
            "content": {
                "transcriptSegmentCount": transcript_segment_count,
                "notesSavedLocally": notes_saved
            },
            "processing": processing,
            "exports": exports,
            "retention": {
                "policy": "manual-delete-only",
                "automaticDeletion": false
            },
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn read_notes(&self, params: RecordingIdParams) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        self.notes_response(&manifest, &dir)
    }

    pub fn save_notes(&self, params: SaveNotesParams) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let bytes = params.markdown.as_bytes();
        if bytes.len() > MAX_NOTES_MARKDOWN_BYTES {
            return Err(RecordingStoreError::new(
                "NOTES_MARKDOWN_TOO_LARGE",
                format!(
                    "notes markdown exceeds {} byte limit",
                    MAX_NOTES_MARKDOWN_BYTES
                ),
            ));
        }

        let dir = self.recording_dir(&params.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        if manifest.state == RecordingState::NeedsRecovery {
            return Err(RecordingStoreError::new(
                "RECORDING_NEEDS_RECOVERY",
                "recording must be recovered before notes can be saved",
            ));
        }

        let index = manifest.chunks.len() as u32;
        let encrypted_payload =
            self.encrypt_chunk_if_available(&params.recording_id, index, bytes)?;
        let (file_name, stored_bytes, encrypted, cipher, payload) = match encrypted_payload {
            Some(payload) => {
                let stored_bytes = payload.len() as u64;
                (
                    format!("chunk-{index:06}.cchunk"),
                    stored_bytes,
                    true,
                    Some("chacha20poly1305".to_string()),
                    payload,
                )
            }
            None => (
                format!("chunk-{index:06}.raw"),
                bytes.len() as u64,
                false,
                None,
                bytes.to_vec(),
            ),
        };
        let chunk_path = dir.join(&file_name);
        self.ensure_chunk_write_space(payload.len())?;
        write_durable_chunk_file(&chunk_path, &payload)?;

        manifest.chunks.push(DurableChunk {
            index,
            kind: DurableChunkKind::NotesMarkdown,
            file_name,
            channel: "notes".to_string(),
            bytes: bytes.len() as u64,
            stored_bytes,
            encrypted,
            cipher,
            speaker: None,
            confidence: None,
            sample_rate_hz: None,
            channel_count: None,
            bits_per_sample: None,
            start_ms: None,
            duration_ms: None,
            created_at_ms: now_ms(),
        });
        manifest.updated_at_ms = now_ms();
        write_manifest(&dir, &manifest)?;
        self.notes_response(&manifest, &dir)
    }

    pub fn read_audio_chunk(&self, params: AudioChunkParams) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        let chunk = manifest
            .chunks
            .iter()
            .find(|chunk| {
                chunk.index == params.index && chunk.kind == DurableChunkKind::AudioPcm16le
            })
            .ok_or_else(|| {
                RecordingStoreError::new(
                    "RECORDING_AUDIO_CHUNK_NOT_FOUND",
                    "audio chunk was not found for this recording",
                )
            })?;
        let bytes = self.read_chunk_bytes(&manifest, chunk, &dir)?;
        Ok(json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false,
            "recordingId": manifest.recording_id.as_str(),
            "index": chunk.index,
            "kind": chunk_kind_label(&chunk.kind),
            "channel": chunk.channel.as_str(),
            "codec": "pcm_s16le",
            "sampleRateHz": chunk.sample_rate_hz.unwrap_or_default(),
            "channelCount": chunk.channel_count.unwrap_or_default(),
            "bitsPerSample": chunk.bits_per_sample.unwrap_or_default(),
            "startMs": chunk.start_ms.unwrap_or_default(),
            "durationMs": chunk.duration_ms.unwrap_or_default(),
            "bytes": bytes.len(),
            "dataBase64": BASE64_STANDARD.encode(bytes)
        }))
    }

    pub fn search(&self, params: SearchRecordingsParams) -> Result<Value, RecordingStoreError> {
        let query = params.query.trim();
        if query.is_empty() || query.len() > 200 {
            return Err(RecordingStoreError::new(
                "RECORDING_SEARCH_QUERY_INVALID",
                "search query must be between 1 and 200 bytes after trimming",
            ));
        }
        let query_lower = query.to_ascii_lowercase();
        let mut matches = Vec::new();
        let collection = self.collect_recording_manifests()?;
        let mut quarantined_count = collection.quarantined.len() as u64;

        for (manifest, dir) in collection.items {
            let chunks = match self.read_manifest_chunks(&manifest, &dir) {
                Ok(chunks) => chunks,
                Err(error) => {
                    let _ = self.quarantine_summary(&manifest.recording_id, error.code);
                    quarantined_count = quarantined_count.saturating_add(1);
                    continue;
                }
            };
            for chunk in chunks {
                let text = chunk
                    .get("textUtf8")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let text_lower = text.to_ascii_lowercase();
                if let Some(offset) = text_lower.find(&query_lower) {
                    matches.push(json!({
                        "recordingId": manifest.recording_id.as_str(),
                        "label": manifest.label.as_deref(),
                        "state": recording_state_label(&manifest.state),
                        "chunkIndex": chunk.get("index").and_then(Value::as_u64).unwrap_or_default(),
                        "channel": chunk.get("channel").and_then(Value::as_str).unwrap_or("unknown"),
                        "snippet": snippet(text, offset, query.len()),
                        "rawPathExposed": false
                    }));
                }
            }
        }

        Ok(json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "query": query,
            "matchCount": matches.len(),
            "quarantinedCount": quarantined_count,
            "matches": matches
        }))
    }

    pub fn export_create(
        &self,
        params: ExportRecordingParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let recording_id = params.recording_id.clone();
        let format = params.format.clone();
        let result = match format.as_str() {
            "markdown" if params.report.is_some() => self.export_report_markdown(params),
            "markdown" => self.export_markdown(params),
            "docx" => self.export_docx(params),
            "pdf" => self.export_pdf(params),
            "wav" => self.export_wav(params),
            _ => Err(RecordingStoreError::new(
                "EXPORT_FORMAT_UNSUPPORTED",
                "supported local export formats are markdown, docx, pdf, and wav",
            )),
        }?;
        let bytes = result.get("bytes").and_then(Value::as_u64);
        self.append_privacy_event(
            &recording_id,
            PrivacyEvent {
                event_type: "export".to_string(),
                engine: Some("candor-core".to_string()),
                model_id: None,
                sha256: None,
                format: Some(format),
                bytes,
                created_at_ms: now_ms(),
            },
        )?;
        Ok(result)
    }

    pub fn export_markdown(
        &self,
        params: ExportRecordingParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        let chunks = self.read_manifest_chunks(&manifest, &dir)?;
        let title = manifest
            .label
            .as_deref()
            .filter(|label| !label.trim().is_empty())
            .unwrap_or(&manifest.recording_id);
        let mut markdown = String::new();
        markdown.push_str("# ");
        markdown.push_str(title);
        markdown.push_str("\n\n");
        markdown.push_str(&format!("- Recording ID: `{}`\n", manifest.recording_id));
        markdown.push_str(&format!(
            "- State: `{}`\n",
            recording_state_label(&manifest.state)
        ));
        let replay = self.replay_manifest(RecordingIdParams {
            recording_id: manifest.recording_id.clone(),
        })?;
        markdown.push_str(&format!("- Chunks: `{}`\n", chunks.len()));
        markdown.push_str(&format!(
            "- Audio duration: `{}` ms\n\n",
            replay
                .get("durationMs")
                .and_then(Value::as_u64)
                .unwrap_or_default()
        ));
        let notes = self.read_notes(RecordingIdParams {
            recording_id: manifest.recording_id.clone(),
        })?;
        let notes_markdown = notes
            .get("markdown")
            .and_then(Value::as_str)
            .unwrap_or_default();
        markdown.push_str("## Local Notes\n\n");
        if notes_markdown.trim().is_empty() {
            markdown.push_str("_No meeting notes yet._\n\n");
        } else {
            markdown.push_str(notes_markdown);
            if !notes_markdown.ends_with('\n') {
                markdown.push('\n');
            }
            markdown.push('\n');
        }
        markdown.push_str("## Local Transcript\n\n");
        let transcript = self.transcript(RecordingIdParams {
            recording_id: manifest.recording_id.clone(),
        })?;
        let segments = transcript
            .get("segments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if segments.is_empty() {
            let mut wrote_transcript = false;
            for chunk in &chunks {
                if chunk.get("kind").and_then(Value::as_str) != Some("transcriptText") {
                    continue;
                }
                let index = chunk
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let channel = chunk
                    .get("channel")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let text = chunk
                    .get("textUtf8")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                markdown.push_str(&format!("### Chunk {index} `{channel}`\n\n"));
                markdown.push_str(text);
                markdown.push_str("\n\n");
                wrote_transcript = true;
            }
            if !wrote_transcript {
                markdown.push_str("_No transcript chunks yet._\n\n");
            }
        } else {
            for segment in segments {
                let start_ms = segment
                    .get("startMs")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let end_ms = segment
                    .get("endMs")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let speaker = segment
                    .get("speaker")
                    .and_then(Value::as_str)
                    .unwrap_or("Speaker");
                let channel = segment
                    .get("channel")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let text = segment
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                markdown.push_str(&format!(
                    "- `{start_ms}-{end_ms} ms` `{channel}` **{speaker}:** {text}\n"
                ));
            }
            markdown.push('\n');
        }

        markdown.push_str("## Local Audio Replay Chunks\n\n");
        let audio_chunks = replay
            .get("audioChunks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if audio_chunks.is_empty() {
            markdown.push_str("_No audio chunks yet._\n\n");
        } else {
            for chunk in audio_chunks {
                let index = chunk
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let channel = chunk
                    .get("channel")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let start_ms = chunk
                    .get("startMs")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let duration_ms = chunk
                    .get("durationMs")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let sample_rate_hz = chunk
                    .get("sampleRateHz")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                markdown.push_str(&format!(
                    "- Chunk `{index}` `{channel}` starts at `{start_ms}` ms, lasts `{duration_ms}` ms, pcm_s16le `{sample_rate_hz}` Hz.\n"
                ));
            }
            markdown.push('\n');
        }

        Ok(json!({
            "format": "markdown",
            "fileName": format!("{}.md", safe_file_stem(title)),
            "markdown": markdown,
            "bytes": markdown.len(),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    fn export_report_markdown(
        &self,
        params: ExportRecordingParams,
    ) -> Result<Value, RecordingStoreError> {
        let report = self.prepare_report(&params)?;
        let markdown = render_report_markdown(&report).map_err(export_render_error)?;
        let file_name = format!("{}.md", safe_file_stem(&report.title));
        Ok(json!({
            "format": "markdown",
            "mimeType": "text/markdown; charset=utf-8",
            "fileName": file_name,
            "markdown": markdown,
            "bytes": markdown.len(),
            "structuredReport": true,
            "generatedLocally": true,
            "networkAttempted": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    fn export_docx(&self, params: ExportRecordingParams) -> Result<Value, RecordingStoreError> {
        let report = self.prepare_report(&params)?;
        let rendered = render_docx(&report).map_err(export_render_error)?;
        validate_document_export_size(rendered.bytes.len())?;
        Ok(json!({
            "format": "docx",
            "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "fileName": format!("{}.docx", safe_file_stem(&report.title)),
            "bytes": rendered.bytes.len(),
            "dataBase64": BASE64_STANDARD.encode(rendered.bytes),
            "structuredReport": true,
            "editable": true,
            "generatedLocally": true,
            "networkAttempted": false,
            "warningCount": rendered.warning_count,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    fn export_pdf(&self, params: ExportRecordingParams) -> Result<Value, RecordingStoreError> {
        let report = self.prepare_report(&params)?;
        let rendered = render_pdf(&report).map_err(export_render_error)?;
        validate_document_export_size(rendered.bytes.len())?;
        Ok(json!({
            "format": "pdf",
            "mimeType": "application/pdf",
            "fileName": format!("{}.pdf", safe_file_stem(&report.title)),
            "bytes": rendered.bytes.len(),
            "dataBase64": BASE64_STANDARD.encode(rendered.bytes),
            "pageCount": rendered.page_count,
            "warningCount": rendered.warning_count,
            "structuredReport": true,
            "searchableText": true,
            "bookmarks": true,
            "generatedLocally": true,
            "networkAttempted": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    fn prepare_report(
        &self,
        params: &ExportRecordingParams,
    ) -> Result<PreparedReport, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        let title = manifest
            .label
            .as_deref()
            .filter(|label| !label.trim().is_empty())
            .unwrap_or(&manifest.recording_id)
            .to_string();
        let replay = self.replay_manifest(RecordingIdParams {
            recording_id: manifest.recording_id.clone(),
        })?;
        let notes = self.read_notes(RecordingIdParams {
            recording_id: manifest.recording_id.clone(),
        })?;
        let notes_markdown = notes
            .get("markdown")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let transcript_value = self.transcript(RecordingIdParams {
            recording_id: manifest.recording_id.clone(),
        })?;
        let mut transcript = transcript_value
            .get("segments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|segment| ReportTranscriptSegment {
                speaker: segment
                    .get("speaker")
                    .and_then(Value::as_str)
                    .unwrap_or("Speaker")
                    .to_string(),
                channel: segment
                    .get("channel")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                text: segment
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                start_ms: segment
                    .get("startMs")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
                end_ms: segment
                    .get("endMs")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
            })
            .collect::<Vec<_>>();
        if transcript.is_empty() {
            let chunks = self.read_manifest_chunks(&manifest, &dir)?;
            transcript.extend(chunks.into_iter().filter_map(|chunk| {
                if chunk.get("kind").and_then(Value::as_str) != Some("transcriptText") {
                    return None;
                }
                Some(ReportTranscriptSegment {
                    speaker: chunk
                        .get("speaker")
                        .and_then(Value::as_str)
                        .unwrap_or("Speaker")
                        .to_string(),
                    channel: chunk
                        .get("channel")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    text: chunk
                        .get("textUtf8")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    start_ms: chunk
                        .get("startMs")
                        .and_then(Value::as_u64)
                        .unwrap_or_default(),
                    end_ms: chunk
                        .get("startMs")
                        .and_then(Value::as_u64)
                        .unwrap_or_default(),
                })
            }));
        }
        let report = PreparedReport {
            title,
            created_at_ms: manifest.created_at_ms,
            duration_ms: replay
                .get("durationMs")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            report: params.report.clone().unwrap_or_default(),
            options: params.options.clone(),
            notes_markdown,
            transcript,
        };
        report
            .validate()
            .map_err(|message| RecordingStoreError::new("EXPORT_REPORT_INVALID", message))?;
        Ok(report)
    }

    pub fn export_wav(&self, params: ExportRecordingParams) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        if let Some(channel) = params.channel.as_deref() {
            validate_channel(channel)?;
        }
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        let selected_channel = params
            .channel
            .clone()
            .or_else(|| {
                manifest
                    .chunks
                    .iter()
                    .find(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le)
                    .map(|chunk| chunk.channel.clone())
            })
            .ok_or_else(|| {
                RecordingStoreError::new(
                    "EXPORT_AUDIO_UNAVAILABLE",
                    "recording has no audio chunks to export",
                )
            })?;
        let wav = self.render_wav_track(&manifest, &dir, &selected_channel)?;
        let title = manifest
            .label
            .as_deref()
            .filter(|label| !label.trim().is_empty())
            .unwrap_or(&manifest.recording_id);
        let file_name = format!(
            "{}-{}.wav",
            safe_file_stem(title),
            safe_file_stem(&selected_channel)
        );

        Ok(json!({
            "format": "wav",
            "mimeType": "audio/wav",
            "fileName": file_name,
            "channel": selected_channel,
            "sampleRateHz": wav.sample_rate_hz,
            "channelCount": wav.channel_count,
            "bitsPerSample": wav.bits_per_sample,
            "durationMs": wav.duration_ms,
            "bytes": wav.bytes.len(),
            "dataBase64": BASE64_STANDARD.encode(wav.bytes),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub(crate) fn pcm_track_for_transcription(
        &self,
        recording_id: &str,
        channel: Option<&str>,
    ) -> Result<PcmTrack, RecordingStoreError> {
        validate_id(recording_id)?;
        if let Some(channel) = channel {
            validate_channel(channel)?;
        }
        let dir = self.recording_dir(recording_id)?;
        let manifest = read_manifest(&dir)?;
        let selected_channel = channel
            .map(str::to_string)
            .or_else(|| {
                manifest
                    .chunks
                    .iter()
                    .find(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le)
                    .map(|chunk| chunk.channel.clone())
            })
            .ok_or_else(|| {
                RecordingStoreError::new(
                    "TRANSCRIPTION_AUDIO_UNAVAILABLE",
                    "recording has no audio chunks to transcribe",
                )
            })?;

        self.render_pcm_track(&manifest, &dir, &selected_channel)
    }

    fn recordings_root(&self) -> PathBuf {
        self.root.join(RECORDINGS_DIR)
    }

    fn recording_dir(&self, recording_id: &str) -> Result<PathBuf, RecordingStoreError> {
        validate_id(recording_id)?;
        Ok(self.recordings_root().join(recording_id))
    }

    fn chunk_encryption_status(&self) -> ChunkEncryptionStatus {
        if os_key_store::status(&self.root).available {
            ChunkEncryptionStatus {
                available: true,
                label: "os-key-encrypted",
                cipher: "chacha20poly1305",
            }
        } else {
            ChunkEncryptionStatus {
                available: false,
                label: "pending-native-key-storage",
                cipher: "none",
            }
        }
    }

    fn encrypt_chunk_if_available(
        &self,
        recording_id: &str,
        index: u32,
        plaintext: &[u8],
    ) -> Result<Option<Vec<u8>>, RecordingStoreError> {
        let key = match os_key_store::get_or_create_key(&self.root) {
            Ok(key) => key.derive_key(RECORDING_CHUNK_KEY_LABEL),
            Err(error) if error.code == "OS_KEY_STORAGE_UNAVAILABLE" => return Ok(None),
            Err(error) => return Err(RecordingStoreError::new(error.code, error.message)),
        };
        encrypt_chunk(&key, recording_id, index, plaintext).map(Some)
    }

    fn manifest_from_chunks(
        &self,
        recording_id: &str,
        dir: &Path,
    ) -> Result<RecordingManifest, RecordingStoreError> {
        let now = now_ms();
        Ok(RecordingManifest {
            schema_version: 2,
            recording_id: recording_id.to_string(),
            label: None,
            state: RecordingState::NeedsRecovery,
            created_at_ms: now,
            updated_at_ms: now,
            chunks: self.scan_chunks(recording_id, dir)?,
            privacy_events: Vec::new(),
        })
    }

    fn scan_chunks(
        &self,
        recording_id: &str,
        dir: &Path,
    ) -> Result<Vec<DurableChunk>, RecordingStoreError> {
        let key = os_key_store::get_or_create_key(&self.root)
            .ok()
            .map(|key| key.derive_key(RECORDING_CHUNK_KEY_LABEL));
        let mut chunks = Vec::new();
        for entry in fs::read_dir(dir).map_err(io_error("RECORDING_STORE_READ_FAILED"))? {
            let entry = entry.map_err(io_error("RECORDING_STORE_READ_FAILED"))?;
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !file_name.starts_with("chunk-")
                || !(file_name.ends_with(PLAINTEXT_CHUNK_EXT)
                    || file_name.ends_with(ENCRYPTED_CHUNK_EXT))
            {
                continue;
            }
            let encrypted = file_name.ends_with(ENCRYPTED_CHUNK_EXT);
            let index = chunk_index_from_name(&file_name).ok_or_else(|| {
                RecordingStoreError::new(
                    "RECORDING_CHUNK_NAME_INVALID",
                    "recording chunk file name did not contain a valid index",
                )
            })?;
            let metadata = entry
                .metadata()
                .map_err(io_error("RECORDING_STORE_READ_FAILED"))?;
            let stored_bytes = metadata.len();
            let bytes = if encrypted {
                match key {
                    Some(key) => decrypt_chunk_len(&key, recording_id, index, &entry.path())?,
                    None => stored_bytes,
                }
            } else {
                stored_bytes
            };
            chunks.push(DurableChunk {
                index,
                kind: DurableChunkKind::TranscriptText,
                file_name,
                channel: "unknown".to_string(),
                bytes,
                stored_bytes,
                encrypted,
                cipher: encrypted.then(|| "chacha20poly1305".to_string()),
                speaker: None,
                confidence: None,
                sample_rate_hz: None,
                channel_count: None,
                bits_per_sample: None,
                start_ms: None,
                duration_ms: None,
                created_at_ms: now_ms(),
            });
        }
        chunks.sort_by_key(|chunk| chunk.index);
        for (expected_index, chunk) in chunks.iter().enumerate() {
            if chunk.index != expected_index as u32 {
                return Err(RecordingStoreError::new(
                    "RECORDING_CHUNK_SEQUENCE_INVALID",
                    "recording chunk files must be contiguous from zero",
                ));
            }
        }
        Ok(chunks)
    }

    fn load_or_rebuild_manifest(
        &self,
        recording_id: &str,
        dir: &Path,
    ) -> Result<RecordingManifest, RecordingStoreError> {
        match read_manifest(dir) {
            Ok(manifest) => Ok(manifest),
            Err(error)
                if matches!(
                    error.code,
                    "RECORDING_MANIFEST_SCHEMA_TOO_NEW" | "RECORDING_MANIFEST_SCHEMA_UNSUPPORTED"
                ) =>
            {
                Err(error)
            }
            Err(_) => self.manifest_from_chunks(recording_id, dir),
        }
    }

    fn quarantine_summary(&self, recording_id: &str, reason_code: &'static str) -> Value {
        let receipt_persisted = self
            .write_quarantine_receipt(recording_id, reason_code)
            .is_ok();
        json!({
            "recordingId": recording_id,
            "reasonCode": reason_code,
            "receiptPersisted": receipt_persisted,
            "contentModified": false,
            "rawPathExposed": false
        })
    }

    fn write_quarantine_receipt(
        &self,
        recording_id: &str,
        reason_code: &'static str,
    ) -> Result<(), RecordingStoreError> {
        validate_id(recording_id)?;
        let receipt_root = self.root.join(QUARANTINE_RECEIPTS_DIR);
        fs::create_dir_all(&receipt_root).map_err(io_error("RECORDING_QUARANTINE_WRITE_FAILED"))?;
        let receipt_path = receipt_root.join(format!("{recording_id}.json"));
        let temporary_path = receipt_root.join(format!("{recording_id}.json.tmp"));
        if receipt_path.exists() {
            let _ = fs::remove_file(&temporary_path);
            return Ok(());
        }
        let receipt = json!({
            "receiptVersion": 1,
            "recordingId": recording_id,
            "reasonCode": reason_code,
            "detectedAtMs": now_ms(),
            "contentModified": false,
            "rawPathExposed": false
        });
        let bytes = serde_json::to_vec_pretty(&receipt).map_err(|err| {
            RecordingStoreError::new("RECORDING_QUARANTINE_WRITE_FAILED", err.to_string())
        })?;
        {
            let mut file = File::create(&temporary_path)
                .map_err(io_error("RECORDING_QUARANTINE_WRITE_FAILED"))?;
            file.write_all(&bytes)
                .map_err(io_error("RECORDING_QUARANTINE_WRITE_FAILED"))?;
            file.sync_all()
                .map_err(io_error("RECORDING_QUARANTINE_WRITE_FAILED"))?;
        }
        match fs::rename(&temporary_path, &receipt_path) {
            Ok(()) => Ok(()),
            Err(_) if receipt_path.exists() => {
                let _ = fs::remove_file(&temporary_path);
                Ok(())
            }
            Err(error) => Err(RecordingStoreError::new(
                "RECORDING_QUARANTINE_WRITE_FAILED",
                error.to_string(),
            )),
        }
    }

    fn collect_recording_manifests(
        &self,
    ) -> Result<RecordingManifestCollection, RecordingStoreError> {
        let recordings_root = self.recordings_root();
        fs::create_dir_all(&recordings_root).map_err(io_error("RECORDING_STORE_CREATE_FAILED"))?;
        let mut items = Vec::new();
        let mut quarantined = Vec::new();
        for entry in
            fs::read_dir(&recordings_root).map_err(io_error("RECORDING_STORE_READ_FAILED"))?
        {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            if !entry.path().is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if validate_id(&id).is_err() {
                continue;
            }
            match self.load_or_rebuild_manifest(&id, &entry.path()) {
                Ok(manifest) => items.push((manifest, entry.path())),
                Err(error) => quarantined.push(self.quarantine_summary(&id, error.code)),
            }
        }
        Ok(RecordingManifestCollection { items, quarantined })
    }

    fn all_recording_manifests(
        &self,
    ) -> Result<Vec<(RecordingManifest, PathBuf)>, RecordingStoreError> {
        self.collect_recording_manifests()
            .map(|collection| collection.items)
    }

    fn all_recording_summaries(&self) -> Result<Vec<Value>, RecordingStoreError> {
        self.all_recording_manifests().map(|items| {
            items
                .into_iter()
                .map(|(manifest, _dir)| recording_summary(&manifest, self.root_kind))
                .collect()
        })
    }

    fn append_privacy_event(
        &self,
        recording_id: &str,
        event: PrivacyEvent,
    ) -> Result<(), RecordingStoreError> {
        validate_id(recording_id)?;
        let dir = self.recording_dir(recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        manifest.schema_version = manifest.schema_version.max(CURRENT_MANIFEST_SCHEMA_VERSION);
        manifest.privacy_events.push(event);
        manifest.updated_at_ms = now_ms();
        write_manifest(&dir, &manifest)
    }

    fn read_manifest_chunks(
        &self,
        manifest: &RecordingManifest,
        dir: &Path,
    ) -> Result<Vec<Value>, RecordingStoreError> {
        let mut chunks = Vec::new();
        for chunk in &manifest.chunks {
            let mut value = json!({
                "index": chunk.index,
                "kind": chunk_kind_label(&chunk.kind),
                "channel": chunk.channel.as_str(),
                "bytes": chunk.bytes,
                "storedBytes": if chunk.stored_bytes == 0 { chunk.bytes } else { chunk.stored_bytes },
                "encrypted": chunk.encrypted,
                "cipher": chunk.cipher.as_deref(),
                "rawPathExposed": false
            });
            if chunk.kind == DurableChunkKind::TranscriptText
                || chunk.kind == DurableChunkKind::TranscriptSegment
                || chunk.kind == DurableChunkKind::NotesMarkdown
            {
                let bytes = self.read_chunk_bytes(manifest, chunk, dir)?;
                let text = String::from_utf8(bytes).map_err(|_| {
                    RecordingStoreError::new(
                        "RECORDING_CHUNK_TEXT_INVALID",
                        "durable transcript chunk was not valid UTF-8",
                    )
                })?;
                value["textUtf8"] = json!(text);
                if chunk.kind == DurableChunkKind::TranscriptSegment {
                    let start_ms = chunk.start_ms.unwrap_or_default();
                    let duration_ms = chunk.duration_ms.unwrap_or_default();
                    value["speaker"] = json!(chunk.speaker.as_deref());
                    value["confidence"] = json!(chunk.confidence);
                    value["startMs"] = json!(start_ms);
                    value["durationMs"] = json!(duration_ms);
                    value["endMs"] = json!(start_ms.saturating_add(duration_ms));
                }
            } else {
                value["codec"] = json!("pcm_s16le");
                value["sampleRateHz"] = json!(chunk.sample_rate_hz.unwrap_or_default());
                value["channelCount"] = json!(chunk.channel_count.unwrap_or_default());
                value["bitsPerSample"] = json!(chunk.bits_per_sample.unwrap_or_default());
                value["startMs"] = json!(chunk.start_ms.unwrap_or_default());
                value["durationMs"] = json!(chunk.duration_ms.unwrap_or_default());
                value["readMethod"] = json!("recording.durable.readAudioChunk");
            }
            chunks.push(value);
        }
        Ok(chunks)
    }

    fn notes_response(
        &self,
        manifest: &RecordingManifest,
        dir: &Path,
    ) -> Result<Value, RecordingStoreError> {
        let notes_chunks = manifest
            .chunks
            .iter()
            .filter(|chunk| chunk.kind == DurableChunkKind::NotesMarkdown)
            .collect::<Vec<_>>();
        let latest = notes_chunks.iter().max_by_key(|chunk| chunk.index).copied();
        let markdown = match latest {
            Some(chunk) => String::from_utf8(self.read_chunk_bytes(manifest, chunk, dir)?)
                .map_err(|_| {
                    RecordingStoreError::new(
                        "NOTES_MARKDOWN_INVALID",
                        "saved notes markdown was not valid UTF-8",
                    )
                })?,
            None => String::new(),
        };
        Ok(json!({
            "rootKind": self.root_kind,
            "recordingId": manifest.recording_id.as_str(),
            "state": recording_state_label(&manifest.state),
            "savedLocally": latest.is_some(),
            "notesFound": latest.is_some(),
            "markdown": markdown,
            "bytes": latest.map(|chunk| chunk.bytes).unwrap_or_default(),
            "storedBytes": latest.map(|chunk| if chunk.stored_bytes == 0 { chunk.bytes } else { chunk.stored_bytes }).unwrap_or_default(),
            "notesChunkCount": notes_chunks.len(),
            "latestChunkIndex": latest.map(|chunk| chunk.index),
            "encryptedAtRest": latest.map(|chunk| chunk.encrypted).unwrap_or(false),
            "cipher": latest.and_then(|chunk| chunk.cipher.as_deref()),
            "updatedAtMs": latest.map(|chunk| chunk.created_at_ms).unwrap_or(manifest.updated_at_ms),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    fn transcript_segments(
        &self,
        manifest: &RecordingManifest,
        dir: &Path,
    ) -> Result<Vec<Value>, RecordingStoreError> {
        let mut segments = Vec::new();
        for chunk in &manifest.chunks {
            if chunk.kind != DurableChunkKind::TranscriptSegment {
                continue;
            }
            let bytes = self.read_chunk_bytes(manifest, chunk, dir)?;
            let text = String::from_utf8(bytes).map_err(|_| {
                RecordingStoreError::new(
                    "TRANSCRIPT_SEGMENT_TEXT_INVALID",
                    "durable transcript segment was not valid UTF-8",
                )
            })?;
            let start_ms = chunk.start_ms.unwrap_or_default();
            let duration_ms = chunk.duration_ms.unwrap_or_default();
            segments.push(json!({
                "index": chunk.index,
                "kind": chunk_kind_label(&chunk.kind),
                "channel": chunk.channel.as_str(),
                "speaker": chunk.speaker.as_deref(),
                "text": text,
                "startMs": start_ms,
                "durationMs": duration_ms,
                "endMs": start_ms.saturating_add(duration_ms),
                "confidence": chunk.confidence,
                "rawPathExposed": false
            }));
        }
        segments.sort_by_key(|segment| {
            (
                segment.get("startMs").and_then(Value::as_u64).unwrap_or(0),
                segment.get("index").and_then(Value::as_u64).unwrap_or(0),
            )
        });
        Ok(segments)
    }

    fn read_chunk_bytes(
        &self,
        manifest: &RecordingManifest,
        chunk: &DurableChunk,
        dir: &Path,
    ) -> Result<Vec<u8>, RecordingStoreError> {
        let path = dir.join(&chunk.file_name);
        if chunk.encrypted {
            let key = os_key_store::get_or_create_key(&self.root)
                .map_err(|err| RecordingStoreError::new(err.code, err.message))?
                .derive_key(RECORDING_CHUNK_KEY_LABEL);
            decrypt_chunk_bytes(&key, &manifest.recording_id, chunk.index, &path)
        } else {
            fs::read(path).map_err(io_error("RECORDING_CHUNK_READ_FAILED"))
        }
    }

    fn render_wav_track(
        &self,
        manifest: &RecordingManifest,
        dir: &Path,
        channel: &str,
    ) -> Result<WavExport, RecordingStoreError> {
        let track = self.render_pcm_track(manifest, dir, channel)?;
        let bytes = wav_bytes(
            track.sample_rate_hz,
            track.channel_count,
            track.bits_per_sample,
            &track.pcm,
        )?;
        Ok(WavExport {
            bytes,
            sample_rate_hz: track.sample_rate_hz,
            channel_count: track.channel_count,
            bits_per_sample: track.bits_per_sample,
            duration_ms: track.duration_ms,
        })
    }

    fn render_pcm_track(
        &self,
        manifest: &RecordingManifest,
        dir: &Path,
        channel: &str,
    ) -> Result<PcmTrack, RecordingStoreError> {
        let mut chunks = manifest
            .chunks
            .iter()
            .filter(|chunk| {
                chunk.kind == DurableChunkKind::AudioPcm16le && chunk.channel == channel
            })
            .collect::<Vec<_>>();
        if chunks.is_empty() {
            return Err(RecordingStoreError::new(
                "EXPORT_AUDIO_CHANNEL_NOT_FOUND",
                "recording has no audio chunks for the requested channel",
            ));
        }
        chunks.sort_by_key(|chunk| (chunk.start_ms.unwrap_or_default(), chunk.index));

        let sample_rate_hz = chunks[0].sample_rate_hz.unwrap_or_default();
        let channel_count = chunks[0].channel_count.unwrap_or_default();
        let bits_per_sample = chunks[0].bits_per_sample.unwrap_or_default();
        validate_audio_format(sample_rate_hz, channel_count, bits_per_sample)?;
        let frame_bytes = audio_frame_bytes(channel_count, bits_per_sample)?;
        let mut pcm = Vec::<u8>::new();
        let mut frames_written = 0_u64;

        for chunk in chunks {
            if chunk.sample_rate_hz.unwrap_or_default() != sample_rate_hz
                || chunk.channel_count.unwrap_or_default() != channel_count
                || chunk.bits_per_sample.unwrap_or_default() != bits_per_sample
            {
                return Err(RecordingStoreError::new(
                    "EXPORT_AUDIO_FORMAT_MISMATCH",
                    "audio chunks for this channel do not share one PCM format",
                ));
            }
            let target_frame =
                start_ms_to_frame(chunk.start_ms.unwrap_or_default(), sample_rate_hz);
            if target_frame > frames_written {
                let silence_bytes = (target_frame - frames_written)
                    .saturating_mul(frame_bytes as u64)
                    .min(usize::MAX as u64) as usize;
                pcm.resize(pcm.len().saturating_add(silence_bytes), 0);
                frames_written = target_frame;
            }
            let bytes = self.read_chunk_bytes(manifest, chunk, dir)?;
            if bytes.len() % frame_bytes != 0 {
                return Err(RecordingStoreError::new(
                    "EXPORT_AUDIO_FRAME_INVALID",
                    "audio chunk bytes were not aligned to whole PCM frames",
                ));
            }
            frames_written = frames_written.saturating_add((bytes.len() / frame_bytes) as u64);
            pcm.extend_from_slice(&bytes);
        }

        let duration_ms = frames_written.saturating_mul(1000) / u64::from(sample_rate_hz.max(1));
        Ok(PcmTrack {
            channel: channel.to_string(),
            sample_rate_hz,
            channel_count,
            bits_per_sample,
            pcm,
            duration_ms,
        })
    }
}

struct ChunkEncryptionStatus {
    available: bool,
    label: &'static str,
    cipher: &'static str,
}

struct WavExport {
    bytes: Vec<u8>,
    sample_rate_hz: u32,
    channel_count: u16,
    bits_per_sample: u16,
    duration_ms: u64,
}

fn default_channel() -> String {
    "mixed".to_string()
}

fn default_chunk_kind() -> DurableChunkKind {
    DurableChunkKind::TranscriptText
}

fn default_export_format() -> String {
    "markdown".to_string()
}

fn default_page_limit() -> u64 {
    DEFAULT_PAGE_LIMIT
}

fn page_bounds(offset: u64, limit: u64) -> Result<(usize, usize), RecordingStoreError> {
    if limit == 0 || limit > MAX_PAGE_LIMIT {
        return Err(RecordingStoreError::new(
            "RECORDING_PAGE_LIMIT_INVALID",
            format!("page limit must be between 1 and {MAX_PAGE_LIMIT}"),
        ));
    }
    let offset = usize::try_from(offset).map_err(|_| {
        RecordingStoreError::new("RECORDING_PAGE_OFFSET_INVALID", "page offset was too large")
    })?;
    let limit = usize::try_from(limit).map_err(|_| {
        RecordingStoreError::new("RECORDING_PAGE_LIMIT_INVALID", "page limit was too large")
    })?;
    Ok((offset, limit))
}

fn export_render_error(message: String) -> RecordingStoreError {
    RecordingStoreError::new("EXPORT_RENDER_FAILED", message)
}

fn validate_document_export_size(bytes: usize) -> Result<(), RecordingStoreError> {
    if bytes > MAX_DOCUMENT_EXPORT_BYTES {
        return Err(RecordingStoreError::new(
            "EXPORT_DOCUMENT_TOO_LARGE",
            format!(
                "generated document exceeds the {MAX_DOCUMENT_EXPORT_BYTES} byte local export limit"
            ),
        ));
    }
    Ok(())
}

fn chunk_kind_label(kind: &DurableChunkKind) -> &'static str {
    match kind {
        DurableChunkKind::TranscriptText => "transcriptText",
        DurableChunkKind::TranscriptSegment => "transcriptSegment",
        DurableChunkKind::AudioPcm16le => "audioPcm16le",
        DurableChunkKind::NotesMarkdown => "notesMarkdown",
    }
}

fn recording_summary(manifest: &RecordingManifest, root_kind: &'static str) -> Value {
    let total_bytes: u64 = manifest.chunks.iter().map(|chunk| chunk.bytes).sum();
    let stored_bytes: u64 = manifest
        .chunks
        .iter()
        .map(|chunk| {
            if chunk.stored_bytes == 0 {
                chunk.bytes
            } else {
                chunk.stored_bytes
            }
        })
        .sum();
    let encrypted_chunks = manifest
        .chunks
        .iter()
        .filter(|chunk| chunk.encrypted)
        .count();
    let encrypted_at_rest =
        !manifest.chunks.is_empty() && encrypted_chunks == manifest.chunks.len();
    let text_chunk_count = manifest
        .chunks
        .iter()
        .filter(|chunk| chunk.kind == DurableChunkKind::TranscriptText)
        .count();
    let transcript_segment_count = manifest
        .chunks
        .iter()
        .filter(|chunk| chunk.kind == DurableChunkKind::TranscriptSegment)
        .count();
    let audio_chunk_count = manifest
        .chunks
        .iter()
        .filter(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le)
        .count();
    let note_chunks = manifest
        .chunks
        .iter()
        .filter(|chunk| chunk.kind == DurableChunkKind::NotesMarkdown)
        .collect::<Vec<_>>();
    let notes_chunk_count = note_chunks.len();
    let notes_bytes = note_chunks
        .iter()
        .max_by_key(|chunk| chunk.index)
        .map(|chunk| chunk.bytes)
        .unwrap_or_default();
    let notes_encrypted_at_rest = note_chunks
        .iter()
        .max_by_key(|chunk| chunk.index)
        .map(|chunk| chunk.encrypted)
        .unwrap_or(false);
    let notes_updated_at_ms = note_chunks
        .iter()
        .max_by_key(|chunk| chunk.index)
        .map(|chunk| chunk.created_at_ms)
        .unwrap_or_default();
    let audio_duration_ms = manifest
        .chunks
        .iter()
        .filter(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le)
        .filter_map(|chunk| match (chunk.start_ms, chunk.duration_ms) {
            (Some(start_ms), Some(duration_ms)) => Some(start_ms.saturating_add(duration_ms)),
            _ => None,
        })
        .max()
        .unwrap_or_default();
    json!({
        "recordingId": manifest.recording_id.as_str(),
        "label": manifest.label.as_deref(),
        "state": recording_state_label(&manifest.state),
        "rootKind": root_kind,
        "rawPathExposed": false,
        "encryptedAtRest": encrypted_at_rest,
        "encryptedChunkCount": encrypted_chunks,
        "chunkCount": manifest.chunks.len(),
        "textChunkCount": text_chunk_count,
        "transcriptSegmentCount": transcript_segment_count,
        "audioChunkCount": audio_chunk_count,
        "notesChunkCount": notes_chunk_count,
        "notesBytes": notes_bytes,
        "notesEncryptedAtRest": notes_encrypted_at_rest,
        "notesUpdatedAtMs": notes_updated_at_ms,
        "audioDurationMs": audio_duration_ms,
        "totalBytes": total_bytes,
        "storedBytes": stored_bytes,
        "createdAtMs": manifest.created_at_ms,
        "updatedAtMs": manifest.updated_at_ms
    })
}

fn deletion_incomplete_result(recording_id: &str, error_code: &'static str) -> Value {
    json!({
        "recordingId": recording_id,
        "state": "deletionIncomplete",
        "deleted": false,
        "recordingDataRemoved": false,
        "activeLibraryRemoved": true,
        "tombstoneRemoved": false,
        "metadataCleanupComplete": false,
        "retryRequired": true,
        "errorCode": error_code,
        "permanent": true,
        "rawPathExposed": false
    })
}

fn audio_replay_chunks(manifest: &RecordingManifest) -> Vec<Value> {
    let mut chunks = manifest
        .chunks
        .iter()
        .filter(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le)
        .map(|chunk| {
            let start_ms = chunk.start_ms.unwrap_or_default();
            let duration_ms = chunk.duration_ms.unwrap_or_default();
            json!({
                "index": chunk.index,
                "kind": chunk_kind_label(&chunk.kind),
                "channel": chunk.channel.as_str(),
                "codec": "pcm_s16le",
                "sampleRateHz": chunk.sample_rate_hz.unwrap_or_default(),
                "channelCount": chunk.channel_count.unwrap_or_default(),
                "bitsPerSample": chunk.bits_per_sample.unwrap_or_default(),
                "startMs": start_ms,
                "durationMs": duration_ms,
                "endMs": start_ms.saturating_add(duration_ms),
                "bytes": chunk.bytes,
                "encrypted": chunk.encrypted,
                "rawPathExposed": false,
                "readMethod": "recording.durable.readAudioChunk"
            })
        })
        .collect::<Vec<_>>();
    chunks.sort_by_key(|chunk| {
        (
            chunk.get("startMs").and_then(Value::as_u64).unwrap_or(0),
            chunk.get("index").and_then(Value::as_u64).unwrap_or(0),
        )
    });
    chunks
}

fn validate_audio_format(
    sample_rate_hz: u32,
    channel_count: u16,
    bits_per_sample: u16,
) -> Result<(), RecordingStoreError> {
    if !(8_000..=192_000).contains(&sample_rate_hz) {
        return Err(RecordingStoreError::new(
            "RECORDING_AUDIO_SAMPLE_RATE_INVALID",
            "audio sample rate must be between 8000 and 192000 Hz",
        ));
    }
    if !(1..=8).contains(&channel_count) {
        return Err(RecordingStoreError::new(
            "RECORDING_AUDIO_CHANNEL_COUNT_INVALID",
            "audio channel count must be between 1 and 8",
        ));
    }
    if bits_per_sample != 16 {
        return Err(RecordingStoreError::new(
            "RECORDING_AUDIO_BITS_INVALID",
            "M2 durable audio accepts PCM 16-bit samples only",
        ));
    }
    Ok(())
}

fn audio_frame_bytes(
    channel_count: u16,
    bits_per_sample: u16,
) -> Result<usize, RecordingStoreError> {
    let bytes_per_sample = usize::from(bits_per_sample / 8);
    let frame_bytes = usize::from(channel_count).saturating_mul(bytes_per_sample);
    if frame_bytes == 0 {
        Err(RecordingStoreError::new(
            "RECORDING_AUDIO_FRAME_INVALID",
            "audio frame size was invalid",
        ))
    } else {
        Ok(frame_bytes)
    }
}

fn audio_duration_ms(
    bytes: u64,
    sample_rate_hz: u32,
    channel_count: u16,
    bits_per_sample: u16,
) -> Result<u64, RecordingStoreError> {
    let frame_bytes = audio_frame_bytes(channel_count, bits_per_sample)? as u64;
    let frames = bytes / frame_bytes;
    let sample_rate = u64::from(sample_rate_hz);
    Ok(frames.saturating_mul(1000) / sample_rate)
}

fn start_ms_to_frame(start_ms: u64, sample_rate_hz: u32) -> u64 {
    start_ms.saturating_mul(u64::from(sample_rate_hz.max(1))) / 1000
}

fn wav_bytes(
    sample_rate_hz: u32,
    channel_count: u16,
    bits_per_sample: u16,
    pcm: &[u8],
) -> Result<Vec<u8>, RecordingStoreError> {
    let data_len = u32::try_from(pcm.len()).map_err(|_| {
        RecordingStoreError::new(
            "EXPORT_AUDIO_TOO_LARGE",
            "audio export exceeded the WAV size limit",
        )
    })?;
    let byte_rate = sample_rate_hz
        .saturating_mul(u32::from(channel_count))
        .saturating_mul(u32::from(bits_per_sample) / 8);
    let block_align = channel_count.saturating_mul(bits_per_sample / 8);
    let riff_len = 36_u32.checked_add(data_len).ok_or_else(|| {
        RecordingStoreError::new(
            "EXPORT_AUDIO_TOO_LARGE",
            "audio export exceeded the WAV size limit",
        )
    })?;

    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_len.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&channel_count.to_le_bytes());
    wav.extend_from_slice(&sample_rate_hz.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    Ok(wav)
}

fn next_audio_start_ms(manifest: &RecordingManifest) -> u64 {
    manifest
        .chunks
        .iter()
        .filter(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le)
        .filter_map(|chunk| match (chunk.start_ms, chunk.duration_ms) {
            (Some(start_ms), Some(duration_ms)) => Some(start_ms.saturating_add(duration_ms)),
            _ => None,
        })
        .max()
        .unwrap_or_default()
}

fn decode_audio_base64(value: &str) -> Result<Vec<u8>, RecordingStoreError> {
    BASE64_STANDARD.decode(value).map_err(|_| {
        RecordingStoreError::new(
            "RECORDING_AUDIO_BASE64_INVALID",
            "audio chunk payload must be valid base64",
        )
    })
}

fn read_manifest(dir: &Path) -> Result<RecordingManifest, RecordingStoreError> {
    let candidates = [
        dir.join(MANIFEST_FILE),
        dir.join("manifest.json.bak"),
        dir.join("manifest.json.tmp"),
    ];
    let mut last_error = None;
    for path in candidates {
        if !path.exists() {
            continue;
        }
        match fs::read(&path) {
            Ok(bytes) => match parse_and_validate_manifest(&bytes, dir) {
                Ok(manifest) => return Ok(manifest),
                Err(error)
                    if matches!(
                        error.code,
                        "RECORDING_MANIFEST_SCHEMA_TOO_NEW"
                            | "RECORDING_MANIFEST_SCHEMA_UNSUPPORTED"
                    ) =>
                {
                    return Err(error);
                }
                Err(err) => {
                    last_error = Some(RecordingStoreError::new(err.code, err.message));
                }
            },
            Err(err) => {
                last_error = Some(RecordingStoreError::new(
                    "RECORDING_MANIFEST_READ_FAILED",
                    err.to_string(),
                ));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| {
        RecordingStoreError::new(
            "RECORDING_MANIFEST_READ_FAILED",
            "recording manifest and recovery copies are missing",
        )
    }))
}

fn parse_and_validate_manifest(
    bytes: &[u8],
    dir: &Path,
) -> Result<RecordingManifest, RecordingStoreError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|err| {
        RecordingStoreError::new(
            "RECORDING_MANIFEST_PARSE_FAILED",
            format!("failed to parse recording manifest: {err}"),
        )
    })?;
    let schema_version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            RecordingStoreError::new(
                "RECORDING_MANIFEST_SCHEMA_INVALID",
                "recording manifest schemaVersion must be an unsigned integer",
            )
        })?;
    if schema_version > u64::from(CURRENT_MANIFEST_SCHEMA_VERSION) {
        return Err(RecordingStoreError::new(
            "RECORDING_MANIFEST_SCHEMA_TOO_NEW",
            format!(
                "recording manifest schema {schema_version} is newer than supported schema {CURRENT_MANIFEST_SCHEMA_VERSION}"
            ),
        ));
    }
    if schema_version == 0 {
        return Err(RecordingStoreError::new(
            "RECORDING_MANIFEST_SCHEMA_UNSUPPORTED",
            "recording manifest schema 0 is unsupported",
        ));
    }

    let manifest: RecordingManifest = serde_json::from_value(value).map_err(|err| {
        RecordingStoreError::new(
            "RECORDING_MANIFEST_PARSE_FAILED",
            format!("failed to parse recording manifest: {err}"),
        )
    })?;
    validate_manifest_structure(&manifest, dir)?;
    Ok(manifest)
}

fn validate_manifest_structure(
    manifest: &RecordingManifest,
    dir: &Path,
) -> Result<(), RecordingStoreError> {
    let directory_id = dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            RecordingStoreError::new(
                "RECORDING_MANIFEST_ID_MISMATCH",
                "recording directory did not have a valid opaque identifier",
            )
        })?;
    if manifest.recording_id != directory_id {
        return Err(RecordingStoreError::new(
            "RECORDING_MANIFEST_ID_MISMATCH",
            "recording manifest identifier did not match its directory",
        ));
    }

    for (expected_index, chunk) in manifest.chunks.iter().enumerate() {
        if chunk.index != expected_index as u32 {
            return Err(RecordingStoreError::new(
                "RECORDING_MANIFEST_CHUNK_SEQUENCE_INVALID",
                "recording manifest chunk indices must be contiguous from zero",
            ));
        }
        let file_name = Path::new(&chunk.file_name);
        if file_name.components().count() != 1
            || file_name.file_name().and_then(|name| name.to_str())
                != Some(chunk.file_name.as_str())
        {
            return Err(RecordingStoreError::new(
                "RECORDING_MANIFEST_CHUNK_NAME_INVALID",
                "recording manifest chunk name was not a local file name",
            ));
        }
        if !dir.join(file_name).is_file() {
            return Err(RecordingStoreError::new(
                "RECORDING_MANIFEST_CHUNK_MISSING",
                "recording manifest referenced a missing chunk",
            ));
        }
    }
    Ok(())
}

fn write_durable_chunk_file(path: &Path, payload: &[u8]) -> Result<(), RecordingStoreError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(io_error("RECORDING_CHUNK_CREATE_FAILED"))?;
    if let Err(error) = file.write_all(payload) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(RecordingStoreError::new(
            "RECORDING_CHUNK_WRITE_FAILED",
            error.to_string(),
        ));
    }
    if let Err(error) = file.sync_all() {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(RecordingStoreError::new(
            "RECORDING_CHUNK_FLUSH_FAILED",
            error.to_string(),
        ));
    }
    Ok(())
}

fn write_manifest(dir: &Path, manifest: &RecordingManifest) -> Result<(), RecordingStoreError> {
    fs::create_dir_all(dir).map_err(io_error("RECORDING_STORE_CREATE_FAILED"))?;
    let tmp_path = dir.join("manifest.json.tmp");
    let backup_path = dir.join("manifest.json.bak");
    let manifest_path = dir.join(MANIFEST_FILE);
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|err| {
        RecordingStoreError::new(
            "RECORDING_MANIFEST_SERIALIZE_FAILED",
            format!("failed to serialize recording manifest: {err}"),
        )
    })?;
    {
        let mut file =
            File::create(&tmp_path).map_err(io_error("RECORDING_MANIFEST_WRITE_FAILED"))?;
        file.write_all(&bytes)
            .map_err(io_error("RECORDING_MANIFEST_WRITE_FAILED"))?;
        file.sync_all()
            .map_err(io_error("RECORDING_MANIFEST_FLUSH_FAILED"))?;
    }
    if backup_path.exists() {
        fs::remove_file(&backup_path).map_err(io_error("RECORDING_MANIFEST_REPLACE_FAILED"))?;
    }
    let had_manifest = manifest_path.exists();
    if had_manifest {
        fs::rename(&manifest_path, &backup_path)
            .map_err(io_error("RECORDING_MANIFEST_REPLACE_FAILED"))?;
    }
    if let Err(err) = fs::rename(&tmp_path, &manifest_path) {
        if had_manifest && backup_path.exists() {
            let _ = fs::rename(&backup_path, &manifest_path);
        }
        return Err(RecordingStoreError::new(
            "RECORDING_MANIFEST_REPLACE_FAILED",
            err.to_string(),
        ));
    }
    if backup_path.exists() {
        let _ = fs::remove_file(&backup_path);
    }
    Ok(())
}

fn encrypt_chunk(
    key: &[u8; 32],
    recording_id: &str,
    index: u32,
    plaintext: &[u8],
) -> Result<Vec<u8>, RecordingStoreError> {
    let mut nonce = [0_u8; 12];
    getrandom::getrandom(&mut nonce)
        .map_err(|err| RecordingStoreError::new("RECORDING_NONCE_FAILED", err.to_string()))?;
    let cipher = ChaCha20Poly1305::new_from_slice(key).map_err(|_| {
        RecordingStoreError::new(
            "RECORDING_CHUNK_KEY_INVALID",
            "durable recording chunk key was invalid",
        )
    })?;
    let aad = chunk_aad(recording_id, index);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| {
            RecordingStoreError::new(
                "RECORDING_CHUNK_ENCRYPT_FAILED",
                "failed to encrypt durable recording chunk",
            )
        })?;
    let mut envelope =
        Vec::with_capacity(ENCRYPTED_CHUNK_MAGIC.len() + nonce.len() + ciphertext.len());
    envelope.extend_from_slice(ENCRYPTED_CHUNK_MAGIC);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

fn decrypt_chunk_len(
    key: &[u8; 32],
    recording_id: &str,
    index: u32,
    path: &Path,
) -> Result<u64, RecordingStoreError> {
    Ok(decrypt_chunk_bytes(key, recording_id, index, path)?.len() as u64)
}

fn decrypt_chunk_bytes(
    key: &[u8; 32],
    recording_id: &str,
    index: u32,
    path: &Path,
) -> Result<Vec<u8>, RecordingStoreError> {
    let envelope = fs::read(path).map_err(io_error("RECORDING_CHUNK_READ_FAILED"))?;
    if envelope.len() <= ENCRYPTED_CHUNK_MAGIC.len() + 12
        || !envelope.starts_with(ENCRYPTED_CHUNK_MAGIC)
    {
        return Err(RecordingStoreError::new(
            "RECORDING_CHUNK_ENVELOPE_INVALID",
            "encrypted durable chunk envelope was invalid",
        ));
    }
    let nonce_start = ENCRYPTED_CHUNK_MAGIC.len();
    let nonce_end = nonce_start + 12;
    let cipher = ChaCha20Poly1305::new_from_slice(key).map_err(|_| {
        RecordingStoreError::new(
            "RECORDING_CHUNK_KEY_INVALID",
            "durable recording chunk key was invalid",
        )
    })?;
    let aad = chunk_aad(recording_id, index);
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&envelope[nonce_start..nonce_end]),
            Payload {
                msg: &envelope[nonce_end..],
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| {
            RecordingStoreError::new(
                "RECORDING_CHUNK_DECRYPT_FAILED",
                "failed to decrypt durable recording chunk during recovery",
            )
        })?;
    Ok(plaintext)
}

fn chunk_aad(recording_id: &str, index: u32) -> String {
    format!("candor-v3-recording-chunk:{recording_id}:{index}")
}

fn chunk_index_from_name(file_name: &str) -> Option<u32> {
    file_name
        .trim_start_matches("chunk-")
        .trim_end_matches(PLAINTEXT_CHUNK_EXT)
        .trim_end_matches(ENCRYPTED_CHUNK_EXT)
        .parse::<u32>()
        .ok()
}

fn validate_id(value: &str) -> Result<(), RecordingStoreError> {
    let valid = !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err(RecordingStoreError::new(
            "RECORDING_ID_INVALID",
            "recording id must be ASCII alphanumeric, dash, or underscore",
        ))
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_channel(value: &str) -> Result<(), RecordingStoreError> {
    let valid = !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err(RecordingStoreError::new(
            "RECORDING_CHANNEL_INVALID",
            "recording channel must be ASCII alphanumeric, dash, or underscore",
        ))
    }
}

fn normalize_optional_label(
    value: Option<String>,
    max_len: usize,
) -> Result<Option<String>, RecordingStoreError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > max_len {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_LABEL_TOO_LONG",
            format!("transcript label must be at most {max_len} bytes"),
        ));
    }
    Ok(Some(trimmed.to_string()))
}

fn normalize_confidence(value: Option<f32>) -> Result<Option<f32>, RecordingStoreError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(Some(value))
    } else {
        Err(RecordingStoreError::new(
            "TRANSCRIPT_CONFIDENCE_INVALID",
            "transcript confidence must be between 0 and 1",
        ))
    }
}

fn transcript_duration_ms(
    start_ms: u64,
    duration_ms: Option<u64>,
    end_ms: Option<u64>,
) -> Result<u64, RecordingStoreError> {
    let duration = match (duration_ms, end_ms) {
        (Some(duration), Some(end)) => {
            if end < start_ms || end.saturating_sub(start_ms) != duration {
                return Err(RecordingStoreError::new(
                    "TRANSCRIPT_TIMING_INVALID",
                    "transcript endMs must equal startMs plus durationMs",
                ));
            }
            duration
        }
        (Some(duration), None) => duration,
        (None, Some(end)) if end >= start_ms => end - start_ms,
        (None, Some(_)) => {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_TIMING_INVALID",
                "transcript endMs must be greater than or equal to startMs",
            ))
        }
        (None, None) => {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_TIMING_INVALID",
                "transcript segment requires durationMs or endMs",
            ))
        }
    };

    if duration == 0 || duration > 60 * 60 * 1000 {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_TIMING_INVALID",
            "transcript segment duration must be between 1 ms and 1 hour",
        ));
    }
    Ok(duration)
}

fn recording_state_label(state: &RecordingState) -> &'static str {
    match state {
        RecordingState::Recording => "recording",
        RecordingState::NeedsRecovery => "needsRecovery",
        RecordingState::Finished => "finished",
    }
}

fn safe_file_stem(value: &str) -> String {
    let mut stem = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() {
            stem.push(byte.to_ascii_lowercase() as char);
        } else if byte == b'-' || byte == b'_' || byte == b' ' {
            stem.push('-');
        }
    }
    let trimmed = stem.trim_matches('-');
    if trimmed.is_empty() {
        "candor-recording".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn snippet(text: &str, byte_offset: usize, query_len: usize) -> String {
    let requested_start = byte_offset.saturating_sub(40);
    let requested_end = byte_offset.saturating_add(query_len).saturating_add(40);
    let mut start = requested_start.min(text.len());
    let mut end = requested_end.min(text.len());

    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }

    let mut value = String::new();
    if start > 0 {
        value.push_str("...");
    }
    value.push_str(&text[start..end]);
    if end < text.len() {
        value.push_str("...");
    }
    value
}

fn new_recording_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let suffix = NEXT_RECORDING_ID_SUFFIX.fetch_add(1, Ordering::Relaxed);
    format!("rec-{nanos}-{}-{suffix}", process::id())
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

fn io_error(code: &'static str) -> impl Fn(std::io::Error) -> RecordingStoreError {
    move |err| RecordingStoreError::new(code, err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> RecordingStore {
        let root = env::temp_dir().join(format!("candor-core-test-{}", new_recording_id()));
        RecordingStore::with_root(root)
    }

    fn recording_id(summary: &Value) -> String {
        summary["recordingId"]
            .as_str()
            .expect("recording id")
            .to_string()
    }

    #[test]
    fn durable_chunks_are_flushed_and_finished() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("test".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);

        let first = store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "abc".to_string(),
            })
            .expect("first chunk");
        assert_eq!(first["chunkCount"], 1);
        assert_eq!(first["totalBytes"], 3);
        #[cfg(windows)]
        {
            assert_eq!(first["encryptedAtRest"], true);
            assert_eq!(first["encryptedChunkCount"], 1);
            assert!(first["storedBytes"].as_u64().unwrap_or_default() > 3);
        }

        let finished = store
            .finish(RecordingIdParams { recording_id })
            .expect("finish recording");
        assert_eq!(finished["state"], "finished");
        assert_eq!(finished["rawPathExposed"], false);
    }

    #[test]
    fn recovery_marks_interrupted_recordings() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id,
                channel: "system".to_string(),
                data_utf8: "meeting audio bytes".to_string(),
            })
            .expect("write chunk");

        let recovered = store.recover().expect("recover");
        assert_eq!(recovered["recoveredCount"], 1);
        assert_eq!(
            recovered["recoveredRecordings"][0]["state"],
            "needsRecovery"
        );
        assert_eq!(recovered["recoveredRecordings"][0]["rawPathExposed"], false);
    }

    #[test]
    fn recovery_rebuilds_missing_manifest_from_chunks() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "chunk".to_string(),
            })
            .expect("write chunk");

        let dir = store.recording_dir(&recording_id).expect("recording dir");
        fs::remove_file(dir.join(MANIFEST_FILE)).expect("remove manifest");

        let recovered = store.recover().expect("recover");
        assert_eq!(recovered["recoveredCount"], 1);
        assert_eq!(recovered["recoveredRecordings"][0]["chunkCount"], 1);
        assert_eq!(recovered["recoveredRecordings"][0]["totalBytes"], 5);
        #[cfg(windows)]
        assert_eq!(recovered["recoveredRecordings"][0]["encryptedAtRest"], true);
    }

    #[test]
    fn corrupt_recording_is_quarantined_without_hiding_healthy_recordings() {
        let store = temp_store();
        let healthy = store
            .start(StartRecordingParams {
                label: Some("Healthy".to_string()),
            })
            .expect("start healthy recording");
        let healthy_id = recording_id(&healthy);
        store
            .finish(RecordingIdParams {
                recording_id: healthy_id.clone(),
            })
            .expect("finish healthy recording");

        let corrupt_id = "corrupt-recording";
        let corrupt_dir = store
            .recording_dir(corrupt_id)
            .expect("corrupt recording dir");
        fs::create_dir_all(&corrupt_dir).expect("create corrupt recording");
        fs::write(corrupt_dir.join(MANIFEST_FILE), b"not-json").expect("write corrupt manifest");
        fs::write(corrupt_dir.join("chunk-000001.raw"), b"orphaned chunk")
            .expect("write gapped chunk");
        let manifest_before = fs::read(corrupt_dir.join(MANIFEST_FILE)).expect("read corrupt data");
        let chunk_before =
            fs::read(corrupt_dir.join("chunk-000001.raw")).expect("read corrupt chunk");

        let listed = store.list().expect("list around corrupt recording");

        assert_eq!(listed["recordingCount"], 1);
        assert_eq!(listed["recordings"][0]["recordingId"], healthy_id);
        assert_eq!(listed["quarantinedCount"], 1);
        assert_eq!(
            listed["quarantinedRecordings"][0]["recordingId"],
            corrupt_id
        );
        assert_eq!(
            listed["quarantinedRecordings"][0]["reasonCode"],
            "RECORDING_CHUNK_SEQUENCE_INVALID"
        );
        assert_eq!(listed["quarantinedRecordings"][0]["contentModified"], false);
        assert_eq!(
            fs::read(corrupt_dir.join(MANIFEST_FILE)).expect("reread corrupt manifest"),
            manifest_before
        );
        assert_eq!(
            fs::read(corrupt_dir.join("chunk-000001.raw")).expect("reread corrupt chunk"),
            chunk_before
        );

        let receipt_path = store
            .root
            .join(QUARANTINE_RECEIPTS_DIR)
            .join(format!("{corrupt_id}.json"));
        let receipt: Value =
            serde_json::from_slice(&fs::read(receipt_path).expect("read quarantine receipt"))
                .expect("parse quarantine receipt");
        let receipt_keys = receipt
            .as_object()
            .expect("receipt object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            receipt_keys,
            vec![
                "contentModified",
                "detectedAtMs",
                "rawPathExposed",
                "reasonCode",
                "receiptVersion",
                "recordingId",
            ]
        );

        let recovered = store.recover().expect("recover around corrupt recording");
        assert_eq!(recovered["quarantinedCount"], 1);
        assert_eq!(
            recovered["quarantinedRecordings"][0]["rawPathExposed"],
            false
        );
    }

    #[test]
    fn future_manifest_is_left_byte_for_byte_untouched_and_not_rebuilt_from_backup() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Future manifest".to_string()),
            })
            .expect("start future recording");
        let recording_id = recording_id(&started);
        let dir = store
            .recording_dir(&recording_id)
            .expect("future recording dir");
        let manifest_path = dir.join(MANIFEST_FILE);
        fs::copy(&manifest_path, dir.join("manifest.json.bak"))
            .expect("preserve current-schema backup");
        let mut future: Value =
            serde_json::from_slice(&fs::read(&manifest_path).expect("read current manifest"))
                .expect("parse current manifest");
        future["schemaVersion"] = json!(99);
        future["futureOnly"] = json!({ "mustSurvive": true });
        let future_bytes = serde_json::to_vec_pretty(&future).expect("serialize future manifest");
        fs::write(&manifest_path, &future_bytes).expect("write future manifest");

        let read_error = store
            .read(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect_err("future manifest must fail closed");
        assert_eq!(read_error.code, "RECORDING_MANIFEST_SCHEMA_TOO_NEW");

        let listed = store.list().expect("list around future manifest");
        assert_eq!(listed["recordingCount"], 0);
        assert_eq!(listed["quarantinedCount"], 1);
        assert_eq!(
            listed["quarantinedRecordings"][0]["reasonCode"],
            "RECORDING_MANIFEST_SCHEMA_TOO_NEW"
        );
        assert_eq!(
            fs::read(&manifest_path).expect("reread future manifest"),
            future_bytes
        );

        let recovered = store.recover().expect("recover around future manifest");
        assert_eq!(recovered["recoveredCount"], 0);
        assert_eq!(recovered["quarantinedCount"], 1);
        assert_eq!(
            fs::read(&manifest_path).expect("reread future manifest after recovery"),
            future_bytes
        );
    }

    #[test]
    fn unsupported_schema_zero_manifest_is_untouched_and_not_rebuilt_from_backup() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Unsupported manifest".to_string()),
            })
            .expect("start unsupported recording");
        let recording_id = recording_id(&started);
        let dir = store
            .recording_dir(&recording_id)
            .expect("unsupported recording dir");
        let manifest_path = dir.join(MANIFEST_FILE);
        fs::copy(&manifest_path, dir.join("manifest.json.bak")).expect("preserve supported backup");
        let mut unsupported: Value =
            serde_json::from_slice(&fs::read(&manifest_path).expect("read current manifest"))
                .expect("parse current manifest");
        unsupported["schemaVersion"] = json!(0);
        unsupported["unsupportedOnly"] = json!({ "mustSurvive": true });
        let unsupported_bytes =
            serde_json::to_vec_pretty(&unsupported).expect("serialize unsupported manifest");
        fs::write(&manifest_path, &unsupported_bytes).expect("write unsupported manifest");

        let read_error = store
            .read(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect_err("unsupported manifest must fail closed");
        assert_eq!(read_error.code, "RECORDING_MANIFEST_SCHEMA_UNSUPPORTED");

        let listed = store.list().expect("list around unsupported manifest");
        assert_eq!(listed["recordingCount"], 0);
        assert_eq!(listed["quarantinedCount"], 1);
        assert_eq!(
            listed["quarantinedRecordings"][0]["reasonCode"],
            "RECORDING_MANIFEST_SCHEMA_UNSUPPORTED"
        );
        assert_eq!(
            fs::read(&manifest_path).expect("reread unsupported manifest"),
            unsupported_bytes
        );

        let recovered = store
            .recover()
            .expect("recover around unsupported manifest");
        assert_eq!(recovered["recoveredCount"], 0);
        assert_eq!(recovered["quarantinedCount"], 1);
        assert_eq!(
            fs::read(&manifest_path).expect("reread unsupported manifest after recovery"),
            unsupported_bytes
        );
    }

    #[test]
    fn unsafe_recording_ids_are_denied() {
        let store = temp_store();
        let error = store
            .finish(RecordingIdParams {
                recording_id: "../escape".to_string(),
            })
            .expect_err("unsafe id should fail");
        assert_eq!(error.code, "RECORDING_ID_INVALID");
    }

    #[test]
    fn finished_recording_delete_uses_tombstone_and_clears_content_free_metadata() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Delete me".to_string()),
            })
            .expect("start recording to delete");
        let recording_id = recording_id(&started);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "private meeting content".to_string(),
            })
            .expect("write recording to delete");
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish recording to delete");
        store
            .write_quarantine_receipt(&recording_id, "TEST_RECEIPT")
            .expect("seed quarantine metadata");
        let active_dir = store
            .recording_dir(&recording_id)
            .expect("active recording dir");
        let marker = store
            .deletion_pending_marker(&recording_id)
            .expect("pending marker");

        let removed = store
            .delete_finished(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("remove recording data");

        assert_eq!(removed["state"], "metadataCleanupPending");
        assert_eq!(removed["recordingDataRemoved"], true);
        assert!(!active_dir.exists());
        assert!(marker.is_file());
        assert_eq!(
            store.list().expect("list after delete")["recordingCount"],
            0
        );

        let completed = store
            .complete_deletion_metadata(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("complete delete metadata");
        assert_eq!(completed["state"], "deleted");
        assert_eq!(completed["deleted"], true);
        assert!(!marker.exists());
        assert!(!store
            .root
            .join(QUARANTINE_RECEIPTS_DIR)
            .join(format!("{recording_id}.json"))
            .exists());
    }

    #[test]
    fn deletion_rejects_recording_and_recovery_states() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start active recording");
        let recording_id = recording_id(&started);

        let active_error = store
            .delete_finished(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect_err("active recording delete must fail");
        assert_eq!(active_error.code, "RECORDING_DELETE_NOT_FINALIZED");
        store
            .mark_needs_recovery(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("mark recording for recovery");
        let recovery_error = store
            .delete_finished(RecordingIdParams { recording_id })
            .expect_err("recovery recording delete must fail");
        assert_eq!(recovery_error.code, "RECORDING_DELETE_NOT_FINALIZED");
    }

    #[test]
    fn incomplete_tombstone_removal_is_resumed_on_recovery() {
        let root = temp_store().root;
        let store = RecordingStore::with_root(root.clone());
        let started = store
            .start(StartRecordingParams {
                label: Some("Interrupted delete".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish recording");
        let failing_store = RecordingStore::with_root(root.clone()).with_failed_tombstone_removal();

        let incomplete = failing_store
            .delete_finished(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("return structured incomplete deletion");

        assert_eq!(incomplete["state"], "deletionIncomplete");
        assert_eq!(incomplete["retryRequired"], true);
        assert!(failing_store
            .deletion_tombstone_dir(&recording_id)
            .expect("tombstone path")
            .exists());
        assert_eq!(
            failing_store.list().expect("list after rename")["recordingCount"],
            0
        );

        let recovery_store = RecordingStore::with_root(root);
        let recovery = recovery_store.recover().expect("resume deletion");
        assert_eq!(recovery["completedDeletionCount"], 1);
        assert_eq!(recovery["completedDeletionIds"][0], recording_id);
        assert_eq!(recovery["pendingDeletionCount"], 0);
        assert!(!recovery_store
            .deletion_tombstone_dir(&recording_id)
            .expect("tombstone path")
            .exists());
    }

    #[test]
    fn synced_delete_intent_resumes_a_crash_before_the_rename() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Pre-rename crash".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish recording");
        let marker = store
            .deletion_pending_marker(&recording_id)
            .expect("pending marker");
        store
            .write_deletion_intent(&recording_id, &marker)
            .expect("write confirmed deletion intent");

        let recovery = store.recover().expect("resume pre-rename deletion");

        assert_eq!(recovery["completedDeletionIds"][0], recording_id);
        assert!(!store
            .recording_dir(&recording_id)
            .expect("active dir")
            .exists());
    }

    #[test]
    fn local_library_read_search_and_export_stay_pathless() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Strategy Sync".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);

        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "Focus on the core platform refresh.".to_string(),
            })
            .expect("write chunk");
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish");

        let list = store.list().expect("list");
        assert_eq!(list["rawPathExposed"], false);
        assert_eq!(list["recordingCount"], 1);
        assert_eq!(list["recordings"][0]["label"], "Strategy Sync");

        let read = store
            .read(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read");
        assert_eq!(read["rawPathExposed"], false);
        assert_eq!(read["chunks"][0]["rawPathExposed"], false);
        assert_eq!(
            read["chunks"][0]["textUtf8"],
            "Focus on the core platform refresh."
        );

        let search = store
            .search(SearchRecordingsParams {
                query: "platform".to_string(),
            })
            .expect("search");
        assert_eq!(search["rawPathExposed"], false);
        assert_eq!(search["matchCount"], 1);
        assert_eq!(search["matches"][0]["rawPathExposed"], false);
        assert!(search["matches"][0]["snippet"]
            .as_str()
            .expect("snippet")
            .contains("platform"));

        let export = store
            .export_markdown(ExportRecordingParams {
                recording_id,
                format: "markdown".to_string(),
                channel: None,
                report: None,
                options: ExportDocumentOptions::default(),
            })
            .expect("export");
        assert_eq!(export["rawPathExposed"], false);
        assert_eq!(export["keyMaterialExposedToRenderer"], false);
        assert_eq!(export["fileName"], "strategy-sync.md");
        assert!(export["markdown"]
            .as_str()
            .expect("markdown")
            .contains("Focus on the core platform refresh."));
    }

    #[test]
    fn search_skips_unreadable_recording_content_and_returns_healthy_matches() {
        let store = temp_store();
        let healthy = store
            .start(StartRecordingParams {
                label: Some("Healthy search".to_string()),
            })
            .expect("start healthy search recording");
        let healthy_id = recording_id(&healthy);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: healthy_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "platform decision".to_string(),
            })
            .expect("write healthy search chunk");
        store
            .finish(RecordingIdParams {
                recording_id: healthy_id.clone(),
            })
            .expect("finish healthy search recording");

        let unreadable_id = "unreadable-content";
        let unreadable_dir = store
            .recording_dir(unreadable_id)
            .expect("unreadable recording dir");
        fs::create_dir_all(&unreadable_dir).expect("create unreadable recording");
        let chunk_name = "chunk-000000.raw";
        fs::write(unreadable_dir.join(chunk_name), [0xff, 0xfe])
            .expect("write invalid UTF-8 chunk");
        let now = now_ms();
        write_manifest(
            &unreadable_dir,
            &RecordingManifest {
                schema_version: CURRENT_MANIFEST_SCHEMA_VERSION,
                recording_id: unreadable_id.to_string(),
                label: Some("Unreadable".to_string()),
                state: RecordingState::Finished,
                created_at_ms: now,
                updated_at_ms: now,
                chunks: vec![DurableChunk {
                    index: 0,
                    kind: DurableChunkKind::TranscriptText,
                    file_name: chunk_name.to_string(),
                    channel: "mic".to_string(),
                    bytes: 2,
                    stored_bytes: 2,
                    encrypted: false,
                    cipher: None,
                    speaker: None,
                    confidence: None,
                    sample_rate_hz: None,
                    channel_count: None,
                    bits_per_sample: None,
                    start_ms: None,
                    duration_ms: None,
                    created_at_ms: now,
                }],
                privacy_events: Vec::new(),
            },
        )
        .expect("write unreadable manifest");

        let searched = store
            .search(SearchRecordingsParams {
                query: "platform".to_string(),
            })
            .expect("search around unreadable content");

        assert_eq!(searched["matchCount"], 1);
        assert_eq!(searched["matches"][0]["recordingId"], healthy_id);
        assert_eq!(searched["quarantinedCount"], 1);
        assert!(store
            .root
            .join(QUARANTINE_RECEIPTS_DIR)
            .join(format!("{unreadable_id}.json"))
            .is_file());
    }

    #[test]
    fn meeting_notes_are_local_pathless_searchable_and_exported() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Notes Sync".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);

        let saved = store
            .save_notes(SaveNotesParams {
                recording_id: recording_id.clone(),
                markdown: "## Decisions\n\n- Keep the M3 notes local.".to_string(),
            })
            .expect("save notes");
        assert_eq!(saved["rawPathExposed"], false);
        assert_eq!(saved["keyMaterialExposedToRenderer"], false);
        assert_eq!(saved["savedLocally"], true);
        assert_eq!(saved["notesChunkCount"], 1);
        assert_eq!(
            saved["markdown"],
            "## Decisions\n\n- Keep the M3 notes local."
        );

        let read = store
            .read_notes(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read notes");
        assert_eq!(read["rawPathExposed"], false);
        assert_eq!(read["markdown"], saved["markdown"]);

        let search = store
            .search(SearchRecordingsParams {
                query: "M3 notes".to_string(),
            })
            .expect("search notes");
        assert_eq!(search["matchCount"], 1);
        assert_eq!(search["matches"][0]["channel"], "notes");

        let export = store
            .export_markdown(ExportRecordingParams {
                recording_id: recording_id.clone(),
                format: "markdown".to_string(),
                channel: None,
                report: None,
                options: ExportDocumentOptions::default(),
            })
            .expect("export");
        let markdown = export["markdown"].as_str().expect("markdown");
        assert!(markdown.contains("## Local Notes"));
        assert!(markdown.contains("Keep the M3 notes local."));

        let list = store.list().expect("list");
        assert_eq!(list["recordings"][0]["notesChunkCount"], 1);
        assert!(
            list["recordings"][0]["notesBytes"]
                .as_u64()
                .unwrap_or_default()
                > 0
        );
    }

    #[test]
    fn durable_audio_chunks_have_pathless_replay_and_readback() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Audio Replay".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let audio_bytes = vec![0_u8; 9_600];
        let audio_base64 = BASE64_STANDARD.encode(&audio_bytes);

        let written = store
            .write_audio_chunk(WriteAudioChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_base64: audio_base64.clone(),
                sample_rate_hz: 48_000,
                channel_count: 1,
                bits_per_sample: 16,
                start_ms: None,
            })
            .expect("write audio");
        assert_eq!(written["rawPathExposed"], false);
        assert_eq!(written["audioChunkCount"], 1);
        assert_eq!(written["audioDurationMs"], 100);

        let segment = store
            .write_transcript_segment(WriteTranscriptSegmentParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                speaker: Some("Alex".to_string()),
                text: "Reliability is our moat.".to_string(),
                start_ms: 10,
                duration_ms: Some(1200),
                end_ms: None,
                confidence: Some(0.95),
            })
            .expect("write transcript segment");
        assert_eq!(segment["rawPathExposed"], false);
        assert_eq!(segment["transcriptSegmentCount"], 1);

        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish");

        let replay = store
            .replay_manifest(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("replay manifest");
        assert_eq!(replay["rawPathExposed"], false);
        assert_eq!(replay["durationMs"], 100);
        assert_eq!(replay["audioChunks"][0]["kind"], "audioPcm16le");
        assert_eq!(replay["audioChunks"][0]["rawPathExposed"], false);
        assert_eq!(
            replay["audioChunks"][0]["readMethod"],
            "recording.durable.readAudioChunk"
        );
        assert_eq!(
            replay["transcriptReadMethod"],
            "recording.durable.transcript"
        );

        let transcript = store
            .transcript(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("transcript");
        assert_eq!(transcript["rawPathExposed"], false);
        assert_eq!(transcript["segmentCount"], 1);
        assert_eq!(transcript["segments"][0]["speaker"], "Alex");
        assert_eq!(transcript["segments"][0]["startMs"], 10);
        assert_eq!(transcript["segments"][0]["endMs"], 1210);
        assert_eq!(
            transcript["segments"][0]["text"],
            "Reliability is our moat."
        );

        let read = store
            .read(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read");
        assert_eq!(read["chunks"][0]["kind"], "audioPcm16le");
        assert_eq!(
            read["chunks"][0]["readMethod"],
            "recording.durable.readAudioChunk"
        );
        assert!(read["chunks"][0].get("dataBase64").is_none());
        assert_eq!(read["chunks"][1]["kind"], "transcriptSegment");
        assert_eq!(read["chunks"][1]["textUtf8"], "Reliability is our moat.");

        let audio = store
            .read_audio_chunk(AudioChunkParams {
                recording_id: recording_id.clone(),
                index: 0,
            })
            .expect("read audio");
        assert_eq!(audio["rawPathExposed"], false);
        assert_eq!(audio["keyMaterialExposedToRenderer"], false);
        assert_eq!(audio["dataBase64"], audio_base64);

        let export = store
            .export_markdown(ExportRecordingParams {
                recording_id: recording_id.clone(),
                format: "markdown".to_string(),
                channel: None,
                report: None,
                options: ExportDocumentOptions::default(),
            })
            .expect("export");
        assert!(export["markdown"]
            .as_str()
            .expect("markdown")
            .contains("Local Audio Replay Chunks"));
        assert!(export["markdown"]
            .as_str()
            .expect("markdown")
            .contains("Reliability is our moat."));

        let wav = store
            .export_create(ExportRecordingParams {
                recording_id,
                format: "wav".to_string(),
                channel: Some("mic".to_string()),
                report: None,
                options: ExportDocumentOptions::default(),
            })
            .expect("wav export");
        assert_eq!(wav["rawPathExposed"], false);
        assert_eq!(wav["keyMaterialExposedToRenderer"], false);
        assert_eq!(wav["format"], "wav");
        assert_eq!(wav["mimeType"], "audio/wav");
        assert_eq!(wav["durationMs"], 100);
        let bytes = BASE64_STANDARD
            .decode(wav["dataBase64"].as_str().expect("wav base64"))
            .expect("decode wav");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(bytes.len(), 44 + audio_bytes.len());
    }

    #[test]
    fn paged_library_and_transcript_reads_are_bounded() {
        let store = temp_store();
        for label in ["First", "Second", "Third"] {
            store
                .start(StartRecordingParams {
                    label: Some(label.to_string()),
                })
                .expect("start paged recording");
        }
        let first_page = store
            .list_page(RecordingPageParams {
                offset: 0,
                limit: 2,
            })
            .expect("first library page");
        assert_eq!(first_page["totalCount"], 3);
        assert_eq!(
            first_page["recordings"]
                .as_array()
                .expect("recordings")
                .len(),
            2
        );
        assert_eq!(first_page["hasMore"], true);

        let recording_id = first_page["recordings"][0]["recordingId"]
            .as_str()
            .expect("recording id")
            .to_string();
        for index in 0..3_u64 {
            store
                .write_transcript_segment(WriteTranscriptSegmentParams {
                    recording_id: recording_id.clone(),
                    channel: "mic".to_string(),
                    speaker: Some("Me".to_string()),
                    text: format!("Segment {index}"),
                    start_ms: index * 1_000,
                    duration_ms: Some(500),
                    end_ms: None,
                    confidence: Some(0.9),
                })
                .expect("write transcript segment");
        }
        let transcript_page = store
            .transcript_page(TranscriptPageParams {
                recording_id,
                offset: 1,
                limit: 1,
            })
            .expect("transcript page");
        assert_eq!(transcript_page["segmentCount"], 3);
        assert_eq!(transcript_page["segments"][0]["text"], "Segment 1");
        assert_eq!(transcript_page["hasMore"], true);
    }

    #[test]
    fn meeting_privacy_receipt_is_core_backed_and_pathless() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Receipt Test".to_string()),
            })
            .expect("start receipt recording");
        let recording_id = recording_id(&started);
        store
            .write_audio_chunk(WriteAudioChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_base64: BASE64_STANDARD.encode(vec![0_u8; 9_600]),
                sample_rate_hz: 48_000,
                channel_count: 1,
                bits_per_sample: 16,
                start_ms: Some(0),
            })
            .expect("write receipt audio");
        store
            .write_transcript_segment(WriteTranscriptSegmentParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                speaker: Some("Me".to_string()),
                text: "Receipt transcript".to_string(),
                start_ms: 0,
                duration_ms: Some(500),
                end_ms: None,
                confidence: Some(0.9),
            })
            .expect("write receipt transcript");
        store
            .save_notes(SaveNotesParams {
                recording_id: recording_id.clone(),
                markdown: "Receipt notes".to_string(),
            })
            .expect("save receipt notes");
        store
            .record_processing_fact(
                &recording_id,
                "transcription",
                "whisper-rs",
                Some("tiny.en"),
                Some("a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"),
            )
            .expect("record transcription fact");
        store
            .record_processing_fact(
                &recording_id,
                "local-ai-recap",
                "heuristic-local",
                None,
                None,
            )
            .expect("record recap fact");
        store
            .export_create(ExportRecordingParams {
                recording_id: recording_id.clone(),
                format: "markdown".to_string(),
                channel: None,
                report: None,
                options: ExportDocumentOptions::default(),
            })
            .expect("record receipt export");

        let receipt = store
            .privacy_receipt(RecordingIdParams { recording_id })
            .expect("privacy receipt");
        assert_eq!(receipt["proofKind"], "meeting-privacy-receipt");
        assert_eq!(receipt["capture"]["channels"][0], "mic");
        assert_eq!(receipt["content"]["transcriptSegmentCount"], 1);
        assert_eq!(receipt["content"]["notesSavedLocally"], true);
        assert_eq!(
            receipt["processing"].as_array().expect("processing").len(),
            2
        );
        assert_eq!(receipt["exports"].as_array().expect("exports").len(), 1);
        assert_eq!(receipt["rawPathExposed"], false);
        assert_eq!(receipt["keyMaterialExposedToRenderer"], false);
    }

    #[test]
    fn v1_manifest_privacy_migration_is_backward_compatible() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Legacy".to_string()),
            })
            .expect("start legacy recording");
        let recording_id = recording_id(&started);
        let dir = store
            .recording_dir(&recording_id)
            .expect("legacy recording dir");
        let mut manifest: Value = serde_json::from_slice(
            &fs::read(dir.join(MANIFEST_FILE)).expect("read legacy manifest"),
        )
        .expect("parse legacy manifest");
        manifest["schemaVersion"] = json!(1);
        manifest
            .as_object_mut()
            .expect("manifest object")
            .remove("privacyEvents");
        fs::write(
            dir.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).expect("serialize legacy manifest"),
        )
        .expect("write legacy manifest");

        let receipt = store
            .privacy_receipt(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read v1 privacy receipt");
        assert_eq!(
            receipt["processing"].as_array().expect("processing").len(),
            0
        );
        store
            .record_processing_fact(&recording_id, "local-ai-ask", "heuristic-local", None, None)
            .expect("upgrade privacy event");
        let upgraded: Value = serde_json::from_slice(
            &fs::read(dir.join(MANIFEST_FILE)).expect("read upgraded manifest"),
        )
        .expect("parse upgraded manifest");
        assert_eq!(upgraded["schemaVersion"], 2);
        assert_eq!(
            upgraded["privacyEvents"]
                .as_array()
                .expect("privacy events")
                .len(),
            1
        );
    }

    #[test]
    fn interrupted_manifest_swap_recovers_the_last_flushed_manifest() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Recover swap".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let dir = store.recording_dir(&recording_id).expect("recording dir");
        let manifest_path = dir.join(MANIFEST_FILE);
        let backup_path = dir.join("manifest.json.bak");
        let tmp_path = dir.join("manifest.json.tmp");

        fs::rename(&manifest_path, &backup_path).expect("simulate interrupted backup swap");
        fs::write(&tmp_path, b"partial manifest").expect("write partial temp manifest");

        let recovered = read_manifest(&dir).expect("recover backup manifest");
        assert_eq!(recovered.recording_id, recording_id);
        assert_eq!(recovered.label.as_deref(), Some("Recover swap"));
    }

    #[test]
    fn corrupt_primary_manifest_rolls_back_to_valid_backup() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Rollback manifest".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let dir = store.recording_dir(&recording_id).expect("recording dir");
        let manifest_path = dir.join(MANIFEST_FILE);
        fs::copy(&manifest_path, dir.join("manifest.json.bak")).expect("copy manifest backup");
        fs::write(&manifest_path, b"corrupt primary").expect("corrupt primary manifest");

        let recovered = read_manifest(&dir).expect("fall back to backup manifest");
        assert_eq!(recovered.recording_id, recording_id);
        assert_eq!(recovered.label.as_deref(), Some("Rollback manifest"));
    }

    #[test]
    fn audio_storage_failure_does_not_commit_a_manifest_chunk() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Storage pressure".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let dir = store.recording_dir(&recording_id).expect("recording dir");
        fs::create_dir(dir.join("chunk-000000.raw")).expect("block plaintext chunk path");
        fs::create_dir(dir.join("chunk-000000.cchunk")).expect("block encrypted chunk path");

        let error = store
            .write_audio_chunk(WriteAudioChunkParams {
                recording_id,
                channel: "mic".to_string(),
                data_base64: BASE64_STANDARD.encode(vec![0_u8; 9_600]),
                sample_rate_hz: 48_000,
                channel_count: 1,
                bits_per_sample: 16,
                start_ms: Some(0),
            })
            .expect_err("chunk creation should fail");
        assert_eq!(error.code, "RECORDING_CHUNK_CREATE_FAILED");
        let manifest = read_manifest(&dir).expect("read unchanged manifest");
        assert!(manifest.chunks.is_empty());
    }

    #[test]
    fn storage_health_is_pathless_and_distinguishes_ok_low_blocking_and_unavailable() {
        let root = temp_store().root;
        let ok = RecordingStore::with_root(root.join("ok"))
            .with_available_space(LOW_DISK_THRESHOLD_BYTES);
        let low = RecordingStore::with_root(root.join("low"))
            .with_available_space(CAPTURE_START_RESERVE_BYTES);
        let blocking = RecordingStore::with_root(root.join("blocking"))
            .with_available_space(CAPTURE_START_RESERVE_BYTES - 1);
        let unavailable =
            RecordingStore::with_root(root.join("unavailable")).with_failed_space_probe();

        assert_eq!(ok.storage_health()["level"], "ok");
        assert_eq!(ok.storage_health()["canStartRecording"], true);
        assert_eq!(low.storage_health()["level"], "low");
        assert_eq!(low.storage_health()["canStartRecording"], true);
        assert_eq!(blocking.storage_health()["level"], "blocking");
        assert_eq!(blocking.storage_health()["canStartRecording"], false);
        assert_eq!(blocking.storage_health()["rawPathExposed"], false);
        assert_eq!(unavailable.storage_health()["level"], "unavailable");
        assert_eq!(unavailable.storage_health()["canStartRecording"], false);
        assert_eq!(
            unavailable.storage_health()["errorCode"],
            "RECORDING_STORAGE_PROBE_FAILED"
        );
    }

    #[test]
    fn filesystem_space_probe_reads_the_temporary_volume_without_paths() {
        let root = env::temp_dir().join(format!("candor-storage-probe-{}", new_recording_id()));
        let store = RecordingStore {
            root: root.clone(),
            root_kind: "test-root",
            available_space_override: None,
            fail_space_probe: false,
            fail_tombstone_removal: false,
        };

        let health = store.storage_health();

        assert_ne!(health["level"], "unavailable");
        assert!(health["availableBytes"].as_u64().is_some());
        assert_eq!(health["rawPathExposed"], false);
        assert!(health.get("path").is_none());
        fs::remove_dir_all(root).expect("remove temporary storage probe root");
    }

    #[test]
    fn capture_start_is_blocked_below_reserve_without_creating_a_recording() {
        let store = temp_store().with_available_space(CAPTURE_START_RESERVE_BYTES - 1);

        let error = store
            .start(StartRecordingParams {
                label: Some("must not start".to_string()),
            })
            .expect_err("low storage must block capture start");

        assert_eq!(error.code, "RECORDING_STORAGE_START_BLOCKED");
        assert!(!store.recordings_root().exists());
    }

    #[test]
    fn blocked_chunk_write_preserves_the_last_committed_manifest() {
        let root = temp_store().root;
        let healthy_store =
            RecordingStore::with_root(root.clone()).with_available_space(LOW_DISK_THRESHOLD_BYTES);
        let started = healthy_store
            .start(StartRecordingParams {
                label: Some("storage boundary".to_string()),
            })
            .expect("start before storage pressure");
        let recording_id = recording_id(&started);
        let dir = healthy_store
            .recording_dir(&recording_id)
            .expect("recording dir");
        let manifest_before = fs::read(dir.join(MANIFEST_FILE)).expect("read committed manifest");
        let pressured_store =
            RecordingStore::with_root(root).with_available_space(CHUNK_WRITE_RESERVE_BYTES);

        let error = pressured_store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "must not be partially committed".to_string(),
            })
            .expect_err("chunk must stop before storage reserve");

        assert_eq!(error.code, "RECORDING_STORAGE_WRITE_BLOCKED");
        assert_eq!(
            fs::read(dir.join(MANIFEST_FILE)).expect("reread committed manifest"),
            manifest_before
        );
        assert!(!dir.join("chunk-000000.raw").exists());
        assert!(!dir.join("chunk-000000.cchunk").exists());
        let manifest = read_manifest(&dir).expect("read preserved manifest");
        assert_eq!(manifest.state, RecordingState::Recording);
        assert!(manifest.chunks.is_empty());
    }

    #[test]
    fn failed_space_probe_blocks_start_without_exposing_a_path() {
        let store = temp_store().with_failed_space_probe();
        let health = store.storage_health();

        let error = store
            .start(StartRecordingParams { label: None })
            .expect_err("unknown storage must fail closed");

        assert_eq!(error.code, "RECORDING_STORAGE_PROBE_FAILED");
        assert_eq!(health["rawPathExposed"], false);
        assert!(health.get("path").is_none());
    }

    #[test]
    fn storage_creation_failure_is_explicit_and_leaves_no_manifest() {
        let root = env::temp_dir().join(format!(
            "candor-core-storage-failure-{}",
            new_recording_id()
        ));
        fs::write(&root, b"not a directory").expect("create blocking file");
        let store = RecordingStore::with_root(root.clone());
        let error = store
            .start(StartRecordingParams { label: None })
            .expect_err("storage creation should fail");
        assert_eq!(error.code, "RECORDING_STORE_CREATE_FAILED");
        assert!(!root.join(RECORDINGS_DIR).join(MANIFEST_FILE).exists());
        fs::remove_file(root).expect("remove blocking file");
    }
}
