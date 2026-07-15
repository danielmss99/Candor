use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

const EXPECTED_FILES: [&str; 4] = [
    "manifest.json",
    "terms.jsonl",
    "LICENSE.txt",
    "signature.json",
];
const MAX_ARCHIVE_BYTES: usize = 2_500_000;
const MAX_EXPANDED_BYTES: u64 = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_TERMS_BYTES: u64 = 6 * 1024 * 1024;
const MAX_LICENSE_BYTES: u64 = 512 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 64 * 1024;
const MAX_COMPRESSION_RATIO: u64 = 100;
const MAX_TERM_LINE_BYTES: usize = 16 * 1024;

#[derive(Debug)]
pub struct DictionaryPackageError {
    pub code: &'static str,
    pub message: String,
}

impl DictionaryPackageError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DictionaryPackageTerm {
    #[serde(alias = "term")]
    pub canonical_term: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub pronunciation_hints: Vec<String>,
    #[serde(default)]
    pub definition: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DictionaryManifest {
    schema_version: u32,
    id: String,
    name: String,
    version: String,
    publisher: String,
    language: String,
    term_count: usize,
    minimum_candor_version: String,
    content_sha256: String,
    signature_algorithm: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DictionarySignature {
    schema_version: u32,
    key_id: String,
    public_key_base64: String,
    signature_base64: String,
    signed_sha256: String,
}

#[derive(Clone, Debug)]
pub struct VerifiedDictionaryPackage {
    pub package_id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub language: String,
    pub minimum_candor_version: String,
    pub key_id: String,
    pub trust_label: String,
    pub entries: Vec<DictionaryPackageTerm>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DictionaryTrustAnchor {
    pub key_id: String,
    pub public_key: [u8; 32],
    pub rotation_generation: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DictionaryTrustAnchorDocument {
    schema_version: u32,
    key_id: String,
    public_key_base64: String,
    rotation_generation: u32,
}

impl DictionaryTrustAnchor {
    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, DictionaryPackageError> {
        if bytes.is_empty() || bytes.len() > MAX_SIGNATURE_BYTES as usize {
            return Err(DictionaryPackageError::new(
                "DICTIONARY_TRUST_ANCHOR_INVALID",
                "the bundled dictionary publisher key is invalid",
            ));
        }
        let document: DictionaryTrustAnchorDocument =
            parse_json(bytes, "DICTIONARY_TRUST_ANCHOR_INVALID")?;
        if document.schema_version != 2
            || !safe_identifier(&document.key_id, 128)
            || document.rotation_generation == 0
        {
            return Err(DictionaryPackageError::new(
                "DICTIONARY_TRUST_ANCHOR_INVALID",
                "the bundled dictionary publisher key is invalid",
            ));
        }
        let public_key = STANDARD.decode(&document.public_key_base64).map_err(|_| {
            DictionaryPackageError::new(
                "DICTIONARY_TRUST_ANCHOR_INVALID",
                "the bundled dictionary publisher key is invalid",
            )
        })?;
        let public_key: [u8; 32] = public_key.try_into().map_err(|_| {
            DictionaryPackageError::new(
                "DICTIONARY_TRUST_ANCHOR_INVALID",
                "the bundled dictionary publisher key is invalid",
            )
        })?;
        VerifyingKey::from_bytes(&public_key).map_err(|_| {
            DictionaryPackageError::new(
                "DICTIONARY_TRUST_ANCHOR_INVALID",
                "the bundled dictionary publisher key is invalid",
            )
        })?;
        Ok(Self {
            key_id: document.key_id,
            public_key,
            rotation_generation: document.rotation_generation,
        })
    }
}

#[cfg(test)]
pub fn verify_candordict_base64(
    archive_base64: &str,
) -> Result<VerifiedDictionaryPackage, DictionaryPackageError> {
    if archive_base64.len() > MAX_ARCHIVE_BYTES.saturating_mul(4).saturating_add(16) / 3 {
        return Err(DictionaryPackageError::new(
            "DICTIONARY_ARCHIVE_TOO_LARGE",
            "the dictionary package exceeds the compressed size limit",
        ));
    }
    let bytes = STANDARD.decode(archive_base64).map_err(|_| {
        DictionaryPackageError::new(
            "DICTIONARY_ARCHIVE_INVALID",
            "the dictionary package is not valid encoded data",
        )
    })?;
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(DictionaryPackageError::new(
            "DICTIONARY_ARCHIVE_TOO_LARGE",
            "the dictionary package exceeds the compressed size limit",
        ));
    }

    verify_candordict_bytes_with_trust(&bytes, None)
}

pub fn verify_candordict_bytes_with_trust(
    bytes: &[u8],
    trust_anchor: Option<&DictionaryTrustAnchor>,
) -> Result<VerifiedDictionaryPackage, DictionaryPackageError> {
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(DictionaryPackageError::new(
            "DICTIONARY_ARCHIVE_TOO_LARGE",
            "the dictionary package exceeds the compressed size limit",
        ));
    }

    let files = read_archive(bytes)?;
    let manifest_bytes = required_file(&files, "manifest.json")?;
    let terms_bytes = required_file(&files, "terms.jsonl")?;
    let license_bytes = required_file(&files, "LICENSE.txt")?;
    let signature_bytes = required_file(&files, "signature.json")?;

    let manifest: DictionaryManifest = parse_json(manifest_bytes, "DICTIONARY_MANIFEST_INVALID")?;
    validate_manifest(&manifest)?;
    if license_bytes.is_empty() || std::str::from_utf8(license_bytes).is_err() {
        return Err(DictionaryPackageError::new(
            "DICTIONARY_LICENSE_INVALID",
            "the dictionary package must contain a UTF-8 license",
        ));
    }
    let terms_hash = hex_sha256(terms_bytes);
    if !terms_hash.eq_ignore_ascii_case(&manifest.content_sha256) {
        return Err(DictionaryPackageError::new(
            "DICTIONARY_CONTENT_HASH_MISMATCH",
            "the dictionary content did not pass its integrity check",
        ));
    }

    let signature: DictionarySignature =
        parse_json(signature_bytes, "DICTIONARY_SIGNATURE_INVALID")?;
    let signing_public_key =
        verify_signature(&signature, manifest_bytes, terms_bytes, license_bytes)?;
    let entries = parse_terms(terms_bytes)?;
    if entries.len() != manifest.term_count {
        return Err(DictionaryPackageError::new(
            "DICTIONARY_TERM_COUNT_MISMATCH",
            "the dictionary term count does not match its manifest",
        ));
    }

    let candor_trusted = trust_anchor.is_some_and(|anchor| {
        anchor.key_id == signature.key_id && anchor.public_key == signing_public_key
    });
    Ok(VerifiedDictionaryPackage {
        package_id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        publisher: manifest.publisher,
        language: manifest.language,
        minimum_candor_version: manifest.minimum_candor_version,
        key_id: signature.key_id,
        trust_label: if candor_trusted {
            "verified-candor".to_string()
        } else {
            "community-unverified".to_string()
        },
        entries,
    })
}

fn read_archive(bytes: &[u8]) -> Result<HashMap<String, Vec<u8>>, DictionaryPackageError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|_| {
        DictionaryPackageError::new(
            "DICTIONARY_ARCHIVE_INVALID",
            "the dictionary package is not a valid archive",
        )
    })?;
    if archive.len() != EXPECTED_FILES.len() {
        return Err(DictionaryPackageError::new(
            "DICTIONARY_ARCHIVE_CONTENT_INVALID",
            "the dictionary package must contain exactly four approved data files",
        ));
    }
    let expected = EXPECTED_FILES.into_iter().collect::<HashSet<_>>();
    let mut output = HashMap::new();
    let mut total_expanded = 0_u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|_| {
            DictionaryPackageError::new(
                "DICTIONARY_ARCHIVE_INVALID",
                "the dictionary package could not be inspected",
            )
        })?;
        let name = file.name().to_string();
        if !expected.contains(name.as_str())
            || name.contains('/')
            || name.contains('\\')
            || file.is_dir()
            || file.enclosed_name().is_none()
        {
            return Err(DictionaryPackageError::new(
                "DICTIONARY_ARCHIVE_CONTENT_INVALID",
                "the dictionary package contains an unapproved path or file",
            ));
        }
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(DictionaryPackageError::new(
                "DICTIONARY_ARCHIVE_LINK_REJECTED",
                "symbolic links are not allowed in dictionary packages",
            ));
        }
        let per_file_limit = match name.as_str() {
            "manifest.json" => MAX_MANIFEST_BYTES,
            "terms.jsonl" => MAX_TERMS_BYTES,
            "LICENSE.txt" => MAX_LICENSE_BYTES,
            "signature.json" => MAX_SIGNATURE_BYTES,
            _ => 0,
        };
        if file.size() > per_file_limit {
            return Err(DictionaryPackageError::new(
                "DICTIONARY_ARCHIVE_FILE_TOO_LARGE",
                "a dictionary package file exceeds its expanded size limit",
            ));
        }
        let compressed_size = file.compressed_size();
        let contents = read_bounded(&mut file, per_file_limit)?;
        let expanded_size = contents.len() as u64;
        if expanded_size > 64 * 1024
            && (compressed_size == 0
                || expanded_size / compressed_size.max(1) > MAX_COMPRESSION_RATIO)
        {
            return Err(DictionaryPackageError::new(
                "DICTIONARY_ARCHIVE_RATIO_REJECTED",
                "the dictionary package has an unsafe compression ratio",
            ));
        }
        total_expanded = total_expanded.saturating_add(expanded_size);
        if total_expanded > MAX_EXPANDED_BYTES {
            return Err(DictionaryPackageError::new(
                "DICTIONARY_ARCHIVE_EXPANDED_TOO_LARGE",
                "the expanded dictionary package exceeds the local size limit",
            ));
        }
        if output.insert(name, contents).is_some() {
            return Err(DictionaryPackageError::new(
                "DICTIONARY_ARCHIVE_DUPLICATE_FILE",
                "the dictionary package contains a duplicate file",
            ));
        }
    }
    Ok(output)
}

