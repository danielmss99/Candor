use std::io::{self, Seek, SeekFrom, Write};
use std::path::Path;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::Emitter;
use hound::{WavReader, WavSpec, WavWriter};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use crate::Segment;

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
      .map(|s| s.map(|v| v as f32 / i16::MAX as f32).map_err(|e| e.to_string()))
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
  let track = format
    .default_track()
    .ok_or("No audio track found")?;
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
    let decoded = decoder.decode(&packet).map_err(|e| format!("decode: {e}"))?;
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
  samples: Arc<Mutex<Vec<f32>>>,
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

  samples.lock().unwrap().clear();
  let (ready_tx, ready_rx) = mpsc::channel();

  std::thread::spawn(move || {
    let err_fn = {
      let app = app_emit.clone();
      move |e| {
        let _ = app.emit("recording-error", format!("System audio: {e}"));
      }
    };
    let rec = recording.clone();
    let buf = samples.clone();

    let built = match sample_format {
      cpal::SampleFormat::F32 => device.build_input_stream(
        &config,
        move |d: &[f32], _: &cpal::InputCallbackInfo| {
          if rec.load(Ordering::Relaxed) {
            buf.lock().unwrap().extend_from_slice(d);
          }
        },
        err_fn,
        None,
      ),
      cpal::SampleFormat::I16 => device.build_input_stream(
        &config,
        move |d: &[i16], _: &cpal::InputCallbackInfo| {
          if rec.load(Ordering::Relaxed) {
            buf.lock()
              .unwrap()
              .extend(d.iter().map(|s| *s as f32 / 32768.0));
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
        let _ = ready_tx.send(Ok(()));
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
    Ok(Ok(())) => Ok(()),
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
