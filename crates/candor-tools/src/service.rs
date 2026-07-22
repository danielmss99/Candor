use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::{Backend, MAX_TOOL_RESULT_BYTES};

const DEFAULT_LIMIT: u64 = 20;
const MAX_LIST_LIMIT: u64 = 50;
const MAX_TRANSCRIPT_LIMIT: u64 = 50;
const MAX_SEARCH_LIMIT: u64 = 25;
const MAX_CURSOR: u64 = 1_000_000;
const MAX_SUMMARY_SCAN_MEETINGS: u64 = 2_000;
const MAX_STATS_SCAN_MEETINGS: u64 = 2_000;
const CORE_PAGE_LIMIT: u64 = MAX_LIST_LIMIT;
const MAX_QUERY_BYTES: usize = 200;
const MAX_TEXT_BYTES: usize = 2_048;
const MAX_SNIPPET_BYTES: usize = 512;
const MAX_EXPORT_BYTES: usize = 96 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

impl ToolError {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new("INPUT_INVALID", message, false)
    }

    pub(crate) fn denied(message: impl Into<String>) -> Self {
        Self::new("OPERATION_DENIED", message, false)
    }

    pub(crate) fn unavailable(message: impl Into<String>) -> Self {
        Self::new("CORE_UNAVAILABLE", message, true)
    }

    pub(crate) fn core_timeout() -> Self {
        Self::new(
            "CORE_RESPONSE_TIMEOUT",
            "Candor core did not respond within the bounded local timeout",
            true,
        )
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL_ERROR", message, false)
    }

    pub(crate) fn core(code: &str, retryable: bool) -> Self {
        Self::new(
            code,
            "Candor core rejected the bounded read-only request",
            retryable,
        )
    }

    fn not_found() -> Self {
        Self::new(
            "MEETING_NOT_FOUND",
            "The meeting was not found within the bounded local library scan",
            false,
        )
    }

    fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
            raw_path_exposed: false,
            key_material_exposed_to_renderer: false,
        }
    }
}

pub struct AutomationService<B: Backend> {
    backend: B,
}

impl<B: Backend> AutomationService<B> {
    pub fn new(backend: B) -> Self {
        Self { backend }
    }

    pub fn invoke(&mut self, tool: &str, arguments: Value) -> Result<Value, ToolError> {
        let result = match tool {
            "list_meetings" => self.list_meetings(arguments),
            "search_meetings" => self.search_meetings(arguments),
            "meeting_summary" => self.meeting_summary_tool(arguments),
            "get_transcript" => self.get_transcript(arguments),
            "export_meeting" => self.export_meeting(arguments),
            "library_statistics" => self.library_statistics(arguments),
            _ => Err(ToolError::denied("Tool is not on the read-only allowlist")),
        }?;
        let encoded = serde_json::to_vec(&result)
            .map_err(|_| ToolError::internal("Could not encode the tool result"))?;
        if encoded.len() > MAX_TOOL_RESULT_BYTES {
            return Err(ToolError::internal(
                "Tool result exceeded the bounded output limit; request a smaller page",
            ));
        }
        Ok(result)
    }

    pub fn into_backend(self) -> B {
        self.backend
    }

    fn list_meetings(&mut self, arguments: Value) -> Result<Value, ToolError> {
        let object = object_args(&arguments, &["cursor", "limit"])?;
        let offset = cursor_arg(object, "cursor", 0, MAX_CURSOR)?;
        let limit = limit_arg(object, MAX_LIST_LIMIT)?;
        let result = self.backend.call(
            "recording.durable.listPage",
            json!({ "offset": offset, "limit": limit }),
        )?;
        let meetings = result
            .get("recordings")
            .and_then(Value::as_array)
            .ok_or_else(|| ToolError::unavailable("Candor core returned an invalid meeting page"))?
            .iter()
            .filter_map(sanitize_summary)
            .collect::<Vec<_>>();
        let has_more = bool_field(&result, "hasMore");
        let next_offset = offset.saturating_add(meetings.len() as u64);
        Ok(private(json!({
            "meetings": meetings,
            "count": meetings.len(),
            "totalCount": u64_field(&result, "totalCount"),
            "totalCountExact": bool_field(&result, "totalCountExact"),
            "cursor": offset.to_string(),
            "nextCursor": has_more.then(|| next_offset.to_string()),
            "hasMore": has_more,
            "sourceTruncated": bool_field(&result, "sourceTruncated")
        })))
    }

