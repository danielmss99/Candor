#[cfg(not(windows))]
use std::fs::OpenOptions;
use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::AtomicBool;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use getrandom::getrandom;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::media_decoder::{
    decode_compressed_media, probe_compressed_media, CompressedMediaProbe, MediaDecoderError,
};
use crate::media_import::{
    local_decoder_capability, validate_media_import, MediaImportCandidate, MediaImportStatus,
    MediaKind, MAX_IMPORT_BYTES, MAX_IMPORT_DURATION_MS, MAX_MAGIC_PROBE_BYTES,
};
use crate::recording_store::{
    RecordingIdParams, RecordingStore, StartRecordingParams, WriteAudioChunkParams,
};

const MEDIA_IMPORT_SERVICE_SCHEMA_VERSION: u32 = 1;
const MAX_RIFF_CHUNKS: usize = 4_096;
pub(crate) const IMPORT_PCM_CHUNK_BYTES: usize = 384 * 1024;
const SOURCE_STAGE_CHUNK_BYTES: usize = 512 * 1024;
const SOURCE_SHA256_HEX_BYTES: usize = 64;
const PRIVATE_STAGE_CREATE_ATTEMPTS: u8 = 16;

#[derive(Debug)]
struct TrustedMainImportParams {
    source_path: PathBuf,
    expected_source_sha256: Option<String>,
}

impl TrustedMainImportParams {
    #[cfg(test)]
    fn inspect(source_path: PathBuf) -> Self {
        Self {
            source_path,
            expected_source_sha256: None,
        }
    }

    fn import(source_path: PathBuf, expected_source_sha256: String) -> Self {
        Self {
            source_path,
            expected_source_sha256: Some(expected_source_sha256),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MediaImportServiceError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl MediaImportServiceError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaLocalSourceValidationResponse {
    pub(crate) schema_version: u32,
    pub(crate) eligible: bool,
    pub(crate) source_size_bytes: u64,
    pub(crate) local_storage_verified: bool,
    pub(crate) regular_file: bool,
    pub(crate) reparse_point: bool,
    pub(crate) cloud_placeholder: bool,
    pub(crate) local_only: bool,
    pub(crate) network_attempted: bool,
    pub(crate) raw_path_exposed: bool,
    pub(crate) key_material_exposed_to_renderer: bool,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaImportInspectResponse {
    pub(crate) schema_version: u32,
    pub(crate) display_name: String,
    pub(crate) media_kind: MediaKind,
    pub(crate) source_size_bytes: u64,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) sample_rate_hz: Option<u32>,
    pub(crate) channel_count: Option<u16>,
    pub(crate) bits_per_sample: Option<u16>,
    pub(crate) source_sha256: String,
    pub(crate) status: MediaImportStatus,
    pub(crate) import_supported: bool,
    pub(crate) decoder_execution_attempted: bool,
    pub(crate) source_modified: bool,
    pub(crate) local_only: bool,
    pub(crate) network_attempted: bool,
    pub(crate) raw_path_exposed: bool,
    pub(crate) key_material_exposed_to_renderer: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaImportResponse {
    pub(crate) schema_version: u32,
    pub(crate) display_name: String,
    pub(crate) media_kind: MediaKind,
    pub(crate) status: MediaImportStatus,
    pub(crate) imported: bool,
    pub(crate) recording_id: Option<String>,
    pub(crate) source_size_bytes: u64,
    pub(crate) imported_pcm_bytes: u64,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) sample_rate_hz: Option<u32>,
    pub(crate) channel_count: Option<u16>,
    pub(crate) bits_per_sample: Option<u16>,
    pub(crate) durable_chunk_count: u32,
    pub(crate) original_audio_retained: bool,
    pub(crate) container_metadata_preserved: bool,
    pub(crate) source_modified: bool,
    pub(crate) decoder_execution_attempted: bool,
    pub(crate) local_only: bool,
    pub(crate) network_attempted: bool,
    pub(crate) raw_path_exposed: bool,
    pub(crate) key_material_exposed_to_renderer: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct MediaImportService {
    staging_root: PathBuf,
}

impl MediaImportService {
    pub(crate) fn with_staging_root(staging_root: PathBuf) -> Self {
        Self { staging_root }
    }

    pub(crate) fn validate_local_source_path(
        &self,
        source_path: PathBuf,
    ) -> Result<MediaLocalSourceValidationResponse, MediaImportServiceError> {
        let validated = validate_local_source(&source_path)?;
        Ok(MediaLocalSourceValidationResponse {
            schema_version: MEDIA_IMPORT_SERVICE_SCHEMA_VERSION,
            eligible: true,
            source_size_bytes: validated.source_size_bytes,
            local_storage_verified: true,
            regular_file: true,
            reparse_point: false,
            cloud_placeholder: false,
            local_only: true,
            network_attempted: false,
            raw_path_exposed: false,
            key_material_exposed_to_renderer: false,
        })
    }

    #[cfg(test)]
    pub(crate) fn inspect_source(
        &self,
        source_path: PathBuf,
    ) -> Result<MediaImportInspectResponse, MediaImportServiceError> {
        self.inspect_trusted(TrustedMainImportParams::inspect(source_path))
    }

    #[cfg(test)]
    pub(crate) fn import_source(
        &self,
        store: &RecordingStore,
        source_path: PathBuf,
    ) -> Result<MediaImportResponse, MediaImportServiceError> {
        let cancellation = AtomicBool::new(false);
        let expected_source_sha256 = self.inspect_source(source_path.clone())?.source_sha256;
        self.import_trusted(
            store,
            TrustedMainImportParams::import(source_path, expected_source_sha256),
            &cancellation,
        )
    }

    pub(crate) fn import_source_cancellable(
        &self,
        store: &RecordingStore,
        source_path: PathBuf,
        expected_source_sha256: String,
        cancellation: &AtomicBool,
    ) -> Result<MediaImportResponse, MediaImportServiceError> {
        self.import_trusted(
            store,
            TrustedMainImportParams::import(source_path, expected_source_sha256),
            cancellation,
        )
    }

    #[cfg(test)]
    fn inspect_trusted(
        &self,
        params: TrustedMainImportParams,
    ) -> Result<MediaImportInspectResponse, MediaImportServiceError> {
        let cancellation = AtomicBool::new(false);
        let prepared = PreparedSource::open(params, &self.staging_root, &cancellation)?;
        Ok(prepared.inspect_response())
    }

    fn import_trusted(
        &self,
        store: &RecordingStore,
        params: TrustedMainImportParams,
        cancellation: &AtomicBool,
    ) -> Result<MediaImportResponse, MediaImportServiceError> {
        self.import_trusted_with_hooks(store, params, cancellation, || {}, || {})
    }

    #[cfg(test)]
    fn import_trusted_with_before_finish<F>(
        &self,
        store: &RecordingStore,
        params: TrustedMainImportParams,
        cancellation: &AtomicBool,
        before_finish: F,
    ) -> Result<MediaImportResponse, MediaImportServiceError>
    where
        F: FnOnce(),
    {
        self.import_trusted_with_hooks(store, params, cancellation, || {}, before_finish)
    }

    fn import_trusted_with_hooks<F, G>(
        &self,
        store: &RecordingStore,
        params: TrustedMainImportParams,
        cancellation: &AtomicBool,
        after_stage: F,
        before_finish: G,
    ) -> Result<MediaImportResponse, MediaImportServiceError>
    where
        F: FnOnce(),
        G: FnOnce(),
    {
        let mut prepared = PreparedSource::open_with_after_stage(
            params,
            &self.staging_root,
            cancellation,
            after_stage,
        )?;
        if cancellation.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(MediaImportServiceError::new(
                "MEDIA_IMPORT_CANCELLED",
                "the local media import was cancelled",
            ));
        }

        // Parsing, type validation, size validation, duration validation, and all RIFF range
        // checks have completed before a durable recording is created.
        validate_local_storage_root(&store.local_data_root_for_core())?;
        let started = store
            .start(StartRecordingParams {
                label: Some(prepared.display_name.clone()),
            })
            .map_err(store_error)?;
        let recording_id = started
            .get("recordingId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| {
                MediaImportServiceError::new(
                    "MEDIA_IMPORT_STORE_RESPONSE_INVALID",
                    "durable recording storage returned an invalid recording identifier",
                )
            })?;

        match import_prepared_media(&mut prepared, store, &recording_id, cancellation) {
            Ok(imported) => {
                before_finish();
                if cancellation.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err(failure_after_cleanup(
                        store,
                        &recording_id,
                        MediaImportServiceError::new(
                            "MEDIA_IMPORT_CANCELLED",
                            "the local media import was cancelled",
                        ),
                    ));
                }
                if let Err(error) = store.finish(RecordingIdParams {
                    recording_id: recording_id.clone(),
                }) {
                    return Err(failure_after_cleanup(
                        store,
                        &recording_id,
                        store_error(error),
                    ));
                }
                Ok(MediaImportResponse {
                    schema_version: MEDIA_IMPORT_SERVICE_SCHEMA_VERSION,
                    display_name: prepared.display_name,
                    media_kind: prepared.media_kind,
                    status: MediaImportStatus::Ready,
                    imported: true,
                    recording_id: Some(recording_id),
                    source_size_bytes: prepared.source_size_bytes,
                    imported_pcm_bytes: imported.total_pcm_bytes,
                    duration_ms: Some(imported.duration_ms),
                    sample_rate_hz: Some(imported.sample_rate_hz),
                    channel_count: Some(imported.channel_count),
                    bits_per_sample: Some(16),
                    durable_chunk_count: imported.chunk_count,
                    original_audio_retained: imported.original_audio_retained,
                    container_metadata_preserved: false,
                    source_modified: false,
                    decoder_execution_attempted: imported.decoder_execution_attempted,
                    local_only: true,
                    network_attempted: false,
                    raw_path_exposed: false,
                    key_material_exposed_to_renderer: false,
                })
            }
            Err(error) => Err(failure_after_cleanup(store, &recording_id, error)),
        }
    }
}

pub(crate) const fn production_local_media_storage_supported() -> bool {
    cfg!(windows)
}

#[derive(Clone, Debug)]
struct PcmRange {
    offset: u64,
    length: u64,
}

#[derive(Clone, Debug)]
struct ParsedWav {
    sample_rate_hz: u32,
    channel_count: u16,
    block_align: u16,
    total_pcm_bytes: u64,
    duration_ms: u64,
    pcm_ranges: Vec<PcmRange>,
}

#[derive(Clone, Debug)]
enum PreparedMedia {
    Wav(ParsedWav),
    Compressed(CompressedMediaProbe),
}

impl PreparedMedia {
    fn duration_ms(&self) -> Option<u64> {
        match self {
            Self::Wav(wav) => Some(wav.duration_ms),
            Self::Compressed(probe) => probe.duration_ms,
        }
    }