fn read_bounded(reader: &mut impl Read, limit: u64) -> Result<Vec<u8>, DictionaryPackageError> {
    let mut contents = Vec::with_capacity(limit.min(64 * 1024) as usize);
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut contents)
        .map_err(|_| {
            DictionaryPackageError::new(
                "DICTIONARY_ARCHIVE_READ_FAILED",
                "the dictionary package could not be read",
            )
        })?;
    if contents.len() as u64 > limit {
        return Err(DictionaryPackageError::new(
            "DICTIONARY_ARCHIVE_FILE_TOO_LARGE",
            "a dictionary package file exceeds its expanded size limit",
        ));
    }
    Ok(contents)
}

fn required_file<'a>(
    files: &'a HashMap<String, Vec<u8>>,
    name: &str,
) -> Result<&'a [u8], DictionaryPackageError> {
    files.get(name).map(Vec::as_slice).ok_or_else(|| {
        DictionaryPackageError::new(
            "DICTIONARY_ARCHIVE_CONTENT_INVALID",
            "the dictionary package is missing a required data file",
        )
    })
}

fn parse_json<T: for<'de> Deserialize<'de>>(
    bytes: &[u8],
    code: &'static str,
) -> Result<T, DictionaryPackageError> {
    serde_json::from_slice(bytes)
        .map_err(|_| DictionaryPackageError::new(code, "dictionary package metadata is invalid"))
}

