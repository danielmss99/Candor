use std::collections::HashSet;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::bundled_ai_assets::BundledAiAssets;
use crate::local_instruct_assets::load_runtime_config;
use crate::local_model_scheduler::{
    LocalModelJobKind, LocalModelScheduler, LocalModelSchedulerError,
};
use crate::recording_store::{RecordingIdParams, RecordingStore, RecordingStoreError};

const BINARY_ENV: &str = "CANDOR_LOCAL_LLM_BINARY";
const BINARY_SHA256_ENV: &str = "CANDOR_LOCAL_LLM_BINARY_SHA256";
const MODEL_ENV: &str = "CANDOR_LOCAL_LLM_MODEL";
const MODEL_SHA256_ENV: &str = "CANDOR_LOCAL_LLM_MODEL_SHA256";
const CONTEXT_TOKENS_ENV: &str = "CANDOR_LOCAL_LLM_CONTEXT_TOKENS";
const DEFAULT_CONTEXT_TOKENS: u32 = 4096;
const DEFAULT_MAX_TOKENS: u32 = 512;
const MAX_TOKENS_LIMIT: u32 = 2_048;
const MAX_PROMPT_BYTES: usize = 24 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_STDERR_BYTES: usize = 2 * 1024 * 1024;
const MAX_QUESTION_BYTES: usize = 500;
const MAX_SEGMENTS_IN_PROMPT: usize = 80;
const MAX_SEGMENT_TEXT_CHARS: usize = 220;
const LOCAL_LLM_TIMEOUT_MS: u64 = 45_000;
const LLAMA_CLI_SUBPROCESS_FLAGS: [&str; 3] = ["--single-turn", "--simple-io", "--log-disable"];
const LLAMA_COMPLETION_SUBPROCESS_FLAGS: [&str; 3] =
    ["--conversation", "--single-turn", "--simple-io"];
const LLAMA_OUTPUT_BOUNDARY: &str = "CANDOR_GENERATED_RESPONSE_START";

#[derive(Debug)]
pub struct LocalInstructError {
    pub code: &'static str,
    pub message: String,
}

impl LocalInstructError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<RecordingStoreError> for LocalInstructError {
    fn from(error: RecordingStoreError) -> Self {
        Self::new(error.code, error.message)
    }
}

impl From<LocalModelSchedulerError> for LocalInstructError {
    fn from(error: LocalModelSchedulerError) -> Self {
        Self::new(error.code, error.message)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInstructRecapParams {
    pub recording_id: String,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInstructAskParams {
    pub recording_id: String,
    pub question: String,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Debug)]
struct PromptSegment {
    citation_id: String,
    segment_index: u64,
    channel: String,
    speaker: String,
    text: String,
    start_ms: u64,
}

#[derive(Debug)]
struct LocalLlmRun {
    output: String,
    output_bytes: usize,
    exit_code: Option<i32>,
    prompt_bytes: usize,
    prompt_deleted_after_run: bool,
}

struct GroundedModelOutput {
    output: String,
    citations_added: usize,
    unsupported_claims_removed: usize,
}

#[derive(Clone, Debug, Default)]
struct LocalInstructModelConfig {
    binary_path: Option<PathBuf>,
    model_path: Option<PathBuf>,
    expected_binary_sha256: Option<String>,
    expected_model_sha256: Option<String>,
    verified_binary_sha256: Option<String>,
    verified_model_sha256: Option<String>,
    binary_fingerprint_verified: bool,
    model_fingerprint_verified: bool,
    context_tokens: Option<u32>,
    configuration_source: String,
    managed_manifest_present: bool,
    bundled_manifest_present: bool,
}

#[derive(Clone, Copy, Debug)]
struct FailureReasonContext {
    binary_configured: bool,
    model_configured: bool,
    binary_exists: bool,
    model_exists: bool,
    binary_hash_required: bool,
    model_hash_required: bool,
    expected_binary_hash_valid: bool,
    expected_model_hash_valid: bool,
    binary_hash_read_error: bool,
    model_hash_read_error: bool,
    binary_hash_matched: bool,
    model_hash_matched: bool,
}

impl LocalInstructModelConfig {
    fn from_env() -> Self {
        Self {
            binary_path: env_path(BINARY_ENV),
            model_path: env_path(MODEL_ENV),
            expected_binary_sha256: env_value(BINARY_SHA256_ENV),
            expected_model_sha256: env_value(MODEL_SHA256_ENV),
            verified_binary_sha256: None,
            verified_model_sha256: None,
            binary_fingerprint_verified: false,
            model_fingerprint_verified: false,
            context_tokens: env_value(CONTEXT_TOKENS_ENV)
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|value| *value > 0),
            configuration_source: "environment".to_string(),
            managed_manifest_present: false,
            bundled_manifest_present: false,
        }
    }

    fn from_sources(asset_root: &Path, bundled_assets: &BundledAiAssets) -> Self {
        let env_config = Self::from_env();
        let managed = load_runtime_config(asset_root);
        let bundled_status = bundled_assets.status();
        let bundled = bundled_assets.language_config().ok().flatten();
        let binary_from_managed = managed.binary_path.is_some();
        let model_from_managed = managed.model_path.is_some();
        let binary_from_bundled = !binary_from_managed && bundled.is_some();
        let model_from_bundled = !model_from_managed && bundled.is_some();
        let binary_from_env =
            !binary_from_managed && !binary_from_bundled && env_config.binary_path.is_some();
        let model_from_env =
            !model_from_managed && !model_from_bundled && env_config.model_path.is_some();
        let managed_used = binary_from_managed || model_from_managed;
        let bundled_used = binary_from_bundled || model_from_bundled;
        let environment_used = binary_from_env || model_from_env;
        let configuration_source = match (managed_used, bundled_used, environment_used) {
            (true, false, false) => "managed-local-assets",
            (false, true, false) => "bundled-package",
            (false, false, true) => "environment",
            (false, false, false) => "none",
            _ => "mixed",
        };
        let bundled_binary_path = bundled.as_ref().map(|value| value.runtime.path.clone());
        let bundled_model_path = bundled.as_ref().map(|value| value.model.path.clone());
        let bundled_binary_sha = bundled.as_ref().map(|value| value.runtime.sha256.clone());
        let bundled_model_sha = bundled.as_ref().map(|value| value.model.sha256.clone());
        let bundled_context_tokens = bundled
            .as_ref()
            .and_then(|value| value.model.context_tokens);

        Self {
            binary_path: managed
                .binary_path
                .or(bundled_binary_path)
                .or(env_config.binary_path),
            model_path: managed
                .model_path
                .or(bundled_model_path)
                .or(env_config.model_path),
            expected_binary_sha256: managed
                .expected_binary_sha256
                .or(bundled_binary_sha.clone())
                .or(env_config.expected_binary_sha256),
            expected_model_sha256: managed
                .expected_model_sha256
                .or(bundled_model_sha.clone())
                .or(env_config.expected_model_sha256),
            verified_binary_sha256: managed.verified_binary_sha256.or(bundled_binary_sha),
            verified_model_sha256: managed.verified_model_sha256.or(bundled_model_sha),
            binary_fingerprint_verified: managed.binary_fingerprint_verified || binary_from_bundled,
            model_fingerprint_verified: managed.model_fingerprint_verified || model_from_bundled,
            context_tokens: if managed.manifest_present {
                managed.context_tokens
            } else if bundled_used {
                bundled_context_tokens
            } else {
                env_config.context_tokens
            },
            configuration_source: configuration_source.to_string(),
            managed_manifest_present: managed.manifest_present,
            bundled_manifest_present: bundled_status
                .get("manifestVersion")
                .is_some_and(Value::is_number),
        }
    }
}

#[derive(Clone)]
pub struct LocalInstructModelService {
    asset_root: PathBuf,
    bundled_assets: BundledAiAssets,
}

impl LocalInstructModelService {
    pub fn with_sources(asset_root: PathBuf, bundled_assets: BundledAiAssets) -> Self {
        Self {
            asset_root,
            bundled_assets,
        }
    }

