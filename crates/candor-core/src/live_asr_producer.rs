//! Trusted capture-time Whisper producer for provisional transcript events.
//!
//! Audio enters only through the bounded in-memory capture tap. Provisional
//! text enters only `LiveTranscriptService::push_internal` and is never written
//! to the recording store. Durable final transcription remains the sole owner
//! of immutable transcript revisions.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(any(feature = "local-whisper", test))]
use crate::capture_service::CaptureSource;
#[cfg(feature = "local-whisper")]
use crate::capture_service::LivePcmSubscription;
use crate::capture_service::{CaptureError, CaptureManager, LivePcmDetachHandle};
use crate::model_manager::ModelManager;
use crate::recording_store::RecordingStore;
use crate::transcription_service::{TranscriptionError, TranscriptionService};
#[cfg(feature = "local-whisper")]
use candor_core::live_transcript_service::InternalPartialTranscript;
use candor_core::live_transcript_service::{LiveTranscriptService, LiveTranscriptServiceError};

#[cfg(feature = "local-whisper")]
use crate::replacement_rules::normalize_transcript_text;
#[cfg(feature = "local-whisper")]
use crate::transcription_service::{live_pcm16le_to_mono_16k, LiveWhisperConfig};

#[cfg(any(feature = "local-whisper", test))]
const LIVE_ASR_SAMPLE_RATE_HZ: usize = 16_000;
#[cfg(any(feature = "local-whisper", test))]
const LIVE_ASR_WINDOW_SECONDS: usize = 5;
#[cfg(any(feature = "local-whisper", test))]
const LIVE_ASR_MIN_WINDOW_SECONDS: usize = 1;
#[cfg(any(feature = "local-whisper", test))]
const LIVE_ASR_MAX_WINDOW_SECONDS: usize = 7;
#[cfg(any(feature = "local-whisper", test))]
const LIVE_ASR_WINDOW_SAMPLES: usize = LIVE_ASR_SAMPLE_RATE_HZ * LIVE_ASR_WINDOW_SECONDS;
#[cfg(any(feature = "local-whisper", test))]
const LIVE_ASR_MIN_WINDOW_SAMPLES: usize = LIVE_ASR_SAMPLE_RATE_HZ * LIVE_ASR_MIN_WINDOW_SECONDS;
#[cfg(any(feature = "local-whisper", test))]
const LIVE_ASR_MAX_WINDOW_SAMPLES: usize = LIVE_ASR_SAMPLE_RATE_HZ * LIVE_ASR_MAX_WINDOW_SECONDS;
#[cfg(feature = "local-whisper")]
const LIVE_ASR_GAP_TOLERANCE_MS: u64 = 200;
#[cfg(any(feature = "local-whisper", test))]
const LIVE_ASR_SILENCE_RMS: f32 = 0.003;
#[cfg(feature = "local-whisper")]
const LIVE_ASR_MAX_SEGMENT_TEXT_BYTES: usize = 4 * 1024;
#[cfg(feature = "local-whisper")]
const LIVE_ASR_RECEIVE_POLL: Duration = Duration::from_millis(50);
const LIVE_ASR_JOIN_BUDGET: Duration = Duration::from_millis(250);

#[derive(Debug)]
pub(crate) struct LiveAsrProducerError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl LiveAsrProducerError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<CaptureError> for LiveAsrProducerError {
    fn from(error: CaptureError) -> Self {
        Self::new(error.code, error.message)
    }
}

impl From<TranscriptionError> for LiveAsrProducerError {
    fn from(error: TranscriptionError) -> Self {
        Self::new(error.code, error.message)
    }
}

