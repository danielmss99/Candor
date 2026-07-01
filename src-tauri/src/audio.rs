use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavReader, WavSpec, WavWriter};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

use crate::Segment;

/// ~115 MB/hour at 16 kHz mono 16-bit PCM.
pub const BYTES_PER_HOUR_16K_MONO: u64 = 115 * 1024 * 1024;
/// Warn when free disk space drops below ~2 hours of recording headroom.
pub const DISK_WARN_BYTES: u64 = 250 * 1024 * 1024;
/// Read/resample this many seconds of source audio per chunk (keeps RAM bounded).
const RESAMPLE_READ_SECS: u32 = 60;
pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// TODO: Integrate RNNoise for real-time noise suppression before Whisper.
/// Blocked: needs a maintained Rust RNNoise binding tested on Windows/macOS.
pub fn preprocess_audio(samples: &[f32]) -> Vec<f32> {
    // Light DC-offset removal + gentle high-pass approximation
    if samples.is_empty() {
        return Vec::new();
    }
    let mean = samples.iter().sum::<f32>() / samples.len() as f32;
    let mut prev = 0.0f32;
    let alpha = 0.995f32;
    samples
        .iter()
        .map(|&s| {
            let x = s - mean;
            let y = alpha * (prev + x - prev);
            prev = x;
            y.clamp(-1.0, 1.0)
        })
        .collect()
}

pub fn save_wav(path: &Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer.write_sample(v).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    Ok(())
}

/// Flush underlying file every ~1s of 16-bit mono audio at the given sample rate.
struct FlushingWriter {
    inner: io::BufWriter<std::fs::File>,
    bytes_since_flush: usize,
    flush_every: usize,
}

impl FlushingWriter {
    fn new(path: &Path, sample_rate: u32) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        let flush_every = (sample_rate as usize * 2).max(8192);
        Ok(Self {
            inner: io::BufWriter::new(file),
            bytes_since_flush: 0,
            flush_every,
        })
    }
}

impl Seek for FlushingWriter {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl Write for FlushingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.bytes_since_flush += n;
        if self.bytes_since_flush >= self.flush_every {
            self.inner.flush()?;
            let _ = self.inner.get_ref().sync_all();
            self.bytes_since_flush = 0;
        }
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Incrementally writes PCM to a WAV file while recording (flushed to disk periodically).
pub struct StreamingWavWriter {
    writer: WavWriter<FlushingWriter>,
    channels: u16,
    samples_written: u64,
}

impl StreamingWavWriter {
    pub fn create(path: &Path, sample_rate: u32, channels: u16) -> Result<Self, String> {
        let ch = channels.max(1);
        let spec = WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let flushing = FlushingWriter::new(path, sample_rate)?;
        let writer = WavWriter::new(flushing, spec).map_err(|e| e.to_string())?;
        Ok(Self {
            writer,
            channels: ch,
            samples_written: 0,
        })
    }

    pub fn write_f32_interleaved(&mut self, samples: &[f32]) -> Result<(), String> {
        let ch = self.channels as usize;
        if ch == 1 {
            for &s in samples {
                let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                self.writer.write_sample(v).map_err(|e| e.to_string())?;
                self.samples_written += 1;
            }
        } else {
            for frame in samples.chunks(ch) {
                let mono = frame.iter().sum::<f32>() / frame.len() as f32;
                let v = (mono.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                self.writer.write_sample(v).map_err(|e| e.to_string())?;
                self.samples_written += 1;
            }
        }
        Ok(())
    }

    pub fn finalize(mut self) -> Result<u64, String> {
        self.writer.flush().map_err(|e| e.to_string())?;
        self.writer.finalize().map_err(|e| e.to_string())?;
        Ok(self.samples_written)
    }

    pub fn samples_written(&self) -> u64 {
        self.samples_written
    }
}

/// Duration in seconds from a finalized mono WAV (uses header sample count).
pub fn wav_duration_seconds(path: &Path) -> Result<u32, String> {
    let reader = WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let frames = reader.len() as u64 / spec.channels as u64;
    Ok((frames / spec.sample_rate as u64).min(u32::MAX as u64) as u32)
}

/// Free bytes on the volume holding `path` (Windows: GetDiskFreeSpaceEx).
pub fn free_disk_bytes(path: &Path) -> Result<u64, String> {
    let dir = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    };
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = dir
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free = 0u64;
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut free,
            )
        };
        if ok != 0 {
            Ok(free)
        } else {
            Err("Could not read disk space".into())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dir;
        Err("Disk space check not implemented on this platform".into())
    }
}

struct StreamResampler {
    ratio: f32,
    src_pos: f32,
}

