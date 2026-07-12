use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::recording_store::{
    RecordingIdParams, RecordingStore, RecordingStoreError, StartRecordingParams,
    WriteAudioChunkParams, WriteChunkParams, WriteTranscriptSegmentParams,
};

const MAX_MARKDOWN_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IMPORTED_AUDIO_BYTES: u64 = 250 * 1024 * 1024;
const IMPORT_AUDIO_CHUNK_BYTES: usize = 384 * 1024;

#[derive(Debug)]
pub struct V2ImportError {
    pub code: &'static str,
    pub message: String,
}

impl V2ImportError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<RecordingStoreError> for V2ImportError {
    fn from(error: RecordingStoreError) -> Self {
        Self::new(error.code, error.message)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ImportFolderParams {
    pub source_path: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct V2ImportProofParams {
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Clone, Debug)]
struct ParsedSegment {
    start_ms: u64,
    speaker: Option<String>,
    text: String,
}

#[derive(Debug)]
struct WavPcm16 {
    sample_rate_hz: u32,
    channel_count: u16,
    pcm: Vec<u8>,
}

#[derive(Default)]
pub struct V2Importer;

impl V2Importer {
    pub fn status(&self) -> Value {
        json!({
            "implemented": true,
            "localOnly": true,
            "cloudAi": false,
            "source": "v2-markdown-frontmatter",
            "importMethod": "native-folder-picker-main-process",
            "rendererRawPathAccess": false,
            "originalsUntouched": true,
            "markdownFrontmatter": true,
            "transcriptImport": true,
            "pcmWavAudioImport": true,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    pub fn import_folder(
        &self,
        store: &RecordingStore,
        params: V2ImportFolderParams,
    ) -> Result<Value, V2ImportError> {
        let source_root = canonical_dir(&params.source_path)?;
        import_folder_from_root(store, &source_root)
    }

    pub fn proof_synthetic(
        &self,
        store: &RecordingStore,
        params: V2ImportProofParams,
    ) -> Result<Value, V2ImportError> {
        let root = std::env::temp_dir().join(format!(
            "candor-v2-import-proof-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(root.join("audio"))
            .map_err(io_error("V2_IMPORT_FIXTURE_CREATE_FAILED"))?;
        let title = params
            .label
            .unwrap_or_else(|| "Imported v2 strategy sync".to_string());
        let wav = fixture_wav_pcm16();
        fs::write(root.join("audio").join("strategy.wav"), wav)
            .map_err(io_error("V2_IMPORT_FIXTURE_WRITE_FAILED"))?;
        fs::write(
            root.join("strategy-sync.md"),
            format!(
                "---\ntitle: {title}\naudio_path: audio/strategy.wav\n---\n\n# My notes\n\nKeep the M0 proof gate visible.\n\n# Transcript\n\n`00:00` [Alex] Decision: keep Electron behind the M0 network proof.\n`00:02` [Priya] Action: Priya to validate the import proof by Friday.\n"
            ),
        )
        .map_err(io_error("V2_IMPORT_FIXTURE_WRITE_FAILED"))?;

        let canonical_root =
            fs::canonicalize(&root).map_err(io_error("V2_IMPORT_FIXTURE_CREATE_FAILED"))?;
        let result = import_folder_from_root(store, &canonical_root);
        let _ = fs::remove_dir_all(&root);
        result
    }
}

fn import_folder_from_root(
    store: &RecordingStore,
    source_root: &Path,
) -> Result<Value, V2ImportError> {
    let markdown_files = markdown_files(source_root)?;
    let mut imported = Vec::<Value>::new();
    let mut skipped = Vec::<Value>::new();
    let mut audio_imported_count = 0_u64;
    let mut audio_skipped_count = 0_u64;

    for markdown_path in markdown_files {
        match import_markdown(store, source_root, &markdown_path) {
            Ok(result) => {
                if result
                    .get("audioImported")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    audio_imported_count += 1;
                } else if result
                    .get("audioSkipped")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    audio_skipped_count += 1;
                }
                imported.push(result);
            }
            Err(error) => skipped.push(json!({
                "sourceFileName": file_name(&markdown_path),
                "code": error.code,
                "message": error.message,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            })),
        }
    }

    Ok(json!({
        "implemented": true,
        "localOnly": true,
        "cloudAi": false,
        "originalsUntouched": true,
        "source": "v2-markdown-frontmatter",
        "markdownScannedCount": imported.len() + skipped.len(),
        "importedCount": imported.len(),
        "skippedCount": skipped.len(),
        "audioImportedCount": audio_imported_count,
        "audioSkippedCount": audio_skipped_count,
        "recordings": imported,
        "skipped": skipped,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    }))
}

fn import_markdown(
    store: &RecordingStore,
    source_root: &Path,
    markdown_path: &Path,
) -> Result<Value, V2ImportError> {
    let stat = fs::metadata(markdown_path).map_err(io_error("V2_IMPORT_MARKDOWN_READ_FAILED"))?;
    if !stat.is_file() || stat.len() > MAX_MARKDOWN_BYTES {
        return Err(V2ImportError::new(
            "V2_IMPORT_MARKDOWN_INVALID",
            "markdown source must be a file below the import size limit",
        ));
    }
    let raw =
        fs::read_to_string(markdown_path).map_err(io_error("V2_IMPORT_MARKDOWN_READ_FAILED"))?;
    let (meta, body) = parse_frontmatter(&raw);
    let title = title_from_markdown(&meta, &body, markdown_path);
    let segments = parse_transcript(&body);
    let notes = parse_notes(&body);
    let started = store.start(StartRecordingParams {
        label: Some(title.clone()),
    })?;
    let recording_id = started["recordingId"]
        .as_str()
        .ok_or_else(|| {
            V2ImportError::new(
                "V2_IMPORT_RECORDING_ID_MISSING",
                "recording start did not return an id",
            )
        })?
        .to_string();

    if !notes.trim().is_empty() {
        store.write_text_chunk(WriteChunkParams {
            recording_id: recording_id.clone(),
            channel: "notes".to_string(),
            data_utf8: notes,
        })?;
    }

    write_segments(store, &recording_id, &segments)?;

    let mut audio_imported = false;
    let mut audio_skipped = false;
    let mut audio_skip_reason = None::<String>;
    if let Some(audio_value) = meta
        .get("audio_path")
        .filter(|value| !value.trim().is_empty())
    {
        match resolve_source_child(
            source_root,
            markdown_path.parent().unwrap_or(source_root),
            audio_value,
        ) {
            Ok(audio_path) => match import_wav_audio(store, &recording_id, &audio_path) {
                Ok(()) => audio_imported = true,
                Err(error) => {
                    audio_skipped = true;
                    audio_skip_reason = Some(error.message);
                }
            },
            Err(error) => {
                audio_skipped = true;
                audio_skip_reason = Some(error.message);
            }
        }
    }

    let finished = store.finish(RecordingIdParams {
        recording_id: recording_id.clone(),
    })?;

    Ok(json!({
        "recordingId": recording_id,
        "label": title,
        "sourceFileName": file_name(markdown_path),
        "transcriptSegmentCount": segments.len(),
        "audioImported": audio_imported,
        "audioSkipped": audio_skipped,
        "audioSkipReason": audio_skip_reason,
        "recording": finished,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    }))
}

fn write_segments(
    store: &RecordingStore,
    recording_id: &str,
    segments: &[ParsedSegment],
) -> Result<(), V2ImportError> {
    for (index, segment) in segments.iter().enumerate() {
        let next_start = segments.get(index + 1).map(|next| next.start_ms);
        let duration = next_start
            .and_then(|next| next.checked_sub(segment.start_ms))
            .filter(|duration| *duration > 0)
            .unwrap_or(1_500)
            .min(60 * 60 * 1000);
        store.write_transcript_segment(WriteTranscriptSegmentParams {
            recording_id: recording_id.to_string(),
            channel: channel_for_speaker(segment.speaker.as_deref()).to_string(),
            speaker: segment.speaker.clone(),
            text: segment.text.clone(),
            start_ms: segment.start_ms,
            duration_ms: Some(duration),
            end_ms: None,
            confidence: None,
        })?;
    }
    Ok(())
}

fn import_wav_audio(
    store: &RecordingStore,
    recording_id: &str,
    audio_path: &Path,
) -> Result<(), V2ImportError> {
    let stat = fs::metadata(audio_path).map_err(io_error("V2_IMPORT_AUDIO_READ_FAILED"))?;
    if !stat.is_file() || stat.len() > MAX_IMPORTED_AUDIO_BYTES {
        return Err(V2ImportError::new(
            "V2_IMPORT_AUDIO_INVALID",
            "audio source must be a file below the import size limit",
        ));
    }
    let bytes = fs::read(audio_path).map_err(io_error("V2_IMPORT_AUDIO_READ_FAILED"))?;
    let wav = parse_wav_pcm16(&bytes)?;
    let frame_bytes = usize::from(wav.channel_count) * 2;
    let chunk_bytes = IMPORT_AUDIO_CHUNK_BYTES - (IMPORT_AUDIO_CHUNK_BYTES % frame_bytes);
    let mut start_ms = 0_u64;
    for chunk in wav.pcm.chunks(chunk_bytes.max(frame_bytes)) {
        if chunk.is_empty() {
            continue;
        }
        store.write_audio_chunk(WriteAudioChunkParams {
            recording_id: recording_id.to_string(),
            channel: "imported".to_string(),
            data_base64: BASE64_STANDARD.encode(chunk),
            sample_rate_hz: wav.sample_rate_hz,
            channel_count: wav.channel_count,
            bits_per_sample: 16,
            start_ms: Some(start_ms),
        })?;
        start_ms = start_ms.saturating_add(audio_duration_ms(
            chunk.len() as u64,
            wav.sample_rate_hz,
            wav.channel_count,
        ));
    }
    Ok(())
}

fn parse_frontmatter(raw: &str) -> (BTreeMap<String, String>, String) {
    let normalized = raw.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return (BTreeMap::new(), normalized);
    };
    let Some(end) = rest.find("\n---\n") else {
        return (BTreeMap::new(), normalized);
    };
    let mut meta = BTreeMap::new();
    for line in rest[..end].lines() {
        if let Some((key, value)) = line.split_once(':') {
            meta.insert(key.trim().to_ascii_lowercase(), clean_meta_value(value));
        }
    }
    (meta, rest[end + 5..].to_string())
}

fn parse_transcript(body: &str) -> Vec<ParsedSegment> {
    let mut segments = Vec::new();
    let mut in_transcript = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') && trimmed.to_ascii_lowercase().contains("transcript") {
            in_transcript = true;
            continue;
        }
        if in_transcript && trimmed.starts_with('#') {
            break;
        }
        if !in_transcript {
            continue;
        }
        if let Some(segment) = parse_transcript_line(trimmed) {
            segments.push(segment);
        }
    }
    segments
}

fn parse_transcript_line(line: &str) -> Option<ParsedSegment> {
    let rest = line.strip_prefix('`')?;
    let (time, text) = rest.split_once('`')?;
    let start_ms = parse_time_ms(time.trim())?;
    let text = text.trim().trim_start_matches('-').trim();
    if text.is_empty() {
        return None;
    }
    let (speaker, text) = if let Some(stripped) = text.strip_prefix('[') {
        if let Some((speaker, rest)) = stripped.split_once("] ") {
            (Some(speaker.trim().to_string()), rest.trim().to_string())
        } else {
            (None, text.to_string())
        }
    } else {
        (None, text.to_string())
    };
    if text.is_empty() {
        None
    } else {
        Some(ParsedSegment {
            start_ms,
            speaker,
            text,
        })
    }
}

fn parse_notes(body: &str) -> String {
    let mut notes = String::new();
    let mut in_notes = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') && trimmed.to_ascii_lowercase().contains("my notes") {
            in_notes = true;
            continue;
        }
        if in_notes && trimmed.starts_with('#') {
            break;
        }
        if in_notes {
            notes.push_str(line);
            notes.push('\n');
        }
    }
    notes.trim().to_string()
}