impl From<LiveTranscriptServiceError> for LiveAsrProducerError {
    fn from(error: LiveTranscriptServiceError) -> Self {
        Self::new(error.code, error.message)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct LiveAsrStopOutcome {
    pub(crate) worker_found: bool,
    pub(crate) cancellation_requested: bool,
    pub(crate) joined_within_budget: bool,
    pub(crate) join_deferred: bool,
    pub(crate) dropped_pcm_chunk_count: u64,
    pub(crate) failure_code: Option<&'static str>,
}

struct LiveAsrWorker {
    cancellation: Arc<AtomicBool>,
    detach: Option<LivePcmDetachHandle>,
    dropped_pcm_chunk_count: Arc<AtomicU64>,
    failure_code: Arc<Mutex<Option<&'static str>>>,
    done: mpsc::Receiver<()>,
    join: Option<thread::JoinHandle<()>>,
}

#[derive(Default)]
pub(crate) struct LiveAsrProducerManager {
    workers: HashMap<String, LiveAsrWorker>,
}

impl LiveAsrProducerManager {
    pub(crate) const fn available() -> bool {
        cfg!(feature = "local-whisper")
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start(
        &mut self,
        recording_id: &str,
        capture_manager: &CaptureManager,
        recording_store: RecordingStore,
        model_manager: ModelManager,
        transcription_service: TranscriptionService,
        live_transcript: LiveTranscriptService,
    ) -> Result<(), LiveAsrProducerError> {
        #[cfg(not(feature = "local-whisper"))]
        {
            let _ = (
                recording_id,
                capture_manager,
                recording_store,
                model_manager,
                transcription_service,
                live_transcript,
            );
            Err(LiveAsrProducerError::new(
                "LIVE_TRANSCRIPT_ENGINE_UNAVAILABLE",
                "this Candor core was built without the packaged local Whisper runtime",
            ))
        }

        #[cfg(feature = "local-whisper")]
        {
            self.reap_completed();
            if self.workers.contains_key(recording_id) {
                return Err(LiveAsrProducerError::new(
                    "LIVE_TRANSCRIPT_PRODUCER_ACTIVE",
                    "a local live transcript producer is already active for this recording",
                ));
            }

            // This performs only bounded metadata reads and cache validation.
            // Model hashing and context loading are never done on the RPC loop.
            let config = transcription_service.prepare_live_whisper(
                &recording_store,
                &model_manager,
                recording_id,
            )?;
            let subscription = capture_manager.subscribe_live_pcm(recording_id)?;
            let detach = subscription.detach_handle();
            let dropped_pcm_chunk_count = subscription.dropped_chunk_counter();
            let cancellation = Arc::new(AtomicBool::new(false));
            let worker_cancellation = cancellation.clone();
            let failure_code = Arc::new(Mutex::new(None));
            let worker_failure_code = failure_code.clone();
            let worker_recording_id = recording_id.to_string();
            let (done_tx, done_rx) = mpsc::channel();
            let join = thread::spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_live_asr_worker(
                        &worker_recording_id,
                        subscription,
                        model_manager,
                        config,
                        live_transcript.clone(),
                        worker_cancellation,
                    )
                }));
                let failure = match result {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(error.code),
                    Err(_) => Some("LIVE_TRANSCRIPT_PRODUCER_PANICKED"),
                };
                if let Some(code) = failure {
                    if let Ok(mut stored) = worker_failure_code.lock() {
                        *stored = Some(code);
                    }
                }
                let _ = live_transcript.producer_stopped(&worker_recording_id);
                let _ = done_tx.send(());
            });
            self.workers.insert(
                recording_id.to_string(),
                LiveAsrWorker {
                    cancellation,
                    detach: Some(detach),
                    dropped_pcm_chunk_count,
                    failure_code,
                    done: done_rx,
                    join: Some(join),
                },
            );
            Ok(())
        }
    }

    pub(crate) fn stop(&mut self, recording_id: &str) -> LiveAsrStopOutcome {
        let Some(worker) = self.workers.remove(recording_id) else {
            return LiveAsrStopOutcome::default();
        };
        cancel_and_reap(worker, LIVE_ASR_JOIN_BUDGET)
    }

    pub(crate) fn stop_all(&mut self) -> Vec<LiveAsrStopOutcome> {
        let workers = std::mem::take(&mut self.workers);
        workers
            .into_values()
            .map(|worker| cancel_and_reap(worker, LIVE_ASR_JOIN_BUDGET))
            .collect()
    }

    #[cfg(feature = "local-whisper")]
    fn reap_completed(&mut self) {
        let completed = self
            .workers
            .iter()
            .filter(|(_, worker)| worker.done.try_recv().is_ok())
            .map(|(recording_id, _)| recording_id.clone())
            .collect::<Vec<_>>();
        for recording_id in completed {
            if let Some(mut worker) = self.workers.remove(&recording_id) {
                if let Some(join) = worker.join.take() {
                    let _ = join.join();
                }
            }
        }
    }
}