    #[cfg(test)]
    fn sample_rate_hz(&self) -> Option<u32> {
        match self {
            Self::Wav(wav) => Some(wav.sample_rate_hz),
            Self::Compressed(probe) => probe.sample_rate_hz,
        }
    }

    #[cfg(test)]
    fn channel_count(&self) -> Option<u16> {
        match self {
            Self::Wav(wav) => Some(wav.channel_count),
            Self::Compressed(probe) => probe.channel_count,
        }
    }
}

struct PrivateStagedSource {
    file: Option<File>,
    cleanup_path: Option<PathBuf>,
    source_sha256: String,
}

impl PrivateStagedSource {
    fn copy_from(
        source: &mut File,
        declared_size_bytes: u64,
        staging_root: &Path,
        cancellation: &AtomicBool,
    ) -> Result<Self, MediaImportServiceError> {
        let (mut staged, cleanup_path) = create_private_stage(staging_root)?;
        source.seek(SeekFrom::Start(0)).map_err(seek_error)?;

        let mut hasher = Sha256::new();
        let mut copied_bytes = 0_u64;
        let mut buffer = vec![0_u8; SOURCE_STAGE_CHUNK_BYTES];
        loop {
            if cancellation.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(MediaImportServiceError::new(
                    "MEDIA_IMPORT_CANCELLED",
                    "the local media import was cancelled",
                ));
            }
            let read = source.read(&mut buffer).map_err(read_error)?;
            if read == 0 {
                break;
            }
            copied_bytes = copied_bytes.checked_add(read as u64).ok_or_else(|| {
                MediaImportServiceError::new(
                    "MEDIA_IMPORT_TOO_LARGE",
                    "media input exceeds the import size limit",
                )
            })?;
            if copied_bytes > declared_size_bytes || copied_bytes > MAX_IMPORT_BYTES {
                return Err(MediaImportServiceError::new(
                    "MEDIA_IMPORT_SOURCE_CHANGED",
                    "the selected media source changed while it was being staged",
                ));
            }
            hasher.update(&buffer[..read]);
            staged.write_all(&buffer[..read]).map_err(|_| {
                MediaImportServiceError::new(
                    "MEDIA_IMPORT_STAGING_WRITE_FAILED",
                    "the selected media source could not be staged privately",
                )
            })?;
        }
        if copied_bytes != declared_size_bytes {
            return Err(MediaImportServiceError::new(
                "MEDIA_IMPORT_SOURCE_CHANGED",
                "the selected media source changed while it was being staged",
            ));
        }
        let final_metadata = source.metadata().map_err(|_| {
            MediaImportServiceError::new(
                "MEDIA_IMPORT_SOURCE_UNAVAILABLE",
                "the opened media source could not be inspected after staging",
            )
        })?;
        if !final_metadata.is_file() || final_metadata.len() != declared_size_bytes {
            return Err(MediaImportServiceError::new(
                "MEDIA_IMPORT_SOURCE_CHANGED",
                "the selected media source changed while it was being staged",
            ));
        }
        staged.flush().map_err(|_| {
            MediaImportServiceError::new(
                "MEDIA_IMPORT_STAGING_WRITE_FAILED",
                "the selected media source could not be staged privately",
            )
        })?;
        staged.seek(SeekFrom::Start(0)).map_err(seek_error)?;

        Ok(Self {
            file: Some(staged),
            cleanup_path,
            source_sha256: lowercase_hex(&hasher.finalize()),
        })
    }

    fn file_mut(&mut self) -> &mut File {
        self.file.as_mut().expect("private media stage is open")
    }

    fn try_clone(&self) -> std::io::Result<File> {
        self.file
            .as_ref()
            .expect("private media stage is open")
            .try_clone()
    }
}

impl Drop for PrivateStagedSource {
    fn drop(&mut self) {
        if let Some(file) = self.file.take() {
            drop(file);
        }
        if let Some(path) = self.cleanup_path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn create_private_stage(
    staging_root: &Path,
) -> Result<(File, Option<PathBuf>), MediaImportServiceError> {
    validate_local_storage_root(staging_root)?;
    fs::create_dir_all(staging_root).map_err(|_| {
        MediaImportServiceError::new(
            "MEDIA_IMPORT_STAGING_CREATE_FAILED",
            "private media staging could not be initialized",
        )
    })?;
    let root_metadata = fs::symlink_metadata(staging_root).map_err(|_| {
        MediaImportServiceError::new(
            "MEDIA_IMPORT_STAGING_CREATE_FAILED",
            "private media staging could not be inspected",
        )
    })?;
    if !root_metadata.is_dir()
        || root_metadata.file_type().is_symlink()
        || is_reparse_metadata(&root_metadata)
    {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_STAGING_CREATE_FAILED",
            "private media staging is not a regular local directory",
        ));
    }
    validate_local_storage_root(staging_root)?;
    protect_private_stage_root(staging_root)?;

    for _ in 0..PRIVATE_STAGE_CREATE_ATTEMPTS {
        let mut random = [0_u8; 16];
        getrandom(&mut random).map_err(|_| {
            MediaImportServiceError::new(
                "MEDIA_IMPORT_STAGING_CREATE_FAILED",
                "private media staging could not create a random identity",
            )
        })?;
        let path = staging_root.join(format!(
            ".candor-media-stage-{}-{}.tmp",
            process::id(),
            lowercase_hex(&random)
        ));
        match open_private_stage_file(&path) {
            Ok(file) => return finalize_private_stage_creation(file, path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                return Err(MediaImportServiceError::new(
                    "MEDIA_IMPORT_STAGING_CREATE_FAILED",
                    "private media staging could not create an isolated file",
                ))
            }
        }
    }
    Err(MediaImportServiceError::new(
        "MEDIA_IMPORT_STAGING_CREATE_FAILED",
        "private media staging could not allocate a unique file",
    ))
}

#[cfg(unix)]
fn open_private_stage_file(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(windows)]
fn open_private_stage_file(path: &Path) -> std::io::Result<File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, FILE_ATTRIBUTE_TEMPORARY,
        FILE_FLAG_DELETE_ON_CLOSE,
    };

    const DELETE_ACCESS: u32 = 0x0001_0000;
    let descriptor = private_stage_security_descriptor()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | DELETE_ACCESS,
            0,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_TEMPORARY
                | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED
                | FILE_FLAG_DELETE_ON_CLOSE,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_handle(handle as _) })
}

#[cfg(not(any(unix, windows)))]
fn open_private_stage_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
}

#[cfg(unix)]
fn finalize_private_stage_creation(
    file: File,
    path: PathBuf,
) -> Result<(File, Option<PathBuf>), MediaImportServiceError> {
    if fs::remove_file(&path).is_err() {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_STAGING_CREATE_FAILED",
            "private media staging could not become anonymous",
        ));
    }
    Ok((file, None))
}

#[cfg(not(unix))]
fn finalize_private_stage_creation(
    file: File,
    path: PathBuf,
) -> Result<(File, Option<PathBuf>), MediaImportServiceError> {
    Ok((file, Some(path)))
}

#[cfg(unix)]
fn protect_private_stage_root(path: &Path) -> Result<(), MediaImportServiceError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| {
        MediaImportServiceError::new(
            "MEDIA_IMPORT_STAGING_CREATE_FAILED",
            "private media staging permissions could not be restricted",
        )
    })
}

#[cfg(windows)]
struct PrivateStageSecurityDescriptor(windows_sys::Win32::Security::PSECURITY_DESCRIPTOR);

#[cfg(windows)]
impl Drop for PrivateStageSecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::LocalFree(self.0 as _);
        }
    }
}

#[cfg(windows)]
fn private_stage_security_descriptor() -> std::io::Result<PrivateStageSecurityDescriptor> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;

    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::PSECURITY_DESCRIPTOR;

    let process_user_sid = crate::local_instruct_model::current_process_user_sid_string()?;
    let descriptor_sddl = format!("D:P(A;;FA;;;{process_user_sid})(A;;FA;;;SY)");
    let sddl = OsStr::new(&descriptor_sddl)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(PrivateStageSecurityDescriptor(descriptor))
}

