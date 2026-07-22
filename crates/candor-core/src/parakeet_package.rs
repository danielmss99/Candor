use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use bzip2::read::BzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::Archive;

pub(crate) const PARAKEET_MODEL_ID: &str = "parakeet-tdt-0.6b-v3-int8";
pub(crate) const PARAKEET_ARCHIVE_SHA256: &str =
    "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf";
pub(crate) const PARAKEET_ARCHIVE_BYTES: u64 = 487_170_055;
pub(crate) const PARAKEET_PACKAGE_DIRECTORY: &str = "parakeet-tdt-0.6b-v3-int8";
pub(crate) const PARAKEET_RUNTIME_VERSION: &str = "sherpa-onnx-1.13.4";

const ARCHIVE_ROOT: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const INSTALL_MANIFEST_NAME: &str = "candor-package.json";
const VERIFY_CACHE_NAME: &str = "candor-package-verify.json";
const MAX_ARCHIVE_ENTRIES: usize = 16;
const MAX_DECOMPRESSED_FILE_BYTES: u64 = 672_000_000;
const COPY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MemberSpec {
    archive_name: &'static str,
    install_name: Option<&'static str>,
    bytes: u64,
    sha256: &'static str,
    required: bool,
}

const MEMBER_SPECS: [MemberSpec; 8] = [
    MemberSpec {
        archive_name: "encoder.int8.onnx",
        install_name: Some("encoder.int8.onnx"),
        bytes: 652_184_281,
        sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
        required: true,
    },
    MemberSpec {
        archive_name: "decoder.int8.onnx",
        install_name: Some("decoder.int8.onnx"),
        bytes: 11_845_275,
        sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
        required: true,
    },
    MemberSpec {
        archive_name: "joiner.int8.onnx",
        install_name: Some("joiner.int8.onnx"),
        bytes: 6_355_277,
        sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
        required: true,
    },
    MemberSpec {
        archive_name: "tokens.txt",
        install_name: Some("tokens.txt"),
        bytes: 93_939,
        sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
        required: true,
    },
    MemberSpec {
        archive_name: "test_wavs/de.wav",
        install_name: None,
        bytes: 121_388,
        sha256: "36d3c4845b9808a1656a2a2e92d884590e2db94389e6fe559643291ae0cd3710",
        required: false,
    },
    MemberSpec {
        archive_name: "test_wavs/en.wav",
        install_name: None,
        bytes: 184_608,
        sha256: "148b936b43ce7c546a866e64da059f0458aee2d65e617f16e9d94f06e8d99ed6",
        required: false,
    },
    MemberSpec {
        archive_name: "test_wavs/es.wav",
        install_name: None,
        bytes: 235_052,
        sha256: "49fd2cfa4b62db7068143c582b35de9d31ec2733495ece3611105131d21de06c",
        required: false,
    },
    MemberSpec {
        archive_name: "test_wavs/fr.wav",
        install_name: None,
        bytes: 219_180,
        sha256: "b59be4349b92d344fb903677165eaf4694025d1ab119c608726ecbcb3164b528",
        required: false,
    },
];

#[derive(Debug)]
pub(crate) struct ParakeetPackageError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ParakeetPackageError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct VerifiedParakeetPackage {
    pub(crate) root: PathBuf,
    pub(crate) archive_sha256: String,
    pub(crate) bytes: u64,
    pub(crate) modified_unix_ms: u64,
}

impl VerifiedParakeetPackage {
    pub(crate) fn encoder(&self) -> PathBuf {
        self.root.join("encoder.int8.onnx")
    }

    pub(crate) fn decoder(&self) -> PathBuf {
        self.root.join("decoder.int8.onnx")
    }

    pub(crate) fn joiner(&self) -> PathBuf {
        self.root.join("joiner.int8.onnx")
    }

