const WINDOWS_CASES = [
  "cleanInstall",
  "upgradeFromPreviousElectronPrerelease",
  "uninstallDataPreserved",
  "standardUser",
  "administrator",
  "offlineLaunch",
  "licenseServiceUnavailable",
  "updateServiceUnavailable",
];

const HARDWARE_CASES = [
  "systemAudio",
  "combinedAudio",
  "deviceDisconnectAndSwitch",
  "sleepResume",
  "lockUnlock",
];

const MICROPHONE_KINDS = ["built-in", "usb", "bluetooth"];
const DURATION_TARGETS = [5, 30, 60, 180];
const SHA256 = /^[a-f0-9]{64}$/i;
const COMMIT = /^[a-f0-9]{40}$/i;

function add(failures, condition, message) {
  if (!condition) failures.push(message);
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeEvidenceRef(value) {
  if (typeof value !== "string" || value.length < 3 || value.length > 240) return false;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.includes("\\")) return false;
  if (value.includes("..") || /[\r\n\0]/.test(value)) return false;
  return /^(?:proof|artifact|ticket):\/\/[A-Za-z0-9._:/-]+$/.test(value);
}

function validateEvidenceRefs(failures, value, label) {
  add(failures, Array.isArray(value) && value.length > 0, `${label} must include at least one evidence reference`);
  for (const reference of Array.isArray(value) ? value : []) {
    add(failures, isSafeEvidenceRef(reference), `${label} contains an unsafe evidence reference`);
  }
}

function validatePassedCase(failures, value, label) {
  add(failures, value?.passed === true, `${label} must pass`);
  validateEvidenceRefs(failures, value?.evidenceRefs, label);
}

function validateCandidate(failures, evidence, expected) {
  const candidate = evidence?.candidate;
  add(failures, candidate?.productName === expected.productName, `candidate product must be ${expected.productName}`);
  add(failures, candidate?.version === expected.version, `candidate version must be ${expected.version}`);
  add(failures, COMMIT.test(candidate?.commit ?? ""), "candidate commit must be a full Git SHA");
  add(failures, candidate?.commit === expected.commit, "candidate commit must match the checked-out source revision");
  add(failures, typeof candidate?.installer?.filename === "string" && candidate.installer.filename.length > 0 && !/[\\/\r\n]/.test(candidate.installer.filename), "installer filename must be a safe basename");
  add(failures, SHA256.test(candidate?.installer?.sha256 ?? ""), "installer SHA-256 is required");
  add(failures, isPositiveNumber(candidate?.installer?.bytes), "installer byte size is required");
  add(failures, candidate?.installer?.signatureValid === true, "installer signature must be valid");
  add(failures, candidate?.installer?.timestampValid === true, "installer signature timestamp must be valid");
  validateEvidenceRefs(failures, candidate?.installer?.evidenceRefs, "installer identity");
}

function validateEnvironment(failures, evidence) {
  const environment = evidence?.environment;
  add(failures, typeof environment?.windowsVersion === "string" && /^Windows 11\b/.test(environment.windowsVersion), "a supported Windows 11 version is required");
  add(failures, environment?.architecture === "x64", "the first beta matrix must run on Windows x64");
  add(failures, typeof environment?.machineRef === "string" && /^[A-Za-z0-9._-]{3,80}$/.test(environment.machineRef), "a redacted machine reference is required");
  add(failures, typeof environment?.operatorRef === "string" && /^[A-Za-z0-9._-]{3,80}$/.test(environment.operatorRef), "a redacted operator reference is required");
  add(failures, !Number.isNaN(Date.parse(environment?.testedAt ?? "")), "environment testedAt must be an ISO timestamp");
}