#[cfg(windows)]
fn protect_private_stage_root(path: &Path) -> Result<(), MediaImportServiceError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Security::{
        SetFileSecurityW, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    };

    let descriptor = private_stage_security_descriptor().map_err(|_| {
        MediaImportServiceError::new(
            "MEDIA_IMPORT_STAGING_CREATE_FAILED",
            "private media staging permissions could not be prepared",
        )
    })?;
    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    if unsafe {
        SetFileSecurityW(
            wide_path.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor.0,
        )
    } == 0
    {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_STAGING_CREATE_FAILED",
            "private media staging permissions could not be restricted",
        ));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn protect_private_stage_root(_path: &Path) -> Result<(), MediaImportServiceError> {
    Ok(())
}

fn validate_source_sha256(value: &str) -> Result<(), MediaImportServiceError> {
    if value.len() != SOURCE_SHA256_HEX_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_IDENTITY_INVALID",
            "the selected media source identity is invalid",
        ));
    }
    Ok(())
}

fn lowercase_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

struct ValidatedLocalSource {
    canonical_path: PathBuf,
    source_size_bytes: u64,
}

struct OpenedLocalSource {
    file: File,
    canonical_path: PathBuf,
    source_size_bytes: u64,
}

fn validate_local_source(
    source_path: &Path,
) -> Result<ValidatedLocalSource, MediaImportServiceError> {
    if !source_path.is_absolute() {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_NOT_LOCAL",
            "the selected media source must use an absolute local path",
        ));
    }
    ensure_path_uses_local_storage(source_path)?;
    reject_symlink_components(source_path)?;
    let source_metadata = fs::symlink_metadata(source_path).map_err(|_| {
        MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_UNAVAILABLE",
            "the selected media source could not be inspected",
        )
    })?;
    reject_reparse_metadata(&source_metadata)?;
    reject_cloud_placeholder_metadata(&source_metadata)?;
    if !source_metadata.is_file() {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_NOT_FILE",
            "the selected media source is not a regular file",
        ));
    }

    let canonical_path = fs::canonicalize(source_path).map_err(|_| {
        MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_UNAVAILABLE",
            "the selected media source could not be resolved",
        )
    })?;
    ensure_path_uses_local_storage(&canonical_path)?;
    let metadata = fs::metadata(&canonical_path).map_err(|_| {
        MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_UNAVAILABLE",
            "the selected media source could not be inspected",
        )
    })?;
    reject_reparse_metadata(&metadata)?;
    reject_cloud_placeholder_metadata(&metadata)?;
    if !metadata.is_file() {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_NOT_FILE",
            "the selected media source is not a regular file",
        ));
    }
    let source_size_bytes = metadata.len();
    if source_size_bytes == 0 {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_EMPTY",
            "media input must not be empty",
        ));
    }
    if source_size_bytes > MAX_IMPORT_BYTES {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_TOO_LARGE",
            "media input exceeds the import size limit",
        ));
    }

    Ok(ValidatedLocalSource {
        canonical_path,
        source_size_bytes,
    })
}

#[cfg(windows)]
fn open_local_source(source_path: &Path) -> Result<OpenedLocalSource, MediaImportServiceError> {
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileAttributeTagInfo, GetFileInformationByHandleEx, GetFinalPathNameByHandleW,
        FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_SEQUENTIAL_SCAN, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, VOLUME_NAME_DOS,
    };

    // Keep the existing lexical and metadata checks for clear early errors, but
    // do not trust them as the final authority. The handle opened below is
    // independently checked after CreateFileW so a path swap cannot redirect
    // staging to a reparse point or remote volume between validation and open.
    let validated = validate_local_source(source_path)?;
    let wide_path = validated
        .canonical_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_OPEN_FAILED",
            "the selected media source could not be opened",
        ));
    }
    let file = unsafe { File::from_raw_handle(handle as _) };
    let raw_handle = file.as_raw_handle() as HANDLE;

    let mut tag_info = FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            raw_handle,
            FileAttributeTagInfo,
            (&mut tag_info as *mut FILE_ATTRIBUTE_TAG_INFO).cast::<c_void>(),
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_UNAVAILABLE",
            "the opened media source could not be inspected safely",
        ));
    }
    if tag_info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_SYMLINK_REJECTED",
            "filesystem reparse points are not accepted for import",
        ));
    }
    reject_cloud_placeholder_attributes(tag_info.FileAttributes)?;

    let mut final_path_buffer = vec![0_u16; 32_768];
    let final_path_length = unsafe {
        GetFinalPathNameByHandleW(
            raw_handle,
            final_path_buffer.as_mut_ptr(),
            final_path_buffer.len() as u32,
            VOLUME_NAME_DOS,
        )
    };
    if final_path_length == 0 || final_path_length as usize >= final_path_buffer.len() {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_UNAVAILABLE",
            "the opened media source identity could not be resolved",
        ));
    }
    let final_path = PathBuf::from(OsString::from_wide(
        &final_path_buffer[..final_path_length as usize],
    ));
    ensure_path_uses_local_storage(&final_path)?;
    reject_symlink_components(&final_path)?;

    let metadata = file.metadata().map_err(|_| {
        MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_UNAVAILABLE",
            "the opened media source could not be inspected",
        )
    })?;
    reject_reparse_metadata(&metadata)?;
    reject_cloud_placeholder_metadata(&metadata)?;
    if !metadata.is_file() || metadata.len() != validated.source_size_bytes {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_CHANGED",
            "the selected media source changed while it was being opened",
        ));
    }

    Ok(OpenedLocalSource {
        file,
        canonical_path: final_path,
        source_size_bytes: metadata.len(),
    })
}

#[cfg(not(windows))]
fn open_local_source(source_path: &Path) -> Result<OpenedLocalSource, MediaImportServiceError> {
    let validated = validate_local_source(source_path)?;
    let file = File::open(&validated.canonical_path).map_err(|_| {
        MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_OPEN_FAILED",
            "the selected media source could not be opened",
        )
    })?;
    let metadata = file.metadata().map_err(|_| {
        MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_UNAVAILABLE",
            "the opened media source could not be inspected",
        )
    })?;
    reject_reparse_metadata(&metadata)?;
    reject_cloud_placeholder_metadata(&metadata)?;
    if !metadata.is_file() || metadata.len() != validated.source_size_bytes {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_CHANGED",
            "the selected media source changed while it was being opened",
        ));
    }
    Ok(OpenedLocalSource {
        file,
        canonical_path: validated.canonical_path,
        source_size_bytes: validated.source_size_bytes,
    })
}

#[cfg(windows)]
fn ensure_path_uses_local_storage(path: &Path) -> Result<(), MediaImportServiceError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumePathNameW};
    use windows_sys::Win32::System::WindowsProgramming::{DRIVE_FIXED, DRIVE_REMOVABLE};

    ensure_windows_disk_path_prefix(path)?;

    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut volume_path = vec![0_u16; 32_768];
    if unsafe {
        GetVolumePathNameW(
            wide_path.as_ptr(),
            volume_path.as_mut_ptr(),
            volume_path.len() as u32,
        )
    } == 0
    {
        return Err(non_local_source_error());
    }
    let drive_type = unsafe { GetDriveTypeW(volume_path.as_ptr()) };
    if drive_type != DRIVE_FIXED && drive_type != DRIVE_REMOVABLE {
        return Err(non_local_source_error());
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_windows_disk_path_prefix(path: &Path) -> Result<(), MediaImportServiceError> {
    use std::path::{Component, Prefix};

    match path.components().next() {
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) =>
        {
            Ok(())
        }
        _ => Err(non_local_source_error()),
    }
}

#[cfg(all(not(windows), not(test)))]
fn ensure_path_uses_local_storage(_path: &Path) -> Result<(), MediaImportServiceError> {
    // Per-path mount locality is not yet provable on non-Windows targets in this
    // release. Fail closed so filtered disk enumeration cannot misclassify a
    // remote mount under a local root mount.
    Err(non_local_source_error())
}

#[cfg(all(not(windows), test))]
fn ensure_path_uses_local_storage(path: &Path) -> Result<(), MediaImportServiceError> {
    if test_path_is_under_local_temp(path) {
        Ok(())
    } else {
        Err(non_local_source_error())
    }
}

fn non_local_source_error() -> MediaImportServiceError {
    MediaImportServiceError::new(
        "MEDIA_IMPORT_SOURCE_NOT_LOCAL",
        "the selected media source is not on verified local storage",
    )
}

#[cfg(windows)]
fn validate_local_storage_root(path: &Path) -> Result<(), MediaImportServiceError> {
    if !path.is_absolute() || ensure_windows_disk_path_prefix(path).is_err() {
        return Err(non_local_storage_error());
    }

    let mut found_existing_ancestor = false;
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                found_existing_ancestor = true;
                if ensure_path_uses_local_storage(ancestor).is_err()
                    || !metadata.is_dir()
                    || metadata.file_type().is_symlink()
                    || is_reparse_metadata(&metadata)
                    || reject_cloud_placeholder_metadata(&metadata).is_err()
                {
                    return Err(non_local_storage_error());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(non_local_storage_error()),
        }
    }
    if !found_existing_ancestor {
        return Err(non_local_storage_error());
    }
    Ok(())
}

#[cfg(all(not(windows), not(test)))]
fn validate_local_storage_root(_path: &Path) -> Result<(), MediaImportServiceError> {
    Err(non_local_storage_error())
}

#[cfg(all(not(windows), test))]
fn validate_local_storage_root(path: &Path) -> Result<(), MediaImportServiceError> {
    if !path.is_absolute() || !test_path_is_under_local_temp(path) {
        return Err(non_local_storage_error());
    }
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(non_local_storage_error());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(non_local_storage_error()),
        }
    }
    Ok(())
}

