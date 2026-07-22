use std::collections::HashSet;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as UnixOpenOptionsExt;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt as WindowsOpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process;
#[cfg(feature = "sqlcipher-vault")]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::meeting_profiles::MeetingProcessingProfileSnapshot;
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
use sha2::{Digest, Sha256};

#[cfg(feature = "sqlcipher-vault")]
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};

const MANIFEST_FILE: &str = "manifest.json";
const RECORDINGS_DIR: &str = "recordings";
const QUARANTINE_RECEIPTS_DIR: &str = "recovery/quarantine";
const DELETION_DATA_DIR: &str = "deletions/data";
const DELETION_PENDING_DIR: &str = "deletions/pending";
// Schema 3 added durable transcription-attempt membership. Schema 4 adds
// encrypted raw, pre-normalization transcript chunks referenced by immutable
// revisions. Older binaries must reject schema 4 instead of misclassifying
// those internal chunks as ordinary transcript content.
const CURRENT_MANIFEST_SCHEMA_VERSION: u32 = 5;
const ENCRYPTED_CHUNK_MAGIC: &[u8] = b"CANDORCHUNK1\n";
const ENCRYPTED_CHUNK_EXT: &str = ".cchunk";
const PLAINTEXT_CHUNK_EXT: &str = ".raw";
const TRANSCRIPTION_ATTEMPT_FILE_MARKER: &str = "-attempt-";
const RAW_TRANSCRIPT_FILE_MARKER: &str = "-raw-transcript";
const RECORDING_CHUNK_KEY_LABEL: &[u8] = b"recording-chunk-v1";
const MAX_DURABLE_CHUNK_BYTES: usize = 512 * 1024;
const MAX_ENCRYPTED_DURABLE_CHUNK_BYTES: u64 =
    (MAX_DURABLE_CHUNK_BYTES + ENCRYPTED_CHUNK_MAGIC.len() + 12 + 16) as u64;
const COMBINED_TRANSCRIPTION_CHANNEL: &str = "combined";
const MAX_COMBINED_TRANSCRIPTION_CHANNELS: usize = 8;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RAW_TRANSCRIPT_BYTES: usize = 16 * 1024 * 1024;
const MAX_COMPARISON_TEXT_BYTES_PER_SIDE: usize = 64 * 1024;
const MAX_REVISION_DETAIL_SEGMENTS: usize = MAX_PAGE_LIMIT as usize;
const MAX_REVISION_DETAIL_SEGMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_NOTES_MARKDOWN_BYTES: usize = 512 * 1024;
const MAX_DOCUMENT_EXPORT_BYTES: usize = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_REVISIONS: usize = 512;
const MAX_PROCESSING_RECEIPTS: usize = 2_048;
const MAX_REVISION_CHUNK_INDICES: usize = 100_000;
const MAX_SEARCH_MATCHES: usize = 500;
const MAX_AUTOMATION_LIST_SCAN_RECORDINGS: usize = 2_000;
const MAX_AUTOMATION_LIST_DIRECTORY_ENTRIES: usize = 4_000;
const MAX_AUTOMATION_LIST_CHUNK_DESCRIPTORS: usize = 100_000;
const MAX_AUTOMATION_LIST_MANIFEST_BYTES_TOTAL: u64 = 32 * 1024 * 1024;
const MAX_AUTOMATION_QUARANTINE_DETAILS: usize = 100;
const MAX_AUTOMATION_LIST_PAGE_RECORDINGS: usize = 50;
const MAX_AUTOMATION_LIST_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_AUTOMATION_SEARCHABLE_RECORDINGS: usize = 100;
const MAX_AUTOMATION_SEARCH_DIRECTORY_ENTRIES: usize = 2_000;
const MAX_AUTOMATION_SEARCHABLE_CHUNK_DESCRIPTORS: usize = 50_000;
const MAX_AUTOMATION_SEARCHABLE_MANIFEST_BYTES_TOTAL: u64 = 16 * 1024 * 1024;
const MAX_AUTOMATION_SEARCHABLE_ROWS: usize = 50_000;
const MAX_AUTOMATION_SEARCHABLE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_AUTOMATION_SEARCH_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_AUTOMATION_TRANSCRIPT_PAGE_SEGMENTS: usize = 50;
const MAX_AUTOMATION_TRANSCRIPT_SEGMENT_RESPONSE_BYTES: usize = 4 * 1024;
const MAX_AUTOMATION_TRANSCRIPT_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_AUTOMATION_LABEL_RESPONSE_BYTES: usize = 256;
const MAX_AUTOMATION_CHANNEL_RESPONSE_BYTES: usize = 32;
const MAX_AUTOMATION_SPEAKER_RESPONSE_BYTES: usize = 128;
#[cfg(feature = "sqlcipher-vault")]
const MAX_SEARCHABLE_ROWS: usize = 100_000;
#[cfg(feature = "sqlcipher-vault")]
const MAX_SEARCHABLE_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(feature = "sqlcipher-vault")]
const MAX_SEARCHABLE_RECORDINGS: usize = 10_000;
#[cfg(feature = "sqlcipher-vault")]
const MAX_SEARCHABLE_CHUNK_DESCRIPTORS: usize = 100_000;
#[cfg(feature = "sqlcipher-vault")]
const MAX_SEARCHABLE_MANIFEST_BYTES_TOTAL: u64 = 64 * 1024 * 1024;
#[cfg(not(feature = "sqlcipher-vault"))]
const MAX_FALLBACK_SEARCHABLE_ROWS: usize = 64;
#[cfg(not(feature = "sqlcipher-vault"))]
const MAX_FALLBACK_SEARCHABLE_BYTES: u64 = 2 * 1024 * 1024;
#[cfg(not(feature = "sqlcipher-vault"))]
const MAX_FALLBACK_SEARCHABLE_RECORDINGS: usize = 64;
const TRUST_SEARCH_DIR: &str = "search";
#[cfg(any(feature = "sqlcipher-vault", test))]
const TRUST_SEARCH_FILE: &str = "trust-history.sqlcipher";
#[cfg(feature = "sqlcipher-vault")]
const TRUST_SEARCH_SCHEMA_VERSION: i64 = 2;
#[cfg(all(feature = "sqlcipher-vault", not(test)))]
const TRUST_SEARCH_INVALIDATION_WAIT_MS: u64 = 5_000;
#[cfg(all(feature = "sqlcipher-vault", test))]
const TRUST_SEARCH_INVALIDATION_WAIT_MS: u64 = 1_000;
#[cfg(feature = "sqlcipher-vault")]
const TRUST_SEARCH_INVALIDATION_POLL_MS: u64 = 5;
const DEFAULT_PAGE_LIMIT: u64 = 50;
const MAX_PAGE_LIMIT: u64 = 500;
const LOW_DISK_THRESHOLD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const CAPTURE_START_RESERVE_BYTES: u64 = 512 * 1024 * 1024;
const CHUNK_WRITE_RESERVE_BYTES: u64 = 64 * 1024 * 1024;
const MANIFEST_WRITE_HEADROOM_BYTES: u64 = 1024 * 1024;
static NEXT_RECORDING_ID_SUFFIX: AtomicU64 = AtomicU64::new(1);
static NEXT_TRANSCRIPTION_ATTEMPT_SUFFIX: AtomicU64 = AtomicU64::new(1);

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

#[cfg(feature = "sqlcipher-vault")]
#[derive(Clone, Debug)]
struct TrustSearchBackfillFailure {
    code: &'static str,
    message: &'static str,
}

#[cfg(feature = "sqlcipher-vault")]
impl TrustSearchBackfillFailure {
    fn from_error(error: &RecordingStoreError) -> Self {
        match error.code {
            "OS_KEY_NOT_FOUND" | "OS_KEY_READ_FAILED" | "OS_KEY_UNPROTECT_FAILED" => Self {
                code: "TRUST_SEARCH_KEY_UNAVAILABLE",
                message: "encrypted local search could not access its device-protected key",
            },
            "TRUST_SEARCH_SQLCIPHER_UNAVAILABLE" => Self {
                code: "TRUST_SEARCH_SQLCIPHER_UNAVAILABLE",
                message: "encrypted local search requires SQLCipher in this core build",
            },
            _ => Self {
                code: "TRUST_SEARCH_BACKFILL_FAILED",
                message: "encrypted local search could not prepare its local index",
            },
        }
    }

    fn as_error(&self) -> RecordingStoreError {
        RecordingStoreError::new(self.code, self.message)
    }
}

#[derive(Clone, Debug)]
pub struct RecordingStore {
    root: PathBuf,
    root_kind: &'static str,
    /// Serializes every complete manifest mutation transaction across clones.
    ///
    /// A mutation must hold this guard from its first manifest read through
    /// any durable chunk write and the final atomic manifest replacement. A
    /// store-wide lock is deliberately used here because clones are handed to
    /// capture, transcription, and main-process workers, and correctness is
    /// more important than parallel metadata writes across meetings.
    manifest_mutation_lock: Arc<Mutex<()>>,
    #[cfg(feature = "sqlcipher-vault")]
    trust_search_lock: Arc<Mutex<()>>,
    #[cfg(feature = "sqlcipher-vault")]
    trust_search_source_generation: Arc<AtomicU64>,
    #[cfg(feature = "sqlcipher-vault")]
    trust_search_index_generation: Arc<AtomicU64>,
    #[cfg(feature = "sqlcipher-vault")]
    trust_search_backfill_running: Arc<AtomicBool>,
    #[cfg(feature = "sqlcipher-vault")]
    trust_search_backfill_failure: Arc<Mutex<Option<TrustSearchBackfillFailure>>>,
    #[cfg(test)]
    available_space_override: Option<u64>,
    #[cfg(test)]
    fail_space_probe: bool,
    #[cfg(test)]
    fail_tombstone_removal: bool,
    #[cfg(test)]
    fail_finish: bool,
    #[cfg(test)]
    fail_abort_unfinished: bool,
    #[cfg(test)]
    fail_transcription_commit: bool,
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
pub struct TranscriptRevisionParams {
    pub recording_id: String,
    pub revision_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReprocessingPrepareParams {
    pub recording_id: String,
    #[serde(default)]
    pub channel: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct TranscriptComparisonDraft {
    pub(crate) raw_text_sha256: String,
    pub(crate) normalized_text_sha256: String,
    pub(crate) raw_text_bytes: u64,
    pub(crate) normalized_text_bytes: u64,
    pub(crate) raw_segment_count: u64,
    pub(crate) normalized_segment_count: u64,
    pub(crate) changed: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct TranscriptionSuccessDraft {
    pub(crate) recording_id: String,
    /// A local Whisper attempt owns every segment it writes. The attempt id is
    /// resolved against durable chunk metadata at commit time so chunks from a
    /// failed or cancelled attempt can never be swept into a later revision.
    pub(crate) attempt_id: Option<String>,
    /// Retained only for legacy/import-style internal callers that commit
    /// already-durable, non-attempt transcript segments.
    pub(crate) chunk_indices: Vec<u32>,
    pub(crate) engine: String,
    pub(crate) model_id: Option<String>,
    pub(crate) model_sha256: Option<String>,
    pub(crate) started_at_ms: u128,
    pub(crate) elapsed_ms: u64,
    pub(crate) comparison: TranscriptComparisonDraft,
    /// Core-internal raw Whisper output captured before trimming and
    /// deterministic replacement rules. This value is never serialized into
    /// a job result, receipt, log, or renderer-facing history list.
    pub(crate) raw_text: String,
}

#[derive(Clone, Debug)]
pub(crate) struct TranscriptionFailureDraft {
    pub(crate) recording_id: String,
    pub(crate) engine: String,
    pub(crate) model_id: Option<String>,
    pub(crate) started_at_ms: u128,
    pub(crate) elapsed_ms: u64,
    pub(crate) error_code: String,
    pub(crate) cancelled: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct CleanupSuccessDraft {
    pub(crate) recording_id: String,
    pub(crate) attempt_id: String,
    pub(crate) parent_revision_id: String,
    pub(crate) engine: String,
    pub(crate) model_id: String,
    pub(crate) model_sha256: String,
    pub(crate) prompt_template_sha256: String,
    pub(crate) started_at_ms: u128,
    pub(crate) elapsed_ms: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct CleanupFailureDraft {
    pub(crate) recording_id: String,
    pub(crate) parent_revision_id: String,
    pub(crate) engine: String,
    pub(crate) model_id: Option<String>,
    pub(crate) model_sha256: Option<String>,
    pub(crate) prompt_template_sha256: String,
    pub(crate) started_at_ms: u128,
    pub(crate) elapsed_ms: u64,
    pub(crate) error_code: String,
    pub(crate) cancelled: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct RecapReceiptDraft {
    pub(crate) recording_id: String,
    pub(crate) input_revision_id: String,
    pub(crate) engine: String,
    pub(crate) model_id: Option<String>,
    pub(crate) model_sha256: Option<String>,
    pub(crate) prompt_template_sha256: String,
    pub(crate) validation_result: String,
    pub(crate) fallback_applied: bool,
    pub(crate) started_at_ms: u128,
    pub(crate) elapsed_ms: u64,
}

#[derive(Clone, Debug)]
enum TranscriptCommitKind {
    Transcription,
    ProtectedTermReview {
        expected_current_revision_id: String,
    },
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
    /// Hash of the plaintext bytes captured before at-rest encryption. New
    /// audio chunks carry this value so a reprocessing request can be planned
    /// from bounded manifest metadata while the background transcription job
    /// performs the actual chunk reads and integrity checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_sha256: Option<String>,
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
    /// Present only while/after a core-owned local transcription attempt.
    /// Attempt chunks are excluded from every content surface until an
    /// immutable transcript revision references them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transcription_attempt_id: Option<String>,
    created_at_ms: u128,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum DurableChunkKind {
    TranscriptText,
    TranscriptSegment,
    RawTranscriptText,
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
    #[serde(default)]
    transcript_revisions: Vec<TranscriptRevision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    current_transcript_revision_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    current_cleaned_revision_id: Option<String>,
    #[serde(default)]
    processing_receipts: Vec<ProcessingReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    processing_profile: Option<MeetingProcessingProfileSnapshot>,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum TranscriptRevisionKind {
    RawAsr,
    Normalized,
    AiCleaned,
    #[default]
    Legacy,
}

impl TranscriptRevisionKind {
    fn label(self) -> &'static str {
        match self {
            Self::RawAsr => "raw-asr",
            Self::Normalized => "normalized",
            Self::AiCleaned => "ai-cleaned",
            Self::Legacy => "legacy",
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TranscriptRevision {
    revision_id: String,
    version: u32,
    source: String,
    #[serde(default)]
    kind: TranscriptRevisionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_revision_id: Option<String>,
    chunk_indices: Vec<u32>,
    engine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_sha256: Option<String>,
    /// `None` identifies a legacy revision created before schema 4. `Some`
    /// identifies a captured raw transcript, including `Some([])` for an
    /// intentionally empty raw output. Indices are never sent to the renderer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    raw_text_chunk_indices: Option<Vec<u32>>,
    comparison: TranscriptComparisonMetadata,
    created_at_ms: u128,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TranscriptComparisonMetadata {
    raw_text_sha256: String,
    normalized_text_sha256: String,
    raw_text_bytes: u64,
    normalized_text_bytes: u64,
    raw_segment_count: u64,
    normalized_segment_count: u64,
    changed: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ProcessingOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProcessingReceipt {
    receipt_id: String,
    attempt: u32,
    operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stage: Option<String>,
    outcome: ProcessingOutcome,
    engine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revision_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_revision_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_revision_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt_template_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    validation_result: Option<String>,
    #[serde(default)]
    fallback_applied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    comparison: Option<TranscriptComparisonMetadata>,
    started_at_ms: u128,
    finished_at_ms: u128,
    elapsed_ms: u64,
}

#[derive(Debug)]
struct RecordingManifestCollection {
    items: Vec<(RecordingManifest, PathBuf)>,
    quarantined: Vec<Value>,
}

#[derive(Debug)]
struct BoundedReadOnlyManifestCollection {
    collection: RecordingManifestCollection,
    source_truncated: bool,
    inspected_directory_entries: usize,
    manifest_bytes_read: u64,
    quarantined_count: u64,
}

#[derive(Debug)]
struct ReadOnlyListCandidate {
    recording_id: String,
    directory: PathBuf,
    modified_at_ns: u128,
}

#[derive(Debug)]
struct BoundedReadOnlyListCandidates {
    candidates: Vec<ReadOnlyListCandidate>,
    source_truncated: bool,
    inspected_directory_entries: usize,
    quarantined: Vec<Value>,
    quarantined_count: u64,
    quarantine_details_truncated: bool,
}

#[derive(Debug)]
struct SearchableTextRow {
    recording_id: String,
    label: Option<String>,
    state: &'static str,
    chunk_index: u32,
    channel: String,
    row_kind: &'static str,
    text: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ai_provenance: Option<AiPrivacyProvenance>,
    created_at_ms: u128,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiPrivacyProvenance {
    engine: String,
    model_id: Option<String>,
    fallback_used: bool,
    fallback_reason: Option<String>,
    prompt_version: String,
    generated_at: String,
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
                    manifest_mutation_lock: Arc::new(Mutex::new(())),
                    #[cfg(feature = "sqlcipher-vault")]
                    trust_search_lock: Arc::new(Mutex::new(())),
                    #[cfg(feature = "sqlcipher-vault")]
                    trust_search_source_generation: Arc::new(AtomicU64::new(1)),
                    #[cfg(feature = "sqlcipher-vault")]
                    trust_search_index_generation: Arc::new(AtomicU64::new(0)),
                    #[cfg(feature = "sqlcipher-vault")]
                    trust_search_backfill_running: Arc::new(AtomicBool::new(false)),
                    #[cfg(feature = "sqlcipher-vault")]
                    trust_search_backfill_failure: Arc::new(Mutex::new(None)),
                    #[cfg(test)]
                    available_space_override: None,
                    #[cfg(test)]
                    fail_space_probe: false,
                    #[cfg(test)]
                    fail_tombstone_removal: false,
                    #[cfg(test)]
                    fail_finish: false,
                    #[cfg(test)]
                    fail_abort_unfinished: false,
                    #[cfg(test)]
                    fail_transcription_commit: false,
                };
            }
        }

        Self {
            root: default_data_root(),
            root_kind: "local-user-data",
            manifest_mutation_lock: Arc::new(Mutex::new(())),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_lock: Arc::new(Mutex::new(())),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_source_generation: Arc::new(AtomicU64::new(1)),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_index_generation: Arc::new(AtomicU64::new(0)),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_backfill_running: Arc::new(AtomicBool::new(false)),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_backfill_failure: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            available_space_override: None,
            #[cfg(test)]
            fail_space_probe: false,
            #[cfg(test)]
            fail_tombstone_removal: false,
            #[cfg(test)]
            fail_finish: false,
            #[cfg(test)]
            fail_abort_unfinished: false,
            #[cfg(test)]
            fail_transcription_commit: false,
        }
    }

    #[cfg(test)]
    pub fn with_root(root: PathBuf) -> Self {
        Self {
            root,
            root_kind: "test-root",
            manifest_mutation_lock: Arc::new(Mutex::new(())),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_lock: Arc::new(Mutex::new(())),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_source_generation: Arc::new(AtomicU64::new(1)),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_index_generation: Arc::new(AtomicU64::new(0)),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_backfill_running: Arc::new(AtomicBool::new(false)),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_backfill_failure: Arc::new(Mutex::new(None)),
            available_space_override: Some(u64::MAX),
            fail_space_probe: false,
            fail_tombstone_removal: false,
            fail_finish: false,
            fail_abort_unfinished: false,
            fail_transcription_commit: false,
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

    #[cfg(test)]
    pub(crate) fn with_failed_finish(mut self) -> Self {
        self.fail_finish = true;
        self
    }

    #[cfg(test)]
    pub(crate) fn with_failed_abort_unfinished(mut self) -> Self {
        self.fail_abort_unfinished = true;
        self
    }

    #[cfg(test)]
    fn with_failed_transcription_commit(mut self) -> Self {
        self.fail_transcription_commit = true;
        self
    }

    fn manifest_mutation_guard(&self) -> MutexGuard<'_, ()> {
        self.manifest_mutation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn trust_search_invalidation_guard(&self) -> Option<MutexGuard<'_, ()>> {
        let started = std::time::Instant::now();
        loop {
            match self.trust_search_lock.try_lock() {
                Ok(guard) => return Some(guard),
                Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                    return Some(poisoned.into_inner());
                }
                Err(std::sync::TryLockError::WouldBlock)
                    if started.elapsed()
                        >= std::time::Duration::from_millis(TRUST_SEARCH_INVALIDATION_WAIT_MS) =>
                {
                    return None;
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(std::time::Duration::from_millis(
                        TRUST_SEARCH_INVALIDATION_POLL_MS,
                    ));
                }
            }
        }
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
            "transcriptRevisions": true,
            "processingReceipts": true,
            "reprocessingFromOriginalAudio": true,
            "searchBackend": if cfg!(feature = "sqlcipher-vault") { "sqlcipher-fts5-query-only" } else { "strictly-bounded-memory-scan" },
            "plaintextSearchIndexPersisted": false,
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

    pub(crate) fn local_data_root_for_core(&self) -> PathBuf {
        self.root.clone()
    }

    pub fn start(&self, params: StartRecordingParams) -> Result<Value, RecordingStoreError> {
        self.start_with_processing_profile(params, None)
    }

    pub(crate) fn start_with_processing_profile(
        &self,
        params: StartRecordingParams,
        processing_profile: Option<MeetingProcessingProfileSnapshot>,
    ) -> Result<Value, RecordingStoreError> {
        let _mutation_guard = self.manifest_mutation_guard();
        self.ensure_capture_start_space()?;
        if let Some(profile) = &processing_profile {
            profile
                .validate()
                .map_err(|error| RecordingStoreError::new(error.code, error.message))?;
        }
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
            transcript_revisions: Vec::new(),
            current_transcript_revision_id: None,
            current_cleaned_revision_id: None,
            processing_receipts: Vec::new(),
            processing_profile,
        };
        write_manifest(&dir, &manifest)?;

        Ok(recording_summary(&manifest, self.root_kind))
    }

    pub(crate) fn processing_profile(
        &self,
        recording_id: &str,
    ) -> Result<Option<MeetingProcessingProfileSnapshot>, RecordingStoreError> {
        validate_id(recording_id)?;
        let dir = self.recording_dir(recording_id)?;
        if !dir.exists() {
            return Err(RecordingStoreError::new(
                "RECORDING_NOT_FOUND",
                "the local recording was not found",
            ));
        }
        Ok(read_manifest(&dir)?.processing_profile)
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

        let _mutation_guard = self.manifest_mutation_guard();
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
            content_sha256: None,
            speaker: None,
            confidence: None,
            sample_rate_hz: None,
            channel_count: None,
            bits_per_sample: None,
            start_ms: None,
            duration_ms: None,
            transcription_attempt_id: None,
            created_at_ms: now_ms(),
        });
        manifest.updated_at_ms = now_ms();
        write_manifest(&dir, &manifest)?;
        #[cfg(feature = "sqlcipher-vault")]
        self.committed_trust_search_source_change();

        Ok(recording_summary(&manifest, self.root_kind))
    }

    pub fn write_transcript_segment(
        &self,
        params: WriteTranscriptSegmentParams,
    ) -> Result<Value, RecordingStoreError> {
        self.write_transcript_segment_inner(params, None)
    }

    pub(crate) fn begin_transcription_attempt(
        &self,
        recording_id: &str,
    ) -> Result<String, RecordingStoreError> {
        validate_id(recording_id)?;
        let dir = self.recording_dir(recording_id)?;
        let manifest = read_manifest(&dir)?;
        if manifest.state == RecordingState::NeedsRecovery {
            return Err(RecordingStoreError::new(
                "RECORDING_NEEDS_RECOVERY",
                "recording must be recovered before local transcription can begin",
            ));
        }
        if manifest.transcript_revisions.len() >= MAX_TRANSCRIPT_REVISIONS {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_REVISION_LIMIT_REACHED",
                "transcript revision history reached its local safety limit",
            ));
        }
        if manifest.processing_receipts.len() >= MAX_PROCESSING_RECEIPTS {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_LIMIT_REACHED",
                "processing receipt history reached its local safety limit",
            ));
        }
        for _ in 0..16 {
            let suffix = NEXT_TRANSCRIPTION_ATTEMPT_SUFFIX.fetch_add(1, Ordering::Relaxed);
            let attempt_id = format!("ta-{}-{suffix}", now_ms());
            if manifest
                .chunks
                .iter()
                .all(|chunk| chunk.transcription_attempt_id.as_deref() != Some(attempt_id.as_str()))
            {
                return Ok(attempt_id);
            }
        }
        Err(RecordingStoreError::new(
            "TRANSCRIPTION_ATTEMPT_ID_EXHAUSTED",
            "a unique local transcription attempt identifier could not be allocated",
        ))
    }

    pub(crate) fn begin_cleanup_attempt(
        &self,
        recording_id: &str,
    ) -> Result<String, RecordingStoreError> {
        self.begin_transcription_attempt(recording_id)
    }

    pub(crate) fn write_transcription_attempt_segment(
        &self,
        attempt_id: &str,
        params: WriteTranscriptSegmentParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_history_id(attempt_id, "TRANSCRIPTION_ATTEMPT_ID_INVALID")?;
        self.write_transcript_segment_inner(params, Some(attempt_id.to_string()))
    }

    pub(crate) fn write_cleanup_attempt_segment(
        &self,
        attempt_id: &str,
        params: WriteTranscriptSegmentParams,
    ) -> Result<Value, RecordingStoreError> {
        self.write_transcription_attempt_segment(attempt_id, params)
    }

    fn write_transcript_segment_inner(
        &self,
        params: WriteTranscriptSegmentParams,
        transcription_attempt_id: Option<String>,
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

        let _mutation_guard = self.manifest_mutation_guard();
        let dir = self.recording_dir(&params.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        if manifest.state == RecordingState::NeedsRecovery {
            return Err(RecordingStoreError::new(
                "RECORDING_NEEDS_RECOVERY",
                "recording must be recovered before transcript segments can be written",
            ));
        }
        if transcription_attempt_id.is_some() {
            manifest.schema_version = manifest.schema_version.max(CURRENT_MANIFEST_SCHEMA_VERSION);
        }

        let index = manifest.chunks.len() as u32;
        let encrypted_payload =
            self.encrypt_chunk_if_available(&params.recording_id, index, bytes)?;
        let (file_name, stored_bytes, encrypted, cipher, payload) = match encrypted_payload {
            Some(payload) => {
                let stored_bytes = payload.len() as u64;
                (
                    transcript_segment_file_name(index, true, transcription_attempt_id.as_deref()),
                    stored_bytes,
                    true,
                    Some("chacha20poly1305".to_string()),
                    payload,
                )
            }
            None => (
                transcript_segment_file_name(index, false, transcription_attempt_id.as_deref()),
                bytes.len() as u64,
                false,
                None,
                bytes.to_vec(),
            ),
        };
        let chunk_path = dir.join(&file_name);
        self.ensure_chunk_write_space(payload.len())?;
        write_durable_chunk_file(&chunk_path, &payload)?;

        #[cfg(feature = "sqlcipher-vault")]
        let changes_search_index =
            transcription_attempt_id.is_none() && manifest.current_transcript_revision_id.is_none();
        manifest.chunks.push(DurableChunk {
            index,
            kind: DurableChunkKind::TranscriptSegment,
            file_name,
            channel: params.channel,
            bytes: bytes.len() as u64,
            stored_bytes,
            encrypted,
            cipher,
            content_sha256: None,
            speaker,
            confidence,
            sample_rate_hz: None,
            channel_count: None,
            bits_per_sample: None,
            start_ms: Some(params.start_ms),
            duration_ms: Some(duration_ms),
            transcription_attempt_id,
            created_at_ms: now_ms(),
        });
        manifest.updated_at_ms = now_ms();
        write_manifest(&dir, &manifest)?;
        #[cfg(feature = "sqlcipher-vault")]
        if changes_search_index {
            self.committed_trust_search_source_change();
        }

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

        let _mutation_guard = self.manifest_mutation_guard();
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
            content_sha256: Some(hex_digest(&Sha256::digest(&bytes))),
            speaker: None,
            confidence: None,
            sample_rate_hz: Some(params.sample_rate_hz),
            channel_count: Some(params.channel_count),
            bits_per_sample: Some(params.bits_per_sample),
            start_ms: Some(start_ms),
            duration_ms: Some(duration_ms),
            transcription_attempt_id: None,
            created_at_ms: now_ms(),
        });
        manifest.updated_at_ms = now_ms();
        write_manifest(&dir, &manifest)?;

        Ok(recording_summary(&manifest, self.root_kind))
    }

    pub fn finish(&self, params: RecordingIdParams) -> Result<Value, RecordingStoreError> {
        #[cfg(test)]
        if self.fail_finish {
            return Err(RecordingStoreError::new(
                "RECORDING_FINISH_FAILED",
                "injected persistent recording finish failure",
            ));
        }
        validate_id(&params.recording_id)?;
        let _mutation_guard = self.manifest_mutation_guard();
        let dir = self.recording_dir(&params.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        if manifest.state == RecordingState::Finished {
            return Ok(recording_summary(&manifest, self.root_kind));
        }
        manifest.state = RecordingState::Finished;
        manifest.updated_at_ms = now_ms();
        write_manifest(&dir, &manifest)?;
        #[cfg(feature = "sqlcipher-vault")]
        self.committed_trust_search_source_change();
        Ok(recording_summary(&manifest, self.root_kind))
    }

    pub(crate) fn require_finished(&self, recording_id: &str) -> Result<(), RecordingStoreError> {
        validate_id(recording_id)?;
        let dir = self.recording_dir(recording_id)?;
        if !dir.exists() {
            return Err(RecordingStoreError::new(
                "RECORDING_NOT_FOUND",
                "the local recording was not found",
            ));
        }
        let manifest = read_manifest(&dir)?;
        if manifest.state != RecordingState::Finished {
            return Err(RecordingStoreError::new(
                "RECORDING_DELETE_NOT_FINALIZED",
                "only a durably finished recording can be permanently deleted",
            ));
        }
        Ok(())
    }

    /// Removes a newly-created recording that never reached durable finish.
    /// This primitive is intentionally crate-private and refuses finalized
    /// meetings so import rollback cannot become a general deletion bypass.
    pub(crate) fn abort_unfinished(
        &self,
        params: RecordingIdParams,
    ) -> Result<Value, RecordingStoreError> {
        #[cfg(test)]
        if self.fail_abort_unfinished {
            return Err(RecordingStoreError::new(
                "RECORDING_ABORT_REMOVE_FAILED",
                "injected unfinished recording cleanup failure",
            ));
        }
        validate_id(&params.recording_id)?;
        let recording_id = params.recording_id;
        let _mutation_guard = self.manifest_mutation_guard();
        let dir = self.recording_dir(&recording_id)?;
        let metadata =
            fs::symlink_metadata(&dir).map_err(io_error("RECORDING_ABORT_READ_FAILED"))?;
        if metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&metadata)
            || !metadata.is_dir()
        {
            return Err(RecordingStoreError::new(
                "RECORDING_ABORT_TARGET_INVALID",
                "unfinished recording target was not an owned directory",
            ));
        }
        let manifest = read_manifest(&dir)?;
        if manifest.state == RecordingState::Finished {
            return Err(RecordingStoreError::new(
                "RECORDING_ABORT_FINALIZED",
                "a durably finished recording cannot be aborted",
            ));
        }
        fs::remove_dir_all(&dir).map_err(io_error("RECORDING_ABORT_REMOVE_FAILED"))?;
        #[cfg(feature = "sqlcipher-vault")]
        self.committed_trust_search_source_change();
        Ok(json!({
            "recordingId": recording_id,
            "aborted": true,
            "recordingDataRemoved": !dir.exists(),
            "rawPathExposed": false
        }))
    }

    pub(crate) fn mark_needs_recovery(
        &self,
        params: RecordingIdParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let _mutation_guard = self.manifest_mutation_guard();
        let dir = self.recording_dir(&params.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        if manifest.state != RecordingState::Finished {
            manifest.state = RecordingState::NeedsRecovery;
            manifest.updated_at_ms = now_ms();
            write_manifest(&dir, &manifest)?;
            #[cfg(feature = "sqlcipher-vault")]
            self.committed_trust_search_source_change();
        }
        Ok(recording_summary(&manifest, self.root_kind))
    }

    pub fn delete_finished(&self, params: RecordingIdParams) -> Result<Value, RecordingStoreError> {
        let _mutation_guard = self.manifest_mutation_guard();
        self.delete_finished_unlocked(params)
    }

    fn delete_finished_unlocked(
        &self,
        params: RecordingIdParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let recording_id = params.recording_id;
        let active_dir = self.recording_dir(&recording_id)?;
        let tombstone_dir = self.deletion_tombstone_dir(&recording_id)?;
        let pending_marker = self.deletion_pending_marker(&recording_id)?;
        #[cfg(feature = "sqlcipher-vault")]
        // A confirmed permanent deletion must not bounce back to the renderer
        // merely because a fully-derived index rebuild is in progress. Wait
        // only for the bounded maintenance interval. If it cannot yield, the
        // durable intent retains the user's confirmation and recovery resumes
        // deletion without exposing or removing content prematurely.
        let _search_guard = match self.trust_search_invalidation_guard() {
            Some(guard) => guard,
            None => {
                return self.queue_confirmed_deletion(
                    &recording_id,
                    &active_dir,
                    &tombstone_dir,
                    &pending_marker,
                );
            }
        };
        macro_rules! invalidate_search_before_delete {
            () => {
                match self.invalidate_trust_search_index_unlocked() {
                    Ok(value) => value,
                    #[cfg(feature = "sqlcipher-vault")]
                    Err(error) if error.code == "TRUST_SEARCH_INVALIDATE_BUSY" => {
                        return self.queue_confirmed_deletion(
                            &recording_id,
                            &active_dir,
                            &tombstone_dir,
                            &pending_marker,
                        );
                    }
                    Err(error) => return Err(error),
                }
            };
        }

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
            invalidate_search_before_delete!();
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
            invalidate_search_before_delete!();
            if !pending_marker.exists() {
                self.write_deletion_intent(&recording_id, &pending_marker)?;
            }
        } else if !pending_marker.exists() {
            return Err(RecordingStoreError::new(
                "RECORDING_NOT_FOUND",
                "recording was not found in the local store",
            ));
        }

        invalidate_search_before_delete!();
        #[cfg(feature = "sqlcipher-vault")]
        self.mark_trust_search_source_change();
        let result = self.remove_deletion_tombstone(&recording_id, &tombstone_dir);
        #[cfg(feature = "sqlcipher-vault")]
        {
            drop(_search_guard);
            self.schedule_trust_search_backfill();
        }
        result
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn queue_confirmed_deletion(
        &self,
        recording_id: &str,
        active_dir: &Path,
        tombstone_dir: &Path,
        pending_marker: &Path,
    ) -> Result<Value, RecordingStoreError> {
        if active_dir.exists() {
            if tombstone_dir.exists() {
                return Err(RecordingStoreError::new(
                    "RECORDING_DELETE_TOMBSTONE_CONFLICT",
                    "active recording and deletion tombstone both exist",
                ));
            }
            if read_manifest(active_dir)?.state != RecordingState::Finished {
                return Err(RecordingStoreError::new(
                    "RECORDING_DELETE_NOT_FINALIZED",
                    "only a durably finished recording can be permanently deleted",
                ));
            }
        } else if tombstone_dir.exists() {
            if read_manifest(tombstone_dir)?.state != RecordingState::Finished {
                return Err(RecordingStoreError::new(
                    "RECORDING_DELETE_NOT_FINALIZED",
                    "deletion tombstone did not contain a finished recording",
                ));
            }
        } else if !pending_marker.exists() {
            return Err(RecordingStoreError::new(
                "RECORDING_NOT_FOUND",
                "recording was not found in the local store",
            ));
        }

        self.write_deletion_intent(recording_id, pending_marker)?;
        let recording_data_removed = !active_dir.exists() && !tombstone_dir.exists();
        Ok(json!({
            "recordingId": recording_id,
            "state": if recording_data_removed { "metadataCleanupPending" } else { "deletionQueued" },
            "deleted": false,
            "recordingDataRemoved": recording_data_removed,
            "confirmationRetained": true,
            "metadataCleanupComplete": false,
            "retryRequired": true,
            "permanent": true,
            "rawPathExposed": false
        }))
    }

    /// The encrypted FTS database is fully derived from meeting content. It is
    /// removed before any meeting deletion so deleted transcript or note text
    /// cannot survive indefinitely in a stale index.
    pub(crate) fn invalidate_trust_search_index(&self) -> Result<Value, RecordingStoreError> {
        #[cfg(feature = "sqlcipher-vault")]
        let _search_guard = self.trust_search_invalidation_guard().ok_or_else(|| {
            RecordingStoreError::new(
                "TRUST_SEARCH_INVALIDATE_BUSY",
                "encrypted search maintenance did not yield before the bounded cleanup timeout",
            )
        })?;
        self.invalidate_trust_search_index_unlocked()
    }

    fn invalidate_trust_search_index_unlocked(&self) -> Result<Value, RecordingStoreError> {
        let search_root = self.root.join(TRUST_SEARCH_DIR);
        let metadata = match fs::symlink_metadata(&search_root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({
                    "invalidated": false,
                    "alreadyAbsent": true,
                    "rawPathExposed": false
                }));
            }
            Err(error) => {
                return Err(RecordingStoreError::new(
                    "TRUST_SEARCH_INVALIDATE_FAILED",
                    error.to_string(),
                ));
            }
        };
        if metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&metadata)
            || !metadata.is_dir()
        {
            return Err(RecordingStoreError::new(
                "TRUST_SEARCH_INVALIDATE_FAILED",
                "derived search storage was not an owned directory",
            ));
        }
        #[cfg(not(feature = "sqlcipher-vault"))]
        match fs::remove_dir_all(&search_root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(RecordingStoreError::new(
                    "TRUST_SEARCH_INVALIDATE_FAILED",
                    error.to_string(),
                ));
            }
        }
        #[cfg(feature = "sqlcipher-vault")]
        {
            let invalidation_started = std::time::Instant::now();
            loop {
                match fs::remove_dir_all(&search_root) {
                    Ok(()) => break,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                    Err(error)
                        if windows_transient_search_remove_error(&error)
                            && invalidation_started.elapsed()
                                < std::time::Duration::from_millis(
                                    TRUST_SEARCH_INVALIDATION_WAIT_MS,
                                ) =>
                    {
                        // A prior store instance in this process can still be
                        // closing its derived SQLCipher connection or finishing
                        // creation of a temporary index file. Retry only known
                        // transient Windows removal errors and preserve the
                        // same bounded deletion wait used for the ownership
                        // mutex.
                        std::thread::sleep(std::time::Duration::from_millis(
                            TRUST_SEARCH_INVALIDATION_POLL_MS,
                        ));
                    }
                    Err(error) if windows_transient_search_remove_error(&error) => {
                        return Err(RecordingStoreError::new(
                        "TRUST_SEARCH_INVALIDATE_BUSY",
                        "encrypted search storage remained in use through the bounded cleanup timeout",
                    ));
                    }
                    Err(error) => {
                        return Err(RecordingStoreError::new(
                            "TRUST_SEARCH_INVALIDATE_FAILED",
                            error.to_string(),
                        ));
                    }
                }
            }
        }
        match fs::symlink_metadata(&search_root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => {
                return Err(RecordingStoreError::new(
                    "TRUST_SEARCH_INVALIDATE_FAILED",
                    "derived search storage remained after invalidation",
                ));
            }
            Err(error) => {
                return Err(RecordingStoreError::new(
                    "TRUST_SEARCH_INVALIDATE_FAILED",
                    error.to_string(),
                ));
            }
        }
        Ok(json!({
            "invalidated": true,
            "alreadyAbsent": false,
            "rawPathExposed": false
        }))
    }