function validateWindowsMatrix(failures, evidence) {
  const matrix = evidence?.windowsMatrix ?? {};
  for (const name of WINDOWS_CASES) validatePassedCase(failures, matrix[name], `Windows matrix ${name}`);

  const upgrade = matrix.upgradeFromPreviousElectronPrerelease;
  add(failures, typeof upgrade?.previousVersion === "string" && /^0\.\d+\.\d+$/.test(upgrade.previousVersion), "upgrade evidence must name the previous Electron prerelease");
  for (const field of ["backupVerified", "dataPreserved", "migrationVerified", "rollbackRetained"]) {
    add(failures, upgrade?.[field] === true, `upgrade evidence must prove ${field}`);
  }

  const license = matrix.licenseServiceUnavailable;
  for (const field of ["existingDataOpened", "existingDataExported", "existingDataDeleted"]) {
    add(failures, license?.[field] === true, `license outage evidence must prove ${field}`);
  }
  add(failures, matrix.uninstallDataPreserved?.vaultPreserved === true, "uninstall evidence must prove the vault was preserved");
  add(failures, matrix.offlineLaunch?.outboundConnections === 0, "offline launch must record zero outbound connections");
}

function validateHardwareMatrix(failures, evidence) {
  const matrix = evidence?.hardwareMatrix ?? {};
  const microphones = Array.isArray(matrix.microphones) ? matrix.microphones : [];
  for (const kind of MICROPHONE_KINDS) {
    const microphone = microphones.find((entry) => entry?.kind === kind);
    validatePassedCase(failures, microphone, `${kind} microphone`);
    add(failures, typeof microphone?.deviceRef === "string" && /^[A-Za-z0-9 ._()-]{3,120}$/.test(microphone.deviceRef), `${kind} microphone requires a redacted device reference`);
  }
  for (const name of HARDWARE_CASES) validatePassedCase(failures, matrix[name], `hardware matrix ${name}`);
  add(failures, matrix.deviceDisconnectAndSwitch?.lossReportedAccurately === true, "device switching must report lost frames or gaps accurately");
  add(failures, matrix.sleepResume?.deterministicOutcome === true, "sleep and resume must have a deterministic continuation or recovery outcome");
  add(failures, matrix.lockUnlock?.recordingStateAccurate === true, "lock and unlock must preserve an accurate recording state");
}

function validateDurationRun(failures, run, targetMinutes) {
  const label = `${targetMinutes}-minute recording`;
  add(failures, run?.passed === true, `${label} must pass`);
  add(failures, run?.targetMinutes === targetMinutes, `${label} target is missing`);
  add(failures, isPositiveNumber(run?.actualSeconds), `${label} actual duration is required`);
  if (isPositiveNumber(run?.actualSeconds)) {
    add(failures, Math.abs(run.actualSeconds - targetMinutes * 60) <= 120, `${label} actual duration differs by more than 120 seconds`);
  }
  add(failures, isNonNegativeNumber(run?.durationDeltaSeconds), `${label} duration delta is required`);
  add(failures, isPositiveNumber(run?.configuredChunkSeconds), `${label} configured chunk duration is required`);
  add(failures, Number.isInteger(run?.droppedChunks) && run.droppedChunks >= 0, `${label} dropped chunk count is required`);
  add(failures, isPositiveNumber(run?.fileBytes), `${label} file size is required`);
  add(failures, isPositiveNumber(run?.transcriptionSeconds), `${label} transcription time is required`);
  add(failures, isNonNegativeNumber(run?.cpuPeakPercent) && run.cpuPeakPercent <= 100, `${label} CPU peak must be between 0 and 100`);
  add(failures, isPositiveNumber(run?.memoryPeakMiB), `${label} memory peak is required`);
  add(failures, isPositiveNumber(run?.storageStartBytes), `${label} starting storage is required`);
  add(failures, isPositiveNumber(run?.storageEndBytes), `${label} ending storage is required`);
  add(failures, run?.playbackVerified === true, `${label} playback must be verified`);
  add(failures, run?.transcriptVerified === true, `${label} transcript must be verified`);
  add(failures, run?.exportVerified === true, `${label} export must be verified`);
  add(failures, SHA256.test(run?.audioSha256 ?? ""), `${label} audio checksum is required`);
  add(failures, isSafeEvidenceRef(run?.logRef), `${label} log reference is missing or unsafe`);
  validateEvidenceRefs(failures, run?.evidenceRefs, label);

  if (targetMinutes === 30) {
    add(failures, run?.forceKillRecovery === true, "30-minute recording must include force-kill recovery");
    add(failures, run?.recoveryResult === "passed", "30-minute force-kill recovery must pass");
    add(failures, isNonNegativeNumber(run?.recoveredLossSeconds), "30-minute recovery loss must be measured");
    if (isNonNegativeNumber(run?.recoveredLossSeconds) && isPositiveNumber(run?.configuredChunkSeconds)) {
      add(failures, run.recoveredLossSeconds <= run.configuredChunkSeconds, "30-minute recovery loss exceeds one configured chunk");
    }
  } else {
    add(failures, ["passed", "not-required"].includes(run?.recoveryResult), `${label} recovery result is required`);
  }
}