fn title_from_markdown(meta: &BTreeMap<String, String>, body: &str, path: &Path) -> String {
    if let Some(title) = meta.get("title").filter(|value| !value.trim().is_empty()) {
        return title.chars().take(120).collect();
    }
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(title) = trimmed.strip_prefix("# ") {
            let title = title.trim();
            if !title.is_empty() {
                return title.chars().take(120).collect();
            }
        }
    }
    path.file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Imported v2 meeting")
        .chars()
        .take(120)
        .collect()
}

fn markdown_files(root: &Path) -> Result<Vec<PathBuf>, V2ImportError> {
    let mut files = Vec::<PathBuf>::new();
    collect_markdown_files(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_markdown_files(root: &Path, files: &mut Vec<PathBuf>) -> Result<(), V2ImportError> {
    for entry in fs::read_dir(root).map_err(io_error("V2_IMPORT_SOURCE_READ_FAILED"))? {
        let entry = entry.map_err(io_error("V2_IMPORT_SOURCE_READ_FAILED"))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(io_error("V2_IMPORT_SOURCE_READ_FAILED"))?;
        if metadata.is_dir() {
            collect_markdown_files(&path, files)?;
        } else if metadata.is_file()
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            files.push(path);
        }
    }
    Ok(())
}

fn canonical_dir(value: &str) -> Result<PathBuf, V2ImportError> {
    let path = PathBuf::from(value);
    let canonical = fs::canonicalize(path).map_err(io_error("V2_IMPORT_SOURCE_INVALID"))?;
    if !canonical.is_dir() {
        return Err(V2ImportError::new(
            "V2_IMPORT_SOURCE_INVALID",
            "import source must be a folder",
        ));
    }
    Ok(canonical)
}

fn resolve_source_child(
    source_root: &Path,
    markdown_dir: &Path,
    value: &str,
) -> Result<PathBuf, V2ImportError> {
    if value.contains("://") {
        return Err(V2ImportError::new(
            "V2_IMPORT_AUDIO_UNSUPPORTED",
            "remote audio references are not imported",
        ));
    }
    let relative = PathBuf::from(value);
    if relative.is_absolute() {
        return Err(V2ImportError::new(
            "V2_IMPORT_AUDIO_UNSUPPORTED",
            "absolute audio paths are not imported from v2 notes",
        ));
    }
    let candidate = markdown_dir.join(&relative);
    let canonical = fs::canonicalize(&candidate)
        .or_else(|_| fs::canonicalize(source_root.join(&relative)))
        .map_err(io_error("V2_IMPORT_AUDIO_READ_FAILED"))?;
    if !canonical.starts_with(source_root) {
        return Err(V2ImportError::new(
            "V2_IMPORT_AUDIO_OUTSIDE_SOURCE",
            "audio import is constrained to the selected source folder",
        ));
    }
    Ok(canonical)
}

fn parse_wav_pcm16(bytes: &[u8]) -> Result<WavPcm16, V2ImportError> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(V2ImportError::new(
            "V2_IMPORT_AUDIO_UNSUPPORTED",
            "only RIFF WAVE PCM audio is imported",
        ));
    }
    let mut offset = 12_usize;
    let mut format = None::<(u16, u16, u32, u16)>;
    let mut data = None::<Vec<u8>>;
    while offset.saturating_add(8) <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        offset += 8;
        if offset.saturating_add(size) > bytes.len() {
            break;
        }
        if id == b"fmt " && size >= 16 {
            let audio_format = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
            let channel_count = u16::from_le_bytes([bytes[offset + 2], bytes[offset + 3]]);
            let sample_rate_hz = u32::from_le_bytes([
                bytes[offset + 4],
                bytes[offset + 5],
                bytes[offset + 6],
                bytes[offset + 7],
            ]);
            let bits_per_sample = u16::from_le_bytes([bytes[offset + 14], bytes[offset + 15]]);
            format = Some((audio_format, channel_count, sample_rate_hz, bits_per_sample));
        } else if id == b"data" {
            data = Some(bytes[offset..offset + size].to_vec());
        }
        offset += size + (size % 2);
    }
    let Some((audio_format, channel_count, sample_rate_hz, bits_per_sample)) = format else {
        return Err(V2ImportError::new(
            "V2_IMPORT_AUDIO_UNSUPPORTED",
            "WAV format chunk was not found",
        ));
    };
    if audio_format != 1 || bits_per_sample != 16 || channel_count == 0 || channel_count > 2 {
        return Err(V2ImportError::new(
            "V2_IMPORT_AUDIO_UNSUPPORTED",
            "only 16-bit mono or stereo PCM WAV audio is imported",
        ));
    }
    let Some(pcm) = data.filter(|value| !value.is_empty()) else {
        return Err(V2ImportError::new(
            "V2_IMPORT_AUDIO_UNSUPPORTED",
            "WAV data chunk was not found",
        ));
    };
    Ok(WavPcm16 {
        sample_rate_hz,
        channel_count,
        pcm,
    })
}