    pub fn complete_deletion_metadata(
        &self,
        params: RecordingIdParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let recording_id = params.recording_id;
        let _mutation_guard = self.manifest_mutation_guard();
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

    pub(crate) fn deletion_pending(&self, recording_id: &str) -> bool {
        self.deletion_pending_marker(recording_id)
            .is_ok_and(|marker| marker.is_file())
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

    fn recover_pending_deletions_unlocked(&self) -> Result<Value, RecordingStoreError> {
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
            match self.delete_finished_unlocked(RecordingIdParams {
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
        let _mutation_guard = self.manifest_mutation_guard();
        let deletion_recovery = self.recover_pending_deletions_unlocked()?;
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
                let mut scanned_chunks = self.scan_chunks(&id, &entry.path())?;
                let owned_raw_indices = manifest
                    .transcript_revisions
                    .iter()
                    .filter_map(|revision| revision.raw_text_chunk_indices.as_ref())
                    .flatten()
                    .copied()
                    .collect::<HashSet<_>>();
                let unowned_raw_files = scanned_chunks
                    .iter()
                    .filter(|chunk| {
                        chunk.kind == DurableChunkKind::RawTranscriptText
                            && !owned_raw_indices.contains(&chunk.index)
                    })
                    .map(|chunk| (chunk.index, entry.path().join(&chunk.file_name)))
                    .collect::<Vec<_>>();
                if !unowned_raw_files.is_empty() {
                    let rebuilt_manifest_contains_unowned =
                        unowned_raw_files.iter().any(|(index, _)| {
                            manifest.chunks.iter().any(|chunk| chunk.index == *index)
                        });
                    for (_, path) in &unowned_raw_files {
                        fs::remove_file(path)
                            .map_err(io_error("TRANSCRIPT_RAW_RECOVERY_CLEANUP_FAILED"))?;
                    }
                    scanned_chunks = self.scan_chunks(&id, &entry.path())?;
                    if rebuilt_manifest_contains_unowned {
                        manifest.chunks = scanned_chunks.clone();
                    }
                }
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

        #[cfg(feature = "sqlcipher-vault")]
        self.committed_trust_search_source_change();

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
        Ok(recording_page_value(
            collection,
            offset,
            limit,
            self.root_kind,
        ))
    }

    /// Lists recordings without creating directories, recovery receipts, or
    /// repaired manifests. Automation companions use this path so a second
    /// process remains observational even while desktop capture is active.
    pub fn list_page_read_only(
        &self,
        params: RecordingPageParams,
    ) -> Result<Value, RecordingStoreError> {
        let (offset, limit) = page_bounds(params.offset, params.limit)?;
        if limit > MAX_AUTOMATION_LIST_PAGE_RECORDINGS {
            return Err(RecordingStoreError::new(
                "RECORDING_PAGE_LIMIT_INVALID",
                format!(
                    "read-only automation page limit must be between 1 and {MAX_AUTOMATION_LIST_PAGE_RECORDINGS}"
                ),
            ));
        }
        let bounded = self.collect_read_only_list_candidates_bounded(
            MAX_AUTOMATION_LIST_SCAN_RECORDINGS,
            MAX_AUTOMATION_LIST_DIRECTORY_ENTRIES,
            MAX_AUTOMATION_QUARANTINE_DETAILS,
        )?;
        let response = self.automation_recording_page_value(bounded, offset, limit)?;
        bounded_automation_response(
            response,
            MAX_AUTOMATION_LIST_RESPONSE_BYTES,
            "AUTOMATION_LIST_RESPONSE_TOO_LARGE",
        )
    }

    fn collect_read_only_list_candidates_bounded(
        &self,
        recording_limit: usize,
        directory_entry_limit: usize,
        quarantine_detail_limit: usize,
    ) -> Result<BoundedReadOnlyListCandidates, RecordingStoreError> {
        let recordings_root = self.recordings_root();
        let root_metadata = match fs::symlink_metadata(&recordings_root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BoundedReadOnlyListCandidates {
                    candidates: Vec::new(),
                    source_truncated: false,
                    inspected_directory_entries: 0,
                    quarantined: Vec::new(),
                    quarantined_count: 0,
                    quarantine_details_truncated: false,
                });
            }
            Err(error) => {
                return Err(RecordingStoreError::new(
                    "RECORDING_STORE_READ_FAILED",
                    error.to_string(),
                ));
            }
        };
        if root_metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&root_metadata)
            || !root_metadata.is_dir()
        {
            return Err(RecordingStoreError::new(
                "RECORDING_STORE_READ_FAILED",
                "recordings root must be an owned directory",
            ));
        }

        let mut candidates = Vec::new();
        let mut quarantined = Vec::new();
        let mut source_truncated = false;
        let mut inspected_directory_entries = 0_usize;
        let mut quarantined_count = 0_u64;
        let mut entries =
            fs::read_dir(&recordings_root).map_err(io_error("RECORDING_STORE_READ_FAILED"))?;
        loop {
            if inspected_directory_entries >= directory_entry_limit {
                source_truncated = true;
                break;
            }
            let Some(entry) = entries.next() else {
                break;
            };
            inspected_directory_entries = inspected_directory_entries.saturating_add(1);
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    source_truncated = true;
                    continue;
                }
            };
            let recording_id = entry.file_name().to_string_lossy().to_string();
            if validate_id(&recording_id).is_err() {
                continue;
            }
            let directory = entry.path();
            let metadata = match fs::symlink_metadata(&directory) {
                Ok(metadata) => metadata,
                Err(_) => {
                    quarantined_count = quarantined_count.saturating_add(1);
                    if quarantined.len() < quarantine_detail_limit {
                        quarantined.push(read_only_quarantine_summary(
                            &recording_id,
                            "RECORDING_DIRECTORY_READ_FAILED",
                        ));
                    }
                    continue;
                }
            };
            if metadata.file_type().is_symlink()
                || metadata_is_reparse_point(&metadata)
                || !metadata.is_dir()
            {
                quarantined_count = quarantined_count.saturating_add(1);
                if quarantined.len() < quarantine_detail_limit {
                    quarantined.push(read_only_quarantine_summary(
                        &recording_id,
                        "RECORDING_DIRECTORY_NOT_OWNED",
                    ));
                }
                continue;
            }
            candidates.push(ReadOnlyListCandidate {
                recording_id,
                modified_at_ns: read_only_list_sort_time_ns(&directory, &metadata),
                directory,
            });
        }
        candidates.sort_by(|left, right| {
            right
                .modified_at_ns
                .cmp(&left.modified_at_ns)
                .then_with(|| right.recording_id.cmp(&left.recording_id))
        });
        if candidates.len() > recording_limit {
            candidates.truncate(recording_limit);
            source_truncated = true;
        }
        let quarantine_details_truncated = quarantined_count > quarantined.len() as u64;
        Ok(BoundedReadOnlyListCandidates {
            candidates,
            source_truncated,
            inspected_directory_entries,
            quarantined,
            quarantined_count,
            quarantine_details_truncated,
        })
    }

    fn automation_recording_page_value(
        &self,
        bounded: BoundedReadOnlyListCandidates,
        offset: usize,
        limit: usize,
    ) -> Result<Value, RecordingStoreError> {
        let BoundedReadOnlyListCandidates {
            candidates,
            source_truncated: scan_truncated,
            inspected_directory_entries,
            mut quarantined,
            mut quarantined_count,
            quarantine_details_truncated: initial_quarantine_details_truncated,
        } = bounded;
        let candidate_count = candidates.len();
        let window_end = offset.saturating_add(limit).min(candidate_count);
        let mut remaining_manifest_bytes = MAX_AUTOMATION_LIST_MANIFEST_BYTES_TOTAL;
        let mut retained_chunk_descriptors = 0_usize;
        let mut recordings = Vec::with_capacity(window_end.saturating_sub(offset));
        let mut selected_candidate_failed = false;
        let mut page_processing_truncated = false;

        for candidate in candidates.iter().skip(offset).take(limit) {
            match read_manifest_with_budget(&candidate.directory, &mut remaining_manifest_bytes) {
                Ok(manifest) => {
                    if manifest.chunks.len()
                        > MAX_AUTOMATION_LIST_CHUNK_DESCRIPTORS
                            .saturating_sub(retained_chunk_descriptors)
                    {
                        page_processing_truncated = true;
                        break;
                    }
                    retained_chunk_descriptors =
                        retained_chunk_descriptors.saturating_add(manifest.chunks.len());
                    recordings.push(automation_recording_summary(&manifest, self.root_kind));
                }
                Err(error) if error.code == "RECORDING_MANIFEST_BUDGET_EXCEEDED" => {
                    page_processing_truncated = true;
                    break;
                }
                Err(error) => {
                    selected_candidate_failed = true;
                    quarantined_count = quarantined_count.saturating_add(1);
                    if quarantined.len() < MAX_AUTOMATION_QUARANTINE_DETAILS {
                        quarantined.push(read_only_quarantine_summary(
                            &candidate.recording_id,
                            error.code,
                        ));
                    }
                }
            }
        }

        let all_candidates_parsed =
            offset == 0 && window_end == candidate_count && !page_processing_truncated;
        let total_count_exact = all_candidates_parsed && !scan_truncated;
        let total_count = if all_candidates_parsed {
            recordings.len()
        } else {
            candidate_count
        };
        let stopped_before_later_candidates = (selected_candidate_failed
            || page_processing_truncated)
            && window_end < candidate_count;
        let source_truncated =
            scan_truncated || page_processing_truncated || stopped_before_later_candidates;
        let has_more = !selected_candidate_failed
            && !page_processing_truncated
            && window_end < candidate_count;
        let quarantine_details_truncated =
            initial_quarantine_details_truncated || quarantined_count > quarantined.len() as u64;
        let manifest_bytes_read =
            MAX_AUTOMATION_LIST_MANIFEST_BYTES_TOTAL.saturating_sub(remaining_manifest_bytes);

        Ok(json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false,
            "offset": offset,
            "limit": limit,
            "totalCount": total_count,
            "totalCountExact": total_count_exact,
            "hasMore": has_more,
            "sourceTruncated": source_truncated,
            "scanLimit": MAX_AUTOMATION_LIST_SCAN_RECORDINGS,
            "directoryEntryLimit": MAX_AUTOMATION_LIST_DIRECTORY_ENTRIES,
            "inspectedDirectoryEntries": inspected_directory_entries,
            "chunkDescriptorLimit": MAX_AUTOMATION_LIST_CHUNK_DESCRIPTORS,
            "manifestByteLimit": MAX_AUTOMATION_LIST_MANIFEST_BYTES_TOTAL,
            "manifestBytesRead": manifest_bytes_read,
            "pageCandidateCount": window_end.saturating_sub(offset),
            "ordering": "manifestModifiedAtThenRecordingId",
            "recordings": recordings,
            "quarantinedCount": quarantined_count,
            "quarantineCountExact": total_count_exact,
            "quarantineDetailsTruncated": quarantine_details_truncated,
            "quarantinedRecordings": quarantined
        }))
    }

    fn collect_recording_manifests_read_only_bounded(
        &self,
        recording_limit: usize,
        directory_entry_limit: usize,
        chunk_descriptor_limit: usize,
        manifest_bytes_limit: u64,
        quarantine_detail_limit: usize,
    ) -> Result<BoundedReadOnlyManifestCollection, RecordingStoreError> {
        let recordings_root = self.recordings_root();
        let root_metadata = match fs::symlink_metadata(&recordings_root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BoundedReadOnlyManifestCollection {
                    collection: RecordingManifestCollection {
                        items: Vec::new(),
                        quarantined: Vec::new(),
                    },
                    source_truncated: false,
                    inspected_directory_entries: 0,
                    manifest_bytes_read: 0,
                    quarantined_count: 0,
                });
            }
            Err(error) => {
                return Err(RecordingStoreError::new(
                    "RECORDING_STORE_READ_FAILED",
                    error.to_string(),
                ));
            }
        };
        if root_metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&root_metadata)
            || !root_metadata.is_dir()
        {
            return Err(RecordingStoreError::new(
                "RECORDING_STORE_READ_FAILED",
                "recordings root must be an owned directory",
            ));
        }

        let mut candidates = Vec::new();
        let mut quarantined = Vec::new();
        let mut source_truncated = false;
        let mut inspected_directory_entries = 0_usize;
        let mut quarantined_count = 0_u64;
        let mut entries =
            fs::read_dir(&recordings_root).map_err(io_error("RECORDING_STORE_READ_FAILED"))?;
        loop {
            if inspected_directory_entries >= directory_entry_limit {
                source_truncated = true;
                break;
            }
            let Some(entry) = entries.next() else {
                break;
            };
            inspected_directory_entries = inspected_directory_entries.saturating_add(1);
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    source_truncated = true;
                    continue;
                }
            };
            let id = entry.file_name().to_string_lossy().to_string();
            if validate_id(&id).is_err() {
                continue;
            }
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    quarantined_count = quarantined_count.saturating_add(1);
                    if quarantined.len() < quarantine_detail_limit {
                        quarantined.push(read_only_quarantine_summary(
                            &id,
                            "RECORDING_DIRECTORY_READ_FAILED",
                        ));
                    }
                    continue;
                }
            };
            if metadata.file_type().is_symlink()
                || metadata_is_reparse_point(&metadata)
                || !metadata.is_dir()
            {
                quarantined_count = quarantined_count.saturating_add(1);
                if quarantined.len() < quarantine_detail_limit {
                    quarantined.push(read_only_quarantine_summary(
                        &id,
                        "RECORDING_DIRECTORY_NOT_OWNED",
                    ));
                }
                continue;
            }
            if candidates.len() >= recording_limit {
                source_truncated = true;
                break;
            }
            candidates.push((id, path));
        }
        candidates.sort_by(|left, right| left.0.cmp(&right.0));

        let mut items = Vec::new();
        let mut retained_chunk_descriptors = 0_usize;
        let mut remaining_manifest_bytes = manifest_bytes_limit;
        for (id, path) in candidates {
            match read_manifest_with_budget(&path, &mut remaining_manifest_bytes) {
                Ok(manifest) => {
                    if manifest.chunks.len()
                        > chunk_descriptor_limit.saturating_sub(retained_chunk_descriptors)
                    {
                        source_truncated = true;
                        continue;
                    }
                    retained_chunk_descriptors =
                        retained_chunk_descriptors.saturating_add(manifest.chunks.len());
                    items.push((manifest, path));
                }
                Err(error) if error.code == "RECORDING_MANIFEST_BUDGET_EXCEEDED" => {
                    source_truncated = true;
                    break;
                }
                Err(error) => {
                    quarantined_count = quarantined_count.saturating_add(1);
                    if quarantined.len() < quarantine_detail_limit {
                        quarantined.push(read_only_quarantine_summary(&id, error.code));
                    }
                }
            }
        }
        let manifest_bytes_read = manifest_bytes_limit.saturating_sub(remaining_manifest_bytes);
        Ok(BoundedReadOnlyManifestCollection {
            collection: RecordingManifestCollection { items, quarantined },
            source_truncated,
            inspected_directory_entries,
            manifest_bytes_read,
            quarantined_count,
        })
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
            "currentRevisionId": manifest.current_transcript_revision_id.as_deref(),
            "revisionCount": manifest.transcript_revisions.len(),
            "segmentCount": segments.len(),
            "durationMs": duration_ms,
            "segments": segments
        }))
    }

    pub(crate) fn transcript_for_local_ai(
        &self,
        recording_id: String,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&recording_id)?;
        let dir = self.recording_dir(&recording_id)?;
        let manifest = read_manifest(&dir)?;
        let evidentiary_revision =
            manifest
                .current_transcript_revision_id
                .as_deref()
                .and_then(|revision_id| {
                    manifest
                        .transcript_revisions
                        .iter()
                        .find(|revision| revision.revision_id == revision_id)
                });
        let cleaned_revision = manifest
            .current_cleaned_revision_id
            .as_deref()
            .and_then(|revision_id| {
                manifest
                    .transcript_revisions
                    .iter()
                    .find(|revision| revision.revision_id == revision_id)
            })
            .filter(|revision| {
                revision.parent_revision_id.as_deref()
                    == manifest.current_transcript_revision_id.as_deref()
            });
        let selected_revision = cleaned_revision.or(evidentiary_revision);
        let selected_indices = selected_revision
            .map(|revision| {
                revision
                    .chunk_indices
                    .iter()
                    .copied()
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_else(|| current_transcript_chunk_indices(&manifest));
        let segments =
            self.transcript_segments_for_indices(&manifest, &dir, Some(&selected_indices), true)?;
        let duration_ms = segments
            .iter()
            .filter_map(|segment| segment.get("endMs").and_then(Value::as_u64))
            .max()
            .unwrap_or_default();
        let input_revision_kind = selected_revision
            .map(effective_revision_kind)
            .unwrap_or(TranscriptRevisionKind::Legacy);
        Ok(json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false,
            "recordingId": manifest.recording_id.as_str(),
            "label": manifest.label.as_deref(),
            "state": recording_state_label(&manifest.state),
            "currentRevisionId": manifest.current_transcript_revision_id.as_deref(),
            "currentCleanedRevisionId": manifest.current_cleaned_revision_id.as_deref(),
            "inputRevisionId": selected_revision.map(|revision| revision.revision_id.as_str()),
            "inputRevisionKind": input_revision_kind.label(),
            "cleanupFallbackApplied": cleaned_revision.is_none(),
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
            "currentRevisionId": manifest.current_transcript_revision_id.as_deref(),
            "revisionCount": manifest.transcript_revisions.len(),
            "offset": offset,
            "limit": limit,
            "segmentCount": total_count,
            "hasMore": offset.saturating_add(page.len()) < total_count,
            "durationMs": duration_ms,
            "segments": page
        }))
    }

    /// Reads a transcript page without creating a missing OS key. A missing
    /// key is an explicit read failure for automation, never an invitation to
    /// mutate the user's key store.
    pub fn transcript_page_read_only(
        &self,
        params: TranscriptPageParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let (offset, limit) = page_bounds(params.offset, params.limit)?;
        if limit > MAX_AUTOMATION_TRANSCRIPT_PAGE_SEGMENTS {
            return Err(RecordingStoreError::new(
                "RECORDING_PAGE_LIMIT_INVALID",
                format!(
                    "read-only transcript page limit must be between 1 and {MAX_AUTOMATION_TRANSCRIPT_PAGE_SEGMENTS}"
                ),
            ));
        }
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        let selected_indices = current_transcript_chunk_indices(&manifest);
        let mut selected_chunks = manifest
            .chunks
            .iter()
            .filter(|chunk| {
                chunk.kind == DurableChunkKind::TranscriptSegment
                    && selected_indices.contains(&chunk.index)
            })
            .collect::<Vec<_>>();
        selected_chunks.sort_by_key(|chunk| (chunk.start_ms.unwrap_or_default(), chunk.index));
        let duration_ms = selected_chunks
            .iter()
            .map(|chunk| {
                chunk
                    .start_ms
                    .unwrap_or_default()
                    .saturating_add(chunk.duration_ms.unwrap_or_default())
            })
            .max()
            .unwrap_or_default();
        let total_count = selected_chunks.len();
        let mut source_text_truncated = false;
        let mut page = Vec::with_capacity(limit.min(total_count.saturating_sub(offset)));
        for chunk in selected_chunks.iter().skip(offset).take(limit) {
            let bytes = self.read_chunk_bytes_with_key_access(&manifest, chunk, &dir, false)?;
            let text = String::from_utf8(bytes).map_err(|_| {
                RecordingStoreError::new(
                    "TRANSCRIPT_SEGMENT_TEXT_INVALID",
                    "durable transcript segment was not valid UTF-8",
                )
            })?;
            let text_truncated = text.len() > MAX_AUTOMATION_TRANSCRIPT_SEGMENT_RESPONSE_BYTES;
            source_text_truncated |= text_truncated;
            let start_ms = chunk.start_ms.unwrap_or_default();
            let duration_ms = chunk.duration_ms.unwrap_or_default();
            page.push(json!({
                "index": chunk.index,
                "kind": chunk_kind_label(&chunk.kind),
                "channel": truncate_utf8(&chunk.channel, MAX_AUTOMATION_CHANNEL_RESPONSE_BYTES),
                "speaker": chunk.speaker.as_deref().map(|speaker| {
                    truncate_utf8(speaker, MAX_AUTOMATION_SPEAKER_RESPONSE_BYTES)
                }),
                "text": truncate_utf8(&text, MAX_AUTOMATION_TRANSCRIPT_SEGMENT_RESPONSE_BYTES),
                "textTruncated": text_truncated,
                "startMs": start_ms,
                "durationMs": duration_ms,
                "endMs": start_ms.saturating_add(duration_ms),
                "confidence": chunk.confidence,
                "rawPathExposed": false
            }));
        }
        let response = json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false,
            "recordingId": manifest.recording_id.as_str(),
            "label": manifest.label.as_deref().map(|label| {
                truncate_utf8(label, MAX_AUTOMATION_LABEL_RESPONSE_BYTES)
            }),
            "state": recording_state_label(&manifest.state),
            "currentRevisionId": manifest.current_transcript_revision_id.as_deref(),
            "revisionCount": manifest.transcript_revisions.len(),
            "offset": offset,
            "limit": limit,
            "segmentCount": total_count,
            "hasMore": offset.saturating_add(page.len()) < total_count,
            "durationMs": duration_ms,
            "segments": page,
            "readOnlySnapshot": true,
            "sourceTextTruncated": source_text_truncated,
            "segmentTextByteLimit": MAX_AUTOMATION_TRANSCRIPT_SEGMENT_RESPONSE_BYTES
        });
        bounded_automation_response(
            response,
            MAX_AUTOMATION_TRANSCRIPT_RESPONSE_BYTES,
            "AUTOMATION_TRANSCRIPT_RESPONSE_TOO_LARGE",
        )
    }

    pub fn trust_history(&self, params: RecordingIdParams) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        let revisions = manifest
            .transcript_revisions
            .iter()
            .map(public_transcript_revision)
            .collect::<Vec<_>>();
        Ok(json!({
            "recordingId": manifest.recording_id,
            "currentRevisionId": manifest.current_transcript_revision_id,
            "currentCleanedRevisionId": manifest.current_cleaned_revision_id,
            "revisionCount": revisions.len(),
            "revisions": revisions,
            "receiptCount": manifest.processing_receipts.len(),
            "processingReceipts": manifest.processing_receipts,
            "immutableRevisions": true,
            "originalAudioRetained": manifest.chunks.iter().any(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn transcript_revision(
        &self,
        params: TranscriptRevisionParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        validate_history_id(&params.revision_id, "TRANSCRIPT_REVISION_ID_INVALID")?;
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        let revision = manifest
            .transcript_revisions
            .iter()
            .find(|revision| revision.revision_id == params.revision_id)
            .ok_or_else(|| {
                RecordingStoreError::new(
                    "TRANSCRIPT_REVISION_NOT_FOUND",
                    "transcript revision was not found for this recording",
                )
            })?;
        let segment_count = revision.chunk_indices.len();
        let segments = self.transcript_revision_segments_preview(&manifest, &dir, revision)?;
        let normalized_preview = transcript_text_from_segments(&segments);
        let (normalized_text, normalized_text_truncated_by_limit) =
            bounded_comparison_text(&normalized_preview);
        let normalized_text_truncated = normalized_text_truncated_by_limit
            || revision.comparison.normalized_text_bytes > normalized_text.len() as u64;
        let comparison_view = match self.raw_transcript_preview(&manifest, &dir, revision)? {
            Some((raw_text, raw_text_truncated)) => {
                json!({
                    "available": true,
                    "rawText": raw_text,
                    "normalizedText": normalized_text,
                    "rawTextTruncated": raw_text_truncated,
                    "normalizedTextTruncated": normalized_text_truncated,
                    "maxTextBytesPerSide": MAX_COMPARISON_TEXT_BYTES_PER_SIDE,
                    "encryptedAtRest": true,
                    "rawPathExposed": false,
                    "keyMaterialExposedToRenderer": false
                })
            }
            None => json!({
                "available": false,
                "reason": "legacy-revision",
                "maxTextBytesPerSide": MAX_COMPARISON_TEXT_BYTES_PER_SIDE,
                "encryptedAtRest": false,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            }),
        };
        let returned_segment_count = segments.len();
        Ok(json!({
            "recordingId": manifest.recording_id,
            "revision": public_transcript_revision(revision),
            "current": manifest.current_transcript_revision_id.as_deref() == Some(revision.revision_id.as_str()),
            "currentCleaned": manifest.current_cleaned_revision_id.as_deref() == Some(revision.revision_id.as_str()),
            "segmentCount": segment_count,
            "returnedSegmentCount": returned_segment_count,
            "hasMore": returned_segment_count < segment_count,
            "segments": segments,
            "comparisonView": comparison_view,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn select_transcript_revision(
        &self,
        params: TranscriptRevisionParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        validate_history_id(&params.revision_id, "TRANSCRIPT_REVISION_ID_INVALID")?;
        let _mutation_guard = self.manifest_mutation_guard();
        let dir = self.recording_dir(&params.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        let revision = manifest
            .transcript_revisions
            .iter()
            .find(|revision| revision.revision_id == params.revision_id)
            .ok_or_else(|| {
                RecordingStoreError::new(
                    "TRANSCRIPT_REVISION_NOT_FOUND",
                    "transcript revision was not found for this recording",
                )
            })?;
        if effective_revision_kind(revision) == TranscriptRevisionKind::AiCleaned {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_CLEANED_REVISION_SELECTION_INVALID",
                "AI-cleaned text cannot replace the selected evidentiary transcript",
            ));
        }
        let revision_id = revision.revision_id.clone();
        let version = revision.version;
        manifest.current_transcript_revision_id = Some(revision_id.clone());
        manifest.updated_at_ms = now_ms();
        write_manifest(&dir, &manifest)?;
        #[cfg(feature = "sqlcipher-vault")]
        self.committed_trust_search_source_change();
        Ok(json!({
            "recordingId": manifest.recording_id,
            "currentRevisionId": revision_id,
            "currentVersion": version,
            "olderRevisionsRetained": manifest.transcript_revisions.len().saturating_sub(1),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn prepare_reprocessing(
        &self,
        params: ReprocessingPrepareParams,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&params.recording_id)?;
        if let Some(channel) = params.channel.as_deref() {
            validate_channel(channel)?;
        }
        let dir = self.recording_dir(&params.recording_id)?;
        let manifest = read_manifest(&dir)?;
        if manifest.state != RecordingState::Finished {
            return Err(RecordingStoreError::new(
                "REPROCESSING_RECORDING_NOT_FINALIZED",
                "reprocessing requires a durably finished recording",
            ));
        }
        let requested_channel = params.channel.as_deref();
        let source_channels = transcription_source_channels(&manifest, requested_channel);
        if source_channels.is_empty() {
            let (code, message) = if requested_channel
                .is_some_and(|channel| channel != COMBINED_TRANSCRIPTION_CHANNEL)
            {
                (
                    "REPROCESSING_AUDIO_CHANNEL_NOT_FOUND",
                    "recording has no original durable audio for the selected channel",
                )
            } else {
                (
                    "REPROCESSING_AUDIO_UNAVAILABLE",
                    "recording has no original durable audio to reprocess",
                )
            };
            return Err(RecordingStoreError::new(code, message));
        }
        if source_channels.len() > MAX_COMBINED_TRANSCRIPTION_CHANNELS {
            return Err(RecordingStoreError::new(
                "REPROCESSING_AUDIO_SOURCE_LIMIT",
                "reprocessing accepts at most eight aligned audio sources",
            ));
        }
        let selected_channel = if requested_channel == Some(COMBINED_TRANSCRIPTION_CHANNEL)
            || source_channels.len() > 1
        {
            COMBINED_TRANSCRIPTION_CHANNEL.to_string()
        } else {
            source_channels[0].clone()
        };
        let audio_chunks = manifest
            .chunks
            .iter()
            .filter(|chunk| {
                chunk.kind == DurableChunkKind::AudioPcm16le
                    && source_channels.contains(&chunk.channel)
            })
            .collect::<Vec<_>>();
        if audio_chunks.is_empty() {
            return Err(RecordingStoreError::new(
                "REPROCESSING_AUDIO_CHANNEL_NOT_FOUND",
                "recording has no original durable audio for the selected channel",
            ));
        }
        let mut duration_ms = 0_u64;
        for source_channel in &source_channels {
            let channel_chunks = audio_chunks
                .iter()
                .copied()
                .filter(|chunk| chunk.channel == *source_channel)
                .collect::<Vec<_>>();
            let first = channel_chunks.first().ok_or_else(|| {
                RecordingStoreError::new(
                    "REPROCESSING_AUDIO_CHANNEL_NOT_FOUND",
                    "recording has no original durable audio for the selected channel",
                )
            })?;
            let sample_rate_hz = first.sample_rate_hz.unwrap_or_default();
            let channel_count = first.channel_count.unwrap_or_default();
            let bits_per_sample = first.bits_per_sample.unwrap_or_default();
            validate_audio_format(sample_rate_hz, channel_count, bits_per_sample)?;
            for chunk in channel_chunks {
                if chunk.sample_rate_hz.unwrap_or_default() != sample_rate_hz
                    || chunk.channel_count.unwrap_or_default() != channel_count
                    || chunk.bits_per_sample.unwrap_or_default() != bits_per_sample
                {
                    return Err(RecordingStoreError::new(
                        "REPROCESSING_AUDIO_FORMAT_MISMATCH",
                        "original audio chunks for each channel must share one PCM format",
                    ));
                }
                duration_ms = duration_ms.max(
                    chunk
                        .start_ms
                        .unwrap_or_default()
                        .saturating_add(chunk.duration_ms.unwrap_or_default()),
                );
            }
        }
        let first = audio_chunks[0];
        let combined = selected_channel == COMBINED_TRANSCRIPTION_CHANNEL;
        let sample_rate_hz = if combined {
            16_000
        } else {
            first.sample_rate_hz.unwrap_or_default()
        };
        let channel_count = if combined {
            1
        } else {
            first.channel_count.unwrap_or_default()
        };
        let bits_per_sample = if combined {
            16
        } else {
            first.bits_per_sample.unwrap_or_default()
        };
        let source_audio_sha256 = source_audio_manifest_digest(&selected_channel, &audio_chunks);
        Ok(json!({
            "recordingId": manifest.recording_id,
            "channel": selected_channel,
            "inputKind": "originalDurableAudio",
            "audioChunkIndices": audio_chunks.iter().map(|chunk| chunk.index).collect::<Vec<_>>(),
            "audioChunkCount": audio_chunks.len(),
            "sourceAudioSha256": source_audio_sha256,
            "sourceAudioIntegrity": if audio_chunks.iter().all(|chunk| chunk.content_sha256.is_some()) {
                "pending-background-content-hash-verification"
            } else if audio_chunks.iter().all(|chunk| chunk.encrypted) {
                "pending-background-encrypted-chunk-authentication"
            } else {
                "pending-background-legacy-read"
            },
            "sampleRateHz": sample_rate_hz,
            "channelCount": channel_count,
            "bitsPerSample": bits_per_sample,
            "durationMs": duration_ms,
            "currentRevisionId": manifest.current_transcript_revision_id,
            "revisionCount": manifest.transcript_revisions.len(),
            "dispatchInput": {
                "recordingId": manifest.recording_id,
                "channel": selected_channel
            },
            "originalAudioModified": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    #[cfg(test)]
    pub(crate) fn transcript_chunk_indices(
        &self,
        recording_id: &str,
    ) -> Result<Vec<u32>, RecordingStoreError> {
        validate_id(recording_id)?;
        let dir = self.recording_dir(recording_id)?;
        let manifest = read_manifest(&dir)?;
        Ok(manifest
            .chunks
            .iter()
            .filter(|chunk| chunk.kind == DurableChunkKind::TranscriptSegment)
            .map(|chunk| chunk.index)
            .collect())
    }

    pub(crate) fn complete_transcription_attempt(
        &self,
        draft: TranscriptionSuccessDraft,
    ) -> Result<Value, RecordingStoreError> {
        self.complete_transcript_attempt_with_kind(draft, TranscriptCommitKind::Transcription)
    }

    pub(crate) fn complete_protected_term_review_attempt(
        &self,
        draft: TranscriptionSuccessDraft,
        expected_current_revision_id: String,
    ) -> Result<Value, RecordingStoreError> {
        validate_history_id(
            &expected_current_revision_id,
            "PROTECTED_TERM_REVISION_ID_INVALID",
        )?;
        self.complete_transcript_attempt_with_kind(
            draft,
            TranscriptCommitKind::ProtectedTermReview {
                expected_current_revision_id,
            },
        )
    }

    pub(crate) fn complete_cleanup_attempt(
        &self,
        draft: CleanupSuccessDraft,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&draft.recording_id)?;
        validate_history_id(&draft.attempt_id, "CLEANUP_ATTEMPT_ID_INVALID")?;
        validate_history_id(
            &draft.parent_revision_id,
            "TRANSCRIPT_PARENT_REVISION_ID_INVALID",
        )?;
        validate_processing_identity(
            &draft.engine,
            Some(&draft.model_id),
            Some(&draft.model_sha256),
        )?;
        if !is_sha256_hex(&draft.prompt_template_sha256) {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_PROMPT_HASH_INVALID",
                "cleanup prompt template fingerprint was invalid",
            ));
        }
        let _mutation_guard = self.manifest_mutation_guard();
        let dir = self.recording_dir(&draft.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        if manifest.current_transcript_revision_id.as_deref()
            != Some(draft.parent_revision_id.as_str())
        {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_CLEANUP_STALE",
                "the evidentiary transcript changed before cleanup could be saved",
            ));
        }
        if manifest.state == RecordingState::NeedsRecovery {
            return Err(RecordingStoreError::new(
                "RECORDING_NEEDS_RECOVERY",
                "recording must be recovered before cleaned text can be saved",
            ));
        }
        if manifest.transcript_revisions.len() >= MAX_TRANSCRIPT_REVISIONS {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_REVISION_LIMIT_REACHED",
                "transcript revision history reached its local safety limit",
            ));
        }
        if manifest.processing_receipts.len() >= MAX_PROCESSING_RECEIPTS {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_LIMIT_REACHED",
                "processing receipt history reached its local safety limit",
            ));
        }
        let parent = manifest
            .transcript_revisions
            .iter()
            .find(|revision| revision.revision_id == draft.parent_revision_id)
            .cloned()
            .ok_or_else(|| {
                RecordingStoreError::new(
                    "TRANSCRIPT_PARENT_REVISION_INVALID",
                    "cleanup input revision was not found",
                )
            })?;
        if effective_revision_kind(&parent) == TranscriptRevisionKind::AiCleaned {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_PARENT_REVISION_INVALID",
                "cleanup input must be an evidentiary transcript revision",
            ));
        }
        let chunk_indices = manifest
            .chunks
            .iter()
            .filter(|chunk| {
                chunk.kind == DurableChunkKind::TranscriptSegment
                    && chunk.transcription_attempt_id.as_deref() == Some(draft.attempt_id.as_str())
            })
            .map(|chunk| chunk.index)
            .collect::<Vec<_>>();
        if chunk_indices.is_empty() || chunk_indices.len() != parent.chunk_indices.len() {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_CLEANUP_SEGMENT_COUNT_INVALID",
                "cleanup must preserve exactly one output for every source segment",
            ));
        }
        validate_revision_chunk_indices(&manifest, &chunk_indices)?;
        validate_revision_attempt_membership(&manifest, &chunk_indices)?;
        let parent_indices = parent.chunk_indices.iter().copied().collect::<HashSet<_>>();
        let cleaned_indices = chunk_indices.iter().copied().collect::<HashSet<_>>();
        let parent_segments =
            self.transcript_segments_for_indices(&manifest, &dir, Some(&parent_indices), true)?;
        let cleaned_segments =
            self.transcript_segments_for_indices(&manifest, &dir, Some(&cleaned_indices), true)?;
        if parent_segments.len() != cleaned_segments.len()
            || parent_segments
                .iter()
                .zip(&cleaned_segments)
                .any(|(source, cleaned)| !cleanup_segment_metadata_matches(source, cleaned))
        {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_CLEANUP_MAPPING_INVALID",
                "cleanup changed a source segment identity, timestamp, channel, or speaker",
            ));
        }
        let source_text = transcript_text_from_segments(&parent_segments);
        let cleaned_text = transcript_text_from_segments(&cleaned_segments);
        let comparison = TranscriptComparisonMetadata {
            raw_text_sha256: hex_digest(&Sha256::digest(source_text.as_bytes())),
            normalized_text_sha256: hex_digest(&Sha256::digest(cleaned_text.as_bytes())),
            raw_text_bytes: u64::try_from(source_text.len()).unwrap_or(u64::MAX),
            normalized_text_bytes: u64::try_from(cleaned_text.len()).unwrap_or(u64::MAX),
            raw_segment_count: u64::try_from(parent_segments.len()).unwrap_or(u64::MAX),
            normalized_segment_count: u64::try_from(cleaned_segments.len()).unwrap_or(u64::MAX),
            changed: source_text != cleaned_text,
        };
        validate_transcript_comparison_metadata(&comparison)?;
        let finished_at_ms = now_ms();
        let version = u32::try_from(manifest.transcript_revisions.len())
            .unwrap_or(u32::MAX)
            .saturating_add(1);
        let revision_id = format!("tr-{version:06}-{finished_at_ms}");
        let attempt = u32::try_from(manifest.processing_receipts.len())
            .unwrap_or(u32::MAX)
            .saturating_add(1);
        let receipt_id = format!("pr-{attempt:06}-{finished_at_ms}");
        let input_revision_kind = effective_revision_kind(&parent).label().to_string();
        manifest.schema_version = manifest.schema_version.max(CURRENT_MANIFEST_SCHEMA_VERSION);
        manifest.transcript_revisions.push(TranscriptRevision {
            revision_id: revision_id.clone(),
            version,
            source: "ai-cleanup".to_string(),
            kind: TranscriptRevisionKind::AiCleaned,
            parent_revision_id: Some(draft.parent_revision_id.clone()),
            chunk_indices,
            engine: draft.engine.clone(),
            model_id: Some(draft.model_id.clone()),
            model_sha256: Some(draft.model_sha256.clone()),
            raw_text_chunk_indices: None,
            comparison: comparison.clone(),
            created_at_ms: finished_at_ms,
        });
        manifest.current_cleaned_revision_id = Some(revision_id.clone());
        manifest.processing_receipts.push(ProcessingReceipt {
            receipt_id: receipt_id.clone(),
            attempt,
            operation: "transcript-cleanup".to_string(),
            stage: Some("cleanup".to_string()),
            outcome: ProcessingOutcome::Succeeded,
            engine: draft.engine,
            model_id: Some(draft.model_id),
            model_sha256: Some(draft.model_sha256),
            revision_id: Some(revision_id.clone()),
            input_revision_id: Some(draft.parent_revision_id),
            input_revision_kind: Some(input_revision_kind),
            prompt_template_sha256: Some(draft.prompt_template_sha256),
            validation_result: Some("passed".to_string()),
            fallback_applied: false,
            error_code: None,
            error_summary: None,
            comparison: Some(comparison),
            started_at_ms: draft.started_at_ms.min(finished_at_ms),
            finished_at_ms,
            elapsed_ms: draft.elapsed_ms,
        });
        manifest.updated_at_ms = finished_at_ms;
        validate_manifest_structure(&manifest, &dir)?;
        write_manifest(&dir, &manifest)?;
        #[cfg(feature = "sqlcipher-vault")]
        self.committed_trust_search_source_change();
        Ok(json!({
            "recordingId": manifest.recording_id,
            "revisionId": revision_id,
            "parentRevisionId": parent.revision_id,
            "version": version,
            "receiptId": receipt_id,
            "source": "ai-cleanup",
            "kind": "ai-cleaned",
            "current": false,
            "currentCleaned": true,
            "segmentCount": cleaned_segments.len(),
            "validationResult": "passed",
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub(crate) fn record_cleanup_failure(
        &self,
        draft: CleanupFailureDraft,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&draft.recording_id)?;
        validate_history_id(
            &draft.parent_revision_id,
            "TRANSCRIPT_PARENT_REVISION_ID_INVALID",
        )?;
        validate_processing_identity(
            &draft.engine,
            draft.model_id.as_deref(),
            draft.model_sha256.as_deref(),
        )?;
        validate_stable_code(&draft.error_code, "PROCESSING_RECEIPT_ERROR_CODE_INVALID")?;
        if !is_sha256_hex(&draft.prompt_template_sha256) {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_PROMPT_HASH_INVALID",
                "cleanup prompt template fingerprint was invalid",
            ));
        }
        let _mutation_guard = self.manifest_mutation_guard();
        let dir = self.recording_dir(&draft.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        let parent = manifest
            .transcript_revisions
            .iter()
            .find(|revision| revision.revision_id == draft.parent_revision_id)
            .ok_or_else(|| {
                RecordingStoreError::new(
                    "TRANSCRIPT_PARENT_REVISION_INVALID",
                    "cleanup failure input revision was not found",
                )
            })?;
        if manifest.processing_receipts.len() >= MAX_PROCESSING_RECEIPTS {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_LIMIT_REACHED",
                "processing receipt history reached its local safety limit",
            ));
        }
        let input_revision_kind = effective_revision_kind(parent).label().to_string();
        let finished_at_ms = now_ms();
        let attempt = u32::try_from(manifest.processing_receipts.len())
            .unwrap_or(u32::MAX)
            .saturating_add(1);
        let receipt_id = format!("pr-{attempt:06}-{finished_at_ms}");
        manifest.schema_version = manifest.schema_version.max(CURRENT_MANIFEST_SCHEMA_VERSION);
        manifest.processing_receipts.push(ProcessingReceipt {
            receipt_id: receipt_id.clone(),
            attempt,
            operation: "transcript-cleanup".to_string(),
            stage: Some("cleanup".to_string()),
            outcome: if draft.cancelled {
                ProcessingOutcome::Cancelled
            } else {
                ProcessingOutcome::Failed
            },
            engine: draft.engine,
            model_id: draft.model_id,
            model_sha256: draft.model_sha256,
            revision_id: None,
            input_revision_id: Some(draft.parent_revision_id),
            input_revision_kind: Some(input_revision_kind),
            prompt_template_sha256: Some(draft.prompt_template_sha256),
            validation_result: Some("failed".to_string()),
            fallback_applied: false,
            error_code: Some(draft.error_code),
            error_summary: Some("local transcript cleanup did not complete".to_string()),
            comparison: None,
            started_at_ms: draft.started_at_ms.min(finished_at_ms),
            finished_at_ms,
            elapsed_ms: draft.elapsed_ms,
        });
        manifest.updated_at_ms = finished_at_ms;
        validate_manifest_structure(&manifest, &dir)?;
        write_manifest(&dir, &manifest)?;
        Ok(json!({
            "recordingId": manifest.recording_id,
            "receiptId": receipt_id,
            "outcome": if draft.cancelled { "cancelled" } else { "failed" },
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub(crate) fn record_recap_receipt(
        &self,
        draft: RecapReceiptDraft,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&draft.recording_id)?;
        validate_history_id(
            &draft.input_revision_id,
            "PROCESSING_RECEIPT_INPUT_REVISION_INVALID",
        )?;
        validate_processing_identity(
            &draft.engine,
            draft.model_id.as_deref(),
            draft.model_sha256.as_deref(),
        )?;
        if !is_sha256_hex(&draft.prompt_template_sha256) {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_PROMPT_HASH_INVALID",
                "recap prompt template fingerprint was invalid",
            ));
        }
        if !matches!(
            draft.validation_result.as_str(),
            "passed" | "not-applicable"
        ) {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_VALIDATION_INVALID",
                "recap validation result was not recognized",
            ));
        }
        let dir = self.recording_dir(&draft.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        let input_revision = manifest
            .transcript_revisions
            .iter()
            .find(|revision| revision.revision_id == draft.input_revision_id)
            .ok_or_else(|| {
                RecordingStoreError::new(
                    "PROCESSING_RECEIPT_INPUT_REVISION_INVALID",
                    "recap input revision was not found",
                )
            })?;
        if manifest.processing_receipts.len() >= MAX_PROCESSING_RECEIPTS {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_LIMIT_REACHED",
                "processing receipt history reached its local safety limit",
            ));
        }
        let input_revision_kind = effective_revision_kind(input_revision).label().to_string();
        let finished_at_ms = now_ms();
        let attempt = u32::try_from(manifest.processing_receipts.len())
            .unwrap_or(u32::MAX)
            .saturating_add(1);
        let receipt_id = format!("pr-{attempt:06}-{finished_at_ms}");
        manifest.schema_version = manifest.schema_version.max(CURRENT_MANIFEST_SCHEMA_VERSION);
        manifest.processing_receipts.push(ProcessingReceipt {
            receipt_id: receipt_id.clone(),
            attempt,
            operation: "local-ai-recap".to_string(),
            stage: Some("recap".to_string()),
            outcome: ProcessingOutcome::Succeeded,
            engine: draft.engine,
            model_id: draft.model_id,
            model_sha256: draft.model_sha256,
            revision_id: None,
            input_revision_id: Some(draft.input_revision_id),
            input_revision_kind: Some(input_revision_kind),
            prompt_template_sha256: Some(draft.prompt_template_sha256),
            validation_result: Some(draft.validation_result),
            fallback_applied: draft.fallback_applied,
            error_code: None,
            error_summary: None,
            comparison: None,
            started_at_ms: draft.started_at_ms.min(finished_at_ms),
            finished_at_ms,
            elapsed_ms: draft.elapsed_ms,
        });
        validate_manifest_structure(&manifest, &dir)?;
        write_manifest(&dir, &manifest)?;
        Ok(json!({
            "recordingId": draft.recording_id,
            "receiptId": receipt_id,
            "operation": "local-ai-recap",
            "inputRevisionId": manifest.processing_receipts.last().and_then(|receipt| receipt.input_revision_id.as_deref()),
            "fallbackApplied": draft.fallback_applied,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    fn complete_transcript_attempt_with_kind(
        &self,
        draft: TranscriptionSuccessDraft,
        commit_kind: TranscriptCommitKind,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&draft.recording_id)?;
        validate_processing_identity(
            &draft.engine,
            draft.model_id.as_deref(),
            draft.model_sha256.as_deref(),
        )?;
        validate_transcript_comparison(&draft.comparison)?;
        validate_raw_transcript_text(&draft.raw_text, &draft.comparison)?;
        if let Some(attempt_id) = draft.attempt_id.as_deref() {
            validate_history_id(attempt_id, "TRANSCRIPTION_ATTEMPT_ID_INVALID")?;
            if !draft.chunk_indices.is_empty() {
                return Err(RecordingStoreError::new(
                    "TRANSCRIPTION_ATTEMPT_CHUNKS_INVALID",
                    "a local transcription attempt cannot accept caller-selected chunks",
                ));
            }
        }
        if draft.chunk_indices.len() > MAX_REVISION_CHUNK_INDICES {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_REVISION_TOO_LARGE",
                "transcript revision contains too many segment references",
            ));
        }
        let _mutation_guard = self.manifest_mutation_guard();
        let dir = self.recording_dir(&draft.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        if let TranscriptCommitKind::ProtectedTermReview {
            expected_current_revision_id,
        } = &commit_kind
        {
            if manifest.current_transcript_revision_id.as_deref()
                != Some(expected_current_revision_id.as_str())
            {
                return Err(RecordingStoreError::new(
                    "PROTECTED_TERM_REVIEW_STALE",
                    "the current transcript changed after protected terms were reviewed",
                ));
            }
        }
        if manifest.state == RecordingState::NeedsRecovery {
            return Err(RecordingStoreError::new(
                "RECORDING_NEEDS_RECOVERY",
                "recording must be recovered before transcript history can be updated",
            ));
        }
        if manifest.transcript_revisions.len() >= MAX_TRANSCRIPT_REVISIONS {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_REVISION_LIMIT_REACHED",
                "transcript revision history reached its local safety limit",
            ));
        }
        if manifest.processing_receipts.len() >= MAX_PROCESSING_RECEIPTS {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_LIMIT_REACHED",
                "processing receipt history reached its local safety limit",
            ));
        }
        let chunk_indices = match draft.attempt_id.as_deref() {
            Some(attempt_id) => manifest
                .chunks
                .iter()
                .filter(|chunk| {
                    chunk.kind == DurableChunkKind::TranscriptSegment
                        && chunk.transcription_attempt_id.as_deref() == Some(attempt_id)
                })
                .map(|chunk| chunk.index)
                .collect::<Vec<_>>(),
            None => draft.chunk_indices,
        };
        let already_committed = committed_transcript_chunk_indices(&manifest);
        if draft.attempt_id.is_some()
            && chunk_indices
                .iter()
                .any(|index| already_committed.contains(index))
        {
            return Err(RecordingStoreError::new(
                "TRANSCRIPTION_ATTEMPT_ALREADY_COMMITTED",
                "local transcription attempt chunks already belong to immutable history",
            ));
        }
        validate_revision_chunk_indices(&manifest, &chunk_indices)?;
        validate_revision_attempt_membership(&manifest, &chunk_indices)?;
        let normalized_indices = chunk_indices.iter().copied().collect::<HashSet<_>>();
        let normalized_segments =
            self.transcript_segments_for_indices(&manifest, &dir, Some(&normalized_indices), true)?;
        if normalized_segments.len() as u64 != draft.comparison.normalized_segment_count {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_COMPARISON_CONTENT_INVALID",
                "normalized transcript segment count did not match immutable comparison metadata",
            ));
        }
        let normalized_text = transcript_text_from_segments(&normalized_segments);
        validate_normalized_transcript_text(&normalized_text, &draft.comparison)?;
        let finished_at_ms = now_ms();
        if draft.attempt_id.is_some() && manifest.transcript_revisions.is_empty() {
            self.promote_legacy_transcript_revision(&mut manifest, &dir, finished_at_ms)?;
        }
        let (source, operation, kind, parent_revision_id, input_revision_kind, stage) =
            match &commit_kind {
                TranscriptCommitKind::ProtectedTermReview {
                    expected_current_revision_id,
                } => {
                    let input_kind = manifest
                        .transcript_revisions
                        .iter()
                        .find(|revision| revision.revision_id == *expected_current_revision_id)
                        .map(effective_revision_kind)
                        .ok_or_else(|| {
                            RecordingStoreError::new(
                                "TRANSCRIPT_PARENT_REVISION_INVALID",
                                "protected-term review input revision was not found",
                            )
                        })?;
                    (
                        "review",
                        "protected-term-review",
                        TranscriptRevisionKind::Normalized,
                        Some(expected_current_revision_id.clone()),
                        Some(input_kind.label().to_string()),
                        "normalization",
                    )
                }
                TranscriptCommitKind::Transcription if manifest.transcript_revisions.is_empty() => {
                    (
                        "initial",
                        "transcription",
                        TranscriptRevisionKind::RawAsr,
                        None,
                        None,
                        "transcription",
                    )
                }
                TranscriptCommitKind::Transcription => (
                    "reprocess",
                    "transcription",
                    TranscriptRevisionKind::RawAsr,
                    None,
                    None,
                    "transcription",
                ),
            };
        let version = u32::try_from(manifest.transcript_revisions.len())
            .unwrap_or(u32::MAX)
            .saturating_add(1);
        let revision_id = format!("tr-{version:06}-{finished_at_ms}");
        let receipt_attempt = u32::try_from(manifest.processing_receipts.len())
            .unwrap_or(u32::MAX)
            .saturating_add(1);
        let receipt_id = format!("pr-{receipt_attempt:06}-{finished_at_ms}");
        let comparison = comparison_metadata(draft.comparison);
        manifest.schema_version = manifest.schema_version.max(CURRENT_MANIFEST_SCHEMA_VERSION);
        let (raw_text_chunk_indices, raw_chunk_paths) = self
            .append_encrypted_raw_transcript_chunks(
                &draft.recording_id,
                &mut manifest,
                &dir,
                &draft.raw_text,
                finished_at_ms,
            )?;
        manifest.transcript_revisions.push(TranscriptRevision {
            revision_id: revision_id.clone(),
            version,
            source: source.to_string(),
            kind,
            parent_revision_id: parent_revision_id.clone(),
            chunk_indices,
            engine: draft.engine.clone(),
            model_id: draft.model_id.clone(),
            model_sha256: draft.model_sha256.clone(),
            raw_text_chunk_indices: Some(raw_text_chunk_indices),
            comparison: comparison.clone(),
            created_at_ms: finished_at_ms,
        });
        manifest.current_transcript_revision_id = Some(revision_id.clone());
        manifest.processing_receipts.push(ProcessingReceipt {
            receipt_id: receipt_id.clone(),
            attempt: receipt_attempt,
            operation: operation.to_string(),
            stage: Some(stage.to_string()),
            outcome: ProcessingOutcome::Succeeded,
            engine: draft.engine,
            model_id: draft.model_id,
            model_sha256: draft.model_sha256,
            revision_id: Some(revision_id.clone()),
            input_revision_id: parent_revision_id,
            input_revision_kind,
            prompt_template_sha256: None,
            validation_result: Some("passed".to_string()),
            fallback_applied: false,
            error_code: None,
            error_summary: None,
            comparison: Some(comparison),
            started_at_ms: draft.started_at_ms.min(finished_at_ms),
            finished_at_ms,
            elapsed_ms: draft.elapsed_ms,
        });
        manifest.updated_at_ms = finished_at_ms;
        let commit = {
            #[cfg(test)]
            if self.fail_transcription_commit {
                Err(RecordingStoreError::new(
                    "TRANSCRIPTION_HISTORY_COMMIT_FAILED",
                    "injected transcription history commit failure",
                ))
            } else {
                write_manifest(&dir, &manifest)
            }
            #[cfg(not(test))]
            {
                write_manifest(&dir, &manifest)
            }
        };
        if let Err(error) = commit {
            for path in raw_chunk_paths {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
        #[cfg(feature = "sqlcipher-vault")]
        self.committed_trust_search_source_change();
        Ok(json!({
            "recordingId": manifest.recording_id,
            "revisionId": revision_id,
            "version": version,
            "receiptId": receipt_id,
            "source": source,
            "kind": kind.label(),
            "current": true,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    fn promote_legacy_transcript_revision(
        &self,
        manifest: &mut RecordingManifest,
        dir: &Path,
        migrated_at_ms: u128,
    ) -> Result<bool, RecordingStoreError> {
        if !manifest.transcript_revisions.is_empty() {
            return Ok(false);
        }
        let mut chunk_indices = current_transcript_chunk_indices(manifest)
            .into_iter()
            .collect::<Vec<_>>();
        chunk_indices.sort_unstable();
        if chunk_indices.is_empty() {
            return Ok(false);
        }
        if chunk_indices.len() > MAX_REVISION_CHUNK_INDICES {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_REVISION_TOO_LARGE",
                "legacy transcript contains too many segment references to preserve safely",
            ));
        }
        let selected_indices = chunk_indices.iter().copied().collect::<HashSet<_>>();
        legacy_transcript_bytes_with_limit(
            manifest,
            &selected_indices,
            MAX_RAW_TRANSCRIPT_BYTES as u64,
        )?;
        let segments =
            self.transcript_segments_for_indices(manifest, dir, Some(&selected_indices), true)?;
        let text = transcript_text_from_segments(&segments);
        let text_bytes = u64::try_from(text.len()).unwrap_or(u64::MAX);
        let text_sha256 = hex_digest(&Sha256::digest(text.as_bytes()));
        let segment_count = u64::try_from(segments.len()).unwrap_or(u64::MAX);
        let created_at_ms = manifest
            .chunks
            .iter()
            .filter(|chunk| selected_indices.contains(&chunk.index))
            .map(|chunk| chunk.created_at_ms)
            .max()
            .unwrap_or(manifest.created_at_ms)
            .min(migrated_at_ms);
        let revision_id = format!("tr-000001-{created_at_ms}");
        manifest.transcript_revisions.push(TranscriptRevision {
            revision_id: revision_id.clone(),
            version: 1,
            source: "initial".to_string(),
            kind: TranscriptRevisionKind::Legacy,
            parent_revision_id: None,
            chunk_indices,
            engine: "legacy-manual".to_string(),
            model_id: None,
            model_sha256: None,
            raw_text_chunk_indices: None,
            comparison: TranscriptComparisonMetadata {
                raw_text_sha256: text_sha256.clone(),
                normalized_text_sha256: text_sha256,
                raw_text_bytes: text_bytes,
                normalized_text_bytes: text_bytes,
                raw_segment_count: segment_count,
                normalized_segment_count: segment_count,
                changed: false,
            },
            created_at_ms,
        });
        manifest.current_transcript_revision_id = Some(revision_id);
        Ok(true)
    }

    pub(crate) fn record_transcription_failure(
        &self,
        draft: TranscriptionFailureDraft,
    ) -> Result<Value, RecordingStoreError> {
        validate_id(&draft.recording_id)?;
        validate_processing_identity(&draft.engine, draft.model_id.as_deref(), None)?;
        validate_stable_code(&draft.error_code, "PROCESSING_RECEIPT_ERROR_CODE_INVALID")?;
        let _mutation_guard = self.manifest_mutation_guard();
        let dir = self.recording_dir(&draft.recording_id)?;
        let mut manifest = read_manifest(&dir)?;
        if manifest.processing_receipts.len() >= MAX_PROCESSING_RECEIPTS {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_LIMIT_REACHED",
                "processing receipt history reached its local safety limit",
            ));
        }
        let finished_at_ms = now_ms();
        let attempt = u32::try_from(manifest.processing_receipts.len())
            .unwrap_or(u32::MAX)
            .saturating_add(1);
        let receipt_id = format!("pr-{attempt:06}-{finished_at_ms}");
        let outcome = if draft.cancelled {
            ProcessingOutcome::Cancelled
        } else {
            ProcessingOutcome::Failed
        };
        manifest.processing_receipts.push(ProcessingReceipt {
            receipt_id: receipt_id.clone(),
            attempt,
            operation: "transcription".to_string(),
            stage: Some("transcription".to_string()),
            outcome,
            engine: draft.engine,
            model_id: draft.model_id,
            model_sha256: None,
            revision_id: None,
            input_revision_id: None,
            input_revision_kind: None,
            prompt_template_sha256: None,
            validation_result: Some("failed".to_string()),
            fallback_applied: false,
            error_code: Some(draft.error_code),
            error_summary: Some("local transcription did not complete".to_string()),
            comparison: None,
            started_at_ms: draft.started_at_ms.min(finished_at_ms),
            finished_at_ms,
            elapsed_ms: draft.elapsed_ms,
        });
        manifest.updated_at_ms = finished_at_ms;
        write_manifest(&dir, &manifest)?;
        Ok(json!({
            "recordingId": manifest.recording_id,
            "receiptId": receipt_id,
            "outcome": if draft.cancelled { "cancelled" } else { "failed" },
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
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
            "transcription" | "local-ai-cleanup" | "local-ai-recap" | "local-ai-ask"
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
                ai_provenance: None,
                created_at_ms: now_ms(),
            },
        )
    }

    pub fn record_ai_processing_fact(
        &self,
        recording_id: &str,
        event_type: &str,
        provenance: &Value,
    ) -> Result<(), RecordingStoreError> {
        if !matches!(event_type, "local-ai-recap" | "local-ai-ask") {
            return Err(RecordingStoreError::new(
                "PRIVACY_EVENT_TYPE_INVALID",
                "AI privacy event type was not allowed",
            ));
        }
        let object = provenance.as_object().ok_or_else(|| {
            RecordingStoreError::new(
                "PRIVACY_AI_PROVENANCE_INVALID",
                "AI provenance was not a structured object",
            )
        })?;
        let engine = object
            .get("engine")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(engine, "local-llm" | "heuristic") {
            return Err(RecordingStoreError::new(
                "PRIVACY_AI_PROVENANCE_INVALID",
                "AI provenance engine was invalid",
            ));
        }
        let model_id = object.get("modelId").and_then(Value::as_str);
        if engine == "local-llm" && model_id.is_none() {
            return Err(RecordingStoreError::new(
                "PRIVACY_AI_PROVENANCE_INVALID",
                "local AI provenance did not identify its model",
            ));
        }
        if model_id.is_some_and(|value| value.is_empty() || value.len() > 200) {
            return Err(RecordingStoreError::new(
                "PRIVACY_AI_PROVENANCE_INVALID",
                "AI provenance model identifier was invalid",
            ));
        }
        let fallback_used = object
            .get("fallbackUsed")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                RecordingStoreError::new(
                    "PRIVACY_AI_PROVENANCE_INVALID",
                    "AI provenance omitted fallback status",
                )
            })?;
        let fallback_reason = object.get("fallbackReason").and_then(Value::as_str);
        if fallback_used != fallback_reason.is_some()
            || fallback_reason.is_some_and(|value| {
                !matches!(
                    value,
                    "llm-unavailable"
                        | "runtime-failed"
                        | "model-corrupt"
                        | "resource-policy"
                        | "user-requested"
                )
            })
        {
            return Err(RecordingStoreError::new(
                "PRIVACY_AI_PROVENANCE_INVALID",
                "AI provenance fallback reason was invalid",
            ));
        }
        let prompt_version = object
            .get("promptVersion")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 100)
            .ok_or_else(|| {
                RecordingStoreError::new(
                    "PRIVACY_AI_PROVENANCE_INVALID",
                    "AI provenance prompt version was invalid",
                )
            })?;
        let generated_at = object
            .get("generatedAt")
            .and_then(Value::as_str)
            .filter(|value| {
                value.len() <= 64
                    && value.is_ascii()
                    && value.contains('T')
                    && (value.ends_with('Z') || value.contains('+'))
            })
            .ok_or_else(|| {
                RecordingStoreError::new(
                    "PRIVACY_AI_PROVENANCE_INVALID",
                    "AI provenance generation time was invalid",
                )
            })?;
        self.append_privacy_event(
            recording_id,
            PrivacyEvent {
                event_type: event_type.to_string(),
                engine: Some(engine.to_string()),
                model_id: model_id.map(str::to_string),
                sha256: None,
                format: None,
                bytes: None,
                ai_provenance: Some(AiPrivacyProvenance {
                    engine: engine.to_string(),
                    model_id: model_id.map(str::to_string),
                    fallback_used,
                    fallback_reason: fallback_reason.map(str::to_string),
                    prompt_version: prompt_version.to_string(),
                    generated_at: generated_at.to_string(),
                }),
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
        let committed_transcript_indices = committed_transcript_chunk_indices(&manifest);
        let transcript_segment_count = manifest
            .chunks
            .iter()
            .filter(|chunk| {
                chunk.kind == DurableChunkKind::TranscriptSegment
                    && !is_uncommitted_attempt_chunk(chunk, &committed_transcript_indices)
            })
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
            "trustHistory": {
                "currentRevisionId": manifest.current_transcript_revision_id,
                "revisionCount": manifest.transcript_revisions.len(),
                "processingReceiptCount": manifest.processing_receipts.len(),
                "processingReceipts": manifest.processing_receipts,
                "immutableRevisions": true
            },
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

        let _mutation_guard = self.manifest_mutation_guard();
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
            content_sha256: None,
            speaker: None,
            confidence: None,
            sample_rate_hz: None,
            channel_count: None,
            bits_per_sample: None,
            start_ms: None,
            duration_ms: None,
            transcription_attempt_id: None,
            created_at_ms: now_ms(),
        });
        manifest.updated_at_ms = now_ms();
        write_manifest(&dir, &manifest)?;
        #[cfg(feature = "sqlcipher-vault")]
        self.committed_trust_search_source_change();
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
        let query = validated_search_query(&params.query)?;
        #[cfg(feature = "sqlcipher-vault")]
        {
            let source_generation = {
                let _source_guard = self.manifest_mutation_lock.try_lock().map_err(|_| {
                    RecordingStoreError::new(
                        "RECORDING_SEARCH_INDEX_BUILDING",
                        "encrypted local search is catching up with a meeting update; retry shortly",
                    )
                })?;
                if let Some(failure) = self
                    .trust_search_backfill_failure
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone()
                {
                    return Err(failure.as_error());
                }
                let source_generation = self.trust_search_source_generation.load(Ordering::Acquire);
                if source_generation != self.trust_search_index_generation.load(Ordering::Acquire) {
                    self.schedule_trust_search_backfill();
                    return Err(RecordingStoreError::new(
                        "RECORDING_SEARCH_INDEX_BUILDING",
                        "encrypted local search is being prepared; retry shortly",
                    ));
                }
                source_generation
            };
            match self.search_sqlcipher_fts(query) {
                Ok(result) => {
                    let _source_guard = self.manifest_mutation_lock.try_lock().map_err(|_| {
                        RecordingStoreError::new(
                            "RECORDING_SEARCH_INDEX_BUILDING",
                            "encrypted local search changed during the query; retry shortly",
                        )
                    })?;
                    if self.trust_search_source_generation.load(Ordering::Acquire)
                        != source_generation
                        || self.trust_search_index_generation.load(Ordering::Acquire)
                            != source_generation
                    {
                        self.schedule_trust_search_backfill();
                        return Err(RecordingStoreError::new(
                            "RECORDING_SEARCH_INDEX_BUILDING",
                            "encrypted local search changed during the query; retry shortly",
                        ));
                    }
                    Ok(result)
                }
                Err(error) if error.code == "TRUST_SEARCH_INDEX_NOT_READY" => {
                    self.schedule_trust_search_backfill();
                    if let Some(failure) = self
                        .trust_search_backfill_failure
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone()
                    {
                        return Err(failure.as_error());
                    }
                    Err(RecordingStoreError::new(
                        "RECORDING_SEARCH_INDEX_BUILDING",
                        "encrypted local search is being prepared; retry shortly",
                    ))
                }
                Err(error) => Err(error),
            }
        }
        #[cfg(not(feature = "sqlcipher-vault"))]
        {
            let (rows, quarantined_count, truncated) = self.searchable_text_rows()?;
            Ok(self.search_bounded_fallback(
                query,
                &rows,
                quarantined_count,
                truncated,
                "bounded-scan",
            ))
        }
    }

    /// Searches durable encrypted source chunks without creating directories,
    /// keys, quarantine receipts, or an index. This is deliberately separate
    /// from the desktop SQLCipher FTS path because an automation process cannot
    /// safely establish that another process's in-memory index generation is
    /// current or rebuild that index while remaining read-only.
    pub fn search_read_only(
        &self,
        params: SearchRecordingsParams,
    ) -> Result<Value, RecordingStoreError> {
        let query = validated_search_query(&params.query)?;
        let (rows, quarantined_count, truncated) = self.searchable_text_rows_bounded(
            MAX_AUTOMATION_SEARCHABLE_RECORDINGS,
            MAX_AUTOMATION_SEARCHABLE_CHUNK_DESCRIPTORS,
            MAX_AUTOMATION_SEARCHABLE_MANIFEST_BYTES_TOTAL,
            MAX_AUTOMATION_SEARCHABLE_ROWS,
            MAX_AUTOMATION_SEARCHABLE_BYTES,
            true,
        )?;
        let response = self.search_bounded_fallback(
            query,
            &rows,
            quarantined_count,
            truncated,
            "bounded-read-only-source-scan",
        );
        bounded_automation_response(
            response,
            MAX_AUTOMATION_SEARCH_RESPONSE_BYTES,
            "AUTOMATION_SEARCH_RESPONSE_TOO_LARGE",
        )
    }

    fn searchable_text_rows(
        &self,
    ) -> Result<(Vec<SearchableTextRow>, u64, bool), RecordingStoreError> {
        #[cfg(feature = "sqlcipher-vault")]
        {
            self.searchable_text_rows_bounded(
                MAX_SEARCHABLE_RECORDINGS,
                MAX_SEARCHABLE_CHUNK_DESCRIPTORS,
                MAX_SEARCHABLE_MANIFEST_BYTES_TOTAL,
                MAX_SEARCHABLE_ROWS,
                MAX_SEARCHABLE_BYTES,
                false,
            )
        }
        #[cfg(not(feature = "sqlcipher-vault"))]
        {
            self.searchable_text_rows_bounded(
                MAX_FALLBACK_SEARCHABLE_RECORDINGS,
                4_096,
                4 * 1024 * 1024,
                MAX_FALLBACK_SEARCHABLE_ROWS,
                MAX_FALLBACK_SEARCHABLE_BYTES,
                false,
            )
        }
    }

    fn searchable_text_rows_bounded(
        &self,
        recording_limit: usize,
        chunk_descriptor_limit: usize,
        manifest_bytes_limit: u64,
        max_rows: usize,
        max_bytes: u64,
        read_only: bool,
    ) -> Result<(Vec<SearchableTextRow>, u64, bool), RecordingStoreError> {
        let (collection, manifest_truncated, read_only_quarantined_count) = if read_only {
            let (collection, truncated, quarantined_count) = self
                .collect_search_manifests_read_only_bounded(
                    recording_limit,
                    chunk_descriptor_limit,
                    manifest_bytes_limit,
                )?;
            (collection, truncated, Some(quarantined_count))
        } else {
            let (collection, truncated) = self.collect_search_manifests_bounded(
                recording_limit,
                chunk_descriptor_limit,
                manifest_bytes_limit,
            )?;
            (collection, truncated, None)
        };
        let mut quarantined_count =
            read_only_quarantined_count.unwrap_or(collection.quarantined.len() as u64);
        let mut rows = Vec::new();
        let mut searchable_bytes = 0_u64;
        let mut truncated = manifest_truncated;
        let mut stop = false;
        for (manifest, dir) in collection.items {
            let response_label = manifest
                .label
                .as_deref()
                .map(|label| truncate_utf8(label, MAX_AUTOMATION_LABEL_RESPONSE_BYTES));
            if read_only {
                if let Some(label) = response_label.as_deref().filter(|label| !label.is_empty()) {
                    if rows.len() >= max_rows
                        || label.len() as u64 > max_bytes.saturating_sub(searchable_bytes)
                    {
                        truncated = true;
                        break;
                    }
                    searchable_bytes = searchable_bytes.saturating_add(label.len() as u64);
                    rows.push(SearchableTextRow {
                        recording_id: manifest.recording_id.clone(),
                        label: response_label.clone(),
                        state: recording_state_label(&manifest.state),
                        chunk_index: 0,
                        channel: "metadata".to_string(),
                        row_kind: "meetingLabel",
                        text: label.to_string(),
                    });
                }
            }
            let selected_indices = current_transcript_chunk_indices(&manifest);
            let cleaned_indices = manifest
                .current_cleaned_revision_id
                .as_deref()
                .and_then(|revision_id| {
                    manifest
                        .transcript_revisions
                        .iter()
                        .find(|revision| revision.revision_id == revision_id)
                })
                .filter(|revision| {
                    revision.parent_revision_id.as_deref()
                        == manifest.current_transcript_revision_id.as_deref()
                })
                .map(|revision| {
                    revision
                        .chunk_indices
                        .iter()
                        .copied()
                        .collect::<HashSet<_>>()
                })
                .unwrap_or_default();
            let latest_notes_index = manifest
                .chunks
                .iter()
                .filter(|chunk| chunk.kind == DurableChunkKind::NotesMarkdown)
                .map(|chunk| chunk.index)
                .max();
            for chunk in manifest.chunks.iter().filter(|chunk| match chunk.kind {
                DurableChunkKind::TranscriptSegment => {
                    selected_indices.contains(&chunk.index)
                        || cleaned_indices.contains(&chunk.index)
                }
                DurableChunkKind::TranscriptText => true,
                DurableChunkKind::NotesMarkdown => latest_notes_index == Some(chunk.index),
                DurableChunkKind::AudioPcm16le | DurableChunkKind::RawTranscriptText => false,
            }) {
                if rows.len() >= max_rows
                    || chunk.bytes > max_bytes.saturating_sub(searchable_bytes)
                {
                    truncated = true;
                    stop = true;
                    break;
                }
                let bytes = match self
                    .read_chunk_bytes_with_key_access(&manifest, chunk, &dir, !read_only)
                {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        if !read_only {
                            let _ = self.quarantine_summary(&manifest.recording_id, error.code);
                        }
                        quarantined_count = quarantined_count.saturating_add(1);
                        break;
                    }
                };
                if bytes.len() as u64 > max_bytes.saturating_sub(searchable_bytes) {
                    truncated = true;
                    stop = true;
                    break;
                }
                let text = match String::from_utf8(bytes) {
                    Ok(text) => text,
                    Err(_) => {
                        if !read_only {
                            let _ = self.quarantine_summary(
                                &manifest.recording_id,
                                "RECORDING_TEXT_ENCODING_INVALID",
                            );
                        }
                        quarantined_count = quarantined_count.saturating_add(1);
                        break;
                    }
                };
                searchable_bytes = searchable_bytes.saturating_add(text.len() as u64);
                let row_kind = match chunk.kind {
                    DurableChunkKind::TranscriptSegment
                        if cleaned_indices.contains(&chunk.index) =>
                    {
                        "cleanedTranscriptSegment"
                    }
                    DurableChunkKind::TranscriptSegment => "originalTranscriptSegment",
                    DurableChunkKind::TranscriptText => "originalTranscriptText",
                    _ => chunk_kind_label(&chunk.kind),
                };
                rows.push(SearchableTextRow {
                    recording_id: manifest.recording_id.clone(),
                    label: if read_only {
                        response_label.clone()
                    } else {
                        manifest.label.clone()
                    },
                    state: recording_state_label(&manifest.state),
                    chunk_index: chunk.index,
                    channel: if read_only {
                        truncate_utf8(&chunk.channel, MAX_AUTOMATION_CHANNEL_RESPONSE_BYTES)
                    } else {
                        chunk.channel.clone()
                    },
                    row_kind,
                    text,
                });
            }
            if stop {
                break;
            }
        }
        Ok((rows, quarantined_count, truncated))
    }

    fn search_bounded_fallback(
        &self,
        query: &str,
        rows: &[SearchableTextRow],
        quarantined_count: u64,
        source_truncated: bool,
        search_backend: &str,
    ) -> Value {
        let query_lower = query.to_lowercase();
        let mut matches = Vec::new();
        let mut truncated = source_truncated;
        for row in rows {
            let text_lower = row.text.to_lowercase();
            let Some(offset) = text_lower.find(&query_lower) else {
                continue;
            };
            if matches.len() >= MAX_SEARCH_MATCHES {
                truncated = true;
                break;
            }
            matches.push(json!({
                "recordingId": row.recording_id,
                "label": row.label,
                "state": row.state,
                "chunkIndex": row.chunk_index,
                "channel": row.channel,
                "rowKind": row.row_kind,
                "snippet": snippet(&row.text, offset, query.len()),
                "rawPathExposed": false
            }));
        }
        json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false,
            "query": query,
            "matchCount": matches.len(),
            "matchLimit": MAX_SEARCH_MATCHES,
            "truncated": truncated,
            "quarantinedCount": quarantined_count,
            "searchBackend": search_backend,
            "encryptedIndex": false,
            "plaintextIndexPersisted": false,
            "matches": matches
        })
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn open_existing_trust_search_connection(&self) -> Result<Connection, RecordingStoreError> {
        let search_root = self.root.join(TRUST_SEARCH_DIR);
        let search_path = search_root.join(TRUST_SEARCH_FILE);
        let root_metadata = fs::symlink_metadata(&search_root).map_err(|_| {
            RecordingStoreError::new(
                "TRUST_SEARCH_INDEX_NOT_READY",
                "encrypted search index has not been built yet",
            )
        })?;
        if root_metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&root_metadata)
            || !root_metadata.is_dir()
        {
            return Err(RecordingStoreError::new(
                "TRUST_SEARCH_OPEN_FAILED",
                "encrypted search storage was not an owned directory",
            ));
        }
        let file_metadata = fs::symlink_metadata(&search_path).map_err(|_| {
            RecordingStoreError::new(
                "TRUST_SEARCH_INDEX_NOT_READY",
                "encrypted search index has not been built yet",
            )
        })?;
        if file_metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&file_metadata)
            || !file_metadata.is_file()
        {
            return Err(RecordingStoreError::new(
                "TRUST_SEARCH_OPEN_FAILED",
                "encrypted search index was not an owned file",
            ));
        }
        let key = os_key_store::get_existing_key(&self.root)
            .map_err(|error| RecordingStoreError::new(error.code, error.message))?;
        let connection = Connection::open_with_flags(
            search_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| RecordingStoreError::new("TRUST_SEARCH_OPEN_FAILED", error.to_string()))?;
        Self::key_trust_search_connection(&connection, &key)?;
        Ok(connection)
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn key_trust_search_connection(
        connection: &Connection,
        key: &os_key_store::OsKey,
    ) -> Result<(), RecordingStoreError> {
        connection
            .pragma_update(None, "key", key.sqlcipher_passphrase())
            .map_err(|error| {
                RecordingStoreError::new("TRUST_SEARCH_KEY_FAILED", error.to_string())
            })?;
        let cipher_version = connection
            .query_row("PRAGMA cipher_version", [], |row| row.get::<_, String>(0))
            .map_err(|error| {
                RecordingStoreError::new("TRUST_SEARCH_SQLCIPHER_UNAVAILABLE", error.to_string())
            })?;
        if cipher_version.trim().is_empty() {
            return Err(RecordingStoreError::new(
                "TRUST_SEARCH_SQLCIPHER_UNAVAILABLE",
                "encrypted search requires SQLCipher",
            ));
        }
        Ok(())
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn committed_trust_search_source_change(&self) {
        self.mark_trust_search_source_change();
        self.schedule_trust_search_backfill();
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn mark_trust_search_source_change(&self) {
        self.trust_search_source_generation
            .fetch_add(1, Ordering::AcqRel);
        *self
            .trust_search_backfill_failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn schedule_trust_search_backfill(&self) {
        if self
            .trust_search_backfill_failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
        {
            return;
        }
        if self
            .trust_search_backfill_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let store = self.clone();
        let spawned = std::thread::Builder::new()
            .name("candor-trust-search-backfill".to_string())
            .spawn(move || {
                lower_trust_search_backfill_priority();
                let changed_during_backfill = match store.rebuild_trust_search_index_once() {
                    Ok(true) => {
                        *store
                            .trust_search_backfill_failure
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                        false
                    }
                    Ok(false) => true,
                    Err(error) => {
                        *store
                            .trust_search_backfill_failure
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                            Some(TrustSearchBackfillFailure::from_error(&error));
                        false
                    }
                };
                store.finish_trust_search_backfill(changed_during_backfill);
            });
        if spawned.is_err() {
            self.trust_search_backfill_running
                .store(false, Ordering::Release);
            *self
                .trust_search_backfill_failure
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                Some(TrustSearchBackfillFailure {
                    code: "TRUST_SEARCH_BACKFILL_FAILED",
                    message: "encrypted local search could not start index preparation",
                });
        }
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn finish_trust_search_backfill(&self, retry_requested: bool) {
        self.trust_search_backfill_running
            .store(false, Ordering::Release);
        if retry_requested
            || self.trust_search_source_generation.load(Ordering::Acquire)
                != self.trust_search_index_generation.load(Ordering::Acquire)
        {
            std::thread::sleep(std::time::Duration::from_millis(25));
            self.schedule_trust_search_backfill();
        }
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn rebuild_trust_search_index_once(&self) -> Result<bool, RecordingStoreError> {
        let _search_guard = self
            .trust_search_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let source_generation = self.trust_search_source_generation.load(Ordering::Acquire);
        let (rows, quarantined_count, source_truncated) = self.searchable_text_rows()?;
        let search_root = self.root.join(TRUST_SEARCH_DIR);
        match fs::symlink_metadata(&search_root) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink()
                    || metadata_is_reparse_point(&metadata)
                    || !metadata.is_dir()
                {
                    return Err(RecordingStoreError::new(
                        "TRUST_SEARCH_CREATE_FAILED",
                        "encrypted search storage was not an owned directory",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(&search_root).map_err(io_error("TRUST_SEARCH_CREATE_FAILED"))?;
            }
            Err(error) => {
                return Err(RecordingStoreError::new(
                    "TRUST_SEARCH_CREATE_FAILED",
                    error.to_string(),
                ));
            }
        }

        let next_path = search_root.join(format!("{TRUST_SEARCH_FILE}.next"));
        let next_sidecar_paths = [
            next_path.clone(),
            search_root.join(format!("{TRUST_SEARCH_FILE}.next-journal")),
            search_root.join(format!("{TRUST_SEARCH_FILE}.next-wal")),
            search_root.join(format!("{TRUST_SEARCH_FILE}.next-shm")),
        ];
        remove_owned_trust_search_files(&next_sidecar_paths)?;
        let key = os_key_store::get_or_create_key(&self.root)
            .map_err(|error| RecordingStoreError::new(error.code, error.message))?;
        let mut connection = Connection::open_with_flags(
            &next_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| RecordingStoreError::new("TRUST_SEARCH_OPEN_FAILED", error.to_string()))?;
        Self::key_trust_search_connection(&connection, &key)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = DELETE;
                 PRAGMA temp_store = MEMORY;
                 PRAGMA secure_delete = ON;
                 CREATE TABLE candor_trust_meta (
                     id INTEGER PRIMARY KEY CHECK (id = 1),
                     quarantined_count INTEGER NOT NULL,
                     source_truncated INTEGER NOT NULL
                 );
                 CREATE VIRTUAL TABLE candor_trust_fts USING fts5(
                     recording_id UNINDEXED,
                     label UNINDEXED,
                     state UNINDEXED,
                     chunk_index UNINDEXED,
                     channel UNINDEXED,
                     row_kind UNINDEXED,
                     text,
                     tokenize = 'unicode61'
                 );",
            )
            .map_err(|error| {
                RecordingStoreError::new("TRUST_SEARCH_SCHEMA_FAILED", error.to_string())
            })?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                RecordingStoreError::new("TRUST_SEARCH_SYNC_FAILED", error.to_string())
            })?;
        transaction
            .execute(
                "INSERT INTO candor_trust_meta (
                    id, quarantined_count, source_truncated
                 ) VALUES (1, ?1, ?2)",
                params![
                    i64::try_from(quarantined_count).unwrap_or(i64::MAX),
                    i64::from(source_truncated)
                ],
            )
            .map_err(|error| {
                RecordingStoreError::new("TRUST_SEARCH_SYNC_FAILED", error.to_string())
            })?;
        {
            let mut insert = transaction
                .prepare(
                    "INSERT INTO candor_trust_fts (
                        recording_id, label, state, chunk_index, channel, row_kind, text
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(|error| {
                    RecordingStoreError::new("TRUST_SEARCH_SYNC_FAILED", error.to_string())
                })?;
            for row in &rows {
                insert
                    .execute(params![
                        row.recording_id,
                        row.label,
                        row.state,
                        i64::from(row.chunk_index),
                        row.channel,
                        row.row_kind,
                        row.text
                    ])
                    .map_err(|error| {
                        RecordingStoreError::new("TRUST_SEARCH_SYNC_FAILED", error.to_string())
                    })?;
            }
        }
        transaction.commit().map_err(|error| {
            RecordingStoreError::new("TRUST_SEARCH_SYNC_FAILED", error.to_string())
        })?;
        connection
            .pragma_update(None, "user_version", TRUST_SEARCH_SCHEMA_VERSION)
            .map_err(|error| {
                RecordingStoreError::new("TRUST_SEARCH_SCHEMA_FAILED", error.to_string())
            })?;
        drop(connection);

        if self.trust_search_source_generation.load(Ordering::Acquire) != source_generation {
            let _ = remove_owned_trust_search_files(&next_sidecar_paths);
            return Ok(false);
        }

        let search_path = search_root.join(TRUST_SEARCH_FILE);
        for path in [
            search_path.clone(),
            search_root.join(format!("{TRUST_SEARCH_FILE}-journal")),
            search_root.join(format!("{TRUST_SEARCH_FILE}-wal")),
            search_root.join(format!("{TRUST_SEARCH_FILE}-shm")),
        ] {
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    let _ = remove_owned_trust_search_files(&next_sidecar_paths);
                    return Err(RecordingStoreError::new(
                        "TRUST_SEARCH_SYNC_FAILED",
                        error.to_string(),
                    ));
                }
            };
            if metadata.file_type().is_symlink()
                || metadata_is_reparse_point(&metadata)
                || !metadata.is_file()
            {
                let _ = remove_owned_trust_search_files(&next_sidecar_paths);
                return Err(RecordingStoreError::new(
                    "TRUST_SEARCH_SYNC_FAILED",
                    "encrypted search index contained an unowned file",
                ));
            }
            fs::remove_file(&path).map_err(io_error("TRUST_SEARCH_SYNC_FAILED"))?;
        }
        fs::rename(&next_path, &search_path).map_err(io_error("TRUST_SEARCH_SYNC_FAILED"))?;
        self.trust_search_index_generation
            .store(source_generation, Ordering::Release);
        Ok(true)
    }

    #[cfg(feature = "sqlcipher-vault")]
    fn search_sqlcipher_fts(&self, query: &str) -> Result<Value, RecordingStoreError> {
        let _search_guard = self.trust_search_lock.try_lock().map_err(|_| {
            RecordingStoreError::new(
                "TRUST_SEARCH_INDEX_NOT_READY",
                "encrypted search index maintenance is still running",
            )
        })?;
        if self.trust_search_source_generation.load(Ordering::Acquire)
            != self.trust_search_index_generation.load(Ordering::Acquire)
        {
            return Err(RecordingStoreError::new(
                "TRUST_SEARCH_INDEX_NOT_READY",
                "encrypted search index is waiting for local backfill",
            ));
        }
        let connection = self.open_existing_trust_search_connection()?;
        let schema_version = connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .map_err(|error| {
                RecordingStoreError::new("TRUST_SEARCH_INDEX_NOT_READY", error.to_string())
            })?;
        if schema_version != TRUST_SEARCH_SCHEMA_VERSION {
            return Err(RecordingStoreError::new(
                "TRUST_SEARCH_INDEX_NOT_READY",
                "encrypted search index requires a local schema backfill",
            ));
        }
        let (quarantined_count, source_truncated) = connection
            .query_row(
                "SELECT quarantined_count, source_truncated
                 FROM candor_trust_meta WHERE id = 1",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .map(|(quarantined, truncated)| {
                (
                    u64::try_from(quarantined).unwrap_or_default(),
                    truncated != 0,
                )
            })
            .map_err(|error| {
                RecordingStoreError::new("TRUST_SEARCH_INDEX_NOT_READY", error.to_string())
            })?;

        let literal_query = fts_literal_query(query)?;
        let mut statement = connection
            .prepare(
                "SELECT recording_id, label, state, chunk_index, channel, row_kind,
                        substr(snippet(candor_trust_fts, 6, '', '', '...', 32), 1, 1000)
                 FROM candor_trust_fts
                 WHERE candor_trust_fts MATCH ?1
                 ORDER BY rowid
                 LIMIT ?2",
            )
            .map_err(|error| {
                RecordingStoreError::new("TRUST_SEARCH_QUERY_FAILED", error.to_string())
            })?;
        let query_limit = i64::try_from(MAX_SEARCH_MATCHES.saturating_add(1)).unwrap_or(i64::MAX);
        let result_rows = statement
            .query_map(params![literal_query, query_limit], |row| {
                Ok(SearchableTextRow {
                    recording_id: row.get(0)?,
                    label: row.get(1)?,
                    state: match row.get::<_, String>(2)?.as_str() {
                        "recording" => "recording",
                        "needsRecovery" => "needsRecovery",
                        "finished" => "finished",
                        _ => "unknown",
                    },
                    chunk_index: u32::try_from(row.get::<_, i64>(3)?).unwrap_or_default(),
                    channel: row.get(4)?,
                    row_kind: match row.get::<_, String>(5)?.as_str() {
                        "transcriptText" => "transcriptText",
                        "transcriptSegment" => "transcriptSegment",
                        "originalTranscriptText" => "originalTranscriptText",
                        "originalTranscriptSegment" => "originalTranscriptSegment",
                        "cleanedTranscriptSegment" => "cleanedTranscriptSegment",
                        "notesMarkdown" => "notesMarkdown",
                        _ => "unknown",
                    },
                    text: row.get(6)?,
                })
            })
            .map_err(|error| {
                RecordingStoreError::new("TRUST_SEARCH_QUERY_FAILED", error.to_string())
            })?;
        let mut matches = Vec::new();
        let mut truncated = source_truncated;
        let query_lower = query.to_lowercase();
        for row in result_rows {
            let row = row.map_err(|error| {
                RecordingStoreError::new("TRUST_SEARCH_QUERY_FAILED", error.to_string())
            })?;
            if matches.len() >= MAX_SEARCH_MATCHES {
                truncated = true;
                break;
            }
            let offset = row
                .text
                .to_lowercase()
                .find(&query_lower)
                .unwrap_or_default();
            matches.push(json!({
                "recordingId": row.recording_id,
                "label": row.label,
                "state": row.state,
                "chunkIndex": row.chunk_index,
                "channel": row.channel,
                "rowKind": row.row_kind,
                "snippet": snippet(&row.text, offset, query.len()),
                "rawPathExposed": false
            }));
        }
        Ok(json!({
            "rootKind": self.root_kind,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false,
            "query": query,
            "matchCount": matches.len(),
            "matchLimit": MAX_SEARCH_MATCHES,
            "truncated": truncated,
            "quarantinedCount": quarantined_count,
            "searchBackend": "sqlcipher-fts5",
            "encryptedIndex": true,
            "plaintextIndexPersisted": false,
            "indexReady": true,
            "indexRebuildScheduled": false,
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
                ai_provenance: None,
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

    pub(crate) fn pcm_tracks_for_transcription(
        &self,
        recording_id: &str,
        channel: Option<&str>,
    ) -> Result<Vec<PcmTrack>, RecordingStoreError> {
        validate_id(recording_id)?;
        if let Some(channel) = channel {
            validate_channel(channel)?;
        }
        let dir = self.recording_dir(recording_id)?;
        let manifest = read_manifest(&dir)?;
        let selected_channels = transcription_source_channels(&manifest, channel);
        if selected_channels.is_empty() {
            let (code, message) =
                if channel.is_some_and(|channel| channel != COMBINED_TRANSCRIPTION_CHANNEL) {
                    (
                        "TRANSCRIPTION_AUDIO_CHANNEL_NOT_FOUND",
                        "recording has no audio for the selected transcription channel",
                    )
                } else {
                    (
                        "TRANSCRIPTION_AUDIO_UNAVAILABLE",
                        "recording has no audio chunks to transcribe",
                    )
                };
            return Err(RecordingStoreError::new(code, message));
        }
        if selected_channels.len() > MAX_COMBINED_TRANSCRIPTION_CHANNELS {
            return Err(RecordingStoreError::new(
                "TRANSCRIPTION_AUDIO_SOURCE_LIMIT",
                "local transcription accepts at most eight aligned audio sources",
            ));
        }

        selected_channels
            .iter()
            .map(|selected_channel| self.render_pcm_track(&manifest, &dir, selected_channel))
            .collect()
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

    fn append_encrypted_raw_transcript_chunks(
        &self,
        recording_id: &str,
        manifest: &mut RecordingManifest,
        dir: &Path,
        raw_text: &str,
        created_at_ms: u128,
    ) -> Result<(Vec<u32>, Vec<PathBuf>), RecordingStoreError> {
        let key = os_key_store::get_or_create_key(&self.root)
            .map_err(|error| {
                let code = if error.code == "OS_KEY_STORAGE_UNAVAILABLE" {
                    "RAW_TRANSCRIPT_ENCRYPTION_UNAVAILABLE"
                } else {
                    error.code
                };
                RecordingStoreError::new(code, error.message)
            })?
            .derive_key(RECORDING_CHUNK_KEY_LABEL);
        let original_chunk_count = manifest.chunks.len();
        let mut indices = Vec::new();
        let mut paths = Vec::new();
        let result = (|| {
            for plaintext in raw_text.as_bytes().chunks(MAX_DURABLE_CHUNK_BYTES) {
                let index = u32::try_from(manifest.chunks.len()).map_err(|_| {
                    RecordingStoreError::new(
                        "TRANSCRIPT_RAW_CHUNK_LIMIT_REACHED",
                        "raw transcript storage exceeded the durable chunk index limit",
                    )
                })?;
                let payload = encrypt_chunk(&key, recording_id, index, plaintext)?;
                self.ensure_chunk_write_space(payload.len())?;
                let file_name = raw_transcript_file_name(index);
                let path = dir.join(&file_name);
                write_durable_chunk_file(&path, &payload)?;
                paths.push(path);
                indices.push(index);
                manifest.chunks.push(DurableChunk {
                    index,
                    kind: DurableChunkKind::RawTranscriptText,
                    file_name,
                    channel: "internal".to_string(),
                    bytes: plaintext.len() as u64,
                    stored_bytes: payload.len() as u64,
                    encrypted: true,
                    cipher: Some("chacha20poly1305".to_string()),
                    content_sha256: Some(hex_digest(&Sha256::digest(plaintext))),
                    speaker: None,
                    confidence: None,
                    sample_rate_hz: None,
                    channel_count: None,
                    bits_per_sample: None,
                    start_ms: None,
                    duration_ms: None,
                    transcription_attempt_id: None,
                    created_at_ms,
                });
            }
            Ok(())
        })();
        if let Err(error) = result {
            for path in &paths {
                let _ = fs::remove_file(path);
            }
            manifest.chunks.truncate(original_chunk_count);
            return Err(error);
        }
        Ok((indices, paths))
    }

    fn raw_transcript_preview(
        &self,
        manifest: &RecordingManifest,
        dir: &Path,
        revision: &TranscriptRevision,
    ) -> Result<Option<(String, bool)>, RecordingStoreError> {
        let Some(indices) = revision.raw_text_chunk_indices.as_ref() else {
            return Ok(None);
        };
        if indices.is_empty() {
            return Ok(Some((String::new(), false)));
        }
        let mut bytes = Vec::with_capacity(MAX_DURABLE_CHUNK_BYTES);
        for index in indices {
            let chunk = manifest.chunks.get(*index as usize).ok_or_else(|| {
                RecordingStoreError::new(
                    "TRANSCRIPT_RAW_CHUNKS_INVALID",
                    "raw transcript revision referenced a missing durable chunk",
                )
            })?;
            bytes.extend(self.read_chunk_bytes(manifest, chunk, dir)?);
            let valid_prefix = std::str::from_utf8(&bytes)
                .map(|_| bytes.len())
                .unwrap_or_else(|error| error.valid_up_to());
            if valid_prefix >= MAX_COMPARISON_TEXT_BYTES_PER_SIDE {
                bytes.truncate(valid_prefix);
                break;
            }
        }
        let valid_prefix = std::str::from_utf8(&bytes)
            .map(|_| bytes.len())
            .unwrap_or_else(|error| error.valid_up_to());
        bytes.truncate(valid_prefix);
        let text = String::from_utf8(bytes).map_err(|_| {
            RecordingStoreError::new(
                "TRANSCRIPT_RAW_TEXT_INVALID",
                "raw transcript content was not valid UTF-8",
            )
        })?;
        let (text, truncated_by_limit) = bounded_comparison_text(&text);
        let truncated =
            truncated_by_limit || revision.comparison.raw_text_bytes > text.len() as u64;
        Ok(Some((text, truncated)))
    }

    fn transcript_revision_segments_preview(
        &self,
        manifest: &RecordingManifest,
        dir: &Path,
        revision: &TranscriptRevision,
    ) -> Result<Vec<Value>, RecordingStoreError> {
        let mut segments = Vec::new();
        let mut serialized_bytes = 2_usize;
        for index in &revision.chunk_indices {
            if segments.len() >= MAX_REVISION_DETAIL_SEGMENTS {
                break;
            }
            let chunk = manifest.chunks.get(*index as usize).ok_or_else(|| {
                RecordingStoreError::new(
                    "TRANSCRIPT_REVISION_CHUNKS_INVALID",
                    "transcript revision referenced a missing segment chunk",
                )
            })?;
            let text =
                String::from_utf8(self.read_chunk_bytes(manifest, chunk, dir)?).map_err(|_| {
                    RecordingStoreError::new(
                        "TRANSCRIPT_SEGMENT_TEXT_INVALID",
                        "durable transcript segment was not valid UTF-8",
                    )
                })?;
            let start_ms = chunk.start_ms.unwrap_or_default();
            let duration_ms = chunk.duration_ms.unwrap_or_default();
            let segment = json!({
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
            });
            let segment_bytes = serde_json::to_vec(&segment)
                .map_err(|error| {
                    RecordingStoreError::new(
                        "TRANSCRIPT_REVISION_SERIALIZE_FAILED",
                        format!("failed to bound transcript revision segment: {error}"),
                    )
                })?
                .len()
                .saturating_add(1);
            if serialized_bytes.saturating_add(segment_bytes) > MAX_REVISION_DETAIL_SEGMENT_BYTES {
                break;
            }
            serialized_bytes = serialized_bytes.saturating_add(segment_bytes);
            segments.push(segment);
        }
        segments.sort_by_key(|segment| {
            (
                segment.get("startMs").and_then(Value::as_u64).unwrap_or(0),
                segment.get("index").and_then(Value::as_u64).unwrap_or(0),
            )
        });
        Ok(segments)
    }

    fn manifest_from_chunks(
        &self,
        recording_id: &str,
        dir: &Path,
    ) -> Result<RecordingManifest, RecordingStoreError> {
        let now = now_ms();
        Ok(RecordingManifest {
            schema_version: CURRENT_MANIFEST_SCHEMA_VERSION,
            recording_id: recording_id.to_string(),
            label: None,
            state: RecordingState::NeedsRecovery,
            created_at_ms: now,
            updated_at_ms: now,
            chunks: self.scan_chunks(recording_id, dir)?,
            privacy_events: Vec::new(),
            transcript_revisions: Vec::new(),
            current_transcript_revision_id: None,
            current_cleaned_revision_id: None,
            processing_receipts: Vec::new(),
            processing_profile: None,
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
            let raw_transcript = file_name.contains(RAW_TRANSCRIPT_FILE_MARKER);
            if raw_transcript && !encrypted {
                return Err(RecordingStoreError::new(
                    "TRANSCRIPT_RAW_ENCRYPTION_INVALID",
                    "raw transcript recovery found an unencrypted internal chunk",
                ));
            }
            let index = chunk_index_from_name(&file_name).ok_or_else(|| {
                RecordingStoreError::new(
                    "RECORDING_CHUNK_NAME_INVALID",
                    "recording chunk file name did not contain a valid index",
                )
            })?;
            let transcription_attempt_id = transcription_attempt_id_from_chunk_name(&file_name);
            if file_name.contains(TRANSCRIPTION_ATTEMPT_FILE_MARKER)
                && transcription_attempt_id.is_none()
            {
                return Err(RecordingStoreError::new(
                    "TRANSCRIPTION_ATTEMPT_ID_INVALID",
                    "transcription attempt chunk name was invalid",
                ));
            }
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
                kind: if raw_transcript {
                    DurableChunkKind::RawTranscriptText
                } else if transcription_attempt_id.is_some() {
                    DurableChunkKind::TranscriptSegment
                } else {
                    DurableChunkKind::TranscriptText
                },
                file_name,
                channel: "unknown".to_string(),
                bytes,
                stored_bytes,
                encrypted,
                cipher: encrypted.then(|| "chacha20poly1305".to_string()),
                content_sha256: None,
                speaker: None,
                confidence: None,
                sample_rate_hz: None,
                channel_count: None,
                bits_per_sample: None,
                start_ms: None,
                duration_ms: None,
                transcription_attempt_id,
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

    fn collect_search_manifests_bounded(
        &self,
        recording_limit: usize,
        chunk_descriptor_limit: usize,
        manifest_bytes_limit: u64,
    ) -> Result<(RecordingManifestCollection, bool), RecordingStoreError> {
        let recordings_root = self.recordings_root();
        fs::create_dir_all(&recordings_root).map_err(io_error("RECORDING_STORE_CREATE_FAILED"))?;
        let mut items = Vec::new();
        let mut quarantined = Vec::new();
        let mut considered = 0_usize;
        let mut retained_chunk_descriptors = 0_usize;
        let mut retained_manifest_bytes = 0_u64;
        let mut truncated = false;
        let mut entries = fs::read_dir(&recordings_root)
            .map_err(io_error("RECORDING_STORE_READ_FAILED"))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if !entry.path().is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if validate_id(&id).is_err() {
                continue;
            }
            if considered >= recording_limit {
                truncated = true;
                break;
            }
            considered = considered.saturating_add(1);
            match read_manifest(&entry.path()) {
                Ok(manifest) => {
                    let manifest_bytes = serde_json::to_vec(&manifest)
                        .map_err(|error| {
                            RecordingStoreError::new(
                                "RECORDING_MANIFEST_SERIALIZE_FAILED",
                                error.to_string(),
                            )
                        })?
                        .len() as u64;
                    if manifest.chunks.len()
                        > chunk_descriptor_limit.saturating_sub(retained_chunk_descriptors)
                        || manifest_bytes
                            > manifest_bytes_limit.saturating_sub(retained_manifest_bytes)
                    {
                        truncated = true;
                        continue;
                    }
                    retained_chunk_descriptors =
                        retained_chunk_descriptors.saturating_add(manifest.chunks.len());
                    retained_manifest_bytes =
                        retained_manifest_bytes.saturating_add(manifest_bytes);
                    items.push((manifest, entry.path()));
                }
                Err(error) => quarantined.push(self.quarantine_summary(&id, error.code)),
            }
        }
        Ok((
            RecordingManifestCollection { items, quarantined },
            truncated,
        ))
    }

    fn collect_search_manifests_read_only_bounded(
        &self,
        recording_limit: usize,
        chunk_descriptor_limit: usize,
        manifest_bytes_limit: u64,
    ) -> Result<(RecordingManifestCollection, bool, u64), RecordingStoreError> {
        let bounded = self.collect_recording_manifests_read_only_bounded(
            recording_limit,
            MAX_AUTOMATION_SEARCH_DIRECTORY_ENTRIES,
            chunk_descriptor_limit,
            manifest_bytes_limit,
            recording_limit.min(MAX_AUTOMATION_QUARANTINE_DETAILS),
        )?;
        let _bounded_scan_metrics = (
            bounded.inspected_directory_entries,
            bounded.manifest_bytes_read,
        );
        Ok((
            bounded.collection,
            bounded.source_truncated,
            bounded.quarantined_count,
        ))
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
        let _mutation_guard = self.manifest_mutation_guard();
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
        let committed_transcript_indices = committed_transcript_chunk_indices(manifest);
        for chunk in &manifest.chunks {
            if chunk.kind == DurableChunkKind::RawTranscriptText
                || is_uncommitted_attempt_chunk(chunk, &committed_transcript_indices)
            {
                continue;
            }
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
        self.transcript_segments_with_key_access(manifest, dir, true)
    }

    fn transcript_segments_with_key_access(
        &self,
        manifest: &RecordingManifest,
        dir: &Path,
        create_key_if_missing: bool,
    ) -> Result<Vec<Value>, RecordingStoreError> {
        let selected_indices = current_transcript_chunk_indices(manifest);
        self.transcript_segments_for_indices(
            manifest,
            dir,
            Some(&selected_indices),
            create_key_if_missing,
        )
    }

    fn transcript_segments_for_indices(
        &self,
        manifest: &RecordingManifest,
        dir: &Path,
        selected_indices: Option<&HashSet<u32>>,
        create_key_if_missing: bool,
    ) -> Result<Vec<Value>, RecordingStoreError> {
        let mut segments = Vec::new();
        for chunk in &manifest.chunks {
            if chunk.kind != DurableChunkKind::TranscriptSegment
                || selected_indices.is_some_and(|indices| !indices.contains(&chunk.index))
            {
                continue;
            }
            let bytes =
                self.read_chunk_bytes_with_key_access(manifest, chunk, dir, create_key_if_missing)?;
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
        self.read_chunk_bytes_with_key_access(manifest, chunk, dir, true)
    }

    fn read_chunk_bytes_with_key_access(
        &self,
        manifest: &RecordingManifest,
        chunk: &DurableChunk,
        dir: &Path,
        create_key_if_missing: bool,
    ) -> Result<Vec<u8>, RecordingStoreError> {
        let path = dir.join(&chunk.file_name);
        let (plaintext, stored_bytes) = if chunk.encrypted {
            let key = if create_key_if_missing {
                os_key_store::get_or_create_key(&self.root)
            } else {
                os_key_store::get_existing_key(&self.root)
            }
            .map_err(|err| RecordingStoreError::new(err.code, err.message))?
            .derive_key(RECORDING_CHUNK_KEY_LABEL);
            decrypt_chunk_bytes(&key, &manifest.recording_id, chunk.index, &path)?
        } else {
            let bytes = read_owned_regular_file_bounded(
                &path,
                MAX_DURABLE_CHUNK_BYTES as u64,
                "RECORDING_CHUNK_READ_FAILED",
                "RECORDING_CHUNK_TOO_LARGE",
                "durable chunk must be an owned regular file",
                "durable chunk exceeded its fixed byte limit",
            )?;
            let stored_bytes = bytes.len() as u64;
            (bytes, stored_bytes)
        };
        if (chunk.stored_bytes != 0 && chunk.stored_bytes != stored_bytes)
            || chunk.bytes != plaintext.len() as u64
        {
            return Err(RecordingStoreError::new(
                "RECORDING_CHUNK_SIZE_MISMATCH",
                "durable chunk bytes did not match committed metadata",
            ));
        }
        if let Some(expected) = chunk.content_sha256.as_deref() {
            let actual = hex_digest(&Sha256::digest(&plaintext));
            if !actual.eq_ignore_ascii_case(expected) {
                return Err(RecordingStoreError::new(
                    "RECORDING_CHUNK_INTEGRITY_FAILED",
                    "durable chunk content did not match its committed integrity hash",
                ));
            }
        }
        Ok(plaintext)
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

fn recording_page_value(
    collection: RecordingManifestCollection,
    offset: usize,
    limit: usize,
    root_kind: &'static str,
) -> Value {
    let mut recordings = collection
        .items
        .into_iter()
        .map(|(manifest, _dir)| recording_summary(&manifest, root_kind))
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
    json!({
        "rootKind": root_kind,
        "rawPathExposed": false,
        "offset": offset,
        "limit": limit,
        "totalCount": total_count,
        "hasMore": offset.saturating_add(page.len()) < total_count,
        "recordings": page,
        "quarantinedCount": collection.quarantined.len(),
        "quarantinedRecordings": collection.quarantined
    })
}

fn automation_recording_summary(manifest: &RecordingManifest, root_kind: &'static str) -> Value {
    let committed_transcript_indices = committed_transcript_chunk_indices(manifest);
    let mut storage_chunk_count = 0_usize;
    let mut accounted_chunk_count = 0_usize;
    let mut encrypted_at_rest = true;
    let mut transcript_segment_count = 0_usize;
    let mut audio_chunk_count = 0_usize;
    let mut notes_chunk_count = 0_usize;
    let mut audio_duration_ms = 0_u64;
    let mut stored_bytes = 0_u64;

    for chunk in &manifest.chunks {
        if is_uncommitted_attempt_chunk(chunk, &committed_transcript_indices) {
            continue;
        }
        storage_chunk_count = storage_chunk_count.saturating_add(1);
        encrypted_at_rest &= chunk.encrypted;
        stored_bytes = stored_bytes.saturating_add(if chunk.stored_bytes == 0 {
            chunk.bytes
        } else {
            chunk.stored_bytes
        });
        if chunk.kind == DurableChunkKind::RawTranscriptText {
            continue;
        }
        accounted_chunk_count = accounted_chunk_count.saturating_add(1);
        match chunk.kind {
            DurableChunkKind::TranscriptSegment => {
                transcript_segment_count = transcript_segment_count.saturating_add(1);
            }
            DurableChunkKind::AudioPcm16le => {
                audio_chunk_count = audio_chunk_count.saturating_add(1);
                audio_duration_ms = audio_duration_ms.max(
                    chunk
                        .start_ms
                        .unwrap_or_default()
                        .saturating_add(chunk.duration_ms.unwrap_or_default()),
                );
            }
            DurableChunkKind::NotesMarkdown => {
                notes_chunk_count = notes_chunk_count.saturating_add(1);
            }
            DurableChunkKind::TranscriptText | DurableChunkKind::RawTranscriptText => {}
        }
    }

    json!({
        "recordingId": manifest.recording_id.as_str(),
        "label": manifest.label.as_deref().map(|label| {
            truncate_utf8(label, MAX_AUTOMATION_LABEL_RESPONSE_BYTES)
        }),
        "state": recording_state_label(&manifest.state),
        "rootKind": root_kind,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false,
        "encryptedAtRest": storage_chunk_count > 0 && encrypted_at_rest,
        "chunkCount": accounted_chunk_count,
        "transcriptSegmentCount": transcript_segment_count,
        "audioChunkCount": audio_chunk_count,
        "notesChunkCount": notes_chunk_count,
        "audioDurationMs": audio_duration_ms,
        "storedBytes": stored_bytes,
        "createdAtMs": manifest.created_at_ms,
        "updatedAtMs": manifest.updated_at_ms
    })
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
        DurableChunkKind::RawTranscriptText => "rawTranscriptText",
        DurableChunkKind::AudioPcm16le => "audioPcm16le",
        DurableChunkKind::NotesMarkdown => "notesMarkdown",
    }
}

fn public_transcript_revision(revision: &TranscriptRevision) -> Value {
    let kind = effective_revision_kind(revision);
    json!({
        "revisionId": revision.revision_id,
        "version": revision.version,
        "source": revision.source,
        "kind": kind.label(),
        "parentRevisionId": revision.parent_revision_id,
        "engine": revision.engine,
        "modelId": revision.model_id,
        "modelSha256": revision.model_sha256,
        "comparison": revision.comparison,
        "rawComparisonAvailable": revision.raw_text_chunk_indices.is_some(),
        "createdAtMs": revision.created_at_ms
    })
}

fn effective_revision_kind(revision: &TranscriptRevision) -> TranscriptRevisionKind {
    if revision.kind != TranscriptRevisionKind::Legacy {
        return revision.kind;
    }
    match revision.source.as_str() {
        "review" => TranscriptRevisionKind::Normalized,
        "initial" | "reprocess" | "import" => TranscriptRevisionKind::RawAsr,
        _ => TranscriptRevisionKind::Legacy,
    }
}

fn committed_transcript_chunk_indices(manifest: &RecordingManifest) -> HashSet<u32> {
    manifest
        .transcript_revisions
        .iter()
        .flat_map(|revision| revision.chunk_indices.iter().copied())
        .collect()
}

fn current_transcript_chunk_indices(manifest: &RecordingManifest) -> HashSet<u32> {
    if let Some(revision) =
        manifest
            .current_transcript_revision_id
            .as_deref()
            .and_then(|revision_id| {
                manifest
                    .transcript_revisions
                    .iter()
                    .find(|revision| revision.revision_id == revision_id)
            })
    {
        return revision.chunk_indices.iter().copied().collect();
    }

    // Legacy/manual transcript segments were committed before attempt
    // membership existed. Core-owned attempt segments must remain invisible
    // until a successful immutable revision references them.
    manifest
        .chunks
        .iter()
        .filter(|chunk| {
            chunk.kind == DurableChunkKind::TranscriptSegment
                && chunk.transcription_attempt_id.is_none()
        })
        .map(|chunk| chunk.index)
        .collect()
}

fn is_uncommitted_attempt_chunk(
    chunk: &DurableChunk,
    committed_transcript_indices: &HashSet<u32>,
) -> bool {
    chunk.kind == DurableChunkKind::TranscriptSegment
        && chunk.transcription_attempt_id.is_some()
        && !committed_transcript_indices.contains(&chunk.index)
}

fn recording_summary(manifest: &RecordingManifest, root_kind: &'static str) -> Value {
    let committed_transcript_indices = committed_transcript_chunk_indices(manifest);
    let storage_chunks = manifest
        .chunks
        .iter()
        .filter(|chunk| !is_uncommitted_attempt_chunk(chunk, &committed_transcript_indices))
        .collect::<Vec<_>>();
    let accounted_chunks = storage_chunks
        .iter()
        .copied()
        .filter(|chunk| chunk.kind != DurableChunkKind::RawTranscriptText)
        .collect::<Vec<_>>();
    let total_bytes: u64 = storage_chunks.iter().map(|chunk| chunk.bytes).sum();
    let stored_bytes: u64 = storage_chunks
        .iter()
        .map(|chunk| {
            if chunk.stored_bytes == 0 {
                chunk.bytes
            } else {
                chunk.stored_bytes
            }
        })
        .sum();
    let encrypted_chunks = accounted_chunks
        .iter()
        .filter(|chunk| chunk.encrypted)
        .count();
    let encrypted_at_rest =
        !storage_chunks.is_empty() && storage_chunks.iter().all(|chunk| chunk.encrypted);
    let text_chunk_count = accounted_chunks
        .iter()
        .filter(|chunk| chunk.kind == DurableChunkKind::TranscriptText)
        .count();
    let transcript_segment_count = accounted_chunks
        .iter()
        .filter(|chunk| chunk.kind == DurableChunkKind::TranscriptSegment)
        .count();
    let audio_chunk_count = accounted_chunks
        .iter()
        .filter(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le)
        .count();
    let note_chunks = accounted_chunks
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
    let audio_duration_ms = accounted_chunks
        .iter()
        .filter(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le)
        .filter_map(|chunk| match (chunk.start_ms, chunk.duration_ms) {
            (Some(start_ms), Some(duration_ms)) => Some(start_ms.saturating_add(duration_ms)),
            _ => None,
        })
        .max()
        .unwrap_or_default();
    let processing_profile = manifest.processing_profile.as_ref().map(|profile| json!({
        "schemaVersion": profile.schema_version,
        "profileId": profile.profile_id,
        "profileVersion": profile.profile_version,
        "modelId": profile.model_id,
        "speechModelId": profile.speech_model_id,
        "cleanupModelId": profile.cleanup_model_id,
        "summaryModelId": profile.summary_model_id,
        "language": profile.language,
        "transcriptionLanguage": profile.transcription_language,
        "dictionaryIds": profile.dictionary_ids,
        "replacementRuleSetId": profile.replacement_rule_set.as_ref().map(|rule_set| rule_set.id.as_str()),
        "replacementRuleSetVersion": profile.replacement_rule_set.as_ref().map(|rule_set| rule_set.version),
        "recapTemplateBound": profile.recap_template.is_some(),
        "liveTranscription": profile.live_transcription,
        "immutableAtCaptureStart": true
    }));
    json!({
        "recordingId": manifest.recording_id.as_str(),
        "label": manifest.label.as_deref(),
        "state": recording_state_label(&manifest.state),
        "rootKind": root_kind,
        "rawPathExposed": false,
        "encryptedAtRest": encrypted_at_rest,
        "encryptedChunkCount": encrypted_chunks,
        "chunkCount": accounted_chunks.len(),
        "textChunkCount": text_chunk_count,
        "transcriptSegmentCount": transcript_segment_count,
        "transcriptRevisionCount": manifest.transcript_revisions.len(),
        "currentTranscriptRevisionId": manifest.current_transcript_revision_id.as_deref(),
        "processingReceiptCount": manifest.processing_receipts.len(),
        "processingProfile": processing_profile,
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
    let mut remaining_bytes = MAX_MANIFEST_BYTES.saturating_mul(3);
    read_manifest_with_budget(dir, &mut remaining_bytes)
}

fn read_manifest_with_budget(
    dir: &Path,
    remaining_bytes: &mut u64,
) -> Result<RecordingManifest, RecordingStoreError> {
    ensure_owned_directory(
        dir,
        "RECORDING_MANIFEST_READ_FAILED",
        "recording directory must be an owned directory",
    )?;
    let candidates = [
        dir.join(MANIFEST_FILE),
        dir.join("manifest.json.bak"),
        dir.join("manifest.json.tmp"),
    ];
    let mut last_error = None;
    for path in candidates {
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                last_error = Some(RecordingStoreError::new(
                    "RECORDING_MANIFEST_READ_FAILED",
                    error.to_string(),
                ));
                continue;
            }
        };
        if metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&metadata)
            || !metadata.is_file()
        {
            last_error = Some(RecordingStoreError::new(
                "RECORDING_MANIFEST_READ_FAILED",
                "recording manifest must be an owned regular file",
            ));
            continue;
        }
        if metadata.len() > MAX_MANIFEST_BYTES {
            last_error = Some(RecordingStoreError::new(
                "RECORDING_MANIFEST_TOO_LARGE",
                "recording manifest exceeded its local safety limit",
            ));
            continue;
        }
        if metadata.len() > *remaining_bytes {
            return Err(RecordingStoreError::new(
                "RECORDING_MANIFEST_BUDGET_EXCEEDED",
                "recording manifest scan exhausted its aggregate byte limit",
            ));
        }
        *remaining_bytes = remaining_bytes.saturating_sub(metadata.len());
        match read_owned_regular_file_bounded(
            &path,
            metadata.len(),
            "RECORDING_MANIFEST_READ_FAILED",
            "RECORDING_MANIFEST_TOO_LARGE",
            "recording manifest must be an owned regular file",
            "recording manifest exceeded its local safety limit",
        ) {
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
                last_error = Some(err);
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
    ensure_owned_directory(
        dir,
        "RECORDING_MANIFEST_READ_FAILED",
        "recording directory must be an owned directory",
    )?;
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

    if let Some(profile) = &manifest.processing_profile {
        profile
            .validate()
            .map_err(|error| RecordingStoreError::new(error.code, error.message))?;
    }

    if manifest.chunks.len() > MAX_REVISION_CHUNK_INDICES {
        return Err(RecordingStoreError::new(
            "RECORDING_MANIFEST_CHUNK_LIMIT_INVALID",
            "recording manifest exceeded the durable chunk descriptor safety limit",
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
        if chunk.bytes > MAX_DURABLE_CHUNK_BYTES as u64
            || chunk.stored_bytes
                > if chunk.encrypted {
                    MAX_ENCRYPTED_DURABLE_CHUNK_BYTES
                } else {
                    MAX_DURABLE_CHUNK_BYTES as u64
                }
        {
            return Err(RecordingStoreError::new(
                "RECORDING_MANIFEST_CHUNK_SIZE_INVALID",
                "recording manifest chunk metadata exceeded its fixed byte limit",
            ));
        }
        let file_attempt_id = transcription_attempt_id_from_chunk_name(&chunk.file_name);
        let file_is_raw_transcript = chunk.file_name.contains(RAW_TRANSCRIPT_FILE_MARKER);
        let chunk_is_raw_transcript = chunk.kind == DurableChunkKind::RawTranscriptText;
        if file_is_raw_transcript != chunk_is_raw_transcript
            || (chunk_is_raw_transcript
                && (!chunk.encrypted
                    || chunk.cipher.as_deref() != Some("chacha20poly1305")
                    || manifest.schema_version < 4))
        {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_RAW_CHUNK_INVALID",
                "raw transcript chunk metadata did not match its encrypted internal file",
            ));
        }
        if (chunk.file_name.contains(TRANSCRIPTION_ATTEMPT_FILE_MARKER)
            && file_attempt_id.is_none())
            || file_attempt_id.as_deref() != chunk.transcription_attempt_id.as_deref()
        {
            return Err(RecordingStoreError::new(
                "TRANSCRIPTION_ATTEMPT_CHUNK_INVALID",
                "transcription attempt membership did not match its durable chunk name",
            ));
        }
        let chunk_path = dir.join(file_name);
        let chunk_metadata = fs::symlink_metadata(&chunk_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                RecordingStoreError::new(
                    "RECORDING_MANIFEST_CHUNK_MISSING",
                    "recording manifest referenced a missing chunk",
                )
            } else {
                RecordingStoreError::new("RECORDING_MANIFEST_CHUNK_READ_FAILED", error.to_string())
            }
        })?;
        if chunk_metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&chunk_metadata)
            || !chunk_metadata.is_file()
        {
            return Err(RecordingStoreError::new(
                "RECORDING_MANIFEST_CHUNK_NOT_OWNED",
                "recording manifest referenced a chunk that was not an owned regular file",
            ));
        }
        let maximum_stored_bytes = if chunk.encrypted {
            MAX_ENCRYPTED_DURABLE_CHUNK_BYTES
        } else {
            MAX_DURABLE_CHUNK_BYTES as u64
        };
        if chunk_metadata.len() > maximum_stored_bytes {
            return Err(RecordingStoreError::new(
                "RECORDING_MANIFEST_CHUNK_SIZE_INVALID",
                "recording manifest chunk file exceeded its fixed byte limit",
            ));
        }
        if let Some(attempt_id) = chunk.transcription_attempt_id.as_deref() {
            validate_history_id(attempt_id, "TRANSCRIPTION_ATTEMPT_ID_INVALID")?;
            if chunk.kind != DurableChunkKind::TranscriptSegment {
                return Err(RecordingStoreError::new(
                    "TRANSCRIPTION_ATTEMPT_CHUNK_INVALID",
                    "only structured transcript segments can belong to a transcription attempt",
                ));
            }
        }
    }
    if manifest.transcript_revisions.len() > MAX_TRANSCRIPT_REVISIONS {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_REVISION_LIMIT_INVALID",
            "recording manifest exceeded the transcript revision safety limit",
        ));
    }
    let mut revision_ids = HashSet::new();
    let mut owned_raw_chunk_indices = HashSet::new();
    for (offset, revision) in manifest.transcript_revisions.iter().enumerate() {
        if revision.version != (offset as u32).saturating_add(1)
            || !revision_ids.insert(revision.revision_id.as_str())
        {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_REVISION_SEQUENCE_INVALID",
                "transcript revisions must have unique sequential identities",
            ));
        }
        validate_history_id(&revision.revision_id, "TRANSCRIPT_REVISION_ID_INVALID")?;
        if !matches!(
            revision.source.as_str(),
            "initial" | "reprocess" | "import" | "review" | "ai-cleanup"
        ) {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_REVISION_SOURCE_INVALID",
                "transcript revision source was not recognized",
            ));
        }
        if manifest.schema_version < 5 && revision.kind != TranscriptRevisionKind::Legacy {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_REVISION_KIND_SCHEMA_INVALID",
                "legacy manifest schema cannot contain typed transcript revisions",
            ));
        }
        let effective_kind = effective_revision_kind(revision);
        if (effective_kind == TranscriptRevisionKind::AiCleaned)
            != (revision.source == "ai-cleanup")
        {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_REVISION_KIND_INVALID",
                "AI-cleaned transcript kind and source were inconsistent",
            ));
        }
        if let Some(parent_revision_id) = revision.parent_revision_id.as_deref() {
            validate_history_id(parent_revision_id, "TRANSCRIPT_PARENT_REVISION_ID_INVALID")?;
            if parent_revision_id == revision.revision_id
                || !revision_ids.contains(parent_revision_id)
            {
                return Err(RecordingStoreError::new(
                    "TRANSCRIPT_PARENT_REVISION_INVALID",
                    "transcript parent must reference an earlier immutable revision",
                ));
            }
        } else if effective_kind == TranscriptRevisionKind::AiCleaned {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_PARENT_REVISION_INVALID",
                "AI-cleaned transcript omitted its immutable input revision",
            ));
        }
        validate_processing_identity(
            &revision.engine,
            revision.model_id.as_deref(),
            revision.model_sha256.as_deref(),
        )?;
        validate_transcript_comparison_metadata(&revision.comparison)?;
        validate_revision_chunk_indices(manifest, &revision.chunk_indices)?;
        validate_revision_attempt_membership(manifest, &revision.chunk_indices)?;
        if manifest.schema_version < 4 && revision.raw_text_chunk_indices.is_some() {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_RAW_SCHEMA_INVALID",
                "legacy manifest schema cannot reference raw transcript chunks",
            ));
        }
        if let Some(indices) = revision.raw_text_chunk_indices.as_deref() {
            validate_raw_revision_chunk_indices(
                manifest,
                indices,
                &revision.comparison,
                &mut owned_raw_chunk_indices,
            )?;
        }
    }
    if manifest.state != RecordingState::NeedsRecovery
        && manifest.chunks.iter().any(|chunk| {
            chunk.kind == DurableChunkKind::RawTranscriptText
                && !owned_raw_chunk_indices.contains(&chunk.index)
        })
    {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_RAW_CHUNK_ORPHANED",
            "recording manifest contained an unowned raw transcript chunk",
        ));
    }
    if manifest
        .current_transcript_revision_id
        .as_deref()
        .is_some_and(|revision_id| !revision_ids.contains(revision_id))
    {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_CURRENT_REVISION_INVALID",
            "current transcript revision did not reference immutable history",
        ));
    }
    if manifest
        .current_transcript_revision_id
        .as_deref()
        .is_some_and(|revision_id| {
            manifest
                .transcript_revisions
                .iter()
                .find(|revision| revision.revision_id == revision_id)
                .is_some_and(|revision| {
                    effective_revision_kind(revision) == TranscriptRevisionKind::AiCleaned
                })
        })
    {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_CURRENT_REVISION_KIND_INVALID",
            "AI-cleaned text cannot be the selected evidentiary transcript",
        ));
    }
    if let Some(cleaned_revision_id) = manifest.current_cleaned_revision_id.as_deref() {
        let cleaned = manifest
            .transcript_revisions
            .iter()
            .find(|revision| revision.revision_id == cleaned_revision_id)
            .ok_or_else(|| {
                RecordingStoreError::new(
                    "TRANSCRIPT_CURRENT_CLEANED_REVISION_INVALID",
                    "selected cleaned transcript did not reference immutable history",
                )
            })?;
        if effective_revision_kind(cleaned) != TranscriptRevisionKind::AiCleaned {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_CURRENT_CLEANED_REVISION_INVALID",
                "selected cleaned transcript did not reference AI-cleaned text",
            ));
        }
    }
    if manifest.processing_receipts.len() > MAX_PROCESSING_RECEIPTS {
        return Err(RecordingStoreError::new(
            "PROCESSING_RECEIPT_LIMIT_INVALID",
            "recording manifest exceeded the processing receipt safety limit",
        ));
    }
    let mut receipt_ids = HashSet::new();
    for (offset, receipt) in manifest.processing_receipts.iter().enumerate() {
        if receipt.attempt != (offset as u32).saturating_add(1)
            || !receipt_ids.insert(receipt.receipt_id.as_str())
        {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_SEQUENCE_INVALID",
                "processing receipts must have unique sequential identities",
            ));
        }
        validate_history_id(&receipt.receipt_id, "PROCESSING_RECEIPT_ID_INVALID")?;
        if !matches!(
            receipt.operation.as_str(),
            "transcription" | "protected-term-review" | "transcript-cleanup" | "local-ai-recap"
        ) {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_OPERATION_INVALID",
                "processing receipt operation was not recognized",
            ));
        }
        if let Some(stage) = receipt.stage.as_deref() {
            if !matches!(
                stage,
                "transcription" | "normalization" | "cleanup" | "recap"
            ) {
                return Err(RecordingStoreError::new(
                    "PROCESSING_RECEIPT_STAGE_INVALID",
                    "processing receipt stage was not recognized",
                ));
            }
        }
        if let Some(input_revision_id) = receipt.input_revision_id.as_deref() {
            validate_history_id(
                input_revision_id,
                "PROCESSING_RECEIPT_INPUT_REVISION_INVALID",
            )?;
            let input_revision = manifest
                .transcript_revisions
                .iter()
                .find(|revision| revision.revision_id == input_revision_id)
                .ok_or_else(|| {
                    RecordingStoreError::new(
                        "PROCESSING_RECEIPT_INPUT_REVISION_INVALID",
                        "processing receipt input revision was not found",
                    )
                })?;
            if receipt.input_revision_kind.as_deref()
                != Some(effective_revision_kind(input_revision).label())
            {
                return Err(RecordingStoreError::new(
                    "PROCESSING_RECEIPT_INPUT_KIND_INVALID",
                    "processing receipt input revision kind did not match immutable history",
                ));
            }
        } else if receipt.input_revision_kind.is_some() {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_INPUT_KIND_INVALID",
                "processing receipt input kind omitted its revision identity",
            ));
        }
        if receipt
            .prompt_template_sha256
            .as_deref()
            .is_some_and(|hash| !is_sha256_hex(hash))
        {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_PROMPT_HASH_INVALID",
                "processing receipt prompt template fingerprint was invalid",
            ));
        }
        if receipt
            .validation_result
            .as_deref()
            .is_some_and(|result| !matches!(result, "passed" | "failed" | "not-applicable"))
        {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_VALIDATION_INVALID",
                "processing receipt validation result was not recognized",
            ));
        }
        validate_processing_identity(
            &receipt.engine,
            receipt.model_id.as_deref(),
            receipt.model_sha256.as_deref(),
        )?;
        if receipt.finished_at_ms < receipt.started_at_ms {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_TIMING_INVALID",
                "processing receipt timing was invalid",
            ));
        }
        match receipt.outcome {
            ProcessingOutcome::Succeeded => {
                let recap_receipt = receipt.operation == "local-ai-recap";
                let transcript_revision_valid = receipt
                    .revision_id
                    .as_deref()
                    .is_some_and(|revision_id| revision_ids.contains(revision_id));
                let recap_lineage_valid = receipt.revision_id.is_none()
                    && receipt.comparison.is_none()
                    && receipt.input_revision_id.is_some()
                    && receipt.prompt_template_sha256.is_some();
                if (recap_receipt && !recap_lineage_valid)
                    || (!recap_receipt
                        && (!transcript_revision_valid || receipt.comparison.is_none()))
                    || receipt.error_code.is_some()
                    || receipt.error_summary.is_some()
                {
                    return Err(RecordingStoreError::new(
                        "PROCESSING_RECEIPT_OUTCOME_INVALID",
                        "successful processing receipt metadata was inconsistent",
                    ));
                }
            }
            ProcessingOutcome::Failed | ProcessingOutcome::Cancelled => {
                if receipt.revision_id.is_some()
                    || receipt.error_code.is_none()
                    || receipt.comparison.is_some()
                {
                    return Err(RecordingStoreError::new(
                        "PROCESSING_RECEIPT_OUTCOME_INVALID",
                        "failed processing receipt metadata was inconsistent",
                    ));
                }
                validate_stable_code(
                    receipt.error_code.as_deref().unwrap_or_default(),
                    "PROCESSING_RECEIPT_ERROR_CODE_INVALID",
                )?;
            }
        }
        if let Some(comparison) = receipt.comparison.as_ref() {
            validate_transcript_comparison_metadata(comparison)?;
        }
        if receipt
            .error_summary
            .as_deref()
            .is_some_and(|summary| summary.is_empty() || summary.len() > 500)
        {
            return Err(RecordingStoreError::new(
                "PROCESSING_RECEIPT_ERROR_SUMMARY_INVALID",
                "processing receipt error summary was invalid",
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

#[cfg(feature = "sqlcipher-vault")]
fn remove_owned_trust_search_files(paths: &[PathBuf]) -> Result<(), RecordingStoreError> {
    for path in paths {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(RecordingStoreError::new(
                    "TRUST_SEARCH_SYNC_FAILED",
                    error.to_string(),
                ));
            }
        };
        if metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&metadata)
            || !metadata.is_file()
        {
            return Err(RecordingStoreError::new(
                "TRUST_SEARCH_SYNC_FAILED",
                "temporary encrypted search index contained an unowned file",
            ));
        }
        fs::remove_file(path).map_err(io_error("TRUST_SEARCH_SYNC_FAILED"))?;
    }
    Ok(())
}