    fn config(&self) -> LocalInstructModelConfig {
        LocalInstructModelConfig::from_sources(&self.asset_root, &self.bundled_assets)
    }

    pub fn status(&self, scheduler: &LocalModelScheduler) -> Value {
        Self::status_for_config(self.config(), scheduler)
    }

    pub fn recap(
        &self,
        store: &RecordingStore,
        scheduler: &mut LocalModelScheduler,
        params: LocalInstructRecapParams,
    ) -> Result<Value, LocalInstructError> {
        let transcript = store.transcript(RecordingIdParams {
            recording_id: params.recording_id,
        })?;
        let segments = prompt_segments(&transcript);
        if segments.is_empty() {
            return Err(LocalInstructError::new(
                "LOCAL_LLM_TRANSCRIPT_EMPTY",
                "local instruct recap requires at least one transcript segment",
            ));
        }
        let prompt = build_recap_prompt(&transcript, &segments)?;
        let max_tokens = normalize_max_tokens(params.max_tokens)?;
        let run = self.run_prompt(scheduler, "local-instruct.recap", &prompt, max_tokens)?;

        Ok(local_instruct_response(
            &transcript,
            &segments,
            "recap",
            None,
            run,
        ))
    }

    pub fn ask(
        &self,
        store: &RecordingStore,
        scheduler: &mut LocalModelScheduler,
        params: LocalInstructAskParams,
    ) -> Result<Value, LocalInstructError> {
        let question = normalize_question(params.question)?;
        let transcript = store.transcript(RecordingIdParams {
            recording_id: params.recording_id,
        })?;
        let segments = prompt_segments(&transcript);
        if segments.is_empty() {
            return Err(LocalInstructError::new(
                "LOCAL_LLM_TRANSCRIPT_EMPTY",
                "local instruct Ask requires at least one transcript segment",
            ));
        }
        let prompt = build_ask_prompt(&transcript, &segments, &question)?;
        let max_tokens = normalize_max_tokens(params.max_tokens)?;
        let run = self.run_prompt(scheduler, "local-instruct.ask", &prompt, max_tokens)?;

        Ok(local_instruct_response(
            &transcript,
            &segments,
            "ask",
            Some(question),
            run,
        ))
    }

    pub fn proof_preflight(&self, scheduler: &mut LocalModelScheduler) -> Value {
        Self::proof_preflight_for_config(self.config(), scheduler)
    }

    fn run_prompt(
        &self,
        scheduler: &mut LocalModelScheduler,
        owner: &'static str,
        prompt: &str,
        max_tokens: u32,
    ) -> Result<LocalLlmRun, LocalInstructError> {
        let config = self.config();
        ensure_ready(&config, scheduler)?;
        let job_id = scheduler.start_job(LocalModelJobKind::Llm, owner)?;
        let result = run_prompt_with_config(config, prompt, max_tokens);
        scheduler.finish_job(job_id);
        result
    }