fn validate_manifest(manifest: &DictionaryManifest) -> Result<(), DictionaryPackageError> {
    if manifest.schema_version != 1
        || manifest.signature_algorithm != "ed25519"
        || !safe_identifier(&manifest.id, 128)
        || !safe_identifier(&manifest.version, 32)
        || !safe_identifier(&manifest.minimum_candor_version, 32)
        || manifest.name.trim().is_empty()
        || manifest.name.chars().count() > 80
        || manifest.publisher.trim().is_empty()
        || manifest.publisher.chars().count() > 120
        || manifest.language.trim().is_empty()
        || manifest.language.chars().count() > 32
        || manifest.term_count == 0
        || manifest.term_count > 20_000
        || !is_sha256(&manifest.content_sha256)
    {
        return Err(DictionaryPackageError::new(
            "DICTIONARY_MANIFEST_INVALID",
            "the dictionary package manifest is not supported",
        ));
    }
    Version::parse(&manifest.version).map_err(|_| {
        DictionaryPackageError::new(
            "DICTIONARY_MANIFEST_INVALID",
            "the dictionary package version is invalid",
        )
    })?;
    let minimum = Version::parse(&manifest.minimum_candor_version).map_err(|_| {
        DictionaryPackageError::new(
            "DICTIONARY_MANIFEST_INVALID",
            "the dictionary package minimum Candor version is invalid",
        )
    })?;
    let current = Version::parse(env!("CARGO_PKG_VERSION")).expect("crate version must be SemVer");
    if minimum > current {
        return Err(DictionaryPackageError::new(
            "DICTIONARY_VERSION_UNSUPPORTED",
            "the dictionary package requires a newer version of Candor",
        ));
    }
    Ok(())
}