fn legacy_transcript_bytes_with_limit(
    manifest: &RecordingManifest,
    selected_indices: &HashSet<u32>,
    maximum_bytes: u64,
) -> Result<u64, RecordingStoreError> {
    let mut segment_count = 0_u64;
    let mut total_bytes = 0_u64;
    for chunk in manifest.chunks.iter().filter(|chunk| {
        chunk.kind == DurableChunkKind::TranscriptSegment && selected_indices.contains(&chunk.index)
    }) {
        if segment_count > 0 {
            total_bytes = total_bytes.saturating_add(1);
        }
        total_bytes = total_bytes.saturating_add(chunk.bytes);
        segment_count = segment_count.saturating_add(1);
        if total_bytes > maximum_bytes {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_LEGACY_MIGRATION_TOO_LARGE",
                "legacy transcript exceeded the bounded immutable-history migration limit",
            ));
        }
    }
    Ok(total_bytes)
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
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(RecordingStoreError::new(
            "RECORDING_MANIFEST_TOO_LARGE",
            "recording manifest exceeded its local safety limit",
        ));
    }
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
    Ok(decrypt_chunk_bytes(key, recording_id, index, path)?.0.len() as u64)
}

fn decrypt_chunk_bytes(
    key: &[u8; 32],
    recording_id: &str,
    index: u32,
    path: &Path,
) -> Result<(Vec<u8>, u64), RecordingStoreError> {
    let envelope = read_owned_regular_file_bounded(
        path,
        MAX_ENCRYPTED_DURABLE_CHUNK_BYTES,
        "RECORDING_CHUNK_READ_FAILED",
        "RECORDING_CHUNK_TOO_LARGE",
        "encrypted durable chunk must be an owned regular file",
        "encrypted durable chunk exceeded its fixed byte limit",
    )?;
    let stored_bytes = envelope.len() as u64;
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
    Ok((plaintext, stored_bytes))
}