impl Drop for LiveAsrProducerManager {
    fn drop(&mut self) {
        let _ = self.stop_all();
    }
}

fn cancel_and_reap(mut worker: LiveAsrWorker, budget: Duration) -> LiveAsrStopOutcome {
    worker.cancellation.store(true, Ordering::SeqCst);
    if let Some(detach) = worker.detach.take() {
        detach.detach();
    }
    let dropped_pcm_chunk_count = worker.dropped_pcm_chunk_count.load(Ordering::Relaxed);
    let completed = match worker.done.recv_timeout(budget) {
        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => true,
        Err(mpsc::RecvTimeoutError::Timeout) => false,
    };
    let failure_code = worker.failure_code.lock().ok().and_then(|value| *value);
    if completed {
        if let Some(join) = worker.join.take() {
            let _ = join.join();
        }
    } else if let Some(join) = worker.join.take() {
        // A dedicated reaper owns every timed-out join. Capture finalization is
        // never held hostage by model verification or an inference unwind.
        thread::spawn(move || {
            let _ = join.join();
        });
    }
    LiveAsrStopOutcome {
        worker_found: true,
        cancellation_requested: true,
        joined_within_budget: completed,
        join_deferred: !completed,
        dropped_pcm_chunk_count,
        failure_code,
    }
}

#[cfg(any(feature = "local-whisper", test))]
#[derive(Debug)]
struct MixedLivePcmWindow {
    start_ms: u64,
    samples: Vec<f32>,
}

#[cfg(any(feature = "local-whisper", test))]
#[derive(Debug)]
struct AlignedLivePcmLane {
    samples: Vec<f32>,
    present: Vec<bool>,
    watermark: usize,
}

#[cfg(any(feature = "local-whisper", test))]
impl Default for AlignedLivePcmLane {
    fn default() -> Self {
        Self {
            samples: vec![0.0; LIVE_ASR_MAX_WINDOW_SAMPLES],
            present: vec![false; LIVE_ASR_MAX_WINDOW_SAMPLES],
            watermark: 0,
        }
    }
}

#[cfg(any(feature = "local-whisper", test))]
impl AlignedLivePcmLane {
    fn clear(&mut self) {
        self.samples.fill(0.0);
        self.present.fill(false);
        self.watermark = 0;
    }

    fn shift_right(&mut self, sample_count: usize) {
        if sample_count >= LIVE_ASR_MAX_WINDOW_SAMPLES {
            self.clear();
            return;
        }
        let retained = LIVE_ASR_MAX_WINDOW_SAMPLES - sample_count;
        self.samples.copy_within(..retained, sample_count);
        self.present.copy_within(..retained, sample_count);
        self.samples[..sample_count].fill(0.0);
        self.present[..sample_count].fill(false);
        self.watermark = self
            .watermark
            .saturating_add(sample_count)
            .min(LIVE_ASR_MAX_WINDOW_SAMPLES);
    }

    fn write(&mut self, offset: usize, samples: &[f32]) {
        if offset >= LIVE_ASR_MAX_WINDOW_SAMPLES || samples.is_empty() {
            return;
        }
        let sample_count = samples.len().min(LIVE_ASR_MAX_WINDOW_SAMPLES - offset);
        let end = offset + sample_count;
        self.samples[offset..end].copy_from_slice(&samples[..sample_count]);
        self.present[offset..end].fill(true);
        self.watermark = self.watermark.max(end);
    }

    fn advance_window(&mut self) {
        let retained = LIVE_ASR_MAX_WINDOW_SAMPLES - LIVE_ASR_WINDOW_SAMPLES;
        self.samples.copy_within(LIVE_ASR_WINDOW_SAMPLES.., 0);
        self.present.copy_within(LIVE_ASR_WINDOW_SAMPLES.., 0);
        self.samples[retained..].fill(0.0);
        self.present[retained..].fill(false);
        self.watermark = self.watermark.saturating_sub(LIVE_ASR_WINDOW_SAMPLES);
    }
}