    fn proof_preflight_for_config(
        config: LocalInstructModelConfig,
        scheduler: &mut LocalModelScheduler,
    ) -> Value {
        let status = Self::status_for_config(config, scheduler);
        let mut scheduler_reservation_ok = false;
        let mut scheduler_denied_code = None;
        let mut scheduler_denied_message = None;

        match scheduler.start_job(LocalModelJobKind::Llm, "local-instruct.preflight") {
            Ok(job_id) => {
                scheduler_reservation_ok = true;
                scheduler.finish_job(job_id);
            }
            Err(error) => {
                scheduler_denied_code = Some(error.code);
                scheduler_denied_message = Some(error.message);
            }
        }

        json!({
            "proofKind": "m4-local-instruct-preflight",
            "proof": {
                "synthetic": true,
                "engine": "llama-cpp-local",
                "backend": "external-llama-cpp-binary",
                "localOnly": true,
                "cloudAi": false,
                "networkAttempted": false,
                "downloadsAttempted": false,
                "backgroundDownloads": false,
                "schedulerReservationAttempted": true,
                "schedulerReservationOk": scheduler_reservation_ok,
                "schedulerReservationDeniedCode": scheduler_denied_code,
                "schedulerReservationDeniedMessage": scheduler_denied_message,
                "whisperLlmConcurrent": false,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            },
            "status": status,
            "statusAfterProof": scheduler.status(),
            "ready": status.get("ready").cloned().unwrap_or(Value::Bool(false)),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    fn status_for_config(
        config: LocalInstructModelConfig,
        scheduler: &LocalModelScheduler,
    ) -> Value {
        let binary_configured = config.binary_path.is_some();
        let model_configured = config.model_path.is_some();
        let binary_exists = config
            .binary_path
            .as_ref()
            .is_some_and(|path| path.is_file());
        let model_exists = config
            .model_path
            .as_ref()
            .is_some_and(|path| path.is_file());
        let binary_bytes = config
            .binary_path
            .as_ref()
            .and_then(|path| fs::metadata(path).ok())
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len());
        let model_bytes = config
            .model_path
            .as_ref()
            .and_then(|path| fs::metadata(path).ok())
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len());
        let expected_binary_hash = config.expected_binary_sha256.as_deref();
        let expected_model_hash = config.expected_model_sha256.as_deref();
        let binary_hash_required = expected_binary_hash.is_some();
        let model_hash_required = expected_model_hash.is_some();
        let expected_binary_hash_valid = expected_binary_hash.is_none_or(is_sha256_hex);
        let expected_model_hash_valid = expected_model_hash.is_none_or(is_sha256_hex);

        let binary_hash_cached = config.binary_fingerprint_verified
            && expected_binary_hash
                .zip(config.verified_binary_sha256.as_deref())
                .is_some_and(|(expected, actual)| expected.eq_ignore_ascii_case(actual));
        let model_hash_cached = config.model_fingerprint_verified
            && expected_model_hash
                .zip(config.verified_model_sha256.as_deref())
                .is_some_and(|(expected, actual)| expected.eq_ignore_ascii_case(actual));
        let mut binary_sha256 = if binary_hash_cached {
            config.verified_binary_sha256.clone()
        } else {
            None
        };
        let mut model_sha256 = if model_hash_cached {
            config.verified_model_sha256.clone()
        } else {
            None
        };
        let mut binary_hash_read_error = false;
        let mut model_hash_read_error = false;
        if binary_sha256.is_none()
            && binary_exists
            && binary_hash_required
            && expected_binary_hash_valid
        {
            match sha256_file(config.binary_path.as_ref().expect("checked binary path")) {
                Ok(hash) => binary_sha256 = Some(hash),
                Err(_) => binary_hash_read_error = true,
            }
        }
        if model_sha256.is_none()
            && model_exists
            && model_hash_required
            && expected_model_hash_valid
        {
            match sha256_file(config.model_path.as_ref().expect("checked model path")) {
                Ok(hash) => model_sha256 = Some(hash),
                Err(_) => model_hash_read_error = true,
            }
        }

        let binary_hash_matched = expected_binary_hash
            .zip(binary_sha256.as_deref())
            .is_some_and(|(expected, actual)| expected.eq_ignore_ascii_case(actual));
        let model_hash_matched = expected_model_hash
            .zip(model_sha256.as_deref())
            .is_some_and(|(expected, actual)| expected.eq_ignore_ascii_case(actual));
        let binary_hash_verified = binary_hash_required && binary_hash_matched;
        let model_hash_verified = model_hash_required && model_hash_matched;
        let (failure_code, failure_message) = failure_reason(FailureReasonContext {
            binary_configured,
            model_configured,
            binary_exists,
            model_exists,
            binary_hash_required,
            model_hash_required,
            expected_binary_hash_valid,
            expected_model_hash_valid,
            binary_hash_read_error,
            model_hash_read_error,
            binary_hash_matched,
            model_hash_matched,
        });
        let ready = failure_code.is_none();

        json!({
            "implemented": true,
            "preflightImplemented": true,
            "generationImplemented": true,
            "askImplemented": true,
            "recapImplemented": true,
            "localOnly": true,
            "cloudAi": false,
            "engine": "llama-cpp-local",
            "backend": "external-llama-cpp-binary",
            "downloadPolicy": "manual-install-only",
            "backgroundDownloads": false,
            "bundledDefaultsSupported": true,
            "promptTransport": "local-temp-prompt-file",
            "promptPathExposed": false,
            "promptDeletedAfterRun": true,
            "modelRequired": true,
            "configuration": {
                "source": config.configuration_source,
                "managedManifestPresent": config.managed_manifest_present,
                "bundledManifestPresent": config.bundled_manifest_present,
                "binaryEnv": BINARY_ENV,
                "binarySha256Env": BINARY_SHA256_ENV,
                "modelEnv": MODEL_ENV,
                "modelSha256Env": MODEL_SHA256_ENV,
                "contextTokensEnv": CONTEXT_TOKENS_ENV,
                "rawValuesExposed": false
            },
            "binaryConfigured": binary_configured,
            "binaryExists": binary_exists,
            "binaryBytes": binary_bytes,
            "binaryHashRequired": binary_hash_required,
            "binaryHashVerified": binary_hash_verified,
            "binaryHashMatched": binary_hash_matched,
            "binaryHashVerificationCached": binary_hash_cached,
            "binarySha256": binary_sha256,
            "modelConfigured": model_configured,
            "modelExists": model_exists,
            "modelBytes": model_bytes,
            "modelHashRequired": model_hash_required,
            "modelHashVerified": model_hash_verified,
            "modelHashMatched": model_hash_matched,
            "modelHashVerificationCached": model_hash_cached,
            "modelSha256": model_sha256,
            "contextTokens": config.context_tokens.unwrap_or(DEFAULT_CONTEXT_TOKENS),
            "ready": ready,
            "failureCode": failure_code,
            "failureMessage": failure_message,
            "scheduler": scheduler.status(),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }
}

fn ensure_ready(
    config: &LocalInstructModelConfig,
    scheduler: &LocalModelScheduler,
) -> Result<(), LocalInstructError> {
    let status = LocalInstructModelService::status_for_config(config.clone(), scheduler);
    if status
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }
    let code = status
        .get("failureCode")
        .and_then(Value::as_str)
        .unwrap_or("LOCAL_LLM_NOT_READY");
    let message = status
        .get("failureMessage")
        .and_then(Value::as_str)
        .unwrap_or("local instruct model is not ready");
    Err(LocalInstructError::new(failure_code(code), message))
}

fn failure_code(code: &str) -> &'static str {
    match code {
        "LOCAL_LLM_BINARY_NOT_CONFIGURED" => "LOCAL_LLM_BINARY_NOT_CONFIGURED",
        "LOCAL_LLM_MODEL_NOT_CONFIGURED" => "LOCAL_LLM_MODEL_NOT_CONFIGURED",
        "LOCAL_LLM_BINARY_NOT_FOUND" => "LOCAL_LLM_BINARY_NOT_FOUND",
        "LOCAL_LLM_MODEL_NOT_FOUND" => "LOCAL_LLM_MODEL_NOT_FOUND",
        "LOCAL_LLM_BINARY_HASH_NOT_CONFIGURED" => "LOCAL_LLM_BINARY_HASH_NOT_CONFIGURED",
        "LOCAL_LLM_MODEL_HASH_NOT_CONFIGURED" => "LOCAL_LLM_MODEL_HASH_NOT_CONFIGURED",
        "LOCAL_LLM_BINARY_HASH_INVALID" => "LOCAL_LLM_BINARY_HASH_INVALID",
        "LOCAL_LLM_MODEL_HASH_INVALID" => "LOCAL_LLM_MODEL_HASH_INVALID",
        "LOCAL_LLM_BINARY_HASH_UNREADABLE" => "LOCAL_LLM_BINARY_HASH_UNREADABLE",
        "LOCAL_LLM_MODEL_HASH_UNREADABLE" => "LOCAL_LLM_MODEL_HASH_UNREADABLE",
        "LOCAL_LLM_BINARY_HASH_MISMATCH" => "LOCAL_LLM_BINARY_HASH_MISMATCH",
        "LOCAL_LLM_MODEL_HASH_MISMATCH" => "LOCAL_LLM_MODEL_HASH_MISMATCH",
        _ => "LOCAL_LLM_NOT_READY",
    }
}

fn run_prompt_with_config(
    config: LocalInstructModelConfig,
    prompt: &str,
    max_tokens: u32,
) -> Result<LocalLlmRun, LocalInstructError> {
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(LocalInstructError::new(
            "LOCAL_LLM_PROMPT_TOO_LARGE",
            format!("local instruct prompt exceeds {MAX_PROMPT_BYTES} byte limit"),
        ));
    }

    let prompt = prepare_prompt_for_runner(prompt, config.binary_path.as_deref())?;
    let prompt_path = write_prompt_file(&prompt)?;
    let command_result = run_llama_command(&config, &prompt_path, max_tokens);
    let prompt_deleted_after_run = fs::remove_file(&prompt_path).is_ok();
    if !prompt_deleted_after_run {
        return Err(LocalInstructError::new(
            "LOCAL_LLM_PROMPT_DELETE_FAILED",
            "local instruct prompt file could not be deleted after the run",
        ));
    }

    let mut run = command_result?;
    run.prompt_deleted_after_run = prompt_deleted_after_run;