    fn search_meetings(&mut self, arguments: Value) -> Result<Value, ToolError> {
        let object = object_args(&arguments, &["query", "cursor", "limit"])?;
        let query = required_string(object, "query", MAX_QUERY_BYTES)?;
        if query.trim().is_empty() {
            return Err(ToolError::invalid("query must not be empty"));
        }
        let query = query.trim().to_string();
        let offset = cursor_arg(object, "cursor", 0, 500)?;
        let limit = limit_arg_with_default(object, MAX_SEARCH_LIMIT, 10)?;
        let result = self
            .backend
            .call("recording.durable.search", json!({ "query": query }))?;
        let source_matches = result
            .get("matches")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ToolError::unavailable("Candor core returned an invalid search result")
            })?;
        let source_overflow = source_matches.len() > 501;
        let mut skipped_matches = 0_u64;
        let all_matches = source_matches
            .iter()
            .take(501)
            .filter_map(|value| match sanitize_search_match(value) {
                Some(value) => Some(value),
                None => {
                    skipped_matches = skipped_matches.saturating_add(1);
                    None
                }
            })
            .collect::<Vec<_>>();

        let start = offset as usize;
        let end = start.saturating_add(limit as usize).min(all_matches.len());
        let matches = if start < all_matches.len() {
            all_matches[start..end].to_vec()
        } else {
            Vec::new()
        };
        let has_more = all_matches.len() > end;
        let source_truncated = bool_field(&result, "truncated") || source_overflow;
        let search_backend = optional_safe_string(result.get("searchBackend"), 64)
            .unwrap_or_else(|| "unknown".to_string());
        Ok(private(json!({
            "query": query,
            "matches": matches,
            "count": matches.len(),
            "cursor": offset.to_string(),
            "nextCursor": has_more.then(|| end.to_string()),
            "hasMore": has_more,
            "scan": {
                "bounded": true,
                "partial": source_truncated || skipped_matches > 0,
                "source": "core-trust-history",
                "searchBackend": search_backend,
                "encryptedIndex": bool_field(&result, "encryptedIndex"),
                "plaintextIndexPersisted": bool_field(&result, "plaintextIndexPersisted"),
                "quarantinedCount": u64_field(&result, "quarantinedCount"),
                "skippedMatches": skipped_matches
            }
        })))
    }

    fn meeting_summary_tool(&mut self, arguments: Value) -> Result<Value, ToolError> {
        let object = object_args(&arguments, &["recordingId"])?;
        let recording_id = recording_id_arg(object)?;
        self.find_summary(&recording_id)
    }

    fn get_transcript(&mut self, arguments: Value) -> Result<Value, ToolError> {
        let object = object_args(&arguments, &["recordingId", "cursor", "limit"])?;
        let recording_id = recording_id_arg(object)?;
        let offset = cursor_arg(object, "cursor", 0, MAX_CURSOR)?;
        let limit = limit_arg(object, MAX_TRANSCRIPT_LIMIT)?;
        let result = self.backend.call(
            "recording.durable.transcriptPage",
            json!({ "recordingId": recording_id, "offset": offset, "limit": limit }),
        )?;
        let segments = result
            .get("segments")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ToolError::unavailable("Candor core returned an invalid transcript page")
            })?
            .iter()
            .filter_map(sanitize_segment)
            .collect::<Vec<_>>();
        let has_more = bool_field(&result, "hasMore");
        let next_offset = offset.saturating_add(segments.len() as u64);
        Ok(private(json!({
            "recordingId": recording_id,
            "label": optional_safe_string(result.get("label"), 256),
            "state": safe_enum(result.get("state"), &["recording", "needsRecovery", "finished"]),
            "durationMs": u64_field(&result, "durationMs"),
            "segmentCount": u64_field(&result, "segmentCount"),
            "segments": segments,
            "count": segments.len(),
            "cursor": offset.to_string(),
            "nextCursor": has_more.then(|| next_offset.to_string()),
            "hasMore": has_more,
            "textTruncatedPerSegment": true
        })))
    }

    fn export_meeting(&mut self, arguments: Value) -> Result<Value, ToolError> {
        let object = object_args(&arguments, &["recordingId", "cursor", "limit", "format"])?;
        let recording_id = recording_id_arg(object)?;
        let format =
            optional_string(object, "format", 16)?.unwrap_or_else(|| "markdown".to_string());
        if format != "markdown" && format != "text" {
            return Err(ToolError::invalid(
                "format must be markdown or text; binary exports are not exposed",
            ));
        }
        let offset = cursor_arg(object, "cursor", 0, MAX_CURSOR)?;
        let limit = limit_arg(object, MAX_TRANSCRIPT_LIMIT)?;
        let summary = self.find_summary(&recording_id)?;
        let transcript = self.get_transcript(json!({
            "recordingId": recording_id,
            "cursor": offset.to_string(),
            "limit": limit
        }))?;

        let title = summary
            .get("label")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("Untitled meeting");
        let mut content = String::new();
        if format == "markdown" {
            append_bounded(
                &mut content,
                &format!("# {}\n\n", one_line(title)),
                MAX_EXPORT_BYTES,
            );
            append_bounded(
                &mut content,
                &format!("Recording ID: `{}`\n\n## Transcript\n\n", recording_id),
                MAX_EXPORT_BYTES,
            );
        } else {
            append_bounded(
                &mut content,
                &format!("{}\n\n", one_line(title)),
                MAX_EXPORT_BYTES,
            );
        }
        let segments = transcript
            .get("segments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut included = 0_u64;
        let mut content_truncated = false;
        for segment in segments {
            let start_ms = u64_field(&segment, "startMs");
            let timestamp = format_timestamp(start_ms);
            let speaker = segment
                .get("speaker")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let text = segment
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let line = match (format.as_str(), speaker) {
                ("markdown", Some(speaker)) => {
                    format!("- **{} {}:** {}\n", timestamp, one_line(speaker), text)
                }
                ("markdown", None) => format!("- **{}:** {}\n", timestamp, text),
                (_, Some(speaker)) => format!("{} {}: {}\n", timestamp, one_line(speaker), text),
                (_, None) => format!("{} {}\n", timestamp, text),
            };
            if !append_bounded(&mut content, &line, MAX_EXPORT_BYTES) {
                content_truncated = true;
                break;
            }
            included += 1;
        }
        let source_has_more = bool_field(&transcript, "hasMore");
        let has_more = source_has_more || content_truncated;
        let next_cursor = has_more.then(|| offset.saturating_add(included).to_string());
        Ok(private(json!({
            "recordingId": recording_id,
            "format": format,
            "content": content,
            "bytes": content.len(),
            "segmentsIncluded": included,
            "cursor": offset.to_string(),
            "nextCursor": next_cursor,
            "hasMore": has_more,
            "truncated": content_truncated,
            "destination": "stdout-only"
        })))
    }

    fn library_statistics(&mut self, arguments: Value) -> Result<Value, ToolError> {
        let object = object_args(&arguments, &[])?;
        if !object.is_empty() {
            return Err(ToolError::invalid(
                "library_statistics accepts no arguments",
            ));
        }
        let mut offset = 0_u64;
        let mut scanned = 0_u64;
        let mut total_count = 0_u64;
        let mut total_audio_duration_ms = 0_u64;
        let mut total_stored_bytes = 0_u64;
        let mut encrypted_count = 0_u64;
        let mut transcript_segment_count = 0_u64;
        let mut states = BTreeMap::<String, u64>::new();
        let mut has_more = false;

        while scanned < MAX_STATS_SCAN_MEETINGS {
            let limit = (MAX_STATS_SCAN_MEETINGS - scanned).min(CORE_PAGE_LIMIT);
            let page = self.backend.call(
                "recording.durable.listPage",
                json!({ "offset": offset, "limit": limit }),
            )?;
            total_count = u64_field(&page, "totalCount");
            let rows = page
                .get("recordings")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ToolError::unavailable("Candor core returned an invalid meeting page")
                })?;
            if rows.is_empty() {
                has_more = false;
                break;
            }
            for row in rows {
                scanned += 1;
                offset += 1;
                total_audio_duration_ms =
                    total_audio_duration_ms.saturating_add(u64_field(row, "audioDurationMs"));
                total_stored_bytes =
                    total_stored_bytes.saturating_add(u64_field(row, "storedBytes"));
                transcript_segment_count = transcript_segment_count
                    .saturating_add(u64_field(row, "transcriptSegmentCount"));
                if bool_field(row, "encryptedAtRest") {
                    encrypted_count += 1;
                }
                let state = safe_enum(
                    row.get("state"),
                    &["recording", "needsRecovery", "finished"],
                );
                *states.entry(state).or_default() += 1;
            }
            has_more = bool_field(&page, "hasMore");
            if !has_more {
                break;
            }
        }
        Ok(private(json!({
            "totalMeetingCount": total_count,
            "meetingsScanned": scanned,
            "partial": has_more,
            "scanLimit": MAX_STATS_SCAN_MEETINGS,
            "totalAudioDurationMs": total_audio_duration_ms,
            "totalStoredBytes": total_stored_bytes,
            "transcriptSegmentCount": transcript_segment_count,
            "encryptedAtRestMeetingCount": encrypted_count,
            "states": states
        })))
    }

    fn find_summary(&mut self, recording_id: &str) -> Result<Value, ToolError> {
        let mut offset = 0_u64;
        while offset < MAX_SUMMARY_SCAN_MEETINGS {
            let limit = (MAX_SUMMARY_SCAN_MEETINGS - offset).min(CORE_PAGE_LIMIT);
            let page = self.backend.call(
                "recording.durable.listPage",
                json!({ "offset": offset, "limit": limit }),
            )?;
            let rows = page
                .get("recordings")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ToolError::unavailable("Candor core returned an invalid meeting page")
                })?;
            for row in rows {
                if row.get("recordingId").and_then(Value::as_str) == Some(recording_id) {
                    return sanitize_summary(row)
                        .map(private)
                        .ok_or_else(ToolError::not_found);
                }
            }
            offset = offset.saturating_add(rows.len() as u64);
            if rows.is_empty() || !bool_field(&page, "hasMore") {
                break;
            }
        }
        Err(ToolError::not_found())
    }
}

pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "list_meetings",
            "description": "List a bounded page of local Candor meeting metadata. Read only and pathless.",
            "inputSchema": page_schema(false)
        },
        {
            "name": "search_meetings",
            "description": "Search a bounded subset of local meeting labels and transcript segments. Read only and pathless.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["query"],
                "properties": {
                    "query": { "type": "string", "minLength": 1, "maxLength": MAX_QUERY_BYTES },
                    "cursor": { "type": "string", "pattern": "^[0-9]{1,3}$" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_SEARCH_LIMIT }
                }
            }
        },
        {
            "name": "meeting_summary",
            "description": "Read bounded metadata for one local Candor meeting.",
            "inputSchema": recording_schema(false, false)
        },
        {
            "name": "get_transcript",
            "description": "Read one bounded page of a local meeting transcript.",
            "inputSchema": recording_schema(true, false)
        },
        {
            "name": "export_meeting",
            "description": "Render one bounded transcript page as markdown or text for stdout. No destination path is accepted.",
            "inputSchema": recording_schema(true, true)
        },
        {
            "name": "library_statistics",
            "description": "Calculate bounded aggregate statistics for the local Candor library.",
            "inputSchema": { "type": "object", "additionalProperties": false, "properties": {} }
        }
    ])
}

fn page_schema(recording_id: bool) -> Value {
    let mut properties = Map::new();
    if recording_id {
        properties.insert(
            "recordingId".to_string(),
            json!({ "type": "string", "minLength": 1, "maxLength": 96 }),
        );
    }
    properties.insert(
        "cursor".to_string(),
        json!({ "type": "string", "pattern": "^[0-9]{1,7}$" }),
    );
    properties.insert(
        "limit".to_string(),
        json!({ "type": "integer", "minimum": 1, "maximum": MAX_LIST_LIMIT }),
    );
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties
    })
}