#[cfg(all(not(windows), test))]
fn test_path_is_under_local_temp(path: &Path) -> bool {
    let lexical_temp = std::env::temp_dir();
    if path.starts_with(&lexical_temp) {
        return true;
    }
    fs::canonicalize(&lexical_temp).is_ok_and(|canonical_temp| path.starts_with(canonical_temp))
}

fn non_local_storage_error() -> MediaImportServiceError {
    MediaImportServiceError::new(
        "MEDIA_IMPORT_STORAGE_NOT_LOCAL",
        "private media storage is not on verified local storage",
    )
}

#[cfg(windows)]
fn reject_cloud_placeholder_metadata(metadata: &Metadata) -> Result<(), MediaImportServiceError> {
    use std::os::windows::fs::MetadataExt;

    reject_cloud_placeholder_attributes(metadata.file_attributes())
}

#[cfg(windows)]
fn reject_cloud_placeholder_attributes(attributes: u32) -> Result<(), MediaImportServiceError> {
    const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
    const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
    const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    if attributes
        & (FILE_ATTRIBUTE_OFFLINE
            | FILE_ATTRIBUTE_RECALL_ON_OPEN
            | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)
        != 0
    {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_SOURCE_CLOUD_PLACEHOLDER",
            "cloud placeholder media must be made fully local before import",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn reject_cloud_placeholder_metadata(_metadata: &Metadata) -> Result<(), MediaImportServiceError> {
    Ok(())
}

struct PreparedSource {
    staged: PrivateStagedSource,
    display_name: String,
    source_size_bytes: u64,
    #[cfg(test)]
    source_sha256: String,
    media_kind: MediaKind,
    #[cfg(test)]
    status: MediaImportStatus,
    media: PreparedMedia,
}

impl PreparedSource {
    #[cfg(test)]
    fn open(
        params: TrustedMainImportParams,
        staging_root: &Path,
        cancellation: &AtomicBool,
    ) -> Result<Self, MediaImportServiceError> {
        Self::open_with_after_stage(params, staging_root, cancellation, || {})
    }

    fn open_with_after_stage<F>(
        params: TrustedMainImportParams,
        staging_root: &Path,
        cancellation: &AtomicBool,
        after_stage: F,
    ) -> Result<Self, MediaImportServiceError>
    where
        F: FnOnce(),
    {
        if let Some(expected) = params.expected_source_sha256.as_deref() {
            validate_source_sha256(expected)?;
        }
        let opened_source = open_local_source(&params.source_path)?;
        let canonical_path = opened_source.canonical_path;
        let source_size_bytes = opened_source.source_size_bytes;
        let display_name = canonical_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                MediaImportServiceError::new(
                    "MEDIA_IMPORT_NAME_INVALID",
                    "media name must be valid Unicode",
                )
            })?
            .to_owned();

        let mut source_file = opened_source.file;

        let mut staged = PrivateStagedSource::copy_from(
            &mut source_file,
            source_size_bytes,
            staging_root,
            cancellation,
        )?;
        if let Some(expected) = params.expected_source_sha256.as_deref() {
            if staged.source_sha256 != expected {
                return Err(MediaImportServiceError::new(
                    "MEDIA_IMPORT_SOURCE_IDENTITY_MISMATCH",
                    "the selected media source changed after it was inspected",
                ));
            }
        }
        after_stage();
        if cancellation.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(MediaImportServiceError::new(
                "MEDIA_IMPORT_CANCELLED",
                "the local media import was cancelled",
            ));
        }

        let mut probe = vec![0_u8; MAX_MAGIC_PROBE_BYTES.min(source_size_bytes as usize)];
        staged.file_mut().read_exact(&mut probe).map_err(|_| {
            MediaImportServiceError::new(
                "MEDIA_IMPORT_SOURCE_READ_FAILED",
                "the media signature could not be read",
            )
        })?;

        let initial_plan = validate_media_import(MediaImportCandidate {
            display_name: &display_name,
            declared_size_bytes: source_size_bytes,
            magic_probe: &probe,
            duration_ms: None,
            decoder: local_decoder_capability(false, false),
        })
        .map_err(|error| MediaImportServiceError::new(error.code, error.message))?;
        let media = match initial_plan.media_kind {
            MediaKind::Wav => {
                staged
                    .file_mut()
                    .seek(SeekFrom::Start(0))
                    .map_err(seek_error)?;
                PreparedMedia::Wav(parse_pcm16_wav(staged.file_mut(), source_size_bytes)?)
            }
            kind => {
                let decoder_file = staged.try_clone().map_err(|_| {
                    MediaImportServiceError::new(
                        "MEDIA_IMPORT_SOURCE_OPEN_FAILED",
                        "the selected media source could not be opened for local decoding",
                    )
                })?;
                PreparedMedia::Compressed(
                    probe_compressed_media(decoder_file, kind).map_err(decoder_error)?,
                )
            }
        };
        let plan = validate_media_import(MediaImportCandidate {
            display_name: &display_name,
            declared_size_bytes: source_size_bytes,
            magic_probe: &probe,
            duration_ms: media.duration_ms(),
            decoder: local_decoder_capability(true, true),
        })
        .map_err(|error| MediaImportServiceError::new(error.code, error.message))?;
        if cancellation.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(MediaImportServiceError::new(
                "MEDIA_IMPORT_CANCELLED",
                "the local media import was cancelled",
            ));
        }
        #[cfg(test)]
        let source_sha256 = staged.source_sha256.clone();

        Ok(Self {
            staged,
            display_name,
            source_size_bytes,
            #[cfg(test)]
            source_sha256,
            media_kind: plan.media_kind,
            #[cfg(test)]
            status: plan.status,
            media,
        })
    }

    #[cfg(test)]
    fn inspect_response(&self) -> MediaImportInspectResponse {
        MediaImportInspectResponse {
            schema_version: MEDIA_IMPORT_SERVICE_SCHEMA_VERSION,
            display_name: self.display_name.clone(),
            media_kind: self.media_kind,
            source_size_bytes: self.source_size_bytes,
            duration_ms: self.media.duration_ms(),
            sample_rate_hz: self.media.sample_rate_hz(),
            channel_count: self.media.channel_count(),
            bits_per_sample: Some(16),
            source_sha256: self.source_sha256.clone(),
            status: self.status,
            import_supported: true,
            decoder_execution_attempted: false,
            source_modified: false,
            local_only: true,
            network_attempted: false,
            raw_path_exposed: false,
            key_material_exposed_to_renderer: false,
        }
    }
}

