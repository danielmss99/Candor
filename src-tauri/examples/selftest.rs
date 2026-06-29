// Headless Whisper self-test: transcribe a known WAV and print the result.
// Usage: cargo run --example selftest -- <model.bin> <audio.wav>
//
// Verifies the whisper-rs + model path end-to-end without a microphone.

use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: selftest <model.bin> <audio.wav>");
        std::process::exit(2);
    }
    let model = PathBuf::from(&args[1]);
    let wav = &args[2];

    let mut reader = hound::WavReader::open(wav).expect("open wav");
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.unwrap() as f32 / max)
                .collect()
        }
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
    };

    println!(
        "loaded {} samples @ {} Hz, {} ch",
        samples.len(),
        spec.sample_rate,
        spec.channels
    );
    let audio = candor_lib::to_mono_16k(&samples, spec.sample_rate, spec.channels);
    let segs = candor_lib::transcribe(&model, &audio).expect("transcribe");

    println!("--- transcript ({} segments) ---", segs.len());
    for s in &segs {
        println!("[{}] {}", s.time, s.text);
    }
}