fn chunk_aad(recording_id: &str, index: u32) -> String {
    format!("candor-v3-recording-chunk:{recording_id}:{index}")
}

fn transcript_segment_file_name(index: u32, encrypted: bool, attempt_id: Option<&str>) -> String {
    let extension = if encrypted {
        ENCRYPTED_CHUNK_EXT
    } else {
        PLAINTEXT_CHUNK_EXT
    };
    match attempt_id {
        Some(attempt_id) => {
            format!("chunk-{index:06}{TRANSCRIPTION_ATTEMPT_FILE_MARKER}{attempt_id}{extension}")
        }
        None => format!("chunk-{index:06}{extension}"),
    }
}

fn raw_transcript_file_name(index: u32) -> String {
    format!("chunk-{index:06}{RAW_TRANSCRIPT_FILE_MARKER}{ENCRYPTED_CHUNK_EXT}")
}

fn chunk_file_stem(file_name: &str) -> Option<&str> {
    file_name
        .strip_suffix(PLAINTEXT_CHUNK_EXT)
        .or_else(|| file_name.strip_suffix(ENCRYPTED_CHUNK_EXT))
}

fn chunk_index_from_name(file_name: &str) -> Option<u32> {
    let stem = chunk_file_stem(file_name)?.strip_prefix("chunk-")?;
    stem.split_once(TRANSCRIPTION_ATTEMPT_FILE_MARKER)
        .map(|(index, _attempt_id)| index)
        .or_else(|| {
            stem.split_once(RAW_TRANSCRIPT_FILE_MARKER)
                .map(|(index, _)| index)
        })
        .unwrap_or(stem)
        .parse::<u32>()
        .ok()
}

