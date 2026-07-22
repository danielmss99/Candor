use std::collections::BTreeMap;

use serde::Serialize;

pub const DIARIZATION_SCHEMA_VERSION: u32 = 1;
pub const DIARIZATION_BENCHMARK_SCHEMA_VERSION: u32 = 1;
pub const DIARIZATION_LICENSE_EVIDENCE_SCHEMA_VERSION: u32 = 1;
pub const MIN_BENCHMARK_SAMPLE_DURATION_MS: u64 = 60_000;
pub const MAX_BENCHMARK_REAL_TIME_FACTOR_MILLI: u32 = 1_000;
pub const MAX_BENCHMARK_PEAK_MEMORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const MAX_SPEAKER_ASSIGNMENTS: usize = 64;
pub const MAX_SPEAKER_NAME_BYTES: usize = 80;

const MAX_MODEL_ID_BYTES: usize = 128;
const SHA256_HEX_BYTES: usize = 64;
const MAX_ANONYMOUS_SPEAKER_NUMBER: u16 = 9_999;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiarizationError {
    pub code: &'static str,
    pub message: String,
}

impl DiarizationError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Proof that a model was resolved from Candor's local verified-model registry.
///
/// The constructor is intended for core-owned integration only. Renderer input must
/// never be converted directly into this type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedLocalDiarizationModel {
    model_id: String,
    sha256: String,
}

impl VerifiedLocalDiarizationModel {
    pub fn from_verified_local_artifact(
        model_id: impl Into<String>,
        sha256: impl Into<String>,
    ) -> Result<Self, DiarizationError> {
        let model_id = model_id.into();
        let sha256 = sha256.into();
        validate_safe_identifier(&model_id, MAX_MODEL_ID_BYTES, "model")?;
        if sha256.len() != SHA256_HEX_BYTES || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(DiarizationError::new(
                "DIARIZATION_MODEL_DIGEST_INVALID",
                "verified local model digest must be a SHA-256 hex value",
            ));
        }
        Ok(Self {
            model_id,
            sha256: sha256.to_ascii_lowercase(),
        })
    }

    pub fn model_id(&self) -> &str {
        &self.model_id
    }
}

/// Core-owned evidence that the exact verified model was reviewed for both
/// local use and redistribution. A model digest alone is not license proof.
/// Renderer input must never be promoted into this type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedDiarizationLicenseEvidence {
    schema_version: u32,
    model_id: String,
    model_sha256: String,
    license_id: String,
    local_use_allowed: bool,
    redistribution_allowed: bool,
}

