use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use screencapturekit::prelude::*;
use screencapturekit::stream::delegate_trait::ErrorHandler;

use super::{
    float32_audio_buffers_to_pcm16, flush_all_audio, flush_pending_audio, CaptureError,
    CaptureRuntimeInfo, CaptureSink, CaptureSource, CAPTURE_CALLBACK_QUEUE_CAPACITY,
    CAPTURE_POLL_TIMEOUT,
};

const SAMPLE_RATE_HZ: u32 = 48_000;
const CHANNEL_COUNT: u16 = 2;

pub(super) fn run_system_capture(
    sink: CaptureSink,
    device_id: Option<String>,
    chunk_ms: u64,
    stop: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<CaptureRuntimeInfo, CaptureError>>,
) -> Result<(), CaptureError> {
    validate_device_id(device_id.as_deref())
        .map_err(|error| announce_start_error(&ready_tx, error))?;

    let content = SCShareableContent::get().map_err(|error| {
        announce_start_error(
            &ready_tx,
            CaptureError::new(
                "CAPTURE_SCREEN_PERMISSION_REQUIRED",
                format!("Screen & System Audio Recording permission is required: {error}"),
            ),
        )
    })?;
    let display = content.displays().into_iter().next().ok_or_else(|| {
        announce_start_error(
            &ready_tx,
            CaptureError::new(
                "CAPTURE_NO_DISPLAY",
                "no display was available for ScreenCaptureKit system audio",
            ),
        )
    })?;
    let display_id = display.display_id();
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .try_build()
        .map_err(|error| {
            announce_start_error(
                &ready_tx,
                CaptureError::new("CAPTURE_STREAM_FILTER_FAILED", error.to_string()),
            )
        })?;
    let configuration = SCStreamConfiguration::new()
        .with_captures_audio(true)
        .with_excludes_current_process_audio(true)
        .with_sample_rate(SAMPLE_RATE_HZ as i32)
        .with_channel_count(i32::from(CHANNEL_COUNT));

    let callback_error = Arc::new(Mutex::new(None::<String>));
    let delegate_error = callback_error.clone();
    let delegate = ErrorHandler::new(move |error| {
        set_callback_error(
            &delegate_error,
            format!("ScreenCaptureKit stopped unexpectedly: {error}"),
        );
    });
    let mut stream = SCStream::new_with_delegate(&filter, &configuration, delegate);

    let (audio_tx, audio_rx) = mpsc::sync_channel::<Vec<u8>>(CAPTURE_CALLBACK_QUEUE_CAPACITY);
    let handler_error = callback_error.clone();
    let handler_id = stream.add_output_handler(
        move |sample: CMSampleBuffer, _output_type: SCStreamOutputType| {
            let bytes = match sample_to_pcm16(&sample) {
                Ok(bytes) => bytes,
                Err(error) => {
                    set_callback_error(&handler_error, error.message);
                    return;
                }
            };
            if bytes.is_empty() {
                return;
            }
            match audio_tx.try_send(bytes) {
                Ok(()) => {}
                Err(mpsc::TrySendError::Full(_)) => set_callback_error(
                    &handler_error,
                    "ScreenCaptureKit audio queue overflowed before a durable write".to_string(),
                ),
                Err(mpsc::TrySendError::Disconnected(_)) => {}
            }
        },
        SCStreamOutputType::Audio,
    );
    if handler_id.is_none() {
        return Err(announce_start_error(
            &ready_tx,
            CaptureError::new(
                "CAPTURE_STREAM_CREATE_FAILED",
                "ScreenCaptureKit rejected the system audio output handler",
            ),
        ));
    }

    stream.start_capture().map_err(|error| {
        announce_start_error(
            &ready_tx,
            CaptureError::new("CAPTURE_STREAM_PLAY_FAILED", error.to_string()),
        )
    })?;
    ready_tx
        .send(Ok(CaptureRuntimeInfo {
            source: CaptureSource::System.label(),
            device_label: format!("System audio (display {display_id})"),
            sample_rate_hz: SAMPLE_RATE_HZ,
            channel_count: CHANNEL_COUNT,
            chunk_ms,
        }))
        .ok();

    let frame_bytes = usize::from(CHANNEL_COUNT) * 2;
    let target_bytes = target_chunk_bytes(chunk_ms, frame_bytes);
    let mut pending = Vec::<u8>::new();
    let mut frames_written = 0_u64;
    let mut capture_error = None;

    while !stop.load(Ordering::SeqCst) {
        if let Some(message) = take_callback_error(&callback_error) {
            capture_error = Some(CaptureError::new("CAPTURE_STREAM_ERROR", message));
            break;
        }
        match audio_rx.recv_timeout(CAPTURE_POLL_TIMEOUT) {
            Ok(bytes) => pending.extend_from_slice(&bytes),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if let Err(error) = flush_pending_audio(
            &sink,
            CaptureSource::System,
            SAMPLE_RATE_HZ,
            CHANNEL_COUNT,
            frame_bytes,
            target_bytes,
            &mut frames_written,
            &mut pending,
        ) {
            capture_error = Some(error);
            break;
        }
    }

    let stop_error = stream
        .stop_capture()
        .err()
        .map(|error| CaptureError::new("CAPTURE_STREAM_STOP_FAILED", error.to_string()));
    drop(stream);
    loop {
        match audio_rx.recv_timeout(CAPTURE_POLL_TIMEOUT) {
            Ok(bytes) => pending.extend_from_slice(&bytes),
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let flush_error = flush_all_audio(
        &sink,
        CaptureSource::System,
        SAMPLE_RATE_HZ,
        CHANNEL_COUNT,
        frame_bytes,
        &mut frames_written,
        &mut pending,
    )
    .err();

    if let Some(error) = capture_error.or(stop_error).or(flush_error) {
        return Err(error);
    }
    Ok(())
}

fn sample_to_pcm16(sample: &CMSampleBuffer) -> Result<Vec<u8>, CaptureError> {
    if !sample.is_valid() || !sample.data_is_ready() {
        return Ok(Vec::new());
    }
    let format = sample.format_description().ok_or_else(|| {
        CaptureError::new(
            "CAPTURE_SAMPLE_FORMAT_UNSUPPORTED",
            "ScreenCaptureKit audio did not include a format description",
        )
    })?;
    let sample_rate = format.audio_sample_rate().unwrap_or_default().round() as u32;
    let channel_count = format.audio_channel_count().unwrap_or_default() as u16;
    if !format.is_pcm()
        || !format.audio_is_float()
        || format.audio_is_big_endian()
        || format.audio_bits_per_channel() != Some(32)
        || sample_rate != SAMPLE_RATE_HZ
        || channel_count != CHANNEL_COUNT
    {
        return Err(CaptureError::new(
            "CAPTURE_SAMPLE_FORMAT_UNSUPPORTED",
            format!(
                "ScreenCaptureKit returned unsupported audio format: codec={}, rate={sample_rate}, channels={channel_count}, bits={:?}, float={}, bigEndian={}",
                format.media_subtype_string(),
                format.audio_bits_per_channel(),
                format.audio_is_float(),
                format.audio_is_big_endian(),
            ),
        ));
    }
    let audio_buffers = sample.audio_buffer_list().ok_or_else(|| {
        CaptureError::new(
            "CAPTURE_AUDIO_BUFFER_INVALID",
            "ScreenCaptureKit audio sample did not contain an AudioBufferList",
        )
    })?;
    let buffers = audio_buffers
        .iter()
        .map(|buffer| (buffer.data(), buffer.number_channels))
        .collect::<Vec<_>>();
    float32_audio_buffers_to_pcm16(&buffers, channel_count)
}

fn validate_device_id(device_id: Option<&str>) -> Result<(), CaptureError> {
    if device_id.is_some_and(|id| !id.trim().is_empty() && id != "default") {
        return Err(CaptureError::new(
            "CAPTURE_DEVICE_ID_INVALID",
            "macOS ScreenCaptureKit system audio device id must be default",
        ));
    }
    Ok(())
}

fn target_chunk_bytes(chunk_ms: u64, frame_bytes: usize) -> usize {
    let bytes = (u64::from(SAMPLE_RATE_HZ)
        .saturating_mul(u64::from(CHANNEL_COUNT))
        .saturating_mul(2)
        .saturating_mul(chunk_ms)
        / 1000)
        .max(frame_bytes as u64) as usize;
    bytes - (bytes % frame_bytes)
}

fn announce_start_error(
    ready_tx: &mpsc::Sender<Result<CaptureRuntimeInfo, CaptureError>>,
    error: CaptureError,
) -> CaptureError {
    ready_tx
        .send(Err(CaptureError::new(error.code, error.message.clone())))
        .ok();
    error
}

fn set_callback_error(error_slot: &Arc<Mutex<Option<String>>>, message: String) {
    if let Ok(mut error_slot) = error_slot.lock() {
        if error_slot.is_none() {
            *error_slot = Some(message);
        }
    }
}

fn take_callback_error(error_slot: &Arc<Mutex<Option<String>>>) -> Option<String> {
    error_slot.lock().ok().and_then(|mut slot| slot.take())
}