#[cfg(any(feature = "local-whisper", test))]
#[derive(Debug, Default)]
struct CombinedLivePcmWindowMixer {
    window_start_ms: Option<u64>,
    microphone: AlignedLivePcmLane,
    system: AlignedLivePcmLane,
    emitted_any: bool,
}

#[cfg(any(feature = "local-whisper", test))]
impl CombinedLivePcmWindowMixer {
    fn push(
        &mut self,
        source: CaptureSource,
        mut start_ms: u64,
        mut samples: &[f32],
    ) -> Option<MixedLivePcmWindow> {
        if samples.is_empty() {
            return None;
        }
        let mut window_start_ms = *self.window_start_ms.get_or_insert(start_ms);
        if start_ms < window_start_ms {
            let earlier_by = milliseconds_to_samples(window_start_ms - start_ms);
            if !self.emitted_any {
                if earlier_by >= LIVE_ASR_MAX_WINDOW_SAMPLES {
                    self.microphone.clear();
                    self.system.clear();
                } else {
                    self.microphone.shift_right(earlier_by);
                    self.system.shift_right(earlier_by);
                }
                self.window_start_ms = Some(start_ms);
                window_start_ms = start_ms;
            } else {
                let trim = earlier_by.min(samples.len());
                samples = &samples[trim..];
                start_ms = window_start_ms;
                if samples.is_empty() {
                    return None;
                }
            }
        }

        let mut offset = milliseconds_to_samples(start_ms.saturating_sub(window_start_ms));
        if offset >= LIVE_ASR_MAX_WINDOW_SAMPLES {
            self.microphone.clear();
            self.system.clear();
            self.window_start_ms = Some(start_ms);
            window_start_ms = start_ms;
            offset = 0;
        }
        match source {
            CaptureSource::Mic => self.microphone.write(offset, samples),
            CaptureSource::System => self.system.write(offset, samples),
        }

        if self.microphone.watermark < LIVE_ASR_WINDOW_SAMPLES
            || self.system.watermark < LIVE_ASR_WINDOW_SAMPLES
        {
            return None;
        }

        let mixed = (0..LIVE_ASR_WINDOW_SAMPLES)
            .map(|index| {
                mix_aligned_live_sample(
                    self.microphone.present[index].then_some(self.microphone.samples[index]),
                    self.system.present[index].then_some(self.system.samples[index]),
                )
            })
            .collect::<Vec<_>>();
        self.microphone.advance_window();
        self.system.advance_window();
        self.window_start_ms =
            Some(window_start_ms.saturating_add(samples_to_ms(LIVE_ASR_WINDOW_SAMPLES)));
        self.emitted_any = true;
        Some(MixedLivePcmWindow {
            start_ms: window_start_ms,
            samples: mixed,
        })
    }
}

#[cfg(any(feature = "local-whisper", test))]
fn mix_aligned_live_sample(microphone: Option<f32>, system: Option<f32>) -> f32 {
    match (microphone, system) {
        (Some(microphone), Some(system)) => ((microphone + system) * 0.5).clamp(-1.0, 1.0),
        (Some(microphone), None) => microphone.clamp(-1.0, 1.0),
        (None, Some(system)) => system.clamp(-1.0, 1.0),
        (None, None) => 0.0,
    }
}