    if let Some(kind) = sensitive_path_kind(&run.output, &config, Some(&prompt_path)) {
        return Err(LocalInstructError::new(
            "LOCAL_LLM_OUTPUT_PATH_EXPOSURE",
            format!("local instruct output included the raw {kind} path and was withheld"),
        ));
    }
    Ok(run)
}

fn write_prompt_file(prompt: &str) -> Result<PathBuf, LocalInstructError> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);

    for attempt in 0..16_u8 {
        let path = env::temp_dir().join(format!(
            "candor-local-instruct-{}-{stamp}-{attempt}.prompt.txt",
            process::id()
        ));
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                return Err(LocalInstructError::new(
                    "LOCAL_LLM_PROMPT_WRITE_FAILED",
                    "local instruct prompt file could not be written",
                ));
            }
        };
        if file.write_all(prompt.as_bytes()).is_err() {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(LocalInstructError::new(
                "LOCAL_LLM_PROMPT_WRITE_FAILED",
                "local instruct prompt file could not be written",
            ));
        }
        return Ok(path);
    }

    Err(LocalInstructError::new(
        "LOCAL_LLM_PROMPT_WRITE_FAILED",
        "local instruct prompt file could not be created safely",
    ))
}

fn is_llama_completion_frontend(binary_path: &Path) -> bool {
    binary_path
        .file_stem()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("llama-completion"))
}

fn prepare_prompt_for_runner(
    prompt: &str,
    binary_path: Option<&Path>,
) -> Result<String, LocalInstructError> {
    if binary_path.is_some_and(is_llama_completion_frontend) {
        return Ok(prompt.to_string());
    }
    let framed = format!("{prompt}\n{LLAMA_OUTPUT_BOUNDARY}\n");
    if framed.len() > MAX_PROMPT_BYTES {
        return Err(LocalInstructError::new(
            "LOCAL_LLM_PROMPT_TOO_LARGE",
            format!("local instruct prompt exceeds {MAX_PROMPT_BYTES} byte limit"),
        ));
    }
    Ok(framed)
}

fn run_llama_command(
    config: &LocalInstructModelConfig,
    prompt_path: &Path,
    max_tokens: u32,
) -> Result<LocalLlmRun, LocalInstructError> {
    let binary_path = config.binary_path.as_ref().ok_or_else(|| {
        LocalInstructError::new(
            "LOCAL_LLM_BINARY_NOT_CONFIGURED",
            "Configure a local llama.cpp-compatible binary before enabling instruct models.",
        )
    })?;
    let model_path = config.model_path.as_ref().ok_or_else(|| {
        LocalInstructError::new(
            "LOCAL_LLM_MODEL_NOT_CONFIGURED",
            "Configure a local GGUF model before enabling instruct models.",
        )
    })?;
    let context_tokens = config.context_tokens.unwrap_or(DEFAULT_CONTEXT_TOKENS);
    let max_tokens = max_tokens.to_string();
    let context_tokens = context_tokens.to_string();
    let completion_frontend = is_llama_completion_frontend(binary_path);
    let subprocess_flags: &[&str] = if completion_frontend {
        &LLAMA_COMPLETION_SUBPROCESS_FLAGS
    } else {
        &LLAMA_CLI_SUBPROCESS_FLAGS
    };

    let mut child = Command::new(binary_path)
        .arg("-m")
        .arg(model_path)
        .arg("-f")
        .arg(prompt_path)
        .arg("-n")
        .arg(&max_tokens)
        .arg("-c")
        .arg(&context_tokens)
        .arg("--temp")
        .arg("0.2")
        .arg("--no-display-prompt")
        .args(subprocess_flags)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| {
            LocalInstructError::new(
                "LOCAL_LLM_COMMAND_SPAWN_FAILED",
                "local instruct model command could not be started",
            )
        })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut stdout_reader = Some(thread::spawn(move || {
        read_child_pipe_limited(
            stdout,
            MAX_OUTPUT_BYTES,
            "LOCAL_LLM_OUTPUT_TOO_LARGE",
            "local instruct output",
        )
    }));
    let mut stderr_reader = Some(thread::spawn(move || {
        read_child_pipe_limited(
            stderr,
            MAX_STDERR_BYTES,
            "LOCAL_LLM_STDERR_TOO_LARGE",
            "local instruct diagnostics",
        )
    }));

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = join_child_pipe(stdout_reader.take(), "stdout")?;
                let stderr = join_child_pipe(stderr_reader.take(), "stderr")?;
                if !status.success() {
                    return Err(LocalInstructError::new(
                        "LOCAL_LLM_COMMAND_FAILED",
                        format!(
                            "local instruct model command exited with code {}",
                            status.code().unwrap_or(-1)
                        ),
                    ));
                }
                let stdout = if completion_frontend {
                    stdout.trim().to_string()
                } else {
                    extract_llama_generated_output(&stdout)
                };
                let stdout = clean_model_generated_output(&stdout);
                if stdout.trim().is_empty() {
                    return Err(LocalInstructError::new(
                        "LOCAL_LLM_OUTPUT_EMPTY",
                        "local instruct model returned no generated text",
                    ));
                }
                return Ok(LocalLlmRun {
                    output: collapse_spaces_preserve_lines(&stdout),
                    output_bytes: stdout.len(),
                    exit_code: status.code(),
                    prompt_bytes: 0,
                    prompt_deleted_after_run: false,
                }
                .with_prompt_bytes(prompt_path)
                .with_stderr_guard(stderr));
            }
            Ok(None) => {
                if started.elapsed() > Duration::from_millis(LOCAL_LLM_TIMEOUT_MS) {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = join_child_pipe(stdout_reader.take(), "stdout");
                    let _ = join_child_pipe(stderr_reader.take(), "stderr");
                    return Err(LocalInstructError::new(
                        "LOCAL_LLM_COMMAND_TIMEOUT",
                        "local instruct model command exceeded the local timeout",
                    ));
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = join_child_pipe(stdout_reader.take(), "stdout");
                let _ = join_child_pipe(stderr_reader.take(), "stderr");
                return Err(LocalInstructError::new(
                    "LOCAL_LLM_COMMAND_WAIT_FAILED",
                    "local instruct model command could not be monitored",
                ));
            }
        }
    }
}

impl LocalLlmRun {
    fn with_prompt_bytes(mut self, prompt_path: &Path) -> Self {
        self.prompt_bytes = fs::metadata(prompt_path)
            .map(|metadata| metadata.len() as usize)
            .unwrap_or_default();
        self
    }

    fn with_stderr_guard(self, _stderr: String) -> Self {
        self
    }
}

fn join_child_pipe(
    reader: Option<thread::JoinHandle<Result<String, LocalInstructError>>>,
    label: &str,
) -> Result<String, LocalInstructError> {
    let Some(reader) = reader else {
        return Ok(String::new());
    };
    reader.join().map_err(|_| {
        LocalInstructError::new(
            "LOCAL_LLM_OUTPUT_READER_FAILED",
            format!("local instruct {label} reader thread failed"),
        )
    })?
}

