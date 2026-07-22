use std::fs::File;
use std::io::{Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};

use symphonia::core::audio::GenericAudioBufferRef;
use symphonia::core::codecs::audio::well_known::{
    CODEC_ID_AAC, CODEC_ID_ALAC, CODEC_ID_MP3, CODEC_ID_VORBIS,
};
use symphonia::core::codecs::audio::{AudioCodecId, AudioDecoderOptions};
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, Track, TrackFlags};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;

use crate::media_import::{MediaKind, MAX_IMPORT_DURATION_MS};

pub(crate) const MAX_DECODED_PCM_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub(crate) const MAX_DECODE_PACKETS: u64 = 5_000_000;
pub(crate) const MAX_DECODE_BUFFER_SAMPLES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_CONTAINER_TRACKS: usize = 128;
const DECODER_STREAM_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MediaDecoderError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl MediaDecoderError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CompressedMediaProbe {
    pub(crate) duration_ms: Option<u64>,
    pub(crate) sample_rate_hz: Option<u32>,
    pub(crate) channel_count: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DecodedMediaSummary {
    pub(crate) duration_ms: u64,
    pub(crate) sample_rate_hz: u32,
    pub(crate) channel_count: u16,
    pub(crate) decoded_pcm_bytes: u64,
    pub(crate) packet_count: u64,
}

struct OpenDecoder {
    format: Box<dyn FormatReader>,
    track_id: u32,
    codec_params: symphonia::core::codecs::audio::AudioCodecParameters,
    duration_ms: Option<u64>,
}

pub(crate) fn probe_compressed_media(
    mut file: File,
    media_kind: MediaKind,
) -> Result<CompressedMediaProbe, MediaDecoderError> {
    file.seek(SeekFrom::Start(0)).map_err(|_| {
        MediaDecoderError::new(
            "MEDIA_IMPORT_SOURCE_SEEK_FAILED",
            "the selected media source could not be traversed safely",
        )
    })?;
    let opened = open_decoder(file, media_kind)?;

    // Constructing the decoder here proves that this build actually registered the selected
    // in-process codec. No packet is decoded during inspection.
    symphonia::default::get_codecs()
        .make_audio_decoder(&opened.codec_params, &AudioDecoderOptions::default())
        .map_err(|_| unsupported_codec(media_kind))?;

    let sample_rate_hz = opened
        .codec_params
        .sample_rate
        .filter(|rate| (8_000..=192_000).contains(rate));
    let channel_count = opened
        .codec_params
        .channels
        .as_ref()
        .and_then(|channels| u16::try_from(channels.count()).ok())
        .filter(|count| (1..=8).contains(count));

    if opened.codec_params.sample_rate.is_some() && sample_rate_hz.is_none() {
        return Err(MediaDecoderError::new(
            "MEDIA_IMPORT_AUDIO_FORMAT_UNSUPPORTED",
            "decoded audio must use a sample rate between 8 and 192 kHz",
        ));
    }
    if opened.codec_params.channels.is_some() && channel_count.is_none() {
        return Err(MediaDecoderError::new(
            "MEDIA_IMPORT_AUDIO_FORMAT_UNSUPPORTED",
            "decoded audio must contain between one and eight channels",
        ));
    }

    Ok(CompressedMediaProbe {
        duration_ms: opened.duration_ms,
        sample_rate_hz,
        channel_count,
    })
}

pub(crate) fn decode_compressed_media<F>(
    mut file: File,
    media_kind: MediaKind,
    cancellation: &AtomicBool,
    mut consume_pcm16: F,
) -> Result<DecodedMediaSummary, MediaDecoderError>
where
    F: FnMut(&[u8], u32, u16, u64) -> Result<(), MediaDecoderError>,
{
    file.seek(SeekFrom::Start(0)).map_err(|_| {
        MediaDecoderError::new(
            "MEDIA_IMPORT_SOURCE_SEEK_FAILED",
            "the selected media source could not be traversed safely",
        )
    })?;
    let mut opened = open_decoder(file, media_kind)?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&opened.codec_params, &AudioDecoderOptions::default())
        .map_err(|_| unsupported_codec(media_kind))?;

    let mut decoded_spec: Option<(u32, u16)> = None;
    let mut samples = Vec::<i16>::new();
    let mut pcm_chunk =
        Vec::<u8>::with_capacity(crate::media_import_service::IMPORT_PCM_CHUNK_BYTES);
    let mut decoded_pcm_bytes = 0_u64;
    let mut decoded_frames = 0_u64;
    let mut packet_count = 0_u64;

    loop {
        if cancellation.load(Ordering::SeqCst) {
            return Err(cancelled_error());
        }
        let packet = match opened.format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::ResetRequired) => {
                return Err(MediaDecoderError::new(
                    "MEDIA_IMPORT_STREAM_CHANGED",
                    "the selected media changes tracks or format while decoding",
                ));
            }
            Err(_) => return Err(decode_failed()),
        };
        packet_count = packet_count.checked_add(1).ok_or_else(packet_limit_error)?;
        if packet_count > MAX_DECODE_PACKETS {
            return Err(packet_limit_error());
        }
        if packet.track_id != opened.track_id {
            continue;
        }

        let decoded = decoder.decode(&packet).map_err(|error| match error {
            SymphoniaError::Unsupported(_) => unsupported_codec(media_kind),
            SymphoniaError::ResetRequired => MediaDecoderError::new(
                "MEDIA_IMPORT_STREAM_CHANGED",
                "the decoded audio format changed while importing",
            ),
            _ => decode_failed(),
        })?;
        if decoded.frames() == 0 {
            continue;
        }
        let (sample_rate_hz, channel_count) = validated_output_spec(&decoded)?;
        match decoded_spec {
            Some(previous) if previous != (sample_rate_hz, channel_count) => {
                return Err(MediaDecoderError::new(
                    "MEDIA_IMPORT_STREAM_CHANGED",
                    "the decoded audio sample rate or channel layout changed while importing",
                ));
            }
            None => decoded_spec = Some((sample_rate_hz, channel_count)),
            _ => {}
        }

        let sample_count = decoded.samples_interleaved();
        if sample_count == 0 || sample_count > MAX_DECODE_BUFFER_SAMPLES {
            return Err(MediaDecoderError::new(
                "MEDIA_IMPORT_DECODE_BUFFER_LIMIT",
                "a decoded media packet exceeds the in-memory sample limit",
            ));
        }
        let frame_count = u64::try_from(decoded.frames()).map_err(|_| decode_limit_error())?;
        let next_frames = decoded_frames
            .checked_add(frame_count)
            .ok_or_else(decode_limit_error)?;
        let duration_ms = next_frames
            .checked_mul(1_000)
            .ok_or_else(decode_limit_error)?
            / u64::from(sample_rate_hz);
        if duration_ms > MAX_IMPORT_DURATION_MS {
            return Err(MediaDecoderError::new(
                "MEDIA_IMPORT_DURATION_LIMIT",
                "media duration exceeds the import limit",
            ));
        }

        let decoded_bytes = u64::try_from(sample_count)
            .ok()
            .and_then(|count| count.checked_mul(2))
            .ok_or_else(decode_limit_error)?;
        let next_decoded_bytes = decoded_pcm_bytes
            .checked_add(decoded_bytes)
            .ok_or_else(decode_limit_error)?;
        if next_decoded_bytes > MAX_DECODED_PCM_BYTES {
            return Err(decode_limit_error());
        }

        samples.resize(sample_count, 0);
        decoded.copy_to_slice_interleaved(&mut samples);
        append_pcm16_le(
            &samples,
            &mut pcm_chunk,
            sample_rate_hz,
            channel_count,
            decoded_frames,
            cancellation,
            &mut consume_pcm16,
        )?;
        decoded_frames = next_frames;
        decoded_pcm_bytes = next_decoded_bytes;
    }

    let (sample_rate_hz, channel_count) = decoded_spec.ok_or_else(|| {
        MediaDecoderError::new(
            "MEDIA_IMPORT_AUDIO_EMPTY",
            "the selected media did not decode to any audio samples",
        )
    })?;
    if cancellation.load(Ordering::SeqCst) {
        return Err(cancelled_error());
    }
    if !pcm_chunk.is_empty() {
        let chunk_frames = u64::try_from(pcm_chunk.len())
            .ok()
            .and_then(|bytes| bytes.checked_div(u64::from(channel_count) * 2))
            .ok_or_else(decode_limit_error)?;
        let start_frame = decoded_frames.saturating_sub(chunk_frames);
        consume_pcm16(
            &pcm_chunk,
            sample_rate_hz,
            channel_count,
            frames_to_ms(start_frame, sample_rate_hz),
        )?;
    }

    Ok(DecodedMediaSummary {
        duration_ms: frames_to_ms(decoded_frames, sample_rate_hz).max(1),
        sample_rate_hz,
        channel_count,
        decoded_pcm_bytes,
        packet_count,
    })
}