#[cfg(feature = "local-whisper")]
#[allow(clippy::too_many_arguments)]
fn run_live_asr_worker(
    recording_id: &str,
    subscription: LivePcmSubscription,
    model_manager: ModelManager,
    config: LiveWhisperConfig,
    live_transcript: LiveTranscriptService,
    cancellation: Arc<AtomicBool>,
) -> Result<(), LiveAsrProducerError> {
    use whisper_rs::{WhisperContext, WhisperContextParameters};

    if cancellation.load(Ordering::SeqCst) {
        return Ok(());
    }
    let context = WhisperContext::new_with_params(
        &config.verified_model.path,
        WhisperContextParameters::default(),
    )
    .map_err(|error| {
        LiveAsrProducerError::new("LIVE_TRANSCRIPT_MODEL_LOAD_FAILED", error.to_string())
    })?;
    let _runtime_load = model_manager.mark_runtime_loaded(&config.verified_model.model_id);
    let mut whisper_state = context.create_state().map_err(|error| {
        LiveAsrProducerError::new("LIVE_TRANSCRIPT_ENGINE_FAILED", error.to_string())
    })?;

    let mut last_emitted_end_ms = 0_u64;
    if subscription.combines_sources() {
        let mut mixer = CombinedLivePcmWindowMixer::default();
        loop {
            if cancellation.load(Ordering::SeqCst) {
                break;
            }
            let chunk = match subscription.receiver.recv_timeout(LIVE_ASR_RECEIVE_POLL) {
                Ok(chunk) => chunk,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let mut samples = live_pcm16le_to_mono_16k(
                &chunk.bytes,
                chunk.sample_rate_hz,
                chunk.channel_count,
                16,
            )?;
            if samples.is_empty() {
                continue;
            }
            if samples.len() > LIVE_ASR_MAX_WINDOW_SAMPLES {
                samples.truncate(LIVE_ASR_MAX_WINDOW_SAMPLES);
            }
            let Some(window) = mixer.push(chunk.source, chunk.start_ms, &samples) else {
                continue;
            };
            transcribe_window(
                recording_id,
                &config,
                &mut whisper_state,
                &window.samples,
                window.start_ms,
                &mut last_emitted_end_ms,
                &live_transcript,
                &cancellation,
            )?;
        }
        return Ok(());
    }

    let mut window_start_ms: Option<u64> = None;
    let mut window_samples = Vec::<f32>::with_capacity(LIVE_ASR_MAX_WINDOW_SAMPLES);
    loop {
        if cancellation.load(Ordering::SeqCst) {
            break;
        }
        let chunk = match subscription.receiver.recv_timeout(LIVE_ASR_RECEIVE_POLL) {
            Ok(chunk) => chunk,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let mut samples =
            live_pcm16le_to_mono_16k(&chunk.bytes, chunk.sample_rate_hz, chunk.channel_count, 16)?;
        if samples.is_empty() {
            continue;
        }
        if samples.len() > LIVE_ASR_MAX_WINDOW_SAMPLES {
            samples.truncate(LIVE_ASR_MAX_WINDOW_SAMPLES);
        }

        if let Some(start_ms) = window_start_ms {
            let expected_start_ms = start_ms.saturating_add(samples_to_ms(window_samples.len()));
            let discontinuity = chunk.start_ms
                > expected_start_ms.saturating_add(LIVE_ASR_GAP_TOLERANCE_MS)
                || expected_start_ms > chunk.start_ms.saturating_add(LIVE_ASR_GAP_TOLERANCE_MS);
            if discontinuity
                || window_samples.len().saturating_add(samples.len()) > LIVE_ASR_MAX_WINDOW_SAMPLES
            {
                if window_samples.len() >= LIVE_ASR_MIN_WINDOW_SAMPLES {
                    transcribe_window(
                        recording_id,
                        &config,
                        &mut whisper_state,
                        &window_samples,
                        start_ms,
                        &mut last_emitted_end_ms,
                        &live_transcript,
                        &cancellation,
                    )?;
                }
                window_samples.clear();
                window_start_ms = None;
            }
        }
        if window_start_ms.is_none() {
            window_start_ms = Some(chunk.start_ms);
        }
        window_samples.extend_from_slice(&samples);
        if window_samples.len() >= LIVE_ASR_WINDOW_SAMPLES {
            let start_ms = window_start_ms.expect("live ASR window start is set with samples");
            transcribe_window(
                recording_id,
                &config,
                &mut whisper_state,
                &window_samples,
                start_ms,
                &mut last_emitted_end_ms,
                &live_transcript,
                &cancellation,
            )?;
            window_samples.clear();
            window_start_ms = None;
        }
    }
    Ok(())
}

#[cfg(feature = "local-whisper")]
#[allow(clippy::too_many_arguments)]
fn transcribe_window(
    recording_id: &str,
    config: &LiveWhisperConfig,
    whisper_state: &mut whisper_rs::WhisperState,
    samples: &[f32],
    window_start_ms: u64,
    last_emitted_end_ms: &mut u64,
    live_transcript: &LiveTranscriptService,
    cancellation: &Arc<AtomicBool>,
) -> Result<(), LiveAsrProducerError> {
    use whisper_rs::{FullParams, SamplingStrategy};

    if cancellation.load(Ordering::SeqCst)
        || samples.len() < LIVE_ASR_MIN_WINDOW_SAMPLES
        || is_silent(samples)
    {
        return Ok(());
    }
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let threads = thread::available_parallelism()
        .map(|count| (count.get() / 2).clamp(1, 4) as i32)
        .unwrap_or(2);
    params.set_n_threads(threads);
    params.set_language((config.language != "auto").then_some(config.language.as_str()));
    params.set_translate(false);
    params.set_no_context(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_tdrz_enable(false);
    if let Some(prompt) = config.initial_prompt.as_deref() {
        params.set_initial_prompt(prompt);
    }
    let abort = cancellation.clone();
    let abort_callback: Box<dyn FnMut() -> bool> = Box::new(move || abort.load(Ordering::SeqCst));
    params.set_abort_callback_safe::<_, Box<dyn FnMut() -> bool>>(Some(abort_callback));
    if let Err(error) = whisper_state.full(params, samples) {
        if cancellation.load(Ordering::SeqCst) {
            return Ok(());
        }
        return Err(LiveAsrProducerError::new(
            "LIVE_TRANSCRIPT_ENGINE_FAILED",
            error.to_string(),
        ));
    }
    if cancellation.load(Ordering::SeqCst) {
        return Ok(());
    }

    let window_end_ms = window_start_ms.saturating_add(samples_to_ms(samples.len()));
    for index in 0..whisper_state.full_n_segments() {
        if cancellation.load(Ordering::SeqCst) {
            break;
        }
        let Some(segment) = whisper_state.get_segment(index) else {
            continue;
        };
        let mut text = segment
            .to_str_lossy()
            .map(|text| text.trim().to_string())
            .unwrap_or_default();
        if let Some(rule_set) = config.replacement_rule_set.as_ref() {
            text = normalize_transcript_text(rule_set, &text)
                .map_err(|error| LiveAsrProducerError::new(error.code, error.message))?
                .normalized_text;
        }
        text = bounded_utf8(text.trim(), LIVE_ASR_MAX_SEGMENT_TEXT_BYTES);
        if text.is_empty() {
            continue;
        }
        let local_start_ms = centiseconds_to_ms(segment.start_timestamp());
        let local_end_ms = centiseconds_to_ms(segment.end_timestamp());
        let start_ms = window_start_ms
            .saturating_add(local_start_ms)
            .max(*last_emitted_end_ms);
        if start_ms >= window_end_ms {
            continue;
        }
        let end_ms = window_start_ms
            .saturating_add(local_end_ms)
            .max(start_ms.saturating_add(1))
            .min(window_end_ms);
        match live_transcript.push_internal(
            recording_id,
            InternalPartialTranscript::from_trusted_asr(start_ms, end_ms, text),
        ) {
            Ok(_) => *last_emitted_end_ms = end_ms,
            Err(error) if error.code == "LIVE_TRANSCRIPT_EVENT_LIMIT" => {
                // Fixed event delivery also drops newest under backpressure. The
                // durable recording and existing provisional text are untouched.
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(any(feature = "local-whisper", test))]
fn samples_to_ms(sample_count: usize) -> u64 {
    u64::try_from(sample_count)
        .unwrap_or(u64::MAX)
        .saturating_mul(1_000)
        / LIVE_ASR_SAMPLE_RATE_HZ as u64
}

#[cfg(any(feature = "local-whisper", test))]
fn milliseconds_to_samples(milliseconds: u64) -> usize {
    usize::try_from(milliseconds.saturating_mul(LIVE_ASR_SAMPLE_RATE_HZ as u64) / 1_000)
        .unwrap_or(usize::MAX)
}

#[cfg(feature = "local-whisper")]
fn centiseconds_to_ms(value: i64) -> u64 {
    if value <= 0 {
        0
    } else {
        (value as u64).saturating_mul(10)
    }
}

#[cfg(any(feature = "local-whisper", test))]
fn is_silent(samples: &[f32]) -> bool {
    if samples.is_empty() {
        return true;
    }
    let mean_square =
        samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32;
    mean_square.sqrt() < LIVE_ASR_SILENCE_RMS
}

#[cfg(any(feature = "local-whisper", test))]
fn bounded_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value[..boundary].trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn helper_bounds_are_utf8_safe_and_silence_is_rejected() {
        assert_eq!(bounded_utf8("hello", 5), "hello");
        assert_eq!(bounded_utf8("aéb", 2), "a");
        assert!(is_silent(&vec![0.0; LIVE_ASR_MIN_WINDOW_SAMPLES]));
        assert!(!is_silent(&vec![0.1; LIVE_ASR_MIN_WINDOW_SAMPLES]));
        assert_eq!(samples_to_ms(80_000), 5_000);
    }

    #[test]
    fn combined_live_pcm_mixer_aligns_overlapping_sources_into_one_window() {
        let mut mixer = CombinedLivePcmWindowMixer::default();
        assert!(mixer
            .push(CaptureSource::Mic, 0, &vec![0.8; LIVE_ASR_WINDOW_SAMPLES],)
            .is_none());
        let window = mixer
            .push(
                CaptureSource::System,
                0,
                &vec![0.2; LIVE_ASR_WINDOW_SAMPLES],
            )
            .expect("both source watermarks complete one aligned window");

        assert_eq!(window.start_ms, 0);
        assert_eq!(window.samples.len(), LIVE_ASR_WINDOW_SAMPLES);
        assert!(window
            .samples
            .iter()
            .all(|sample| (*sample - 0.5).abs() < f32::EPSILON));
    }

    #[test]
    fn combined_live_pcm_mixer_retains_non_overlapping_audio_from_each_source() {
        let mut mixer = CombinedLivePcmWindowMixer::default();
        assert!(mixer
            .push(
                CaptureSource::Mic,
                0,
                &vec![0.75; LIVE_ASR_WINDOW_SAMPLES / 2],
            )
            .is_none());
        assert!(mixer.push(CaptureSource::Mic, 4_999, &[0.75; 16]).is_none());
        let window = mixer
            .push(
                CaptureSource::System,
                2_500,
                &vec![0.25; LIVE_ASR_WINDOW_SAMPLES / 2],
            )
            .expect("both lanes reached the aligned window boundary");

        assert!((window.samples[1_000] - 0.75).abs() < f32::EPSILON);
        assert!((window.samples[60_000] - 0.25).abs() < f32::EPSILON);
    }

    #[test]
    fn cancellation_never_waits_beyond_the_join_budget() {
        let cancellation = Arc::new(AtomicBool::new(false));
        let thread_cancellation = cancellation.clone();
        let (done_tx, done_rx) = mpsc::channel();
        let join = thread::spawn(move || {
            while !thread_cancellation.load(Ordering::SeqCst) {
                thread::yield_now();
            }
            let _ = done_tx.send(());
        });
        let worker = LiveAsrWorker {
            cancellation,
            detach: None,
            dropped_pcm_chunk_count: Arc::new(AtomicU64::new(3)),
            failure_code: Arc::new(Mutex::new(None)),
            done: done_rx,
            join: Some(join),
        };
        let started = Instant::now();
        let outcome = cancel_and_reap(worker, Duration::from_millis(100));
        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(outcome.cancellation_requested);
        assert!(outcome.joined_within_budget);
        assert_eq!(outcome.dropped_pcm_chunk_count, 3);
    }

    #[test]
    fn non_cooperative_worker_is_detached_to_an_owned_reaper() {
        let cancellation = Arc::new(AtomicBool::new(false));
        let (done_tx, done_rx) = mpsc::channel();
        let join = thread::spawn(move || {
            thread::sleep(Duration::from_millis(75));
            let _ = done_tx.send(());
        });
        let worker = LiveAsrWorker {
            cancellation,
            detach: None,
            dropped_pcm_chunk_count: Arc::new(AtomicU64::new(0)),
            failure_code: Arc::new(Mutex::new(None)),
            done: done_rx,
            join: Some(join),
        };
        let started = Instant::now();
        let outcome = cancel_and_reap(worker, Duration::from_millis(5));
        assert!(started.elapsed() < Duration::from_millis(50));
        assert!(outcome.join_deferred);
        assert!(!outcome.joined_within_budget);
    }
}