fn recording_schema(paged: bool, export: bool) -> Value {
    let mut schema = page_schema(true);
    let object = schema.as_object_mut().expect("schema object");
    object.insert("required".to_string(), json!(["recordingId"]));
    let properties = object
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .expect("properties object");
    if !paged {
        properties.remove("cursor");
        properties.remove("limit");
    }
    if export {
        properties.insert(
            "format".to_string(),
            json!({ "type": "string", "enum": ["markdown", "text"] }),
        );
    }
    schema
}

fn private(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.insert("rawPathExposed".to_string(), Value::Bool(false));
        object.insert(
            "keyMaterialExposedToRenderer".to_string(),
            Value::Bool(false),
        );
    }
    value
}

fn object_args<'a>(
    arguments: &'a Value,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, ToolError> {
    let object = arguments
        .as_object()
        .ok_or_else(|| ToolError::invalid("tool arguments must be an object"))?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(ToolError::invalid(format!(
            "unexpected argument: {}",
            truncate_utf8(key, 64)
        )));
    }
    Ok(object)
}

fn recording_id_arg(object: &Map<String, Value>) -> Result<String, ToolError> {
    let value = required_string(object, "recordingId", 96)?;
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(ToolError::invalid(
            "recordingId must use ASCII letters, numbers, dash, or underscore",
        ));
    }
    Ok(value)
}

