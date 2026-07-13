import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function asPath(pathValue) {
  return resolve(repoRoot, pathValue);
}

function rel(pathValue) {
  return relative(repoRoot, pathValue).replaceAll("\\", "/");
}

function readJson(pathValue) {
  return JSON.parse(readFileSync(pathValue, "utf8").replace(/^\uFEFF/, ""));
}

function proofFiles(proofDir) {
  if (!existsSync(proofDir)) return [];
  return readdirSync(proofDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const pathValue = join(proofDir, entry.name);
      return {
        name: entry.name,
        path: pathValue,
        modifiedMs: statSync(pathValue).mtimeMs,
      };
    });
}

function newestMatching(files, pattern) {
  return files
    .filter((entry) => pattern.test(entry.name))
    .sort((a, b) => b.modifiedMs - a.modifiedMs)[0] ?? null;
}

function gate(status, label, details = {}) {
  return {
    label,
    status,
    ...details,
  };
}

function fromProof(files, pattern, label, validate) {
  const file = newestMatching(files, pattern);
  if (!file) {
    return gate("missing", label, { file: null, failures: [`${label} proof artifact is missing`] });
  }
  let payload = null;
  try {
    payload = readJson(file.path);
  } catch (error) {
    return gate("failed", label, {
      file: rel(file.path),
      failures: [`${label} proof artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    });
  }
  const failures = validate(payload);
  return gate(failures.length === 0 ? "passed" : "failed", label, {
    file: rel(file.path),
    generatedAt: payload?.generatedAt ?? null,
    failures,
    summary: summarizePayload(payload),
  });
}

function summarizePayload(payload) {
  if (payload?.proofKind === "m0-proof-audit-summary" || Array.isArray(payload?.rows)) {
    return {
      exitReady: payload?.exitReady === true,
      missingCount: Array.isArray(payload?.missing) ? payload.missing.length : null,
      failedCount: Array.isArray(payload?.failed) ? payload.failed.length : null,
    };
  }
  if (payload?.proofKind === "v3-local-verification") {
    return {
      ok: payload?.ok === true,
      stepCount: Array.isArray(payload?.steps) ? payload.steps.length : null,
      failedSteps: Array.isArray(payload?.steps)
        ? payload.steps.filter((step) => step?.ok !== true).map((step) => step?.name)
        : [],
    };
  }
  if (payload?.proofKind === "m1-capture-proof-audit") {
    return {
      ok: payload?.ok === true,
      strictReal: payload?.strictReal === true,
      requiredReal: payload?.requiredReal ?? [],
    };
  }
  if (payload?.proofKind === "v3-source-security-proof") {
    return {
      ok: payload?.ok === true,
      requiredSourcesOk: payload?.checks?.requiredSources?.ok === true,
      trackedEnvironmentFilesOk: payload?.checks?.trackedEnvironmentFiles?.ok === true,
      ignoredEnvironmentFilesOk: payload?.checks?.ignoredEnvironmentFiles?.ok === true,
      electronRustRulesOk: payload?.checks?.electronRustRules?.ok === true,
      mutationTestsOk: payload?.checks?.mutationTests?.ok === true,
      failures: payload?.failures ?? [],
    };
  }
  if (payload?.proofKind === "v3-updater-policy-proof") {
    return {
      ok: payload?.ok === true,
      networkAttempted: payload?.networkAttempted === true,
      staticChecksOk: Object.values(payload?.staticChecks ?? {}).every((check) => check?.ok === true),
      liveUpdatesOk: payload?.liveChecks?.updates?.ok === true,
      externalCallsAttempted: payload?.liveChecks?.auditSnapshot?.externalCallsAttempted ?? null,
      failures: payload?.failures ?? [],
    };
  }
  if (payload?.proofKind === "v3-release-signing-proof") {
    return {
      ok: payload?.ok === true,
      releaseReady: payload?.releaseReady === true,
      windowsInstallerCount: Array.isArray(payload?.windows?.installerCandidates)
        ? payload.windows.installerCandidates.length
        : null,
      windowsAppSigned: payload?.windows?.appSignature?.valid === true,
      windowsCoreSigned: payload?.windows?.coreSignature?.valid === true,
      macDmgCount: Array.isArray(payload?.macos?.dmgCandidates) ? payload.macos.dmgCandidates.length : null,
      macAppBundleCount: Array.isArray(payload?.macos?.appBundleCandidates)
        ? payload.macos.appBundleCandidates.length
        : null,
      macAppSigned: payload?.macos?.signature?.appCodeSigned === true,
      macAppGatekeeperAccepted: payload?.macos?.signature?.appGatekeeperAccepted === true,
      macDmgGatekeeperAccepted: payload?.macos?.signature?.dmgGatekeeperAccepted === true,
      macNotarized: payload?.macos?.signature?.notarized === true,
      linuxAppImageCount: Array.isArray(payload?.linux?.appImageCandidates)
        ? payload.linux.appImageCandidates.length
        : null,
      linuxDebCount: Array.isArray(payload?.linux?.debCandidates) ? payload.linux.debCandidates.length : null,
      linuxAppImageSigned:
        Array.isArray(payload?.linux?.appImageSignatures) &&
        payload.linux.appImageSignatures.length > 0 &&
        payload.linux.appImageSignatures.every((entry) => entry?.verified === true),
      linuxDebSigned:
        Array.isArray(payload?.linux?.debSignatures) &&
        payload.linux.debSignatures.length > 0 &&
        payload.linux.debSignatures.every((entry) => entry?.verified === true),
      consistencyOk: payload?.consistency?.ok === true,
      failures: payload?.failures ?? [],
    };
  }
  if (payload?.proofKind === "v3-release-artifact-smoke") {
    return {
      ok: payload?.ok === true,
      platform: payload?.platform ?? null,
      extractionAttempted: payload?.currentPlatform?.extractionAttempted === true,
      currentPlatformOk: payload?.currentPlatform?.ok === true,
      failures: payload?.failures ?? [],
    };
  }
  if (payload?.proofKind === "v3-release-checksums") {
    return {
      ok: payload?.ok === true,
      mode: payload?.mode ?? null,
      artifactCount: payload?.artifactCount ?? null,
      gitHead: payload?.git?.head ?? null,
      gitDirty: payload?.git?.dirty ?? null,
      sourceManifestHead: payload?.sourceManifest?.gitHead ?? null,
      failures: payload?.failures ?? [],
    };
  }
  if (payload?.proofKind === "m1-real-capture-proof") {
    return {
      ok: payload?.ok === true,
      consentGranted: payload?.consentGranted === true,
      recordingAttempted: payload?.recordingAttempted === true,
      failures: payload?.failures ?? [],
      steps: Array.isArray(payload?.steps) ? payload.steps.map((step) => step?.name) : [],
    };
  }
  if (payload?.proofKind === "m1-real-capture-readiness") {
    return {
      ready: payload?.ready === true,
      recordingAttempted: payload?.recordingAttempted === true,
      failures: payload?.failures ?? [],
    };
  }
  if (payload?.proofKind === "m2-real-whisper-inputs") {
    return {
      ready: payload?.ready === true,
      downloadsAttempted: payload?.downloadsAttempted === true,
      failures: payload?.failures ?? [],
    };
  }
  if (payload?.proofKind === "m2-transcription-proof-audit") {
    return {
      ok: payload?.ok === true,
      requireRealLocal: payload?.requireRealLocal === true,
      failures: payload?.failures ?? [],
    };
  }
  if (payload?.proofKind === "m2-real-whisper-proof") {
    return {
      ok: payload?.ok === true,
      consentGranted: payload?.consentGranted === true,
      inputValidationAttempted: payload?.inputValidationAttempted === true,
      inferenceAttempted: payload?.inferenceAttempted === true,
      failures: payload?.failures ?? [],
      steps: Array.isArray(payload?.steps) ? payload.steps.map((step) => step?.name) : [],
    };
  }
  return {
    ok: payload?.ok === true,
    proofKind: payload?.proofKind ?? null,
  };
}

function validateM0Exit(payload) {
  const failures = [];
  if (payload?.exitReady !== true) failures.push("M0 exit proof is not ready");
  if (payload?.ok !== true) failures.push("M0 proof audit ok must be true");
  if (Array.isArray(payload?.missing) && payload.missing.length > 0) {
    failures.push(`M0 proof audit has ${payload.missing.length} missing gate(s)`);
  }
  if (Array.isArray(payload?.failed) && payload.failed.length > 0) {
    failures.push(`M0 proof audit has ${payload.failed.length} failed gate(s)`);
  }
  return failures;
}

function validateLocalVerification(payload) {
  const failures = [];
  if (payload?.ok !== true) failures.push("local staged verification did not pass");
  if (!Array.isArray(payload?.steps) || payload.steps.length === 0) {
    failures.push("local staged verification has no recorded steps");
  } else {
    const failed = payload.steps.filter((step) => step?.ok !== true).map((step) => step?.name ?? "unknown");
    if (failed.length > 0) failures.push(`local staged verification failed steps: ${failed.join(", ")}`);
  }
  return failures;
}

function validateSourceSecurity(payload) {
  const failures = [];
  if (payload?.ok !== true) failures.push("source security proof did not pass");
  if (payload?.proofKind !== "v3-source-security-proof") {
    failures.push("source security proofKind must be v3-source-security-proof");
  }
  if (payload?.localOnly !== true) failures.push("source security proof localOnly must be true");
  if (payload?.cloudAi !== false) failures.push("source security proof cloudAi must be false");
  if (payload?.rawPathExposed !== false) failures.push("source security proof must not expose raw paths");
  if (payload?.keyMaterialExposedToRenderer !== false) {
    failures.push("source security proof must not expose key material");
  }
  if (payload?.checks?.requiredSources?.ok !== true) {
    failures.push("source security proof must prove required Electron/Rust sources exist");
  }
  if (payload?.checks?.trackedEnvironmentFiles?.ok !== true) {
    failures.push("source security proof must prove env files are not tracked");
  }
  if (payload?.checks?.ignoredEnvironmentFiles?.ok !== true) {
    failures.push("source security proof must prove local env files are ignored");
  }
  if (payload?.checks?.electronRustRules?.ok !== true) {
    failures.push("source security proof must pass Electron/Rust source rules");
  }
  if (payload?.checks?.mutationTests?.ok !== true) {
    failures.push("source security proof mutation tests must pass");
  }
  if (Array.isArray(payload?.failures) && payload.failures.length > 0) {
    failures.push(`source security proof has ${payload.failures.length} failure(s)`);
  }
  return failures;
}

function validateUpdaterPolicy(payload) {
  const failures = [];
  if (payload?.ok !== true) failures.push("updater policy proof did not pass");
  if (payload?.proofKind !== "v3-updater-policy-proof") {
    failures.push("updater policy proofKind must be v3-updater-policy-proof");
  }
  if (payload?.localOnly !== true) failures.push("updater policy proof localOnly must be true");
  if (payload?.cloudAi !== false) failures.push("updater policy proof cloudAi must be false");
  if (payload?.networkAttempted !== false) failures.push("updater policy proof must not attempt network");
  if (payload?.rawPathExposed !== false) failures.push("updater policy proof must not expose raw paths");
  if (payload?.keyMaterialExposedToRenderer !== false) {
    failures.push("updater policy proof must not expose key material");
  }
  if (payload?.staticChecks?.electronBackgroundNetworkingDisabled?.ok !== true) {
    failures.push("updater proof must show Electron background networking disabled");
  }
  if (payload?.staticChecks?.electronComponentUpdaterDisabled?.ok !== true) {
    failures.push("updater proof must show Electron component updater disabled");
  }
  if (payload?.staticChecks?.electronAutoUpdaterAbsent?.ok !== true) {
    failures.push("updater proof must show autoUpdater absent");
  }
  if (payload?.staticChecks?.electronCrashReporterStartAbsent?.ok !== true) {
    failures.push("updater proof must show crashReporter.start absent");
  }
  if (payload?.staticChecks?.mainAllowlistExposesStatusOnly?.ok !== true) {
    failures.push("updater proof must show Electron exposes update status only");
  }
  if (payload?.staticChecks?.preloadExposesStatusOnly?.ok !== true) {
    failures.push("updater proof must show preload exposes update status only");
  }
  if (payload?.staticChecks?.rendererBlocksConnect?.ok !== true) {
    failures.push("updater proof must show renderer connect-src none");
  }
  if (payload?.staticChecks?.coreManualOnlyPolicy?.ok !== true) {
    failures.push("updater proof must show core manual-only policy source");
  }
  if (payload?.liveChecks?.updates?.ok !== true) {
    failures.push("updater proof must show live updates.status manual-only policy");
  }
  if (payload?.liveChecks?.auditSnapshot?.externalCallsAttempted !== 0) {
    failures.push("updater proof must show zero attempted external calls");
  }
  if (Array.isArray(payload?.failures) && payload.failures.length > 0) {
    failures.push(`updater policy proof has ${payload.failures.length} failure(s)`);
  }
  return failures;
}

function validateReleaseSigning(payload) {
  const failures = [];
  if (payload?.ok !== true) failures.push("release signing proof did not run successfully");
  if (payload?.proofKind !== "v3-release-signing-proof") {
    failures.push("release signing proofKind must be v3-release-signing-proof");
  }
  if (payload?.releaseReady !== true) failures.push("release signing proof is not release-ready");
  if (payload?.localOnly !== true) failures.push("release signing proof localOnly must be true");
  if (payload?.cloudAi !== false) failures.push("release signing proof cloudAi must be false");
  if (payload?.networkAttempted !== false) failures.push("release signing proof must not attempt network");
  if (payload?.rawPathExposed !== false) failures.push("release signing proof must not expose raw paths");
  if (payload?.keyMaterialExposedToRenderer !== false) {
    failures.push("release signing proof must not expose key material");
  }
  if (payload?.consistency?.ok !== true) {
    failures.push("release signing proof must match artifact manifest and release artifact smoke hashes");
  }
  if (!Array.isArray(payload?.windows?.installerCandidates) || payload.windows.installerCandidates.length === 0) {
    failures.push("release signing proof must include a Windows installer");
  }
  if (payload?.windows?.appSignature?.valid !== true) {
    failures.push("release signing proof must show signed Windows app executable");
  }
  if (payload?.windows?.coreSignature?.valid !== true) {
    failures.push("release signing proof must show signed Windows sidecar executable");
  }
  if (
    !Array.isArray(payload?.windows?.installerSignatures) ||
    !payload.windows.installerSignatures.some((signature) => signature?.valid === true)
  ) {
    failures.push("release signing proof must show a signed Windows installer");
  }
  if (!Array.isArray(payload?.macos?.dmgCandidates) || payload.macos.dmgCandidates.length === 0) {
    failures.push("release signing proof must include a macOS DMG");
  } else {
    if (payload?.macos?.signature?.notarized !== true) {
      failures.push("release signing proof must show a notarized or stapled macOS DMG");
    }
    if (payload?.macos?.signature?.dmgGatekeeperAccepted !== true) {
      failures.push("release signing proof must show macOS DMG Gatekeeper acceptance");
    }
  }
  if (payload?.macos?.notarizationConfigured !== true) {
    failures.push("release signing proof must show macOS notarization configured");
  }
  if (
    Array.isArray(payload?.macos?.appBundleCandidates) &&
    payload.macos.appBundleCandidates.length > 0
  ) {
    if (payload?.macos?.signature?.appCodeSigned !== true) {
      failures.push("release signing proof must show a signed macOS app bundle");
    }
    if (payload?.macos?.signature?.appGatekeeperAccepted !== true) {
      failures.push("release signing proof must show macOS app bundle Gatekeeper acceptance");
    }
  }
  if (!Array.isArray(payload?.linux?.appImageCandidates) || payload.linux.appImageCandidates.length === 0) {
    failures.push("release signing proof must include a Linux AppImage");
  } else if (
    !Array.isArray(payload?.linux?.appImageSignatures) ||
    !payload.linux.appImageSignatures.every((entry) => entry?.verified === true)
  ) {
    failures.push("release signing proof must show verified detached signatures for Linux AppImage artifacts");
  }
  if (!Array.isArray(payload?.linux?.debCandidates) || payload.linux.debCandidates.length === 0) {
    failures.push("release signing proof must include a Linux deb");
  } else if (
    !Array.isArray(payload?.linux?.debSignatures) ||
    !payload.linux.debSignatures.every((entry) => entry?.verified === true)
  ) {
    failures.push("release signing proof must show verified detached signatures for Linux deb artifacts");
  }
  if (Array.isArray(payload?.failures) && payload.failures.length > 0) {
    failures.push(`release signing proof has ${payload.failures.length} failure(s)`);
  }
  return failures;
}

function validateReleaseArtifactSmoke(payload) {
  const failures = [];
  if (payload?.ok !== true) failures.push("release artifact smoke did not pass");
  if (payload?.proofKind !== "v3-release-artifact-smoke") {
    failures.push("release artifact smoke proofKind must be v3-release-artifact-smoke");
  }
  if (payload?.localOnly !== true) failures.push("release artifact smoke localOnly must be true");
  if (payload?.cloudAi !== false) failures.push("release artifact smoke cloudAi must be false");
  if (payload?.networkAttempted !== false) failures.push("release artifact smoke must not attempt network");
  if (payload?.rawPathExposed !== false) failures.push("release artifact smoke must not expose raw paths");
  if (payload?.keyMaterialExposedToRenderer !== false) {
    failures.push("release artifact smoke must not expose key material");
  }
  if (payload?.currentPlatform?.ok !== true) failures.push("release artifact smoke current platform check did not pass");
  if (payload?.currentPlatform?.extractionAttempted !== true) {
    failures.push("release artifact smoke must attempt artifact extraction or mounting");
  }
  const requiredEntries = Array.isArray(payload?.currentPlatform?.requiredEntries)
    ? payload.currentPlatform.requiredEntries
    : [];
  if (requiredEntries.length === 0) {
    failures.push("release artifact smoke must record extracted payload entries");
  }
  for (const entry of requiredEntries) {
    if (entry?.exists !== true) {
      failures.push(`release artifact smoke extracted entry is missing: ${entry?.extractedPath ?? "unknown"}`);
    }
    if (entry?.hashMatchesUnpacked !== true) {
      failures.push(`release artifact smoke extracted entry does not match unpacked output: ${entry?.extractedPath ?? "unknown"}`);
    }
  }
  if (payload?.platform === "win32") {
    if (payload?.currentPlatform?.installer?.exists !== true) {
      failures.push("release artifact smoke must include a Windows installer");
    }
    for (const expected of [
      "Candor.exe",
      "resources/app.asar",
      "resources/bin/candor-core.exe",
    ]) {
      const entry = requiredEntries.find((candidate) => candidate?.extractedPath === expected);
      if (!entry) {
        failures.push(`release artifact smoke missing payload evidence for ${expected}`);
      } else if (entry.hashMatchesUnpacked !== true) {
        failures.push(`release artifact smoke hash did not match unpacked payload for ${expected}`);
      }
    }
  }
  if (Array.isArray(payload?.failures) && payload.failures.length > 0) {
    failures.push(`release artifact smoke has ${payload.failures.length} failure(s)`);
  }
  return failures;
}

function validateReleaseChecksums(payload) {
  const failures = [];
  if (payload?.ok !== true) failures.push("release checksum proof did not pass");
  if (payload?.proofKind !== "v3-release-checksums") {
    failures.push("release checksum proofKind must be v3-release-checksums");
  }
  if (payload?.mode !== "verify") failures.push("release checksum proof must come from verification mode");
  if (payload?.localOnly !== true) failures.push("release checksum proof localOnly must be true");
  if (payload?.cloudAi !== false) failures.push("release checksum proof cloudAi must be false");
  if (payload?.networkAttempted !== false) failures.push("release checksum proof must not attempt network");
  if (payload?.rawPathExposed !== false) failures.push("release checksum proof must not expose raw paths");
  if (payload?.keyMaterialExposed !== false) failures.push("release checksum proof must not expose key material");
  if (typeof payload?.git?.head !== "string" || !/^[a-f0-9]{40}$/.test(payload.git.head)) {
    failures.push("release checksum proof must identify a committed source revision");
  }
  if (payload?.git?.dirty !== false) failures.push("release checksum proof must come from a clean tracked source tree");
  if (payload?.sourceManifest?.proofKind !== "m0-artifact-manifest") {
    failures.push("release checksum proof must bind to the M0 artifact manifest");
  }
  if (payload?.sourceManifest?.gitHead !== payload?.git?.head || payload?.sourceManifest?.dirty !== false) {
    failures.push("release checksum proof source manifest must match the clean committed revision");
  }
  if (!Number.isInteger(payload?.sourceManifest?.artifactCount) || payload.sourceManifest.artifactCount < 1) {
    failures.push("release checksum proof source manifest must include at least one package");
  }
  if (
    !Array.isArray(payload?.sourceManifest?.matchedArtifactNames) ||
    payload.sourceManifest.matchedArtifactNames.length !== payload?.sourceManifest?.artifactCount
  ) {
    failures.push("release checksum proof must match every package recorded by the source manifest");
  }

  const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
  if (!Number.isInteger(payload?.artifactCount) || payload.artifactCount < 1) {
    failures.push("release checksum proof must include at least one package");
  }
  if (payload?.artifactCount !== artifacts.length) {
    failures.push("release checksum artifact count does not match the artifact list");
  }
  for (const artifact of artifacts) {
    if (typeof artifact?.name !== "string" || artifact.name.length === 0 || artifact.name !== artifact.name.replaceAll("\\", "/").split("/").at(-1)) {
      failures.push("release checksum artifact names must be non-empty basenames");
    }
    if (typeof artifact?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      failures.push(`release checksum is invalid for ${artifact?.name ?? "unknown artifact"}`);
    }
  }
  for (const name of payload?.sourceManifest?.matchedArtifactNames ?? []) {
    if (typeof name !== "string" || name.length === 0 || name !== name.replaceAll("\\", "/").split("/").at(-1)) {
      failures.push("release checksum source-manifest matches must use basename-only package names");
    }
    if (!artifacts.some((artifact) => artifact?.name === name)) {
      failures.push(`release checksum source-manifest package is absent: ${name}`);
    }
  }
  return failures;
}

function validateIconProof(payload) {
  const failures = [];
  if (payload?.ok !== true) failures.push("application icon proof did not pass");
  if (payload?.proofKind !== "v3-icon-proof") {
    failures.push("application icon proofKind must be v3-icon-proof");
  }
  if (payload?.generator?.passed !== true) {
    failures.push("application icons must reproduce byte-for-byte from source geometry");
  }
  if (payload?.builderConfig?.passed !== true) {
    failures.push("Electron builder must reference Windows, macOS, and Linux icon assets");
  }
  if (Number(payload?.ico?.count ?? 0) < 9) {
    failures.push("Windows ICO must include the complete multi-resolution icon family");
  }
  if (Number(payload?.icns?.count ?? 0) < 7) {
    failures.push("macOS ICNS must include the complete modern icon family");
  }
  if (!Array.isArray(payload?.pngs) || payload.pngs.length < 11) {
    failures.push("Linux PNG icon family is incomplete");
  }
  if (payload?.packaged?.passed !== true) {
    failures.push("packaged application icon proof did not pass");
  }
  if (payload?.platform === "win32") {
    if (payload?.packaged?.differentPixels !== 0) {
      failures.push("packaged Windows executable icon differs from the generated source icon");
    }
    if (payload?.packaged?.totalChannelDelta !== 0) {
      failures.push("packaged Windows executable icon pixel channels differ from source");
    }
  }
  return failures;
}

function hasBoundedRealCaptureDuration(value) {
  return Number.isInteger(value) && value >= 500 && value <= 5000;
}

function validateRealCapture(payload) {
  const failures = [];
  if (payload?.ok !== true) failures.push("real capture proof audit did not pass");
  if (payload?.strictReal !== true) failures.push("real capture proof audit must run in strictReal mode");
  const required = Array.isArray(payload?.requiredReal) ? payload.requiredReal : [];
  for (const name of ["mic", "system", "combined"]) {
    if (!required.includes(name)) failures.push(`real capture proof must require ${name}`);
    const branch = payload?.realDevice?.[name];
    if (branch?.ok !== true) failures.push(`real capture branch ${name} is not proven`);
    if (!hasBoundedRealCaptureDuration(branch?.durationMsRequested)) {
      failures.push(`real capture branch ${name} must record bounded requested duration`);
    }
    if (!Number.isFinite(branch?.durationMsActual) || branch.durationMsActual < 0) {
      failures.push(`real capture branch ${name} must record actual duration`);
    }
  }
  return failures;
}

function validateRealCaptureOrchestrator(payload) {
  const failures = [];
  if (payload?.ok !== true) failures.push("real capture orchestrator did not pass");
  if (payload?.proofKind !== "m1-real-capture-proof") {
    failures.push("real capture orchestrator proofKind must be m1-real-capture-proof");
  }
  if (payload?.recordOnly !== false) failures.push("real capture orchestrator must not be record-only");
  if (payload?.consentGranted !== true) failures.push("real capture orchestrator consent is not proven");
  if (payload?.localOnly !== true) failures.push("real capture orchestrator localOnly must be true");
  if (payload?.cloudAi !== false) failures.push("real capture orchestrator cloudAi must be false");
  if (payload?.recordingAttempted !== true) failures.push("real capture orchestrator must attempt recording");
  if (!hasBoundedRealCaptureDuration(payload?.realCaptureDuration?.requestedMs)) {
    failures.push("real capture orchestrator must record bounded capture duration");
  }
  if (payload?.rawPathExposed !== false) failures.push("real capture orchestrator must not expose raw paths");
  if (payload?.keyMaterialExposedToRenderer !== false) {
    failures.push("real capture orchestrator must not expose key material");
  }
  if (Array.isArray(payload?.failures) && payload.failures.length > 0) {
    failures.push(`real capture orchestrator has ${payload.failures.length} failure(s)`);
  }
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  for (const name of ["m1:real-capture-readiness", "m1:capture-service-smoke", "m1:capture-proof-audit:real"]) {
    const step = steps.find((item) => item?.name === name);
    if (!step) {
      failures.push(`real capture orchestrator missing step ${name}`);
    } else if (step.ok !== true) {
      failures.push(`real capture orchestrator step ${name} did not pass`);
    }
  }
  if (payload?.artifacts?.strictAudit?.ok !== true) {
    failures.push("real capture orchestrator strict audit artifact is not passing");
  }
  return failures;
}

function validateRealCaptureReadiness(payload) {
  const failures = [];
  if (payload?.ready !== true) failures.push("real capture readiness is not proven");
  if (payload?.localOnly !== true) failures.push("real capture readiness localOnly must be true");
  if (payload?.cloudAi !== false) failures.push("real capture readiness cloudAi must be false");
  if (payload?.recordingAttempted !== false) failures.push("real capture readiness must not start recording");
  if (payload?.operatorConsentRequiredForRealCapture !== true) {
    failures.push("real capture readiness must require operator consent for real capture");
  }
  if (payload?.rawPathExposed !== false) failures.push("real capture readiness must not expose raw paths");
  if (payload?.keyMaterialExposedToRenderer !== false) {
    failures.push("real capture readiness must not expose key material");
  }
  if (payload?.readiness?.micAvailable !== true) failures.push("real capture mic readiness is not proven");
  if (payload?.readiness?.systemAvailable !== true) failures.push("real capture system readiness is not proven");
  if (payload?.readiness?.combinedAvailable !== true) failures.push("real capture combined readiness is not proven");
  return failures;
}

function validateRealWhisperInputs(payload) {
  const failures = [];
  if (payload?.ready !== true) failures.push("real Whisper inputs are not ready");
  if (payload?.downloadsAttempted !== false) failures.push("real Whisper input preflight must not download anything");
  if (payload?.model?.hashMatched !== true) failures.push("real Whisper model hash is not proven");
  if (payload?.audio?.ok !== true) failures.push("real Whisper audio fixture is not proven");
  if (payload?.rawPathExposed !== false) failures.push("real Whisper input preflight must not expose raw paths");
  return failures;
}

function validateRealWhisperProof(payload) {
  const failures = [];
  if (payload?.ok !== true) failures.push("real Whisper transcription audit did not pass");
  if (payload?.requireRealLocal !== true) failures.push("real Whisper transcription audit must require real local inference");
  if (payload?.realLocalWhisper?.ok !== true) failures.push("real Whisper transcription branch is not proven");
  return failures;
}

function validateRealWhisperOrchestrator(payload) {
  const failures = [];
  if (payload?.ok !== true) failures.push("real Whisper orchestrator did not pass");
  if (payload?.proofKind !== "m2-real-whisper-proof") {
    failures.push("real Whisper orchestrator proofKind must be m2-real-whisper-proof");
  }
  if (payload?.recordOnly !== false) failures.push("real Whisper orchestrator must not be record-only");
  if (payload?.consentGranted !== true) failures.push("real Whisper orchestrator consent is not proven");
  if (payload?.localOnly !== true) failures.push("real Whisper orchestrator localOnly must be true");
  if (payload?.cloudAi !== false) failures.push("real Whisper orchestrator cloudAi must be false");
  if (payload?.downloadsAttempted !== false) failures.push("real Whisper orchestrator must not download");
  if (payload?.modelDownloadsAttempted !== false) {
    failures.push("real Whisper orchestrator must not download models");
  }
  if (payload?.inputValidationAttempted !== true) {
    failures.push("real Whisper orchestrator must validate inputs");
  }
  if (payload?.inferenceAttempted !== true) {
    failures.push("real Whisper orchestrator must attempt local inference");
  }
  if (payload?.rawPathExposed !== false) failures.push("real Whisper orchestrator must not expose raw paths");
  if (payload?.keyMaterialExposedToRenderer !== false) {
    failures.push("real Whisper orchestrator must not expose key material");
  }
  if (Array.isArray(payload?.failures) && payload.failures.length > 0) {
    failures.push(`real Whisper orchestrator has ${payload.failures.length} failure(s)`);
  }
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  for (const name of [
    "m2:real-whisper-inputs",
    "m2:whisper-preflight",
    "m2:transcription-boundary-smoke:real",
    "m2:transcription-proof-audit:real",
  ]) {
    const step = steps.find((item) => item?.name === name);
    if (!step) {
      failures.push(`real Whisper orchestrator missing step ${name}`);
    } else if (step.ok !== true) {
      failures.push(`real Whisper orchestrator step ${name} did not pass`);
    }
  }
  if (payload?.artifacts?.strictAudit?.ok !== true) {
    failures.push("real Whisper orchestrator strict audit artifact is not passing");
  }
  return failures;
}

const strict = hasArg("--strict");
const proofDir = asPath(argValue("--proof-dir", "release-v3/proofs"));
const outputPath = asPath(
  argValue(
    "--write",
    join(
      "release-v3",
      "proofs",
      strict
        ? `v3-release-readiness-audit-strict-${process.platform}-${process.arch}.json`
        : `v3-release-readiness-audit-${process.platform}-${process.arch}.json`,
    ),
  ),
);
const files = proofFiles(proofDir);

const gates = [
  fromProof(files, /^m0-proof-audit-summary\.json$/, "M0 cross-OS packaged network exit", validateM0Exit),
  fromProof(files, /^v3-local-verification-.+\.json$/, "local staged verification", validateLocalVerification),
  fromProof(files, /^v3-source-security-proof-.+\.json$/, "V3 source security proof", validateSourceSecurity),
  fromProof(files, /^v3-updater-policy-proof-.+\.json$/, "V3 updater policy proof", validateUpdaterPolicy),
  fromProof(files, /^v3-release-artifact-smoke-.+\.json$/, "V3 release artifact smoke", validateReleaseArtifactSmoke),
  fromProof(files, /^v3-release-checksums-.+\.json$/, "V3 release package checksums", validateReleaseChecksums),
  fromProof(files, /^v3-icon-proof-.+\.json$/, "V3 packaged application icon proof", validateIconProof),
  fromProof(files, /^v3-release-signing-proof-.+\.json$/, "V3 signed release and installer proof", validateReleaseSigning),
  fromProof(files, /^m1-real-capture-readiness-.+\.json$/, "M1 real capture readiness", validateRealCaptureReadiness),
  fromProof(files, /^m1-real-capture-proof-.+\.json$/, "M1 consented real capture orchestrator", validateRealCaptureOrchestrator),
  fromProof(files, /^m1-capture-proof-audit-real-.+\.json$/, "M1 real mic plus system capture", validateRealCapture),
  fromProof(files, /^m2-real-whisper-proof-.+\.json$/, "M2 consented real Whisper orchestrator", validateRealWhisperOrchestrator),
  fromProof(files, /^m2-real-whisper-inputs-.+\.json$/, "M2 real Whisper local inputs", validateRealWhisperInputs),
  fromProof(files, /^m2-transcription-proof-audit-real-.+\.json$/, "M2 real local Whisper inference", validateRealWhisperProof),
];

const missing = gates.filter((item) => item.status === "missing");
const failed = gates.filter((item) => item.status === "failed");
const releaseReady = missing.length === 0 && failed.length === 0;

const report = {
  ok: !strict || releaseReady,
  proofKind: "v3-release-readiness-audit",
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  strict,
  releaseReady,
  localOnly: true,
  cloudAi: false,
  gates,
  missing: missing.map((item) => ({ label: item.label, file: item.file ?? null })),
  failed: failed.map((item) => ({
    label: item.label,
    file: item.file ?? null,
    failures: item.failures ?? [],
  })),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (releaseReady) {
  console.log(`V3 release readiness audit passed. Proof written to ${outputPath}.`);
} else {
  console.log(`V3 release readiness audit recorded gaps. Proof written to ${outputPath}.`);
  for (const item of [...missing, ...failed]) {
    console.log(`- ${item.label}: ${item.status}`);
    for (const failure of item.failures ?? []) {
      console.log(`  ${failure}`);
    }
  }
}

if (strict && !releaseReady) {
  process.exit(1);
}