fn read_child_pipe_limited<T: Read>(
    pipe: Option<T>,
    max_bytes: usize,
    overflow_code: &'static str,
    label: &str,
) -> Result<String, LocalInstructError> {
    let Some(mut pipe) = pipe else {
        return Ok(String::new());
    };
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = pipe.read(&mut buffer).map_err(|_| {
            LocalInstructError::new(
                "LOCAL_LLM_OUTPUT_READ_FAILED",
                format!("{label} could not be read"),
            )
        })?;
        if read == 0 {
            break;
        }
        if output.len().saturating_add(read) > max_bytes {
            return Err(LocalInstructError::new(
                overflow_code,
                format!("{label} exceeds the {max_bytes} byte limit"),
            ));
        }
        output.extend_from_slice(&buffer[..read]);
    }
    String::from_utf8(output).map_err(|_| {
        LocalInstructError::new(
            "LOCAL_LLM_OUTPUT_ENCODING_INVALID",
            format!("{label} was not valid UTF-8"),
        )
    })
}

fn sensitive_path_kind(
    text: &str,
    config: &LocalInstructModelConfig,
    prompt_path: Option<&Path>,
) -> Option<&'static str> {
    let mut paths = Vec::new();
    if let Some(path) = &config.binary_path {
        paths.push(("runner", path.as_path()));
    }
    if let Some(path) = &config.model_path {
        paths.push(("model", path.as_path()));
    }
    if let Some(path) = prompt_path {
        paths.push(("temporary prompt", path));
    }
    paths
        .into_iter()
        .find(|(_, path)| {
            let path = path.to_string_lossy();
            !path.is_empty() && text.contains(path.as_ref())
        })
        .map(|(kind, _)| kind)
}

fn env_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_path(name: &str) -> Option<PathBuf> {
    env_value(name).map(PathBuf::from)
}

