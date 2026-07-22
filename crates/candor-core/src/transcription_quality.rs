use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sysinfo::System;

const POLICY_SCHEMA_VERSION: u32 = 1;
const POLICY_FILE: &str = "transcription-quality.json";
const POLICY_BACKUP_FILE: &str = "transcription-quality.json.bak";
const POLICY_TEMP_FILE: &str = "transcription-quality.json.tmp";
const GIB: u64 = 1024 * 1024 * 1024;
const BALANCED_MAX_REAL_TIME_FACTOR: f64 = 0.5;
const MAXIMUM_MAX_REAL_TIME_FACTOR: f64 = 1.0;
const MAX_BENCHMARK_MODEL_HASHES: usize = 8;
pub(crate) const TRANSCRIPTION_BENCHMARK_AUDIO_SECONDS: u32 = 30;

#[derive(Debug)]
pub struct TranscriptionQualityError {
    pub code: &'static str,
    pub message: String,
}

impl TranscriptionQualityError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionTier {
    Fast,
    #[default]
    Balanced,
    Maximum,
}

impl TranscriptionTier {
    pub fn id(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Balanced => "balanced",
            Self::Maximum => "maximum",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Fast => "Fast",
            Self::Balanced => "Balanced",
            Self::Maximum => "Maximum accuracy",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LanguagePreference {
    #[default]
    English,
    Multilingual,
}

impl LanguagePreference {
    fn id(self) -> &'static str {
        match self {
            Self::English => "english",
            Self::Multilingual => "multilingual",
        }
    }

    pub fn whisper_language(self) -> &'static str {
        match self {
            Self::English => "en",
            Self::Multilingual => "auto",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BenchmarkEvidence {
    state: String,
    #[serde(default)]
    balanced_passed: bool,
    #[serde(default)]
    maximum_passed: bool,
    #[serde(default)]
    balanced_real_time_factor: Option<f64>,
    #[serde(default)]
    maximum_real_time_factor: Option<f64>,
    #[serde(default, alias = "llmTokensPerSecond")]
    llm_estimated_tokens_per_second: Option<f64>,
    #[serde(default)]
    model_hashes: Vec<String>,
    #[serde(default)]
    balanced_model_sha256: Option<String>,
    #[serde(default)]
    maximum_model_sha256: Option<String>,
    #[serde(default)]
    failure_code: Option<String>,
    #[serde(default)]
    failure_tier: Option<TranscriptionBenchmarkTier>,
}

impl Default for BenchmarkEvidence {
    fn default() -> Self {
        Self {
            state: "not-run".to_string(),
            balanced_passed: false,
            maximum_passed: false,
            balanced_real_time_factor: None,
            maximum_real_time_factor: None,
            llm_estimated_tokens_per_second: None,
            model_hashes: Vec::new(),
            balanced_model_sha256: None,
            maximum_model_sha256: None,
            failure_code: None,
            failure_tier: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QualityPolicy {
    schema_version: u32,
    preferred_tier: TranscriptionTier,
    language_preference: LanguagePreference,
    #[serde(default)]
    selection_explicit: bool,
    benchmark: BenchmarkEvidence,
}

impl QualityPolicy {
    fn default_for(hardware: &HardwareCapability) -> Self {
        let benchmark = BenchmarkEvidence::default();
        Self {
            schema_version: POLICY_SCHEMA_VERSION,
            preferred_tier: recommended_tier(hardware, &benchmark),
            language_preference: LanguagePreference::English,
            selection_explicit: false,
            benchmark,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareCapability {
    total_memory_bytes: u64,
    logical_cpu_count: usize,
    operating_system: &'static str,
    architecture: &'static str,
    acceleration_state: &'static str,
}

impl HardwareCapability {
    fn detect() -> Self {
        let mut system = System::new_all();
        system.refresh_memory();
        Self {
            total_memory_bytes: system.total_memory(),
            logical_cpu_count: std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1),
            operating_system: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            acceleration_state: "not-measured",
        }
    }

    #[cfg(test)]
    fn with_memory_gib(memory_gib: u64) -> Self {
        Self {
            total_memory_bytes: memory_gib * GIB,
            logical_cpu_count: 8,
            operating_system: "test",
            architecture: "test",
            acceleration_state: "not-measured",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptionQualityUpdateParams {
    pub tier: TranscriptionTier,
    #[serde(default)]
    pub language_preference: Option<LanguagePreference>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionBenchmarkTier {
    #[default]
    Balanced,
    Maximum,
}

impl TranscriptionBenchmarkTier {
    pub fn id(self) -> &'static str {
        match self {
            Self::Balanced => "balanced",
            Self::Maximum => "maximum",
        }
    }

    pub fn model_id(self) -> &'static str {
        match self {
            Self::Balanced => "large-v3-turbo",
            Self::Maximum => "large-v3",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptionBenchmarkParams {
    #[serde(default)]
    pub tier: TranscriptionBenchmarkTier,
}

#[derive(Clone, Debug)]
pub struct TranscriptionBenchmarkMeasurement {
    pub tier: TranscriptionBenchmarkTier,
    pub whisper_real_time_factor: f64,
    pub llm_estimated_tokens_per_second: f64,
    pub whisper_model_sha256: String,
    pub llm_model_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QualityResolution {
    pub tier: TranscriptionTier,
    pub language_preference: LanguagePreference,
    pub model_id: &'static str,
    pub fallback_applied: bool,
    pub guard_reason: Option<&'static str>,
}

#[derive(Clone)]
pub struct TranscriptionQualityService {
    root: PathBuf,
    hardware: HardwareCapability,
    storage_lock: Arc<Mutex<()>>,
}

impl TranscriptionQualityService {
    pub fn with_root(root: PathBuf) -> Self {
        Self {
            root,
            hardware: HardwareCapability::detect(),
            storage_lock: Arc::new(Mutex::new(())),
        }
    }

    #[cfg(test)]
    fn with_hardware(root: PathBuf, hardware: HardwareCapability) -> Self {
        Self {
            root,
            hardware,
            storage_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn status(&self) -> Value {
        match self.load_policy() {
            Ok(policy) => self.status_for(&policy, None, false),
            Err(error) => json!({
                "implemented": true,
                "state": "corrupt",
                "tier": "fast",
                "languagePreference": "english",
                "recommendedTier": "fast",
                "benchmarkState": "unavailable",
                "benchmarkFailureTier": null,
                "estimatedRealTimeFactor": null,
                "estimatedMinutesPerHour": null,
                "estimatedCompletionAvailable": false,
                "fallbackApplied": true,
                "guardReason": "quality-settings-need-reset",
                "failureCode": error.code,
                "hardware": self.hardware,
                "tiers": self.tier_values(&QualityPolicy::default_for(&self.hardware)),
                "localOnly": true,
                "cloudAi": false,
                "rawModelNamesExposed": false,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            }),
        }
    }

    pub(crate) fn measured_speech_model_latencies_ms(&self) -> BTreeMap<String, u64> {
        let Ok(policy) = self.load_policy() else {
            return BTreeMap::new();
        };
        if policy.benchmark.state != "measured" {
            return BTreeMap::new();
        }
        let mut measurements = BTreeMap::new();
        for (tier, real_time_factor, measured_sha256) in [
            (
                TranscriptionBenchmarkTier::Balanced,
                policy.benchmark.balanced_real_time_factor,
                policy.benchmark.balanced_model_sha256.as_deref(),
            ),
            (
                TranscriptionBenchmarkTier::Maximum,
                policy.benchmark.maximum_real_time_factor,
                policy.benchmark.maximum_model_sha256.as_deref(),
            ),
        ] {
            let Some(real_time_factor) = real_time_factor else {
                continue;
            };
            if !real_time_factor.is_finite()
                || real_time_factor <= 0.0
                || !benchmark_hash_matches(tier, measured_sha256)
            {
                continue;
            }
            let elapsed_ms =
                real_time_factor * f64::from(TRANSCRIPTION_BENCHMARK_AUDIO_SECONDS) * 1_000.0;
            if elapsed_ms.is_finite() && elapsed_ms > 0.0 && elapsed_ms <= u64::MAX as f64 {
                measurements.insert(tier.model_id().to_string(), elapsed_ms.round() as u64);
            }
        }
        measurements
    }

    pub fn update(
        &self,
        params: TranscriptionQualityUpdateParams,
    ) -> Result<Value, TranscriptionQualityError> {
        let _guard = self.lock_storage()?;
        let mut policy = self.load_policy_unlocked()?;
        if let Some(language) = params.language_preference {
            policy.language_preference = language;
        }
        let requested = params.tier;
        let evaluation = evaluate_tier(requested, &self.hardware, &policy.benchmark);
        let fallback_applied = !evaluation.available;
        let guard_reason = evaluation.guard_reason;
        policy.preferred_tier = if evaluation.available {
            requested
        } else {
            recommended_tier(&self.hardware, &policy.benchmark)
        };
        policy.selection_explicit = true;
        self.write_policy_unlocked(&policy)?;
        Ok(self.status_for(&policy, guard_reason, fallback_applied))
    }

    pub fn resolve(&self) -> Result<QualityResolution, TranscriptionQualityError> {
        let policy = self.load_policy()?;
        Ok(resolve_policy(&policy, &self.hardware))
    }

    pub fn record_benchmark(
        &self,
        measurement: TranscriptionBenchmarkMeasurement,
    ) -> Result<Value, TranscriptionQualityError> {
        validate_benchmark_measurement(&measurement)?;
        let _guard = self.lock_storage()?;
        let mut policy = self.load_policy_unlocked()?;
        let passed = match measurement.tier {
            TranscriptionBenchmarkTier::Balanced => {
                policy.benchmark.balanced_real_time_factor =
                    Some(measurement.whisper_real_time_factor);
                let passed = measurement.whisper_real_time_factor <= BALANCED_MAX_REAL_TIME_FACTOR;
                policy.benchmark.balanced_passed = passed;
                policy.benchmark.balanced_model_sha256 =
                    Some(measurement.whisper_model_sha256.clone());
                passed
            }
            TranscriptionBenchmarkTier::Maximum => {
                policy.benchmark.maximum_real_time_factor =
                    Some(measurement.whisper_real_time_factor);
                let passed = measurement.whisper_real_time_factor <= MAXIMUM_MAX_REAL_TIME_FACTOR;
                policy.benchmark.maximum_passed = passed;
                policy.benchmark.maximum_model_sha256 =
                    Some(measurement.whisper_model_sha256.clone());
                passed
            }
        };
        policy.benchmark.state = "measured".to_string();
        policy.benchmark.llm_estimated_tokens_per_second =
            Some(measurement.llm_estimated_tokens_per_second);
        policy.benchmark.failure_code = None;
        policy.benchmark.failure_tier = None;
        for hash in [
            measurement.whisper_model_sha256,
            measurement.llm_model_sha256,
        ] {
            if !policy
                .benchmark
                .model_hashes
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&hash))
            {
                policy.benchmark.model_hashes.push(hash);
            }
        }
        if policy.benchmark.model_hashes.len() > MAX_BENCHMARK_MODEL_HASHES {
            let remove_count = policy.benchmark.model_hashes.len() - MAX_BENCHMARK_MODEL_HASHES;
            policy.benchmark.model_hashes.drain(..remove_count);
        }
        if passed && !policy.selection_explicit {
            policy.preferred_tier = recommended_tier(&self.hardware, &policy.benchmark);
        }
        self.write_policy_unlocked(&policy)?;
        Ok(json!({
            "benchmarkState": "measured",
            "tier": measurement.tier.id(),
            "passed": passed,
            "whisperMeasured": true,
            "localLlmMeasured": true,
            "localOnly": true,
            "cloudAi": false,
            "rawModelNamesExposed": false,
            "rawHashExposed": false,
            "rawMetricExposed": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn record_benchmark_failure(
        &self,
        tier: TranscriptionBenchmarkTier,
        failure_code: &'static str,
    ) -> Result<(), TranscriptionQualityError> {
        let _guard = self.lock_storage()?;
        let mut policy = self.load_policy_unlocked()?;
        if !policy.benchmark.balanced_passed && !policy.benchmark.maximum_passed {
            policy.benchmark.state = "failed".to_string();
        }
        policy.benchmark.failure_code = Some(failure_code.to_string());
        policy.benchmark.failure_tier = Some(tier);
        self.write_policy_unlocked(&policy)
    }

    fn status_for(
        &self,
        policy: &QualityPolicy,
        guard_reason: Option<&'static str>,
        fallback_applied: bool,
    ) -> Value {
        let resolution = resolve_policy(policy, &self.hardware);
        let estimated_minutes_per_hour = estimated_minutes_per_hour(policy, resolution.tier);
        json!({
            "implemented": true,
            "state": "ready",
            "tier": resolution.tier.id(),
            "languagePreference": policy.language_preference.id(),
            "recommendedTier": recommended_tier(&self.hardware, &policy.benchmark).id(),
            "recommendationBasis": if policy.benchmark.state == "measured" { "measured-local-benchmark" } else { "conservative-hardware-policy" },
            "benchmarkState": policy.benchmark.state,
            "benchmarkFailureCode": policy.benchmark.failure_code,
            "benchmarkFailureTier": policy.benchmark.failure_tier.map(TranscriptionBenchmarkTier::id),
            // Raw benchmark values are diagnostics-only. Normal settings receive only
            // a rounded, user-facing completion estimate.
            "estimatedRealTimeFactor": Value::Null,
            "estimatedMinutesPerHour": estimated_minutes_per_hour,
            "estimatedCompletionAvailable": estimated_minutes_per_hour.is_some(),
            "fallbackApplied": fallback_applied || resolution.fallback_applied,
            "guardReason": guard_reason.or(resolution.guard_reason),
            "hardware": self.hardware,
            "tiers": self.tier_values(policy),
            "localOnly": true,
            "cloudAi": false,
            "rawModelNamesExposed": false,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    fn tier_values(&self, policy: &QualityPolicy) -> Vec<Value> {
        let recommendation = recommended_tier(&self.hardware, &policy.benchmark);
        [
            TranscriptionTier::Fast,
            TranscriptionTier::Balanced,
            TranscriptionTier::Maximum,
        ]
        .into_iter()
        .map(|tier| {
            let evaluation = evaluate_tier(tier, &self.hardware, &policy.benchmark);
            json!({
                "id": tier.id(),
                "label": tier.label(),
                "available": evaluation.available,
                "recommended": tier == recommendation,
                "guardReason": evaluation.guard_reason
            })
        })
        .collect()
    }

    fn load_policy(&self) -> Result<QualityPolicy, TranscriptionQualityError> {
        let _guard = self.lock_storage()?;
        self.load_policy_unlocked()
    }

    fn load_policy_unlocked(&self) -> Result<QualityPolicy, TranscriptionQualityError> {
        let path = self.root.join(POLICY_FILE);
        if !path.exists() {
            return Ok(QualityPolicy::default_for(&self.hardware));
        }
        match read_policy(&path) {
            Ok(policy) => Ok(policy),
            Err(primary_error) => {
                let backup = self.root.join(POLICY_BACKUP_FILE);
                if backup.exists() {
                    read_policy(&backup).map_err(|_| primary_error)
                } else {
                    Err(primary_error)
                }
            }
        }
    }

    fn lock_storage(&self) -> Result<MutexGuard<'_, ()>, TranscriptionQualityError> {
        self.storage_lock.lock().map_err(|_| {
            TranscriptionQualityError::new(
                "TRANSCRIPTION_QUALITY_LOCK_FAILED",
                "transcription quality settings are temporarily unavailable",
            )
        })
    }

    fn write_policy_unlocked(
        &self,
        policy: &QualityPolicy,
    ) -> Result<(), TranscriptionQualityError> {
        fs::create_dir_all(&self.root).map_err(|_| {
            TranscriptionQualityError::new(
                "TRANSCRIPTION_QUALITY_DIR_FAILED",
                "transcription quality settings could not be prepared",
            )
        })?;
        let target = self.root.join(POLICY_FILE);
        let backup = self.root.join(POLICY_BACKUP_FILE);
        let temporary = self.root.join(POLICY_TEMP_FILE);
        if temporary.exists() {
            fs::remove_file(&temporary).map_err(|_| {
                TranscriptionQualityError::new(
                    "TRANSCRIPTION_QUALITY_TEMP_FAILED",
                    "stale transcription quality settings could not be removed",
                )
            })?;
        }
        let payload = serde_json::to_vec_pretty(policy).map_err(|_| {
            TranscriptionQualityError::new(
                "TRANSCRIPTION_QUALITY_SERIALIZE_FAILED",
                "transcription quality settings could not be encoded",
            )
        })?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| {
                TranscriptionQualityError::new(
                    "TRANSCRIPTION_QUALITY_WRITE_FAILED",
                    "transcription quality settings could not be written",
                )
            })?;
        file.write_all(&payload)
            .and_then(|_| file.sync_all())
            .map_err(|_| {
                TranscriptionQualityError::new(
                    "TRANSCRIPTION_QUALITY_WRITE_FAILED",
                    "transcription quality settings could not be written durably",
                )
            })?;
        drop(file);

        if backup.exists() {
            fs::remove_file(&backup).map_err(|_| {
                TranscriptionQualityError::new(
                    "TRANSCRIPTION_QUALITY_BACKUP_FAILED",
                    "stale transcription quality backup could not be removed",
                )
            })?;
        }
        let had_target = target.exists();
        if had_target {
            fs::rename(&target, &backup).map_err(|_| {
                TranscriptionQualityError::new(
                    "TRANSCRIPTION_QUALITY_BACKUP_FAILED",
                    "current transcription quality settings could not be backed up",
                )
            })?;
        }
        if fs::rename(&temporary, &target).is_err() {
            if had_target && backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(TranscriptionQualityError::new(
                "TRANSCRIPTION_QUALITY_COMMIT_FAILED",
                "new transcription quality settings could not be committed",
            ));
        }
        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }
        Ok(())
    }
}

fn validate_benchmark_measurement(
    measurement: &TranscriptionBenchmarkMeasurement,
) -> Result<(), TranscriptionQualityError> {
    if !measurement.whisper_real_time_factor.is_finite()
        || measurement.whisper_real_time_factor <= 0.0
        || !measurement.llm_estimated_tokens_per_second.is_finite()
        || measurement.llm_estimated_tokens_per_second <= 0.0
    {
        return Err(TranscriptionQualityError::new(
            "TRANSCRIPTION_BENCHMARK_MEASUREMENT_INVALID",
            "local performance measurements must be finite positive values",
        ));
    }
    if !is_sha256(&measurement.whisper_model_sha256) || !is_sha256(&measurement.llm_model_sha256) {
        return Err(TranscriptionQualityError::new(
            "TRANSCRIPTION_BENCHMARK_MODEL_HASH_INVALID",
            "local performance measurements require verified model fingerprints",
        ));
    }
    let expected_whisper_sha256 = crate::model_manager::trusted_model_sha256(
        measurement.tier.model_id(),
    )
    .ok_or_else(|| {
        TranscriptionQualityError::new(
            "TRANSCRIPTION_BENCHMARK_MODEL_UNTRUSTED",
            "the measured Whisper model is not in Candor's trusted model policy",
        )
    })?;
    if !expected_whisper_sha256.eq_ignore_ascii_case(&measurement.whisper_model_sha256) {
        return Err(TranscriptionQualityError::new(
            "TRANSCRIPTION_BENCHMARK_MODEL_TRUST_MISMATCH",
            "the measured Whisper model does not match Candor's trusted fingerprint",
        ));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Clone, Copy)]
struct TierEvaluation {
    available: bool,
    guard_reason: Option<&'static str>,
}

fn evaluate_tier(
    tier: TranscriptionTier,
    hardware: &HardwareCapability,
    benchmark: &BenchmarkEvidence,
) -> TierEvaluation {
    match tier {
        TranscriptionTier::Fast => TierEvaluation {
            available: true,
            guard_reason: None,
        },
        TranscriptionTier::Balanced if hardware.total_memory_bytes < 8 * GIB => TierEvaluation {
            available: false,
            guard_reason: Some("balanced-requires-at-least-8gb-memory"),
        },
        TranscriptionTier::Balanced if !benchmark.balanced_passed => TierEvaluation {
            available: false,
            guard_reason: Some("balanced-requires-passing-local-benchmark-on-this-device"),
        },
        TranscriptionTier::Balanced
            if !benchmark_hash_matches(
                TranscriptionBenchmarkTier::Balanced,
                benchmark.balanced_model_sha256.as_deref(),
            ) =>
        {
            TierEvaluation {
                available: false,
                guard_reason: Some("balanced-requires-fresh-local-benchmark-for-current-model"),
            }
        }
        TranscriptionTier::Balanced => TierEvaluation {
            available: true,
            guard_reason: None,
        },
        TranscriptionTier::Maximum if hardware.total_memory_bytes < 16 * GIB => TierEvaluation {
            available: false,
            guard_reason: Some("maximum-requires-at-least-16gb-memory"),
        },
        TranscriptionTier::Maximum if !benchmark.maximum_passed => TierEvaluation {
            available: false,
            guard_reason: Some("maximum-requires-passing-local-benchmark"),
        },
        TranscriptionTier::Maximum
            if !benchmark_hash_matches(
                TranscriptionBenchmarkTier::Maximum,
                benchmark.maximum_model_sha256.as_deref(),
            ) =>
        {
            TierEvaluation {
                available: false,
                guard_reason: Some("maximum-requires-fresh-local-benchmark-for-current-model"),
            }
        }
        TranscriptionTier::Maximum => TierEvaluation {
            available: true,
            guard_reason: None,
        },
    }
}

fn benchmark_hash_matches(tier: TranscriptionBenchmarkTier, measured_sha256: Option<&str>) -> bool {
    crate::model_manager::trusted_model_sha256(tier.model_id())
        .zip(measured_sha256)
        .is_some_and(|(expected, measured)| expected.eq_ignore_ascii_case(measured))
}

fn recommended_tier(
    hardware: &HardwareCapability,
    benchmark: &BenchmarkEvidence,
) -> TranscriptionTier {
    if evaluate_tier(TranscriptionTier::Balanced, hardware, benchmark).available {
        TranscriptionTier::Balanced
    } else {
        TranscriptionTier::Fast
    }
}

fn estimated_minutes_per_hour(policy: &QualityPolicy, tier: TranscriptionTier) -> Option<u64> {
    let real_time_factor = match tier {
        TranscriptionTier::Fast => None,
        TranscriptionTier::Balanced => policy.benchmark.balanced_real_time_factor,
        TranscriptionTier::Maximum => policy.benchmark.maximum_real_time_factor,
    }?;
    let minutes = (real_time_factor * 60.0).ceil();
    if !minutes.is_finite() || minutes <= 0.0 {
        return None;
    }
    Some(minutes.clamp(1.0, 60.0) as u64)
}

fn resolve_policy(policy: &QualityPolicy, hardware: &HardwareCapability) -> QualityResolution {
    let evaluation = evaluate_tier(policy.preferred_tier, hardware, &policy.benchmark);
    let tier = if evaluation.available {
        policy.preferred_tier
    } else {
        recommended_tier(hardware, &policy.benchmark)
    };
    QualityResolution {
        tier,
        language_preference: policy.language_preference,
        model_id: model_for(tier, policy.language_preference),
        fallback_applied: !evaluation.available,
        guard_reason: evaluation.guard_reason,
    }
}

fn model_for(tier: TranscriptionTier, language: LanguagePreference) -> &'static str {
    match (tier, language) {
        (TranscriptionTier::Fast, LanguagePreference::English) => "small.en",
        (TranscriptionTier::Fast, LanguagePreference::Multilingual) => "small",
        (TranscriptionTier::Balanced, _) => "large-v3-turbo",
        (TranscriptionTier::Maximum, _) => "large-v3",
    }
}

fn read_policy(path: &Path) -> Result<QualityPolicy, TranscriptionQualityError> {
    let file = File::open(path).map_err(|_| {
        TranscriptionQualityError::new(
            "TRANSCRIPTION_QUALITY_READ_FAILED",
            "transcription quality settings could not be read",
        )
    })?;
    let mut bytes = Vec::new();
    file.take(64 * 1024).read_to_end(&mut bytes).map_err(|_| {
        TranscriptionQualityError::new(
            "TRANSCRIPTION_QUALITY_READ_FAILED",
            "transcription quality settings could not be read",
        )
    })?;
    let policy: QualityPolicy = serde_json::from_slice(&bytes).map_err(|_| {
        TranscriptionQualityError::new(
            "TRANSCRIPTION_QUALITY_CORRUPT",
            "transcription quality settings are invalid and were not changed",
        )
    })?;
    if policy.schema_version != POLICY_SCHEMA_VERSION {
        return Err(TranscriptionQualityError::new(
            "TRANSCRIPTION_QUALITY_SCHEMA_UNSUPPORTED",
            "transcription quality settings use an unsupported version",
        ));
    }
    Ok(policy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "candor-quality-{name}-{}-{stamp}",
            std::process::id()
        ))
    }

    fn trusted_hash(tier: TranscriptionBenchmarkTier) -> String {
        crate::model_manager::trusted_model_sha256(tier.model_id())
            .expect("trusted benchmark model")
            .to_string()
    }

    #[test]
    fn fast_maps_language_without_mutating_preference() {
        let root = test_root("language");
        let service = TranscriptionQualityService::with_hardware(
            root,
            HardwareCapability::with_memory_gib(8),
        );
        service
            .update(TranscriptionQualityUpdateParams {
                tier: TranscriptionTier::Fast,
                language_preference: Some(LanguagePreference::Multilingual),
            })
            .expect("save multilingual fast");
        let resolved = service.resolve().expect("resolve multilingual fast");
        assert_eq!(resolved.model_id, "small");
        assert_eq!(
            resolved.language_preference,
            LanguagePreference::Multilingual
        );

        service
            .update(TranscriptionQualityUpdateParams {
                tier: TranscriptionTier::Balanced,
                language_preference: None,
            })
            .expect("guard balanced");
        let guarded = service.resolve().expect("resolve guarded balanced");
        assert_eq!(guarded.model_id, "small");
        assert_eq!(
            guarded.language_preference,
            LanguagePreference::Multilingual
        );
    }

    #[test]
    fn balanced_requires_a_measured_pass_on_every_device() {
        let hardware = HardwareCapability::with_memory_gib(32);
        let evaluation = evaluate_tier(
            TranscriptionTier::Balanced,
            &hardware,
            &BenchmarkEvidence::default(),
        );
        assert!(!evaluation.available);
        assert_eq!(
            evaluation.guard_reason,
            Some("balanced-requires-passing-local-benchmark-on-this-device")
        );

        let measured = BenchmarkEvidence {
            state: "measured".to_string(),
            balanced_passed: true,
            balanced_model_sha256: Some(trusted_hash(TranscriptionBenchmarkTier::Balanced)),
            ..BenchmarkEvidence::default()
        };
        assert!(evaluate_tier(TranscriptionTier::Balanced, &hardware, &measured).available);
    }

    #[test]
    fn maximum_requires_memory_and_measured_pass() {
        let hardware = HardwareCapability::with_memory_gib(32);
        let pending = evaluate_tier(
            TranscriptionTier::Maximum,
            &hardware,
            &BenchmarkEvidence::default(),
        );
        assert!(!pending.available);
        let measured = BenchmarkEvidence {
            state: "measured".to_string(),
            maximum_passed: true,
            maximum_model_sha256: Some(trusted_hash(TranscriptionBenchmarkTier::Maximum)),
            ..BenchmarkEvidence::default()
        };
        assert!(evaluate_tier(TranscriptionTier::Maximum, &hardware, &measured).available);
    }

    #[test]
    fn measured_balanced_benchmark_unlocks_only_after_a_passing_local_run() {
        let root = test_root("measured-balanced");
        let service = TranscriptionQualityService::with_hardware(
            root,
            HardwareCapability::with_memory_gib(16),
        );
        let result = service
            .record_benchmark(TranscriptionBenchmarkMeasurement {
                tier: TranscriptionBenchmarkTier::Balanced,
                whisper_real_time_factor: 0.25,
                llm_estimated_tokens_per_second: 8.0,
                whisper_model_sha256: trusted_hash(TranscriptionBenchmarkTier::Balanced),
                llm_model_sha256: "b".repeat(64),
            })
            .expect("record benchmark");
        assert_eq!(result["passed"], true);
        assert_eq!(result["rawHashExposed"], false);
        let status = service.status();
        assert_eq!(status["benchmarkState"], "measured");
        assert_eq!(status["recommendedTier"], "balanced");
        assert_eq!(status["estimatedMinutesPerHour"], 15);
        assert_eq!(status["estimatedCompletionAvailable"], true);
        assert_eq!(status["estimatedRealTimeFactor"], Value::Null);
        assert!(status.get("llmEstimatedTokensPerSecond").is_none());
        assert!(status.get("modelHashes").is_none());
    }

    #[test]
    fn model_latency_cache_exposes_only_real_trusted_benchmark_measurements() {
        let root = test_root("model-latency-cache");
        let service = TranscriptionQualityService::with_hardware(
            root,
            HardwareCapability::with_memory_gib(16),
        );
        assert!(service.measured_speech_model_latencies_ms().is_empty());

        service
            .record_benchmark(TranscriptionBenchmarkMeasurement {
                tier: TranscriptionBenchmarkTier::Balanced,
                whisper_real_time_factor: 0.25,
                llm_estimated_tokens_per_second: 8.0,
                whisper_model_sha256: trusted_hash(TranscriptionBenchmarkTier::Balanced),
                llm_model_sha256: "b".repeat(64),
            })
            .expect("record trusted local benchmark");

        let measurements = service.measured_speech_model_latencies_ms();
        assert_eq!(measurements.get("large-v3-turbo"), Some(&7_500));
        assert!(!measurements.contains_key("large-v3"));
        assert!(!measurements.contains_key("small.en"));
    }

    #[test]
    fn benchmark_does_not_override_an_explicit_fast_selection() {
        let root = test_root("explicit-fast");
        let service = TranscriptionQualityService::with_hardware(
            root,
            HardwareCapability::with_memory_gib(16),
        );
        service
            .update(TranscriptionQualityUpdateParams {
                tier: TranscriptionTier::Fast,
                language_preference: None,
            })
            .expect("save explicit fast preference");
        service
            .record_benchmark(TranscriptionBenchmarkMeasurement {
                tier: TranscriptionBenchmarkTier::Balanced,
                whisper_real_time_factor: 0.25,
                llm_estimated_tokens_per_second: 8.0,
                whisper_model_sha256: trusted_hash(TranscriptionBenchmarkTier::Balanced),
                llm_model_sha256: "c".repeat(64),
            })
            .expect("record balanced benchmark");
        let status = service.status();
        assert_eq!(status["tier"], "fast");
        assert_eq!(status["recommendedTier"], "balanced");
        assert_eq!(status["estimatedMinutesPerHour"], Value::Null);
    }

    #[test]
    fn slow_or_untrusted_benchmark_evidence_fails_closed() {
        let root = test_root("slow-balanced");
        let service = TranscriptionQualityService::with_hardware(
            root,
            HardwareCapability::with_memory_gib(32),
        );
        let result = service
            .record_benchmark(TranscriptionBenchmarkMeasurement {
                tier: TranscriptionBenchmarkTier::Balanced,
                whisper_real_time_factor: 0.75,
                llm_estimated_tokens_per_second: 4.0,
                whisper_model_sha256: trusted_hash(TranscriptionBenchmarkTier::Balanced),
                llm_model_sha256: "d".repeat(64),
            })
            .expect("record slow benchmark");
        assert_eq!(result["passed"], false);
        assert_eq!(service.status()["recommendedTier"], "fast");

        let error = service
            .record_benchmark(TranscriptionBenchmarkMeasurement {
                tier: TranscriptionBenchmarkTier::Maximum,
                whisper_real_time_factor: 0.5,
                llm_estimated_tokens_per_second: 4.0,
                whisper_model_sha256: "f".repeat(64),
                llm_model_sha256: "e".repeat(64),
            })
            .expect_err("unverified evidence must fail");
        assert_eq!(error.code, "TRANSCRIPTION_BENCHMARK_MODEL_TRUST_MISMATCH");
    }

    #[test]
    fn trusted_model_revision_change_invalidates_old_benchmark_evidence() {
        let hardware = HardwareCapability::with_memory_gib(32);
        let stale = BenchmarkEvidence {
            state: "measured".to_string(),
            balanced_passed: true,
            balanced_model_sha256: Some("0".repeat(64)),
            ..BenchmarkEvidence::default()
        };
        let evaluation = evaluate_tier(TranscriptionTier::Balanced, &hardware, &stale);
        assert!(!evaluation.available);
        assert_eq!(
            evaluation.guard_reason,
            Some("balanced-requires-fresh-local-benchmark-for-current-model")
        );
    }

    #[test]
    fn first_benchmark_failure_is_persisted_without_unlocking_balanced() {
        let root = test_root("failure");
        let service = TranscriptionQualityService::with_hardware(
            root,
            HardwareCapability::with_memory_gib(16),
        );
        service
            .record_benchmark_failure(
                TranscriptionBenchmarkTier::Balanced,
                "TRANSCRIPTION_BENCHMARK_ENGINE_UNAVAILABLE",
            )
            .expect("record failure");
        let status = service.status();
        assert_eq!(status["benchmarkState"], "failed");
        assert_eq!(
            status["benchmarkFailureCode"],
            "TRANSCRIPTION_BENCHMARK_ENGINE_UNAVAILABLE"
        );
        assert_eq!(status["benchmarkFailureTier"], "balanced");
        assert_eq!(status["recommendedTier"], "fast");
    }

    #[test]
    fn policy_round_trip_is_durable() {
        let root = test_root("round-trip");
        let hardware = HardwareCapability::with_memory_gib(16);
        let service = TranscriptionQualityService::with_hardware(root.clone(), hardware.clone());
        service
            .update(TranscriptionQualityUpdateParams {
                tier: TranscriptionTier::Fast,
                language_preference: Some(LanguagePreference::English),
            })
            .expect("write policy");
        let reopened = TranscriptionQualityService::with_hardware(root, hardware);
        assert_eq!(
            reopened.resolve().expect("reopen").tier,
            TranscriptionTier::Fast
        );
    }

    #[test]
    fn corrupt_policy_is_not_overwritten_or_silently_used() {
        let root = test_root("corrupt");
        fs::create_dir_all(&root).expect("create root");
        let path = root.join(POLICY_FILE);
        fs::write(&path, b"not-json").expect("seed corruption");
        let before = fs::read(&path).expect("read before");
        let service = TranscriptionQualityService::with_hardware(
            root,
            HardwareCapability::with_memory_gib(16),
        );
        let error = service
            .resolve()
            .expect_err("corrupt settings must fail closed");
        assert_eq!(error.code, "TRANSCRIPTION_QUALITY_CORRUPT");
        assert_eq!(fs::read(&path).expect("read after"), before);
        assert_eq!(service.status()["state"], "corrupt");
    }
}