fn transcription_attempt_id_from_chunk_name(file_name: &str) -> Option<String> {
    let stem = chunk_file_stem(file_name)?;
    let (_prefix, attempt_id) = stem.split_once(TRANSCRIPTION_ATTEMPT_FILE_MARKER)?;
    validate_history_id(attempt_id, "TRANSCRIPTION_ATTEMPT_ID_INVALID")
        .ok()
        .map(|()| attempt_id.to_string())
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

fn validate_history_id(value: &str, code: &'static str) -> Result<(), RecordingStoreError> {
    let valid = !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err(RecordingStoreError::new(
            code,
            "history identifier must be bounded ASCII alphanumeric, dash, or underscore",
        ))
    }
}

fn validate_stable_code(value: &str, code: &'static str) -> Result<(), RecordingStoreError> {
    let valid = !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err(RecordingStoreError::new(
            code,
            "processing error code must be bounded uppercase ASCII",
        ))
    }
}

fn validate_processing_identity(
    engine: &str,
    model_id: Option<&str>,
    model_sha256: Option<&str>,
) -> Result<(), RecordingStoreError> {
    if engine.is_empty()
        || engine.len() > 80
        || !engine
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(RecordingStoreError::new(
            "PROCESSING_ENGINE_INVALID",
            "processing engine identifier was invalid",
        ));
    }
    if model_id.is_some_and(|value| {
        value.is_empty()
            || value.len() > 200
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    }) {
        return Err(RecordingStoreError::new(
            "PROCESSING_MODEL_ID_INVALID",
            "processing model identifier was invalid",
        ));
    }
    if model_sha256.is_some_and(|value| !is_sha256_hex(value)) {
        return Err(RecordingStoreError::new(
            "PROCESSING_MODEL_HASH_INVALID",
            "processing model hash was invalid",
        ));
    }
    Ok(())
}

fn validate_revision_chunk_indices(
    manifest: &RecordingManifest,
    chunk_indices: &[u32],
) -> Result<(), RecordingStoreError> {
    if chunk_indices.len() > MAX_REVISION_CHUNK_INDICES {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_REVISION_TOO_LARGE",
            "transcript revision contains too many segment references",
        ));
    }
    let mut previous = None;
    for index in chunk_indices {
        if previous.is_some_and(|prior| prior >= *index) {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_REVISION_CHUNKS_INVALID",
                "transcript revision chunk references must be unique and increasing",
            ));
        }
        let valid = manifest.chunks.get(*index as usize).is_some_and(|chunk| {
            chunk.index == *index && chunk.kind == DurableChunkKind::TranscriptSegment
        });
        if !valid {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_REVISION_CHUNKS_INVALID",
                "transcript revision referenced a non-transcript chunk",
            ));
        }
        previous = Some(*index);
    }
    Ok(())
}

