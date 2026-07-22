use std::env;
use std::error::Error;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use bzip2::read::BzDecoder;
use sha2::{Digest, Sha256};
use tar::Archive;

const ARCHIVE_NAME: &str = "sherpa-onnx-v1.13.4-win-x64-static-MT-Release-lib.tar.bz2";
const ARCHIVE_BYTES: u64 = 119_847_445;
const ARCHIVE_SHA256: &str = "d81bd1d25112540862d2387072e76b2b6843ef962918d6b5c7db5a19c6276b4c";
const EXTRACTED_DIRECTORY: &str = "sherpa-onnx-v1.13.4-win-x64-static-MT-Release-lib";
const VERIFY_MARKER: &str = ".candor-archive-sha256";
const STATIC_LIBS: &[&str] = &[
    "sherpa-onnx-c-api",
    "sherpa-onnx-core",
    "kaldi-decoder-core",
    "sherpa-onnx-kaldifst-core",
    "sherpa-onnx-fstfar",
    "sherpa-onnx-fst",
    "kaldi-native-fbank-core",
    "kissfft-float",
    "piper_phonemize",
    "espeak-ng",
    "ucd",
    "onnxruntime",
    "ssentencepiece_core",
];

type DynError = Box<dyn Error>;

fn main() {
    if let Err(error) = try_main() {
        panic!("{error}");
    }
}

fn try_main() -> Result<(), DynError> {
    println!("cargo:rerun-if-env-changed=SHERPA_ONNX_ARCHIVE_DIR");
    println!("cargo:rerun-if-env-changed=DOCS_RS");
    if env::var_os("DOCS_RS").is_some() {
        return Ok(());
    }
    if env::var_os("CARGO_FEATURE_SHARED").is_some() {
        return Err("Candor's sherpa-onnx patch supports only the pinned static runtime".into());
    }
    let target_os = env::var("CARGO_CFG_TARGET_OS")?;
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH")?;
    if target_os != "windows" || target_arch != "x86_64" {
        return Err(format!(
            "Candor's pinned sherpa-onnx runtime supports windows/x86_64, not {target_os}/{target_arch}"
        )
        .into());
    }
    let target_features = env::var("CARGO_CFG_TARGET_FEATURE").unwrap_or_default();
    if !target_features
        .split(',')
        .any(|feature| feature == "crt-static")
    {
        return Err(
            "the pinned sherpa-onnx /MT archive requires Rust target-feature=+crt-static".into(),
        );
    }

    let archive_dir = env::var_os("SHERPA_ONNX_ARCHIVE_DIR").ok_or(
        "SHERPA_ONNX_ARCHIVE_DIR is required; Candor's build script never downloads native code",
    )?;
    let archive_path = PathBuf::from(archive_dir).join(ARCHIVE_NAME);
    verify_archive(&archive_path)?;

    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    let cache_root = target_dir_from_out_dir(&out_dir)?.join("sherpa-onnx-prebuilt-candor");
    let extracted = cache_root.join(EXTRACTED_DIRECTORY);
    let marker = extracted.join(VERIFY_MARKER);
    let marker_valid = fs::read_to_string(&marker)
        .map(|value| value.trim().eq_ignore_ascii_case(ARCHIVE_SHA256))
        .unwrap_or(false);
    if !marker_valid {
        if extracted.exists() {
            fs::remove_dir_all(&extracted)?;
        }
        fs::create_dir_all(&cache_root)?;
        let decoder = BzDecoder::new(File::open(&archive_path)?);
        let mut archive = Archive::new(decoder);
        archive.unpack(&cache_root)?;
        let lib_dir = extracted.join("lib");
        if !lib_dir.is_dir() {
            let _ = fs::remove_dir_all(&extracted);
            return Err(
                "the verified sherpa-onnx archive did not contain its lib directory".into(),
            );
        }
        fs::write(&marker, format!("{ARCHIVE_SHA256}\n"))?;
    }

    let lib_dir = extracted.join("lib");
    if !lib_dir.is_dir() {
        return Err("the verified sherpa-onnx runtime cache is incomplete".into());
    }
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    for library in STATIC_LIBS {
        println!("cargo:rustc-link-lib=static={library}");
    }
    Ok(())
}

fn verify_archive(path: &Path) -> Result<(), DynError> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "the pinned sherpa-onnx archive is unavailable at {}: {error}",
            path.display()
        )
    })?;
    if !metadata.is_file() || metadata.len() != ARCHIVE_BYTES {
        return Err("the sherpa-onnx archive did not match its pinned byte count".into());
    }
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    if format!("{:x}", digest.finalize()) != ARCHIVE_SHA256 {
        return Err("the sherpa-onnx archive failed its pinned SHA-256 check".into());
    }
    Ok(())
}

fn target_dir_from_out_dir(out_dir: &Path) -> Result<PathBuf, DynError> {
    if let Ok(explicit) = env::var("CARGO_TARGET_DIR") {
        return Ok(PathBuf::from(explicit));
    }
    if let Some(target) = out_dir
        .ancestors()
        .find(|path| path.file_name() == Some(OsStr::new("target")))
    {
        return Ok(target.to_path_buf());
    }
    Ok(out_dir.to_path_buf())
}