impl VerifiedDiarizationLicenseEvidence {
    #[allow(clippy::too_many_arguments)]
    pub fn from_reviewed_license(
        schema_version: u32,
        model_id: impl Into<String>,
        model_sha256: impl Into<String>,
        license_id: impl Into<String>,
        local_use_allowed: bool,
        redistribution_allowed: bool,
    ) -> Result<Self, DiarizationError> {
        let model_id = model_id.into();
        let model_sha256 = model_sha256.into();
        let license_id = license_id.into();
        validate_safe_identifier(&model_id, MAX_MODEL_ID_BYTES, "license model")?;
        validate_safe_identifier(&license_id, MAX_MODEL_ID_BYTES, "license")?;
        if model_sha256.len() != SHA256_HEX_BYTES
            || !model_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(DiarizationError::new(
                "DIARIZATION_LICENSE_DIGEST_INVALID",
                "license evidence model digest must be a SHA-256 hex value",
            ));
        }
        Ok(Self {
            schema_version,
            model_id,
            model_sha256: model_sha256.to_ascii_lowercase(),
            license_id,
            local_use_allowed,
            redistribution_allowed,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiarizationBenchmark {
    schema_version: u32,
    model_id: String,
    model_sha256: String,
    sample_duration_ms: u64,
    real_time_factor_milli: u32,
    peak_memory_bytes: u64,
    completed_without_error: bool,
    local_only: bool,
}

impl DiarizationBenchmark {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        schema_version: u32,
        model_id: impl Into<String>,
        model_sha256: impl Into<String>,
        sample_duration_ms: u64,
        real_time_factor_milli: u32,
        peak_memory_bytes: u64,
        completed_without_error: bool,
        local_only: bool,
    ) -> Result<Self, DiarizationError> {
        let model_id = model_id.into();
        let model_sha256 = model_sha256.into();
        validate_safe_identifier(&model_id, MAX_MODEL_ID_BYTES, "benchmark model")?;
        if model_sha256.len() != SHA256_HEX_BYTES
            || !model_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(DiarizationError::new(
                "DIARIZATION_BENCHMARK_DIGEST_INVALID",
                "benchmark model digest must be a SHA-256 hex value",
            ));
        }
        Ok(Self {
            schema_version,
            model_id,
            model_sha256: model_sha256.to_ascii_lowercase(),
            sample_duration_ms,
            real_time_factor_milli,
            peak_memory_bytes,
            completed_without_error,
            local_only,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiarizationGateStatus {
    Disabled,
    ModelNotVerified,
    LicenseEvidenceRequired,
    LicenseEvidenceStale,
    LicenseRejected,
    BenchmarkRequired,
    BenchmarkStale,
    BenchmarkFailed,
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizationGateDecision {
    pub schema_version: u32,
    pub status: DiarizationGateStatus,
    pub reason_code: &'static str,
    pub diarization_allowed: bool,
    pub model_id: Option<String>,
    pub license_evidence_verified: bool,
    pub redistribution_allowed: bool,
    pub benchmark_required: bool,
    pub anonymous_speaker_labels_only: bool,
    pub biometric_identity_claimed: bool,
    pub local_only: bool,
    pub network_attempted: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

/// Opaque authorization token for a local diarizer.
///
/// A token exists only when the model proof and matching benchmark both pass.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiarizationPermit {
    model_id: String,
    model_sha256: String,
}

impl DiarizationPermit {
    pub fn model_id(&self) -> &str {
        &self.model_id
    }

    pub fn matches_verified_model(&self, model: &VerifiedLocalDiarizationModel) -> bool {
        self.model_id == model.model_id && self.model_sha256 == model.sha256
    }
}

#[derive(Clone, Debug)]
pub struct DiarizationGateEvaluation {
    pub decision: DiarizationGateDecision,
    permit: Option<DiarizationPermit>,
}

impl DiarizationGateEvaluation {
    pub fn permit(&self) -> Option<&DiarizationPermit> {
        self.permit.as_ref()
    }
}

pub fn evaluate_diarization_gate(
    enabled_by_user: bool,
    verified_model: Option<&VerifiedLocalDiarizationModel>,
    license_evidence: Option<&VerifiedDiarizationLicenseEvidence>,
    benchmark: Option<&DiarizationBenchmark>,
) -> DiarizationGateEvaluation {
    if !enabled_by_user {
        return evaluation(
            DiarizationGateStatus::Disabled,
            "DIARIZATION_DISABLED_BY_USER",
            verified_model,
            false,
            false,
            false,
        );
    }
    let Some(model) = verified_model else {
        return evaluation(
            DiarizationGateStatus::ModelNotVerified,
            "DIARIZATION_MODEL_NOT_VERIFIED",
            None,
            false,
            false,
            false,
        );
    };
    let Some(license_evidence) = license_evidence else {
        return evaluation(
            DiarizationGateStatus::LicenseEvidenceRequired,
            "DIARIZATION_LICENSE_EVIDENCE_REQUIRED",
            Some(model),
            false,
            false,
            false,
        );
    };
    if license_evidence.schema_version != DIARIZATION_LICENSE_EVIDENCE_SCHEMA_VERSION
        || license_evidence.model_id != model.model_id
        || license_evidence.model_sha256 != model.sha256
    {
        return evaluation(
            DiarizationGateStatus::LicenseEvidenceStale,
            "DIARIZATION_LICENSE_EVIDENCE_STALE",
            Some(model),
            false,
            false,
            false,
        );
    }
    if !license_evidence.local_use_allowed || !license_evidence.redistribution_allowed {
        return evaluation(
            DiarizationGateStatus::LicenseRejected,
            "DIARIZATION_LICENSE_REJECTED",
            Some(model),
            true,
            license_evidence.redistribution_allowed,
            false,
        );
    }
    let Some(benchmark) = benchmark else {
        return evaluation(
            DiarizationGateStatus::BenchmarkRequired,
            "DIARIZATION_BENCHMARK_REQUIRED",
            Some(model),
            true,
            true,
            false,
        );
    };
    if benchmark.schema_version != DIARIZATION_BENCHMARK_SCHEMA_VERSION
        || benchmark.model_id != model.model_id
        || benchmark.model_sha256 != model.sha256
    {
        return evaluation(
            DiarizationGateStatus::BenchmarkStale,
            "DIARIZATION_BENCHMARK_STALE",
            Some(model),
            true,
            true,
            false,
        );
    }
    if !benchmark.local_only
        || !benchmark.completed_without_error
        || benchmark.sample_duration_ms < MIN_BENCHMARK_SAMPLE_DURATION_MS
        || benchmark.real_time_factor_milli > MAX_BENCHMARK_REAL_TIME_FACTOR_MILLI
        || benchmark.peak_memory_bytes == 0
        || benchmark.peak_memory_bytes > MAX_BENCHMARK_PEAK_MEMORY_BYTES
    {
        return evaluation(
            DiarizationGateStatus::BenchmarkFailed,
            "DIARIZATION_BENCHMARK_FAILED",
            Some(model),
            true,
            true,
            false,
        );
    }

    evaluation(
        DiarizationGateStatus::Ready,
        "DIARIZATION_READY",
        Some(model),
        true,
        true,
        true,
    )
}

fn evaluation(
    status: DiarizationGateStatus,
    reason_code: &'static str,
    model: Option<&VerifiedLocalDiarizationModel>,
    license_evidence_verified: bool,
    redistribution_allowed: bool,
    allowed: bool,
) -> DiarizationGateEvaluation {
    let permit = if allowed {
        model.map(|model| DiarizationPermit {
            model_id: model.model_id.clone(),
            model_sha256: model.sha256.clone(),
        })
    } else {
        None
    };
    DiarizationGateEvaluation {
        decision: DiarizationGateDecision {
            schema_version: DIARIZATION_SCHEMA_VERSION,
            status,
            reason_code,
            diarization_allowed: allowed,
            model_id: model.map(|model| model.model_id.clone()),
            license_evidence_verified,
            redistribution_allowed,
            benchmark_required: !matches!(
                status,
                DiarizationGateStatus::Disabled | DiarizationGateStatus::Ready
            ),
            anonymous_speaker_labels_only: true,
            biometric_identity_claimed: false,
            local_only: true,
            network_attempted: false,
            raw_path_exposed: false,
            key_material_exposed_to_renderer: false,
        },
        permit,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeakerNameSource {
    User,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerNameAssignment {
    pub schema_version: u32,
    pub anonymous_speaker_id: String,
    pub display_name: String,
    pub source: SpeakerNameSource,
    pub user_controlled: bool,
    pub identity_inferred: bool,
    pub biometric_identity_claimed: bool,
    pub local_only: bool,
    pub network_attempted: bool,
    pub raw_path_exposed: bool,
    pub key_material_exposed_to_renderer: bool,
}

#[derive(Clone, Debug, Default)]
pub struct SpeakerNameAssignments {
    assignments: BTreeMap<String, String>,
}

impl SpeakerNameAssignments {
    pub fn assign(
        &mut self,
        anonymous_speaker_id: impl Into<String>,
        display_name: impl Into<String>,
    ) -> Result<SpeakerNameAssignment, DiarizationError> {
        let anonymous_speaker_id = anonymous_speaker_id.into();
        let display_name = display_name.into();
        validate_anonymous_speaker_id(&anonymous_speaker_id)?;
        validate_speaker_name(&display_name)?;
        if !self.assignments.contains_key(&anonymous_speaker_id)
            && self.assignments.len() >= MAX_SPEAKER_ASSIGNMENTS
        {
            return Err(DiarizationError::new(
                "DIARIZATION_SPEAKER_LIMIT",
                "speaker name assignment limit reached",
            ));
        }
        self.assignments
            .insert(anonymous_speaker_id.clone(), display_name.clone());
        Ok(assignment_response(anonymous_speaker_id, display_name))
    }

    pub fn remove(
        &mut self,
        anonymous_speaker_id: &str,
    ) -> Result<Option<SpeakerNameAssignment>, DiarizationError> {
        validate_anonymous_speaker_id(anonymous_speaker_id)?;
        Ok(self
            .assignments
            .remove(anonymous_speaker_id)
            .map(|display_name| {
                assignment_response(anonymous_speaker_id.to_string(), display_name)
            }))
    }

    pub fn list(&self) -> Vec<SpeakerNameAssignment> {
        self.assignments
            .iter()
            .map(|(speaker_id, display_name)| {
                assignment_response(speaker_id.clone(), display_name.clone())
            })
            .collect()
    }
}

fn assignment_response(
    anonymous_speaker_id: String,
    display_name: String,
) -> SpeakerNameAssignment {
    SpeakerNameAssignment {
        schema_version: DIARIZATION_SCHEMA_VERSION,
        anonymous_speaker_id,
        display_name,
        source: SpeakerNameSource::User,
        user_controlled: true,
        identity_inferred: false,
        biometric_identity_claimed: false,
        local_only: true,
        network_attempted: false,
        raw_path_exposed: false,
        key_material_exposed_to_renderer: false,
    }
}

fn validate_safe_identifier(
    value: &str,
    max_bytes: usize,
    kind: &str,
) -> Result<(), DiarizationError> {
    if value.is_empty() || value.len() > max_bytes {
        return Err(DiarizationError::new(
            "DIARIZATION_ID_INVALID",
            format!("{kind} identifier is empty or exceeds its limit"),
        ));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(DiarizationError::new(
            "DIARIZATION_ID_INVALID",
            format!("{kind} identifier contains unsupported characters"),
        ));
    }
    Ok(())
}

fn validate_anonymous_speaker_id(value: &str) -> Result<(), DiarizationError> {
    let Some(number) = value.strip_prefix("speaker-") else {
        return Err(DiarizationError::new(
            "DIARIZATION_SPEAKER_ID_INVALID",
            "speaker identifier must use the anonymous speaker-N form",
        ));
    };
    let parsed = number.parse::<u16>().map_err(|_| {
        DiarizationError::new(
            "DIARIZATION_SPEAKER_ID_INVALID",
            "speaker identifier must use the anonymous speaker-N form",
        )
    })?;
    if parsed == 0 || parsed > MAX_ANONYMOUS_SPEAKER_NUMBER || number.starts_with('0') {
        return Err(DiarizationError::new(
            "DIARIZATION_SPEAKER_ID_INVALID",
            "speaker identifier is outside the supported anonymous range",
        ));
    }
    Ok(())
}

fn validate_speaker_name(value: &str) -> Result<(), DiarizationError> {
    if value.is_empty()
        || value.len() > MAX_SPEAKER_NAME_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(DiarizationError::new(
            "DIARIZATION_SPEAKER_NAME_INVALID",
            "speaker name is empty, untrimmed, contains controls, or exceeds its limit",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn model() -> VerifiedLocalDiarizationModel {
        VerifiedLocalDiarizationModel::from_verified_local_artifact("diarization-small", DIGEST_A)
            .unwrap()
    }

    fn passing_benchmark() -> DiarizationBenchmark {
        DiarizationBenchmark::new(
            DIARIZATION_BENCHMARK_SCHEMA_VERSION,
            "diarization-small",
            DIGEST_A,
            MIN_BENCHMARK_SAMPLE_DURATION_MS,
            750,
            512 * 1024 * 1024,
            true,
            true,
        )
        .unwrap()
    }

    fn license() -> VerifiedDiarizationLicenseEvidence {
        VerifiedDiarizationLicenseEvidence::from_reviewed_license(
            DIARIZATION_LICENSE_EVIDENCE_SCHEMA_VERSION,
            "diarization-small",
            DIGEST_A,
            "mpl-2-0",
            true,
            true,
        )
        .unwrap()
    }

    #[test]
    fn no_permit_exists_when_disabled_or_model_is_unverified() {
        let disabled = evaluate_diarization_gate(
            false,
            Some(&model()),
            Some(&license()),
            Some(&passing_benchmark()),
        );
        assert_eq!(disabled.decision.status, DiarizationGateStatus::Disabled);
        assert!(!disabled.decision.diarization_allowed);
        assert!(disabled.permit().is_none());

        let unverified =
            evaluate_diarization_gate(true, None, Some(&license()), Some(&passing_benchmark()));
        assert_eq!(
            unverified.decision.status,
            DiarizationGateStatus::ModelNotVerified
        );
        assert!(unverified.permit().is_none());
    }

    #[test]
    fn reviewed_matching_license_and_redistribution_evidence_are_required() {
        let model = model();
        let benchmark = passing_benchmark();
        let missing = evaluate_diarization_gate(true, Some(&model), None, Some(&benchmark));
        assert_eq!(
            missing.decision.status,
            DiarizationGateStatus::LicenseEvidenceRequired
        );
        assert!(missing.permit().is_none());

        let stale = VerifiedDiarizationLicenseEvidence::from_reviewed_license(
            DIARIZATION_LICENSE_EVIDENCE_SCHEMA_VERSION,
            "diarization-small",
            DIGEST_B,
            "mpl-2-0",
            true,
            true,
        )
        .unwrap();
        let stale_result =
            evaluate_diarization_gate(true, Some(&model), Some(&stale), Some(&benchmark));
        assert_eq!(
            stale_result.decision.status,
            DiarizationGateStatus::LicenseEvidenceStale
        );

        let restricted = VerifiedDiarizationLicenseEvidence::from_reviewed_license(
            DIARIZATION_LICENSE_EVIDENCE_SCHEMA_VERSION,
            "diarization-small",
            DIGEST_A,
            "restricted-local",
            true,
            false,
        )
        .unwrap();
        let rejected =
            evaluate_diarization_gate(true, Some(&model), Some(&restricted), Some(&benchmark));
        assert_eq!(
            rejected.decision.status,
            DiarizationGateStatus::LicenseRejected
        );
        assert!(rejected.decision.license_evidence_verified);
        assert!(!rejected.decision.redistribution_allowed);
        assert!(rejected.permit().is_none());
    }

    #[test]
    fn matching_passing_benchmark_is_required_for_a_permit() {
        let model = model();
        let license = license();
        let missing = evaluate_diarization_gate(true, Some(&model), Some(&license), None);
        assert_eq!(
            missing.decision.status,
            DiarizationGateStatus::BenchmarkRequired
        );
        assert!(missing.permit().is_none());

        let stale = DiarizationBenchmark::new(
            DIARIZATION_BENCHMARK_SCHEMA_VERSION,
            "diarization-small",
            DIGEST_B,
            MIN_BENCHMARK_SAMPLE_DURATION_MS,
            500,
            100,
            true,
            true,
        )
        .unwrap();
        let stale_result =
            evaluate_diarization_gate(true, Some(&model), Some(&license), Some(&stale));
        assert_eq!(
            stale_result.decision.status,
            DiarizationGateStatus::BenchmarkStale
        );
        assert!(stale_result.permit().is_none());

        let passing = passing_benchmark();
        let ready = evaluate_diarization_gate(true, Some(&model), Some(&license), Some(&passing));
        assert_eq!(ready.decision.status, DiarizationGateStatus::Ready);
        assert!(ready.decision.diarization_allowed);
        assert!(ready.permit().unwrap().matches_verified_model(&model));
    }

    #[test]
    fn benchmark_threshold_failures_never_issue_a_permit() {
        let model = model();
        let failures = [
            DiarizationBenchmark::new(
                1,
                "diarization-small",
                DIGEST_A,
                MIN_BENCHMARK_SAMPLE_DURATION_MS - 1,
                500,
                100,
                true,
                true,
            )
            .unwrap(),
            DiarizationBenchmark::new(
                1,
                "diarization-small",
                DIGEST_A,
                MIN_BENCHMARK_SAMPLE_DURATION_MS,
                MAX_BENCHMARK_REAL_TIME_FACTOR_MILLI + 1,
                100,
                true,
                true,
            )
            .unwrap(),
            DiarizationBenchmark::new(
                1,
                "diarization-small",
                DIGEST_A,
                MIN_BENCHMARK_SAMPLE_DURATION_MS,
                500,
                MAX_BENCHMARK_PEAK_MEMORY_BYTES + 1,
                true,
                true,
            )
            .unwrap(),
            DiarizationBenchmark::new(
                1,
                "diarization-small",
                DIGEST_A,
                MIN_BENCHMARK_SAMPLE_DURATION_MS,
                500,
                100,
                false,
                true,
            )
            .unwrap(),
            DiarizationBenchmark::new(
                1,
                "diarization-small",
                DIGEST_A,
                MIN_BENCHMARK_SAMPLE_DURATION_MS,
                500,
                100,
                true,
                false,
            )
            .unwrap(),
        ];
        for benchmark in failures {
            let result =
                evaluate_diarization_gate(true, Some(&model), Some(&license()), Some(&benchmark));
            assert_eq!(
                result.decision.status,
                DiarizationGateStatus::BenchmarkFailed
            );
            assert!(!result.decision.diarization_allowed);
            assert!(result.permit().is_none());
        }
    }

    #[test]
    fn speaker_names_are_bounded_and_explicitly_user_controlled() {
        let mut assignments = SpeakerNameAssignments::default();
        let assigned = assignments.assign("speaker-1", "Avery").unwrap();
        assert_eq!(assigned.display_name, "Avery");
        assert_eq!(assigned.source, SpeakerNameSource::User);
        assert!(assigned.user_controlled);
        assert!(!assigned.identity_inferred);
        assert!(!assigned.biometric_identity_claimed);

        let updated = assignments.assign("speaker-1", "Morgan").unwrap();
        assert_eq!(updated.display_name, "Morgan");
        assert_eq!(assignments.list().len(), 1);
        assert_eq!(assignments.remove("speaker-1").unwrap(), Some(updated));
        assert!(assignments.list().is_empty());
    }

    #[test]
    fn rejects_invalid_speaker_ids_and_names() {
        let mut assignments = SpeakerNameAssignments::default();
        for id in [
            "Alex",
            "speaker-0",
            "speaker-01",
            "speaker-10000",
            "speaker/1",
        ] {
            assert_eq!(
                assignments.assign(id, "Alex").unwrap_err().code,
                "DIARIZATION_SPEAKER_ID_INVALID"
            );
        }
        for name in ["", " Alex", "Alex ", "Alex\nMorgan"] {
            assert_eq!(
                assignments.assign("speaker-1", name).unwrap_err().code,
                "DIARIZATION_SPEAKER_NAME_INVALID"
            );
        }
        let too_long = "a".repeat(MAX_SPEAKER_NAME_BYTES + 1);
        assert_eq!(
            assignments.assign("speaker-1", too_long).unwrap_err().code,
            "DIARIZATION_SPEAKER_NAME_INVALID"
        );
    }

    #[test]
    fn speaker_assignment_count_is_bounded() {
        let mut assignments = SpeakerNameAssignments::default();
        for number in 1..=MAX_SPEAKER_ASSIGNMENTS {
            assignments
                .assign(format!("speaker-{number}"), format!("Participant {number}"))
                .unwrap();
        }
        assert_eq!(assignments.list().len(), MAX_SPEAKER_ASSIGNMENTS);
        assert_eq!(
            assignments
                .assign("speaker-65", "Participant 65")
                .unwrap_err()
                .code,
            "DIARIZATION_SPEAKER_LIMIT"
        );
    }

    #[test]
    fn serialized_status_and_labels_are_local_pathless_and_non_biometric() {
        let model = model();
        let benchmark = passing_benchmark();
        let decision =
            evaluate_diarization_gate(true, Some(&model), Some(&license()), Some(&benchmark))
                .decision;
        let value = serde_json::to_value(decision).unwrap();
        assert_eq!(value["diarizationAllowed"], true);
        assert_eq!(value["licenseEvidenceVerified"], true);
        assert_eq!(value["redistributionAllowed"], true);
        assert_eq!(value["anonymousSpeakerLabelsOnly"], true);
        assert_eq!(value["biometricIdentityClaimed"], false);
        assert_eq!(value["rawPathExposed"], false);
        assert_eq!(value["keyMaterialExposedToRenderer"], false);
        assert_eq!(value["networkAttempted"], false);
        assert!(value.get("modelSha256").is_none());
        assert!(value.get("path").is_none());
    }
}