impl StreamResampler {
    fn new(src_rate: u32, dst_rate: u32) -> Self {
        Self {
            ratio: dst_rate as f32 / src_rate as f32,
            src_pos: 0.0,
        }
    }

    fn process(&mut self, mono: &[f32]) -> Vec<f32> {
        if mono.is_empty() {
            return Vec::new();
        }
        let last = mono.len() - 1;
        let start_out = (self.src_pos * self.ratio).floor() as usize;
        let end_src = mono.len() as f32 - 1.0;
        let end_out = ((end_src + self.src_pos) * self.ratio).floor() as usize;
        let out_len = end_out.saturating_sub(start_out);
        let mut out = Vec::with_capacity(out_len.max(1));
        for i in 0..out_len {
            let src = (start_out + i) as f32 / self.ratio - self.src_pos;
            let i0 = src.floor() as usize;
            let i1 = (i0 + 1).min(last);
            let frac = src - i0 as f32;
            let s0 = mono.get(i0).copied().unwrap_or(0.0);
            let s1 = mono.get(i1).copied().unwrap_or(s0);
            out.push(s0 * (1.0 - frac) + s1 * frac);
        }
        self.src_pos += mono.len() as f32;
        out
    }
}

fn read_mono_from_iter(
    iter: &mut dyn Iterator<Item = Result<i16, hound::Error>>,
    max_frames: usize,
    channels: u16,
) -> Result<Vec<f32>, String> {
    let ch = channels.max(1) as usize;
    let mut mono = Vec::with_capacity(max_frames);
    for _ in 0..max_frames {
        if ch == 1 {
            match iter.next() {
                Some(Ok(v)) => mono.push(v as f32 / i16::MAX as f32),
                Some(Err(e)) => return Err(e.to_string()),
                None => break,
            }
        } else {
            let mut frame = Vec::with_capacity(ch);
            for _ in 0..ch {
                match iter.next() {
                    Some(Ok(v)) => frame.push(v as f32 / i16::MAX as f32),
                    Some(Err(e)) => return Err(e.to_string()),
                    None => break,
                }
            }
            if frame.len() < ch {
                break;
            }
            mono.push(frame.iter().sum::<f32>() / ch as f32);
        }
    }
    Ok(mono)
}

/// Resample a WAV to 16 kHz mono on disk without loading the full file into RAM.
pub fn stream_resample_wav_to_16k(source: &Path, dest: &Path) -> Result<u32, String> {
    stream_resample_mix_to_16k(source, None, dest)
}