fn parse_time_ms(value: &str) -> Option<u64> {
    let parts = value.split(':').collect::<Vec<_>>();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [minutes, seconds] => (0_u64, minutes.parse().ok()?, parse_seconds_ms(seconds)?),
        [hours, minutes, seconds] => (
            hours.parse().ok()?,
            minutes.parse().ok()?,
            parse_seconds_ms(seconds)?,
        ),
        [seconds] => (0_u64, 0_u64, parse_seconds_ms(seconds)?),
        _ => return None,
    };
    Some(
        hours
            .saturating_mul(3_600_000)
            .saturating_add(minutes.saturating_mul(60_000))
            .saturating_add(seconds),
    )
}

fn parse_seconds_ms(value: &str) -> Option<u64> {
    if let Some((seconds, millis)) = value.split_once('.') {
        let seconds = seconds.parse::<u64>().ok()?.saturating_mul(1000);
        let millis = millis
            .chars()
            .take(3)
            .collect::<String>()
            .parse::<u64>()
            .ok()
            .unwrap_or_default();
        Some(seconds.saturating_add(millis))
    } else {
        value
            .parse::<u64>()
            .ok()
            .map(|seconds| seconds.saturating_mul(1000))
    }
}

fn audio_duration_ms(bytes: u64, sample_rate_hz: u32, channel_count: u16) -> u64 {
    let frame_bytes = u64::from(channel_count).saturating_mul(2).max(1);
    let frames = bytes / frame_bytes;
    frames.saturating_mul(1000) / u64::from(sample_rate_hz).max(1)
}