fn open_decoder(file: File, media_kind: MediaKind) -> Result<OpenDecoder, MediaDecoderError> {
    let stream = MediaSourceStream::new(
        Box::new(file),
        MediaSourceStreamOptions {
            buffer_len: DECODER_STREAM_BUFFER_BYTES,
        },
    );
    let mut hint = Hint::new();
    hint.with_extension(extension_for(media_kind));
    let format = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default()
                .prebuild_seek_index(false)
                .seek_index_fill_period_ms(u16::MAX),
            MetadataOptions::default(),
        )
        .map_err(|_| {
            MediaDecoderError::new(
                "MEDIA_IMPORT_CONTAINER_UNSUPPORTED",
                "the selected media container could not be parsed by the bundled local decoder",
            )
        })?;
    if format.tracks().len() > MAX_CONTAINER_TRACKS {
        return Err(MediaDecoderError::new(
            "MEDIA_IMPORT_TRACK_LIMIT",
            "the selected media container contains too many tracks",
        ));
    }

    let track = select_supported_audio_track(format.as_ref(), media_kind)?;
    let codec_params = track
        .codec_params
        .as_ref()
        .and_then(CodecParameters::audio)
        .cloned()
        .ok_or_else(missing_audio_error)?;
    let duration_ms = track_duration_ms(track)?;
    if duration_ms.is_some_and(|duration| duration == 0 || duration > MAX_IMPORT_DURATION_MS) {
        return Err(MediaDecoderError::new(
            "MEDIA_IMPORT_DURATION_LIMIT",
            "media duration is empty or exceeds the import limit",
        ));
    }
    let track_id = track.id;

    Ok(OpenDecoder {
        format,
        track_id,
        codec_params,
        duration_ms,
    })
}