fn validate_revision_attempt_membership(
    manifest: &RecordingManifest,
    chunk_indices: &[u32],
) -> Result<(), RecordingStoreError> {
    let mut membership: Option<Option<&str>> = None;
    for index in chunk_indices {
        let attempt_id = manifest
            .chunks
            .iter()
            .find(|chunk| chunk.index == *index)
            .and_then(|chunk| chunk.transcription_attempt_id.as_deref());
        match membership {
            Some(existing) if existing != attempt_id => {
                return Err(RecordingStoreError::new(
                    "TRANSCRIPT_REVISION_ATTEMPT_INVALID",
                    "a transcript revision cannot combine chunks from different attempts",
                ));
            }
            None => membership = Some(attempt_id),
            Some(_) => {}
        }
    }
    Ok(())
}

fn validate_raw_revision_chunk_indices(
    manifest: &RecordingManifest,
    chunk_indices: &[u32],
    comparison: &TranscriptComparisonMetadata,
    owned_indices: &mut HashSet<u32>,
) -> Result<(), RecordingStoreError> {
    if chunk_indices.len() > MAX_REVISION_CHUNK_INDICES {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_RAW_CHUNKS_INVALID",
            "raw transcript revision contains too many durable chunk references",
        ));
    }
    let mut previous = None;
    let mut total_bytes = 0_u64;
    for index in chunk_indices {
        if previous.is_some_and(|prior| prior >= *index) || !owned_indices.insert(*index) {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_RAW_CHUNKS_INVALID",
                "raw transcript chunk references must be unique, increasing, and owned by one revision",
            ));
        }
        let chunk = manifest.chunks.get(*index as usize).ok_or_else(|| {
            RecordingStoreError::new(
                "TRANSCRIPT_RAW_CHUNKS_INVALID",
                "raw transcript revision referenced a missing durable chunk",
            )
        })?;
        if chunk.index != *index
            || chunk.kind != DurableChunkKind::RawTranscriptText
            || !chunk.encrypted
            || chunk
                .content_sha256
                .as_deref()
                .is_none_or(|hash| !is_sha256_hex(hash))
        {
            return Err(RecordingStoreError::new(
                "TRANSCRIPT_RAW_CHUNKS_INVALID",
                "raw transcript revision referenced an invalid encrypted chunk",
            ));
        }
        total_bytes = total_bytes.checked_add(chunk.bytes).ok_or_else(|| {
            RecordingStoreError::new(
                "TRANSCRIPT_RAW_TOO_LARGE",
                "raw transcript byte count overflowed its local safety limit",
            )
        })?;
        previous = Some(*index);
    }
    if total_bytes != comparison.raw_text_bytes || total_bytes > MAX_RAW_TRANSCRIPT_BYTES as u64 {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_RAW_CHUNKS_INVALID",
            "raw transcript chunk bytes did not match immutable comparison metadata",
        ));
    }
    Ok(())
}

fn validate_transcript_comparison(
    comparison: &TranscriptComparisonDraft,
) -> Result<(), RecordingStoreError> {
    let metadata = TranscriptComparisonMetadata {
        raw_text_sha256: comparison.raw_text_sha256.clone(),
        normalized_text_sha256: comparison.normalized_text_sha256.clone(),
        raw_text_bytes: comparison.raw_text_bytes,
        normalized_text_bytes: comparison.normalized_text_bytes,
        raw_segment_count: comparison.raw_segment_count,
        normalized_segment_count: comparison.normalized_segment_count,
        changed: comparison.changed,
    };
    validate_transcript_comparison_metadata(&metadata)
}

fn validate_raw_transcript_text(
    raw_text: &str,
    comparison: &TranscriptComparisonDraft,
) -> Result<(), RecordingStoreError> {
    validate_transcript_content(
        raw_text.as_bytes(),
        comparison.raw_text_bytes,
        &comparison.raw_text_sha256,
        "raw",
    )
}

fn validate_normalized_transcript_text(
    normalized_text: &str,
    comparison: &TranscriptComparisonDraft,
) -> Result<(), RecordingStoreError> {
    validate_transcript_content(
        normalized_text.as_bytes(),
        comparison.normalized_text_bytes,
        &comparison.normalized_text_sha256,
        "normalized",
    )
}

fn validate_transcript_content(
    text: &[u8],
    expected_bytes: u64,
    expected_sha256: &str,
    representation: &'static str,
) -> Result<(), RecordingStoreError> {
    if text.len() > MAX_RAW_TRANSCRIPT_BYTES {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_RAW_TOO_LARGE",
            "transcript comparison content exceeded its local storage safety limit",
        ));
    }
    let actual_bytes = u64::try_from(text.len()).unwrap_or(u64::MAX);
    let actual_sha256 = hex_digest(&Sha256::digest(text));
    if actual_bytes != expected_bytes || !actual_sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_COMPARISON_CONTENT_INVALID",
            format!("{representation} transcript content did not match its immutable comparison metadata"),
        ));
    }
    Ok(())
}