fn channel_for_speaker(speaker: Option<&str>) -> &'static str {
    let Some(speaker) = speaker else {
        return "system";
    };
    let lower = speaker.to_ascii_lowercase();
    if lower == "me" || lower == "alex" || lower == "user" {
        "mic"
    } else {
        "system"
    }
}

fn clean_meta_value(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_string()
}

fn fixture_wav_pcm16() -> Vec<u8> {
    let sample_rate = 16_000_u32;
    let channel_count = 1_u16;
    let bits_per_sample = 16_u16;
    let pcm = vec![0_u8; sample_rate as usize * 2 / 10];
    let data_len = pcm.len() as u32;
    let byte_rate = sample_rate * u32::from(channel_count) * u32::from(bits_per_sample) / 8;
    let block_align = channel_count * bits_per_sample / 8;
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&channel_count.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(&pcm);
    wav
}

fn io_error(code: &'static str) -> impl Fn(std::io::Error) -> V2ImportError {
    move |err| V2ImportError::new(code, err.to_string())
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording_store::RecordingStore;

    fn store() -> RecordingStore {
        let root = std::env::temp_dir().join(format!(
            "candor-v2-import-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        RecordingStore::with_root(root)
    }

    #[test]
    fn imports_synthetic_v2_markdown_without_paths() {
        let store = store();
        let importer = V2Importer;
        let result = importer
            .proof_synthetic(&store, V2ImportProofParams::default())
            .expect("proof import");

        assert_eq!(result["localOnly"], true);
        assert_eq!(result["originalsUntouched"], true);
        assert_eq!(result["importedCount"], 1);
        assert_eq!(result["audioImportedCount"], 1);
        assert_eq!(result["rawPathExposed"], false);
        assert_eq!(result["keyMaterialExposedToRenderer"], false);
        assert!(result["recordings"][0]["recordingId"].as_str().is_some());
        assert_eq!(result["recordings"][0]["transcriptSegmentCount"], 2);
    }
}
