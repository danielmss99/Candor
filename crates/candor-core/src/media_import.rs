use serde::Serialize;

pub const MEDIA_IMPORT_SCHEMA_VERSION: u32 = 1;
pub const MAX_IMPORT_NAME_BYTES: usize = 255;
pub const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_IMPORT_DURATION_MS: u64 = 12 * 60 * 60 * 1_000;
pub const MAX_MAGIC_PROBE_BYTES: usize = 4 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaImportError {
    pub code: &'static str,
    pub message: String,
}

impl MediaImportError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Wav,
    Mp3,
    M4a,
    Mp4,
    Webm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalDecoderCapability {
    /// The bundled/local decoder has passed the application's integrity check.
    Verified,
    /// No local decoder for the media kind is installed in this build.
    Unavailable,
    /// Decoder bytes exist, but integrity verification has not succeeded.
    Unverified,
}

pub fn local_decoder_capability(
    decoder_present: bool,
    integrity_verified: bool,
) -> LocalDecoderCapability {
    match (decoder_present, integrity_verified) {
        (false, _) => LocalDecoderCapability::Unavailable,
        (true, false) => LocalDecoderCapability::Unverified,
        (true, true) => LocalDecoderCapability::Verified,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaImportStatus {
    Ready,
    DurationProbeRequired,
    DecoderUnavailable,
    DecoderUnverified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaStagingAction {
    CopyToPrivateStaging,
    ProbeDurationWithVerifiedLocalDecoder,
    DecodeWithVerifiedLocalDecoder,
    EncryptIntoVault,
}

#[derive(Clone, Debug)]
pub struct MediaImportCandidate<'a> {
    /// A basename supplied separately from the source path.
    pub display_name: &'a str,
    pub declared_size_bytes: u64,
    /// A bounded prefix of the source bytes used only for container sniffing.
    pub magic_probe: &'a [u8],
    /// Duration read from trusted metadata, when already available.
    pub duration_ms: Option<u64>,
    pub decoder: LocalDecoderCapability,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaImportPlan {
    pub schema_version: u32,
    pub display_name: String,
    pub media_kind: MediaKind,
    pub declared_size_bytes: u64,
    pub duration_ms: Option<u64>,
    pub status: MediaImportStatus,
    pub actions: Vec<MediaStagingAction>,
    pub staging_allowed: bool,
    pub requires_private_staging: bool,
    pub source_path_retained: bool,
    pub arbitrary_codec_execution_allowed: bool,
    pub local_only: bool,
    pub network_attempted: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

pub fn validate_media_import(
    candidate: MediaImportCandidate<'_>,
) -> Result<MediaImportPlan, MediaImportError> {
    let media_kind = kind_from_safe_name(candidate.display_name)?;
    validate_size(candidate.declared_size_bytes)?;
    validate_duration(candidate.duration_ms)?;
    validate_magic_probe(media_kind, candidate.magic_probe)?;

    let status = match candidate.decoder {
        LocalDecoderCapability::Unavailable => MediaImportStatus::DecoderUnavailable,
        LocalDecoderCapability::Unverified => MediaImportStatus::DecoderUnverified,
        LocalDecoderCapability::Verified if candidate.duration_ms.is_none() => {
            MediaImportStatus::DurationProbeRequired
        }
        LocalDecoderCapability::Verified => MediaImportStatus::Ready,
    };

    let actions = match status {
        MediaImportStatus::Ready => vec![
            MediaStagingAction::CopyToPrivateStaging,
            MediaStagingAction::DecodeWithVerifiedLocalDecoder,
            MediaStagingAction::EncryptIntoVault,
        ],
        MediaImportStatus::DurationProbeRequired => vec![
            MediaStagingAction::CopyToPrivateStaging,
            MediaStagingAction::ProbeDurationWithVerifiedLocalDecoder,
        ],
        MediaImportStatus::DecoderUnavailable | MediaImportStatus::DecoderUnverified => Vec::new(),
    };

    Ok(MediaImportPlan {
        schema_version: MEDIA_IMPORT_SCHEMA_VERSION,
        display_name: candidate.display_name.to_string(),
        media_kind,
        declared_size_bytes: candidate.declared_size_bytes,
        duration_ms: candidate.duration_ms,
        status,
        staging_allowed: matches!(
            status,
            MediaImportStatus::Ready | MediaImportStatus::DurationProbeRequired
        ),
        actions,
        requires_private_staging: true,
        source_path_retained: false,
        arbitrary_codec_execution_allowed: false,
        local_only: true,
        network_attempted: false,
        raw_path_exposed: false,
        key_material_exposed_to_renderer: false,
    })
}

fn kind_from_safe_name(display_name: &str) -> Result<MediaKind, MediaImportError> {
    if display_name.is_empty() || display_name.len() > MAX_IMPORT_NAME_BYTES {
        return Err(MediaImportError::new(
            "MEDIA_IMPORT_NAME_INVALID",
            "media name is empty or exceeds its limit",
        ));
    }
    if display_name.trim() != display_name
        || display_name == "."
        || display_name == ".."
        || display_name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
    {
        return Err(MediaImportError::new(
            "MEDIA_IMPORT_NAME_INVALID",
            "media name must be a safe basename without path components",
        ));
    }

    let (stem, extension) = display_name.rsplit_once('.').ok_or_else(|| {
        MediaImportError::new(
            "MEDIA_IMPORT_EXTENSION_UNSUPPORTED",
            "media name must include a supported extension",
        )
    })?;
    if stem.is_empty() {
        return Err(MediaImportError::new(
            "MEDIA_IMPORT_NAME_INVALID",
            "media name must include a basename before the extension",
        ));
    }
    match extension.to_ascii_lowercase().as_str() {
        "wav" => Ok(MediaKind::Wav),
        "mp3" => Ok(MediaKind::Mp3),
        "m4a" => Ok(MediaKind::M4a),
        "mp4" => Ok(MediaKind::Mp4),
        "webm" => Ok(MediaKind::Webm),
        _ => Err(MediaImportError::new(
            "MEDIA_IMPORT_EXTENSION_UNSUPPORTED",
            "supported media extensions are WAV, MP3, M4A, MP4, and WebM",
        )),
    }
}

fn validate_size(size_bytes: u64) -> Result<(), MediaImportError> {
    if size_bytes == 0 {
        return Err(MediaImportError::new(
            "MEDIA_IMPORT_EMPTY",
            "media input must not be empty",
        ));
    }
    if size_bytes > MAX_IMPORT_BYTES {
        return Err(MediaImportError::new(
            "MEDIA_IMPORT_TOO_LARGE",
            "media input exceeds the import size limit",
        ));
    }
    Ok(())
}

fn validate_duration(duration_ms: Option<u64>) -> Result<(), MediaImportError> {
    let Some(duration_ms) = duration_ms else {
        return Ok(());
    };
    if duration_ms == 0 {
        return Err(MediaImportError::new(
            "MEDIA_IMPORT_DURATION_INVALID",
            "media duration must be greater than zero",
        ));
    }
    if duration_ms > MAX_IMPORT_DURATION_MS {
        return Err(MediaImportError::new(
            "MEDIA_IMPORT_DURATION_LIMIT",
            "media duration exceeds the import limit",
        ));
    }
    Ok(())
}

fn validate_magic_probe(kind: MediaKind, probe: &[u8]) -> Result<(), MediaImportError> {
    if probe.is_empty() || probe.len() > MAX_MAGIC_PROBE_BYTES {
        return Err(MediaImportError::new(
            "MEDIA_IMPORT_MAGIC_PROBE_INVALID",
            "media signature probe is empty or exceeds its limit",
        ));
    }
    let matches = match kind {
        MediaKind::Wav => is_wav(probe),
        MediaKind::Mp3 => is_mp3(probe),
        MediaKind::M4a | MediaKind::Mp4 => is_iso_base_media(probe),
        MediaKind::Webm => is_webm(probe),
    };
    if !matches {
        return Err(MediaImportError::new(
            "MEDIA_IMPORT_TYPE_MISMATCH",
            "media extension does not match the verified container signature",
        ));
    }
    Ok(())
}

fn is_wav(probe: &[u8]) -> bool {
    probe.len() >= 12 && &probe[0..4] == b"RIFF" && &probe[8..12] == b"WAVE"
}

fn is_mp3(probe: &[u8]) -> bool {
    if probe.len() >= 3 && &probe[0..3] == b"ID3" {
        return true;
    }
    if probe.len() < 4 || probe[0] != 0xff || probe[1] & 0xe0 != 0xe0 {
        return false;
    }
    let version_bits = (probe[1] >> 3) & 0x03;
    let layer_bits = (probe[1] >> 1) & 0x03;
    let bitrate_bits = (probe[2] >> 4) & 0x0f;
    let sample_rate_bits = (probe[2] >> 2) & 0x03;
    version_bits != 0x01 && layer_bits != 0 && bitrate_bits != 0x0f && sample_rate_bits != 0x03
}

fn is_iso_base_media(probe: &[u8]) -> bool {
    probe.len() >= 12 && &probe[4..8] == b"ftyp" && probe[0..4] != [0, 0, 0, 0]
}

fn is_webm(probe: &[u8]) -> bool {
    probe.len() >= 8
        && probe.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
        && probe
            .windows(4)
            .any(|window| window.eq_ignore_ascii_case(b"webm"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WAV: &[u8] = b"RIFF\x24\x00\x00\x00WAVEfmt ";
    const MP3: &[u8] = b"ID3\x04\x00\x00";
    const MP4: &[u8] = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00";
    const WEBM: &[u8] = b"\x1a\x45\xdf\xa3\x42\x82webm";

    fn candidate<'a>(name: &'a str, magic_probe: &'a [u8]) -> MediaImportCandidate<'a> {
        MediaImportCandidate {
            display_name: name,
            declared_size_bytes: 4_096,
            magic_probe,
            duration_ms: Some(10_000),
            decoder: LocalDecoderCapability::Verified,
        }
    }

    #[test]
    fn accepts_each_supported_extension_with_matching_magic() {
        for (name, magic, kind) in [
            ("meeting.wav", WAV, MediaKind::Wav),
            ("meeting.mp3", MP3, MediaKind::Mp3),
            ("meeting.m4a", MP4, MediaKind::M4a),
            ("meeting.mp4", MP4, MediaKind::Mp4),
            ("meeting.webm", WEBM, MediaKind::Webm),
        ] {
            let plan = validate_media_import(candidate(name, magic)).unwrap();
            assert_eq!(plan.media_kind, kind);
            assert_eq!(plan.status, MediaImportStatus::Ready);
            assert!(plan.staging_allowed);
            assert!(!plan.source_path_retained);
            assert!(!plan.arbitrary_codec_execution_allowed);
        }
    }

    #[test]
    fn rejects_forged_extensions_and_magic() {
        let error = validate_media_import(candidate("meeting.wav", MP3)).unwrap_err();
        assert_eq!(error.code, "MEDIA_IMPORT_TYPE_MISMATCH");

        let error = validate_media_import(candidate("meeting.mp3", WAV)).unwrap_err();
        assert_eq!(error.code, "MEDIA_IMPORT_TYPE_MISMATCH");

        let matroska_without_webm_doctype = b"\x1a\x45\xdf\xa3matroska";
        let error = validate_media_import(candidate("meeting.webm", matroska_without_webm_doctype))
            .unwrap_err();
        assert_eq!(error.code, "MEDIA_IMPORT_TYPE_MISMATCH");
    }

    #[test]
    fn rejects_traversal_names_and_unsupported_extensions() {
        for name in [
            "../meeting.wav",
            "..\\meeting.wav",
            "C:\\meeting.wav",
            "/meeting.wav",
            " meeting.wav",
            "meeting.wav ",
        ] {
            assert_eq!(
                validate_media_import(candidate(name, WAV))
                    .unwrap_err()
                    .code,
                "MEDIA_IMPORT_NAME_INVALID"
            );
        }
        assert_eq!(
            validate_media_import(candidate("meeting.exe", WAV))
                .unwrap_err()
                .code,
            "MEDIA_IMPORT_EXTENSION_UNSUPPORTED"
        );
    }

    #[test]
    fn rejects_oversized_empty_and_overlong_media() {
        let mut oversized = candidate("meeting.wav", WAV);
        oversized.declared_size_bytes = MAX_IMPORT_BYTES + 1;
        assert_eq!(
            validate_media_import(oversized).unwrap_err().code,
            "MEDIA_IMPORT_TOO_LARGE"
        );

        let mut empty = candidate("meeting.wav", WAV);
        empty.declared_size_bytes = 0;
        assert_eq!(
            validate_media_import(empty).unwrap_err().code,
            "MEDIA_IMPORT_EMPTY"
        );

        let mut overlong = candidate("meeting.wav", WAV);
        overlong.duration_ms = Some(MAX_IMPORT_DURATION_MS + 1);
        assert_eq!(
            validate_media_import(overlong).unwrap_err().code,
            "MEDIA_IMPORT_DURATION_LIMIT"
        );

        let oversized_probe = vec![0_u8; MAX_MAGIC_PROBE_BYTES + 1];
        assert_eq!(
            validate_media_import(candidate("meeting.wav", &oversized_probe))
                .unwrap_err()
                .code,
            "MEDIA_IMPORT_MAGIC_PROBE_INVALID"
        );
    }

    #[test]
    fn decoder_and_duration_states_are_explicit_and_non_executing() {
        let mut unavailable = candidate("meeting.wav", WAV);
        unavailable.decoder = LocalDecoderCapability::Unavailable;
        let plan = validate_media_import(unavailable).unwrap();
        assert_eq!(plan.status, MediaImportStatus::DecoderUnavailable);
        assert!(!plan.staging_allowed);
        assert!(plan.actions.is_empty());

        let mut unverified = candidate("meeting.wav", WAV);
        unverified.decoder = LocalDecoderCapability::Unverified;
        let plan = validate_media_import(unverified).unwrap();
        assert_eq!(plan.status, MediaImportStatus::DecoderUnverified);
        assert!(!plan.staging_allowed);

        let mut unknown_duration = candidate("meeting.wav", WAV);
        unknown_duration.duration_ms = None;
        let plan = validate_media_import(unknown_duration).unwrap();
        assert_eq!(plan.status, MediaImportStatus::DurationProbeRequired);
        assert_eq!(
            plan.actions,
            vec![
                MediaStagingAction::CopyToPrivateStaging,
                MediaStagingAction::ProbeDurationWithVerifiedLocalDecoder
            ]
        );
        assert!(!plan
            .actions
            .contains(&MediaStagingAction::DecodeWithVerifiedLocalDecoder));
    }

    #[test]
    fn output_is_pathless_keyless_and_local() {
        let plan = validate_media_import(candidate("meeting.wav", WAV)).unwrap();
        let value = serde_json::to_value(plan).unwrap();
        assert_eq!(value["rawPathExposed"], false);
        assert_eq!(value["keyMaterialExposedToRenderer"], false);
        assert_eq!(value["networkAttempted"], false);
        assert_eq!(value["sourcePathRetained"], false);
        assert_eq!(value["arbitraryCodecExecutionAllowed"], false);
        assert!(value.get("sourcePath").is_none());
        assert!(value.get("stagingPath").is_none());
        assert!(value.get("key").is_none());
    }
}