function validateReliability(failures, evidence) {
  const runs = Array.isArray(evidence?.recordings) ? evidence.recordings : [];
  for (const target of DURATION_TARGETS) validateDurationRun(failures, runs.find((run) => run?.targetMinutes === target), target);
  validatePassedCase(failures, evidence?.coreHangRecovery, "core hang recovery");
  add(failures, evidence?.coreHangRecovery?.captureOutcomeExplicit === true, "core hang recovery must expose the capture outcome");
  add(failures, evidence?.coreHangRecovery?.committedDataPreserved === true, "core hang recovery must preserve committed data");
  validatePassedCase(failures, evidence?.diskPressure, "disk pressure");
  add(failures, evidence?.diskPressure?.falseSavedStatePrevented === true, "disk pressure must never show a false saved state");
}

function validateManualChecks(failures, evidence) {
  const accessibility = evidence?.accessibility ?? {};
  for (const field of ["keyboardRecordReviewExport", "focusRestoration", "highContrast", "reducedMotion", "zoom200"]) {
    add(failures, accessibility[field] === true, `manual accessibility evidence must prove ${field}`);
  }
  validateEvidenceRefs(failures, accessibility.evidenceRefs, "manual accessibility");
  add(failures, evidence?.diagnostics?.contentAndSecretsExcluded === true, "diagnostic evidence must exclude user content and secrets");
  validateEvidenceRefs(failures, evidence?.diagnostics?.evidenceRefs, "diagnostic redaction");
}

export function validateManualReleaseEvidence(evidence, expected) {
  const failures = [];
  add(failures, evidence?.schemaVersion === 1, "manual release evidence schemaVersion must be 1");
  validateCandidate(failures, evidence, expected);
  validateEnvironment(failures, evidence);
  validateWindowsMatrix(failures, evidence);
  validateHardwareMatrix(failures, evidence);
  validateReliability(failures, evidence);
  validateManualChecks(failures, evidence);
  return [...new Set(failures)];
}

export function validateManualReleaseProof(payload) {
  const failures = [];
  add(failures, payload?.proofKind === "v3-manual-release-matrix", "manual release proofKind must be v3-manual-release-matrix");
  add(failures, payload?.ok === true, "manual release matrix did not pass");
  add(failures, payload?.releaseReady === true, "manual release matrix is not release-ready");
  add(failures, payload?.inputPresent === true, "manual release evidence input is missing");
  add(failures, payload?.localOnly === true, "manual release proof must be local-only");
  add(failures, payload?.networkAttempted === false, "manual release proof generation must not use the network");
  add(failures, payload?.rawPathExposed === false, "manual release proof must not expose full paths");
  add(failures, SHA256.test(payload?.evidenceSha256 ?? ""), "manual release evidence digest is missing");
  add(failures, Array.isArray(payload?.failures) && payload.failures.length === 0, "manual release proof contains failures");
  return failures;
}

export const MANUAL_RELEASE_MATRIX_REQUIREMENTS = {
  windowsCases: WINDOWS_CASES,
  hardwareCases: HARDWARE_CASES,
  microphoneKinds: MICROPHONE_KINDS,
  durationTargets: DURATION_TARGETS,
};