/// Mix optional second WAV (same length, resampled independently) while writing 16 kHz mono.
pub fn stream_resample_mix_to_16k(
    mic_source: &Path,
    system_source: Option<&Path>,
    dest: &Path,
) -> Result<u32, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mic_reader = WavReader::open(mic_source).map_err(|e| e.to_string())?;
    let mic_spec = mic_reader.spec();
    let mic_sr = mic_spec.sample_rate;
    let mic_ch = mic_spec.channels;

    let mut sys_reader = if let Some(p) = system_source.filter(|p| p.exists()) {
        Some(WavReader::open(p).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let (sys_sr, sys_ch) = sys_reader
        .as_ref()
        .map(|r| (r.spec().sample_rate, r.spec().channels))
        .unwrap_or((mic_sr, mic_ch));

    let spec = WavSpec {
        channels: 1,
        sample_rate: WHISPER_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut mic_iter: Box<dyn Iterator<Item = Result<i16, hound::Error>>> =
        Box::new(mic_reader.into_samples::<i16>());
    let mut sys_iter: Option<Box<dyn Iterator<Item = Result<i16, hound::Error>>>> =
        sys_reader.map(|r| {
            Box::new(r.into_samples::<i16>()) as Box<dyn Iterator<Item = Result<i16, hound::Error>>>
        });
    let mut writer = WavWriter::create(dest, spec).map_err(|e| e.to_string())?;

    let mut mic_resampler = StreamResampler::new(mic_sr, WHISPER_SAMPLE_RATE);
    let mut sys_resampler = StreamResampler::new(sys_sr, WHISPER_SAMPLE_RATE);
    let read_frames = (mic_sr * RESAMPLE_READ_SECS).max(1024) as usize;
    let mut total_out: u64 = 0;

    loop {
        let mic_chunk = read_mono_from_iter(mic_iter.as_mut(), read_frames, mic_ch)?;
        if mic_chunk.is_empty() {
            break;
        }
        let mut mic_16k = mic_resampler.process(&mic_chunk);
        if let Some(ref mut sys_it) = sys_iter {
            let sys_chunk = read_mono_from_iter(sys_it.as_mut(), read_frames, sys_ch)?;
            if !sys_chunk.is_empty() {
                let sys_16k = sys_resampler.process(&sys_chunk);
                mic_16k = mix_mono(&mic_16k, &sys_16k);
            }
        }
        let processed = preprocess_audio(&mic_16k);
        for s in processed {
            let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            writer.write_sample(v).map_err(|e| e.to_string())?;
            total_out += 1;
        }
    }

    writer.finalize().map_err(|e| e.to_string())?;
    Ok((total_out / WHISPER_SAMPLE_RATE as u64).min(u32::MAX as u64) as u32)
}

/// Read 16 kHz mono WAV in fixed-size chunks without loading the full file.
pub struct WavChunkReader {
    samples: Box<dyn Iterator<Item = Result<i16, hound::Error>>>,
    chunk_samples: usize,
    total_frames: u64,
}

impl WavChunkReader {
    pub fn open(path: &Path, chunk_samples: usize) -> Result<Self, String> {
        let reader = WavReader::open(path).map_err(|e| e.to_string())?;
        let spec = reader.spec();
        if spec.sample_rate != WHISPER_SAMPLE_RATE || spec.channels != 1 {
            return Err(format!(
                "Expected 16 kHz mono WAV, got {} Hz {} ch",
                spec.sample_rate, spec.channels
            ));
        }
        let total_frames = reader.len() as u64;
        Ok(Self {
            samples: Box::new(reader.into_samples::<i16>()),
            chunk_samples,
            total_frames,
        })
    }

    pub fn chunk_samples(&self) -> usize {
        self.chunk_samples
    }

    /// Returns the next chunk, or `None` when finished.
    pub fn next_chunk(&mut self) -> Result<Option<Vec<f32>>, String> {
        let mut chunk = Vec::with_capacity(self.chunk_samples);
        while chunk.len() < self.chunk_samples {
            match self.samples.next() {
                Some(Ok(v)) => chunk.push(v as f32 / i16::MAX as f32),
                Some(Err(e)) => return Err(e.to_string()),
                None => break,
            }
        }
        if chunk.is_empty() {
            Ok(None)
        } else {
            Ok(Some(chunk))
        }
    }

    pub fn total_chunks(&self) -> u32 {
        (self.total_frames as usize)
            .div_ceil(self.chunk_samples)
            .max(1) as u32
    }
}

pub fn export_clip(
    source_wav: &Path,
    start_seconds: f32,
    end_seconds: f32,
    dest: &Path,
) -> Result<(), String> {
    let reader = WavReader::open(source_wav).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let sr = spec.sample_rate as f32;
    let start = (start_seconds.max(0.0) * sr) as u32;
    let end = (end_seconds.max(start_seconds) * sr) as u32;
    let samples: Vec<i16> = reader
        .into_samples::<i16>()
        .skip(start as usize)
        .take((end - start) as usize)
        .map(|s| s.map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    if samples.is_empty() {
        return Err("Clip range is empty".into());
    }
    let mut writer = WavWriter::create(dest, spec).map_err(|e| e.to_string())?;
    for s in samples {
        writer.write_sample(s).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn decode_audio_file(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "wav" => decode_wav(path),
        "mp3" | "m4a" | "aac" | "mp4" | "ogg" | "flac" => decode_symphonia(path),
        other => Err(format!("Unsupported audio format: {other}")),
    }
}

fn decode_wav(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let reader = WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .map(|s| s.map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => reader
            .into_samples::<i16>()
            .map(|s| {
                s.map(|v| v as f32 / i16::MAX as f32)
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?,
    };
    let mono = if spec.channels > 1 {
        samples
            .chunks(spec.channels as usize)
            .map(|c| c.iter().sum::<f32>() / c.len() as f32)
            .collect()
    } else {
        samples
    };
    Ok((mono, spec.sample_rate))
}

fn decode_symphonia(path: &Path) -> Result<(Vec<f32>, u32), String> {
    use std::fs::File;
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let src = File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(src), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe failed: {e}"))?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("No audio track found")?;
    let track_id = track.id;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or("Unknown sample rate")?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("decoder: {e}"))?;

    let mut pcm: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(e) => return Err(format!("read packet: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = decoder
            .decode(&packet)
            .map_err(|e| format!("decode: {e}"))?;
        let spec = *decoded.spec();
        let channels = spec.channels.count();
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buf.copy_interleaved_ref(decoded);
        let interleaved = buf.samples();
        if channels > 1 {
            for frame in interleaved.chunks(channels) {
                pcm.push(frame.iter().sum::<f32>() / channels as f32);
            }
        } else {
            pcm.extend_from_slice(interleaved);
        }
    }
    Ok((pcm, sample_rate))
}

/// Mix two mono streams resampled to the same length (uses longer stream).
pub fn mix_mono(a: &[f32], b: &[f32]) -> Vec<f32> {
    let len = a.len().max(b.len());
    let mut out = Vec::with_capacity(len);
    for i in 0..len {
        let av = a.get(i).copied().unwrap_or(0.0);
        let bv = b.get(i).copied().unwrap_or(0.0);
        out.push((av * 0.55 + bv * 0.85).clamp(-1.0, 1.0));
    }
    out
}

/// Best-effort speaker diarization: alternate speakers on long pauses.
pub fn diarize_segments(segs: &mut [Segment]) {
    if segs.len() < 2 {
        if let Some(s) = segs.first_mut() {
            s.speaker = Some("Speaker 1".into());
        }
        return;
    }
    let mut speaker = 1u8;
    segs[0].speaker = Some(format!("Speaker {speaker}"));
    for i in 1..segs.len() {
        let gap = parse_mmss(&segs[i].time) - parse_mmss(&segs[i - 1].time);
        if gap > 1.2 {
            speaker = if speaker == 1 { 2 } else { 1 };
        }
        segs[i].speaker = Some(format!("Speaker {speaker}"));
    }
}

fn parse_mmss(time: &str) -> f32 {
    let parts: Vec<f32> = time.split(':').filter_map(|p| p.parse().ok()).collect();
    match parts.len() {
        3 => parts[0] * 3600.0 + parts[1] * 60.0 + parts[2],
        2 => parts[0] * 60.0 + parts[1],
        _ => 0.0,
    }
}

#[cfg(target_os = "windows")]
pub fn find_loopback_device(host: &cpal::Host) -> Option<cpal::Device> {
    host.input_devices().ok().and_then(|mut devices| {
        devices.find(|d| {
            d.name()
                .map(|n| {
                    let lower = n.to_lowercase();
                    lower.contains("loopback")
                        || lower.contains("stereo mix")
                        || lower.contains("what u hear")
                        || lower.contains("wave out mix")
                })
                .unwrap_or(false)
        })
    })
}

#[cfg(not(target_os = "windows"))]
pub fn find_loopback_device(_host: &cpal::Host) -> Option<cpal::Device> {
    None
}

pub fn start_loopback_capture(
    recording: Arc<AtomicBool>,
    live_wav: Arc<Mutex<Option<StreamingWavWriter>>>,
    sample_rate: u32,
    channels: u16,
    app_emit: tauri::AppHandle,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = find_loopback_device(&host).ok_or(
    "System audio capture unavailable — enable Stereo Mix or a loopback device in Windows sound settings",
  )?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("No loopback config: {e}"))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let loop_sr = config.sample_rate.0;
    let loop_ch = config.channels;

    let (ready_tx, ready_rx) = mpsc::channel();

    std::thread::spawn(move || {
        let err_fn = {
            let app = app_emit.clone();
            move |e| {
                let _ = app.emit("recording-error", format!("System audio: {e}"));
            }
        };
        let rec = recording.clone();
        let wav = live_wav.clone();

        let write_samples = move |data: &[f32]| {
            if !rec.load(Ordering::Relaxed) {
                return;
            }
            if let Ok(mut guard) = wav.lock() {
                if let Some(w) = guard.as_mut() {
                    let _ = w.write_f32_interleaved(data);
                }
            }
        };

        let built = match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                move |d: &[f32], _: &cpal::InputCallbackInfo| write_samples(d),
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config,
                move |d: &[i16], _: &cpal::InputCallbackInfo| {
                    for s in d {
                        write_samples(&[*s as f32 / 32768.0]);
                    }
                },
                err_fn,
                None,
            ),
            other => {
                let _ = ready_tx.send(Err(format!("Unsupported loopback format: {other:?}")));
                return;
            }
        };

        match built {
            Ok(stream) => {
                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(Err(format!("Failed to start loopback: {e}")));
                    return;
                }
                let _ = ready_tx.send(Ok((loop_sr, loop_ch)));
                while recording.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                }
                drop(stream);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(format!("Failed to open loopback: {e}")));
            }
        }
    });

    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok((loop_sr, loop_ch))) => {
            let _ = (sample_rate, channels, loop_sr, loop_ch);
            Ok(())
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Timed out starting system audio capture".into()),
    }
}

pub fn resample_to_16k_mono(samples: &[f32], sample_rate: u32, channels: u16) -> Vec<f32> {
    crate::to_mono_16k(samples, sample_rate, channels)
}

pub fn audio_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("audio");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