fn failure_reason(context: FailureReasonContext) -> (Option<&'static str>, Option<&'static str>) {
    let FailureReasonContext {
        binary_configured,
        model_configured,
        binary_exists,
        model_exists,
        binary_hash_required,
        model_hash_required,
        expected_binary_hash_valid,
        expected_model_hash_valid,
        binary_hash_read_error,
        model_hash_read_error,
        binary_hash_matched,
        model_hash_matched,
    } = context;
    if !binary_configured {
        return (
            Some("LOCAL_LLM_BINARY_NOT_CONFIGURED"),
            Some("Configure a local llama.cpp-compatible binary before enabling instruct models."),
        );
    }
    if !model_configured {
        return (
            Some("LOCAL_LLM_MODEL_NOT_CONFIGURED"),
            Some("Configure a local GGUF model before enabling instruct models."),
        );
    }
    if !binary_exists {
        return (
            Some("LOCAL_LLM_BINARY_NOT_FOUND"),
            Some("The configured local LLM binary was not found."),
        );
    }
    if !model_exists {
        return (
            Some("LOCAL_LLM_MODEL_NOT_FOUND"),
            Some("The configured local GGUF model was not found."),
        );
    }
    if !binary_hash_required {
        return (
            Some("LOCAL_LLM_BINARY_HASH_NOT_CONFIGURED"),
            Some("Configure the trusted SHA-256 for the local llama.cpp binary."),
        );
    }
    if !model_hash_required {
        return (
            Some("LOCAL_LLM_MODEL_HASH_NOT_CONFIGURED"),
            Some("Configure the trusted SHA-256 for the local GGUF model."),
        );
    }
    if !expected_binary_hash_valid {
        return (
            Some("LOCAL_LLM_BINARY_HASH_INVALID"),
            Some("The configured local llama.cpp SHA-256 value is not valid hex."),
        );
    }
    if !expected_model_hash_valid {
        return (
            Some("LOCAL_LLM_MODEL_HASH_INVALID"),
            Some("The configured local GGUF SHA-256 value is not valid hex."),
        );
    }
    if binary_hash_read_error {
        return (
            Some("LOCAL_LLM_BINARY_HASH_UNREADABLE"),
            Some("The configured local llama.cpp binary could not be hashed."),
        );
    }
    if model_hash_read_error {
        return (
            Some("LOCAL_LLM_MODEL_HASH_UNREADABLE"),
            Some("The configured local GGUF model could not be hashed."),
        );
    }
    if !binary_hash_matched {
        return (
            Some("LOCAL_LLM_BINARY_HASH_MISMATCH"),
            Some("The configured local llama.cpp binary hash did not match the expected value."),
        );
    }
    if !model_hash_matched {
        return (
            Some("LOCAL_LLM_MODEL_HASH_MISMATCH"),
            Some("The configured local GGUF model hash did not match the expected value."),
        );
    }
    (None, None)
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn normalize_max_tokens(value: Option<u32>) -> Result<u32, LocalInstructError> {
    let value = value.unwrap_or(DEFAULT_MAX_TOKENS);
    if (1..=MAX_TOKENS_LIMIT).contains(&value) {
        Ok(value)
    } else {
        Err(LocalInstructError::new(
            "LOCAL_LLM_MAX_TOKENS_INVALID",
            format!("maxTokens must be between 1 and {MAX_TOKENS_LIMIT}"),
        ))
    }
}

fn normalize_question(question: String) -> Result<String, LocalInstructError> {
    let question = collapse_spaces(&question);
    if question.is_empty() {
        return Err(LocalInstructError::new(
            "LOCAL_LLM_QUESTION_INVALID",
            "question must not be empty",
        ));
    }
    if question.len() > MAX_QUESTION_BYTES {
        return Err(LocalInstructError::new(
            "LOCAL_LLM_QUESTION_INVALID",
            format!("question exceeds {MAX_QUESTION_BYTES} byte limit"),
        ));
    }
    Ok(question)
}

fn prompt_segments(transcript: &Value) -> Vec<PromptSegment> {
    transcript
        .get("segments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_SEGMENTS_IN_PROMPT)
        .enumerate()
        .filter_map(|(position, segment)| {
            let text = collapse_spaces(segment.get("text").and_then(Value::as_str).unwrap_or(""));
            if text.is_empty() {
                return None;
            }
            let channel = segment
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or("mixed")
                .to_string();
            let speaker = segment
                .get("speaker")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| if channel == "mic" { "Me" } else { "Speaker" })
                .to_string();
            Some(PromptSegment {
                citation_id: format!("s{position}"),
                segment_index: segment
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or(position as u64),
                channel,
                speaker,
                text: trim_to(&text, MAX_SEGMENT_TEXT_CHARS),
                start_ms: segment
                    .get("startMs")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
            })
        })
        .collect()
}

fn build_recap_prompt(
    transcript: &Value,
    segments: &[PromptSegment],
) -> Result<String, LocalInstructError> {
    let mut prompt = base_prompt(transcript);
    prompt.push_str("Use only the transcript below.\n\n");
    append_prompt_segments(&mut prompt, segments);
    prompt.push_str(
        "\nWrite the recap now using the exact Markdown headings Summary, Decisions, Actions, Risks, and Questions at level two. Under each heading, write concise bullets that paraphrase concrete transcript facts rather than copying instruction labels or generic placeholders. Name people, deliverables, deadlines, and consequences when the transcript provides them. End every factual bullet with a valid transcript citation such as [s0], and use at least two different valid citations. Write None under Questions if the transcript contains no open question. Return only the recap and do not write an end-of-text marker.\n",
    );
    finish_prompt(prompt)
}

fn build_ask_prompt(
    transcript: &Value,
    segments: &[PromptSegment],
    question: &str,
) -> Result<String, LocalInstructError> {
    let mut prompt = base_prompt(transcript);
    prompt.push_str("Question: ");
    prompt.push_str(question);
    prompt.push_str("\n\n");
    append_prompt_segments(&mut prompt, segments);
    prompt.push_str(
        "\nAnswer the question now using only the transcript. Return exactly one concise sentence followed by the supporting transcript id in square brackets, for example: Priya validates the installer [s1]. The final characters must be a valid citation like [s1]. Do not write an end-of-text marker.\n",
    );
    finish_prompt(prompt)
}

fn base_prompt(transcript: &Value) -> String {
    let label = transcript
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("Untitled meeting");
    format!(
        "You are Candor's local-only meeting note model. Do not invent facts. The meeting is: {}.\n",
        trim_to(label, 120)
    )
}

fn append_prompt_segments(prompt: &mut String, segments: &[PromptSegment]) {
    prompt.push_str("Transcript:\n");
    for segment in segments {
        prompt.push_str(&format!(
            "[{} | {} ms | {} | {}] {}\n",
            segment.citation_id, segment.start_ms, segment.channel, segment.speaker, segment.text
        ));
    }
}

fn finish_prompt(prompt: String) -> Result<String, LocalInstructError> {
    if prompt.len() <= MAX_PROMPT_BYTES {
        Ok(prompt)
    } else {
        Err(LocalInstructError::new(
            "LOCAL_LLM_PROMPT_TOO_LARGE",
            format!("local instruct prompt exceeds {MAX_PROMPT_BYTES} byte limit"),
        ))
    }
}

fn local_instruct_response(
    transcript: &Value,
    segments: &[PromptSegment],
    mode: &str,
    question: Option<String>,
    run: LocalLlmRun,
) -> Value {
    let grounded = ground_model_output(&run.output, segments);
    let citation_positions = cited_segment_positions(&grounded.output);
    let citations = citation_positions
        .iter()
        .filter_map(|position| segments.get(*position))
        .map(citation_value)
        .collect::<Vec<_>>();
    let citations_verified = !citations.is_empty();
    let recording_id = transcript
        .get("recordingId")
        .cloned()
        .unwrap_or(Value::Null);
    let label = transcript.get("label").cloned().unwrap_or(Value::Null);
    let citations_added = grounded.citations_added;
    let unsupported_claims_removed = grounded.unsupported_claims_removed;
    let output = grounded.output;
    let output_bytes = output.len();

    json!({
        "recordingId": recording_id,
        "label": label,
        "question": question,
        "engine": "llama-cpp-local",
        "backend": "external-llama-cpp-binary",
        "mode": mode,
        "answer": if mode == "ask" { Value::String(output.clone()) } else { Value::Null },
        "recapMarkdown": if mode == "recap" { Value::String(output.clone()) } else { Value::Null },
        "output": output,
        "outputBytes": output_bytes,
        "rawModelOutputBytes": run.output_bytes,
        "exitCode": run.exit_code,
        "promptBytes": run.prompt_bytes,
        "promptTransport": "local-temp-prompt-file",
        "promptPathExposed": false,
        "promptDeletedAfterRun": run.prompt_deleted_after_run,
        "modelRequired": true,
        "localOnly": true,
        "cloudAi": false,
        "networkAttempted": false,
        "downloadsAttempted": false,
        "citationMode": "core-grounded-bare-or-rich-bracketed-transcript-ids",
        "citationsVerifiedFromOutput": citations_verified,
        "citations": citations,
        "groundingMethod": "core-lexical-overlap-speaker-aware",
        "modelOutputGrounded": true,
        "citationsAddedByCore": citations_added,
        "unsupportedClaimsRemoved": unsupported_claims_removed,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn ground_model_output(output: &str, segments: &[PromptSegment]) -> GroundedModelOutput {
    let mut lines = Vec::new();
    let mut citations_added = 0;
    let mut unsupported_claims_removed = 0;

    for raw_line in output.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            if lines.last().is_some_and(|line: &String| !line.is_empty()) {
                lines.push(String::new());
            }
            continue;
        }
        if is_output_heading(line) {
            lines.push(strip_segment_citations(line).trim().to_string());
            continue;
        }

        let (prefix, content) = if let Some(content) = line.strip_prefix("- ") {
            ("- ", content)
        } else if let Some(content) = line.strip_prefix("* ") {
            ("- ", content)
        } else {
            ("", line)
        };
        if is_none_claim(content) {
            lines.push(format!("{prefix}None"));
            continue;
        }

        let units = if prefix.is_empty() {
            split_claim_sentences(content)
        } else {
            vec![content.to_string()]
        };
        let mut grounded_units = Vec::new();
        for unit in units {
            let claim = strip_segment_citations(&unit);
            let claim = claim.trim();
            if claim.is_empty() || is_none_claim(claim) {
                continue;
            }
            if let Some(segment) = best_grounding_segment(claim, segments) {
                grounded_units.push(format!("{claim} [{}]", segment.citation_id));
                citations_added += 1;
            } else {
                unsupported_claims_removed += 1;
            }
        }
        if grounded_units.is_empty() {
            continue;
        }
        if prefix.is_empty() {
            lines.push(grounded_units.join(" "));
        } else {
            lines.push(format!("{prefix}{}", grounded_units.join(" ")));
        }
    }

    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    GroundedModelOutput {
        output: lines.join("\n"),
        citations_added,
        unsupported_claims_removed,
    }
}

fn is_output_heading(line: &str) -> bool {
    line.starts_with('#')
        || (line.len() <= 80
            && line.starts_with("**")
            && (line.ends_with("**") || line.ends_with(":**")))
}

fn is_none_claim(claim: &str) -> bool {
    matches!(
        claim
            .trim()
            .trim_matches(|character: char| !character.is_ascii_alphabetic())
            .to_ascii_lowercase()
            .as_str(),
        "none" | "no open questions"
    )
}

fn split_claim_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut start = 0;
    for (index, character) in text.char_indices() {
        if !matches!(character, '.' | '?' | '!') {
            continue;
        }
        let end = index + character.len_utf8();
        if text[end..].chars().next().is_none_or(char::is_whitespace) {
            let sentence = text[start..end].trim();
            if !sentence.is_empty() {
                sentences.push(sentence.to_string());
            }
            start = end;
        }
    }
    let remainder = text[start..].trim();
    if !remainder.is_empty() {
        sentences.push(remainder.to_string());
    }
    if sentences.is_empty() {
        vec![text.trim().to_string()]
    } else {
        sentences
    }
}

fn best_grounding_segment<'a>(
    claim: &str,
    segments: &'a [PromptSegment],
) -> Option<&'a PromptSegment> {
    let claim_tokens = grounding_tokens(claim);
    if claim_tokens.len() < 2 {
        return None;
    }
    let mentioned_speakers = segments
        .iter()
        .filter(|segment| text_mentions_speaker(&claim_tokens, &segment.speaker))
        .map(|segment| segment.speaker.to_ascii_lowercase())
        .collect::<HashSet<_>>();

    segments
        .iter()
        .filter_map(|segment| {
            if !mentioned_speakers.is_empty()
                && !mentioned_speakers.contains(&segment.speaker.to_ascii_lowercase())
            {
                return None;
            }
            let segment_tokens = grounding_tokens(&segment.text);
            let score = claim_tokens.intersection(&segment_tokens).count();
            (score >= 2).then_some((score, segment))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, segment)| segment)
}