fn verify_signature(
    signature: &DictionarySignature,
    manifest: &[u8],
    terms: &[u8],
    license: &[u8],
) -> Result<[u8; 32], DictionaryPackageError> {
    if signature.schema_version != 1 || !safe_identifier(&signature.key_id, 128) {
        return Err(DictionaryPackageError::new(
            "DICTIONARY_SIGNATURE_INVALID",
            "the dictionary signature metadata is invalid",
        ));
    }
    let digest = signed_digest(manifest, terms, license);
    if !hex_bytes(&digest).eq_ignore_ascii_case(&signature.signed_sha256) {
        return Err(DictionaryPackageError::new(
            "DICTIONARY_SIGNATURE_DIGEST_MISMATCH",
            "the dictionary signature does not match the package contents",
        ));
    }
    let public_key = STANDARD.decode(&signature.public_key_base64).map_err(|_| {
        DictionaryPackageError::new(
            "DICTIONARY_SIGNATURE_INVALID",
            "the dictionary public key is invalid",
        )
    })?;
    let signature_bytes = STANDARD.decode(&signature.signature_base64).map_err(|_| {
        DictionaryPackageError::new(
            "DICTIONARY_SIGNATURE_INVALID",
            "the dictionary signature is invalid",
        )
    })?;
    let public_key: [u8; 32] = public_key.try_into().map_err(|_| {
        DictionaryPackageError::new(
            "DICTIONARY_SIGNATURE_INVALID",
            "the dictionary public key has an invalid size",
        )
    })?;
    let signature_bytes: [u8; 64] = signature_bytes.try_into().map_err(|_| {
        DictionaryPackageError::new(
            "DICTIONARY_SIGNATURE_INVALID",
            "the dictionary signature has an invalid size",
        )
    })?;
    let verifying_key = VerifyingKey::from_bytes(&public_key).map_err(|_| {
        DictionaryPackageError::new(
            "DICTIONARY_SIGNATURE_INVALID",
            "the dictionary public key is not valid Ed25519 data",
        )
    })?;
    verifying_key
        .verify(&digest, &Signature::from_bytes(&signature_bytes))
        .map_err(|_| {
            DictionaryPackageError::new(
                "DICTIONARY_SIGNATURE_REJECTED",
                "the dictionary package signature could not be verified",
            )
        })?;
    Ok(public_key)
}