fn parse_pcm16_wav(file: &mut File, file_size: u64) -> Result<ParsedWav, MediaImportServiceError> {
    if file_size < 44 {
        return Err(wav_error(
            "PCM WAV input is shorter than its minimum header",
        ));
    }
    let mut riff_header = [0_u8; 12];
    file.read_exact(&mut riff_header).map_err(read_error)?;
    if &riff_header[0..4] != b"RIFF" || &riff_header[8..12] != b"WAVE" {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_TYPE_MISMATCH",
            "media extension does not match a RIFF/WAVE signature",
        ));
    }
    let riff_size = u32::from_le_bytes(riff_header[4..8].try_into().unwrap()) as u64;
    if riff_size.checked_add(8) != Some(file_size) {
        return Err(wav_error(
            "RIFF length must describe the entire selected WAV file",
        ));
    }

    let mut cursor = 12_u64;
    let mut fmt: Option<(u32, u16, u16)> = None;
    let mut pcm_ranges = Vec::new();
    let mut total_pcm_bytes = 0_u64;
    let mut chunk_count = 0_usize;
    while cursor < file_size {
        chunk_count += 1;
        if chunk_count > MAX_RIFF_CHUNKS || file_size.saturating_sub(cursor) < 8 {
            return Err(wav_error(
                "WAV chunk table is malformed or exceeds its limit",
            ));
        }
        file.seek(SeekFrom::Start(cursor)).map_err(seek_error)?;
        let mut chunk_header = [0_u8; 8];
        file.read_exact(&mut chunk_header).map_err(read_error)?;
        let chunk_id: [u8; 4] = chunk_header[0..4].try_into().unwrap();
        let chunk_len = u32::from_le_bytes(chunk_header[4..8].try_into().unwrap()) as u64;
        let data_offset = cursor
            .checked_add(8)
            .ok_or_else(|| wav_error("WAV offset overflow"))?;
        let data_end = data_offset
            .checked_add(chunk_len)
            .ok_or_else(|| wav_error("WAV chunk length overflow"))?;
        let padded_end = data_end
            .checked_add(chunk_len & 1)
            .ok_or_else(|| wav_error("WAV padding overflow"))?;
        if padded_end > file_size {
            return Err(wav_error("WAV chunk extends beyond the selected file"));
        }

        match &chunk_id {
            b"fmt " => {
                if fmt.is_some() || !(16..=64 * 1024).contains(&chunk_len) {
                    return Err(wav_error("WAV must contain one bounded PCM format chunk"));
                }
                let mut header = [0_u8; 16];
                file.read_exact(&mut header).map_err(read_error)?;
                let audio_format = u16::from_le_bytes(header[0..2].try_into().unwrap());
                let channel_count = u16::from_le_bytes(header[2..4].try_into().unwrap());
                let sample_rate_hz = u32::from_le_bytes(header[4..8].try_into().unwrap());
                let byte_rate = u32::from_le_bytes(header[8..12].try_into().unwrap());
                let block_align = u16::from_le_bytes(header[12..14].try_into().unwrap());
                let bits_per_sample = u16::from_le_bytes(header[14..16].try_into().unwrap());
                let expected_align = channel_count
                    .checked_mul(2)
                    .ok_or_else(|| wav_error("WAV channel count overflows its PCM frame size"))?;
                let expected_rate = sample_rate_hz
                    .checked_mul(u32::from(expected_align))
                    .ok_or_else(|| wav_error("WAV byte rate overflows its supported range"))?;
                if audio_format != 1
                    || bits_per_sample != 16
                    || !(1..=8).contains(&channel_count)
                    || !(8_000..=192_000).contains(&sample_rate_hz)
                    || block_align != expected_align
                    || byte_rate != expected_rate
                {
                    return Err(MediaImportServiceError::new(
                        "MEDIA_IMPORT_WAV_FORMAT_UNSUPPORTED",
                        "only native PCM 16-bit WAV at 8-192 kHz with 1-8 channels is supported",
                    ));
                }
                fmt = Some((sample_rate_hz, channel_count, block_align));
            }
            b"data" => {
                if chunk_len == 0 || pcm_ranges.len() >= MAX_RIFF_CHUNKS {
                    return Err(wav_error(
                        "WAV audio data is empty or fragmented excessively",
                    ));
                }
                total_pcm_bytes = total_pcm_bytes
                    .checked_add(chunk_len)
                    .ok_or_else(|| wav_error("WAV audio data length overflow"))?;
                pcm_ranges.push(PcmRange {
                    offset: data_offset,
                    length: chunk_len,
                });
            }
            _ => {}
        }
        cursor = padded_end;
    }
    if cursor != file_size {
        return Err(wav_error(
            "WAV chunk table did not end at the file boundary",
        ));
    }
    let (sample_rate_hz, channel_count, block_align) = fmt.ok_or_else(|| {
        MediaImportServiceError::new(
            "MEDIA_IMPORT_WAV_FORMAT_MISSING",
            "WAV input does not contain a PCM format chunk",
        )
    })?;
    if pcm_ranges.is_empty() || total_pcm_bytes == 0 {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_WAV_DATA_MISSING",
            "WAV input does not contain audio data",
        ));
    }
    if pcm_ranges
        .iter()
        .any(|range| range.length % u64::from(block_align) != 0)
    {
        return Err(wav_error(
            "WAV audio data does not contain whole PCM frames",
        ));
    }
    let frame_count = total_pcm_bytes / u64::from(block_align);
    let duration_ms = frame_count
        .checked_mul(1_000)
        .ok_or_else(|| wav_error("WAV duration overflow"))?
        / u64::from(sample_rate_hz);
    let duration_ms = duration_ms.max(1);
    if duration_ms > MAX_IMPORT_DURATION_MS {
        return Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_DURATION_LIMIT",
            "media duration exceeds the import limit",
        ));
    }

    Ok(ParsedWav {
        sample_rate_hz,
        channel_count,
        block_align,
        total_pcm_bytes,
        duration_ms,
        pcm_ranges,
    })
}

fn import_pcm_ranges(
    file: &mut File,
    store: &RecordingStore,
    recording_id: &str,
    wav: &ParsedWav,
    cancellation: &AtomicBool,
) -> Result<u32, MediaImportServiceError> {
    let frame_bytes = usize::from(wav.block_align);
    let buffer_capacity = IMPORT_PCM_CHUNK_BYTES - (IMPORT_PCM_CHUNK_BYTES % frame_bytes);
    let mut buffer = vec![0_u8; buffer_capacity];
    let mut chunk_count = 0_u32;
    let mut start_ms = 0_u64;

    for range in &wav.pcm_ranges {
        file.seek(SeekFrom::Start(range.offset))
            .map_err(seek_error)?;
        let mut remaining = range.length;
        while remaining > 0 {
            if cancellation.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(MediaImportServiceError::new(
                    "MEDIA_IMPORT_CANCELLED",
                    "the local media import was cancelled",
                ));
            }
            let read_len = usize::try_from(remaining.min(buffer.len() as u64)).map_err(|_| {
                MediaImportServiceError::new(
                    "MEDIA_IMPORT_WAV_RANGE_INVALID",
                    "WAV audio range could not be represented safely",
                )
            })?;
            file.read_exact(&mut buffer[..read_len])
                .map_err(read_error)?;
            store
                .write_audio_chunk(WriteAudioChunkParams {
                    recording_id: recording_id.to_owned(),
                    channel: "imported-media".to_owned(),
                    data_base64: BASE64_STANDARD.encode(&buffer[..read_len]),
                    sample_rate_hz: wav.sample_rate_hz,
                    channel_count: wav.channel_count,
                    bits_per_sample: 16,
                    start_ms: Some(start_ms),
                })
                .map_err(store_error)?;
            let frames = read_len as u64 / u64::from(wav.block_align);
            start_ms = start_ms
                .saturating_add(frames.saturating_mul(1_000) / u64::from(wav.sample_rate_hz));
            chunk_count = chunk_count.checked_add(1).ok_or_else(|| {
                MediaImportServiceError::new(
                    "MEDIA_IMPORT_CHUNK_LIMIT",
                    "imported audio required too many durable chunks",
                )
            })?;
            remaining -= read_len as u64;
        }
    }
    Ok(chunk_count)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ImportedPcmSummary {
    total_pcm_bytes: u64,
    duration_ms: u64,
    sample_rate_hz: u32,
    channel_count: u16,
    chunk_count: u32,
    original_audio_retained: bool,
    decoder_execution_attempted: bool,
}

fn import_prepared_media(
    prepared: &mut PreparedSource,
    store: &RecordingStore,
    recording_id: &str,
    cancellation: &AtomicBool,
) -> Result<ImportedPcmSummary, MediaImportServiceError> {
    match prepared.media.clone() {
        PreparedMedia::Wav(wav) => {
            if cancellation.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(MediaImportServiceError::new(
                    "MEDIA_IMPORT_CANCELLED",
                    "the local media import was cancelled",
                ));
            }
            let chunk_count = import_pcm_ranges(
                prepared.staged.file_mut(),
                store,
                recording_id,
                &wav,
                cancellation,
            )?;
            Ok(ImportedPcmSummary {
                total_pcm_bytes: wav.total_pcm_bytes,
                duration_ms: wav.duration_ms,
                sample_rate_hz: wav.sample_rate_hz,
                channel_count: wav.channel_count,
                chunk_count,
                original_audio_retained: true,
                decoder_execution_attempted: false,
            })
        }
        PreparedMedia::Compressed(_) => {
            let decoder_file = prepared.staged.try_clone().map_err(|_| {
                MediaImportServiceError::new(
                    "MEDIA_IMPORT_SOURCE_OPEN_FAILED",
                    "the selected media source could not be opened for local decoding",
                )
            })?;
            let mut chunk_count = 0_u32;
            let decoded = decode_compressed_media(
                decoder_file,
                prepared.media_kind,
                cancellation,
                |pcm, sample_rate_hz, channel_count, start_ms| {
                    store
                        .write_audio_chunk(WriteAudioChunkParams {
                            recording_id: recording_id.to_owned(),
                            channel: "imported-media".to_owned(),
                            data_base64: BASE64_STANDARD.encode(pcm),
                            sample_rate_hz,
                            channel_count,
                            bits_per_sample: 16,
                            start_ms: Some(start_ms),
                        })
                        .map_err(|error| {
                            MediaDecoderError::new(
                                "MEDIA_IMPORT_STORE_FAILED",
                                format!(
                                    "durable recording storage rejected imported audio ({})",
                                    error.code
                                ),
                            )
                        })?;
                    chunk_count = chunk_count.checked_add(1).ok_or_else(|| {
                        MediaDecoderError::new(
                            "MEDIA_IMPORT_CHUNK_LIMIT",
                            "imported audio required too many durable chunks",
                        )
                    })?;
                    Ok(())
                },
            )
            .map_err(decoder_error)?;
            Ok(ImportedPcmSummary {
                total_pcm_bytes: decoded.decoded_pcm_bytes,
                duration_ms: decoded.duration_ms,
                sample_rate_hz: decoded.sample_rate_hz,
                channel_count: decoded.channel_count,
                chunk_count,
                original_audio_retained: false,
                decoder_execution_attempted: true,
            })
        }
    }
}

fn failure_after_cleanup(
    store: &RecordingStore,
    recording_id: &str,
    original: MediaImportServiceError,
) -> MediaImportServiceError {
    match store.abort_unfinished(RecordingIdParams {
        recording_id: recording_id.to_owned(),
    }) {
        Ok(_) => original,
        Err(cleanup) => MediaImportServiceError::new(
            "MEDIA_IMPORT_CLEANUP_FAILED",
            format!(
                "media import failed with {} and its new partial recording could not be removed ({})",
                original.code, cleanup.code
            ),
        ),
    }
}

fn reject_symlink_components(path: &Path) -> Result<(), MediaImportServiceError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| {
                MediaImportServiceError::new(
                    "MEDIA_IMPORT_SOURCE_UNAVAILABLE",
                    "the current directory could not be resolved",
                )
            })?
            .join(path)
    };
    for component in absolute.ancestors() {
        match fs::symlink_metadata(component) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || is_reparse_metadata(&metadata) {
                    return Err(MediaImportServiceError::new(
                        "MEDIA_IMPORT_SYMLINK_REJECTED",
                        "symbolic links and filesystem reparse points are not accepted for import",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(MediaImportServiceError::new(
                    "MEDIA_IMPORT_SOURCE_UNAVAILABLE",
                    "the selected media source could not be inspected safely",
                ));
            }
        }
    }
    Ok(())
}