    pub(crate) fn tokens(&self) -> PathBuf {
        self.root.join("tokens.txt")
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PackageState {
    pub(crate) installed: bool,
    pub(crate) verified: bool,
    pub(crate) bytes: u64,
    pub(crate) modified_unix_ms: u64,
    pub(crate) archive_sha256: Option<String>,
    pub(crate) failure_code: Option<&'static str>,
    pub(crate) failure_message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallManifest {
    schema_version: u32,
    model_id: String,
    archive_sha256: String,
    archive_bytes: u64,
    installed_at_unix_ms: u64,
    members: Vec<MemberManifest>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberManifest {
    name: String,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyCache {
    schema_version: u32,
    model_id: String,
    archive_sha256: String,
    verified_at_unix_ms: u64,
    members: Vec<CachedMember>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedMember {
    name: String,
    bytes: u64,
    modified_unix_ms: u64,
    sha256: String,
}

pub(crate) fn install_archive(
    archive_path: &Path,
    staging_root: &Path,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<VerifiedParakeetPackage, ParakeetPackageError> {
    if staging_root.exists() {
        fs::remove_dir_all(staging_root).map_err(|error| {
            ParakeetPackageError::new("PARAKEET_STAGING_CLEANUP_FAILED", error.to_string())
        })?;
    }
    fs::create_dir(staging_root).map_err(|error| {
        ParakeetPackageError::new("PARAKEET_STAGING_CREATE_FAILED", error.to_string())
    })?;

    let result = extract_archive(archive_path, staging_root, cancellation);
    if let Err(error) = result {
        let _ = fs::remove_dir_all(staging_root);
        return Err(error);
    }

    write_install_manifest(staging_root)?;
    verify_package(staging_root, false)?.ok_or_else(|| {
        ParakeetPackageError::new(
            "PARAKEET_PACKAGE_VERIFY_FAILED",
            "the extracted Parakeet package did not pass verification",
        )
    })
}

pub(crate) fn quick_state(root: &Path) -> PackageState {
    match verify_package(root, true) {
        Ok(Some(package)) => PackageState {
            installed: true,
            verified: true,
            bytes: package.bytes,
            modified_unix_ms: package.modified_unix_ms,
            archive_sha256: Some(package.archive_sha256),
            failure_code: None,
            failure_message: None,
        },
        Ok(None) if root.exists() => PackageState {
            installed: true,
            verified: false,
            bytes: installed_member_bytes(root),
            modified_unix_ms: directory_modified_ms(root),
            archive_sha256: None,
            failure_code: Some("MODEL_VERIFICATION_REQUIRED"),
            failure_message: Some("local Parakeet package needs hash verification".to_string()),
        },
        Ok(None) => missing_state(),
        Err(error) if root.exists() => PackageState {
            installed: true,
            verified: false,
            bytes: installed_member_bytes(root),
            modified_unix_ms: directory_modified_ms(root),
            archive_sha256: None,
            failure_code: Some(error.code),
            failure_message: Some(error.message),
        },
        Err(_) => missing_state(),
    }
}

pub(crate) fn verify_state(root: &Path) -> PackageState {
    match verify_package(root, false) {
        Ok(Some(package)) => PackageState {
            installed: true,
            verified: true,
            bytes: package.bytes,
            modified_unix_ms: package.modified_unix_ms,
            archive_sha256: Some(package.archive_sha256),
            failure_code: None,
            failure_message: None,
        },
        Ok(None) => missing_state(),
        Err(error) => PackageState {
            installed: root.exists(),
            verified: false,
            bytes: installed_member_bytes(root),
            modified_unix_ms: directory_modified_ms(root),
            archive_sha256: None,
            failure_code: Some(error.code),
            failure_message: Some(error.message),
        },
    }
}

pub(crate) fn verified_package(
    root: &Path,
) -> Result<VerifiedParakeetPackage, ParakeetPackageError> {
    verify_package(root, false)?.ok_or_else(|| {
        ParakeetPackageError::new(
            "MODEL_NOT_INSTALLED",
            "local Parakeet package is not installed",
        )
    })
}

fn missing_state() -> PackageState {
    PackageState {
        installed: false,
        verified: false,
        bytes: 0,
        modified_unix_ms: 0,
        archive_sha256: None,
        failure_code: Some("MODEL_NOT_INSTALLED"),
        failure_message: Some("local Parakeet package is not installed".to_string()),
    }
}

fn extract_archive(
    archive_path: &Path,
    staging_root: &Path,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<(), ParakeetPackageError> {
    let archive_file = File::open(archive_path).map_err(|error| {
        ParakeetPackageError::new("PARAKEET_ARCHIVE_READ_FAILED", error.to_string())
    })?;
    let decoder = BzDecoder::new(archive_file);
    let mut archive = Archive::new(decoder);
    let entries = archive.entries().map_err(|error| {
        ParakeetPackageError::new("PARAKEET_ARCHIVE_INVALID", error.to_string())
    })?;
    let mut entry_count = 0_usize;
    let mut declared_total_bytes = 0_u64;
    let mut extracted_total_bytes = 0_u64;
    let mut seen = HashSet::<String>::new();

    for entry in entries {
        ensure_not_cancelled(cancellation)?;
        entry_count += 1;
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err(ParakeetPackageError::new(
                "PARAKEET_ARCHIVE_ENTRY_LIMIT",
                "the Parakeet archive contained too many entries",
            ));
        }
        let mut entry = entry.map_err(|error| {
            ParakeetPackageError::new("PARAKEET_ARCHIVE_INVALID", error.to_string())
        })?;
        let path_bytes = entry.path_bytes();
        let raw_path = std::str::from_utf8(path_bytes.as_ref()).map_err(|_| {
            ParakeetPackageError::new(
                "PARAKEET_ARCHIVE_PATH_INVALID",
                "the Parakeet archive contained a non-UTF-8 path",
            )
        })?;
        validate_archive_path(raw_path)?;
        let normalized = raw_path.trim_end_matches('/').to_ascii_lowercase();
        if !seen.insert(normalized) {
            return Err(ParakeetPackageError::new(
                "PARAKEET_ARCHIVE_DUPLICATE_ENTRY",
                "the Parakeet archive contained duplicate normalized paths",
            ));
        }
        let relative = raw_path
            .trim_end_matches('/')
            .strip_prefix(&format!("{ARCHIVE_ROOT}/"));
        let entry_type = entry.header().entry_type();
        if raw_path.trim_end_matches('/') == ARCHIVE_ROOT || relative == Some("test_wavs") {
            if !entry_type.is_dir() {
                return Err(ParakeetPackageError::new(
                    "PARAKEET_ARCHIVE_ENTRY_TYPE_INVALID",
                    "the Parakeet archive directory entry had an invalid type",
                ));
            }
            continue;
        }
        if !entry_type.is_file() {
            return Err(ParakeetPackageError::new(
                "PARAKEET_ARCHIVE_ENTRY_TYPE_INVALID",
                "the Parakeet archive contained a link or special entry",
            ));
        }
        let relative = relative.ok_or_else(|| {
            ParakeetPackageError::new(
                "PARAKEET_ARCHIVE_PATH_INVALID",
                "the Parakeet archive contained an unexpected path",
            )
        })?;
        let spec = MEMBER_SPECS
            .iter()
            .find(|candidate| candidate.archive_name == relative)
            .ok_or_else(|| {
                ParakeetPackageError::new(
                    "PARAKEET_ARCHIVE_MEMBER_UNEXPECTED",
                    "the Parakeet archive contained an unexpected file",
                )
            })?;
        let header_bytes = entry.header().size().map_err(|error| {
            ParakeetPackageError::new("PARAKEET_ARCHIVE_INVALID", error.to_string())
        })?;
        if header_bytes != spec.bytes {
            return Err(ParakeetPackageError::new(
                "PARAKEET_ARCHIVE_MEMBER_SIZE_MISMATCH",
                format!("{} had an unexpected size", spec.archive_name),
            ));
        }
        declared_total_bytes = declared_total_bytes.saturating_add(header_bytes);
        if declared_total_bytes > MAX_DECOMPRESSED_FILE_BYTES {
            return Err(ParakeetPackageError::new(
                "PARAKEET_ARCHIVE_DECOMPRESSED_LIMIT",
                "the Parakeet archive exceeded the decompressed byte limit",
            ));
        }
        let output_path = spec.install_name.map(|name| staging_root.join(name));
        let (digest, extracted_bytes) =
            copy_and_hash(&mut entry, output_path.as_deref(), cancellation)?;
        if extracted_bytes != spec.bytes {
            return Err(ParakeetPackageError::new(
                "PARAKEET_ARCHIVE_MEMBER_SIZE_MISMATCH",
                format!(
                    "{} yielded an unexpected number of bytes",
                    spec.archive_name
                ),
            ));
        }
        extracted_total_bytes = extracted_total_bytes.saturating_add(extracted_bytes);
        if extracted_total_bytes > MAX_DECOMPRESSED_FILE_BYTES {
            return Err(ParakeetPackageError::new(
                "PARAKEET_ARCHIVE_DECOMPRESSED_LIMIT",
                "the Parakeet archive exceeded the decompressed byte limit",
            ));
        }
        if !digest.eq_ignore_ascii_case(spec.sha256) {
            return Err(ParakeetPackageError::new(
                "PARAKEET_ARCHIVE_MEMBER_HASH_MISMATCH",
                format!("{} failed its trusted SHA-256 check", spec.archive_name),
            ));
        }
    }

    for spec in MEMBER_SPECS.iter().filter(|spec| spec.required) {
        let expected = format!("{ARCHIVE_ROOT}/{}", spec.archive_name).to_ascii_lowercase();
        if !seen.contains(&expected) {
            return Err(ParakeetPackageError::new(
                "PARAKEET_ARCHIVE_MEMBER_MISSING",
                format!(
                    "{} was missing from the Parakeet archive",
                    spec.archive_name
                ),
            ));
        }
    }
    Ok(())
}

fn validate_archive_path(path: &str) -> Result<(), ParakeetPackageError> {
    let invalid = path.is_empty()
        || path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains(':')
        || path.contains('\0')
        || path.split('/').any(|component| {
            component == ".." || component == "." || is_windows_device_name(component)
        });
    if invalid {
        Err(ParakeetPackageError::new(
            "PARAKEET_ARCHIVE_PATH_INVALID",
            "the Parakeet archive contained an unsafe path",
        ))
    } else {
        Ok(())
    }
}

fn is_windows_device_name(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

fn copy_and_hash(
    input: &mut dyn Read,
    output_path: Option<&Path>,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<(String, u64), ParakeetPackageError> {
    let mut output = match output_path {
        Some(path) => Some(
            File::options()
                .create_new(true)
                .write(true)
                .open(path)
                .map_err(|error| {
                    ParakeetPackageError::new("PARAKEET_MEMBER_WRITE_FAILED", error.to_string())
                })?,
        ),
        None => None,
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    let mut copied_bytes = 0_u64;
    loop {
        ensure_not_cancelled(cancellation)?;
        let read = input.read(&mut buffer).map_err(|error| {
            ParakeetPackageError::new("PARAKEET_ARCHIVE_READ_FAILED", error.to_string())
        })?;
        if read == 0 {
            break;
        }
        copied_bytes = copied_bytes.saturating_add(read as u64);
        hasher.update(&buffer[..read]);
        if let Some(file) = output.as_mut() {
            file.write_all(&buffer[..read]).map_err(|error| {
                ParakeetPackageError::new("PARAKEET_MEMBER_WRITE_FAILED", error.to_string())
            })?;
        }
    }
    if let Some(file) = output {
        file.sync_all().map_err(|error| {
            ParakeetPackageError::new("PARAKEET_MEMBER_FLUSH_FAILED", error.to_string())
        })?;
    }
    Ok((format!("{:x}", hasher.finalize()), copied_bytes))
}

fn ensure_not_cancelled(
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<(), ParakeetPackageError> {
    if cancellation.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        Err(ParakeetPackageError::new(
            "MODEL_IMPORT_CANCELLED",
            "Parakeet package installation was cancelled",
        ))
    } else {
        Ok(())
    }
}

fn write_install_manifest(root: &Path) -> Result<(), ParakeetPackageError> {
    let members = MEMBER_SPECS
        .iter()
        .filter_map(|spec| {
            spec.install_name.map(|name| MemberManifest {
                name: name.to_string(),
                bytes: spec.bytes,
                sha256: spec.sha256.to_string(),
            })
        })
        .collect();
    let manifest = InstallManifest {
        schema_version: 1,
        model_id: PARAKEET_MODEL_ID.to_string(),
        archive_sha256: PARAKEET_ARCHIVE_SHA256.to_string(),
        archive_bytes: PARAKEET_ARCHIVE_BYTES,
        installed_at_unix_ms: now_unix_ms(),
        members,
    };
    write_json_atomic(root.join(INSTALL_MANIFEST_NAME), &manifest)
}

fn verify_package(
    root: &Path,
    cache_only: bool,
) -> Result<Option<VerifiedParakeetPackage>, ParakeetPackageError> {
    if !root.is_dir() {
        return Ok(None);
    }
    validate_directory_members(root)?;
    let manifest: InstallManifest = read_json(root.join(INSTALL_MANIFEST_NAME))?;
    validate_install_manifest(&manifest)?;
    if let Ok(cache) = read_json::<VerifyCache>(root.join(VERIFY_CACHE_NAME)) {
        if valid_verify_cache(root, &cache) {
            return Ok(Some(package_from_cache(root, &cache)));
        }
    }
    if cache_only {
        return Ok(None);
    }
    let mut cached_members = Vec::new();
    for spec in MEMBER_SPECS
        .iter()
        .filter(|spec| spec.install_name.is_some())
    {
        let name = spec.install_name.unwrap_or_default();
        let path = root.join(name);
        let metadata = fs::metadata(&path).map_err(|error| {
            ParakeetPackageError::new("PARAKEET_PACKAGE_MEMBER_MISSING", error.to_string())
        })?;
        if !metadata.is_file() || metadata.len() != spec.bytes {
            return Err(ParakeetPackageError::new(
                "PARAKEET_PACKAGE_MEMBER_SIZE_MISMATCH",
                format!("{name} had an unexpected installed size"),
            ));
        }
        let digest = sha256_file(&path)?;
        if !digest.eq_ignore_ascii_case(spec.sha256) {
            return Err(ParakeetPackageError::new(
                "PARAKEET_PACKAGE_MEMBER_HASH_MISMATCH",
                format!("{name} failed its installed SHA-256 check"),
            ));
        }
        cached_members.push(CachedMember {
            name: name.to_string(),
            bytes: metadata.len(),
            modified_unix_ms: metadata.modified().map(unix_ms).unwrap_or_default(),
            sha256: digest,
        });
    }
    let cache = VerifyCache {
        schema_version: 1,
        model_id: PARAKEET_MODEL_ID.to_string(),
        archive_sha256: PARAKEET_ARCHIVE_SHA256.to_string(),
        verified_at_unix_ms: now_unix_ms(),
        members: cached_members,
    };
    write_json_atomic(root.join(VERIFY_CACHE_NAME), &cache)?;
    Ok(Some(package_from_cache(root, &cache)))
}

fn validate_directory_members(root: &Path) -> Result<(), ParakeetPackageError> {
    let allowed = HashSet::from([
        "encoder.int8.onnx",
        "decoder.int8.onnx",
        "joiner.int8.onnx",
        "tokens.txt",
        INSTALL_MANIFEST_NAME,
        VERIFY_CACHE_NAME,
    ]);
    for entry in fs::read_dir(root).map_err(|error| {
        ParakeetPackageError::new("PARAKEET_PACKAGE_READ_FAILED", error.to_string())
    })? {
        let entry = entry.map_err(|error| {
            ParakeetPackageError::new("PARAKEET_PACKAGE_READ_FAILED", error.to_string())
        })?;
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(|| {
            ParakeetPackageError::new(
                "PARAKEET_PACKAGE_MEMBER_UNEXPECTED",
                "the installed package contained a non-UTF-8 name",
            )
        })?;
        if !allowed.contains(name)
            || !entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        {
            return Err(ParakeetPackageError::new(
                "PARAKEET_PACKAGE_MEMBER_UNEXPECTED",
                "the installed package contained an unexpected entry",
            ));
        }
    }
    Ok(())
}

fn validate_install_manifest(manifest: &InstallManifest) -> Result<(), ParakeetPackageError> {
    if manifest.schema_version != 1
        || manifest.model_id != PARAKEET_MODEL_ID
        || manifest.archive_bytes != PARAKEET_ARCHIVE_BYTES
        || !manifest
            .archive_sha256
            .eq_ignore_ascii_case(PARAKEET_ARCHIVE_SHA256)
        || manifest.members.len() != 4
    {
        return Err(ParakeetPackageError::new(
            "PARAKEET_PACKAGE_MANIFEST_INVALID",
            "the installed Parakeet package manifest was invalid",
        ));
    }
    for spec in MEMBER_SPECS
        .iter()
        .filter(|spec| spec.install_name.is_some())
    {
        let name = spec.install_name.unwrap_or_default();
        if !manifest.members.iter().any(|member| {
            member.name == name
                && member.bytes == spec.bytes
                && member.sha256.eq_ignore_ascii_case(spec.sha256)
        }) {
            return Err(ParakeetPackageError::new(
                "PARAKEET_PACKAGE_MANIFEST_INVALID",
                "the installed Parakeet package manifest did not match the trusted layout",
            ));
        }
    }
    Ok(())
}

fn valid_verify_cache(root: &Path, cache: &VerifyCache) -> bool {
    if cache.schema_version != 1
        || cache.model_id != PARAKEET_MODEL_ID
        || !cache
            .archive_sha256
            .eq_ignore_ascii_case(PARAKEET_ARCHIVE_SHA256)
        || cache.members.len() != 4
    {
        return false;
    }
    MEMBER_SPECS
        .iter()
        .filter(|spec| spec.install_name.is_some())
        .all(|spec| {
            let name = spec.install_name.unwrap_or_default();
            let Some(cached) = cache.members.iter().find(|member| member.name == name) else {
                return false;
            };
            if cached.bytes != spec.bytes || !cached.sha256.eq_ignore_ascii_case(spec.sha256) {
                return false;
            }
            let Ok(metadata) = fs::metadata(root.join(name)) else {
                return false;
            };
            metadata.is_file()
                && metadata.len() == cached.bytes
                && metadata.modified().map(unix_ms).unwrap_or_default() == cached.modified_unix_ms
        })
}

fn package_from_cache(root: &Path, cache: &VerifyCache) -> VerifiedParakeetPackage {
    VerifiedParakeetPackage {
        root: root.to_path_buf(),
        archive_sha256: cache.archive_sha256.clone(),
        bytes: cache.members.iter().map(|member| member.bytes).sum(),
        modified_unix_ms: cache
            .members
            .iter()
            .map(|member| member.modified_unix_ms)
            .max()
            .unwrap_or_default(),
    }
}

fn installed_member_bytes(root: &Path) -> u64 {
    MEMBER_SPECS
        .iter()
        .filter_map(|spec| spec.install_name)
        .filter_map(|name| fs::metadata(root.join(name)).ok())
        .map(|metadata| metadata.len())
        .sum()
}

fn directory_modified_ms(root: &Path) -> u64 {
    fs::metadata(root)
        .and_then(|metadata| metadata.modified())
        .map(unix_ms)
        .unwrap_or_default()
}

fn sha256_file(path: &Path) -> Result<String, ParakeetPackageError> {
    let mut file = File::open(path).map_err(|error| {
        ParakeetPackageError::new("PARAKEET_PACKAGE_READ_FAILED", error.to_string())
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            ParakeetPackageError::new("PARAKEET_PACKAGE_READ_FAILED", error.to_string())
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: PathBuf) -> Result<T, ParakeetPackageError> {
    let bytes = fs::read(path).map_err(|error| {
        ParakeetPackageError::new("PARAKEET_PACKAGE_MANIFEST_READ_FAILED", error.to_string())
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        ParakeetPackageError::new("PARAKEET_PACKAGE_MANIFEST_INVALID", error.to_string())
    })
}

fn write_json_atomic<T: Serialize>(path: PathBuf, value: &T) -> Result<(), ParakeetPackageError> {
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        ParakeetPackageError::new("PARAKEET_PACKAGE_MANIFEST_INVALID", error.to_string())
    })?;
    {
        let mut file = File::options()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| {
                ParakeetPackageError::new(
                    "PARAKEET_PACKAGE_MANIFEST_WRITE_FAILED",
                    error.to_string(),
                )
            })?;
        file.write_all(&bytes).map_err(|error| {
            ParakeetPackageError::new("PARAKEET_PACKAGE_MANIFEST_WRITE_FAILED", error.to_string())
        })?;
        file.sync_all().map_err(|error| {
            ParakeetPackageError::new("PARAKEET_PACKAGE_MANIFEST_WRITE_FAILED", error.to_string())
        })?;
    }
    if path.exists() {
        fs::remove_file(&path).map_err(|error| {
            ParakeetPackageError::new("PARAKEET_PACKAGE_MANIFEST_WRITE_FAILED", error.to_string())
        })?;
    }
    fs::rename(temporary, path).map_err(|error| {
        ParakeetPackageError::new("PARAKEET_PACKAGE_MANIFEST_WRITE_FAILED", error.to_string())
    })
}

fn unix_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

fn now_unix_ms() -> u64 {
    unix_ms(SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bzip2::write::BzEncoder;
    use bzip2::Compression;
    use std::io::Cursor;
    use tar::{Builder, EntryType, Header};

    fn test_root(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("candor-parakeet-{label}-{stamp}"))
    }

    fn archive_with_entry(path: &str, entry_type: EntryType) -> PathBuf {
        let root = test_root("archive");
        fs::create_dir_all(&root).expect("archive root");
        let path_out = root.join("test.tar.bz2");
        let file = File::create(&path_out).expect("archive file");
        let encoder = BzEncoder::new(file, Compression::best());
        let mut builder = Builder::new(encoder);
        let mut header = Header::new_gnu();
        header.set_entry_type(entry_type);
        header.set_size(0);
        header.set_mode(0o600);
        header.set_cksum();
        builder
            .append_data(&mut header, path, Cursor::new(Vec::<u8>::new()))
            .expect("append test entry");
        let encoder = builder.into_inner().expect("finish tar");
        encoder.finish().expect("finish bzip2");
        path_out
    }

    #[test]
    fn archive_path_validation_rejects_windows_and_posix_traversal_forms() {
        for path in [
            "../escape.txt",
            "root/../escape.txt",
            "root\\..\\escape.txt",
            "/absolute/file",
            "\\\\server\\share\\file",
            "C:/Windows/file",
            "root/NUL.txt",
            "root/com1.log",
            "root/LPT9",
        ] {
            assert_eq!(
                validate_archive_path(path).expect_err(path).code,
                "PARAKEET_ARCHIVE_PATH_INVALID"
            );
        }
    }

    #[test]
    fn archive_path_validation_accepts_only_safe_relative_shapes() {
        for path in [
            ARCHIVE_ROOT,
            "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx",
            "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/test_wavs/en.wav",
        ] {
            validate_archive_path(path).expect(path);
        }
    }

    #[test]
    fn extraction_rejects_unexpected_members_before_writing() {
        let archive = archive_with_entry(
            &format!("{ARCHIVE_ROOT}/unexpected.bin"),
            EntryType::Regular,
        );
        let staging = test_root("unexpected-staging");
        fs::create_dir_all(&staging).expect("staging");
        let error = extract_archive(&archive, &staging, None).expect_err("unexpected member");
        assert_eq!(error.code, "PARAKEET_ARCHIVE_MEMBER_UNEXPECTED");
        assert_eq!(fs::read_dir(&staging).expect("read staging").count(), 0);
        let _ = fs::remove_dir_all(archive.parent().unwrap_or(Path::new(".")));
        let _ = fs::remove_dir_all(staging);
    }

    #[test]
    fn extraction_rejects_links_even_with_an_allowed_member_name() {
        let archive = archive_with_entry(
            &format!("{ARCHIVE_ROOT}/encoder.int8.onnx"),
            EntryType::Symlink,
        );
        let staging = test_root("link-staging");
        fs::create_dir_all(&staging).expect("staging");
        let error = extract_archive(&archive, &staging, None).expect_err("link member");
        assert_eq!(error.code, "PARAKEET_ARCHIVE_ENTRY_TYPE_INVALID");
        assert_eq!(fs::read_dir(&staging).expect("read staging").count(), 0);
        let _ = fs::remove_dir_all(archive.parent().unwrap_or(Path::new(".")));
        let _ = fs::remove_dir_all(staging);
    }

    #[test]
    fn trusted_layout_fits_inside_the_decompressed_limit() {
        let total: u64 = MEMBER_SPECS.iter().map(|member| member.bytes).sum();
        assert_eq!(total, 671_239_000);
        assert!(total < MAX_DECOMPRESSED_FILE_BYTES);
        assert!(MEMBER_SPECS.len() + 2 <= MAX_ARCHIVE_ENTRIES);
    }

    #[cfg(all(windows, feature = "local-parakeet"))]
    fn proof_wav(path: &Path) -> (i32, Vec<f32>) {
        let bytes = fs::read(path).expect("read Parakeet proof WAV");
        assert!(bytes.len() >= 44 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE");
        let mut offset = 12_usize;
        let mut format_verified = false;
        let mut sample_rate_hz = 0_i32;
        let mut samples = None;
        while offset.saturating_add(8) <= bytes.len() {
            let chunk_id = &bytes[offset..offset + 4];
            let chunk_bytes = u32::from_le_bytes(
                bytes[offset + 4..offset + 8]
                    .try_into()
                    .expect("WAV chunk size"),
            ) as usize;
            offset += 8;
            let end = offset.checked_add(chunk_bytes).expect("bounded WAV chunk");
            assert!(end <= bytes.len(), "WAV chunk exceeds file");
            if chunk_id == b"fmt " {
                assert!(chunk_bytes >= 16, "WAV format chunk is too short");
                let audio_format =
                    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap());
                let channels =
                    u16::from_le_bytes(bytes[offset + 2..offset + 4].try_into().unwrap());
                let sample_rate =
                    u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap());
                let bits = u16::from_le_bytes(bytes[offset + 14..offset + 16].try_into().unwrap());
                assert_eq!((audio_format, channels, bits), (1, 1, 16));
                assert!((8_000..=48_000).contains(&sample_rate));
                sample_rate_hz = sample_rate as i32;
                format_verified = true;
            } else if chunk_id == b"data" {
                assert_eq!(chunk_bytes % 2, 0, "PCM16 data must be sample-aligned");
                samples = Some(
                    bytes[offset..end]
                        .chunks_exact(2)
                        .map(|sample| {
                            i16::from_le_bytes([sample[0], sample[1]]) as f32 / i16::MAX as f32
                        })
                        .collect::<Vec<_>>(),
                );
            }
            offset = end.saturating_add(chunk_bytes % 2);
        }
        assert!(format_verified, "WAV format was not verified");
        (sample_rate_hz, samples.expect("WAV data chunk"))
    }

    #[cfg(all(windows, feature = "local-parakeet"))]
    #[test]
    #[ignore = "requires the pinned 487 MB model archive and native sherpa runtime"]
    fn official_archive_installs_and_runs_real_parakeet_inference() {
        use sherpa_onnx::{
            OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig,
        };

        let archive = PathBuf::from(
            std::env::var_os("CANDOR_PARAKEET_PROOF_ARCHIVE")
                .expect("CANDOR_PARAKEET_PROOF_ARCHIVE"),
        );
        let wav = PathBuf::from(
            std::env::var_os("CANDOR_PARAKEET_PROOF_WAV").expect("CANDOR_PARAKEET_PROOF_WAV"),
        );
        let supplied_install = std::env::var_os("CANDOR_PARAKEET_PROOF_INSTALL").map(PathBuf::from);
        let staging = supplied_install
            .clone()
            .unwrap_or_else(|| test_root("official-proof-install"));
        let package = if supplied_install.is_some() {
            verified_package(&staging).expect("verify prior official archive install")
        } else {
            install_archive(&archive, &staging, None).expect("install official archive")
        };
        assert_eq!(package.archive_sha256, PARAKEET_ARCHIVE_SHA256);
        assert_eq!(package.bytes, 670_478_772);

        let text_path = |path: PathBuf| path.to_string_lossy().into_owned();
        let mut config = OfflineRecognizerConfig::default();
        config.model_config.transducer = OfflineTransducerModelConfig {
            encoder: Some(text_path(package.encoder())),
            decoder: Some(text_path(package.decoder())),
            joiner: Some(text_path(package.joiner())),
        };
        config.model_config.tokens = Some(text_path(package.tokens()));
        config.model_config.model_type = Some("nemo_transducer".to_string());
        config.model_config.provider = Some("cpu".to_string());
        config.model_config.num_threads = 4;
        config.decoding_method = Some("greedy_search".to_string());
        let recognizer = OfflineRecognizer::create(&config).expect("load verified Parakeet model");
        let stream = recognizer.create_stream();
        let (sample_rate_hz, samples) = proof_wav(&wav);
        stream.accept_waveform(sample_rate_hz, &samples);
        recognizer.decode(&stream);
        let result = stream.get_result().expect("Parakeet result");
        println!("CANDOR_REAL_PARAKEET_TEXT={}", result.text);
        assert!(
            !result.text.trim().is_empty(),
            "Parakeet returned empty text"
        );
        if supplied_install.is_none() {
            let _ = fs::remove_dir_all(staging);
        }
    }
}
