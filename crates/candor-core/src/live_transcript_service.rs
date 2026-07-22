//! Bounded coordination for provisional, local-only transcript updates.
//!
//! The actual Whisper partial producer is owned by the trusted core capture
//! pipeline. It constructs
//! [`InternalPartialTranscript`] and calls [`LiveTranscriptService::push_internal`].
//! Renderer IPC must never register that method or accept provisional text.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::live_transcription::{
    FinalReconciliationResult, ImmutableFinalRevisionRef, LiveTranscriptError,
    PartialTranscriptAccumulator, PartialTranscriptClearResult, PartialTranscriptEvent,
    PartialTranscriptSnapshot, TRANSCRIPT_PARTIAL_EVENT,
};

pub const LIVE_TRANSCRIPT_SERVICE_SCHEMA_VERSION: u32 = 1;
pub const MAX_LIVE_TRANSCRIPT_SESSIONS: usize = 8;
pub const MAX_PENDING_LIVE_TRANSCRIPT_EVENTS: usize = 512;
pub const MAX_LIVE_TRANSCRIPT_EVENTS_PER_DRAIN: usize = 128;

/// The complete renderer-callable method allowlist for this service.
///
/// Push and final reconciliation are deliberately absent. Main-process
/// integration should register only these names and should still validate each
/// recording identifier at its IPC boundary.
pub const LIVE_TRANSCRIPT_RENDERER_METHODS: [&str; 6] = [
    "liveTranscript.enable",
    "liveTranscript.start",
    "liveTranscript.snapshot",
    "liveTranscript.clear",
    "liveTranscript.stop",
    "liveTranscript.eventsDrain",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveTranscriptServiceError {
    pub code: &'static str,
    pub message: String,
}

impl LiveTranscriptServiceError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<LiveTranscriptError> for LiveTranscriptServiceError {
    fn from(value: LiveTranscriptError) -> Self {
        Self {
            code: value.code,
            message: value.message,
        }
    }
}

/// Trusted producer input for one provisional ASR segment.
///
/// This type has private fields, no public constructor, and does not implement
/// `Deserialize`. It therefore cannot serve as a renderer JSON contract.
#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(dead_code)] // Constructed only by the future trusted in-core Whisper partial producer.
pub struct InternalPartialTranscript {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

impl InternalPartialTranscript {
    #[allow(dead_code)] // Renderer deserialization is intentionally impossible.
    pub fn from_trusted_asr(start_ms: u64, end_ms: u64, text: impl Into<String>) -> Self {
        Self {
            start_ms,
            end_ms,
            text: text.into(),
        }
    }
}

/// Proof-carrying wrapper created only after a final revision commit succeeds.
///
/// The recording store or transcription job should call `after_commit` only
/// after the immutable revision and its receipt are durably committed.
#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(dead_code)] // Constructed only after the recording store commits a final revision.
pub struct CommittedFinalRevisionRef {
    final_revision: ImmutableFinalRevisionRef,
}

impl CommittedFinalRevisionRef {
    #[allow(dead_code)]
    pub fn after_commit(final_revision: ImmutableFinalRevisionRef) -> Self {
        Self { final_revision }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranscriptSessionStatus {
    pub schema_version: u32,
    pub recording_id: String,
    pub enabled: bool,
    pub active: bool,
    pub provisional_segment_count: usize,
    pub pending_event_count: usize,
    pub local_only: bool,
    pub network_attempted: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranscriptEventEnvelope {
    pub schema_version: u32,
    pub delivery_sequence: u64,
    pub channel: &'static str,
    pub payload: PartialTranscriptEvent,
    pub local_only: bool,
    pub network_attempted: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranscriptEventDrain {
    pub schema_version: u32,
    pub events: Vec<LiveTranscriptEventEnvelope>,
    pub drained_event_count: usize,
    pub remaining_event_count: usize,
    pub local_only: bool,
    pub network_attempted: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranscriptClearStatus {
    pub schema_version: u32,
    pub recording_id: String,
    pub discarded_segment_count: usize,
    pub discarded_text_bytes: usize,
    pub discarded_pending_event_count: usize,
    pub session_removed: bool,
    pub memory_cleared: bool,
    /// `String` deallocation clears ownership but Rust's allocator does not
    /// promise a physical byte overwrite without an additional zeroizing type.
    pub zeroization_guaranteed: bool,
    pub final_revision_unchanged: bool,
    pub local_only: bool,
    pub network_attempted: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranscriptReconciliation {
    pub schema_version: u32,
    pub result: FinalReconciliationResult,
    pub discarded_pending_event_count: usize,
    pub producer_closed: bool,
    pub local_only: bool,
    pub network_attempted: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

#[derive(Debug)]
struct LiveTranscriptSession {
    active: bool,
    enabled_sequence: u64,
    accumulator: PartialTranscriptAccumulator,
}

#[derive(Debug)]
struct LiveTranscriptState {
    sessions: HashMap<String, LiveTranscriptSession>,
    pending_events: VecDeque<LiveTranscriptEventEnvelope>,
    next_session_sequence: u64,
    #[allow(dead_code)] // Used when the trusted partial producer is connected.
    next_delivery_sequence: u64,
}

/// Thread-safe coordinator for bounded provisional transcript sessions.
#[derive(Clone, Debug)]
pub struct LiveTranscriptService {
    state: Arc<Mutex<LiveTranscriptState>>,
    session_limit: usize,
    #[allow(dead_code)] // Used when the trusted partial producer is connected.
    pending_event_limit: usize,
    drain_limit: usize,
}

impl Default for LiveTranscriptService {
    fn default() -> Self {
        Self::new()
    }
}

impl LiveTranscriptService {
    pub fn new() -> Self {
        Self::with_limits(
            MAX_LIVE_TRANSCRIPT_SESSIONS,
            MAX_PENDING_LIVE_TRANSCRIPT_EVENTS,
            MAX_LIVE_TRANSCRIPT_EVENTS_PER_DRAIN,
        )
    }

    fn with_limits(session_limit: usize, pending_event_limit: usize, drain_limit: usize) -> Self {
        debug_assert!(session_limit > 0);
        debug_assert!(pending_event_limit > 0);
        debug_assert!(drain_limit > 0);
        Self {
            state: Arc::new(Mutex::new(LiveTranscriptState {
                sessions: HashMap::new(),
                pending_events: VecDeque::new(),
                next_session_sequence: 1,
                next_delivery_sequence: 1,
            })),
            session_limit,
            pending_event_limit,
            drain_limit,
        }
    }

    /// Enables a recording for live transcription without starting a producer.
    pub fn enable(
        &self,
        recording_id: impl Into<String>,
    ) -> Result<LiveTranscriptSessionStatus, LiveTranscriptServiceError> {
        let recording_id = recording_id.into();
        let accumulator = PartialTranscriptAccumulator::new(recording_id.clone())?;
        let mut state = self.lock_state()?;

        if !state.sessions.contains_key(&recording_id) {
            let inactive_eviction = (state.sessions.len() >= self.session_limit)
                .then(|| {
                    state
                        .sessions
                        .iter()
                        .filter(|(_, session)| !session.active)
                        .min_by_key(|(candidate_id, session)| {
                            (session.enabled_sequence, candidate_id.as_str())
                        })
                        .map(|(candidate_id, _)| candidate_id.clone())
                })
                .flatten();
            if state.sessions.len() >= self.session_limit && inactive_eviction.is_none() {
                return Err(LiveTranscriptServiceError::new(
                    "LIVE_TRANSCRIPT_SESSION_LIMIT",
                    "live transcript session limit reached with all sessions active",
                ));
            }
            let enabled_sequence = state.next_session_sequence;
            state.next_session_sequence =
                state.next_session_sequence.checked_add(1).ok_or_else(|| {
                    LiveTranscriptServiceError::new(
                        "LIVE_TRANSCRIPT_SESSION_SEQUENCE_LIMIT",
                        "live transcript session sequence limit reached",
                    )
                })?;
            if let Some(evicted_recording_id) = inactive_eviction {
                state.sessions.remove(&evicted_recording_id);
                remove_recording_events(&mut state, &evicted_recording_id);
            }
            state.sessions.insert(
                recording_id.clone(),
                LiveTranscriptSession {
                    active: false,
                    enabled_sequence,
                    accumulator,
                },
            );
        }

        Ok(session_status(&state, &recording_id))
    }

    /// Starts trusted producer updates for an already-enabled recording.
    pub fn start(
        &self,
        recording_id: &str,
    ) -> Result<LiveTranscriptSessionStatus, LiveTranscriptServiceError> {
        let mut state = self.lock_state()?;
        let session = state.sessions.get_mut(recording_id).ok_or_else(|| {
            LiveTranscriptServiceError::new(
                "LIVE_TRANSCRIPT_NOT_ENABLED",
                "enable live transcription before starting the producer",
            )
        })?;
        if session.accumulator.snapshot().finalized {
            return Err(LiveTranscriptServiceError::new(
                "LIVE_TRANSCRIPT_FINALIZED",
                "a reconciled live transcript session cannot restart",
            ));
        }
        session.active = true;
        Ok(session_status(&state, recording_id))
    }

    /// Marks the trusted producer inactive while retaining provisional text for
    /// reconciliation with the final immutable transcript revision.
    pub fn producer_stopped(
        &self,
        recording_id: &str,
    ) -> Result<LiveTranscriptSessionStatus, LiveTranscriptServiceError> {
        let mut state = self.lock_state()?;
        let session = state.sessions.get_mut(recording_id).ok_or_else(|| {
            LiveTranscriptServiceError::new(
                "LIVE_TRANSCRIPT_NOT_ENABLED",
                "live transcription is not enabled for this recording",
            )
        })?;
        session.active = false;
        Ok(session_status(&state, recording_id))
    }

    /// Accepts text only from a trusted in-core ASR producer.
    #[allow(dead_code)]
    pub fn push_internal(
        &self,
        recording_id: &str,
        update: InternalPartialTranscript,
    ) -> Result<LiveTranscriptEventEnvelope, LiveTranscriptServiceError> {
        let mut state = self.lock_state()?;
        if state.pending_events.len() >= self.pending_event_limit {
            return Err(LiveTranscriptServiceError::new(
                "LIVE_TRANSCRIPT_EVENT_LIMIT",
                "pending live transcript event limit reached",
            ));
        }

        let payload = {
            let session = state.sessions.get_mut(recording_id).ok_or_else(|| {
                LiveTranscriptServiceError::new(
                    "LIVE_TRANSCRIPT_NOT_ENABLED",
                    "live transcription is not enabled for this recording",
                )
            })?;
            if !session.active {
                return Err(LiveTranscriptServiceError::new(
                    "LIVE_TRANSCRIPT_NOT_ACTIVE",
                    "live transcript producer is not active for this recording",
                ));
            }
            session
                .accumulator
                .push(update.start_ms, update.end_ms, update.text)?
        };

        let delivery_sequence = state.next_delivery_sequence;
        state.next_delivery_sequence =
            state.next_delivery_sequence.checked_add(1).ok_or_else(|| {
                LiveTranscriptServiceError::new(
                    "LIVE_TRANSCRIPT_DELIVERY_SEQUENCE_LIMIT",
                    "live transcript delivery sequence limit reached",
                )
            })?;
        let envelope = LiveTranscriptEventEnvelope {
            schema_version: LIVE_TRANSCRIPT_SERVICE_SCHEMA_VERSION,
            delivery_sequence,
            channel: TRANSCRIPT_PARTIAL_EVENT,
            payload,
            local_only: true,
            network_attempted: false,
            raw_path_exposed: false,
            key_material_exposed_to_renderer: false,
        };
        state.pending_events.push_back(envelope.clone());
        Ok(envelope)
    }

    pub fn snapshot(
        &self,
        recording_id: &str,
    ) -> Result<PartialTranscriptSnapshot, LiveTranscriptServiceError> {
        let state = self.lock_state()?;
        state
            .sessions
            .get(recording_id)
            .map(|session| session.accumulator.snapshot())
            .ok_or_else(|| {
                LiveTranscriptServiceError::new(
                    "LIVE_TRANSCRIPT_NOT_ENABLED",
                    "live transcription is not enabled for this recording",
                )
            })
    }

    /// Clears provisional segments and all undelivered events for one recording.
    pub fn clear(
        &self,
        recording_id: &str,
    ) -> Result<LiveTranscriptClearStatus, LiveTranscriptServiceError> {
        let mut state = self.lock_state()?;
        let cleared = state
            .sessions
            .get_mut(recording_id)
            .map(|session| session.accumulator.clear_provisional())
            .ok_or_else(|| {
                LiveTranscriptServiceError::new(
                    "LIVE_TRANSCRIPT_NOT_ENABLED",
                    "live transcription is not enabled for this recording",
                )
            })?;
        let discarded_pending_event_count = remove_recording_events(&mut state, recording_id);
        Ok(clear_status(cleared, discarded_pending_event_count, false))
    }

    /// Stops and removes a session, dropping all coordinator-owned text.
    pub fn stop(
        &self,
        recording_id: &str,
    ) -> Result<LiveTranscriptClearStatus, LiveTranscriptServiceError> {
        let mut state = self.lock_state()?;
        let mut session = state.sessions.remove(recording_id).ok_or_else(|| {
            LiveTranscriptServiceError::new(
                "LIVE_TRANSCRIPT_NOT_ENABLED",
                "live transcription is not enabled for this recording",
            )
        })?;
        session.active = false;
        let cleared = session.accumulator.clear_provisional();
        let discarded_pending_event_count = remove_recording_events(&mut state, recording_id);
        Ok(clear_status(cleared, discarded_pending_event_count, true))
    }

    /// Idempotently drops all provisional text and pending events during a
    /// durable recording deletion transaction.
    pub fn remove_for_deletion(
        &self,
        recording_id: &str,
    ) -> Result<LiveTranscriptClearStatus, LiveTranscriptServiceError> {
        let mut state = self.lock_state()?;
        let cleared = match state.sessions.remove(recording_id) {
            Some(mut session) => {
                session.active = false;
                session.accumulator.clear_provisional()
            }
            None => {
                PartialTranscriptAccumulator::new(recording_id.to_string())?.clear_provisional()
            }
        };
        let discarded_pending_event_count = remove_recording_events(&mut state, recording_id);
        Ok(clear_status(cleared, discarded_pending_event_count, true))
    }

    /// Returns only the fixed `transcript.partial` event envelope and drains a
    /// bounded number of queued events. Callers cannot select an event name.
    pub fn drain_events(&self) -> Result<LiveTranscriptEventDrain, LiveTranscriptServiceError> {
        let mut state = self.lock_state()?;
        let drain_count = state.pending_events.len().min(self.drain_limit);
        let events: Vec<_> = state.pending_events.drain(..drain_count).collect();
        Ok(LiveTranscriptEventDrain {
            schema_version: LIVE_TRANSCRIPT_SERVICE_SCHEMA_VERSION,
            drained_event_count: events.len(),
            remaining_event_count: state.pending_events.len(),
            events,
            local_only: true,
            network_attempted: false,
            raw_path_exposed: false,
            key_material_exposed_to_renderer: false,
        })
    }

    /// Reconciles only a proof-carrying immutable revision reference produced by
    /// a trusted core caller after durable commit.
    #[allow(dead_code)]
    pub fn reconcile_committed(
        &self,
        committed: &CommittedFinalRevisionRef,
    ) -> Result<LiveTranscriptReconciliation, LiveTranscriptServiceError> {
        let recording_id = committed.final_revision.recording_id().to_string();
        let mut state = self.lock_state()?;
        let result = {
            let session = state.sessions.get_mut(&recording_id).ok_or_else(|| {
                LiveTranscriptServiceError::new(
                    "LIVE_TRANSCRIPT_NOT_ENABLED",
                    "live transcription is not enabled for this recording",
                )
            })?;
            let result = session
                .accumulator
                .reconcile_final(&committed.final_revision)?;
            session.active = false;
            result
        };
        state.sessions.remove(&recording_id);
        let discarded_pending_event_count = remove_recording_events(&mut state, &recording_id);
        Ok(LiveTranscriptReconciliation {
            schema_version: LIVE_TRANSCRIPT_SERVICE_SCHEMA_VERSION,
            result,
            discarded_pending_event_count,
            producer_closed: true,
            local_only: true,
            network_attempted: false,
            raw_path_exposed: false,
            key_material_exposed_to_renderer: false,
        })
    }

    fn lock_state(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, LiveTranscriptState>, LiveTranscriptServiceError> {
        self.state.lock().map_err(|_| {
            LiveTranscriptServiceError::new(
                "LIVE_TRANSCRIPT_STATE_UNAVAILABLE",
                "live transcript coordinator state is unavailable",
            )
        })
    }
}

fn session_status(state: &LiveTranscriptState, recording_id: &str) -> LiveTranscriptSessionStatus {
    let session = state
        .sessions
        .get(recording_id)
        .expect("session status is requested only for an existing session");
    LiveTranscriptSessionStatus {
        schema_version: LIVE_TRANSCRIPT_SERVICE_SCHEMA_VERSION,
        recording_id: recording_id.to_string(),
        enabled: true,
        active: session.active,
        provisional_segment_count: session.accumulator.snapshot().segment_count,
        pending_event_count: state
            .pending_events
            .iter()
            .filter(|event| event.payload.recording_id == recording_id)
            .count(),
        local_only: true,
        network_attempted: false,
        raw_path_exposed: false,
        key_material_exposed_to_renderer: false,
    }
}

fn remove_recording_events(state: &mut LiveTranscriptState, recording_id: &str) -> usize {
    let before = state.pending_events.len();
    state
        .pending_events
        .retain(|event| event.payload.recording_id != recording_id);
    before - state.pending_events.len()
}

fn clear_status(
    cleared: PartialTranscriptClearResult,
    discarded_pending_event_count: usize,
    session_removed: bool,
) -> LiveTranscriptClearStatus {
    LiveTranscriptClearStatus {
        schema_version: LIVE_TRANSCRIPT_SERVICE_SCHEMA_VERSION,
        recording_id: cleared.recording_id,
        discarded_segment_count: cleared.discarded_segment_count,
        discarded_text_bytes: cleared.discarded_text_bytes,
        discarded_pending_event_count,
        session_removed,
        memory_cleared: true,
        zeroization_guaranteed: false,
        final_revision_unchanged: cleared.final_revision_unchanged,
        local_only: true,
        network_attempted: false,
        raw_path_exposed: false,
        key_material_exposed_to_renderer: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active(service: &LiveTranscriptService, recording_id: &str) {
        service.enable(recording_id).unwrap();
        service.start(recording_id).unwrap();
    }

    fn update(start_ms: u64, end_ms: u64, text: &str) -> InternalPartialTranscript {
        InternalPartialTranscript::from_trusted_asr(start_ms, end_ms, text)
    }

    #[test]
    fn sessions_are_isolated_and_sequences_are_per_recording() {
        let service = LiveTranscriptService::new();
        active(&service, "recording-a");
        active(&service, "recording-b");

        let a1 = service
            .push_internal("recording-a", update(0, 10, "a one"))
            .unwrap();
        let b1 = service
            .push_internal("recording-b", update(0, 10, "b one"))
            .unwrap();
        let a2 = service
            .push_internal("recording-a", update(10, 20, "a two"))
            .unwrap();

        assert_eq!(a1.payload.sequence, 1);
        assert_eq!(b1.payload.sequence, 1);
        assert_eq!(a2.payload.sequence, 2);
        assert_eq!(a1.delivery_sequence, 1);
        assert_eq!(b1.delivery_sequence, 2);
        assert_eq!(a2.delivery_sequence, 3);
        assert_eq!(service.snapshot("recording-a").unwrap().segment_count, 2);
        assert_eq!(service.snapshot("recording-b").unwrap().segment_count, 1);
    }

    #[test]
    fn drain_is_bounded_ordered_and_destructive() {
        let service = LiveTranscriptService::with_limits(2, 4, 2);
        active(&service, "recording-a");
        for sequence in 0..3 {
            service
                .push_internal(
                    "recording-a",
                    update(sequence, sequence, &format!("part {sequence}")),
                )
                .unwrap();
        }

        let first = service.drain_events().unwrap();
        assert_eq!(first.drained_event_count, 2);
        assert_eq!(first.remaining_event_count, 1);
        assert_eq!(first.events[0].channel, TRANSCRIPT_PARTIAL_EVENT);
        assert_eq!(first.events[0].delivery_sequence, 1);
        assert_eq!(first.events[1].delivery_sequence, 2);

        let second = service.drain_events().unwrap();
        assert_eq!(second.drained_event_count, 1);
        assert_eq!(second.events[0].delivery_sequence, 3);
        assert_eq!(service.drain_events().unwrap().drained_event_count, 0);
    }

    #[test]
    fn final_reconciliation_requires_committed_ref_and_discards_provisional_events() {
        let service = LiveTranscriptService::new();
        active(&service, "recording-a");
        service
            .push_internal("recording-a", update(0, 10, "provisional"))
            .unwrap();

        let final_ref = ImmutableFinalRevisionRef::new("recording-a", "revision-1").unwrap();
        let committed = CommittedFinalRevisionRef::after_commit(final_ref);
        service.producer_stopped("recording-a").unwrap();
        let stopped = service.snapshot("recording-a").unwrap();
        assert_eq!(stopped.segment_count, 1);
        assert!(!service.enable("recording-a").unwrap().active);
        let result = service.reconcile_committed(&committed).unwrap();
        assert_eq!(result.result.final_revision_id, "revision-1");
        assert_eq!(result.result.discarded_provisional_segment_count, 1);
        assert_eq!(result.discarded_pending_event_count, 1);
        assert!(result.producer_closed);
        assert_eq!(service.drain_events().unwrap().drained_event_count, 0);
        assert_eq!(
            service.snapshot("recording-a").unwrap_err().code,
            "LIVE_TRANSCRIPT_NOT_ENABLED"
        );
        assert_eq!(
            service
                .push_internal("recording-a", update(10, 20, "late"))
                .unwrap_err()
                .code,
            "LIVE_TRANSCRIPT_NOT_ENABLED"
        );
    }

    #[test]
    fn committed_reconciliation_releases_slots_across_sequential_meetings() {
        let service = LiveTranscriptService::with_limits(2, 4, 2);

        for sequence in 0..10 {
            let recording_id = format!("recording-{sequence}");
            active(&service, &recording_id);
            service
                .push_internal(&recording_id, update(0, 10, "provisional"))
                .unwrap();
            service.producer_stopped(&recording_id).unwrap();

            let final_ref = ImmutableFinalRevisionRef::new(
                recording_id.clone(),
                format!("revision-{sequence}"),
            )
            .unwrap();
            let committed = CommittedFinalRevisionRef::after_commit(final_ref);
            let result = service.reconcile_committed(&committed).unwrap();

            assert_eq!(
                result.result.final_revision_id,
                format!("revision-{sequence}")
            );
            assert_eq!(result.result.discarded_provisional_segment_count, 1);
            assert_eq!(result.discarded_pending_event_count, 1);
            assert_eq!(
                service.snapshot(&recording_id).unwrap_err().code,
                "LIVE_TRANSCRIPT_NOT_ENABLED"
            );
        }

        active(&service, "recording-after-ten");
    }

    #[test]
    fn session_and_pending_event_limits_reject_growth_without_cross_session_loss() {
        let service = LiveTranscriptService::with_limits(2, 2, 2);
        active(&service, "recording-a");
        active(&service, "recording-b");
        assert_eq!(
            service.enable("recording-c").unwrap_err().code,
            "LIVE_TRANSCRIPT_SESSION_LIMIT"
        );

        service
            .push_internal("recording-a", update(0, 1, "a"))
            .unwrap();
        service
            .push_internal("recording-b", update(0, 1, "b"))
            .unwrap();
        assert_eq!(
            service
                .push_internal("recording-a", update(1, 2, "not stored"))
                .unwrap_err()
                .code,
            "LIVE_TRANSCRIPT_EVENT_LIMIT"
        );
        assert_eq!(service.snapshot("recording-a").unwrap().segment_count, 1);
        assert_eq!(service.snapshot("recording-b").unwrap().segment_count, 1);
    }

    #[test]
    fn enable_evicts_oldest_inactive_session_but_never_an_active_session() {
        let service = LiveTranscriptService::with_limits(2, 4, 2);
        active(&service, "active-recording");
        active(&service, "failed-recording-0");
        service
            .push_internal("failed-recording-0", update(0, 10, "failed partial"))
            .unwrap();
        service.producer_stopped("failed-recording-0").unwrap();

        for sequence in 1..10 {
            let recording_id = format!("failed-recording-{sequence}");
            service.enable(&recording_id).unwrap();

            assert!(service.snapshot("active-recording").is_ok());
            assert_eq!(
                service
                    .snapshot(&format!("failed-recording-{}", sequence - 1))
                    .unwrap_err()
                    .code,
                "LIVE_TRANSCRIPT_NOT_ENABLED"
            );
            assert!(service.snapshot(&recording_id).is_ok());
            if sequence == 1 {
                assert_eq!(service.drain_events().unwrap().drained_event_count, 0);
            }
        }

        service.start("failed-recording-9").unwrap();
        assert_eq!(
            service.enable("third-active").unwrap_err().code,
            "LIVE_TRANSCRIPT_SESSION_LIMIT"
        );
        assert!(service.snapshot("active-recording").is_ok());
        assert!(service.snapshot("failed-recording-9").is_ok());
    }

    #[test]
    fn clear_and_stop_remove_only_target_recording_state() {
        let service = LiveTranscriptService::new();
        active(&service, "recording-a");
        active(&service, "recording-b");
        service
            .push_internal("recording-a", update(0, 1, "secret a"))
            .unwrap();
        service
            .push_internal("recording-b", update(0, 1, "keep b"))
            .unwrap();

        let cleared = service.clear("recording-a").unwrap();
        assert_eq!(cleared.discarded_segment_count, 1);
        assert_eq!(cleared.discarded_pending_event_count, 1);
        assert!(cleared.memory_cleared);
        assert!(!cleared.zeroization_guaranteed);
        assert_eq!(service.snapshot("recording-a").unwrap().segment_count, 0);
        assert_eq!(service.snapshot("recording-b").unwrap().segment_count, 1);

        let stopped = service.stop("recording-a").unwrap();
        assert!(stopped.session_removed);
        assert!(service.snapshot("recording-a").is_err());
        assert_eq!(service.drain_events().unwrap().drained_event_count, 1);
    }

    #[test]
    fn deletion_cleanup_is_idempotent_and_drops_only_target_text() {
        let service = LiveTranscriptService::new();
        active(&service, "recording-delete");
        active(&service, "recording-keep");
        service
            .push_internal("recording-delete", update(0, 1, "private text"))
            .unwrap();
        service
            .push_internal("recording-keep", update(0, 1, "retained text"))
            .unwrap();

        let first = service.remove_for_deletion("recording-delete").unwrap();
        assert_eq!(first.discarded_segment_count, 1);
        assert_eq!(first.discarded_pending_event_count, 1);
        assert!(first.session_removed);
        let second = service.remove_for_deletion("recording-delete").unwrap();
        assert_eq!(second.discarded_segment_count, 0);
        assert_eq!(second.discarded_pending_event_count, 0);
        assert_eq!(service.snapshot("recording-keep").unwrap().segment_count, 1);
        assert_eq!(service.drain_events().unwrap().drained_event_count, 1);
    }

    #[test]
    fn renderer_allowlist_has_no_text_ingress_or_reconciliation_surface() {
        assert!(LIVE_TRANSCRIPT_RENDERER_METHODS
            .iter()
            .all(|method| !method.contains("push") && !method.contains("reconcile")));
        assert_eq!(LIVE_TRANSCRIPT_RENDERER_METHODS.len(), 6);

        let service = LiveTranscriptService::new();
        let status = service.enable("recording-a").unwrap();
        let value = serde_json::to_value(status).unwrap();
        assert!(value.get("text").is_none());
        assert_eq!(value["rawPathExposed"], false);
        assert_eq!(value["keyMaterialExposedToRenderer"], false);
    }

    #[test]
    fn all_event_envelopes_are_fixed_pathless_and_keyless() {
        let service = LiveTranscriptService::new();
        active(&service, "recording-a");
        let envelope = service
            .push_internal("recording-a", update(0, 1, "local"))
            .unwrap();
        let value = serde_json::to_value(envelope).unwrap();
        assert_eq!(value["channel"], TRANSCRIPT_PARTIAL_EVENT);
        assert_eq!(value["rawPathExposed"], false);
        assert_eq!(value["keyMaterialExposedToRenderer"], false);
        assert_eq!(value["networkAttempted"], false);
        assert!(value.get("path").is_none());
        assert!(value.get("key").is_none());
    }
}