fn transcript_text_from_segments(segments: &[Value]) -> String {
    segments
        .iter()
        .filter_map(|segment| segment.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn cleanup_segment_metadata_matches(source: &Value, cleaned: &Value) -> bool {
    ["channel", "speaker", "startMs", "durationMs", "endMs"]
        .iter()
        .all(|field| source.get(*field) == cleaned.get(*field))
}

fn bounded_comparison_text(text: &str) -> (String, bool) {
    if text.len() <= MAX_COMPARISON_TEXT_BYTES_PER_SIDE {
        return (text.to_string(), false);
    }
    let mut end = MAX_COMPARISON_TEXT_BYTES_PER_SIDE;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

fn validate_transcript_comparison_metadata(
    comparison: &TranscriptComparisonMetadata,
) -> Result<(), RecordingStoreError> {
    if !is_sha256_hex(&comparison.raw_text_sha256)
        || !is_sha256_hex(&comparison.normalized_text_sha256)
    {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_COMPARISON_HASH_INVALID",
            "transcript comparison hashes were invalid",
        ));
    }
    let hashes_differ = !comparison
        .raw_text_sha256
        .eq_ignore_ascii_case(&comparison.normalized_text_sha256);
    let metadata_differs = comparison.raw_text_bytes != comparison.normalized_text_bytes
        || comparison.raw_segment_count != comparison.normalized_segment_count;
    if comparison.changed != (hashes_differ || metadata_differs) {
        return Err(RecordingStoreError::new(
            "TRANSCRIPT_COMPARISON_STATE_INVALID",
            "transcript comparison change state was inconsistent",
        ));
    }
    Ok(())
}

fn comparison_metadata(draft: TranscriptComparisonDraft) -> TranscriptComparisonMetadata {
    TranscriptComparisonMetadata {
        raw_text_sha256: draft.raw_text_sha256.to_ascii_lowercase(),
        normalized_text_sha256: draft.normalized_text_sha256.to_ascii_lowercase(),
        raw_text_bytes: draft.raw_text_bytes,
        normalized_text_bytes: draft.normalized_text_bytes,
        raw_segment_count: draft.raw_segment_count,
        normalized_segment_count: draft.normalized_segment_count,
        changed: draft.changed,
    }
}

pub(crate) fn transcript_text_sha256(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    hex_digest(&digest)
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn source_audio_manifest_digest(channel: &str, chunks: &[&DurableChunk]) -> Option<String> {
    if chunks.is_empty()
        || chunks.iter().any(|chunk| {
            chunk
                .content_sha256
                .as_deref()
                .is_none_or(|hash| !is_sha256_hex(hash))
        })
    {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(b"candor-original-audio-manifest-v2");
    hasher.update((channel.len() as u64).to_le_bytes());
    hasher.update(channel.as_bytes());
    for chunk in chunks {
        hasher.update((chunk.channel.len() as u64).to_le_bytes());
        hasher.update(chunk.channel.as_bytes());
        hasher.update(chunk.index.to_le_bytes());
        hasher.update(chunk.start_ms.unwrap_or_default().to_le_bytes());
        hasher.update(chunk.duration_ms.unwrap_or_default().to_le_bytes());
        hasher.update(chunk.bytes.to_le_bytes());
        hasher.update(chunk.sample_rate_hz.unwrap_or_default().to_le_bytes());
        hasher.update(chunk.channel_count.unwrap_or_default().to_le_bytes());
        hasher.update(chunk.bits_per_sample.unwrap_or_default().to_le_bytes());
        hasher.update(
            chunk
                .content_sha256
                .as_deref()
                .expect("content hash presence checked above")
                .as_bytes(),
        );
    }
    Some(hex_digest(&hasher.finalize()))
}

fn transcription_source_channels(
    manifest: &RecordingManifest,
    requested_channel: Option<&str>,
) -> Vec<String> {
    if let Some(channel) =
        requested_channel.filter(|channel| *channel != COMBINED_TRANSCRIPTION_CHANNEL)
    {
        let channel_exists = manifest
            .chunks
            .iter()
            .any(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le && chunk.channel == channel);
        return if channel_exists {
            vec![channel.to_string()]
        } else {
            Vec::new()
        };
    }

    let mut seen = HashSet::new();
    let mut channels = manifest
        .chunks
        .iter()
        .filter(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le)
        .filter(|chunk| seen.insert(chunk.channel.clone()))
        .map(|chunk| chunk.channel.clone())
        .collect::<Vec<_>>();
    channels.sort_by(|left, right| {
        transcription_channel_rank(left)
            .cmp(&transcription_channel_rank(right))
            .then_with(|| left.cmp(right))
    });
    channels
}

fn transcription_channel_rank(channel: &str) -> u8 {
    match channel {
        "mic" => 0,
        "system" => 1,
        _ => 2,
    }
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

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn read_only_quarantine_summary(recording_id: &str, reason_code: &'static str) -> Value {
    json!({
        "recordingId": recording_id,
        "reasonCode": reason_code,
        "receiptPersisted": false,
        "contentModified": false,
        "rawPathExposed": false
    })
}

fn read_only_list_sort_time_ns(directory: &Path, directory_metadata: &fs::Metadata) -> u128 {
    for file_name in [MANIFEST_FILE, "manifest.json.bak", "manifest.json.tmp"] {
        if let Ok(metadata) = fs::symlink_metadata(directory.join(file_name)) {
            return metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
        }
    }
    directory_metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn bounded_automation_response(
    response: Value,
    maximum_bytes: usize,
    error_code: &'static str,
) -> Result<Value, RecordingStoreError> {
    let serialized_bytes = serde_json::to_vec(&response).map_err(|_| {
        RecordingStoreError::new(
            error_code,
            "read-only automation response could not be serialized safely",
        )
    })?;
    if serialized_bytes.len() > maximum_bytes {
        return Err(RecordingStoreError::new(
            error_code,
            "read-only automation response exceeded its fixed byte limit",
        ));
    }
    Ok(response)
}

fn validated_search_query(query: &str) -> Result<&str, RecordingStoreError> {
    let trimmed = query.trim();
    if trimmed.is_empty() || trimmed.len() > 200 {
        return Err(RecordingStoreError::new(
            "RECORDING_SEARCH_QUERY_INVALID",
            "search query must be between 1 and 200 bytes after trimming",
        ));
    }
    let _ = fts_literal_query(trimmed)?;
    Ok(trimmed)
}

fn fts_literal_query(query: &str) -> Result<String, RecordingStoreError> {
    let trimmed = query.trim();
    if trimmed.is_empty()
        || trimmed.len() > 200
        || trimmed.chars().any(|character| {
            character == '\0' || (character.is_control() && !character.is_whitespace())
        })
    {
        return Err(RecordingStoreError::new(
            "RECORDING_SEARCH_QUERY_INVALID",
            "search query contained unsupported control characters",
        ));
    }
    let mut literal = String::with_capacity(trimmed.len().saturating_add(2));
    literal.push('"');
    for character in trimmed.chars() {
        if character == '"' {
            literal.push('"');
        }
        literal.push(character);
    }
    literal.push('"');
    Ok(literal)
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

fn ensure_owned_directory(
    path: &Path,
    error_code: &'static str,
    invalid_message: &'static str,
) -> Result<(), RecordingStoreError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| RecordingStoreError::new(error_code, error.to_string()))?;
    if metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
        || !metadata.is_dir()
    {
        return Err(RecordingStoreError::new(error_code, invalid_message));
    }
    Ok(())
}

fn read_owned_regular_file_bounded(
    path: &Path,
    maximum_bytes: u64,
    read_error_code: &'static str,
    too_large_error_code: &'static str,
    invalid_message: &'static str,
    too_large_message: &'static str,
) -> Result<Vec<u8>, RecordingStoreError> {
    let path_metadata = fs::symlink_metadata(path)
        .map_err(|error| RecordingStoreError::new(read_error_code, error.to_string()))?;
    if path_metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&path_metadata)
        || !path_metadata.is_file()
    {
        return Err(RecordingStoreError::new(read_error_code, invalid_message));
    }
    if path_metadata.len() > maximum_bytes {
        return Err(RecordingStoreError::new(
            too_large_error_code,
            too_large_message,
        ));
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.custom_flags(0x0020_0000);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    options.custom_flags(0x0002_0000);
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    ))]
    options.custom_flags(0x0000_0100);
    let mut file = options
        .open(path)
        .map_err(|error| RecordingStoreError::new(read_error_code, error.to_string()))?;
    let opened_metadata = file
        .metadata()
        .map_err(|error| RecordingStoreError::new(read_error_code, error.to_string()))?;
    if metadata_is_reparse_point(&opened_metadata) || !opened_metadata.is_file() {
        return Err(RecordingStoreError::new(read_error_code, invalid_message));
    }
    if opened_metadata.len() > maximum_bytes {
        return Err(RecordingStoreError::new(
            too_large_error_code,
            too_large_message,
        ));
    }
    let expected_len = opened_metadata.len();
    let capacity = usize::try_from(expected_len)
        .map_err(|_| RecordingStoreError::new(too_large_error_code, too_large_message))?;
    let mut bytes = Vec::with_capacity(capacity);
    Read::by_ref(&mut file)
        .take(expected_len)
        .read_to_end(&mut bytes)
        .map_err(|error| RecordingStoreError::new(read_error_code, error.to_string()))?;
    let final_metadata = file
        .metadata()
        .map_err(|error| RecordingStoreError::new(read_error_code, error.to_string()))?;
    if bytes.len() as u64 != expected_len
        || final_metadata.len() != expected_len
        || metadata_is_reparse_point(&final_metadata)
        || !final_metadata.is_file()
    {
        return Err(RecordingStoreError::new(
            read_error_code,
            "owned file changed while it was being read",
        ));
    }
    Ok(bytes)
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(all(feature = "sqlcipher-vault", windows))]
fn windows_transient_search_remove_error(error: &std::io::Error) -> bool {
    // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION, and
    // ERROR_DIR_NOT_EMPTY. The last value occurs when a background SQLite
    // builder creates a sidecar between remove_dir_all enumeration and final
    // directory removal.
    matches!(error.raw_os_error(), Some(32 | 33 | 145))
}

#[cfg(all(feature = "sqlcipher-vault", not(windows)))]
fn windows_transient_search_remove_error(_error: &std::io::Error) -> bool {
    false
}

#[cfg(feature = "sqlcipher-vault")]
fn lower_trust_search_backfill_priority() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
        };
        // FTS backfill can decrypt substantial local history. Keep it below
        // capture and foreground work; priority adjustment failure is non-fatal.
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
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

    fn comparison(raw: &str, normalized: &str, segment_count: u64) -> TranscriptComparisonDraft {
        TranscriptComparisonDraft {
            raw_text_sha256: transcript_text_sha256(raw),
            normalized_text_sha256: transcript_text_sha256(normalized),
            raw_text_bytes: raw.len() as u64,
            normalized_text_bytes: normalized.len() as u64,
            raw_segment_count: segment_count,
            normalized_segment_count: segment_count,
            changed: raw != normalized,
        }
    }

    fn write_segment(store: &RecordingStore, recording_id: &str, text: &str) -> u32 {
        store
            .write_transcript_segment(WriteTranscriptSegmentParams {
                recording_id: recording_id.to_string(),
                channel: "mic".to_string(),
                speaker: Some("Me".to_string()),
                text: text.to_string(),
                start_ms: 0,
                duration_ms: Some(500),
                end_ms: None,
                confidence: Some(0.9),
            })
            .expect("write transcript segment");
        *store
            .transcript_chunk_indices(recording_id)
            .expect("transcript indices")
            .last()
            .expect("new transcript index")
    }

    fn write_attempt_segment(
        store: &RecordingStore,
        recording_id: &str,
        attempt_id: &str,
        text: &str,
    ) {
        store
            .write_transcription_attempt_segment(
                attempt_id,
                WriteTranscriptSegmentParams {
                    recording_id: recording_id.to_string(),
                    channel: "mic".to_string(),
                    speaker: Some("Me".to_string()),
                    text: text.to_string(),
                    start_ms: 0,
                    duration_ms: Some(500),
                    end_ms: None,
                    confidence: Some(0.9),
                },
            )
            .expect("write attempt transcript segment");
    }

    fn write_orphan_raw_transcript_file(
        store: &RecordingStore,
        recording_id: &str,
        text: &str,
    ) -> PathBuf {
        let dir = store.recording_dir(recording_id).expect("recording dir");
        let manifest = read_manifest(&dir).expect("manifest");
        let index = manifest.chunks.len() as u32;
        let key = os_key_store::get_or_create_key(&store.root)
            .expect("test storage key")
            .derive_key(RECORDING_CHUNK_KEY_LABEL);
        let payload = encrypt_chunk(&key, recording_id, index, text.as_bytes())
            .expect("encrypt orphan raw transcript");
        let path = dir.join(raw_transcript_file_name(index));
        write_durable_chunk_file(&path, &payload).expect("write orphan raw transcript");
        path
    }

    fn complete_attempt(
        store: &RecordingStore,
        recording_id: &str,
        attempt_id: &str,
        text: &str,
    ) -> Result<Value, RecordingStoreError> {
        store.complete_transcription_attempt(TranscriptionSuccessDraft {
            recording_id: recording_id.to_string(),
            attempt_id: Some(attempt_id.to_string()),
            chunk_indices: Vec::new(),
            engine: "whisper-rs".to_string(),
            model_id: Some("ggml-base.en.bin".to_string()),
            model_sha256: Some("a".repeat(64)),
            started_at_ms: now_ms(),
            elapsed_ms: 25,
            comparison: comparison(text, text, 1),
            raw_text: text.to_string(),
        })
    }

    #[test]
    fn read_only_listing_does_not_create_an_empty_store() {
        let store = temp_store();
        let root = store.root.clone();

        let listed = store
            .list_page_read_only(RecordingPageParams {
                offset: 0,
                limit: 25,
            })
            .expect("read-only list");

        assert_eq!(listed["totalCount"], 0);
        assert!(!root.exists());
    }

    #[test]
    fn read_only_manifest_collection_stops_at_directory_and_manifest_byte_limits() {
        let store = temp_store();
        for label in ["one", "two", "three"] {
            store
                .start(StartRecordingParams {
                    label: Some(label.to_string()),
                })
                .expect("start bounded collection recording");
        }

        let directory_bounded = store
            .collect_recording_manifests_read_only_bounded(10, 1, 10, u64::MAX, 10)
            .expect("collect with a one-entry directory limit");
        assert_eq!(directory_bounded.inspected_directory_entries, 1);
        assert!(directory_bounded.source_truncated);
        assert!(directory_bounded.collection.items.len() <= 1);

        let manifest_bounded = store
            .collect_recording_manifests_read_only_bounded(10, 10, 10, 1, 10)
            .expect("collect with a one-byte manifest limit");
        assert!(manifest_bounded.source_truncated);
        assert_eq!(manifest_bounded.manifest_bytes_read, 0);
        assert!(manifest_bounded.collection.items.is_empty());
    }

    #[test]
    fn read_only_list_reports_partial_counts_without_oversized_pages() {
        let store = temp_store();
        store
            .start(StartRecordingParams {
                label: Some("x".repeat(1_024)),
            })
            .expect("start list-bound recording");

        let page = store
            .list_page_read_only(RecordingPageParams {
                offset: 0,
                limit: 1,
            })
            .expect("bounded read-only list");
        assert!(page["recordings"][0]["label"]
            .as_str()
            .is_some_and(|label| label.len() <= MAX_AUTOMATION_LABEL_RESPONSE_BYTES));
        assert!(
            serde_json::to_vec(&page)
                .expect("serialize list page")
                .len()
                <= MAX_AUTOMATION_LIST_RESPONSE_BYTES
        );

        let error = store
            .list_page_read_only(RecordingPageParams {
                offset: 0,
                limit: (MAX_AUTOMATION_LIST_PAGE_RECORDINGS + 1) as u64,
            })
            .expect_err("oversized automation list page must fail");
        assert_eq!(error.code, "RECORDING_PAGE_LIMIT_INVALID");
    }

    #[test]
    fn read_only_list_does_not_parse_or_validate_an_out_of_page_candidate() {
        let store = temp_store();
        let invalid_started = store
            .start(StartRecordingParams {
                label: Some("older invalid candidate".to_string()),
            })
            .expect("start invalid list candidate");
        let invalid_id = recording_id(&invalid_started);
        let invalid_chunk_index = write_segment(&store, &invalid_id, "out of page text");
        let invalid_dir = store.recording_dir(&invalid_id).expect("invalid dir");
        let invalid_manifest = read_manifest(&invalid_dir).expect("invalid fixture manifest");
        let invalid_chunk_path = invalid_dir.join(
            &invalid_manifest
                .chunks
                .get(invalid_chunk_index as usize)
                .expect("invalid fixture chunk")
                .file_name,
        );
        let valid_started = store
            .start(StartRecordingParams {
                label: Some("newest valid candidate".to_string()),
            })
            .expect("start valid list candidate");
        let valid_id = recording_id(&valid_started);
        write_segment(&store, &valid_id, "valid list marker");
        let _ = wait_for_search(&store, "valid list marker");
        let valid_dir = store.recording_dir(&valid_id).expect("valid dir");
        let valid_manifest_bytes = fs::metadata(valid_dir.join(MANIFEST_FILE))
            .expect("valid manifest metadata")
            .len();
        fs::remove_file(&invalid_chunk_path).expect("remove fixture chunk");
        fs::create_dir(&invalid_chunk_path).expect("replace fixture chunk with directory");
        let backup_path = invalid_dir.join("manifest.json.bak");
        if backup_path.exists() {
            fs::remove_file(&backup_path).expect("remove fallback fixture manifest");
        }
        let invalid_manifest_before =
            fs::read(invalid_dir.join(MANIFEST_FILE)).expect("invalid manifest before");

        let first_page = store
            .list_page_read_only(RecordingPageParams {
                offset: 0,
                limit: 1,
            })
            .expect("first bounded list page");
        assert_eq!(first_page["recordings"].as_array().map(Vec::len), Some(1));
        assert_eq!(first_page["recordings"][0]["recordingId"], valid_id);
        assert_eq!(first_page["pageCandidateCount"], 1);
        assert_eq!(first_page["manifestBytesRead"], valid_manifest_bytes);
        assert_eq!(first_page["quarantinedCount"], 0);
        assert_eq!(first_page["hasMore"], true);
        assert_eq!(first_page["totalCountExact"], false);
        assert_eq!(
            fs::read(invalid_dir.join(MANIFEST_FILE)).expect("invalid manifest after first page"),
            invalid_manifest_before
        );

        let second_page = store
            .list_page_read_only(RecordingPageParams {
                offset: 1,
                limit: 1,
            })
            .expect("invalid selected page is reported without mutation");
        assert!(second_page["recordings"]
            .as_array()
            .is_some_and(Vec::is_empty));
        assert_eq!(second_page["quarantinedCount"], 1);
        assert_eq!(second_page["hasMore"], false);
        assert!(!store.root.join(QUARANTINE_RECEIPTS_DIR).exists());
        assert_eq!(
            fs::read(invalid_dir.join(MANIFEST_FILE)).expect("invalid manifest after second page"),
            invalid_manifest_before
        );
    }

    #[cfg(windows)]
    #[test]
    fn read_only_transcript_does_not_recreate_a_missing_key() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("read-only key proof".to_string()),
            })
            .expect("start");
        let recording_id = recording_id(&started);
        write_segment(&store, &recording_id, "local transcript");
        let _ = wait_for_search(&store, "local transcript");
        let key_path = store.root.join("keys").join("vault-key.dpapi");
        fs::remove_file(&key_path).expect("remove test key");

        let error = store
            .transcript_page_read_only(TranscriptPageParams {
                recording_id,
                offset: 0,
                limit: 25,
            })
            .expect_err("missing key must fail closed");

        assert_eq!(error.code, "OS_KEY_NOT_FOUND");
        assert!(!key_path.exists());
    }

    #[test]
    fn read_only_transcript_paginates_before_decrypting_segment_content() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start paged transcript recording");
        let recording_id = recording_id(&started);
        write_segment(&store, &recording_id, "first segment");
        write_segment(&store, &recording_id, "second segment");
        let corrupt_index = write_segment(&store, &recording_id, "third segment");
        let _ = wait_for_search(&store, "third segment");
        let dir = store.recording_dir(&recording_id).expect("recording dir");
        let manifest = read_manifest(&dir).expect("manifest before corruption");
        let corrupt_chunk = manifest
            .chunks
            .get(corrupt_index as usize)
            .expect("third chunk");
        let corrupt_path = dir.join(&corrupt_chunk.file_name);
        let mut corrupt_bytes = fs::read(&corrupt_path).expect("read third chunk");
        let last = corrupt_bytes.last_mut().expect("encrypted payload byte");
        *last ^= 0x5a;
        fs::write(&corrupt_path, corrupt_bytes).expect("corrupt third chunk in place");

        let first_page = store
            .transcript_page_read_only(TranscriptPageParams {
                recording_id: recording_id.clone(),
                offset: 0,
                limit: 1,
            })
            .expect("first page must not decrypt later chunks");
        assert_eq!(first_page["segments"][0]["text"], "first segment");

        let error = store
            .transcript_page_read_only(TranscriptPageParams {
                recording_id,
                offset: 2,
                limit: 1,
            })
            .expect_err("corrupted selected page must fail closed");
        assert_eq!(error.code, "RECORDING_CHUNK_DECRYPT_FAILED");
        assert!(!store.root.join(QUARANTINE_RECEIPTS_DIR).exists());
    }

    #[test]
    fn read_only_transcript_bounds_segment_and_response_bytes() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start long transcript recording");
        let recording_id = recording_id(&started);
        write_segment(&store, &recording_id, &"z".repeat(8_192));

        let page = store
            .transcript_page_read_only(TranscriptPageParams {
                recording_id: recording_id.clone(),
                offset: 0,
                limit: 1,
            })
            .expect("bounded transcript page");
        assert_eq!(page["segments"][0]["textTruncated"], true);
        assert_eq!(
            page["segments"][0]["text"]
                .as_str()
                .expect("bounded text")
                .len(),
            MAX_AUTOMATION_TRANSCRIPT_SEGMENT_RESPONSE_BYTES
        );
        assert!(
            serde_json::to_vec(&page)
                .expect("serialize transcript page")
                .len()
                <= MAX_AUTOMATION_TRANSCRIPT_RESPONSE_BYTES
        );

        let error = store
            .transcript_page_read_only(TranscriptPageParams {
                recording_id,
                offset: 0,
                limit: (MAX_AUTOMATION_TRANSCRIPT_PAGE_SEGMENTS + 1) as u64,
            })
            .expect_err("oversized transcript page must fail");
        assert_eq!(error.code, "RECORDING_PAGE_LIMIT_INVALID");
    }

    #[test]
    fn read_only_automation_rejects_non_regular_chunks_without_mutation() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start owned-chunk recording");
        let recording_id = recording_id(&started);
        let chunk_index = write_segment(&store, &recording_id, "owned source text");
        let _ = wait_for_search(&store, "owned source text");
        let dir = store.recording_dir(&recording_id).expect("recording dir");
        let manifest = read_manifest(&dir).expect("manifest");
        let manifest_before = fs::read(dir.join(MANIFEST_FILE)).expect("manifest before");
        let chunk_path = dir.join(
            &manifest
                .chunks
                .get(chunk_index as usize)
                .expect("transcript chunk")
                .file_name,
        );
        fs::remove_file(&chunk_path).expect("remove owned chunk for adversarial fixture");
        fs::create_dir(&chunk_path).expect("replace chunk with directory");

        let transcript_error = store
            .transcript_page_read_only(TranscriptPageParams {
                recording_id: recording_id.clone(),
                offset: 0,
                limit: 1,
            })
            .expect_err("directory chunk must be rejected");
        assert_eq!(transcript_error.code, "RECORDING_MANIFEST_CHUNK_NOT_OWNED");
        let search = store
            .search_read_only(SearchRecordingsParams {
                query: "owned".to_string(),
            })
            .expect("read-only search skips invalid source");
        assert_eq!(search["matchCount"], 0);
        assert_eq!(
            fs::read(dir.join(MANIFEST_FILE)).expect("manifest after"),
            manifest_before
        );
        assert!(!store.root.join(QUARANTINE_RECEIPTS_DIR).exists());
    }

    #[cfg(windows)]
    #[test]
    fn read_only_automation_rejects_symlinked_chunks_without_mutation() {
        use std::os::windows::fs::symlink_file;

        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start symlink fixture recording");
        let recording_id = recording_id(&started);
        let chunk_index = write_segment(&store, &recording_id, "linked source text");
        let _ = wait_for_search(&store, "linked source text");
        let dir = store.recording_dir(&recording_id).expect("recording dir");
        let manifest = read_manifest(&dir).expect("manifest");
        let manifest_before = fs::read(dir.join(MANIFEST_FILE)).expect("manifest before");
        let chunk_path = dir.join(
            &manifest
                .chunks
                .get(chunk_index as usize)
                .expect("transcript chunk")
                .file_name,
        );
        let outside_path = store.root.join("outside-owned-chunk.cchunk");
        fs::copy(&chunk_path, &outside_path).expect("copy outside target");
        fs::remove_file(&chunk_path).expect("remove owned chunk");
        if symlink_file(&outside_path, &chunk_path).is_err() {
            return;
        }

        let error = store
            .transcript_page_read_only(TranscriptPageParams {
                recording_id,
                offset: 0,
                limit: 1,
            })
            .expect_err("symlinked chunk must be rejected");
        assert_eq!(error.code, "RECORDING_MANIFEST_CHUNK_NOT_OWNED");
        assert_eq!(
            fs::read(dir.join(MANIFEST_FILE)).expect("manifest after"),
            manifest_before
        );
        assert!(!store.root.join(QUARANTINE_RECEIPTS_DIR).exists());
    }

    fn complete_revision(
        store: &RecordingStore,
        recording_id: &str,
        chunk_indices: Vec<u32>,
        _source: &str,
        raw: &str,
        normalized: &str,
    ) -> Value {
        store
            .complete_transcription_attempt(TranscriptionSuccessDraft {
                recording_id: recording_id.to_string(),
                attempt_id: None,
                chunk_indices,
                engine: "whisper-rs".to_string(),
                model_id: Some("ggml-base.en.bin".to_string()),
                model_sha256: Some("a".repeat(64)),
                started_at_ms: now_ms(),
                elapsed_ms: 25,
                comparison: comparison(raw, normalized, 1),
                raw_text: raw.to_string(),
            })
            .expect("complete transcript revision")
    }

    #[test]
    fn cloned_workers_serialize_audio_and_notes_manifest_transactions() {
        const WRITE_COUNT: usize = 24;

        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("concurrent chunk mutation proof".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);

        // Hold the same shared guard used by every clone until both workers
        // are ready. Releasing it queues genuine concurrent mutations without
        // relying on scheduler timing to construct the race.
        let held_guard = store.manifest_mutation_guard();
        let ready = Arc::new(std::sync::Barrier::new(3));

        let audio_store = store.clone();
        let audio_recording_id = recording_id.clone();
        let audio_ready = Arc::clone(&ready);
        let audio_worker = std::thread::spawn(move || {
            audio_ready.wait();
            (0..WRITE_COUNT)
                .map(|sequence| {
                    let mut pcm = vec![0_u8; 320];
                    pcm[0] = sequence as u8;
                    audio_store
                        .write_audio_chunk(WriteAudioChunkParams {
                            recording_id: audio_recording_id.clone(),
                            channel: "mic".to_string(),
                            data_base64: BASE64_STANDARD.encode(pcm),
                            sample_rate_hz: 16_000,
                            channel_count: 1,
                            bits_per_sample: 16,
                            start_ms: None,
                        })
                        .map(|_| ())
                })
                .collect::<Vec<_>>()
        });

        let notes_store = store.clone();
        let notes_recording_id = recording_id.clone();
        let notes_ready = Arc::clone(&ready);
        let notes_worker = std::thread::spawn(move || {
            notes_ready.wait();
            (0..WRITE_COUNT)
                .map(|sequence| {
                    notes_store
                        .save_notes(SaveNotesParams {
                            recording_id: notes_recording_id.clone(),
                            markdown: format!("concurrent-note-{sequence:02}"),
                        })
                        .map(|_| ())
                })
                .collect::<Vec<_>>()
        });

        ready.wait();
        drop(held_guard);

        for result in audio_worker.join().expect("join audio worker") {
            result.expect("concurrent audio write");
        }
        for result in notes_worker.join().expect("join notes worker") {
            result.expect("concurrent notes write");
        }

        let dir = store
            .recording_dir(&recording_id)
            .expect("recording directory");
        let manifest = read_manifest(&dir).expect("read final manifest");
        assert_eq!(manifest.chunks.len(), WRITE_COUNT * 2);
        for (expected_index, chunk) in manifest.chunks.iter().enumerate() {
            assert_eq!(chunk.index, expected_index as u32);
            assert!(dir.join(&chunk.file_name).is_file());
        }

        let audio_chunks = manifest
            .chunks
            .iter()
            .filter(|chunk| chunk.kind == DurableChunkKind::AudioPcm16le)
            .collect::<Vec<_>>();
        let notes_chunks = manifest
            .chunks
            .iter()
            .filter(|chunk| chunk.kind == DurableChunkKind::NotesMarkdown)
            .collect::<Vec<_>>();
        assert_eq!(audio_chunks.len(), WRITE_COUNT);
        assert_eq!(notes_chunks.len(), WRITE_COUNT);

        let audio_sequences = audio_chunks
            .iter()
            .map(|chunk| {
                store
                    .read_chunk_bytes(&manifest, chunk, &dir)
                    .expect("read audio payload")[0]
            })
            .collect::<HashSet<_>>();
        let note_values = notes_chunks
            .iter()
            .map(|chunk| {
                String::from_utf8(
                    store
                        .read_chunk_bytes(&manifest, chunk, &dir)
                        .expect("read notes payload"),
                )
                .expect("notes utf8")
            })
            .collect::<HashSet<_>>();
        assert_eq!(audio_sequences.len(), WRITE_COUNT);
        assert_eq!(note_values.len(), WRITE_COUNT);
    }

    #[test]
    fn cloned_workers_preserve_revision_selection_completion_and_processing_facts() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("concurrent trust history proof".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);

        let first_attempt = store
            .begin_transcription_attempt(&recording_id)
            .expect("first attempt");
        write_attempt_segment(&store, &recording_id, &first_attempt, "first revision");
        let first_revision =
            complete_attempt(&store, &recording_id, &first_attempt, "first revision")
                .expect("complete first revision")["revisionId"]
                .as_str()
                .expect("first revision id")
                .to_string();

        let second_attempt = store
            .begin_transcription_attempt(&recording_id)
            .expect("second attempt");
        write_attempt_segment(&store, &recording_id, &second_attempt, "second revision");
        complete_attempt(&store, &recording_id, &second_attempt, "second revision")
            .expect("complete second revision");

        let third_attempt = store
            .begin_transcription_attempt(&recording_id)
            .expect("third attempt");
        write_attempt_segment(&store, &recording_id, &third_attempt, "third revision");

        let held_guard = store.manifest_mutation_guard();
        let ready = Arc::new(std::sync::Barrier::new(4));

        let selection_store = store.clone();
        let selection_recording_id = recording_id.clone();
        let selection_revision_id = first_revision.clone();
        let selection_ready = Arc::clone(&ready);
        let selection_worker = std::thread::spawn(move || {
            selection_ready.wait();
            selection_store.select_transcript_revision(TranscriptRevisionParams {
                recording_id: selection_recording_id,
                revision_id: selection_revision_id,
            })
        });

        let completion_store = store.clone();
        let completion_recording_id = recording_id.clone();
        let completion_attempt_id = third_attempt.clone();
        let completion_ready = Arc::clone(&ready);
        let completion_worker = std::thread::spawn(move || {
            completion_ready.wait();
            complete_attempt(
                &completion_store,
                &completion_recording_id,
                &completion_attempt_id,
                "third revision",
            )
        });

        let processing_store = store.clone();
        let processing_recording_id = recording_id.clone();
        let processing_ready = Arc::clone(&ready);
        let processing_worker = std::thread::spawn(move || {
            processing_ready.wait();
            processing_store.record_processing_fact(
                &processing_recording_id,
                "local-ai-recap",
                "heuristic",
                None,
                None,
            )
        });

        ready.wait();
        drop(held_guard);

        selection_worker
            .join()
            .expect("join selection worker")
            .expect("select revision");
        let completed_revision = completion_worker
            .join()
            .expect("join completion worker")
            .expect("complete concurrent revision")["revisionId"]
            .as_str()
            .expect("completed revision id")
            .to_string();
        processing_worker
            .join()
            .expect("join processing worker")
            .expect("record processing fact");

        let manifest = read_manifest(
            &store
                .recording_dir(&recording_id)
                .expect("recording directory"),
        )
        .expect("read final manifest");
        assert_eq!(manifest.transcript_revisions.len(), 3);
        assert!(manifest
            .transcript_revisions
            .iter()
            .any(|revision| revision.revision_id == completed_revision));
        assert_eq!(manifest.processing_receipts.len(), 3);
        assert!(manifest
            .privacy_events
            .iter()
            .any(|event| event.event_type == "local-ai-recap"));
        assert!(matches!(
            manifest.current_transcript_revision_id.as_deref(),
            Some(current) if current == first_revision || current == completed_revision
        ));
    }

    #[test]
    fn transcript_reruns_select_one_current_revision_and_preserve_older_revision() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Revision history".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let first_index = write_segment(&store, &recording_id, "first transcript");
        let first = complete_revision(
            &store,
            &recording_id,
            vec![first_index],
            "initial",
            "first transcript",
            "first transcript",
        );
        let first_revision_id = first["revisionId"].as_str().expect("first id").to_string();
        let first_before = store
            .transcript_revision(TranscriptRevisionParams {
                recording_id: recording_id.clone(),
                revision_id: first_revision_id.clone(),
            })
            .expect("read first revision");

        let second_index = write_segment(&store, &recording_id, "second transcript");
        let second = complete_revision(
            &store,
            &recording_id,
            vec![second_index],
            "reprocess",
            " second transcript ",
            "second transcript",
        );
        let current = store
            .transcript(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read current transcript");
        assert_eq!(current["revisionCount"], 2);
        assert_eq!(current["currentRevisionId"], second["revisionId"]);
        assert_eq!(current["segmentCount"], 1);
        assert_eq!(current["segments"][0]["text"], "second transcript");

        let first_after = store
            .transcript_revision(TranscriptRevisionParams {
                recording_id: recording_id.clone(),
                revision_id: first_revision_id.clone(),
            })
            .expect("read immutable first revision again");
        assert_eq!(first_before["revision"], first_after["revision"]);
        assert_eq!(first_after["segments"][0]["text"], "first transcript");

        let selected = store
            .select_transcript_revision(TranscriptRevisionParams {
                recording_id: recording_id.clone(),
                revision_id: first_revision_id,
            })
            .expect("select older revision");
        assert_eq!(selected["olderRevisionsRetained"], 1);
        let restored = store
            .transcript(RecordingIdParams { recording_id })
            .expect("read selected older transcript");
        assert_eq!(restored["segmentCount"], 1);
        assert_eq!(restored["segments"][0]["text"], "first transcript");
    }

    #[test]
    fn schema_five_exposes_typed_asr_revision_and_stage_receipt() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Typed history".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let index = write_segment(&store, &recording_id, "typed raw transcript");
        let committed = complete_revision(
            &store,
            &recording_id,
            vec![index],
            "initial",
            "typed raw transcript",
            "typed raw transcript",
        );

        let history = store
            .trust_history(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("typed trust history");
        assert_eq!(history["revisions"][0]["kind"], "raw-asr");
        assert_eq!(history["revisions"][0]["parentRevisionId"], Value::Null);
        assert_eq!(history["currentRevisionId"], committed["revisionId"]);
        assert_eq!(history["currentCleanedRevisionId"], Value::Null);
        assert_eq!(history["processingReceipts"][0]["stage"], "transcription");
        assert_eq!(
            history["processingReceipts"][0]["validationResult"],
            "passed"
        );
        assert_eq!(history["processingReceipts"][0]["fallbackApplied"], false);

        let manifest = read_manifest(
            &store
                .recording_dir(&recording_id)
                .expect("recording directory"),
        )
        .expect("schema five manifest");
        assert_eq!(manifest.schema_version, 5);
    }

    #[test]
    fn cleaned_revision_uses_separate_pointer_and_cannot_replace_evidence() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Separate cleaned pointer".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let index = write_segment(&store, &recording_id, "immutable source");
        let committed = complete_revision(
            &store,
            &recording_id,
            vec![index],
            "initial",
            "immutable source",
            "immutable source",
        );
        let raw_revision_id = committed["revisionId"]
            .as_str()
            .expect("raw revision id")
            .to_string();
        let dir = store
            .recording_dir(&recording_id)
            .expect("recording directory");
        let mut manifest = read_manifest(&dir).expect("manifest");
        let raw = manifest.transcript_revisions[0].clone();
        let cleaned_revision_id = format!("tr-000002-{}", now_ms());
        manifest.transcript_revisions.push(TranscriptRevision {
            revision_id: cleaned_revision_id.clone(),
            version: 2,
            source: "ai-cleanup".to_string(),
            kind: TranscriptRevisionKind::AiCleaned,
            parent_revision_id: Some(raw_revision_id.clone()),
            chunk_indices: raw.chunk_indices,
            engine: "local-llm".to_string(),
            model_id: Some("fixture-local-model".to_string()),
            model_sha256: Some("b".repeat(64)),
            raw_text_chunk_indices: None,
            comparison: raw.comparison,
            created_at_ms: now_ms(),
        });
        manifest.current_cleaned_revision_id = Some(cleaned_revision_id.clone());
        write_manifest(&dir, &manifest).expect("write valid cleaned revision");

        let history = store
            .trust_history(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("history with cleaned revision");
        assert_eq!(history["currentRevisionId"], raw_revision_id);
        assert_eq!(history["currentCleanedRevisionId"], cleaned_revision_id);
        assert_eq!(history["revisions"][1]["kind"], "ai-cleaned");
        assert_eq!(
            history["revisions"][1]["parentRevisionId"],
            history["revisions"][0]["revisionId"]
        );

        let error = store
            .select_transcript_revision(TranscriptRevisionParams {
                recording_id,
                revision_id: cleaned_revision_id,
            })
            .expect_err("cleaned text must not replace evidence");
        assert_eq!(error.code, "TRANSCRIPT_CLEANED_REVISION_SELECTION_INVALID");
    }

    #[test]
    fn cleaned_revision_rejects_missing_parent() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let index = write_segment(&store, &recording_id, "source");
        complete_revision(
            &store,
            &recording_id,
            vec![index],
            "initial",
            "source",
            "source",
        );
        let dir = store
            .recording_dir(&recording_id)
            .expect("recording directory");
        let mut manifest = read_manifest(&dir).expect("manifest");
        let raw = manifest.transcript_revisions[0].clone();
        manifest.transcript_revisions.push(TranscriptRevision {
            revision_id: format!("tr-000002-{}", now_ms()),
            version: 2,
            source: "ai-cleanup".to_string(),
            kind: TranscriptRevisionKind::AiCleaned,
            parent_revision_id: Some("tr-missing-parent".to_string()),
            chunk_indices: raw.chunk_indices,
            engine: "local-llm".to_string(),
            model_id: Some("fixture-local-model".to_string()),
            model_sha256: Some("c".repeat(64)),
            raw_text_chunk_indices: None,
            comparison: raw.comparison,
            created_at_ms: now_ms(),
        });

        write_manifest(&dir, &manifest).expect("write adversarial manifest fixture");
        let error = read_manifest(&dir).expect_err("missing parent must fail closed on reopen");
        assert_eq!(error.code, "TRANSCRIPT_PARENT_REVISION_INVALID");
    }

    #[test]
    fn cleanup_commit_preserves_evidence_and_records_validated_lineage() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Cleanup handoff".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let index = write_segment(&store, &recording_id, "um this is the source");
        let committed = complete_revision(
            &store,
            &recording_id,
            vec![index],
            "initial",
            "um this is the source",
            "um this is the source",
        );
        let parent_revision_id = committed["revisionId"]
            .as_str()
            .expect("parent revision")
            .to_string();
        let attempt_id = store
            .begin_cleanup_attempt(&recording_id)
            .expect("begin cleanup attempt");
        store
            .write_cleanup_attempt_segment(
                &attempt_id,
                WriteTranscriptSegmentParams {
                    recording_id: recording_id.clone(),
                    channel: "mic".to_string(),
                    speaker: Some("Me".to_string()),
                    text: "This is the source.".to_string(),
                    start_ms: 0,
                    duration_ms: Some(500),
                    end_ms: None,
                    confidence: Some(0.9),
                },
            )
            .expect("write cleaned segment");
        let cleaned = store
            .complete_cleanup_attempt(CleanupSuccessDraft {
                recording_id: recording_id.clone(),
                attempt_id,
                parent_revision_id: parent_revision_id.clone(),
                engine: "llama-cpp-local".to_string(),
                model_id: "qwen3-4b-official-q4-k-m".to_string(),
                model_sha256: "b".repeat(64),
                prompt_template_sha256: "c".repeat(64),
                started_at_ms: now_ms(),
                elapsed_ms: 20,
            })
            .expect("commit cleaned revision");

        let history = store
            .trust_history(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read cleanup history");
        assert_eq!(history["currentRevisionId"], parent_revision_id);
        assert_eq!(history["currentCleanedRevisionId"], cleaned["revisionId"]);
        assert_eq!(history["revisions"][1]["kind"], "ai-cleaned");
        assert_eq!(
            history["processingReceipts"][1]["inputRevisionId"],
            history["revisions"][0]["revisionId"]
        );
        assert_eq!(history["processingReceipts"][1]["stage"], "cleanup");
        assert_eq!(
            history["processingReceipts"][1]["validationResult"],
            "passed"
        );

        let ai_input = store
            .transcript_for_local_ai(recording_id)
            .expect("read AI handoff transcript");
        assert_eq!(ai_input["inputRevisionKind"], "ai-cleaned");
        assert_eq!(ai_input["cleanupFallbackApplied"], false);
        assert_eq!(ai_input["segments"][0]["text"], "This is the source.");
    }

    #[test]
    fn recap_receipt_preserves_summary_lineage_without_creating_a_transcript_revision() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Summary lineage".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let index = write_segment(&store, &recording_id, "the original source");
        let committed = complete_revision(
            &store,
            &recording_id,
            vec![index],
            "initial",
            "the original source",
            "the original source",
        );
        let input_revision_id = committed["revisionId"]
            .as_str()
            .expect("input revision")
            .to_string();

        store
            .record_recap_receipt(RecapReceiptDraft {
                recording_id: recording_id.clone(),
                input_revision_id: input_revision_id.clone(),
                engine: "llama-cpp-local".to_string(),
                model_id: Some("qwen3-4b-official-q4-k-m".to_string()),
                model_sha256: Some("d".repeat(64)),
                prompt_template_sha256: "e".repeat(64),
                validation_result: "passed".to_string(),
                fallback_applied: true,
                started_at_ms: now_ms(),
                elapsed_ms: 12,
            })
            .expect("record recap receipt");

        let history = store
            .trust_history(RecordingIdParams { recording_id })
            .expect("read recap history");
        assert_eq!(history["revisionCount"], 1);
        assert_eq!(history["receiptCount"], 2);
        assert_eq!(
            history["processingReceipts"][1]["operation"],
            "local-ai-recap"
        );
        assert_eq!(history["processingReceipts"][1]["stage"], "recap");
        assert_eq!(history["processingReceipts"][1]["revisionId"], Value::Null);
        assert_eq!(
            history["processingReceipts"][1]["inputRevisionId"],
            input_revision_id
        );
        assert_eq!(history["processingReceipts"][1]["fallbackApplied"], true);
    }

    #[test]
    fn search_labels_original_and_cleaned_transcript_matches_separately() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let index = write_segment(&store, &recording_id, "um handoffterm source");
        let committed = complete_revision(
            &store,
            &recording_id,
            vec![index],
            "initial",
            "um handoffterm source",
            "um handoffterm source",
        );
        let attempt_id = store
            .begin_cleanup_attempt(&recording_id)
            .expect("begin cleanup");
        store
            .write_cleanup_attempt_segment(
                &attempt_id,
                WriteTranscriptSegmentParams {
                    recording_id: recording_id.clone(),
                    channel: "mic".to_string(),
                    speaker: Some("Me".to_string()),
                    text: "Handoffterm polishedonlyterm source.".to_string(),
                    start_ms: 0,
                    duration_ms: Some(500),
                    end_ms: None,
                    confidence: Some(0.9),
                },
            )
            .expect("write cleaned transcript");
        store
            .complete_cleanup_attempt(CleanupSuccessDraft {
                recording_id: recording_id.clone(),
                attempt_id,
                parent_revision_id: committed["revisionId"]
                    .as_str()
                    .expect("parent revision")
                    .to_string(),
                engine: "llama-cpp-local".to_string(),
                model_id: "qwen3-4b-official-q4_k_m".to_string(),
                model_sha256: "a".repeat(64),
                prompt_template_sha256: "b".repeat(64),
                started_at_ms: now_ms(),
                elapsed_ms: 5,
            })
            .expect("commit cleaned transcript");

        let search = wait_for_search(&store, "handoffterm");
        assert_eq!(search["matchCount"], 2);
        let kinds = search["matches"]
            .as_array()
            .expect("search matches")
            .iter()
            .filter_map(|value| value["rowKind"].as_str())
            .collect::<HashSet<_>>();
        assert!(kinds.contains("originalTranscriptSegment"));
        assert!(kinds.contains("cleanedTranscriptSegment"));

        let replacement_index = write_segment(&store, &recording_id, "replacement source");
        complete_revision(
            &store,
            &recording_id,
            vec![replacement_index],
            "manual reprocess",
            "replacement source",
            "replacement source",
        );
        let stale_cleaned_search = wait_for_search(&store, "polishedonlyterm");
        assert_eq!(stale_cleaned_search["matchCount"], 0);
    }

    #[test]
    fn cleanup_commit_rejects_changed_segment_metadata() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let index = write_segment(&store, &recording_id, "source");
        let committed = complete_revision(
            &store,
            &recording_id,
            vec![index],
            "initial",
            "source",
            "source",
        );
        let parent_revision_id = committed["revisionId"]
            .as_str()
            .expect("parent revision")
            .to_string();
        let attempt_id = store
            .begin_cleanup_attempt(&recording_id)
            .expect("begin cleanup attempt");
        store
            .write_cleanup_attempt_segment(
                &attempt_id,
                WriteTranscriptSegmentParams {
                    recording_id: recording_id.clone(),
                    channel: "mic".to_string(),
                    speaker: Some("Me".to_string()),
                    text: "Source.".to_string(),
                    start_ms: 100,
                    duration_ms: Some(500),
                    end_ms: None,
                    confidence: Some(0.9),
                },
            )
            .expect("write mismatched segment");
        let error = store
            .complete_cleanup_attempt(CleanupSuccessDraft {
                recording_id,
                attempt_id,
                parent_revision_id,
                engine: "llama-cpp-local".to_string(),
                model_id: "qwen3-4b-official-q4-k-m".to_string(),
                model_sha256: "b".repeat(64),
                prompt_template_sha256: "c".repeat(64),
                started_at_ms: now_ms(),
                elapsed_ms: 20,
            })
            .expect_err("timestamp drift must fail");
        assert_eq!(error.code, "TRANSCRIPT_CLEANUP_MAPPING_INVALID");
    }

    #[test]
    fn first_native_reprocess_promotes_legacy_manual_transcript_before_replacing_it() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Legacy reprocess".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        write_segment(&store, &recording_id, "legacy transcript remains available");
        write_segment(
            &store,
            &recording_id,
            "legacy second segment remains available",
        );
        write_segment(
            &store,
            &recording_id,
            "legacy third segment remains available",
        );
        let legacy_manifest = read_manifest(
            &store
                .recording_dir(&recording_id)
                .expect("legacy recording directory"),
        )
        .expect("read legacy manifest");
        let legacy_indices = current_transcript_chunk_indices(&legacy_manifest);
        let bounded_error =
            legacy_transcript_bytes_with_limit(&legacy_manifest, &legacy_indices, 8)
                .expect_err("oversized legacy migration must fail before content reads");
        assert_eq!(bounded_error.code, "TRANSCRIPT_LEGACY_MIGRATION_TOO_LARGE");
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish legacy recording");
        let attempt_id = store
            .begin_transcription_attempt(&recording_id)
            .expect("begin reprocess attempt");
        write_attempt_segment(&store, &recording_id, &attempt_id, "replacement transcript");
        let completed =
            complete_attempt(&store, &recording_id, &attempt_id, "replacement transcript")
                .expect("complete reprocess attempt");

        let restarted = RecordingStore::with_root(store.root.clone());
        let history = restarted
            .trust_history(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read Trust History");
        assert_eq!(history["revisionCount"], 2);
        assert_eq!(history["revisions"][0]["source"], "initial");
        assert_eq!(history["revisions"][0]["engine"], "legacy-manual");
        assert_eq!(history["revisions"][0]["rawComparisonAvailable"], false);
        assert_eq!(history["revisions"][1]["source"], "reprocess");
        assert_eq!(history["currentRevisionId"], completed["revisionId"]);

        let legacy_revision_id = history["revisions"][0]["revisionId"]
            .as_str()
            .expect("legacy revision id")
            .to_string();
        let legacy = restarted
            .transcript_revision(TranscriptRevisionParams {
                recording_id: recording_id.clone(),
                revision_id: legacy_revision_id.clone(),
            })
            .expect("read preserved legacy revision");
        assert_eq!(legacy["segmentCount"], 3);
        assert_eq!(
            legacy["segments"][0]["text"],
            "legacy transcript remains available"
        );
        assert_eq!(
            legacy["segments"][1]["text"],
            "legacy second segment remains available"
        );
        assert_eq!(
            legacy["segments"][2]["text"],
            "legacy third segment remains available"
        );
        assert_eq!(legacy["comparisonView"]["reason"], "legacy-revision");
        restarted
            .select_transcript_revision(TranscriptRevisionParams {
                recording_id: recording_id.clone(),
                revision_id: legacy_revision_id,
            })
            .expect("select preserved legacy revision");
        let selected = restarted
            .transcript(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read selected legacy transcript");
        assert_eq!(selected["segmentCount"], 3);
        let exported = restarted
            .export_markdown(ExportRecordingParams {
                recording_id,
                format: "markdown".to_string(),
                channel: None,
                report: None,
                options: ExportDocumentOptions::default(),
            })
            .expect("export selected legacy transcript");
        assert!(exported["markdown"]
            .as_str()
            .expect("export markdown")
            .contains("legacy third segment remains available"));
    }

    #[test]
    fn raw_transcript_is_encrypted_private_and_available_only_as_a_bounded_revision_view() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let index = write_segment(&store, &recording_id, "normalized safe phrase");
        let committed = complete_revision(
            &store,
            &recording_id,
            vec![index],
            "initial",
            "raw-private-original phrase",
            "normalized safe phrase",
        );
        let revision_id = committed["revisionId"]
            .as_str()
            .expect("revision id")
            .to_string();
        let dir = store.recording_dir(&recording_id).expect("recording dir");
        let manifest = read_manifest(&dir).expect("manifest");
        let raw_index = manifest.transcript_revisions[0]
            .raw_text_chunk_indices
            .as_ref()
            .and_then(|indices| indices.first())
            .copied()
            .expect("raw chunk index");
        let raw_chunk = &manifest.chunks[raw_index as usize];
        assert_eq!(raw_chunk.kind, DurableChunkKind::RawTranscriptText);
        assert!(raw_chunk.encrypted);
        assert!(raw_chunk.file_name.contains(RAW_TRANSCRIPT_FILE_MARKER));
        let ciphertext = fs::read(dir.join(&raw_chunk.file_name)).expect("raw ciphertext");
        assert!(!String::from_utf8_lossy(&ciphertext).contains("raw-private-original"));

        let history = store
            .trust_history(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("history");
        let history_json = serde_json::to_string(&history).expect("history json");
        assert_eq!(history["revisions"][0]["rawComparisonAvailable"], true);
        assert!(!history_json.contains("rawTextChunkIndices"));
        assert!(!history_json.contains("raw-private-original"));

        let detail = store
            .transcript_revision(TranscriptRevisionParams {
                recording_id: recording_id.clone(),
                revision_id,
            })
            .expect("revision detail");
        assert_eq!(detail["comparisonView"]["available"], true);
        assert_eq!(
            detail["comparisonView"]["rawText"],
            "raw-private-original phrase"
        );
        assert_eq!(
            detail["comparisonView"]["normalizedText"],
            "normalized safe phrase"
        );
        assert_eq!(detail["comparisonView"]["encryptedAtRest"], true);
        let detail_json = serde_json::to_string(&detail).expect("detail json");
        assert!(!detail_json.contains("rawTextChunkIndices"));
        assert!(!detail_json.contains(RAW_TRANSCRIPT_FILE_MARKER));

        let general = store
            .read(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("general recording read");
        let general_json = serde_json::to_string(&general).expect("general json");
        assert!(!general_json.contains("raw-private-original"));
        assert!(!general_json.contains("rawTranscriptText"));
        assert!(!general_json.contains(RAW_TRANSCRIPT_FILE_MARKER));
        assert_eq!(general["chunkCount"], 1);
        assert!(
            general["summary"]["totalBytes"]
                .as_u64()
                .unwrap_or_default()
                >= ("normalized safe phrase".len() + "raw-private-original phrase".len()) as u64
        );
        assert_eq!(
            store
                .read_audio_chunk(AudioChunkParams {
                    recording_id,
                    index: raw_index,
                })
                .expect_err("raw chunk must not be an audio read")
                .code,
            "RECORDING_AUDIO_CHUNK_NOT_FOUND"
        );
    }

    #[test]
    fn revision_comparison_preview_is_utf8_safe_and_transport_bounded() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let normalized = "é".repeat(40_000);
        let raw = format!(" {normalized} ");
        let index = write_segment(&store, &recording_id, &normalized);
        let committed = complete_revision(
            &store,
            &recording_id,
            vec![index],
            "initial",
            &raw,
            &normalized,
        );
        let detail = store
            .transcript_revision(TranscriptRevisionParams {
                recording_id,
                revision_id: committed["revisionId"]
                    .as_str()
                    .expect("revision id")
                    .to_string(),
            })
            .expect("bounded detail");
        for field in ["rawText", "normalizedText"] {
            let text = detail["comparisonView"][field]
                .as_str()
                .expect("bounded comparison text");
            assert!(text.len() <= MAX_COMPARISON_TEXT_BYTES_PER_SIDE);
            assert!(std::str::from_utf8(text.as_bytes()).is_ok());
        }
        assert_eq!(detail["comparisonView"]["rawTextTruncated"], true);
        assert_eq!(detail["comparisonView"]["normalizedTextTruncated"], true);
        assert!(serde_json::to_vec(&detail).expect("serialize detail").len() < 5 * 1024 * 1024);
    }

    #[test]
    fn revision_detail_stops_before_the_501st_segment_chunk() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let mut indices = Vec::new();
        for _ in 0..501 {
            indices.push(write_segment(&store, &recording_id, "x"));
        }
        let normalized = vec!["x"; 501].join("\n");
        let mut metadata = comparison(&normalized, &normalized, 501);
        metadata.raw_segment_count = 501;
        metadata.normalized_segment_count = 501;
        let committed = store
            .complete_transcription_attempt(TranscriptionSuccessDraft {
                recording_id: recording_id.clone(),
                attempt_id: None,
                chunk_indices: indices.clone(),
                engine: "whisper-rs".to_string(),
                model_id: Some("ggml-base.en.bin".to_string()),
                model_sha256: Some("a".repeat(64)),
                started_at_ms: now_ms(),
                elapsed_ms: 25,
                comparison: metadata,
                raw_text: normalized,
            })
            .expect("complete many-segment revision");
        let dir = store.recording_dir(&recording_id).expect("recording dir");
        let manifest = read_manifest(&dir).expect("manifest");
        let unread_index = indices[500];
        let unread_path = dir.join(&manifest.chunks[unread_index as usize].file_name);
        fs::write(&unread_path, [0xff_u8]).expect("corrupt out-of-page segment");

        let detail = store
            .transcript_revision(TranscriptRevisionParams {
                recording_id,
                revision_id: committed["revisionId"]
                    .as_str()
                    .expect("revision id")
                    .to_string(),
            })
            .expect("bounded revision detail must not read segment 501");
        assert_eq!(detail["segmentCount"], 501);
        assert_eq!(detail["returnedSegmentCount"], 500);
        assert_eq!(detail["hasMore"], true);
        assert_eq!(detail["segments"].as_array().map(Vec::len), Some(500));
        assert!(
            serde_json::to_vec(&detail)
                .expect("serialize bounded detail")
                .len()
                < MAX_REVISION_DETAIL_SEGMENT_BYTES + 512 * 1024
        );
    }

    #[test]
    fn legacy_revision_without_raw_chunks_remains_readable_and_reports_unavailable() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let index = write_segment(&store, &recording_id, "legacy normalized text");
        let committed = complete_revision(
            &store,
            &recording_id,
            vec![index],
            "initial",
            "legacy normalized text",
            "legacy normalized text",
        );
        let revision_id = committed["revisionId"]
            .as_str()
            .expect("revision id")
            .to_string();
        let dir = store.recording_dir(&recording_id).expect("recording dir");
        let mut manifest = read_manifest(&dir).expect("manifest");
        let raw_indices = manifest.transcript_revisions[0]
            .raw_text_chunk_indices
            .take()
            .expect("raw indices");
        for index in raw_indices.into_iter().rev() {
            let chunk = manifest.chunks.pop().expect("raw chunk");
            assert_eq!(chunk.index, index);
            fs::remove_file(dir.join(chunk.file_name)).expect("remove raw chunk");
        }
        manifest.schema_version = 3;
        manifest.transcript_revisions[0].kind = TranscriptRevisionKind::Legacy;
        manifest.transcript_revisions[0].parent_revision_id = None;
        manifest.current_cleaned_revision_id = None;
        manifest.processing_receipts.clear();
        write_manifest(&dir, &manifest).expect("write legacy manifest");

        let history = store
            .trust_history(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("legacy history");
        assert_eq!(history["revisions"][0]["rawComparisonAvailable"], false);
        assert!(!serde_json::to_string(&history)
            .expect("history json")
            .contains("rawTextChunkIndices"));
        let detail = store
            .transcript_revision(TranscriptRevisionParams {
                recording_id,
                revision_id,
            })
            .expect("legacy detail");
        assert_eq!(detail["comparisonView"]["available"], false);
        assert_eq!(detail["comparisonView"]["reason"], "legacy-revision");
        assert_eq!(detail["segments"][0]["text"], "legacy normalized text");
    }

    fn assert_orphan_raw_recovery(manifest_damage: Option<&str>) {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        write_segment(&store, &recording_id, "ordinary readable meeting text");
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish recording");
        let orphan = write_orphan_raw_transcript_file(
            &store,
            &recording_id,
            "crash-window-private-raw-text",
        );
        let manifest_path = store
            .recording_dir(&recording_id)
            .expect("recording dir")
            .join(MANIFEST_FILE);
        match manifest_damage {
            Some("missing") => fs::remove_file(&manifest_path).expect("remove manifest"),
            Some("corrupt") => fs::write(&manifest_path, b"{corrupt").expect("corrupt manifest"),
            _ => {}
        }

        let recovered = store.recover().expect("recover orphan raw chunk");
        assert_eq!(recovered["quarantinedCount"], 0);
        assert!(!orphan.exists());
        let read = store
            .read(RecordingIdParams { recording_id })
            .expect("ordinary meeting remains readable");
        let serialized = serde_json::to_string(&read).expect("serialize recovered meeting");
        assert!(serialized.contains("ordinary readable meeting text"));
        assert!(!serialized.contains("crash-window-private-raw-text"));
        assert!(!serialized.contains("rawTranscriptText"));
        assert!(!serialized.contains(RAW_TRANSCRIPT_FILE_MARKER));
        let search = wait_for_search(&store, "crash-window-private-raw-text");
        assert_eq!(search["matchCount"], 0);
        let export = store
            .export_create(ExportRecordingParams {
                recording_id: read["summary"]["recordingId"]
                    .as_str()
                    .expect("recording id from read")
                    .to_string(),
                format: "markdown".to_string(),
                channel: None,
                report: None,
                options: Default::default(),
            })
            .expect("export recovered meeting");
        assert!(!serde_json::to_string(&export)
            .expect("serialize recovered export")
            .contains("crash-window-private-raw-text"));
    }

    #[test]
    fn recovery_removes_uncommitted_raw_chunk_after_manifest_commit_crash_window() {
        assert_orphan_raw_recovery(None);
    }

    #[test]
    fn recovery_removes_unowned_raw_chunk_when_manifest_is_missing() {
        assert_orphan_raw_recovery(Some("missing"));
    }

    #[test]
    fn recovery_removes_unowned_raw_chunk_when_manifest_is_corrupt() {
        assert_orphan_raw_recovery(Some("corrupt"));
    }

    #[test]
    fn failed_first_attempt_is_invisible_before_and_after_restart() {
        let store = temp_store();
        let root = store.root.clone();
        let started = store
            .start(StartRecordingParams {
                label: Some("Attempt isolation".to_string()),
            })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish recording");
        let attempt_id = store
            .begin_transcription_attempt(&recording_id)
            .expect("begin failed attempt");
        write_attempt_segment(
            &store,
            &recording_id,
            &attempt_id,
            "failed-attempt-private-phrase",
        );
        store
            .record_transcription_failure(TranscriptionFailureDraft {
                recording_id: recording_id.clone(),
                engine: "whisper-rs".to_string(),
                model_id: Some("ggml-base.en.bin".to_string()),
                started_at_ms: now_ms(),
                elapsed_ms: 12,
                error_code: "TRANSCRIPTION_ENGINE_FAILED".to_string(),
                cancelled: false,
            })
            .expect("record failed attempt");

        let assert_invisible = |candidate: &RecordingStore| {
            let transcript = candidate
                .transcript(RecordingIdParams {
                    recording_id: recording_id.clone(),
                })
                .expect("read transcript");
            assert_eq!(transcript["segmentCount"], 0);
            assert_eq!(transcript["revisionCount"], 0);
            let read = candidate
                .read(RecordingIdParams {
                    recording_id: recording_id.clone(),
                })
                .expect("read recording");
            let serialized = serde_json::to_string(&read).expect("serialize read");
            assert!(!serialized.contains("failed-attempt-private-phrase"));
            assert_eq!(read["chunkCount"], 0);
            assert_eq!(read["summary"]["transcriptSegmentCount"], 0);
            let search = wait_for_search(candidate, "failed-attempt-private-phrase");
            assert_eq!(search["matchCount"], 0);
            let receipt = candidate
                .privacy_receipt(RecordingIdParams {
                    recording_id: recording_id.clone(),
                })
                .expect("privacy receipt");
            assert_eq!(receipt["content"]["transcriptSegmentCount"], 0);
            assert_eq!(receipt["trustHistory"]["revisionCount"], 0);
            if receipt["trustHistory"]["processingReceiptCount"] == 1 {
                assert_eq!(
                    receipt["trustHistory"]["processingReceipts"][0]["outcome"],
                    "failed"
                );
            }
            assert_eq!(receipt["rawPathExposed"], false);
            assert_eq!(receipt["keyMaterialExposedToRenderer"], false);
        };

        assert_invisible(&store);
        let restarted = RecordingStore::with_root(root.clone());
        restarted.recover().expect("recover restarted store");
        assert_invisible(&restarted);

        let manifest_path = restarted
            .recording_dir(&recording_id)
            .expect("recording dir")
            .join(MANIFEST_FILE);
        let mut tampered: Value = serde_json::from_slice(
            &fs::read(&manifest_path).expect("read attempt manifest for tamper test"),
        )
        .expect("parse attempt manifest for tamper test");
        tampered["chunks"][0]
            .as_object_mut()
            .expect("attempt chunk object")
            .remove("transcriptionAttemptId");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&tampered).expect("serialize tampered attempt manifest"),
        )
        .expect("write tampered attempt manifest");
        let tampered_error = restarted
            .transcript(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect_err("mismatched attempt membership must fail closed");
        assert_eq!(tampered_error.code, "TRANSCRIPTION_ATTEMPT_CHUNK_INVALID");
        restarted
            .recover()
            .expect("recover attempt membership from durable chunk name");
        assert_invisible(&restarted);

        fs::remove_file(manifest_path).expect("remove manifest to exercise fail-closed rebuild");
        let rebuilt = RecordingStore::with_root(root);
        rebuilt
            .recover()
            .expect("rebuild missing manifest after failed attempt");
        assert_invisible(&rebuilt);
    }

    #[test]
    fn cancelled_attempt_preserves_the_previously_committed_transcript() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish recording");
        let committed_attempt = store
            .begin_transcription_attempt(&recording_id)
            .expect("begin committed attempt");
        write_attempt_segment(
            &store,
            &recording_id,
            &committed_attempt,
            "stable committed transcript",
        );
        complete_attempt(
            &store,
            &recording_id,
            &committed_attempt,
            "stable committed transcript",
        )
        .expect("commit initial transcript");
        let before = store
            .transcript(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read transcript before cancellation");

        let cancelled_attempt = store
            .begin_transcription_attempt(&recording_id)
            .expect("begin cancelled attempt");
        write_attempt_segment(
            &store,
            &recording_id,
            &cancelled_attempt,
            "cancelled-attempt-private-phrase",
        );
        store
            .record_transcription_failure(TranscriptionFailureDraft {
                recording_id: recording_id.clone(),
                engine: "whisper-rs".to_string(),
                model_id: Some("ggml-base.en.bin".to_string()),
                started_at_ms: now_ms(),
                elapsed_ms: 8,
                error_code: "TRANSCRIPTION_CANCELLED".to_string(),
                cancelled: true,
            })
            .expect("record cancelled attempt");

        let after = store
            .transcript(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read transcript after cancellation");
        assert_eq!(after["currentRevisionId"], before["currentRevisionId"]);
        assert_eq!(after["segments"], before["segments"]);
        let read = store
            .read(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read recording after cancellation");
        assert!(!serde_json::to_string(&read)
            .expect("serialize read")
            .contains("cancelled-attempt-private-phrase"));
        let history = store
            .trust_history(RecordingIdParams { recording_id })
            .expect("read trust history");
        assert_eq!(history["revisionCount"], 1);
        assert_eq!(history["receiptCount"], 2);
        assert_eq!(history["processingReceipts"][1]["outcome"], "cancelled");
        assert!(history["processingReceipts"][1]["revisionId"].is_null());
    }

    #[test]
    fn failed_final_commit_stays_invisible_and_later_success_is_initial() {
        let store = temp_store().with_failed_transcription_commit();
        let root = store.root.clone();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish recording");
        let failed_attempt = store
            .begin_transcription_attempt(&recording_id)
            .expect("begin commit-failing attempt");
        write_attempt_segment(
            &store,
            &recording_id,
            &failed_attempt,
            "history-commit-failed-private-phrase",
        );
        let error = complete_attempt(
            &store,
            &recording_id,
            &failed_attempt,
            "history-commit-failed-private-phrase",
        )
        .expect_err("final history commit must fail");
        assert_eq!(error.code, "TRANSCRIPTION_HISTORY_COMMIT_FAILED");
        let failed_dir = store
            .recording_dir(&recording_id)
            .expect("failed recording directory");
        assert!(fs::read_dir(&failed_dir)
            .expect("list failed recording files")
            .filter_map(Result::ok)
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .contains(RAW_TRANSCRIPT_FILE_MARKER)));
        store
            .record_transcription_failure(TranscriptionFailureDraft {
                recording_id: recording_id.clone(),
                engine: "whisper-rs".to_string(),
                model_id: Some("ggml-base.en.bin".to_string()),
                started_at_ms: now_ms(),
                elapsed_ms: 25,
                error_code: error.code.to_string(),
                cancelled: false,
            })
            .expect("record final commit failure");
        assert_eq!(
            store
                .transcript(RecordingIdParams {
                    recording_id: recording_id.clone(),
                })
                .expect("read after failed commit")["segmentCount"],
            0
        );

        let restarted = RecordingStore::with_root(root.clone());
        restarted.recover().expect("recover after failed commit");
        assert_eq!(
            restarted
                .transcript(RecordingIdParams {
                    recording_id: recording_id.clone(),
                })
                .expect("read after restart")["segmentCount"],
            0
        );
        let successful_attempt = restarted
            .begin_transcription_attempt(&recording_id)
            .expect("begin later successful attempt");
        write_attempt_segment(
            &restarted,
            &recording_id,
            &successful_attempt,
            "later committed transcript",
        );
        complete_attempt(
            &restarted,
            &recording_id,
            &successful_attempt,
            "later committed transcript",
        )
        .expect("commit later successful attempt");

        let history = restarted
            .trust_history(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read later trust history");
        assert_eq!(history["revisionCount"], 1);
        assert_eq!(history["revisions"][0]["source"], "initial");
        assert_eq!(history["processingReceipts"][0]["outcome"], "failed");
        assert_eq!(history["processingReceipts"][1]["outcome"], "succeeded");
        let transcript = restarted
            .transcript(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("read later transcript");
        assert_eq!(transcript["segmentCount"], 1);
        assert_eq!(
            transcript["segments"][0]["text"],
            "later committed transcript"
        );

        let restarted_again = RecordingStore::with_root(root);
        let transcript_after_restart = restarted_again
            .transcript(RecordingIdParams { recording_id })
            .expect("read committed transcript after second restart");
        assert_eq!(transcript_after_restart["segments"], transcript["segments"]);
    }

    #[test]
    fn processing_receipts_capture_failure_and_comparison_without_content_or_paths() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let index = write_segment(&store, &recording_id, "normalized");
        complete_revision(
            &store,
            &recording_id,
            vec![index],
            "initial",
            " normalized ",
            "normalized",
        );
        store
            .record_transcription_failure(TranscriptionFailureDraft {
                recording_id: recording_id.clone(),
                engine: "whisper-rs".to_string(),
                model_id: Some("ggml-base.en.bin".to_string()),
                started_at_ms: now_ms(),
                elapsed_ms: 42,
                error_code: "TRANSCRIPTION_ENGINE_FAILED".to_string(),
                cancelled: false,
            })
            .expect("record failed receipt");

        let history = store
            .trust_history(RecordingIdParams { recording_id })
            .expect("trust history");
        assert_eq!(history["revisionCount"], 1);
        assert_eq!(history["receiptCount"], 2);
        assert_eq!(history["revisions"][0]["comparison"]["changed"], true);
        assert_eq!(history["processingReceipts"][1]["outcome"], "failed");
        assert_eq!(
            history["processingReceipts"][1]["errorCode"],
            "TRANSCRIPTION_ENGINE_FAILED"
        );
        assert_eq!(history["rawPathExposed"], false);
        assert_eq!(history["keyMaterialExposedToRenderer"], false);
        let serialized = serde_json::to_string(&history).expect("serialize history");
        assert!(!serialized.contains(" normalized "));
        assert!(!serialized.contains("manifest.json"));
    }

    #[test]
    fn reprocessing_preparation_uses_original_audio_without_modifying_or_exposing_it() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .write_audio_chunk(WriteAudioChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_base64: BASE64_STANDARD.encode([0_u8, 0, 1, 0, 2, 0, 3, 0]),
                sample_rate_hz: 16_000,
                channel_count: 1,
                bits_per_sample: 16,
                start_ms: Some(0),
            })
            .expect("write original audio");
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish recording");
        let dir = store.recording_dir(&recording_id).expect("recording dir");
        let manifest = read_manifest(&dir).expect("manifest");
        let audio_file = dir.join(&manifest.chunks[0].file_name);
        let before = fs::read(&audio_file).expect("audio before");

        let prepared = store
            .prepare_reprocessing(ReprocessingPrepareParams {
                recording_id,
                channel: Some("mic".to_string()),
            })
            .expect("prepare reprocessing");
        assert_eq!(prepared["inputKind"], "originalDurableAudio");
        assert_eq!(prepared["audioChunkIndices"], json!([0]));
        assert_eq!(
            prepared["sourceAudioSha256"]
                .as_str()
                .expect("audio hash")
                .len(),
            64
        );
        assert_eq!(
            prepared["sourceAudioIntegrity"],
            "pending-background-content-hash-verification"
        );
        assert_eq!(prepared["originalAudioModified"], false);
        assert_eq!(prepared["rawPathExposed"], false);
        assert_eq!(prepared["keyMaterialExposedToRenderer"], false);
        assert_eq!(fs::read(audio_file).expect("audio after"), before);
    }

    #[test]
    fn default_reprocessing_and_transcription_include_every_audio_source() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        for (channel, start_ms, fill) in [("system", 25_u64, 2_u8), ("mic", 0, 1)] {
            store
                .write_audio_chunk(WriteAudioChunkParams {
                    recording_id: recording_id.clone(),
                    channel: channel.to_string(),
                    data_base64: BASE64_STANDARD.encode(vec![fill; 3_200]),
                    sample_rate_hz: 16_000,
                    channel_count: 1,
                    bits_per_sample: 16,
                    start_ms: Some(start_ms),
                })
                .expect("write source audio");
        }
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish recording");

        let prepared = store
            .prepare_reprocessing(ReprocessingPrepareParams {
                recording_id: recording_id.clone(),
                channel: None,
            })
            .expect("prepare combined reprocessing");
        assert_eq!(prepared["channel"], "combined");
        assert_eq!(prepared["audioChunkIndices"], json!([0, 1]));
        assert_eq!(prepared["audioChunkCount"], 2);
        assert_eq!(prepared["sampleRateHz"], 16_000);
        assert_eq!(prepared["channelCount"], 1);
        assert_eq!(prepared["bitsPerSample"], 16);
        assert_eq!(prepared["dispatchInput"]["channel"], "combined");
        assert_eq!(
            prepared["sourceAudioSha256"]
                .as_str()
                .expect("combined source digest")
                .len(),
            64
        );

        let tracks = store
            .pcm_tracks_for_transcription(&recording_id, None)
            .expect("default transcription tracks");
        assert_eq!(
            tracks
                .iter()
                .map(|track| track.channel.as_str())
                .collect::<Vec<_>>(),
            ["mic", "system"]
        );
        let mic_only = store
            .pcm_tracks_for_transcription(&recording_id, Some("mic"))
            .expect("explicit microphone track");
        assert_eq!(mic_only.len(), 1);
        assert_eq!(mic_only[0].channel, "mic");
    }

    #[test]
    fn legacy_reprocessing_plan_defers_audio_reads_to_the_background_job() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .write_audio_chunk(WriteAudioChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_base64: BASE64_STANDARD.encode([0_u8, 0, 1, 0]),
                sample_rate_hz: 16_000,
                channel_count: 1,
                bits_per_sample: 16,
                start_ms: Some(0),
            })
            .expect("write original audio");
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish recording");
        let dir = store.recording_dir(&recording_id).expect("recording dir");
        let mut manifest = read_manifest(&dir).expect("manifest");
        manifest.chunks[0].content_sha256 = None;
        let audio_path = dir.join(&manifest.chunks[0].file_name);
        write_manifest(&dir, &manifest).expect("write legacy manifest");
        let stored_len = fs::metadata(&audio_path).expect("audio metadata").len() as usize;
        fs::write(&audio_path, vec![0_u8; stored_len])
            .expect("corrupt payload without changing manifest-visible metadata");

        let prepared = store
            .prepare_reprocessing(ReprocessingPrepareParams {
                recording_id,
                channel: Some("mic".to_string()),
            })
            .expect("prepare metadata-only reprocessing");

        assert_eq!(prepared["sourceAudioSha256"], Value::Null);
        assert!(prepared["sourceAudioIntegrity"]
            .as_str()
            .is_some_and(|state| state.starts_with("pending-background-")));
    }

    #[test]
    fn fts_queries_are_literal_and_cannot_inject_match_operators() {
        assert_eq!(
            fts_literal_query("alpha\" OR *").expect("literal query"),
            "\"alpha\"\" OR *\""
        );
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "alpha private phrase".to_string(),
            })
            .expect("write searchable text");
        store
            .finish(RecordingIdParams { recording_id })
            .expect("finish recording");
        let result = wait_for_search(&store, "missing\" OR alpha");
        assert_eq!(result["matchCount"], 0);
        assert_eq!(result["plaintextIndexPersisted"], false);
    }

    #[test]
    fn trust_history_bounds_and_legacy_manifest_defaults_fail_safe() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        let oversized = store
            .complete_transcription_attempt(TranscriptionSuccessDraft {
                recording_id: recording_id.clone(),
                attempt_id: None,
                chunk_indices: vec![0; MAX_REVISION_CHUNK_INDICES + 1],
                engine: "whisper-rs".to_string(),
                model_id: None,
                model_sha256: None,
                started_at_ms: now_ms(),
                elapsed_ms: 1,
                comparison: comparison("", "", 0),
                raw_text: String::new(),
            })
            .expect_err("oversized history must fail");
        assert_eq!(oversized.code, "TRANSCRIPT_REVISION_TOO_LARGE");

        let dir = store.recording_dir(&recording_id).expect("recording dir");
        let manifest_path = dir.join(MANIFEST_FILE);
        let mut legacy: Value =
            serde_json::from_slice(&fs::read(&manifest_path).expect("read current manifest"))
                .expect("parse current manifest");
        legacy
            .as_object_mut()
            .expect("manifest object")
            .remove("transcriptRevisions");
        legacy
            .as_object_mut()
            .expect("manifest object")
            .remove("currentTranscriptRevisionId");
        legacy
            .as_object_mut()
            .expect("manifest object")
            .remove("processingReceipts");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&legacy).expect("serialize legacy manifest"),
        )
        .expect("write legacy manifest");
        let history = store
            .trust_history(RecordingIdParams { recording_id })
            .expect("read legacy history defaults");
        assert_eq!(history["revisionCount"], 0);
        assert_eq!(history["receiptCount"], 0);

        let query_error = store
            .search(SearchRecordingsParams {
                query: "x".repeat(201),
            })
            .expect_err("oversized query must fail");
        assert_eq!(query_error.code, "RECORDING_SEARCH_QUERY_INVALID");
    }

    #[cfg(not(feature = "sqlcipher-vault"))]
    #[test]
    fn search_without_sqlcipher_uses_bounded_nonpersistent_fallback() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "fallback search".to_string(),
            })
            .expect("write text");
        store
            .finish(RecordingIdParams { recording_id })
            .expect("finish");
        let result = store
            .search(SearchRecordingsParams {
                query: "fallback".to_string(),
            })
            .expect("fallback search");
        assert_eq!(result["searchBackend"], "bounded-scan");
        assert_eq!(result["encryptedIndex"], false);
        assert_eq!(result["plaintextIndexPersisted"], false);
        assert!(!store.root.join("search").exists());
    }

    #[test]
    fn read_only_search_includes_transcript_and_notes_without_mutating_source_state() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Budget review".to_string()),
            })
            .expect("start read-only search recording");
        let recording_id = recording_id(&started);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "Transcript budget decision".to_string(),
            })
            .expect("write searchable transcript");
        store
            .save_notes(SaveNotesParams {
                recording_id: recording_id.clone(),
                markdown: "Notes budget owner is Priya".to_string(),
            })
            .expect("write searchable notes");
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish read-only search recording");
        let recording_dir = store.recording_dir(&recording_id).expect("recording dir");
        let manifest_before = fs::read(recording_dir.join(MANIFEST_FILE)).expect("manifest before");

        let result = store
            .search_read_only(SearchRecordingsParams {
                query: "budget".to_string(),
            })
            .expect("read-only search");

        assert_eq!(result["searchBackend"], "bounded-read-only-source-scan");
        assert_eq!(result["matchCount"], 3);
        let row_kinds = result["matches"]
            .as_array()
            .expect("matches")
            .iter()
            .filter_map(|value| value["rowKind"].as_str())
            .collect::<HashSet<_>>();
        assert_eq!(
            row_kinds,
            HashSet::from(["meetingLabel", "originalTranscriptText", "notesMarkdown"])
        );
        assert_eq!(result["rawPathExposed"], false);
        assert_eq!(result["keyMaterialExposedToRenderer"], false);
        assert_eq!(
            fs::read(recording_dir.join(MANIFEST_FILE)).expect("manifest after"),
            manifest_before
        );
        assert!(!store.root.join(QUARANTINE_RECEIPTS_DIR).exists());
        #[cfg(feature = "sqlcipher-vault")]
        let _ = wait_for_search(&store, "budget");
    }

    #[test]
    fn read_only_search_does_not_create_a_missing_store_or_key() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!("candor-search-read-only-empty-{stamp}"));
        let store = RecordingStore::with_root(root.clone());

        let result = store
            .search_read_only(SearchRecordingsParams {
                query: "nothing".to_string(),
            })
            .expect("empty read-only search");

        assert_eq!(result["matchCount"], 0);
        assert!(!root.exists());
    }

    #[test]
    fn search_collection_and_plaintext_limits_truncate_before_unbounded_retention() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start bounded search recording");
        let recording_id = recording_id(&started);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "bounded plaintext".to_string(),
            })
            .expect("write bounded text");
        store
            .finish(RecordingIdParams { recording_id })
            .expect("finish bounded search recording");

        let (manifests, descriptor_truncated) = store
            .collect_search_manifests_bounded(10, 0, u64::MAX)
            .expect("collect with zero descriptor budget");
        assert!(descriptor_truncated);
        assert!(manifests.items.is_empty());

        let (manifests, manifest_truncated) = store
            .collect_search_manifests_bounded(10, 10, 1)
            .expect("collect with small manifest budget");
        assert!(manifest_truncated);
        assert!(manifests.items.is_empty());

        let (rows, quarantined, text_truncated) = store
            .searchable_text_rows_bounded(10, 10, u64::MAX, 10, 4, false)
            .expect("collect with small plaintext budget");
        assert!(text_truncated);
        assert_eq!(quarantined, 0);
        assert!(rows.is_empty());
    }

    #[test]
    fn bounded_search_collection_skips_an_oversized_manifest_and_keeps_later_meetings() {
        let store = temp_store();
        let mut recording_ids = [
            recording_id(
                &store
                    .start(StartRecordingParams { label: None })
                    .expect("start first bounded recording"),
            ),
            recording_id(
                &store
                    .start(StartRecordingParams { label: None })
                    .expect("start second bounded recording"),
            ),
        ];
        recording_ids.sort();
        for text in ["oversized one", "oversized two"] {
            store
                .write_text_chunk(WriteChunkParams {
                    recording_id: recording_ids[0].clone(),
                    channel: "mic".to_string(),
                    data_utf8: text.to_string(),
                })
                .expect("write oversized manifest chunk");
        }
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_ids[1].clone(),
                channel: "mic".to_string(),
                data_utf8: "later bounded meeting".to_string(),
            })
            .expect("write later bounded manifest chunk");

        let (collection, truncated) = store
            .collect_search_manifests_bounded(10, 1, u64::MAX)
            .expect("collect bounded manifests");
        assert!(truncated);
        assert_eq!(collection.items.len(), 1);
        assert_eq!(collection.items[0].0.recording_id, recording_ids[1]);
    }

    #[cfg(all(feature = "sqlcipher-vault", windows))]
    #[test]
    fn search_with_sqlcipher_uses_encrypted_fts5_without_path_or_key_exposure() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "encrypted full text search".to_string(),
            })
            .expect("write text");
        store
            .finish(RecordingIdParams { recording_id })
            .expect("finish");
        let result = wait_for_search(&store, "encrypted");
        assert_eq!(result["searchBackend"], "sqlcipher-fts5");
        assert_eq!(result["encryptedIndex"], true);
        assert_eq!(result["plaintextIndexPersisted"], false);
        assert_eq!(result["rawPathExposed"], false);
        assert_eq!(result["keyMaterialExposedToRenderer"], false);
        let serialized = serde_json::to_string(&result).expect("serialize result");
        assert!(!serialized.contains("trust-history.sqlcipher"));
        let search_path = store.root.join(TRUST_SEARCH_DIR).join(TRUST_SEARCH_FILE);
        let encrypted_bytes = fs::read(&search_path).expect("read encrypted search database");
        assert!(!encrypted_bytes.starts_with(b"SQLite format 3\0"));
        assert!(!encrypted_bytes
            .windows(b"encrypted full text search".len())
            .any(|window| window == b"encrypted full text search"));

        let wrong_key = Connection::open_with_flags(
            &search_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .expect("open encrypted database for wrong-key proof");
        wrong_key
            .pragma_update(None, "key", "0".repeat(64))
            .expect("apply wrong SQLCipher key");
        assert!(wrong_key
            .query_row("SELECT count(*) FROM sqlite_master", [], |row| row
                .get::<_, i64>(0))
            .is_err());

        let injected = wait_for_search(&store, "missing\" OR encrypted");
        assert_eq!(injected["searchBackend"], "sqlcipher-fts5");
        assert_eq!(injected["matchCount"], 0);
    }

    #[cfg(all(feature = "sqlcipher-vault", windows))]
    #[test]
    fn encrypted_search_rebuild_removes_owned_crash_sidecars() {
        let store = temp_store();
        let search_root = store.root.join(TRUST_SEARCH_DIR);
        fs::create_dir_all(&search_root).expect("create search root");
        let sidecars = [
            search_root.join(format!("{TRUST_SEARCH_FILE}.next")),
            search_root.join(format!("{TRUST_SEARCH_FILE}.next-journal")),
            search_root.join(format!("{TRUST_SEARCH_FILE}.next-wal")),
            search_root.join(format!("{TRUST_SEARCH_FILE}.next-shm")),
        ];
        for sidecar in &sidecars {
            fs::write(sidecar, b"interrupted temporary index").expect("seed crash sidecar");
        }

        assert!(store
            .rebuild_trust_search_index_once()
            .expect("rebuild encrypted search"));
        assert!(sidecars.iter().all(|sidecar| !sidecar.exists()));
        assert!(search_root.join(TRUST_SEARCH_FILE).is_file());
    }

    #[cfg(all(feature = "sqlcipher-vault", windows))]
    #[test]
    fn encrypted_search_rejects_live_and_dangling_temporary_symlinks() {
        use std::os::windows::fs::{symlink_dir, symlink_file};

        let store = temp_store();
        let search_root = store.root.join(TRUST_SEARCH_DIR);
        fs::create_dir_all(&search_root).expect("create search root");
        let target = search_root.join("outside-owned-temp.db");
        let link = search_root.join(format!("{TRUST_SEARCH_FILE}.next"));
        fs::write(&target, b"not an owned temporary index").expect("write symlink target");
        if symlink_file(&target, &link).is_err() {
            return;
        }
        let live_error = remove_owned_trust_search_files(std::slice::from_ref(&link))
            .expect_err("live temporary symlink must fail closed");
        assert_eq!(live_error.code, "TRUST_SEARCH_SYNC_FAILED");
        fs::remove_file(&link).expect("remove live symlink");
        fs::remove_file(&target).expect("remove symlink target");

        if symlink_file(&target, &link).is_err() {
            return;
        }
        let dangling_error = remove_owned_trust_search_files(std::slice::from_ref(&link))
            .expect_err("dangling temporary symlink must fail closed");
        assert_eq!(dangling_error.code, "TRUST_SEARCH_SYNC_FAILED");
        fs::remove_file(&link).expect("remove dangling symlink");

        let outside_directory = store.root.join("outside-search-directory");
        fs::create_dir_all(&outside_directory).expect("create outside directory");
        fs::remove_dir_all(&search_root).expect("remove owned search directory");
        if symlink_dir(&outside_directory, &search_root).is_err() {
            return;
        }
        fs::remove_dir_all(&outside_directory).expect("make search directory symlink dangling");
        let invalidate_error = store
            .invalidate_trust_search_index_unlocked()
            .expect_err("dangling search directory symlink must fail closed");
        assert_eq!(invalidate_error.code, "TRUST_SEARCH_INVALIDATE_FAILED");
        fs::remove_dir(&search_root).expect("remove dangling directory symlink");
    }

    #[cfg(all(feature = "sqlcipher-vault", windows))]
    #[test]
    fn encrypted_search_rebuilds_existing_index_after_restart_before_serving_results() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start restart search recording");
        let recording_id = recording_id(&started);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "restart freshness phrase".to_string(),
            })
            .expect("write restart search text");
        store
            .finish(RecordingIdParams { recording_id })
            .expect("finish restart search recording");
        assert_eq!(
            wait_for_search(&store, "restart freshness")["matchCount"],
            1
        );

        let restarted = RecordingStore::with_root(store.root.clone());
        let first = restarted
            .search(SearchRecordingsParams {
                query: "restart freshness".to_string(),
            })
            .expect_err("restart must not trust a prior process index generation");
        assert_eq!(first.code, "RECORDING_SEARCH_INDEX_BUILDING");
        assert_eq!(
            wait_for_search(&restarted, "restart freshness")["matchCount"],
            1
        );
    }

    fn wait_for_search(store: &RecordingStore, query: &str) -> Value {
        for _ in 0..400 {
            match store.search(SearchRecordingsParams {
                query: query.to_string(),
            }) {
                Ok(result) => return result,
                Err(error) if error.code == "RECORDING_SEARCH_INDEX_BUILDING" => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("encrypted search failed: {}: {}", error.code, error.message),
            }
        }
        panic!("encrypted search index did not become ready");
    }

    #[cfg(all(feature = "sqlcipher-vault", windows))]
    #[test]
    fn first_encrypted_search_reports_index_building_instead_of_zero_matches() {
        let store = temp_store();
        let error = store
            .search(SearchRecordingsParams {
                query: "first query".to_string(),
            })
            .expect_err("a missing encrypted index must be an explicit retry state");
        assert_eq!(error.code, "RECORDING_SEARCH_INDEX_BUILDING");
    }

    #[cfg(all(feature = "sqlcipher-vault", windows))]
    #[test]
    fn encrypted_search_surfaces_persistent_backfill_failure_and_recovers_after_source_change() {
        let store = temp_store();
        let search_root = store.root.join(TRUST_SEARCH_DIR);
        fs::create_dir_all(&store.root).expect("create test root");
        fs::write(&search_root, b"not an owned search directory")
            .expect("seed invalid search root");
        let initial = store
            .search(SearchRecordingsParams {
                query: "failure".to_string(),
            })
            .expect_err("first request schedules backfill");
        assert_eq!(initial.code, "RECORDING_SEARCH_INDEX_BUILDING");

        let failure = (0..400)
            .find_map(|_| {
                let error = store
                    .search(SearchRecordingsParams {
                        query: "failure".to_string(),
                    })
                    .expect_err("invalid search root cannot become ready");
                if error.code == "RECORDING_SEARCH_INDEX_BUILDING" {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    None
                } else {
                    Some(error)
                }
            })
            .expect("persistent backfill failure");
        assert_eq!(failure.code, "TRUST_SEARCH_BACKFILL_FAILED");
        let repeated = store
            .search(SearchRecordingsParams {
                query: "failure".to_string(),
            })
            .expect_err("stable failure must not reschedule forever");
        assert_eq!(repeated.code, "TRUST_SEARCH_BACKFILL_FAILED");
        assert!(!store.trust_search_backfill_running.load(Ordering::Acquire));

        fs::remove_file(&search_root).expect("remove invalid search root");
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start after repair");
        let recording_id = recording_id(&started);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "recovered encrypted search".to_string(),
            })
            .expect("write after repair");
        store
            .finish(RecordingIdParams { recording_id })
            .expect("finish after repair");
        assert_eq!(wait_for_search(&store, "recovered")["matchCount"], 1);
    }

    #[cfg(all(feature = "sqlcipher-vault", windows))]
    #[test]
    fn encrypted_search_returns_promptly_instead_of_waiting_for_backfill() {
        let store = temp_store();
        store
            .trust_search_index_generation
            .store(1, Ordering::Release);
        store
            .trust_search_source_generation
            .store(1, Ordering::Release);
        let search_guard = store
            .trust_search_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let started = std::time::Instant::now();
        let error = store
            .search(SearchRecordingsParams {
                query: "bounded".to_string(),
            })
            .expect_err("busy index must surface an explicit retry state");
        assert_eq!(error.code, "RECORDING_SEARCH_INDEX_BUILDING");
        assert!(started.elapsed() < std::time::Duration::from_millis(250));
        drop(search_guard);
    }

    #[cfg(all(feature = "sqlcipher-vault", windows))]
    #[test]
    fn encrypted_search_refreshes_selected_revision_and_recovery_state() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Revision search".to_string()),
            })
            .expect("start revision recording");
        let recording_id = recording_id(&started);
        let first_index = write_segment(&store, &recording_id, "first revision phrase");
        let first = complete_revision(
            &store,
            &recording_id,
            vec![first_index],
            "initial",
            "first revision phrase",
            "first revision phrase",
        );
        let first_revision_id = first["revisionId"]
            .as_str()
            .expect("first revision id")
            .to_string();
        let second_index = write_segment(&store, &recording_id, "second revision phrase");
        complete_revision(
            &store,
            &recording_id,
            vec![second_index],
            "reprocess",
            "second revision phrase",
            "second revision phrase",
        );
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish revision recording");
        assert_eq!(wait_for_search(&store, "second revision")["matchCount"], 1);
        assert_eq!(wait_for_search(&store, "first revision")["matchCount"], 0);

        store
            .select_transcript_revision(TranscriptRevisionParams {
                recording_id: recording_id.clone(),
                revision_id: first_revision_id,
            })
            .expect("select first revision");
        assert_eq!(wait_for_search(&store, "first revision")["matchCount"], 1);
        assert_eq!(wait_for_search(&store, "second revision")["matchCount"], 0);

        let dir = store.recording_dir(&recording_id).expect("recording dir");
        let mut manifest = read_manifest(&dir).expect("read manifest for recovery test");
        manifest.state = RecordingState::Recording;
        write_manifest(&dir, &manifest).expect("write interrupted state");
        store.recover().expect("recover interrupted recording");
        let recovered = wait_for_search(&store, "first revision");
        assert_eq!(recovered["matchCount"], 1);
        assert_eq!(recovered["matches"][0]["state"], "needsRecovery");
    }

    #[cfg(all(feature = "sqlcipher-vault", windows))]
    #[test]
    fn encrypted_search_refreshes_notes_and_deletion_without_stale_text() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Search freshness".to_string()),
            })
            .expect("start freshness recording");
        let recording_id = recording_id(&started);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "retained transcript phrase".to_string(),
            })
            .expect("write freshness transcript");
        store
            .save_notes(SaveNotesParams {
                recording_id: recording_id.clone(),
                markdown: "superseded private note".to_string(),
            })
            .expect("save first note");
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish freshness recording");
        assert_eq!(wait_for_search(&store, "superseded")["matchCount"], 1);

        store
            .save_notes(SaveNotesParams {
                recording_id: recording_id.clone(),
                markdown: "replacement local note".to_string(),
            })
            .expect("replace note");
        assert_eq!(wait_for_search(&store, "replacement")["matchCount"], 1);
        assert_eq!(wait_for_search(&store, "superseded")["matchCount"], 0);

        let maintenance_store = store.clone();
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let maintenance = std::thread::spawn(move || {
            let search_guard = maintenance_store
                .trust_search_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            locked_tx.send(()).expect("report held search lock");
            release_rx.recv().expect("release held search lock");
            drop(search_guard);
        });
        locked_rx.recv().expect("wait for held search lock");
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(25));
            release_tx.send(()).expect("release search maintenance");
        });
        let deleted = store
            .delete_finished(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("confirmed deletion waits for bounded search maintenance");
        release.join().expect("release thread");
        maintenance.join().expect("maintenance thread");
        assert_eq!(deleted["recordingDataRemoved"], true);
        assert_eq!(wait_for_search(&store, "replacement")["matchCount"], 0);
        assert_eq!(wait_for_search(&store, "retained")["matchCount"], 0);
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
        let search_root = store.root.join(TRUST_SEARCH_DIR);
        fs::create_dir_all(&search_root).expect("seed derived search directory");
        fs::write(
            search_root.join(TRUST_SEARCH_FILE),
            b"unique deleted meeting text retained by a stale index",
        )
        .expect("seed derived search index");

        let removed = store
            .delete_finished(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("remove recording data");

        assert_eq!(removed["state"], "metadataCleanupPending");
        assert_eq!(removed["recordingDataRemoved"], true);
        assert!(!active_dir.exists());
        assert!(!search_root.exists());
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
    fn deletion_fails_closed_when_derived_search_storage_cannot_be_invalidated() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams { label: None })
            .expect("start recording");
        let recording_id = recording_id(&started);
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish recording");
        let search_root = store.root.join(TRUST_SEARCH_DIR);
        fs::write(&search_root, b"not an owned search directory")
            .expect("seed invalid search target");

        let error = store
            .delete_finished(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect_err("delete must fail before content removal");

        assert_eq!(error.code, "TRUST_SEARCH_INVALIDATE_FAILED");
        assert!(store
            .recording_dir(&recording_id)
            .expect("recording directory")
            .is_dir());
    }

    #[cfg(all(feature = "sqlcipher-vault", windows))]
    #[test]
    fn confirmed_deletion_queues_after_bounded_search_wait_without_reconfirmation() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("Queued deletion".to_string()),
            })
            .expect("start queued deletion recording");
        let recording_id = recording_id(&started);
        store
            .write_text_chunk(WriteChunkParams {
                recording_id: recording_id.clone(),
                channel: "mic".to_string(),
                data_utf8: "queued deletion search text".to_string(),
            })
            .expect("write queued deletion text");
        store
            .finish(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("finish queued deletion recording");
        assert_eq!(wait_for_search(&store, "queued deletion")["matchCount"], 1);

        let maintenance_store = store.clone();
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let maintenance = std::thread::spawn(move || {
            let search_guard = maintenance_store
                .trust_search_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            locked_tx.send(()).expect("report held search lock");
            release_rx.recv().expect("release held search lock");
            drop(search_guard);
        });
        locked_rx.recv().expect("wait for held search lock");

        let started_wait = std::time::Instant::now();
        let queued = store
            .delete_finished(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("confirmed deletion is durably queued");
        assert_eq!(queued["state"], "deletionQueued");
        assert_eq!(queued["recordingDataRemoved"], false);
        assert_eq!(queued["confirmationRetained"], true);
        assert!(started_wait.elapsed() >= std::time::Duration::from_millis(900));
        assert!(store.deletion_pending(&recording_id));
        assert!(store
            .recording_dir(&recording_id)
            .expect("queued recording directory")
            .is_dir());

        release_tx.send(()).expect("release search maintenance");
        maintenance.join().expect("maintenance thread");
        let recovered = store.recover().expect("resume confirmed deletion");
        assert_eq!(recovered["completedDeletionCount"], 1);
        assert_eq!(recovered["completedDeletionIds"][0], recording_id);
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

        let search = wait_for_search(&store, "platform");
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
                    content_sha256: None,
                    speaker: None,
                    confidence: None,
                    sample_rate_hz: None,
                    channel_count: None,
                    bits_per_sample: None,
                    start_ms: None,
                    duration_ms: None,
                    transcription_attempt_id: None,
                    created_at_ms: now,
                }],
                privacy_events: Vec::new(),
                transcript_revisions: Vec::new(),
                current_transcript_revision_id: None,
                current_cleaned_revision_id: None,
                processing_receipts: Vec::new(),
                processing_profile: None,
            },
        )
        .expect("write unreadable manifest");

        let searched = wait_for_search(&store, "platform");

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

        let search = wait_for_search(&store, "M3 notes");
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
    fn ai_privacy_provenance_is_typed_and_discards_source_content() {
        let store = temp_store();
        let started = store
            .start(StartRecordingParams {
                label: Some("AI provenance".to_string()),
            })
            .expect("start provenance recording");
        let recording_id = recording_id(&started);
        store
            .record_ai_processing_fact(
                &recording_id,
                "local-ai-recap",
                &json!({
                    "engine": "local-llm",
                    "modelId": "qwen3-4b-q4-k-m",
                    "fallbackUsed": false,
                    "fallbackReason": null,
                    "promptVersion": "candor-grounded-v1",
                    "generatedAt": "2026-07-14T12:00:00Z",
                    "prompt": "sensitive prompt must not persist",
                    "transcript": "sensitive transcript must not persist"
                }),
            )
            .expect("record typed AI provenance");

        let receipt = store
            .privacy_receipt(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("privacy receipt");
        let provenance = &receipt["processing"][0]["aiProvenance"];
        assert_eq!(provenance["engine"], "local-llm");
        assert_eq!(provenance["modelId"], "qwen3-4b-q4-k-m");
        assert_eq!(provenance["fallbackUsed"], false);
        assert_eq!(provenance["promptVersion"], "candor-grounded-v1");
        let serialized = serde_json::to_string(&receipt).expect("serialize receipt");
        assert!(!serialized.contains("sensitive prompt"));
        assert!(!serialized.contains("sensitive transcript"));

        let error = store
            .record_ai_processing_fact(
                &recording_id,
                "local-ai-ask",
                &json!({
                    "engine": "local-llm",
                    "fallbackUsed": false,
                    "promptVersion": "candor-grounded-v1",
                    "generatedAt": "2026-07-14T12:00:00Z"
                }),
            )
            .expect_err("local LLM provenance requires a model id");
        assert_eq!(error.code, "PRIVACY_AI_PROVENANCE_INVALID");
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
        assert_eq!(upgraded["schemaVersion"], CURRENT_MANIFEST_SCHEMA_VERSION);
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
            manifest_mutation_lock: Arc::new(Mutex::new(())),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_lock: Arc::new(Mutex::new(())),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_source_generation: Arc::new(AtomicU64::new(1)),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_index_generation: Arc::new(AtomicU64::new(0)),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_backfill_running: Arc::new(AtomicBool::new(false)),
            #[cfg(feature = "sqlcipher-vault")]
            trust_search_backfill_failure: Arc::new(Mutex::new(None)),
            available_space_override: None,
            fail_space_probe: false,
            fail_tombstone_removal: false,
            fail_finish: false,
            fail_abort_unfinished: false,
            fail_transcription_commit: false,
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