fn select_supported_audio_track(
    format: &dyn FormatReader,
    media_kind: MediaKind,
) -> Result<&Track, MediaDecoderError> {
    let audio_tracks = format
        .tracks()
        .iter()
        .filter(|track| {
            track
                .codec_params
                .as_ref()
                .is_some_and(CodecParameters::is_audio)
        })
        .collect::<Vec<_>>();
    if audio_tracks.is_empty() {
        return Err(missing_audio_error());
    }

    audio_tracks
        .iter()
        .copied()
        .find(|track| {
            track.flags.contains(TrackFlags::DEFAULT)
                && track_codec(track).is_some_and(|codec| supported_codec(media_kind, codec))
        })
        .or_else(|| {
            audio_tracks.iter().copied().find(|track| {
                track_codec(track).is_some_and(|codec| supported_codec(media_kind, codec))
            })
        })
        .ok_or_else(|| unsupported_codec(media_kind))
}

fn track_codec(track: &Track) -> Option<AudioCodecId> {
    track
        .codec_params
        .as_ref()
        .and_then(CodecParameters::audio)
        .map(|params| params.codec)
}

fn supported_codec(media_kind: MediaKind, codec: AudioCodecId) -> bool {
    match media_kind {
        MediaKind::Mp3 => codec == CODEC_ID_MP3,
        MediaKind::M4a | MediaKind::Mp4 => codec == CODEC_ID_AAC || codec == CODEC_ID_ALAC,
        MediaKind::Webm => codec == CODEC_ID_VORBIS,
        MediaKind::Wav => false,
    }
}

fn track_duration_ms(track: &Track) -> Result<Option<u64>, MediaDecoderError> {
    let (Some(time_base), Some(duration)) = (track.time_base, track.duration) else {
        return Ok(None);
    };
    let millis = u128::from(duration.get())
        .checked_mul(u128::from(time_base.numer.get()))
        .and_then(|value| value.checked_mul(1_000))
        .and_then(|value| value.checked_div(u128::from(time_base.denom.get())))
        .ok_or_else(decode_limit_error)?;
    u64::try_from(millis)
        .map(Some)
        .map_err(|_| decode_limit_error())
}