fn required_string(
    object: &Map<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Result<String, ToolError> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid(format!("{key} must be a string")))?;
    if value.len() > max_bytes {
        return Err(ToolError::invalid(format!(
            "{key} must be at most {max_bytes} bytes"
        )));
    }
    Ok(value.to_string())
}

fn optional_string(
    object: &Map<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Result<Option<String>, ToolError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.len() <= max_bytes => Ok(Some(value.clone())),
        _ => Err(ToolError::invalid(format!(
            "{key} must be a string of at most {max_bytes} bytes"
        ))),
    }
}

fn cursor_arg(
    object: &Map<String, Value>,
    key: &str,
    default: u64,
    maximum: u64,
) -> Result<u64, ToolError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::String(value))
            if !value.is_empty()
                && value.len() <= 10
                && value.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            value
                .parse::<u64>()
                .ok()
                .filter(|value| *value <= maximum)
                .ok_or_else(|| ToolError::invalid(format!("{key} exceeded its bounded range")))
        }
        _ => Err(ToolError::invalid(format!(
            "{key} must be a decimal cursor string"
        ))),
    }
}

fn limit_arg(object: &Map<String, Value>, maximum: u64) -> Result<u64, ToolError> {
    limit_arg_with_default(object, maximum, DEFAULT_LIMIT.min(maximum))
}

fn limit_arg_with_default(
    object: &Map<String, Value>,
    maximum: u64,
    default: u64,
) -> Result<u64, ToolError> {
    match object.get("limit") {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Number(value)) => value
            .as_u64()
            .filter(|value| (1..=maximum).contains(value))
            .ok_or_else(|| ToolError::invalid(format!("limit must be between 1 and {maximum}"))),
        _ => Err(ToolError::invalid("limit must be an integer")),
    }
}

fn sanitize_summary(value: &Value) -> Option<Value> {
    let recording_id = value.get("recordingId")?.as_str()?;
    if recording_id.len() > 96
        || !recording_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    Some(json!({
        "recordingId": recording_id,
        "label": optional_safe_string(value.get("label"), 256),
        "state": safe_enum(value.get("state"), &["recording", "needsRecovery", "finished"]),
        "encryptedAtRest": bool_field(value, "encryptedAtRest"),
        "chunkCount": u64_field(value, "chunkCount"),
        "transcriptSegmentCount": u64_field(value, "transcriptSegmentCount"),
        "audioChunkCount": u64_field(value, "audioChunkCount"),
        "notesChunkCount": u64_field(value, "notesChunkCount"),
        "audioDurationMs": u64_field(value, "audioDurationMs"),
        "storedBytes": u64_field(value, "storedBytes"),
        "createdAtMs": u64_field(value, "createdAtMs"),
        "updatedAtMs": u64_field(value, "updatedAtMs"),
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    }))
}