fn parse_terms(bytes: &[u8]) -> Result<Vec<DictionaryPackageTerm>, DictionaryPackageError> {
    let content = std::str::from_utf8(bytes).map_err(|_| {
        DictionaryPackageError::new(
            "DICTIONARY_TERMS_INVALID",
            "dictionary terms must use UTF-8 text",
        )
    })?;
    let mut entries = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if line.len() > MAX_TERM_LINE_BYTES || line.contains('\0') {
            return Err(DictionaryPackageError::new(
                "DICTIONARY_TERM_LINE_INVALID",
                "a dictionary term entry exceeds the safe line limit",
            ));
        }
        let entry = serde_json::from_str::<DictionaryPackageTerm>(line).map_err(|_| {
            DictionaryPackageError::new(
                "DICTIONARY_TERM_SCHEMA_INVALID",
                "a dictionary term entry does not match the data-only schema",
            )
        })?;
        entries.push(entry);
        if entries.len() > 20_000 {
            return Err(DictionaryPackageError::new(
                "DICTIONARY_TERM_LIMIT",
                "the dictionary package contains too many terms",
            ));
        }
    }
    Ok(entries)
}

fn signed_digest(manifest: &[u8], terms: &[u8], license: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"CANDOR-DICTIONARY-SIGNATURE-V1\0");
    for bytes in [manifest, terms, license] {
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    }
    hasher.finalize().into()
}

fn hex_sha256(bytes: &[u8]) -> String {
    hex_bytes(&Sha256::digest(bytes))
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn safe_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;
    use zip::write::FileOptions;
    use zip::CompressionMethod;

    use super::*;

    fn package_with(
        terms: &[u8],
        extra_name: Option<&str>,
        compression: CompressionMethod,
        minimum_candor_version: &str,
    ) -> String {
        let manifest = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "id": "com.candor.dictionary.test",
            "name": "Test dictionary",
            "version": "1.0.0",
            "publisher": "Candor test",
            "language": "en",
            "termCount": terms.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()).count(),
            "minimumCandorVersion": minimum_candor_version,
            "contentSha256": hex_sha256(terms),
            "signatureAlgorithm": "ed25519"
        }))
        .expect("manifest");
        let license = b"MIT test license";
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let digest = signed_digest(&manifest, terms, license);
        let signature = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "keyId": "test-key-1",
            "publicKeyBase64": STANDARD.encode(key.verifying_key().as_bytes()),
            "signatureBase64": STANDARD.encode(key.sign(&digest).to_bytes()),
            "signedSha256": hex_bytes(&digest)
        }))
        .expect("signature");

        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = FileOptions::default().compression_method(compression);
        for (name, bytes) in [
            (extra_name.unwrap_or("manifest.json"), manifest.as_slice()),
            ("terms.jsonl", terms),
            ("LICENSE.txt", license.as_slice()),
            ("signature.json", signature.as_slice()),
        ] {
            writer.start_file(name, options).expect("start file");
            writer.write_all(bytes).expect("write file");
        }
        STANDARD.encode(writer.finish().expect("finish zip").into_inner())
    }

    #[test]
    fn verifies_signed_data_only_package() {
        let terms = br#"{"canonicalTerm":"adalimumab","aliases":["Humira"],"definition":"A medicine","category":"drug"}
"#;
        let verified = verify_candordict_base64(&package_with(
            terms,
            None,
            CompressionMethod::Stored,
            "0.4.0",
        ))
        .expect("package verifies");
        assert_eq!(verified.entries.len(), 1);
        assert_eq!(verified.entries[0].canonical_term, "adalimumab");
        assert_eq!(verified.trust_label, "community-unverified");
    }

    #[test]
    fn grants_candor_trust_only_for_the_exact_bundled_key() {
        let terms = br#"{"canonicalTerm":"adalimumab"}
"#;
        let encoded = package_with(terms, None, CompressionMethod::Stored, "0.4.0");
        let bytes = STANDARD.decode(encoded).expect("decode package");
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let anchor = DictionaryTrustAnchor {
            key_id: "test-key-1".to_string(),
            public_key: *signing_key.verifying_key().as_bytes(),
            rotation_generation: 1,
        };
        let verified = verify_candordict_bytes_with_trust(&bytes, Some(&anchor))
            .expect("trusted package verifies");
        assert_eq!(verified.trust_label, "verified-candor");

        let unknown_anchor = DictionaryTrustAnchor {
            key_id: anchor.key_id.clone(),
            public_key: *SigningKey::from_bytes(&[8_u8; 32])
                .verifying_key()
                .as_bytes(),
            rotation_generation: 1,
        };
        let community = verify_candordict_bytes_with_trust(&bytes, Some(&unknown_anchor))
            .expect("community package still verifies cryptographically");
        assert_eq!(community.trust_label, "community-unverified");
    }

    #[test]
    fn parses_a_data_only_publisher_key_document() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let bytes = serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "keyId": "candor-dictionaries-2026",
            "publicKeyBase64": STANDARD.encode(signing_key.verifying_key().as_bytes()),
            "rotationGeneration": 1
        }))
        .expect("publisher key document");
        let anchor = DictionaryTrustAnchor::from_json_bytes(&bytes).expect("valid anchor");
        assert_eq!(anchor.key_id, "candor-dictionaries-2026");
        assert_eq!(anchor.public_key, *signing_key.verifying_key().as_bytes());
        assert_eq!(anchor.rotation_generation, 1);
    }

    #[test]
    fn rejects_path_traversal() {
        let terms = br#"{"canonicalTerm":"adalimumab"}
"#;
        let error = verify_candordict_base64(&package_with(
            terms,
            Some("../manifest.json"),
            CompressionMethod::Stored,
            "0.4.0",
        ))
        .expect_err("traversal must fail");
        assert_eq!(error.code, "DICTIONARY_ARCHIVE_CONTENT_INVALID");
    }

    #[test]
    fn rejects_content_changed_after_signing() {
        let terms = br#"{"canonicalTerm":"adalimumab"}
"#;
        let encoded = package_with(terms, None, CompressionMethod::Stored, "0.4.0");
        let bytes = STANDARD.decode(encoded).expect("decode");
        let mut archive = ZipArchive::new(Cursor::new(bytes)).expect("archive");
        let manifest = {
            let mut file = archive.by_name("manifest.json").expect("manifest");
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).expect("read");
            bytes
        };
        assert!(!manifest.is_empty());
        let invalid_terms = br#"{"canonicalTerm":"different"}
