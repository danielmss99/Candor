use std::collections::VecDeque;

use serde::Serialize;

pub const TRANSCRIPT_PARTIAL_EVENT: &str = "transcript.partial";
pub const LIVE_TRANSCRIPT_SCHEMA_VERSION: u32 = 1;
pub const MAX_PARTIAL_SEGMENTS: usize = 256;
pub const MAX_PARTIAL_SEGMENT_TEXT_BYTES: usize = 4 * 1024;
pub const MAX_PARTIAL_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_PARTIAL_TIMESTAMP_MS: u64 = 24 * 60 * 60 * 1_000;

const MAX_RECORDING_ID_BYTES: usize = 128;
const MAX_FINAL_REVISION_ID_BYTES: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveTranscriptError {
    pub code: &'static str,
    pub message: String,
}

impl LiveTranscriptError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialTranscriptSegment {
    pub sequence: u64,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialTranscriptEvent {
    pub event: &'static str,
    pub schema_version: u32,
    pub recording_id: String,
    pub sequence: u64,
    pub provisional: bool,
    pub is_final: bool,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub segment_count: usize,
    pub local_only: bool,
    pub network_attempted: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialTranscriptSnapshot {
    pub schema_version: u32,
    pub recording_id: String,
    pub provisional: bool,
    pub finalized: bool,
    pub final_revision_id: Option<String>,
    pub segments: Vec<PartialTranscriptSegment>,
    pub segment_count: usize,
    pub text_bytes: usize,
    pub local_only: bool,
    pub network_attempted: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialTranscriptClearResult {
    pub schema_version: u32,
    pub recording_id: String,
    pub discarded_segment_count: usize,
    pub discarded_text_bytes: usize,
    pub final_revision_unchanged: bool,
    pub local_only: bool,
    pub network_attempted: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

/// A validated reference to a final transcript revision that another service owns.
///
/// This type intentionally contains no transcript text and exposes no mutation API.
/// Reconciliation can discard provisional data, but cannot edit the final revision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImmutableFinalRevisionRef {
    recording_id: String,
    revision_id: String,
}

impl ImmutableFinalRevisionRef {
    pub fn new(
        recording_id: impl Into<String>,
        revision_id: impl Into<String>,
    ) -> Result<Self, LiveTranscriptError> {
        let recording_id = recording_id.into();
        let revision_id = revision_id.into();
        validate_identifier(&recording_id, MAX_RECORDING_ID_BYTES, "recording")?;
        validate_identifier(&revision_id, MAX_FINAL_REVISION_ID_BYTES, "final revision")?;
        Ok(Self {
            recording_id,
            revision_id,
        })
    }

    pub fn recording_id(&self) -> &str {
        &self.recording_id
    }

    pub fn revision_id(&self) -> &str {
        &self.revision_id
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalReconciliationResult {
    pub schema_version: u32,
    pub recording_id: String,
    pub final_revision_id: String,
    pub discarded_provisional_segment_count: usize,
    pub final_revision_unchanged: bool,
    pub already_reconciled: bool,
    pub local_only: bool,
    pub network_attempted: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

#[derive(Clone, Debug)]
pub struct PartialTranscriptAccumulator {
    recording_id: String,
    next_sequence: u64,
    last_end_ms: Option<u64>,
    text_bytes: usize,
    segments: VecDeque<PartialTranscriptSegment>,
    final_revision_id: Option<String>,
}

impl PartialTranscriptAccumulator {
    pub fn new(recording_id: impl Into<String>) -> Result<Self, LiveTranscriptError> {
        let recording_id = recording_id.into();
        validate_identifier(&recording_id, MAX_RECORDING_ID_BYTES, "recording")?;
        Ok(Self {
            recording_id,
            next_sequence: 1,
            last_end_ms: None,
            text_bytes: 0,
            segments: VecDeque::new(),
            final_revision_id: None,
        })
    }

    pub fn push(
        &mut self,
        start_ms: u64,
        end_ms: u64,
        text: impl Into<String>,
    ) -> Result<PartialTranscriptEvent, LiveTranscriptError> {
        if self.final_revision_id.is_some() {
            return Err(LiveTranscriptError::new(
                "LIVE_TRANSCRIPT_FINALIZED",
                "provisional transcript updates are closed after final reconciliation",
            ));
        }
        if end_ms < start_ms {
            return Err(LiveTranscriptError::new(
                "LIVE_TRANSCRIPT_TIMESTAMP_INVALID",
                "partial transcript end time must not precede its start time",
            ));
        }
        if end_ms > MAX_PARTIAL_TIMESTAMP_MS {
            return Err(LiveTranscriptError::new(
                "LIVE_TRANSCRIPT_TIMESTAMP_LIMIT",
                "partial transcript timestamp exceeds the bounded session duration",
            ));
        }
        if self
            .last_end_ms
            .is_some_and(|previous_end| start_ms < previous_end)
        {
            return Err(LiveTranscriptError::new(
                "LIVE_TRANSCRIPT_TIMESTAMP_NON_MONOTONIC",
                "partial transcript timestamps must be monotonic",
            ));
        }

        let text = text.into();
        let text = text.trim();
        if text.is_empty() {
            return Err(LiveTranscriptError::new(
                "LIVE_TRANSCRIPT_TEXT_EMPTY",
                "partial transcript text must not be empty",
            ));
        }
        if text.len() > MAX_PARTIAL_SEGMENT_TEXT_BYTES {
            return Err(LiveTranscriptError::new(
                "LIVE_TRANSCRIPT_SEGMENT_TOO_LARGE",
                "partial transcript segment exceeds the text limit",
            ));
        }
        while self.segments.len() >= MAX_PARTIAL_SEGMENTS
            || self.text_bytes.saturating_add(text.len()) > MAX_PARTIAL_TEXT_BYTES
        {
            let Some(expired) = self.segments.pop_front() else {
                break;
            };
            self.text_bytes = self.text_bytes.saturating_sub(expired.text.len());
        }
        let next_text_bytes = self.text_bytes.saturating_add(text.len());

        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.checked_add(1).ok_or_else(|| {
            LiveTranscriptError::new(
                "LIVE_TRANSCRIPT_SEQUENCE_LIMIT",
                "partial transcript sequence limit reached",
            )
        })?;
        let segment = PartialTranscriptSegment {
            sequence,
            start_ms,
            end_ms,
            text: text.to_string(),
        };
        self.last_end_ms = Some(end_ms);
        self.text_bytes = next_text_bytes;
        self.segments.push_back(segment.clone());

        Ok(PartialTranscriptEvent {
            event: TRANSCRIPT_PARTIAL_EVENT,
            schema_version: LIVE_TRANSCRIPT_SCHEMA_VERSION,
            recording_id: self.recording_id.clone(),
            sequence,
            provisional: true,
            is_final: false,
            start_ms,
            end_ms,
            text: segment.text,
            segment_count: self.segments.len(),
            local_only: true,
            network_attempted: false,
            raw_path_exposed: false,
            key_material_exposed_to_renderer: false,
        })
    }

    pub fn snapshot(&self) -> PartialTranscriptSnapshot {
        PartialTranscriptSnapshot {
            schema_version: LIVE_TRANSCRIPT_SCHEMA_VERSION,
            recording_id: self.recording_id.clone(),
            provisional: self.final_revision_id.is_none(),
            finalized: self.final_revision_id.is_some(),
            final_revision_id: self.final_revision_id.clone(),
            segments: self.segments.iter().cloned().collect(),
            segment_count: self.segments.len(),
            text_bytes: self.text_bytes,
            local_only: true,
            network_attempted: false,
            raw_path_exposed: false,
            key_material_exposed_to_renderer: false,
        }
    }

    pub fn clear_provisional(&mut self) -> PartialTranscriptClearResult {
        let discarded_segment_count = self.segments.len();
        let discarded_text_bytes = self.text_bytes;
        self.segments.clear();
        self.text_bytes = 0;
        self.last_end_ms = None;
        PartialTranscriptClearResult {
            schema_version: LIVE_TRANSCRIPT_SCHEMA_VERSION,
            recording_id: self.recording_id.clone(),
            discarded_segment_count,
            discarded_text_bytes,
            final_revision_unchanged: true,
            local_only: true,
            network_attempted: false,
            raw_path_exposed: false,
            key_material_exposed_to_renderer: false,
        }
    }

    pub fn reconcile_final(
        &mut self,
        final_revision: &ImmutableFinalRevisionRef,
    ) -> Result<FinalReconciliationResult, LiveTranscriptError> {
        if final_revision.recording_id() != self.recording_id {
            return Err(LiveTranscriptError::new(
                "LIVE_TRANSCRIPT_RECORDING_MISMATCH",
                "final transcript revision belongs to a different recording",
            ));
        }
        if let Some(existing_revision_id) = &self.final_revision_id {
            if existing_revision_id != final_revision.revision_id() {
                return Err(LiveTranscriptError::new(
                    "LIVE_TRANSCRIPT_FINAL_REVISION_CONFLICT",
                    "a different immutable final revision is already reconciled",
                ));
            }
            return Ok(FinalReconciliationResult {
                schema_version: LIVE_TRANSCRIPT_SCHEMA_VERSION,
                recording_id: self.recording_id.clone(),
                final_revision_id: existing_revision_id.clone(),
                discarded_provisional_segment_count: 0,
                final_revision_unchanged: true,
                already_reconciled: true,
                local_only: true,
                network_attempted: false,
                raw_path_exposed: false,
                key_material_exposed_to_renderer: false,
            });
        }

        let discarded_provisional_segment_count = self.segments.len();
        self.segments.clear();
        self.text_bytes = 0;
        self.last_end_ms = None;
        self.final_revision_id = Some(final_revision.revision_id().to_string());

        Ok(FinalReconciliationResult {
            schema_version: LIVE_TRANSCRIPT_SCHEMA_VERSION,
            recording_id: self.recording_id.clone(),
            final_revision_id: final_revision.revision_id().to_string(),
            discarded_provisional_segment_count,
            final_revision_unchanged: true,
            already_reconciled: false,
            local_only: true,
            network_attempted: false,
            raw_path_exposed: false,
            key_material_exposed_to_renderer: false,
        })
    }
}

fn validate_identifier(
    value: &str,
    max_bytes: usize,
    kind: &str,
) -> Result<(), LiveTranscriptError> {
    if value.is_empty() || value.len() > max_bytes {
        return Err(LiveTranscriptError::new(
            "LIVE_TRANSCRIPT_ID_INVALID",
            format!("{kind} identifier is empty or exceeds its limit"),
        ));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(LiveTranscriptError::new(
            "LIVE_TRANSCRIPT_ID_INVALID",
            format!("{kind} identifier contains unsupported characters"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn partial_event_has_fixed_pathless_shape() {
        let mut accumulator = PartialTranscriptAccumulator::new("recording-1").unwrap();
        let event = accumulator.push(0, 500, "hello").unwrap();
        let value = serde_json::to_value(event).unwrap();

        assert_eq!(value["event"], TRANSCRIPT_PARTIAL_EVENT);
        assert_eq!(value["schemaVersion"], LIVE_TRANSCRIPT_SCHEMA_VERSION);
        assert_eq!(value["recordingId"], "recording-1");
        assert_eq!(value["sequence"], 1);
        assert_eq!(value["provisional"], true);
        assert_eq!(value["isFinal"], false);
        assert_eq!(value["rawPathExposed"], false);
        assert_eq!(value["keyMaterialExposedToRenderer"], false);
        assert_eq!(value["networkAttempted"], false);
        assert_eq!(value.as_object().unwrap().len(), 14);
    }

    #[test]
    fn timestamps_are_monotonic_and_bounded() {
        let mut accumulator = PartialTranscriptAccumulator::new("recording-1").unwrap();
        accumulator.push(100, 200, "first").unwrap();
        let overlap = accumulator.push(199, 300, "overlap").unwrap_err();
        assert_eq!(overlap.code, "LIVE_TRANSCRIPT_TIMESTAMP_NON_MONOTONIC");

        accumulator.push(200, 300, "second").unwrap();
        let reversed = accumulator.push(400, 399, "bad").unwrap_err();
        assert_eq!(reversed.code, "LIVE_TRANSCRIPT_TIMESTAMP_INVALID");

        let too_long = accumulator
            .push(
                MAX_PARTIAL_TIMESTAMP_MS,
                MAX_PARTIAL_TIMESTAMP_MS + 1,
                "bad",
            )
            .unwrap_err();
        assert_eq!(too_long.code, "LIVE_TRANSCRIPT_TIMESTAMP_LIMIT");
    }

    #[test]
    fn segment_and_text_limits_roll_forward_without_unbounded_growth() {
        let mut accumulator = PartialTranscriptAccumulator::new("recording-1").unwrap();
        let oversized = "x".repeat(MAX_PARTIAL_SEGMENT_TEXT_BYTES + 1);
        assert_eq!(
            accumulator.push(0, 1, oversized).unwrap_err().code,
            "LIVE_TRANSCRIPT_SEGMENT_TOO_LARGE"
        );

        for index in 0..(MAX_PARTIAL_SEGMENTS + 32) {
            let start = index as u64;
            accumulator.push(start, start, "x").unwrap();
        }
        let snapshot = accumulator.snapshot();
        assert_eq!(snapshot.segment_count, MAX_PARTIAL_SEGMENTS);
        assert_eq!(snapshot.segments.first().unwrap().sequence, 33);
        assert_eq!(
            snapshot.segments.last().unwrap().sequence,
            (MAX_PARTIAL_SEGMENTS + 32) as u64
        );
        assert!(snapshot.text_bytes <= MAX_PARTIAL_TEXT_BYTES);

        let mut text_bounded = PartialTranscriptAccumulator::new("recording-2").unwrap();
        let maximum_segment = "x".repeat(MAX_PARTIAL_SEGMENT_TEXT_BYTES);
        let retained = MAX_PARTIAL_TEXT_BYTES / MAX_PARTIAL_SEGMENT_TEXT_BYTES;
        for index in 0..(retained + 5) {
            let timestamp = index as u64;
            text_bounded
                .push(timestamp, timestamp, maximum_segment.clone())
                .unwrap();
        }
        let snapshot = text_bounded.snapshot();
        assert_eq!(snapshot.segment_count, retained);
        assert_eq!(snapshot.text_bytes, MAX_PARTIAL_TEXT_BYTES);
        assert_eq!(snapshot.segments.first().unwrap().sequence, 6);
    }

    #[test]
    fn clear_discards_only_provisional_state() {
        let mut accumulator = PartialTranscriptAccumulator::new("recording-1").unwrap();
        accumulator.push(0, 10, "hello").unwrap();
        let result = accumulator.clear_provisional();
        assert_eq!(result.discarded_segment_count, 1);
        assert_eq!(result.discarded_text_bytes, 5);
        assert!(result.final_revision_unchanged);
        assert!(accumulator.snapshot().segments.is_empty());

        let next = accumulator.push(0, 10, "again").unwrap();
        assert_eq!(next.sequence, 2);
    }

    #[test]
    fn final_reconciliation_never_overwrites_an_immutable_revision() {
        let mut accumulator = PartialTranscriptAccumulator::new("recording-1").unwrap();
        accumulator.push(0, 10, "provisional").unwrap();
        let final_one = ImmutableFinalRevisionRef::new("recording-1", "revision-1").unwrap();
        let result = accumulator.reconcile_final(&final_one).unwrap();
        assert_eq!(result.discarded_provisional_segment_count, 1);
        assert!(result.final_revision_unchanged);
        assert!(!result.already_reconciled);

        let repeated = accumulator.reconcile_final(&final_one).unwrap();
        assert!(repeated.already_reconciled);
        let final_two = ImmutableFinalRevisionRef::new("recording-1", "revision-2").unwrap();
        let conflict = accumulator.reconcile_final(&final_two).unwrap_err();
        assert_eq!(conflict.code, "LIVE_TRANSCRIPT_FINAL_REVISION_CONFLICT");
        assert_eq!(
            accumulator.snapshot().final_revision_id,
            Some("revision-1".into())
        );
        assert_eq!(
            accumulator.push(11, 20, "late").unwrap_err().code,
            "LIVE_TRANSCRIPT_FINALIZED"
        );
    }

    #[test]
    fn final_revision_must_belong_to_the_same_recording() {
        let mut accumulator = PartialTranscriptAccumulator::new("recording-1").unwrap();
        let other = ImmutableFinalRevisionRef::new("recording-2", "revision-1").unwrap();
        let error = accumulator.reconcile_final(&other).unwrap_err();
        assert_eq!(error.code, "LIVE_TRANSCRIPT_RECORDING_MISMATCH");
        assert_eq!(accumulator.snapshot().final_revision_id, None);
    }

    #[test]
    fn serialization_contains_no_hidden_path_or_key_fields() {
        let accumulator = PartialTranscriptAccumulator::new("recording-1").unwrap();
        let value = serde_json::to_value(accumulator.snapshot()).unwrap();
        assert_eq!(value["rawPathExposed"], json!(false));
        assert_eq!(value["keyMaterialExposedToRenderer"], json!(false));
        assert!(value.get("path").is_none());
        assert!(value.get("key").is_none());
    }
}