fn sanitize_segment(value: &Value) -> Option<Value> {
    let text = value.get("text")?.as_str()?;
    Some(json!({
        "index": u64_field(value, "index"),
        "channel": optional_safe_string(value.get("channel"), 32),
        "speaker": optional_safe_string(value.get("speaker"), 128),
        "text": truncate_utf8(text, MAX_TEXT_BYTES),
        "textTruncated": text.len() > MAX_TEXT_BYTES,
        "startMs": u64_field(value, "startMs"),
        "endMs": u64_field(value, "endMs"),
        "durationMs": u64_field(value, "durationMs"),
        "confidence": value.get("confidence").and_then(Value::as_f64),
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    }))
}

fn sanitize_search_match(value: &Value) -> Option<Value> {
    let recording_id = value.get("recordingId")?.as_str()?;
    if recording_id.is_empty()
        || recording_id.len() > 96
        || !recording_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    let row_kind = safe_enum(
        value.get("rowKind"),
        &[
            "meetingLabel",
            "transcriptText",
            "transcriptSegment",
            "notesMarkdown",
        ],
    );
    let kind = match row_kind.as_str() {
        "meetingLabel" => "metadata",
        "notesMarkdown" => "notes",
        "transcriptText" | "transcriptSegment" => "transcript",
        _ => return None,
    };
    let snippet = value.get("snippet")?.as_str()?;
    Some(private(json!({
        "recordingId": recording_id,
        "label": optional_safe_string(value.get("label"), 256),
        "state": safe_enum(value.get("state"), &["recording", "needsRecovery", "finished"]),
        "kind": kind,
        "chunkIndex": u64_field(value, "chunkIndex"),
        "channel": optional_safe_string(value.get("channel"), 32),
        "snippet": truncate_utf8(snippet, MAX_SNIPPET_BYTES)
    })))
}

fn optional_safe_string(value: Option<&Value>, max_bytes: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|value| truncate_utf8(value, max_bytes))
}