fn text_mentions_speaker(tokens: &HashSet<String>, speaker: &str) -> bool {
    let speaker_tokens = speaker
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| token.len() >= 3)
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    !speaker_tokens.is_empty() && speaker_tokens.iter().all(|token| tokens.contains(token))
}

fn grounding_tokens(text: &str) -> HashSet<String> {
    text.split(|character: char| !character.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase)
        .filter(|token| token.len() >= 3 && !is_grounding_stopword(token))
        .collect()
}

fn is_grounding_stopword(token: &str) -> bool {
    matches!(
        token,
        "the"
            | "and"
            | "for"
            | "with"
            | "from"
            | "that"
            | "this"
            | "will"
            | "must"
            | "after"
            | "before"
            | "until"
            | "into"
            | "only"
            | "each"
            | "every"
            | "under"
            | "write"
            | "concise"
            | "fact"
            | "decision"
            | "decisions"
            | "action"
            | "actions"
            | "risk"
            | "risks"
            | "summary"
            | "question"
            | "questions"
            | "owner"
            | "open"
            | "none"
            | "using"
            | "transcript"
    )
}

fn strip_segment_citations(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if let Some((_, end)) = citation_span_at(bytes, index) {
            index = end;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).unwrap_or_else(|_| text.to_string())
}

fn citation_span_at(bytes: &[u8], index: usize) -> Option<(usize, usize)> {
    if index + 3 >= bytes.len() || bytes[index] != b'[' || bytes[index + 1] != b's' {
        return None;
    }
    let mut cursor = index + 2;
    let start = cursor;
    while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
        cursor += 1;
    }
    if cursor == start || cursor >= bytes.len() {
        return None;
    }
    let citation_end = if bytes[cursor] == b']' {
        cursor
    } else if bytes[cursor..].starts_with(b" | ") {
        let offset = bytes[cursor + 3..bytes.len().min(cursor + 160)]
            .iter()
            .position(|byte| *byte == b']' || *byte == b'\n' || *byte == b'\r')?;
        let end = cursor + 3 + offset;
        if bytes[end] != b']' {
            return None;
        }
        end
    } else {
        return None;
    };
    let position = std::str::from_utf8(&bytes[start..cursor])
        .ok()?
        .parse::<usize>()
        .ok()?;
    Some((position, citation_end + 1))
}

fn cited_segment_positions(output: &str) -> Vec<usize> {
    let bytes = output.as_bytes();
    let mut positions = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if let Some((position, end)) = citation_span_at(bytes, index) {
            if !positions.contains(&position) {
                positions.push(position);
            }
            index = end;
        } else {
            index += 1;
        }
    }
    positions
}