fn validated_output_spec(
    decoded: &GenericAudioBufferRef<'_>,
) -> Result<(u32, u16), MediaDecoderError> {
    let sample_rate_hz = decoded.spec().rate();
    let channel_count = u16::try_from(decoded.spec().channels().count()).map_err(|_| {
        MediaDecoderError::new(
            "MEDIA_IMPORT_AUDIO_FORMAT_UNSUPPORTED",
            "decoded audio contains too many channels",
        )
    })?;
    if !(8_000..=192_000).contains(&sample_rate_hz) || !(1..=8).contains(&channel_count) {
        return Err(MediaDecoderError::new(
            "MEDIA_IMPORT_AUDIO_FORMAT_UNSUPPORTED",
            "decoded audio must use 8-192 kHz and contain one to eight channels",
        ));
    }
    Ok((sample_rate_hz, channel_count))
}

fn append_pcm16_le<F>(
    samples: &[i16],
    chunk: &mut Vec<u8>,
    sample_rate_hz: u32,
    channel_count: u16,
    decoded_frames_before_buffer: u64,
    cancellation: &AtomicBool,
    consume_pcm16: &mut F,
) -> Result<(), MediaDecoderError>
where
    F: FnMut(&[u8], u32, u16, u64) -> Result<(), MediaDecoderError>,
{
    let frame_bytes = usize::from(channel_count) * 2;
    let chunk_limit = crate::media_import_service::IMPORT_PCM_CHUNK_BYTES
        - (crate::media_import_service::IMPORT_PCM_CHUNK_BYTES % frame_bytes);
    let mut samples_consumed = 0_usize;

    for sample in samples {
        chunk.extend_from_slice(&sample.to_le_bytes());
        samples_consumed += 1;
        if chunk.len() == chunk_limit {
            if cancellation.load(Ordering::SeqCst) {
                return Err(cancelled_error());
            }
            let frames_consumed = u64::try_from(samples_consumed / usize::from(channel_count))
                .map_err(|_| decode_limit_error())?;
            let chunk_frames =
                u64::try_from(chunk.len() / frame_bytes).map_err(|_| decode_limit_error())?;
            let start_frame = decoded_frames_before_buffer
                .checked_add(frames_consumed)
                .and_then(|value| value.checked_sub(chunk_frames))
                .ok_or_else(decode_limit_error)?;
            consume_pcm16(
                chunk,
                sample_rate_hz,
                channel_count,
                frames_to_ms(start_frame, sample_rate_hz),
            )?;
            chunk.clear();
        }
    }
    Ok(())
}

fn frames_to_ms(frames: u64, sample_rate_hz: u32) -> u64 {
    frames.saturating_mul(1_000) / u64::from(sample_rate_hz)
}

fn extension_for(media_kind: MediaKind) -> &'static str {
    match media_kind {
        MediaKind::Mp3 => "mp3",
        MediaKind::M4a => "m4a",
        MediaKind::Mp4 => "mp4",
        MediaKind::Webm => "webm",
        MediaKind::Wav => "wav",
    }
}

fn missing_audio_error() -> MediaDecoderError {
    MediaDecoderError::new(
        "MEDIA_IMPORT_AUDIO_TRACK_MISSING",
        "the selected media container does not contain a supported audio track",
    )
}

fn unsupported_codec(media_kind: MediaKind) -> MediaDecoderError {
    let supported = match media_kind {
        MediaKind::Mp3 => "MP3 audio",
        MediaKind::M4a | MediaKind::Mp4 => "AAC-LC or ALAC audio",
        MediaKind::Webm => "Vorbis audio; WebM Opus is not enabled in this pure-Rust build",
        MediaKind::Wav => "PCM16 WAV audio",
    };
    MediaDecoderError::new(
        "MEDIA_IMPORT_CODEC_UNSUPPORTED",
        format!("this local build supports {supported} for the selected container"),
    )
}

fn decode_failed() -> MediaDecoderError {
    MediaDecoderError::new(
        "MEDIA_IMPORT_DECODE_FAILED",
        "the selected media could not be decoded completely",
    )
}

fn decode_limit_error() -> MediaDecoderError {
    MediaDecoderError::new(
        "MEDIA_IMPORT_DECODE_LIMIT",
        "decoded audio exceeds the local import resource limit",
    )
}

fn packet_limit_error() -> MediaDecoderError {
    MediaDecoderError::new(
        "MEDIA_IMPORT_PACKET_LIMIT",
        "the selected media requires too many packets to decode safely",
    )
}

fn cancelled_error() -> MediaDecoderError {
    MediaDecoderError::new(
        "MEDIA_IMPORT_CANCELLED",
        "the local media import was cancelled",
    )
}