fn reject_reparse_metadata(metadata: &Metadata) -> Result<(), MediaImportServiceError> {
    if is_reparse_metadata(metadata) {
        Err(MediaImportServiceError::new(
            "MEDIA_IMPORT_SYMLINK_REJECTED",
            "filesystem reparse points are not accepted for import",
        ))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn is_reparse_metadata(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_metadata(_metadata: &Metadata) -> bool {
    false
}

fn read_error(_error: std::io::Error) -> MediaImportServiceError {
    MediaImportServiceError::new(
        "MEDIA_IMPORT_SOURCE_READ_FAILED",
        "the selected media source could not be read completely",
    )
}

fn seek_error(_error: std::io::Error) -> MediaImportServiceError {
    MediaImportServiceError::new(
        "MEDIA_IMPORT_SOURCE_SEEK_FAILED",
        "the selected media source could not be traversed safely",
    )
}

fn wav_error(message: impl Into<String>) -> MediaImportServiceError {
    MediaImportServiceError::new("MEDIA_IMPORT_WAV_MALFORMED", message)
}

fn store_error(error: crate::recording_store::RecordingStoreError) -> MediaImportServiceError {
    MediaImportServiceError::new(
        "MEDIA_IMPORT_STORE_FAILED",
        format!(
            "durable recording storage rejected imported audio ({})",
            error.code
        ),
    )
}

fn decoder_error(error: MediaDecoderError) -> MediaImportServiceError {
    MediaImportServiceError::new(error.code, error.message)
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    use base64::Engine as _;
    use serde_json::Value;

    use super::*;
    use crate::media_test_fixtures::{
        decode, OPUS_WEBM, TONE_ALAC_M4A, TONE_M4A, TONE_MP3, TONE_WEBM, VIDEO_ONLY_MP4,
    };
    use crate::recording_store::AudioChunkParams;

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(1);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let suffix = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "candor-media-import-{name}-{}-{suffix}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            #[cfg(not(windows))]
            let path = fs::canonicalize(path).expect("canonicalize test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn pcm16_wav(sample_rate: u32, channels: u16, pcm: &[u8]) -> Vec<u8> {
        assert_eq!(pcm.len() % (usize::from(channels) * 2), 0);
        let mut body = Vec::new();
        body.extend_from_slice(b"fmt ");
        body.extend_from_slice(&16_u32.to_le_bytes());
        body.extend_from_slice(&1_u16.to_le_bytes());
        body.extend_from_slice(&channels.to_le_bytes());
        body.extend_from_slice(&sample_rate.to_le_bytes());
        body.extend_from_slice(&(sample_rate * u32::from(channels) * 2).to_le_bytes());
        body.extend_from_slice(&(channels * 2).to_le_bytes());
        body.extend_from_slice(&16_u16.to_le_bytes());
        body.extend_from_slice(b"data");
        body.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        body.extend_from_slice(pcm);
        if !pcm.len().is_multiple_of(2) {
            body.push(0);
        }
        body.extend_from_slice(b"LIST");
        body.extend_from_slice(&4_u32.to_le_bytes());
        body.extend_from_slice(b"INFO");
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(&body);
        wav
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        let mut file = File::create(path).expect("create media file");
        file.write_all(bytes).expect("write media file");
        file.sync_all().expect("flush media file");
    }

    fn service(dir: &TestDir) -> MediaImportService {
        let root = dir.path().join("private-media-staging");
        MediaImportService::with_staging_root(root)
    }

    fn assert_private_staging_empty(dir: &TestDir) {
        let root = dir.path().join("private-media-staging");
        if root.exists() {
            assert_eq!(
                fs::read_dir(root)
                    .expect("read private media staging root")
                    .count(),
                0,
                "private media staging retained a file"
            );
        }
    }

    fn assert_vault_has_no_staged_source_or_temporary_file(vault: &Path, source_name: &str) {
        let mut pending = vec![vault.to_path_buf()];
        while let Some(directory) = pending.pop() {
            if !directory.exists() {
                continue;
            }
            for entry in fs::read_dir(directory).expect("read vault directory") {
                let entry = entry.expect("read vault entry");
                let path = entry.path();
                if entry.file_type().expect("inspect vault entry").is_dir() {
                    pending.push(path);
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                assert_ne!(name, source_name.to_ascii_lowercase());
                assert!(!name.ends_with(".tmp"), "temporary vault file remained");
                assert!(!name.ends_with(".part"), "partial vault file remained");
                assert!(!name.contains("staging"), "staging vault file remained");
            }
        }
    }

    #[test]
    fn inspects_valid_pcm16_wav_without_exposing_a_path() {
        let dir = TestDir::new("inspect-wav");
        let source = dir.path().join("meeting.wav");
        let pcm = vec![0x24_u8; 32_000];
        let wav_bytes = pcm16_wav(16_000, 1, &pcm);
        let expected_source_sha256 = lowercase_hex(&Sha256::digest(&wav_bytes));
        write_file(&source, &wav_bytes);

        let response = service(&dir)
            .inspect_source(source)
            .expect("inspect PCM WAV");
        assert_eq!(response.status, MediaImportStatus::Ready);
        assert!(response.import_supported);
        assert_eq!(response.duration_ms, Some(1_000));
        assert_eq!(response.sample_rate_hz, Some(16_000));
        assert_eq!(response.source_sha256, expected_source_sha256);
        let json = serde_json::to_value(response).expect("serialize response");
        assert_eq!(json["sourceSha256"], expected_source_sha256);
        assert_eq!(json["rawPathExposed"], false);
        assert_eq!(json["keyMaterialExposedToRenderer"], false);
        assert!(json.get("sourcePath").is_none());
        assert!(json.get("canonicalPath").is_none());
        assert_private_staging_empty(&dir);
    }

    #[test]
    fn imports_pcm_losslessly_in_durable_bounded_chunks() {
        let dir = TestDir::new("import-wav");
        let source = dir.path().join("long meeting.wav");
        let pcm = (0..(SOURCE_STAGE_CHUNK_BYTES + 64_000))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let wav_bytes = pcm16_wav(16_000, 1, &pcm);
        write_file(&source, &wav_bytes);
        let before = fs::read(&source).expect("read source before import");
        let store = RecordingStore::with_root(dir.path().join("vault"));

        let response = service(&dir)
            .import_source(&store, source.clone())
            .expect("import PCM WAV");
        assert!(response.imported);
        assert!(response.original_audio_retained);
        assert!(!response.container_metadata_preserved);
        assert!(response.durable_chunk_count >= 2);
        assert_eq!(fs::read(&source).expect("read source after import"), before);

        let recording_id = response.recording_id.expect("recording id");
        let replay = store
            .replay_manifest(RecordingIdParams {
                recording_id: recording_id.clone(),
            })
            .expect("replay manifest");
        assert_eq!(replay["state"], "finished");
        assert_eq!(replay["audioChunkCount"], response.durable_chunk_count);

        let mut reconstructed = Vec::new();
        for index in 0..response.durable_chunk_count {
            let chunk = store
                .read_audio_chunk(AudioChunkParams {
                    recording_id: recording_id.clone(),
                    index,
                })
                .expect("read imported chunk");
            let decoded = BASE64_STANDARD
                .decode(chunk["dataBase64"].as_str().expect("base64 audio"))
                .expect("decode imported chunk");
            reconstructed.extend_from_slice(&decoded);
        }
        assert_eq!(reconstructed, pcm);
        const { assert!(SOURCE_STAGE_CHUNK_BYTES <= 1024 * 1024) };
        assert_private_staging_empty(&dir);
    }

    #[test]
    fn rejects_same_size_source_substitution_before_creating_a_recording() {
        let dir = TestDir::new("identity-substitution");
        let source = dir.path().join("meeting.wav");
        let original = pcm16_wav(16_000, 1, &[0x11_u8; 32_000]);
        let replacement = pcm16_wav(16_000, 1, &[0x22_u8; 32_000]);
        assert_eq!(original.len(), replacement.len());
        write_file(&source, &original);
        let media_import = service(&dir);
        let expected = media_import
            .inspect_source(source.clone())
            .expect("inspect original source")
            .source_sha256;
        write_file(&source, &replacement);
        let store = RecordingStore::with_root(dir.path().join("vault"));
        let cancellation = AtomicBool::new(false);

        let error = media_import
            .import_source_cancellable(&store, source, expected, &cancellation)
            .expect_err("same-size replacement must fail identity binding");

        assert_eq!(error.code, "MEDIA_IMPORT_SOURCE_IDENTITY_MISMATCH");
        assert_eq!(store.list().expect("list recordings")["recordingCount"], 0);
        assert_private_staging_empty(&dir);
    }

    #[test]
    fn rejects_invalid_source_identity_before_accessing_the_source_path() {
        let dir = TestDir::new("identity-invalid");
        let missing_source = dir.path().join("does-not-exist.wav");
        let store = RecordingStore::with_root(dir.path().join("vault"));
        let cancellation = AtomicBool::new(false);
        let media_import = service(&dir);

        for invalid in ["A".repeat(64), "a".repeat(63), "g".repeat(64)] {
            let error = media_import
                .import_source_cancellable(&store, missing_source.clone(), invalid, &cancellation)
                .expect_err("invalid source identity must fail closed");
            assert_eq!(error.code, "MEDIA_IMPORT_SOURCE_IDENTITY_INVALID");
        }

        assert_eq!(store.list().expect("list recordings")["recordingCount"], 0);
        assert!(!dir.path().join("private-media-staging").exists());
    }

    #[test]
    fn decodes_the_private_stage_when_the_original_changes_after_staging() {
        let dir = TestDir::new("post-stage-mutation");
        let source = dir.path().join("meeting.wav");
        let original_pcm = vec![0x31_u8; 32_000];
        let replacement_pcm = vec![0x42_u8; 32_000];
        let original = pcm16_wav(16_000, 1, &original_pcm);
        let replacement = pcm16_wav(16_000, 1, &replacement_pcm);
        assert_eq!(original.len(), replacement.len());
        write_file(&source, &original);
        let media_import = service(&dir);
        let expected = media_import
            .inspect_source(source.clone())
            .expect("inspect original source")
            .source_sha256;
        let store = RecordingStore::with_root(dir.path().join("vault"));
        let cancellation = AtomicBool::new(false);
        let source_to_mutate = source.clone();

        let response = media_import
            .import_trusted_with_hooks(
                &store,
                TrustedMainImportParams::import(source.clone(), expected),
                &cancellation,
                || write_file(&source_to_mutate, &replacement),
                || {},
            )
            .expect("import must remain bound to the private stage");

        let recording_id = response.recording_id.expect("recording id");
        let mut reconstructed = Vec::new();
        for index in 0..response.durable_chunk_count {
            let chunk = store
                .read_audio_chunk(AudioChunkParams {
                    recording_id: recording_id.clone(),
                    index,
                })
                .expect("read staged import chunk");
            reconstructed.extend_from_slice(
                &BASE64_STANDARD
                    .decode(chunk["dataBase64"].as_str().expect("base64 audio"))
                    .expect("decode staged import chunk"),
            );
        }
        assert_eq!(reconstructed, original_pcm);
        assert_eq!(fs::read(source).expect("read mutated source"), replacement);
        assert_private_staging_empty(&dir);
    }

    #[test]
    fn private_staging_root_is_restricted_and_retains_no_source_file() {
        let dir = TestDir::new("private-stage-permissions");
        let source = dir.path().join("meeting.wav");
        write_file(&source, &pcm16_wav(16_000, 1, &[0x55_u8; 32_000]));

        service(&dir)
            .inspect_source(source)
            .expect("inspect source through private stage");

        let staging_root = dir.path().join("private-media-staging");
        assert!(staging_root.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&staging_root)
                .expect("private stage metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700);
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use std::ptr::null_mut;

            use windows_sys::Win32::Foundation::{LocalFree, ERROR_SUCCESS};
            use windows_sys::Win32::Security::Authorization::{
                ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW,
                SDDL_REVISION_1, SE_FILE_OBJECT,
            };
            use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};

            let wide_path = staging_root
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
            let status = unsafe {
                GetNamedSecurityInfoW(
                    wide_path.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    &mut descriptor,
                )
            };
            assert_eq!(status, ERROR_SUCCESS);

            let mut sddl_ptr = null_mut();
            let mut sddl_len = 0_u32;
            let converted = unsafe {
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut sddl_ptr,
                    &mut sddl_len,
                )
            };
            assert_ne!(converted, 0);
            let sddl = unsafe {
                String::from_utf16_lossy(std::slice::from_raw_parts(sddl_ptr, sddl_len as usize))
            };
            unsafe {
                LocalFree(sddl_ptr as _);
                LocalFree(descriptor as _);
            }
            assert!(
                sddl.starts_with("D:P"),
                "unexpected private staging DACL: {sddl}"
            );
            assert!(
                sddl.contains(";;;SY"),
                "LocalSystem missing from DACL: {sddl}"
            );
            let process_user_sid = crate::local_instruct_model::current_process_user_sid_string()
                .expect("current process SID");
            assert!(
                sddl.contains(&process_user_sid),
                "current process user missing from DACL: {sddl}"
            );
            for broad_sid in [";;;WD", ";;;AU", ";;;BU", ";;;BG", ";;;AN"] {
                assert!(!sddl.contains(broad_sid), "broad staging DACL: {sddl}");
            }
        }
        assert_private_staging_empty(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn private_media_storage_rejects_unc_roots_before_directory_creation() {
        let unc_root = PathBuf::from(format!(
            r"\\127.0.0.1\candor-must-not-connect\media-stage-{}",
            std::process::id()
        ));

        let error = create_private_stage(&unc_root)
            .expect_err("UNC-backed private media staging must be rejected");

        assert_eq!(error.code, "MEDIA_IMPORT_STORAGE_NOT_LOCAL");
        assert!(!error.message.contains(&unc_root.display().to_string()));
    }

    #[cfg(windows)]
    #[test]
    fn private_media_storage_rejects_a_reparse_backed_ancestor() {
        use std::os::windows::fs::symlink_dir;

        let dir = TestDir::new("reparse-storage-root");
        let real_root = dir.path().join("real-root");
        let linked_root = dir.path().join("linked-root");
        fs::create_dir_all(&real_root).expect("create real storage root");
        if symlink_dir(&real_root, &linked_root).is_err() {
            // Windows installations without Developer Mode may deny unprivileged
            // symlink creation. The deterministic UNC test above still covers the
            // pre-I/O local-volume gate on those machines.
            return;
        }

        let error = validate_local_storage_root(&linked_root.join("recordings"))
            .expect_err("reparse-backed private media storage must be rejected");
        assert_eq!(error.code, "MEDIA_IMPORT_STORAGE_NOT_LOCAL");
    }

    #[test]
    fn persistent_finish_failure_aborts_the_new_partial_recording() {
        let dir = TestDir::new("finish-failure-cleanup");
        let source = dir.path().join("meeting.wav");
        write_file(&source, &pcm16_wav(16_000, 1, &[0x18_u8; 32_000]));
        let store = RecordingStore::with_root(dir.path().join("vault")).with_failed_finish();

        let error = service(&dir)
            .import_source(&store, source)
            .expect_err("finish failure must be reported");

        assert_eq!(error.code, "MEDIA_IMPORT_STORE_FAILED");
        let recordings_root = store.local_data_root_for_core().join("recordings");
        assert!(recordings_root.is_dir());
        assert_eq!(
            fs::read_dir(recordings_root)
                .expect("read recordings root")
                .count(),
            0
        );
        assert_private_staging_empty(&dir);
    }

    #[test]
    fn imports_the_bundled_compressed_codec_matrix_without_copying_sources() {
        let dir = TestDir::new("compressed-supported");
        let store = RecordingStore::with_root(dir.path().join("vault"));

        for (name, fixture, kind) in [
            ("meeting.mp3", TONE_MP3, MediaKind::Mp3),
            ("meeting-aac.m4a", TONE_M4A, MediaKind::M4a),
            ("meeting-alac.m4a", TONE_ALAC_M4A, MediaKind::M4a),
            ("meeting-aac.mp4", TONE_M4A, MediaKind::Mp4),
            ("meeting-alac.mp4", TONE_ALAC_M4A, MediaKind::Mp4),
            ("meeting.webm", TONE_WEBM, MediaKind::Webm),
        ] {
            let source = dir.path().join(name);
            let source_bytes = decode(fixture);
            write_file(&source, &source_bytes);
            let inspection = service(&dir)
                .inspect_source(source.clone())
                .expect("inspect supported compressed media");
            assert!(inspection.import_supported);
            assert_eq!(inspection.media_kind, kind);
            assert!(matches!(
                inspection.status,
                MediaImportStatus::Ready | MediaImportStatus::DurationProbeRequired
            ));

            let response = service(&dir)
                .import_source(&store, source.clone())
                .expect("import supported compressed media");
            assert!(response.imported);
            assert_eq!(response.media_kind, kind);
            assert_eq!(response.status, MediaImportStatus::Ready);
            assert!(response.decoder_execution_attempted);
            assert!(!response.original_audio_retained);
            assert!(response.imported_pcm_bytes > 0);
            assert!(response.duration_ms.is_some_and(|duration| duration > 0));
            assert_eq!(response.bits_per_sample, Some(16));
            assert!(response.durable_chunk_count > 0);
            assert_eq!(
                fs::read(&source).expect("read source after import"),
                source_bytes
            );

            let recording_id = response.recording_id.clone().expect("recording id");
            let replay = store
                .replay_manifest(RecordingIdParams {
                    recording_id: recording_id.clone(),
                })
                .expect("replay compressed import");
            assert_eq!(replay["state"], "finished");
            for index in 0..response.durable_chunk_count {
                let chunk = store
                    .read_audio_chunk(AudioChunkParams {
                        recording_id: recording_id.clone(),
                        index,
                    })
                    .expect("read compressed import chunk");
                let decoded = BASE64_STANDARD
                    .decode(chunk["dataBase64"].as_str().expect("base64 audio"))
                    .expect("decode imported PCM chunk");
                assert!(!decoded.is_empty());
                assert!(decoded.len() <= IMPORT_PCM_CHUNK_BYTES);
            }

            let serialized = serde_json::to_value(response).expect("serialize import response");
            assert_eq!(serialized["rawPathExposed"], false);
            assert_eq!(serialized["keyMaterialExposedToRenderer"], false);
            assert!(serialized.get("sourcePath").is_none());
            assert!(serialized.get("canonicalPath").is_none());
            assert_vault_has_no_staged_source_or_temporary_file(
                &store.local_data_root_for_core(),
                name,
            );
        }
        assert_eq!(store.list().expect("list recordings")["recordingCount"], 6);
        assert_private_staging_empty(&dir);
    }

    #[test]
    fn rejects_opus_and_video_only_media_with_exact_pathless_codes() {
        let dir = TestDir::new("compressed-rejected");
        let store = RecordingStore::with_root(dir.path().join("vault"));

        for (name, fixture, expected_code) in [
            ("opus.webm", OPUS_WEBM, "MEDIA_IMPORT_CODEC_UNSUPPORTED"),
            (
                "video-only.mp4",
                VIDEO_ONLY_MP4,
                "MEDIA_IMPORT_AUDIO_TRACK_MISSING",
            ),
        ] {
            let source = dir.path().join(name);
            write_file(&source, &decode(fixture));
            let error = service(&dir)
                .import_source(&store, source.clone())
                .expect_err("unsupported compressed media must be rejected");
            assert_eq!(error.code, expected_code);
            assert!(!error.message.contains(&source.display().to_string()));
            assert!(!error.message.contains(&dir.path().display().to_string()));
        }
        assert_eq!(store.list().expect("list recordings")["recordingCount"], 0);
        assert_private_staging_empty(&dir);
    }

    #[test]
    fn compressed_import_cancellation_creates_no_durable_recording() {
        let dir = TestDir::new("compressed-cancelled");
        let source = dir.path().join("meeting.mp3");
        write_file(&source, &decode(TONE_MP3));
        let store = RecordingStore::with_root(dir.path().join("vault"));
        let cancellation = AtomicBool::new(true);

        let expected = service(&dir)
            .inspect_source(source.clone())
            .expect("inspect compressed source before cancellation")
            .source_sha256;
        let error = service(&dir)
            .import_source_cancellable(&store, source, expected, &cancellation)
            .expect_err("cancelled import must stop");

        assert_eq!(error.code, "MEDIA_IMPORT_CANCELLED");
        assert_eq!(store.list().expect("list recordings")["recordingCount"], 0);
        assert_private_staging_empty(&dir);
    }

    #[test]
    fn cancellation_after_last_decoded_chunk_aborts_before_finish() {
        let dir = TestDir::new("compressed-cancel-before-finish");
        let source = dir.path().join("meeting.mp3");
        write_file(&source, &decode(TONE_MP3));
        let store = RecordingStore::with_root(dir.path().join("vault"));
        let cancellation = AtomicBool::new(false);

        let expected = service(&dir)
            .inspect_source(source.clone())
            .expect("inspect compressed source")
            .source_sha256;
        let error = service(&dir)
            .import_trusted_with_before_finish(
                &store,
                TrustedMainImportParams::import(source, expected),
                &cancellation,
                || cancellation.store(true, Ordering::SeqCst),
            )
            .expect_err("cancellation at the commit boundary must abort");

        assert_eq!(error.code, "MEDIA_IMPORT_CANCELLED");
        assert_eq!(store.list().expect("list recordings")["recordingCount"], 0);
        assert_private_staging_empty(&dir);
    }

    #[test]
    fn cancellation_reports_a_real_partial_recording_cleanup_failure() {
        let dir = TestDir::new("compressed-cancel-cleanup-failure");
        let source = dir.path().join("meeting.mp3");
        write_file(&source, &decode(TONE_MP3));
        let store =
            RecordingStore::with_root(dir.path().join("vault")).with_failed_abort_unfinished();
        let cancellation = AtomicBool::new(false);

        let expected = service(&dir)
            .inspect_source(source.clone())
            .expect("inspect compressed source")
            .source_sha256;
        let error = service(&dir)
            .import_trusted_with_before_finish(
                &store,
                TrustedMainImportParams::import(source, expected),
                &cancellation,
                || cancellation.store(true, Ordering::SeqCst),
            )
            .expect_err("failed rollback must not be reported as ordinary cancellation");

        assert_eq!(error.code, "MEDIA_IMPORT_CLEANUP_FAILED");
        assert!(error.message.contains("MEDIA_IMPORT_CANCELLED"));
        assert!(error.message.contains("RECORDING_ABORT_REMOVE_FAILED"));
        assert_eq!(
            store.list().expect("list partial recordings")["recordingCount"],
            1
        );
        assert_private_staging_empty(&dir);
    }

    #[test]
    fn compressed_finish_failure_aborts_the_partial_recording() {
        let dir = TestDir::new("compressed-finish-failure");
        let source = dir.path().join("meeting.mp3");
        write_file(&source, &decode(TONE_MP3));
        let store = RecordingStore::with_root(dir.path().join("vault")).with_failed_finish();

        let error = service(&dir)
            .import_source(&store, source)
            .expect_err("finish failure must be reported");

        assert_eq!(error.code, "MEDIA_IMPORT_STORE_FAILED");
        assert_eq!(store.list().expect("list recordings")["recordingCount"], 0);
        assert_private_staging_empty(&dir);
    }

    #[test]
    fn fully_parses_before_recording_and_rejects_truncated_riff() {
        let dir = TestDir::new("truncated");
        let source = dir.path().join("broken.wav");
        let mut bytes = pcm16_wav(16_000, 1, &[0_u8; 32]);
        bytes.truncate(bytes.len() - 2);
        write_file(&source, &bytes);
        let store = RecordingStore::with_root(dir.path().join("vault"));

        let error = service(&dir)
            .import_source(&store, source)
            .expect_err("truncated RIFF must fail");
        assert_eq!(error.code, "MEDIA_IMPORT_WAV_MALFORMED");
        assert_eq!(store.list().expect("list recordings")["recordingCount"], 0);
    }

    #[test]
    fn rejects_non_pcm_and_bad_frame_alignment_before_recording() {
        let dir = TestDir::new("bad-format");
        let source = dir.path().join("float.wav");
        let mut wav = pcm16_wav(16_000, 1, &[0_u8; 32]);
        wav[20..22].copy_from_slice(&3_u16.to_le_bytes());
        write_file(&source, &wav);
        let store = RecordingStore::with_root(dir.path().join("vault"));
        let error = service(&dir)
            .import_source(&store, source)
            .expect_err("float WAV must fail");
        assert_eq!(error.code, "MEDIA_IMPORT_WAV_FORMAT_UNSUPPORTED");
        assert_eq!(store.list().unwrap()["recordingCount"], 0);

        let source = dir.path().join("unaligned.wav");
        let mut body = pcm16_wav(16_000, 2, &[0_u8; 32]);
        let data_len_offset = 40;
        body[data_len_offset..data_len_offset + 4].copy_from_slice(&31_u32.to_le_bytes());
        body.truncate(44 + 31);
        let riff_size = (body.len() - 8) as u32;
        body[4..8].copy_from_slice(&riff_size.to_le_bytes());
        write_file(&source, &body);
        let error = service(&dir)
            .import_source(&store, source)
            .expect_err("partial PCM frame must fail");
        assert_eq!(error.code, "MEDIA_IMPORT_WAV_MALFORMED");
        assert_eq!(store.list().unwrap()["recordingCount"], 0);
    }

    #[test]
    fn rejects_directories_and_magic_mismatches_without_path_leakage() {
        let dir = TestDir::new("invalid-source");
        let directory_error = service(&dir)
            .inspect_source(dir.path().to_path_buf())
            .expect_err("directory must fail");
        assert_eq!(directory_error.code, "MEDIA_IMPORT_SOURCE_NOT_FILE");
        assert!(!directory_error
            .message
            .contains(&dir.path().display().to_string()));

        let source = dir.path().join("forged.mp4");
        write_file(&source, b"ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00");
        let mismatch = service(&dir)
            .inspect_source(source)
            .expect_err("forged extension must fail");
        assert_eq!(mismatch.code, "MEDIA_IMPORT_TYPE_MISMATCH");
    }

    #[test]
    fn serialized_import_result_is_pathless_and_keyless() {
        let response = MediaImportResponse {
            schema_version: 1,
            display_name: "meeting.mp4".to_owned(),
            media_kind: MediaKind::Mp4,
            status: MediaImportStatus::DecoderUnavailable,
            imported: false,
            recording_id: None,
            source_size_bytes: 100,
            imported_pcm_bytes: 0,
            duration_ms: None,
            sample_rate_hz: None,
            channel_count: None,
            bits_per_sample: None,
            durable_chunk_count: 0,
            original_audio_retained: false,
            container_metadata_preserved: false,
            source_modified: false,
            decoder_execution_attempted: false,
            local_only: true,
            network_attempted: false,
            raw_path_exposed: false,
            key_material_exposed_to_renderer: false,
        };
        let value = serde_json::to_value(response).expect("serialize import response");
        assert_eq!(value["rawPathExposed"], Value::Bool(false));
        assert_eq!(value["keyMaterialExposedToRenderer"], Value::Bool(false));
        assert!(value.get("sourcePath").is_none());
        assert!(value.get("key").is_none());
    }
}

#[cfg(all(test, not(windows)))]
mod non_windows_tests {
    use super::*;

    #[test]
    fn production_media_locality_support_is_explicitly_disabled() {
        assert!(!production_local_media_storage_supported());
        let error = ensure_path_uses_local_storage(Path::new("/candor-outside-test-temp.wav"))
            .expect_err("non-Windows source locality must remain test-temp scoped");
        assert_eq!(error.code, "MEDIA_IMPORT_SOURCE_NOT_LOCAL");
    }

    #[test]
    fn private_media_test_allowance_does_not_extend_beyond_the_temp_root() {
        let error = validate_local_storage_root(Path::new("/candor-private-media"))
            .expect_err("non-Windows private storage must remain test-temp scoped");
        assert_eq!(error.code, "MEDIA_IMPORT_STORAGE_NOT_LOCAL");
    }
}