fn citation_value(segment: &PromptSegment) -> Value {
    json!({
        "citationId": segment.citation_id,
        "segmentIndex": segment.segment_index,
        "startMs": segment.start_ms,
        "speaker": segment.speaker,
        "channel": segment.channel,
        "quote": trim_to(&segment.text, MAX_SEGMENT_TEXT_CHARS),
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn collapse_spaces(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn collapse_spaces_preserve_lines(text: &str) -> String {
    text.lines()
        .map(collapse_spaces)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_llama_generated_output(output: &str) -> String {
    let framed = output
        .rfind(LLAMA_OUTPUT_BOUNDARY)
        .map(|index| &output[index + LLAMA_OUTPUT_BOUNDARY.len()..])
        .unwrap_or(output);
    let mut end = framed.len();
    for marker in ["\n[ Prompt:", "\nExiting..."] {
        if let Some(index) = framed.find(marker) {
            end = end.min(index);
        }
    }
    framed[..end]
        .trim()
        .trim_start_matches('>')
        .trim()
        .to_string()
}

fn clean_model_generated_output(output: &str) -> String {
    let mut output = output.trim();
    for marker in ["[end of text]", "</s>"] {
        if let Some(stripped) = output.strip_suffix(marker) {
            output = stripped.trim_end();
        }
    }
    output.to_string()
}

fn trim_to(text: &str, max_chars: usize) -> String {
    let cleaned = collapse_spaces(text);
    if cleaned.chars().count() <= max_chars {
        return cleaned;
    }
    let keep = max_chars.saturating_sub(3);
    let mut output = cleaned.chars().take(keep).collect::<String>();
    output.push_str("...");
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        env::temp_dir().join(format!(
            "candor-local-instruct-{label}-{}-{stamp}",
            process::id()
        ))
    }

    #[test]
    fn status_without_config_fails_closed_and_pathless() {
        let scheduler = LocalModelScheduler::default();
        let status = LocalInstructModelService::status_for_config(
            LocalInstructModelConfig::default(),
            &scheduler,
        );

        assert_eq!(status["implemented"], true);
        assert_eq!(status["preflightImplemented"], true);
        assert_eq!(status["generationImplemented"], true);
        assert_eq!(status["ready"], false);
        assert_eq!(status["failureCode"], "LOCAL_LLM_BINARY_NOT_CONFIGURED");
        assert_eq!(status["localOnly"], true);
        assert_eq!(status["cloudAi"], false);
        assert_eq!(status["rawPathExposed"], false);
    }

    #[test]
    fn configured_hash_mismatch_does_not_expose_paths() {
        let root = temp_root("hash-mismatch");
        fs::create_dir_all(&root).expect("create temp root");
        let binary_path = root.join(if cfg!(windows) {
            "llama-cli.exe"
        } else {
            "llama-cli"
        });
        let model_path = root.join("tiny.gguf");
        fs::write(&binary_path, b"binary").expect("write binary");
        fs::write(&model_path, b"not a real model").expect("write model");
        let binary_sha256 = sha256_file(&binary_path).expect("hash binary");

        let scheduler = LocalModelScheduler::default();
        let status = LocalInstructModelService::status_for_config(
            LocalInstructModelConfig {
                binary_path: Some(binary_path),
                model_path: Some(model_path),
                expected_binary_sha256: Some(binary_sha256),
                expected_model_sha256: Some("0".repeat(64)),
                context_tokens: Some(2048),
                ..LocalInstructModelConfig::default()
            },
            &scheduler,
        );
        let serialized = serde_json::to_string(&status).expect("serialize status");

        assert_eq!(status["ready"], false);
        assert_eq!(status["failureCode"], "LOCAL_LLM_MODEL_HASH_MISMATCH");
        assert_eq!(status["modelHashRequired"], true);
        assert_eq!(status["modelHashVerified"], false);
        assert_eq!(status["contextTokens"], 2048);
        assert_eq!(status["rawPathExposed"], false);
        assert!(!serialized.contains(&root.to_string_lossy().to_string()));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preflight_reserves_and_releases_llm_scheduler_job() {
        let mut scheduler = LocalModelScheduler::default();
        let proof = LocalInstructModelService::proof_preflight_for_config(
            LocalInstructModelConfig::default(),
            &mut scheduler,
        );

        assert_eq!(proof["proofKind"], "m4-local-instruct-preflight");
        assert_eq!(proof["proof"]["schedulerReservationAttempted"], true);
        assert_eq!(proof["proof"]["schedulerReservationOk"], true);
        assert_eq!(proof["proof"]["networkAttempted"], false);
        assert_eq!(proof["proof"]["downloadsAttempted"], false);
        assert_eq!(proof["proof"]["whisperLlmConcurrent"], false);
        assert_eq!(proof["statusAfterProof"]["active"], false);
        assert_eq!(proof["rawPathExposed"], false);
    }

    #[test]
    fn prompt_citations_are_parsed_without_duplicates() {
        assert_eq!(
            cited_segment_positions("Decision [s2], then [s2] and [s10]."),
            vec![2, 10]
        );
        assert_eq!(
            cited_segment_positions("Decision [s2 | 3300 ms | system | Morgan], then action [s1]."),
            vec![2, 1]
        );
        assert!(cited_segment_positions("No citation here [sx].").is_empty());
        assert!(cited_segment_positions("Malformed [s2 anything].").is_empty());
    }

    #[test]
    fn core_grounding_adds_evidence_and_removes_wrong_speaker_claims() {
        let segments = vec![
            PromptSegment {
                citation_id: "s0".to_string(),
                segment_index: 0,
                channel: "mic".to_string(),
                speaker: "Alex".to_string(),
                text: "Decision: Candor will ship the local-only recorder after the release checklist is complete.".to_string(),
                start_ms: 0,
            },
            PromptSegment {
                citation_id: "s1".to_string(),
                segment_index: 1,
                channel: "system".to_string(),
                speaker: "Priya".to_string(),
                text: "Action: Priya must validate the Windows installer signature and offline replay before Friday.".to_string(),
                start_ms: 1600,
            },
            PromptSegment {
                citation_id: "s2".to_string(),
                segment_index: 2,
                channel: "system".to_string(),
                speaker: "Morgan".to_string(),
                text: "Risk: if crash recovery loses more than one audio chunk, the release must be blocked.".to_string(),
                start_ms: 3300,
            },
        ];
        let output = ground_model_output(
            "**Summary:**\nCandor ships the local-only recorder after the release checklist. Priya validates the Windows installer signature and offline replay before Friday.\n**Actions:**\n- Priya validates the installer signature and offline replay.\n- Morgan validates the installer signature and offline replay.\n**Risks:**\n- Crash recovery losing more than one audio chunk blocks release.",
            &segments,
        );

        assert!(output.output.contains("checklist. [s0]"));
        assert!(output.output.contains("Friday. [s1]"));
        assert!(output.output.contains("blocks release. [s2]"));
        assert!(!output.output.contains("Morgan validates"));
        assert!(output.citations_added >= 4);
        assert_eq!(output.unsupported_claims_removed, 1);
        assert_eq!(cited_segment_positions(&output.output), vec![0, 1, 2]);

        let placeholders = ground_model_output(
            "## Summary\n- Concise fact [s0]\n## Decisions\n- Decision [s0]",
            &segments,
        );
        assert!(cited_segment_positions(&placeholders.output).is_empty());
    }

    #[test]
    fn llama_frontend_contract_uses_clean_one_shot_modes() {
        assert_eq!(
            LLAMA_CLI_SUBPROCESS_FLAGS,
            ["--single-turn", "--simple-io", "--log-disable"]
        );
        assert_eq!(
            LLAMA_COMPLETION_SUBPROCESS_FLAGS,
            ["--conversation", "--single-turn", "--simple-io"]
        );
        assert!(is_llama_completion_frontend(Path::new(
            "llama-completion.exe"
        )));
        assert!(!is_llama_completion_frontend(Path::new("llama-cli.exe")));

        let completion_prompt =
            prepare_prompt_for_runner("local prompt", Some(Path::new("llama-completion.exe")))
                .expect("completion prompt");
        assert_eq!(completion_prompt, "local prompt");
        let cli_prompt =
            prepare_prompt_for_runner("local prompt", Some(Path::new("llama-cli.exe")))
                .expect("CLI prompt");
        assert!(cli_prompt.ends_with(&format!("{LLAMA_OUTPUT_BOUNDARY}\n")));
    }

    #[test]
    fn prompt_transport_uses_a_private_new_file() {
        let path = write_prompt_file("private meeting transcript").expect("write prompt");
        assert_eq!(
            fs::read_to_string(&path).expect("read prompt"),
            "private meeting transcript"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path)
                .expect("prompt metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        fs::remove_file(path).expect("remove prompt");
    }

    #[test]
    fn child_pipe_reader_enforces_the_byte_limit() {
        let output = read_child_pipe_limited(
            Some(io::Cursor::new(b"local output")),
            32,
            "LOCAL_LLM_OUTPUT_TOO_LARGE",
            "local instruct output",
        )
        .expect("bounded output");
        assert_eq!(output, "local output");

        let error = read_child_pipe_limited(
            Some(io::Cursor::new(b"too large")),
            4,
            "LOCAL_LLM_OUTPUT_TOO_LARGE",
            "local instruct output",
        )
        .expect_err("oversized output must fail");
        assert_eq!(error.code, "LOCAL_LLM_OUTPUT_TOO_LARGE");
    }

    #[test]
    fn framed_llama_output_discards_cli_banner_and_performance_footer() {
        let raw = format!(
            "Loading model...\nmodel: C:\\private\\model.gguf\n> prompt\n{LLAMA_OUTPUT_BOUNDARY}\n## Summary\n- Local decision [s0]\n[ Prompt: 20 t/s | Generation: 10 t/s ]\nExiting..."
        );
        let output = extract_llama_generated_output(&raw);
        assert_eq!(output, "## Summary\n- Local decision [s0]");
        assert!(!output.contains("model.gguf"));

        let repeated = format!(
            "{LLAMA_OUTPUT_BOUNDARY}\nmodel: C:\\private\\model.gguf\n{LLAMA_OUTPUT_BOUNDARY}\nFinal answer [s1]"
        );
        assert_eq!(
            extract_llama_generated_output(&repeated),
            "Final answer [s1]"
        );

        assert_eq!(
            extract_llama_generated_output("fixture output [s1]"),
            "fixture output [s1]"
        );
        assert_eq!(
            clean_model_generated_output("Answer with citation [s1] [end of text]"),
            "Answer with citation [s1]"
        );
    }

    #[test]
    fn prompt_segments_are_pathless_and_channel_attributed() {
        let transcript = json!({
            "recordingId": "rec-test",
            "label": "Fixture",
            "segments": [
                {
                    "index": 4,
                    "channel": "mic",
                    "speaker": "Alex",
                    "text": "Decision: keep everything local.",
                    "startMs": 10
                },
                {
                    "index": 5,
                    "channel": "system",
                    "text": "Action: Priya will validate citations.",
                    "startMs": 20
                }
            ]
        });

        let segments = prompt_segments(&transcript);
        let prompt = build_recap_prompt(&transcript, &segments).expect("prompt");

        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].citation_id, "s0");
        assert_eq!(segments[1].speaker, "Speaker");
        assert!(prompt.contains("[s0 | 10 ms | mic | Alex]"));
        assert!(prompt.contains("[s1 | 20 ms | system | Speaker]"));
        assert!(!prompt.contains("C:\\"));
    }
}