fn safe_enum(value: Option<&Value>, allowed: &[&str]) -> String {
    value
        .and_then(Value::as_str)
        .filter(|value| allowed.contains(value))
        .unwrap_or("unknown")
        .to_string()
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn u64_field(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
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

fn one_line(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character == '\n' || character == '\r' || character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

fn append_bounded(destination: &mut String, value: &str, limit: usize) -> bool {
    if destination.len().saturating_add(value.len()) <= limit {
        destination.push_str(value);
        return true;
    }
    let remaining = limit.saturating_sub(destination.len());
    if remaining > 0 {
        destination.push_str(&truncate_utf8(value, remaining));
    }
    false
}

fn format_timestamp(milliseconds: u64) -> String {
    let seconds = milliseconds / 1_000;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3_600,
        (seconds % 3_600) / 60,
        seconds % 60
    )
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    #[derive(Default)]
    struct MockBackend {
        responses: VecDeque<Result<Value, ToolError>>,
        calls: Vec<(String, Value)>,
    }

    impl MockBackend {
        fn with_responses(responses: Vec<Value>) -> Self {
            Self {
                responses: responses.into_iter().map(Ok).collect(),
                calls: Vec::new(),
            }
        }
    }

    impl Backend for MockBackend {
        fn call(&mut self, method: &str, params: Value) -> Result<Value, ToolError> {
            self.calls.push((method.to_string(), params));
            self.responses
                .pop_front()
                .unwrap_or_else(|| Err(ToolError::internal("missing mock response")))
        }
    }

    fn fixture_summary(id: &str) -> Value {
        json!({
            "recordingId": id,
            "label": "Weekly sync",
            "state": "finished",
            "encryptedAtRest": true,
            "chunkCount": 4,
            "transcriptSegmentCount": 2,
            "audioChunkCount": 1,
            "notesChunkCount": 1,
            "audioDurationMs": 900,
            "storedBytes": 1234,
            "createdAtMs": 10,
            "updatedAtMs": 20,
            "rawPath": "C:/must/not/leak",
            "key": "must-not-leak"
        })
    }

    #[test]
    fn unknown_tools_are_denied_without_calling_core() {
        let backend = MockBackend::default();
        let mut service = AutomationService::new(backend);
        let error = service
            .invoke("recording.durable.delete", json!({}))
            .expect_err("denied");
        assert_eq!(error.code, "OPERATION_DENIED");
        assert!(service.into_backend().calls.is_empty());
    }

    #[test]
    fn list_is_paginated_sanitized_and_pathless() {
        let backend = MockBackend::with_responses(vec![json!({
            "recordings": [fixture_summary("abc-123")],
            "totalCount": 2,
            "totalCountExact": false,
            "hasMore": true,
            "sourceTruncated": false,
            "rawPath": "C:/leak"
        })]);
        let mut service = AutomationService::new(backend);
        let value = service
            .invoke("list_meetings", json!({ "limit": 1 }))
            .expect("list");
        assert_eq!(value["rawPathExposed"], false);
        assert_eq!(value["keyMaterialExposedToRenderer"], false);
        assert_eq!(value["nextCursor"], "1");
        assert_eq!(value["totalCountExact"], false);
        assert_eq!(value["sourceTruncated"], false);
        assert!(value["meetings"][0].get("rawPath").is_none());
        assert!(value["meetings"][0].get("key").is_none());
        let backend = service.into_backend();
        assert_eq!(backend.calls[0].0, "recording.durable.listPage");
        assert_eq!(backend.calls[0].1, json!({ "offset": 0, "limit": 1 }));
    }

    #[test]
    fn list_preserves_core_partial_result_indicators() {
        let backend = MockBackend::with_responses(vec![json!({
            "recordings": [],
            "totalCount": 1,
            "totalCountExact": false,
            "hasMore": false,
            "sourceTruncated": true
        })]);
        let mut service = AutomationService::new(backend);
        let value = service
            .invoke("list_meetings", json!({ "limit": 1 }))
            .expect("partial list");
        assert_eq!(value["meetings"], json!([]));
        assert_eq!(value["hasMore"], false);
        assert_eq!(value["sourceTruncated"], true);
        assert_eq!(value["totalCountExact"], false);
    }

    #[test]
    fn summary_uses_the_supported_read_only_core_page_limit() {
        let backend = MockBackend::with_responses(vec![json!({
            "recordings": [fixture_summary("abc")],
            "totalCount": 1,
            "hasMore": false
        })]);
        let mut service = AutomationService::new(backend);
        let value = service
            .invoke("meeting_summary", json!({ "recordingId": "abc" }))
            .expect("summary");
        assert_eq!(value["recordingId"], "abc");
        let backend = service.into_backend();
        assert_eq!(
            backend.calls,
            vec![(
                "recording.durable.listPage".to_string(),
                json!({ "offset": 0, "limit": MAX_LIST_LIMIT })
            )]
        );
    }

    #[test]
    fn transcript_is_bounded_and_drops_unrecognized_fields() {
        let long_text = "x".repeat(MAX_TEXT_BYTES + 100);
        let backend = MockBackend::with_responses(vec![json!({
            "recordingId": "abc",
            "label": "Meeting",
            "state": "finished",
            "durationMs": 10,
            "segmentCount": 1,
            "hasMore": false,
            "segments": [{
                "index": 0,
                "text": long_text,
                "startMs": 0,
                "endMs": 10,
                "secretPath": "C:/leak"
            }]
        })]);
        let mut service = AutomationService::new(backend);
        let value = service
            .invoke("get_transcript", json!({ "recordingId": "abc" }))
            .expect("transcript");
        assert_eq!(value["segments"][0]["textTruncated"], true);
        assert!(value["segments"][0]["text"].as_str().unwrap().len() <= MAX_TEXT_BYTES);
        assert!(value["segments"][0].get("secretPath").is_none());
    }

    #[test]
    fn search_uses_core_trust_history_and_includes_notes_without_leaking_fields() {
        let backend = MockBackend::with_responses(vec![json!({
            "query": "budget",
            "matches": [
                {
                    "recordingId": "abc",
                    "label": "Budget weekly sync",
                    "state": "finished",
                    "rowKind": "meetingLabel",
                    "chunkIndex": 0,
                    "channel": "metadata",
                    "snippet": "Budget weekly sync"
                },
                {
                    "recordingId": "abc",
                    "label": "Weekly sync",
                    "state": "finished",
                    "rowKind": "transcriptSegment",
                    "chunkIndex": 3,
                    "channel": "system",
                    "snippet": "Discuss budget tomorrow",
                    "rawPath": "C:/must/not/leak"
                },
                {
                    "recordingId": "abc",
                    "label": "Weekly sync",
                    "state": "finished",
                    "rowKind": "notesMarkdown",
                    "chunkIndex": 4,
                    "channel": "notes",
                    "snippet": "Budget owner is Priya",
                    "key": "must-not-leak"
                }
            ],
            "truncated": false,
            "quarantinedCount": 0,
            "searchBackend": "bounded-read-only-source-scan",
            "encryptedIndex": false,
            "plaintextIndexPersisted": false
        })]);
        let mut service = AutomationService::new(backend);
        let value = service
            .invoke("search_meetings", json!({ "query": "budget" }))
            .expect("search");
        assert_eq!(value["count"], 3);
        assert_eq!(value["matches"][0]["kind"], "metadata");
        assert_eq!(value["matches"][1]["kind"], "transcript");
        assert_eq!(value["matches"][2]["kind"], "notes");
        assert!(value["matches"][1].get("rawPath").is_none());
        assert!(value["matches"][2].get("key").is_none());
        assert_eq!(value["scan"]["source"], "core-trust-history");
        assert_eq!(value["scan"]["partial"], false);
        let backend = service.into_backend();
        assert_eq!(
            backend.calls,
            vec![(
                "recording.durable.search".to_string(),
                json!({ "query": "budget" })
            )]
        );
    }

    #[test]
    fn export_is_stdout_only_and_does_not_call_core_export() {
        let backend = MockBackend::with_responses(vec![
            json!({
                "recordings": [fixture_summary("abc")],
                "totalCount": 1,
                "hasMore": false
            }),
            json!({
                "recordingId": "abc",
                "label": "Weekly sync",
                "state": "finished",
                "durationMs": 900,
                "segmentCount": 1,
                "segments": [{ "index": 0, "text": "Hello", "startMs": 0, "endMs": 900 }],
                "hasMore": false
            }),
        ]);
        let mut service = AutomationService::new(backend);
        let value = service
            .invoke("export_meeting", json!({ "recordingId": "abc" }))
            .expect("export");
        assert_eq!(value["destination"], "stdout-only");
        assert!(value["content"].as_str().unwrap().contains("Hello"));
        let backend = service.into_backend();
        assert!(backend
            .calls
            .iter()
            .all(|(method, _)| !method.starts_with("export.")));
    }

    #[test]
    fn statistics_are_bounded_and_aggregated() {
        let backend = MockBackend::with_responses(vec![json!({
            "recordings": [fixture_summary("abc")],
            "totalCount": 1,
            "hasMore": false
        })]);
        let mut service = AutomationService::new(backend);
        let value = service
            .invoke("library_statistics", json!({}))
            .expect("statistics");
        assert_eq!(value["meetingsScanned"], 1);
        assert_eq!(value["totalStoredBytes"], 1234);
        assert_eq!(value["encryptedAtRestMeetingCount"], 1);
        assert_eq!(value["partial"], false);
        let backend = service.into_backend();
        assert_eq!(
            backend.calls,
            vec![(
                "recording.durable.listPage".to_string(),
                json!({ "offset": 0, "limit": MAX_LIST_LIMIT })
            )]
        );
    }

    #[test]
    fn schemas_disallow_additional_properties() {
        let definitions = tool_definitions();
        let tools = definitions.as_array().expect("tools");
        assert_eq!(tools.len(), 6);
        assert!(tools.iter().all(|tool| {
            tool.pointer("/inputSchema/additionalProperties") == Some(&Value::Bool(false))
        }));
    }
}