"#;
        let invalid = package_with(invalid_terms, None, CompressionMethod::Stored, "0.4.0");
        assert!(verify_candordict_base64(&invalid).is_ok());
        let mut decoded = STANDARD.decode(invalid).expect("decode");
        let position = decoded
            .windows("different".len())
            .position(|window| window == b"different")
            .expect("term bytes");
        decoded[position] = b'X';
        let error =
            verify_candordict_base64(&STANDARD.encode(decoded)).expect_err("tampering must fail");
        assert!(matches!(
            error.code,
            "DICTIONARY_CONTENT_HASH_MISMATCH"
                | "DICTIONARY_ARCHIVE_INVALID"
                | "DICTIONARY_ARCHIVE_READ_FAILED"
        ));
    }

    #[test]
    fn rejects_unsafe_compression_ratio() {
        let terms = vec![b'a'; 100_000];
        let error = verify_candordict_base64(&package_with(
            &terms,
            None,
            CompressionMethod::Deflated,
            "0.4.0",
        ))
        .expect_err("archive bomb ratio must fail");
        assert_eq!(error.code, "DICTIONARY_ARCHIVE_RATIO_REJECTED");
    }

    #[test]
    fn bounded_reader_rejects_actual_output_beyond_declared_policy_limit() {
        let mut reader = Cursor::new(vec![b'a'; 65]);
        let error = read_bounded(&mut reader, 64).expect_err("actual output must be bounded");
        assert_eq!(error.code, "DICTIONARY_ARCHIVE_FILE_TOO_LARGE");
    }

    #[test]
    fn rejects_packages_requiring_a_newer_candor_version() {
        let terms = br#"{"canonicalTerm":"adalimumab"}
"#;
        let error = verify_candordict_base64(&package_with(
            terms,
            None,
            CompressionMethod::Stored,
            "99.0.0",
        ))
        .expect_err("future package must fail");
        assert_eq!(error.code, "DICTIONARY_VERSION_UNSUPPORTED");
    }
}
