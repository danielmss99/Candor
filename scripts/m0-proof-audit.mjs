import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const expectedProtocolVersion = "m0-jsonrpc-stdio-1";

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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function newestFirst(a, b) {
  return statSync(b.path).mtimeMs - statSync(a.path).mtimeMs;
}

function proofFiles(rootDir) {
  if (!existsSync(rootDir)) return [];
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        entries.push({
          name: entry.name,
          displayName: relative(rootDir, path).replaceAll("\\", "/"),
          path,
        });
      }
    }
  };
  walk(rootDir);
  return entries;
}

function findProofs(proofDir, pattern) {
  return proofFiles(proofDir)
    .filter((entry) => pattern.test(entry.name))
    .map((entry) => ({
      name: entry.displayName,
      path: entry.path,
      payload: readJson(entry.path),
    }))
    .sort(newestFirst);
}

function requireField(condition, message, failures) {
  if (!condition) failures.push(message);
}

function validGitHead(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function numberValue(value, fallback = Number.NaN) {
  return typeof value === "number" ? value : fallback;
}

function validateSourceProvenance(payload, label, failures) {
  requireField(validGitHead(payload?.git?.head), `${label} git head must be recorded`, failures);
  requireField(typeof payload?.git?.dirty === "boolean", `${label} git dirty flag must be recorded`, failures);
  if (payload?.ci?.githubActions === true) {
    requireField(typeof payload?.ci?.runId === "string" && payload.ci.runId.length > 0, `${label} CI run id must be recorded`, failures);
    requireField(typeof payload?.ci?.runAttempt === "string" && payload.ci.runAttempt.length > 0, `${label} CI run attempt must be recorded`, failures);
    requireField(payload?.ci?.sha === payload?.git?.head, `${label} CI sha must match git head`, failures);
  }
}

function nonWindowsAvailableOsKeyLabels() {
  return ["keychain-proof-available", "secret-service-proof-available"];
}

function nonWindowsUnavailableOsKeyLabels() {
  return ["keychain-unavailable", "secret-service-unavailable"];
}

function normalizeWindowsPath(value) {
  return String(value ?? "").replaceAll("\\", "/").toLowerCase();
}

function validateWindowsFirewallRules(payload, failures) {
  requireField(typeof payload?.appPath === "string" && payload.appPath.length > 0, "appPath must be recorded", failures);
  requireField(typeof payload?.corePath === "string" && payload.corePath.length > 0, "corePath must be recorded", failures);

  const rules = Array.isArray(payload?.temporaryFirewallRules) ? payload.temporaryFirewallRules : [];
  requireField(rules.length >= 2, "temporaryFirewallRules must include app and core block rules", failures);

  for (const expectedPath of [payload?.appPath, payload?.corePath]) {
    const normalizedExpected = normalizeWindowsPath(expectedPath);
    const matchingRule = rules.find(
      (rule) => normalizeWindowsPath(rule?.program) === normalizedExpected,
    );
    requireField(Boolean(matchingRule), `temporaryFirewallRules must include program ${expectedPath}`, failures);
    if (matchingRule) {
      requireField(matchingRule.direction === "Outbound", `firewall rule for ${expectedPath} must be outbound`, failures);
      requireField(matchingRule.action === "Block", `firewall rule for ${expectedPath} must block`, failures);
      requireField(matchingRule.enabled === "True", `firewall rule for ${expectedPath} must be enabled`, failures);
    }
  }
}

function validateWindowsReleaseIdentity(payload, failures) {
  const releaseDir = normalizeWindowsPath(payload?.releaseDir).replace(/\/+$/, "");
  requireField(releaseDir.length > 0, "releaseDir must be recorded", failures);

  const selectedPaths = {
    appExecutable: payload?.appPath,
    coreExecutable: payload?.corePath,
    appArchive: payload?.appArchivePath,
  };
  const expectedPaths = {
    appExecutable: `${releaseDir}/win-unpacked/candor v3 m0.exe`,
    coreExecutable: `${releaseDir}/win-unpacked/resources/bin/candor-core.exe`,
    appArchive: `${releaseDir}/win-unpacked/resources/app.asar`,
  };

  for (const artifactName of ["appExecutable", "coreExecutable", "appArchive"]) {
    const selectedPath = normalizeWindowsPath(selectedPaths[artifactName]);
    const identity = payload?.releaseIdentity?.[artifactName];
    const smokeArtifact = payload?.smokeProof?.packagedArtifacts?.[artifactName];

    requireField(
      selectedPath === expectedPaths[artifactName],
      `${artifactName} path must come from releaseDir`,
      failures,
    );
    requireField(identity?.exists === true, `releaseIdentity.${artifactName} must exist`, failures);
    requireField(
      normalizeWindowsPath(identity?.path) === selectedPath,
      `releaseIdentity.${artifactName} path must match selected release`,
      failures,
    );
    requireField(
      typeof identity?.sha256 === "string" && identity.sha256.length === 64,
      `releaseIdentity.${artifactName} must include sha256`,
      failures,
    );
    requireField(
      numberValue(identity?.bytes) > 0,
      `releaseIdentity.${artifactName} must include byte size`,
      failures,
    );
    requireField(
      normalizeWindowsPath(smokeArtifact?.path) === selectedPath,
      `embedded smokeProof ${artifactName} path must match selected release`,
      failures,
    );
    requireField(
      String(smokeArtifact?.sha256 ?? "").toLowerCase() ===
        String(identity?.sha256 ?? "").toLowerCase(),
      `embedded smokeProof ${artifactName} sha256 must match selected release`,
      failures,
    );
    requireField(
      smokeArtifact?.bytes === identity?.bytes,
      `embedded smokeProof ${artifactName} byte size must match selected release`,
      failures,
    );
  }

  requireField(
    normalizeWindowsPath(payload?.smokeProof?.executable) === normalizeWindowsPath(payload?.appPath),
    "embedded smokeProof executable must match appPath",
    failures,
  );
  requireField(
    normalizeWindowsPath(payload?.smokeProof?.corePath) === normalizeWindowsPath(payload?.corePath),
    "embedded smokeProof corePath must match corePath",
    failures,
  );
}

function validateMacosManagedPf(payload, failures) {
  const managed = payload?.managedPf;
  requireField(managed?.requested === true, "managedPf.requested must be true", failures);
  requireField(
    payload?.denyMechanism ===
      "managed-pf isolated-group deny with per-rule blocked-attempt counters and PKTAP escape attribution",
    "denyMechanism must combine isolated-group PF counters and PKTAP escape attribution",
    failures,
  );
  requireField(typeof managed?.anchor === "string" && managed.anchor.length > 0, "managedPf.anchor must be recorded", failures);
  requireField(
    typeof managed?.rules === "string" &&
      managed.rules.includes("block drop out quick"),
    "managedPf.rules must include the outbound block rule",
    failures,
  );
  requireField(
    typeof managed?.rules === "string" &&
      Number.isInteger(payload?.executionIdentity?.uid) &&
      managed.rules.includes(` user ${payload.executionIdentity.uid}`),
    "managedPf.rules must scope the deny rule to the invoking desktop user",
    failures,
  );
  requireField(
    typeof managed?.rules === "string" &&
      Number.isInteger(managed?.executionGid) &&
      managed.rules.includes(` group ${managed.executionGid}`),
    "managedPf.rules must scope the deny rule to the isolated execution group",
    failures,
  );
  requireField(managed?.anchorLoaded === true, "managed PF anchor must be loaded", failures);
  requireField(
    Number.isInteger(managed?.executionGid) && managed.executionGid > 0,
    "managed PF proof must record the isolated execution GID",
    failures,
  );
  requireField(
    managed?.countersReset === true,
    "managed PF application counters must be reset after the sentinel",
    failures,
  );
  requireField(
    managed?.sentinelRuleStats?.parsed === true &&
      managed.sentinelRuleStats.ruleCount === 2 &&
      managed.sentinelRuleStats.packets > 0,
    "managed PF sentinel counters must record blocked packets",
    failures,
  );
  requireField(
    managed?.applicationBaselineRuleStats?.parsed === true &&
      managed.applicationBaselineRuleStats.ruleCount === 2 &&
      managed.applicationBaselineRuleStats.packets === 0,
    "managed PF application counter baseline must be zero",
    failures,
  );
  requireField(
    managed?.applicationRuleStats?.parsed === true &&
      managed.applicationRuleStats.ruleCount === 2 &&
      managed.applicationRuleStats.packets === 0,
    "managed PF application counters must remain zero",
    failures,
  );
  requireField(managed?.anchorFlushed === true, "managed PF anchor must be flushed", failures);
  requireField(managed?.enableTokenReleased === true, "managed PF enable token must be released", failures);
  requireField(!managed?.cleanupError, "managed PF cleanup must not report an error", failures);
}

function validateDenyLayerProbe(payload, failures) {
  const probe = payload?.denyLayerProbe;
  requireField(probe?.attempted === true, "denyLayerProbe.attempted must be true", failures);
  requireField(probe?.blocked === true, "denyLayerProbe.blocked must be true", failures);
  requireField(typeof probe?.target === "string" && probe.target.length > 0, "denyLayerProbe.target must be recorded", failures);
  requireField(typeof probe?.reason === "string" && probe.reason.length > 0, "denyLayerProbe.reason must be recorded", failures);
}

function expectedNetworkProofKind(osName) {
  if (osName === "windows") return "m0-network-deny-windows";
  if (osName === "linux") return "m0-network-deny-linux";
  if (osName === "macos") return "m0-network-deny-macos";
  return null;
}

function validateSmokeProof(payload) {
  const failures = [];
  requireField(payload?.ok === true, "ok must be true", failures);
  requireField(payload?.proofKind === "m0-packaged-runtime-smoke", "proofKind must be m0-packaged-runtime-smoke", failures);
  validateSourceProvenance(payload, "packaged smoke", failures);
  requireField(payload?.appIsPackaged === true, "appIsPackaged must be true", failures);
  requireField(payload?.rendererBridge?.preloadBridgePresent === true, "renderer preload bridge must be present", failures);
  requireField(
    payload?.rendererIsolationProbe?.attempted === true,
    "renderer isolation probe must run",
    failures,
  );
  requireField(
    payload?.rendererIsolationProbe?.candorPresent === true,
    "renderer isolation probe must find the Candor bridge",
    failures,
  );
  requireField(
    payload?.rendererIsolationProbe?.coreFrozen === true &&
      payload?.rendererIsolationProbe?.shellFrozen === true,
    "renderer isolation probe must show frozen bridge surfaces",
    failures,
  );
  requireField(
    payload?.rendererIsolationProbe?.nodeRequireAvailable === false &&
      payload?.rendererIsolationProbe?.nodeProcessAvailable === false &&
      payload?.rendererIsolationProbe?.ipcRendererAvailable === false &&
      payload?.rendererIsolationProbe?.electronGlobalAvailable === false,
    "renderer isolation probe must deny Node and Electron globals",
    failures,
  );
  requireField(
    Array.isArray(payload?.rendererIsolationProbe?.forbiddenGlobalsPresent) &&
      payload.rendererIsolationProbe.forbiddenGlobalsPresent.length === 0,
    "renderer isolation probe must find zero forbidden globals",
    failures,
  );
  requireField(
    Array.isArray(payload?.rendererIsolationProbe?.forbiddenCoreKeysPresent) &&
      payload.rendererIsolationProbe.forbiddenCoreKeysPresent.length === 0,
    "renderer isolation probe must find zero private core bridge methods",
    failures,
  );
  requireField(
    Array.isArray(payload?.rendererIsolationProbe?.forbiddenShellKeysPresent) &&
      payload.rendererIsolationProbe.forbiddenShellKeysPresent.length === 0,
    "renderer isolation probe must find zero private shell bridge methods",
    failures,
  );
  requireField(
    payload?.rendererIsolationProbe?.coreKeys?.includes("transcriptionRunLocal") &&
      payload?.rendererIsolationProbe?.coreKeys?.includes("modelsImportFromFile"),
    "renderer isolation probe must find typed transcription and model import methods",
    failures,
  );
  requireField(
    !payload?.rendererIsolationProbe?.shellKeys?.includes("openExternal"),
    "renderer isolation probe must not expose openExternal",
    failures,
  );
  requireField(
    payload?.rendererIsolationProbe?.rawPathExposed === false &&
      payload?.rendererIsolationProbe?.keyMaterialExposedToRenderer === false,
    "renderer isolation probe must not expose raw paths or key material",
    failures,
  );
  requireField(
    payload?.rendererBridge?.status?.sidecarTransport === "stdio-json-lines",
    "renderer status must report stdio-json-lines",
    failures,
  );
  requireField(
    payload?.mainRpc?.status?.sidecarTransport === "stdio-json-lines",
    "main RPC status must report stdio-json-lines",
    failures,
  );
  requireField(
    payload?.rendererBridge?.status?.protocolVersion === expectedProtocolVersion,
    "renderer status must report expected protocol version",
    failures,
  );
  requireField(
    payload?.mainRpc?.status?.protocolVersion === expectedProtocolVersion,
    "main RPC status must report expected protocol version",
    failures,
  );
  requireField(
    payload?.rendererBridge?.status?.networkPolicy === "disabled-by-default",
    "renderer status must report disabled-by-default network policy",
    failures,
  );
  requireField(
    payload?.rendererBridge?.supervisorStatus?.lastHandshake?.ok === true,
    "renderer supervisor handshake must be ok",
    failures,
  );
  requireField(
    payload?.rendererBridge?.supervisorStatus?.lastHandshake?.version?.protocolVersion === expectedProtocolVersion,
    "renderer supervisor handshake must report expected protocol version",
    failures,
  );
  requireField(
    payload?.sidecarSupervisor?.lastHandshake?.ok === true,
    "main supervisor handshake must be ok",
    failures,
  );
  requireField(
    payload?.sidecarSupervisor?.lastHandshake?.version?.protocolVersion === expectedProtocolVersion,
    "main supervisor handshake must report expected protocol version",
    failures,
  );
  requireField(
    payload?.sidecarSupervisor?.state === "running",
    "main supervisor state must be running after smoke restart",
    failures,
  );
  requireField(
    numberValue(payload?.sidecarSupervisor?.restartCount) >= 1,
    "main supervisor restart count must show at least one restart",
    failures,
  );
  requireField(
    payload?.restartExercise?.before?.lastHandshake?.ok === true,
    "restart exercise must record a successful pre-restart handshake",
    failures,
  );
  requireField(
    payload?.restartExercise?.before?.lastHandshake?.version?.protocolVersion === expectedProtocolVersion,
    "restart exercise pre-restart handshake must report expected protocol version",
    failures,
  );
  requireField(
    payload?.restartExercise?.after?.lastHandshake?.ok === true,
    "restart exercise must record a successful post-restart handshake",
    failures,
  );
  requireField(
    payload?.restartExercise?.after?.lastHandshake?.version?.protocolVersion === expectedProtocolVersion,
    "restart exercise post-restart handshake must report expected protocol version",
    failures,
  );
  requireField(
    numberValue(payload?.restartExercise?.after?.restartCount) >
      numberValue(payload?.restartExercise?.before?.restartCount),
    "restart exercise must increase restart count",
    failures,
  );
  requireField(
    payload?.restartExercise?.status?.sidecarTransport === "stdio-json-lines",
    "restart exercise status must report stdio-json-lines",
    failures,
  );
  requireField(
    payload?.restartExercise?.status?.protocolVersion === expectedProtocolVersion,
    "restart exercise status must report expected protocol version",
    failures,
  );
  requireField(
    payload?.rendererBridge?.supervisorStatus?.pid === payload?.rendererBridge?.status?.pid,
    "renderer supervisor PID must match renderer status PID",
    failures,
  );
  requireField(
    payload?.sidecarSupervisor?.pid === payload?.mainRpc?.status?.pid,
    "main supervisor PID must match main status PID",
    failures,
  );
  requireField(
    payload?.rendererBridge?.capabilities?.deniedCapabilities?.includes("localhostTcp"),
    "capabilities must deny localhostTcp",
    failures,
  );
  requireField(
    Number.isInteger(payload?.rendererBridge?.capabilities?.maxRpcFrameBytes) &&
      payload.rendererBridge.capabilities.maxRpcFrameBytes >= 1024,
    "capabilities must report maxRpcFrameBytes",
    failures,
  );
  requireField(
    payload?.rendererBridge?.vaultStatus?.backend === "sqlcipher",
    "vault status must report SQLCipher backend",
    failures,
  );
  requireField(
    payload?.rendererBridge?.vaultStatus?.sqlcipherAvailable === true,
    "vault status must report SQLCipher availability",
    failures,
  );
  requireField(
    payload?.rendererBridge?.vaultStatus?.keyMaterialExposedToRenderer === false,
    "vault status must not expose key material",
    failures,
  );
  requireField(
    payload?.rendererBridge?.vaultStatus?.rawPathExposed === false,
    "vault status must not expose raw paths",
    failures,
  );
  requireField(
    payload?.rendererBridge?.transcriptionStatus?.localOnly === true,
    "transcription status must report local-only operation",
    failures,
  );
  requireField(
    payload?.rendererBridge?.transcriptionStatus?.cloudAi === false,
    "transcription status must deny cloud AI",
    failures,
  );
  requireField(
    payload?.rendererBridge?.transcriptionStatus?.engine === "whisper-rs",
    "transcription status must report whisper-rs",
    failures,
  );
  requireField(
    payload?.rendererBridge?.transcriptionStatus?.whisperFeatureEnabled === true,
    "packaged transcription status must report local Whisper feature enabled",
    failures,
  );
  requireField(
    payload?.rendererBridge?.transcriptionStatus?.modelPathAcceptedFromRenderer === false,
    "transcription status must deny renderer model paths",
    failures,
  );
  requireField(
    payload?.rendererBridge?.transcriptionStatus?.rawPathExposed === false,
    "transcription status must not expose raw paths",
    failures,
  );
  requireField(
    payload?.rendererBridge?.transcriptionStatus?.keyMaterialExposedToRenderer === false,
    "transcription status must not expose key material",
    failures,
  );
  if (payload?.platform === "win32") {
    requireField(
      payload?.rendererBridge?.vaultStatus?.osKeyStorage === "dpapi-proof-available",
      "Windows vault status must report DPAPI proof availability",
      failures,
    );
    requireField(
      payload?.rendererBridge?.vaultStatusBeforeOpen?.localOpenAvailable === true,
      "Windows vault status before open must report local open availability",
      failures,
    );
    requireField(
      payload?.rendererBridge?.vaultOpenLocal?.backend === "sqlcipher" &&
        payload?.rendererBridge?.vaultOpenLocal?.encrypted === true &&
        payload?.rendererBridge?.vaultOpenLocal?.openMode === "os-key" &&
        payload?.rendererBridge?.vaultOpenLocal?.passphraseRequired === false,
      "Windows packaged smoke must open the local OS-key SQLCipher vault",
      failures,
    );
    requireField(
      payload?.rendererBridge?.vaultOpenLocal?.keyMaterialExposedToRenderer === false &&
        payload?.rendererBridge?.vaultOpenLocal?.rawPathExposed === false,
      "Windows packaged vault open must not expose keys or raw paths",
      failures,
    );
  } else {
    const localOpenAvailable = payload?.rendererBridge?.vaultStatusBeforeOpen?.localOpenAvailable === true;
    const expectedLabels = localOpenAvailable
      ? nonWindowsAvailableOsKeyLabels()
      : nonWindowsUnavailableOsKeyLabels();
    requireField(
      expectedLabels.includes(payload?.rendererBridge?.vaultStatus?.osKeyStorage),
      `non-Windows vault status must report ${localOpenAvailable ? "available" : "unavailable"} native key storage`,
      failures,
    );
    if (localOpenAvailable) {
      requireField(
        payload?.rendererBridge?.vaultOpenLocal?.backend === "sqlcipher" &&
          payload?.rendererBridge?.vaultOpenLocal?.encrypted === true &&
          payload?.rendererBridge?.vaultOpenLocal?.openMode === "os-key" &&
          payload?.rendererBridge?.vaultOpenLocal?.passphraseRequired === false,
        "non-Windows packaged smoke must open the local OS-key SQLCipher vault when native storage is available",
        failures,
      );
      requireField(
        payload?.rendererBridge?.vaultOpenLocal?.keyMaterialExposedToRenderer === false &&
          payload?.rendererBridge?.vaultOpenLocal?.rawPathExposed === false,
        "non-Windows packaged vault open must not expose keys or raw paths",
        failures,
      );
    } else {
      requireField(
        payload?.rendererBridge?.vaultOpenLocal?.skipped === true &&
          payload?.rendererBridge?.vaultOpenLocal?.reason === "native-os-key-storage-unavailable" &&
          payload?.rendererBridge?.vaultOpenLocal?.keyMaterialExposedToRenderer === false &&
          payload?.rendererBridge?.vaultOpenLocal?.rawPathExposed === false,
        "non-Windows packaged smoke must report safe unavailable vault-open state",
        failures,
      );
    }
  }
  requireField(
    payload?.rendererBridge?.auditSnapshot?.externalCallsAttempted === 0,
    "privacy audit must report zero external calls attempted",
    failures,
  );
  requireField(
    payload?.sessionNetworkGuard?.externalAllowedRequests === 0,
    "session guard must report zero external allowed requests",
    failures,
  );
  requireField(
    payload?.networkBlockProbe?.renderer?.fetch?.attempted === true &&
      payload?.networkBlockProbe?.renderer?.fetch?.blocked === true,
    "network block probe must prove renderer fetch denial",
    failures,
  );
  requireField(
    payload?.networkBlockProbe?.renderer?.windowOpen?.attempted === true &&
      payload?.networkBlockProbe?.renderer?.windowOpen?.denied === true,
    "network block probe must prove external window-open denial",
    failures,
  );
  requireField(
    payload?.networkBlockProbe?.renderer?.navigation?.attempted === true &&
      payload?.networkBlockProbe?.renderer?.navigation?.stayedInApp === true,
    "network block probe must prove external navigation denial",
    failures,
  );
  requireField(
    payload?.networkBlockProbe?.renderer?.externalAllowedDelta === 0,
    "renderer network block probe must allow zero external requests",
    failures,
  );
  requireField(
    numberValue(payload?.networkBlockProbe?.renderer?.deniedWindowOpenDelta) >= 1 &&
      numberValue(payload?.networkBlockProbe?.renderer?.deniedNavigationDelta) >= 1,
    "renderer network block probe must increment denial counters",
    failures,
  );
  requireField(
    payload?.networkBlockProbe?.sessionGuard?.fetch?.attempted === true &&
      payload?.networkBlockProbe?.sessionGuard?.fetch?.blocked === true,
    "network block probe must prove session fetch denial",
    failures,
  );
  requireField(
    payload?.networkBlockProbe?.sessionGuard?.externalAllowedDelta === 0,
    "session network block probe must allow zero external requests",
    failures,
  );
  requireField(
    numberValue(payload?.networkBlockProbe?.sessionGuard?.blockedDelta) >= 1,
    "session network block probe must increment blocked request count",
    failures,
  );
  requireField(
    payload?.networkBlockProbe?.rawPathExposed === false,
    "network block probe must not expose raw paths",
    failures,
  );
  requireField(
    payload?.networkBlockProbe?.renderer?.before?.blockedRequests === 0,
    "session guard must report zero blocked requests before the explicit network probe",
    failures,
  );
  for (const artifactName of ["appExecutable", "coreExecutable", "appArchive"]) {
    requireField(
      payload?.packagedArtifacts?.[artifactName]?.exists === true,
      `packagedArtifacts.${artifactName} must exist`,
      failures,
    );
    requireField(
      typeof payload?.packagedArtifacts?.[artifactName]?.sha256 === "string" &&
        payload.packagedArtifacts[artifactName].sha256.length === 64,
      `packagedArtifacts.${artifactName} must include sha256`,
      failures,
    );
    requireField(
      numberValue(payload?.packagedArtifacts?.[artifactName]?.bytes) > 0,
      `packagedArtifacts.${artifactName} must include byte size`,
      failures,
    );
  }
  return failures;
}

function validateSmokeManifestPair(smokePayload, manifestPayload) {
  const failures = [];
  requireField(
    smokePayload?.platform === manifestPayload?.platform,
    "smoke platform must match manifest platform",
    failures,
  );
  requireField(
    smokePayload?.arch === manifestPayload?.arch,
    "smoke arch must match manifest arch",
    failures,
  );
  requireField(smokePayload?.git?.head === manifestPayload?.git?.head, "smoke git head must match manifest git head", failures);
  requireField(smokePayload?.git?.dirty === manifestPayload?.git?.dirty, "smoke dirty flag must match manifest dirty flag", failures);
  if (smokePayload?.ci?.githubActions === true || manifestPayload?.ci?.githubActions === true) {
    requireField(smokePayload?.ci?.githubActions === true, "smoke CI provenance must be present", failures);
    requireField(manifestPayload?.ci?.githubActions === true, "manifest CI provenance must be present", failures);
    requireField(smokePayload?.ci?.runId === manifestPayload?.ci?.runId, "smoke CI run id must match manifest", failures);
    requireField(smokePayload?.ci?.runAttempt === manifestPayload?.ci?.runAttempt, "smoke CI run attempt must match manifest", failures);
    requireField(smokePayload?.ci?.sha === manifestPayload?.ci?.sha, "smoke CI sha must match manifest", failures);
  }
  for (const artifactName of ["appExecutable", "coreExecutable", "appArchive"]) {
    requireField(
      smokePayload?.packagedArtifacts?.[artifactName]?.sha256 ===
        manifestPayload?.packaged?.[artifactName]?.sha256,
      `${artifactName} sha256 must match manifest`,
      failures,
    );
    requireField(
      smokePayload?.packagedArtifacts?.[artifactName]?.bytes ===
        manifestPayload?.packaged?.[artifactName]?.bytes,
      `${artifactName} byte size must match manifest`,
      failures,
    );
  }
  return failures;
}

function validateV3ManifestPair(v3Payload, manifestPayload) {
  const failures = [];
  requireField(v3Payload?.platform === manifestPayload?.platform, "staged verification platform must match manifest platform", failures);
  requireField(v3Payload?.arch === manifestPayload?.arch, "staged verification arch must match manifest arch", failures);
  requireField(v3Payload?.git?.head === manifestPayload?.git?.head, "staged verification git head must match manifest git head", failures);
  requireField(v3Payload?.git?.dirty === manifestPayload?.git?.dirty, "staged verification dirty flag must match manifest dirty flag", failures);

  if (v3Payload?.ci?.githubActions === true || manifestPayload?.ci?.githubActions === true) {
    requireField(v3Payload?.ci?.githubActions === true, "staged verification CI provenance must be present", failures);
    requireField(manifestPayload?.ci?.githubActions === true, "manifest CI provenance must be present", failures);
    requireField(v3Payload?.ci?.runId === manifestPayload?.ci?.runId, "staged verification CI run id must match manifest", failures);
    requireField(
      v3Payload?.ci?.runAttempt === manifestPayload?.ci?.runAttempt,
      "staged verification CI run attempt must match manifest",
      failures,
    );
    requireField(v3Payload?.ci?.sha === manifestPayload?.ci?.sha, "staged verification CI sha must match manifest", failures);
  }

  return failures;
}

function sourceIdentityMatchEvidence(v3Payload, manifestCandidate) {
  return {
    status: "matched",
    manifestFile: manifestCandidate.file,
    gitHead: v3Payload?.git?.head ?? null,
    dirty: v3Payload?.git?.dirty ?? null,
    ci: {
      githubActions: v3Payload?.ci?.githubActions === true,
      runId: v3Payload?.ci?.runId ?? null,
      runAttempt: v3Payload?.ci?.runAttempt ?? null,
      sha: v3Payload?.ci?.sha ?? null,
    },
  };
}

function artifactHashMatchEvidence(smokePayload, manifestCandidate) {
  const artifacts = {};
  for (const artifactName of ["appExecutable", "coreExecutable", "appArchive"]) {
    const smokeArtifact = smokePayload?.packagedArtifacts?.[artifactName] ?? {};
    const manifestArtifact = manifestCandidate?.payload?.packaged?.[artifactName] ?? {};
    artifacts[artifactName] = {
      sha256: smokeArtifact.sha256 ?? null,
      manifestSha256: manifestArtifact.sha256 ?? null,
      sha256Match: smokeArtifact.sha256 === manifestArtifact.sha256,
      bytes: smokeArtifact.bytes ?? null,
      manifestBytes: manifestArtifact.bytes ?? null,
      bytesMatch: smokeArtifact.bytes === manifestArtifact.bytes,
    };
  }
  return {
    status: "matched",
    manifestFile: manifestCandidate.file,
    sourceIdentity: {
      gitHead: smokePayload?.git?.head ?? null,
      dirty: smokePayload?.git?.dirty ?? null,
      ci: {
        githubActions: smokePayload?.ci?.githubActions === true,
        runId: smokePayload?.ci?.runId ?? null,
        runAttempt: smokePayload?.ci?.runAttempt ?? null,
        sha: smokePayload?.ci?.sha ?? null,
      },
    },
    artifacts,
  };
}

function minimalValidSmokeProof() {
  const handshake = {
    ok: true,
    at: "2026-07-10T00:00:00.000Z",
    version: {
      protocolVersion: expectedProtocolVersion,
      version: "0.1.0",
    },
  };
  const status = {
    sidecarTransport: "stdio-json-lines",
    protocolVersion: expectedProtocolVersion,
    networkPolicy: "disabled-by-default",
    pid: 200,
  };
  return {
    ok: true,
    proofKind: "m0-packaged-runtime-smoke",
    platform: "linux",
    arch: "x64",
    git: {
      head: "1".repeat(40),
      dirty: false,
    },
    ci: {
      githubActions: true,
      runId: "1000",
      runAttempt: "1",
      sha: "1".repeat(40),
    },
    appIsPackaged: true,
    rendererIsolationProbe: {
      attempted: true,
      candorPresent: true,
      coreFrozen: true,
      shellFrozen: true,
      coreKeys: ["modelsImportFromFile", "transcriptionRunLocal"],
      shellKeys: ["externalNavigationDisabled", "networkPolicy", "supervisorStatus"],
      forbiddenCoreKeysPresent: [],
      forbiddenShellKeysPresent: [],
      forbiddenGlobalsPresent: [],
      nodeRequireAvailable: false,
      nodeProcessAvailable: false,
      ipcRendererAvailable: false,
      electronGlobalAvailable: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    },
    rendererBridge: {
      preloadBridgePresent: true,
      supervisorStatus: {
        state: "running",
        restartCount: 1,
        pid: 200,
        lastHandshake: handshake,
      },
      status,
      capabilities: {
        deniedCapabilities: ["localhostTcp"],
        maxRpcFrameBytes: 1024 * 1024,
      },
      vaultStatusBeforeOpen: {
        backend: "sqlcipher",
        sqlcipherAvailable: true,
        localOpenAvailable: false,
        osKeyStorage: "secret-service-unavailable",
        keyMaterialExposedToRenderer: false,
        rawPathExposed: false,
      },
      vaultStatus: {
        backend: "sqlcipher",
        sqlcipherAvailable: true,
        localOpenAvailable: false,
        osKeyStorage: "secret-service-unavailable",
        keyMaterialExposedToRenderer: false,
        rawPathExposed: false,
      },
      vaultOpenLocal: {
        skipped: true,
        reason: "native-os-key-storage-unavailable",
        keyMaterialExposedToRenderer: false,
        rawPathExposed: false,
      },
      transcriptionStatus: {
        localOnly: true,
        cloudAi: false,
        engine: "whisper-rs",
        whisperFeatureEnabled: true,
        modelPathAcceptedFromRenderer: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      },
      auditSnapshot: {
        externalCallsAttempted: 0,
      },
    },
    mainRpc: {
      status,
    },
    sidecarSupervisor: {
      state: "running",
      restartCount: 1,
      pid: 200,
      lastHandshake: handshake,
    },
    restartExercise: {
      before: {
        restartCount: 0,
        lastHandshake: handshake,
      },
      after: {
        restartCount: 1,
        lastHandshake: handshake,
      },
      status,
    },
    sessionNetworkGuard: {
      externalAllowedRequests: 0,
      blockedRequests: 1,
      deniedWindowOpenRequests: 1,
      deniedNavigationRequests: 1,
    },
    networkBlockProbe: {
      renderer: {
        before: {
          blockedRequests: 0,
          externalAllowedRequests: 0,
          deniedWindowOpenRequests: 0,
          deniedNavigationRequests: 0,
        },
        after: {
          blockedRequests: 0,
          externalAllowedRequests: 0,
          deniedWindowOpenRequests: 1,
          deniedNavigationRequests: 1,
        },
        fetch: {
          attempted: true,
          blocked: true,
        },
        windowOpen: {
          attempted: true,
          denied: true,
        },
        navigation: {
          attempted: true,
          stayedInApp: true,
        },
        externalAllowedDelta: 0,
        blockedDelta: 0,
        deniedWindowOpenDelta: 1,
        deniedNavigationDelta: 1,
      },
      sessionGuard: {
        before: {
          blockedRequests: 0,
          externalAllowedRequests: 0,
        },
        after: {
          blockedRequests: 1,
          externalAllowedRequests: 0,
        },
        fetch: {
          attempted: true,
          blocked: true,
        },
        externalAllowedDelta: 0,
        blockedDelta: 1,
      },
      rawPathExposed: false,
    },
    packagedArtifacts: {
      appExecutable: {
        exists: true,
        bytes: 100,
        sha256: "a".repeat(64),
      },
      coreExecutable: {
        exists: true,
        bytes: 101,
        sha256: "b".repeat(64),
      },
      appArchive: {
        exists: true,
        bytes: 102,
        sha256: "c".repeat(64),
      },
    },
  };
}

function minimalValidDenyLayerProbe() {
  return {
    attempted: true,
    target: "1.1.1.1:443",
    blocked: true,
    reason: "ENETUNREACH",
    durationMs: 5,
  };
}

function minimalValidManifestProof() {
  return {
    ok: true,
    proofKind: "m0-artifact-manifest",
    platform: "linux",
    arch: "x64",
    git: {
      head: "1".repeat(40),
      dirty: false,
    },
    ci: {
      githubActions: true,
      runId: "1000",
      runAttempt: "1",
      sha: "1".repeat(40),
    },
    packaged: {
      appExecutable: {
        exists: true,
        bytes: 100,
        sha256: "a".repeat(64),
      },
      coreExecutable: {
        exists: true,
        bytes: 101,
        sha256: "b".repeat(64),
      },
      appArchive: {
        exists: true,
        bytes: 102,
        sha256: "c".repeat(64),
      },
    },
    releaseArtifacts: [
      {
        kind: "linux-appimage",
        exists: true,
        bytes: 103,
        sha256: "d".repeat(64),
      },
      {
        kind: "linux-deb",
        exists: true,
        bytes: 104,
        sha256: "e".repeat(64),
      },
    ],
    sources: [],
  };
}

function minimalValidV3VerificationProof() {
  return {
    ok: true,
    proofKind: "v3-local-verification",
    platform: "linux",
    arch: "x64",
    git: {
      head: "1".repeat(40),
      dirty: false,
    },
    ci: {
      githubActions: true,
      runId: "1000",
      runAttempt: "1",
      sha: "1".repeat(40),
    },
    steps: [
      "M0 CI contract smoke",
      "M0 local verification",
      "V3 source security proof",
      "V3 updater policy proof",
      "M1 durable capture and consent",
      "M1 SQLCipher vault",
      "M2 walking skeleton",
      "M3 product surface",
      "M4 local AI fallback",
      "M5 importer",
      "Vitest regression suite",
    ].map((name) => ({
      name,
      command: `test ${name}`,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      ok: true,
    })),
  };
}

function minimalValidReleaseArtifactSmokeProof() {
  return {
    ok: true,
    proofKind: "v3-release-artifact-smoke",
    platform: "win32",
    arch: "x64",
    localOnly: true,
    cloudAi: false,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
    currentPlatform: {
      ok: true,
      extractionAttempted: true,
      installer: {
        exists: true,
        bytes: 100,
        sha256: "a".repeat(64),
      },
      requiredEntries: [
        {
          extractedPath: "Candor v3 M0.exe",
          exists: true,
          hashMatchesUnpacked: true,
        },
        {
          extractedPath: "resources/app.asar",
          exists: true,
          hashMatchesUnpacked: true,
        },
        {
          extractedPath: "resources/bin/candor-core.exe",
          exists: true,
          hashMatchesUnpacked: true,
        },
      ],
    },
    releaseGaps: ["production signing is verified by the separate release-signing gate"],
    failures: [],
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertSelfTest(condition, message) {
  if (!condition) {
    throw new Error(`M0 proof audit self-test failed: ${message}`);
  }
}

function assertSelfTestFailure(name, mutate, expectedMessagePart) {
  const payload = cloneJson(minimalValidSmokeProof());
  mutate(payload);
  const failures = validateSmokeProof(payload);
  assertSelfTest(
    failures.some((failure) => failure.includes(expectedMessagePart)),
    `${name} did not fail with ${expectedMessagePart}. Actual failures: ${failures.join("; ")}`,
  );
}

function runSelfTest() {
  const tempDir = mkdtempSync(join(tmpdir(), "candor-m0-proof-audit-"));
  try {
    const bomJsonPath = join(tempDir, "bom.json");
    writeFileSync(bomJsonPath, `\uFEFF${JSON.stringify({ ok: true })}`, "utf8");
    assertSelfTest(readJson(bomJsonPath).ok === true, "readJson must accept UTF-8 BOM JSON");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  const validSmoke = minimalValidSmokeProof();
  const validManifest = minimalValidManifestProof();
  const validV3Verification = minimalValidV3VerificationProof();
  const validReleaseArtifactSmoke = minimalValidReleaseArtifactSmokeProof();
  assertSelfTest(validateSmokeProof(validSmoke).length === 0, "valid smoke proof should pass");
  assertSelfTest(validateManifestProof(validManifest).length === 0, "valid manifest proof should pass");
  assertSelfTest(
    validateV3VerificationProof(validV3Verification).length === 0,
    "valid v3 staged verification proof should pass",
  );
  assertSelfTest(
    validateReleaseArtifactSmokeProof("windows", validReleaseArtifactSmoke).length === 0,
    "valid release artifact smoke proof should pass",
  );
  const mismatchedReleaseArtifactSmoke = cloneJson(validReleaseArtifactSmoke);
  mismatchedReleaseArtifactSmoke.currentPlatform.requiredEntries.find(
    (entry) => entry.extractedPath === "resources/bin/candor-core.exe",
  ).hashMatchesUnpacked = false;
  assertSelfTest(
    validateReleaseArtifactSmokeProof("windows", mismatchedReleaseArtifactSmoke).some((failure) =>
      failure.includes("Windows installer payload must match unpacked hash for resources/bin/candor-core.exe"),
    ),
    "release artifact smoke proof must fail when sidecar payload does not match unpacked output",
  );
  assertSelfTest(
    validateSmokeManifestPair(validSmoke, validManifest).length === 0,
    "valid smoke and manifest proofs should match",
  );
  const mismatchedSmokeIdentity = cloneJson(validSmoke);
  mismatchedSmokeIdentity.git.head = "3".repeat(40);
  assertSelfTest(
    validateSmokeManifestPair(mismatchedSmokeIdentity, validManifest).some((failure) =>
      failure.includes("smoke git head must match manifest git head"),
    ),
    "packaged smoke proof must fail when git head differs from manifest",
  );
  assertSelfTest(
    validateV3ManifestPair(validV3Verification, validManifest).length === 0,
    "valid v3 staged verification proof and manifest should share source identity",
  );
  const mismatchedV3Identity = cloneJson(validV3Verification);
  mismatchedV3Identity.git.head = "2".repeat(40);
  assertSelfTest(
    validateV3ManifestPair(mismatchedV3Identity, validManifest).some((failure) =>
      failure.includes("staged verification git head must match manifest git head"),
    ),
    "v3 staged verification proof must fail when git head differs from manifest",
  );
  const validHashEvidence = artifactHashMatchEvidence(validSmoke, { file: "manifest.json", payload: validManifest });
  assertSelfTest(
    validHashEvidence.artifacts.coreExecutable.sha256Match === true &&
      validHashEvidence.artifacts.coreExecutable.bytesMatch === true,
    "artifact hash match evidence should show core executable match",
  );

  assertSelfTestFailure(
    "missing renderer isolation probe",
    (payload) => {
      delete payload.rendererIsolationProbe;
    },
    "renderer isolation probe must run",
  );
  assertSelfTestFailure(
    "renderer exposes Node global",
    (payload) => {
      payload.rendererIsolationProbe.nodeProcessAvailable = true;
      payload.rendererIsolationProbe.forbiddenGlobalsPresent = ["process"];
    },
    "renderer isolation probe must deny Node and Electron globals",
  );
  assertSelfTestFailure(
    "renderer exposes private core method",
    (payload) => {
      payload.rendererIsolationProbe.forbiddenCoreKeysPresent = ["modelsImportStart"];
    },
    "renderer isolation probe must find zero private core bridge methods",
  );

  assertSelfTestFailure(
    "missing sidecar supervisor",
    (payload) => {
      delete payload.sidecarSupervisor;
    },
    "main supervisor handshake must be ok",
  );
  assertSelfTestFailure(
    "missing restart exercise",
    (payload) => {
      delete payload.restartExercise;
    },
    "restart exercise must increase restart count",
  );
  assertSelfTestFailure(
    "wrong protocol",
    (payload) => {
      payload.sidecarSupervisor.lastHandshake.version.protocolVersion = "old-protocol";
    },
    "main supervisor handshake must report expected protocol version",
  );
  assertSelfTestFailure(
    "stale restart count",
    (payload) => {
      payload.restartExercise.after.restartCount = payload.restartExercise.before.restartCount;
    },
    "restart exercise must increase restart count",
  );
  assertSelfTestFailure(
    "missing artifact hash evidence",
    (payload) => {
      delete payload.packagedArtifacts.coreExecutable.sha256;
    },
    "packagedArtifacts.coreExecutable must include sha256",
  );

  const mismatchedManifest = cloneJson(validManifest);
  mismatchedManifest.packaged.coreExecutable.sha256 = "d".repeat(64);
  assertSelfTest(
    validateSmokeManifestPair(validSmoke, mismatchedManifest).some((failure) =>
      failure.includes("coreExecutable sha256 must match manifest"),
    ),
    "smoke proof must fail artifact hash mismatch with manifest",
  );

  const missingV3Step = cloneJson(validV3Verification);
  missingV3Step.steps = missingV3Step.steps.filter((step) => step.name !== "M3 product surface");
  assertSelfTest(
    validateV3VerificationProof(missingV3Step).some((failure) =>
      failure.includes("required step missing: M3 product surface"),
    ),
    "v3 staged proof must fail when a required step is missing",
  );

  const failedV3Step = cloneJson(validV3Verification);
  const failedDurableStep = failedV3Step.steps.find(
    (step) => step.name === "M1 durable capture and consent",
  );
  failedDurableStep.ok = false;
  failedDurableStep.exitCode = 1;
  assertSelfTest(
    validateV3VerificationProof(failedV3Step).some((failure) =>
      failure.includes("step failed: M1 durable capture and consent"),
    ),
    "v3 staged proof must fail when a step failed",
  );

  const networkFailures = validateNetworkProof("linux", {
    ok: true,
    proofKind: "m0-network-deny-linux",
    denyMechanism: "unshare --net",
    applicationUidNonRoot: true,
    applicationRunsAsRoot: false,
    denyLayerProbe: minimalValidDenyLayerProbe(),
    smokeProof: validSmoke,
  });
  assertSelfTest(networkFailures.length === 0, "valid embedded smoke proof should pass network proof");

  const rootApplicationFailures = validateNetworkProof("linux", {
    ok: true,
    proofKind: "m0-network-deny-linux",
    denyMechanism: "unshare --net",
    applicationUidNonRoot: false,
    applicationRunsAsRoot: true,
    denyLayerProbe: minimalValidDenyLayerProbe(),
    smokeProof: validSmoke,
  });
  assertSelfTest(
    rootApplicationFailures.some((failure) => failure.includes("packaged application must run as a non-root user")),
    "Linux network proof must fail when the packaged application runs as root",
  );

  const connectedDenyLayerFailures = validateNetworkProof("linux", {
    ok: true,
    proofKind: "m0-network-deny-linux",
    denyMechanism: "unshare --net",
    applicationUidNonRoot: true,
    applicationRunsAsRoot: false,
    denyLayerProbe: {
      ...minimalValidDenyLayerProbe(),
      blocked: false,
      reason: "connected",
    },
    smokeProof: validSmoke,
  });
  assertSelfTest(
    connectedDenyLayerFailures.some((failure) => failure.includes("denyLayerProbe.blocked must be true")),
    "Linux network proof must fail when the deny sentinel connects",
  );

  const windowsReleaseDir = "C:\\Candor";
  const windowsAppPath = `${windowsReleaseDir}\\win-unpacked\\Candor v3 M0.exe`;
  const windowsCorePath = `${windowsReleaseDir}\\win-unpacked\\resources\\bin\\candor-core.exe`;
  const windowsAppArchivePath = `${windowsReleaseDir}\\win-unpacked\\resources\\app.asar`;
  const validWindowsSmoke = cloneJson(validSmoke);
  validWindowsSmoke.executable = windowsAppPath;
  validWindowsSmoke.corePath = windowsCorePath;
  validWindowsSmoke.packagedArtifacts.appExecutable.path = windowsAppPath;
  validWindowsSmoke.packagedArtifacts.coreExecutable.path = windowsCorePath;
  validWindowsSmoke.packagedArtifacts.appArchive.path = windowsAppArchivePath;
  const validWindowsReleaseFields = {
    releaseDir: windowsReleaseDir,
    appPath: windowsAppPath,
    corePath: windowsCorePath,
    appArchivePath: windowsAppArchivePath,
    releaseIdentity: cloneJson(validWindowsSmoke.packagedArtifacts),
    smokeProof: validWindowsSmoke,
  };

  const validWindowsNetworkFailures = validateNetworkProof("windows", {
    ok: true,
    proofKind: "m0-network-deny-windows",
    ...validWindowsReleaseFields,
    cleanup: {
      ruleGroupRemoved: true,
    },
    temporaryFirewallRules: [
      {
        displayName: "app outbound block",
        direction: "Outbound",
        action: "Block",
        enabled: "True",
        program: windowsAppPath,
      },
      {
        displayName: "core outbound block",
        direction: "Outbound",
        action: "Block",
        enabled: "True",
        program: windowsCorePath,
      },
    ],
    observedTcpConnections: [],
    observedUdpEndpoints: [],
  });
  assertSelfTest(validWindowsNetworkFailures.length === 0, "valid Windows network proof should pass");

  const mixedWindowsSmoke = cloneJson(validWindowsSmoke);
  mixedWindowsSmoke.executable = "C:\\OlderCandor\\win-unpacked\\Candor v3 M0.exe";
  const mixedWindowsReleaseFailures = [];
  validateWindowsReleaseIdentity(
    { ...validWindowsReleaseFields, smokeProof: mixedWindowsSmoke },
    mixedWindowsReleaseFailures,
  );
  assertSelfTest(
    mixedWindowsReleaseFailures.some((failure) =>
      failure.includes("embedded smokeProof executable must match appPath"),
    ),
    "Windows network proof must reject a smoke receipt from a different package",
  );

  const tcpObservedWindowsFailures = validateNetworkProof("windows", {
    ok: true,
    proofKind: "m0-network-deny-windows",
    ...validWindowsReleaseFields,
    cleanup: {
      ruleGroupRemoved: true,
    },
    temporaryFirewallRules: [
      {
        displayName: "app outbound block",
        direction: "Outbound",
        action: "Block",
        enabled: "True",
        program: windowsAppPath,
      },
      {
        displayName: "core outbound block",
        direction: "Outbound",
        action: "Block",
        enabled: "True",
        program: windowsCorePath,
      },
    ],
    observedTcpConnections: [{ remoteAddress: "203.0.113.10", remotePort: 443 }],
    observedUdpEndpoints: [],
  });
  assertSelfTest(
    tcpObservedWindowsFailures.some((failure) => failure.includes("observedTcpConnections must be empty")),
    "Windows network proof must fail when TCP connections are observed",
  );

  const udpObservedWindowsFailures = validateNetworkProof("windows", {
    ok: true,
    proofKind: "m0-network-deny-windows",
    ...validWindowsReleaseFields,
    cleanup: {
      ruleGroupRemoved: true,
    },
    temporaryFirewallRules: [
      {
        displayName: "app outbound block",
        direction: "Outbound",
        action: "Block",
        enabled: "True",
        program: windowsAppPath,
      },
      {
        displayName: "core outbound block",
        direction: "Outbound",
        action: "Block",
        enabled: "True",
        program: windowsCorePath,
      },
    ],
    observedTcpConnections: [],
    observedUdpEndpoints: [{ localAddress: "0.0.0.0", localPort: 5353 }],
  });
  assertSelfTest(
    udpObservedWindowsFailures.some((failure) => failure.includes("observedUdpEndpoints must be empty")),
    "Windows network proof must fail when UDP endpoints are observed",
  );

  const missingRuleWindowsFailures = validateNetworkProof("windows", {
    ok: true,
    proofKind: "m0-network-deny-windows",
    ...validWindowsReleaseFields,
    cleanup: {
      ruleGroupRemoved: true,
    },
    temporaryFirewallRules: [],
    observedTcpConnections: [],
    observedUdpEndpoints: [],
  });
  assertSelfTest(
    missingRuleWindowsFailures.some((failure) =>
      failure.includes("temporaryFirewallRules must include app and core block rules"),
    ),
    "Windows network proof must fail without app and core firewall rule evidence",
  );

  const prerequisiteWindowsFailures = validateNetworkProof("windows", {
    ok: false,
    proofKind: "m0-network-deny-windows",
    prerequisiteFailure: "administrator-required",
    error: "Run this script from an elevated PowerShell session so it can create and remove temporary firewall rules.",
    appPath: "C:\\Candor\\Candor v3 M0.exe",
    corePath: "C:\\Candor\\resources\\bin\\candor-core.exe",
    temporaryFirewallRules: [],
    observedTcpConnections: [],
    observedUdpEndpoints: [],
    smokeProof: null,
  });
  assertSelfTest(
    prerequisiteWindowsFailures.length === 1 &&
      prerequisiteWindowsFailures[0].includes("network proof prerequisite failed: administrator-required"),
    "Windows network proof must report prerequisite failures without cascading rule checks",
  );

  const validManagedMacosProof = {
    ok: true,
    proofKind: "m0-network-deny-macos",
    denyMechanism:
      "managed-pf isolated-group deny with per-rule blocked-attempt counters and PKTAP escape attribution",
    applicationUidNonRoot: true,
    applicationRunsAsRoot: false,
    executionIdentity: {
      user: "runner",
      uid: 501,
      gid: 62000,
      groups: [62000],
      isolatedGid: 62000,
      processTreeComplete: true,
    },
    interface: "pktap,all",
    captureConfiguration: {
      mode: "temporary-pcapng-file",
      snapshotLengthBytes: 256,
      metadataFilter: "dir=out",
      rawCaptureRemoved: true,
    },
    packetCount: 0,
    denyLayerProbe: { ...minimalValidDenyLayerProbe(), pid: 1234, uid: 501, gid: 62000 },
    packetAttribution: {
      captureInterface: "pktap,all",
      captureMetadataFilter: "dir=out",
      captureStats: {
        parsed: true,
        captured: 0,
        receivedByFilter: 12,
        kernelDropped: 0,
        metadataFilterDropped: 12,
      },
      captureParse: {
        exitCode: 0,
        error: null,
        stderr: "reading from file fixture.pcapng",
        rawCaptureRemoved: true,
      },
      blockedMetadataSource: "PF per-rule packet counters scoped to an isolated execution GID",
      complete: true,
      packetOverflowCount: 0,
      tcpdumpExitedBeforeCleanup: false,
      applicationPacketCount: 0,
      applicationEscapedPacketCount: 0,
      applicationBlockedPacketCount: 0,
      applicationBaselinePacketCount: 0,
      denyProbeCounted: true,
      denyProbePacketCount: 1,
      observedProcesses: [{ pid: 2000, ppid: 1999, uid: 501, gid: 62000, command: "Candor v3 M0" }],
      processIdentityMismatches: [],
      observedPacketCount: 0,
      packetsWithoutProcessMetadata: [],
      kernelAttributedPacketCount: 0,
      kernelAttributedPacketSamples: [],
    },
    managedPf: {
      requested: true,
      anchor: "com.apple/candor-v3-m0-network-deny-123",
      rules: "block drop out quick proto { tcp udp } all user 501 group 62000",
      anchorLoaded: true,
      executionGid: 62000,
      sentinelRuleStats: { parsed: true, ruleCount: 2, packets: 1, bytes: 64 },
      applicationBaselineRuleStats: { parsed: true, ruleCount: 2, packets: 0, bytes: 0 },
      applicationRuleStats: { parsed: true, ruleCount: 2, packets: 0, bytes: 0 },
      countersReset: true,
      anchorFlushed: true,
      enableTokenReleased: true,
      cleanupError: null,
    },
    smokeProof: validSmoke,
  };
  const validManagedMacosFailures = validateNetworkProof("macos", validManagedMacosProof);
  assertSelfTest(
    validManagedMacosFailures.length === 0,
    `valid managed macOS network proof should pass. Actual failures: ${validManagedMacosFailures.join("; ")}`,
  );

  const staleManagedMacosProof = cloneJson(validManagedMacosProof);
  staleManagedMacosProof.managedPf.anchorFlushed = false;
  const staleManagedMacosFailures = validateNetworkProof("macos", staleManagedMacosProof);
  assertSelfTest(
    staleManagedMacosFailures.some((failure) => failure.includes("managed PF anchor must be flushed")),
    "managed macOS network proof must fail without PF cleanup evidence",
  );

  const staleCounterManagedMacosProof = cloneJson(validManagedMacosProof);
  staleCounterManagedMacosProof.managedPf.applicationRuleStats.packets = 1;
  const staleCounterManagedMacosFailures = validateNetworkProof("macos", staleCounterManagedMacosProof);
  assertSelfTest(
    staleCounterManagedMacosFailures.some((failure) =>
      failure.includes("managed PF application counters must remain zero"),
    ),
    "managed macOS network proof must fail when its isolated-group PF counters record an attempt",
  );

  const escapedIdentityManagedMacosProof = cloneJson(validManagedMacosProof);
  escapedIdentityManagedMacosProof.executionIdentity.processTreeComplete = false;
  escapedIdentityManagedMacosProof.packetAttribution.processIdentityMismatches = [
    { pid: 2001, uid: 501, gid: 20, command: "Candor v3 M0 Helper" },
  ];
  const escapedIdentityManagedMacosFailures = validateNetworkProof(
    "macos",
    escapedIdentityManagedMacosProof,
  );
  assertSelfTest(
    escapedIdentityManagedMacosFailures.some((failure) =>
      failure.includes("must retain the isolated non-root execution identity"),
    ) &&
      escapedIdentityManagedMacosFailures.some((failure) =>
        failure.includes("must not escape the isolated execution identity"),
      ),
    "managed macOS network proof must fail when a packaged process escapes the isolated GID",
  );

  const leakingManagedMacosProof = cloneJson(validManagedMacosProof);
  leakingManagedMacosProof.packetCount = 1;
  leakingManagedMacosProof.packetAttribution.applicationPacketCount = 1;
  const leakingManagedMacosFailures = validateNetworkProof("macos", leakingManagedMacosProof);
  assertSelfTest(
    leakingManagedMacosFailures.some((failure) =>
      failure.includes("Candor-attributed outbound packet count must be zero"),
    ),
    "managed macOS network proof must fail for a Candor-attributed outbound packet",
  );

  const overflowManagedMacosProof = cloneJson(validManagedMacosProof);
  overflowManagedMacosProof.packetAttribution.complete = false;
  overflowManagedMacosProof.packetAttribution.packetOverflowCount = 1;
  const overflowManagedMacosFailures = validateNetworkProof("macos", overflowManagedMacosProof);
  assertSelfTest(
    overflowManagedMacosFailures.some((failure) => failure.includes("PKTAP packet capture must not overflow")),
    "managed macOS network proof must fail when PKTAP evidence overflows",
  );

  const droppedManagedMacosProof = cloneJson(validManagedMacosProof);
  droppedManagedMacosProof.packetAttribution.complete = false;
  droppedManagedMacosProof.packetAttribution.captureStats.kernelDropped = 1;
  const droppedManagedMacosFailures = validateNetworkProof("macos", droppedManagedMacosProof);
  assertSelfTest(
    droppedManagedMacosFailures.some((failure) =>
      failure.includes("PKTAP capture statistics must be complete with zero kernel drops"),
    ),
    "managed macOS network proof must fail when the kernel drops PKTAP evidence",
  );

  const retainedCaptureManagedMacosProof = cloneJson(validManagedMacosProof);
  retainedCaptureManagedMacosProof.packetAttribution.complete = false;
  retainedCaptureManagedMacosProof.captureConfiguration.rawCaptureRemoved = false;
  retainedCaptureManagedMacosProof.packetAttribution.captureParse.rawCaptureRemoved = false;
  const retainedCaptureManagedMacosFailures = validateNetworkProof(
    "macos",
    retainedCaptureManagedMacosProof,
  );
  assertSelfTest(
    retainedCaptureManagedMacosFailures.some((failure) =>
      failure.includes("removed temporary pcapng file"),
    ) &&
      retainedCaptureManagedMacosFailures.some((failure) =>
        failure.includes("removed before proof publication"),
      ),
    "managed macOS network proof must fail when the raw PKTAP trace remains on disk",
  );

  const truncatedManagedMacosProof = cloneJson(validManagedMacosProof);
  truncatedManagedMacosProof.packetAttribution.complete = false;
  truncatedManagedMacosProof.packetAttribution.tcpdumpExitedBeforeCleanup = true;
  const truncatedManagedMacosFailures = validateNetworkProof("macos", truncatedManagedMacosProof);
  assertSelfTest(
    truncatedManagedMacosFailures.some((failure) =>
      failure.includes("PKTAP capture must remain active through the packaged smoke"),
    ),
    "managed macOS network proof must fail when PKTAP exits before the smoke ends",
  );

  const staleNetworkPayload = cloneJson(validSmoke);
  delete staleNetworkPayload.restartExercise;
  const staleNetworkFailures = validateNetworkProof("linux", {
    ok: true,
    proofKind: "m0-network-deny-linux",
    denyMechanism: "unshare --net",
    applicationUidNonRoot: true,
    applicationRunsAsRoot: false,
    denyLayerProbe: minimalValidDenyLayerProbe(),
    smokeProof: staleNetworkPayload,
  });
  assertSelfTest(
    staleNetworkFailures.some((failure) =>
      failure.includes("embedded smokeProof: restart exercise must increase restart count"),
    ),
    "embedded smoke proof must enforce restart evidence",
  );

  console.log("M0 proof audit self-test passed.");
}

function validateNetworkProof(osName, payload) {
  const failures = [];
  const expectedProofKind = expectedNetworkProofKind(osName);
  if (expectedProofKind) {
    requireField(payload?.proofKind === expectedProofKind, `proofKind must be ${expectedProofKind}`, failures);
  }
  if (typeof payload?.prerequisiteFailure === "string" && payload.prerequisiteFailure.trim()) {
    const detail =
      typeof payload?.error === "string" && payload.error.trim()
        ? `: ${payload.error.trim()}`
        : "";
    failures.push(`network proof prerequisite failed: ${payload.prerequisiteFailure.trim()}${detail}`);
    return failures;
  }
  requireField(payload?.ok === true, "ok must be true", failures);
  if (payload?.ok !== true && typeof payload?.error === "string" && payload.error.trim()) {
    failures.push(`proof error: ${payload.error.trim()}`);
  }
  requireField(payload?.smokeProof?.ok === true, "embedded smokeProof must be ok", failures);

  if (payload?.smokeProof) {
    failures.push(...validateSmokeProof(payload.smokeProof).map((message) => `embedded smokeProof: ${message}`));
  }

  if (osName === "windows") {
    requireField(payload?.cleanup?.ruleGroupRemoved === true, "temporary firewall rules must be removed", failures);
    requireField(Array.isArray(payload?.temporaryFirewallRules), "temporaryFirewallRules must be recorded", failures);
    validateWindowsFirewallRules(payload, failures);
    validateWindowsReleaseIdentity(payload, failures);
    requireField(Array.isArray(payload?.observedTcpConnections), "observedTcpConnections must be recorded", failures);
    requireField(payload?.observedTcpConnections?.length === 0, "observedTcpConnections must be empty", failures);
    requireField(Array.isArray(payload?.observedUdpEndpoints), "observedUdpEndpoints must be recorded", failures);
    requireField(payload?.observedUdpEndpoints?.length === 0, "observedUdpEndpoints must be empty", failures);
  }

  if (osName === "linux") {
    requireField(payload?.denyMechanism === "unshare --net", "denyMechanism must be unshare --net", failures);
    requireField(
      payload?.applicationUidNonRoot === true && payload?.applicationRunsAsRoot === false,
      "packaged application must run as a non-root user inside the network namespace",
      failures,
    );
    validateDenyLayerProbe(payload, failures);
  }

  if (osName === "macos") {
    requireField(
      payload?.applicationUidNonRoot === true && payload?.applicationRunsAsRoot === false,
      "packaged application must run as a non-root user while PF and tcpdump stay privileged",
      failures,
    );
    if (payload?.managedPf?.requested === true) {
      validateDenyLayerProbe(payload, failures);
      validateMacosManagedPf(payload, failures);
    } else {
      requireField(payload?.externalDenyConfirmed === true, "external deny layer must be confirmed", failures);
      requireField(
        payload?.denyMechanism === "operator-confirmed external deny layer plus PKTAP process attribution",
        "denyMechanism must be operator-confirmed external deny layer plus PKTAP process attribution",
        failures,
      );
    }
    const attribution = payload?.packetAttribution;
    requireField(payload?.interface === "pktap,all", "macOS capture interface must be pktap,all", failures);
    requireField(
      attribution?.captureInterface === "pktap,all",
      "packetAttribution.captureInterface must be pktap,all",
      failures,
    );
    requireField(
      payload?.captureConfiguration?.mode === "temporary-pcapng-file" &&
        payload.captureConfiguration.snapshotLengthBytes === 256 &&
        payload.captureConfiguration.metadataFilter === "dir=out" &&
        payload.captureConfiguration.rawCaptureRemoved === true,
      "PKTAP capture must use a removed temporary pcapng file with bounded snapshots",
      failures,
    );
    requireField(
      attribution?.captureMetadataFilter === "dir=out" &&
        attribution.captureMetadataFilter === payload?.captureConfiguration?.metadataFilter,
      "PKTAP capture must be restricted to outbound packet metadata",
      failures,
    );
    requireField(
      attribution?.captureParse?.exitCode === 0 &&
        !attribution.captureParse.error &&
        attribution.captureParse.rawCaptureRemoved === true,
      "PKTAP pcapng must parse successfully and be removed before proof publication",
      failures,
    );
    requireField(
      attribution?.captureStats?.parsed === true &&
        attribution.captureStats.kernelDropped === 0 &&
        attribution.captureStats.captured === attribution?.observedPacketCount,
      "PKTAP capture statistics must be complete with zero kernel drops",
      failures,
    );
    requireField(
      Array.isArray(attribution?.packetsWithoutProcessMetadata) &&
        attribution.packetsWithoutProcessMetadata.length === 0,
      "PKTAP packets must have process or explicit kernel attribution",
      failures,
    );
    if (payload?.managedPf?.requested === true) {
      requireField(
        attribution?.blockedMetadataSource ===
          "PF per-rule packet counters scoped to an isolated execution GID",
        "blocked-attempt evidence must come from isolated-group PF counters",
        failures,
      );
      requireField(
        payload?.executionIdentity?.uid > 0 &&
          payload?.executionIdentity?.gid === payload?.managedPf?.executionGid &&
          payload?.executionIdentity?.isolatedGid === payload?.managedPf?.executionGid &&
          payload?.executionIdentity?.processTreeComplete === true,
        "macOS packaged process tree must retain the isolated non-root execution identity",
        failures,
      );
    }
    requireField(attribution?.complete === true, "PKTAP process attribution must be complete", failures);
    requireField(attribution?.packetOverflowCount === 0, "PKTAP packet capture must not overflow", failures);
    requireField(
      attribution?.tcpdumpExitedBeforeCleanup === false,
      "PKTAP capture must remain active through the packaged smoke",
      failures,
    );
    requireField(
      attribution?.applicationPacketCount === 0 &&
        attribution?.applicationEscapedPacketCount === 0 &&
        (!payload?.managedPf?.requested || attribution?.applicationBlockedPacketCount === 0) &&
        payload?.packetCount === 0,
      "Candor-attributed outbound packet count must be zero",
      failures,
    );
    requireField(
      Array.isArray(attribution?.observedProcesses) && attribution.observedProcesses.length > 0,
      "PKTAP proof must record the observed Candor process tree",
      failures,
    );
    requireField(
      Array.isArray(attribution?.processIdentityMismatches) &&
        attribution.processIdentityMismatches.length === 0,
      "Candor process tree must not escape the isolated execution identity",
      failures,
    );
    if (payload?.managedPf?.requested === true) {
      requireField(
        Number.isInteger(payload?.denyLayerProbe?.pid) && payload.denyLayerProbe.pid > 0,
        "managed PF deny probe must record its process PID",
        failures,
      );
      requireField(
        payload?.denyLayerProbe?.uid === payload?.executionIdentity?.uid &&
          payload?.denyLayerProbe?.gid === payload?.executionIdentity?.isolatedGid,
        "managed PF deny probe must run under the isolated execution identity",
        failures,
      );
      requireField(
        attribution?.denyProbeCounted === true && attribution?.denyProbePacketCount > 0,
        "isolated-group PF counters must record the blocked sentinel",
        failures,
      );
      requireField(
        attribution?.applicationBaselinePacketCount === 0,
        "isolated-group PF application counter baseline must be zero",
        failures,
      );
    }
  }

  return failures;
}

function expectedReleaseArtifactKinds(platform) {
  if (platform === "win32") return ["windows-installer"];
  if (platform === "darwin") return ["macos-dmg"];
  if (platform === "linux") return ["linux-appimage", "linux-deb"];
  return [];
}

function validateManifestProof(payload) {
  const failures = [];
  requireField(payload?.ok === true, "ok must be true", failures);
  requireField(payload?.proofKind === "m0-artifact-manifest", "proofKind must be m0-artifact-manifest", failures);
  validateSourceProvenance(payload, "manifest", failures);
  requireField(payload?.packaged?.appExecutable?.exists === true, "packaged app executable must exist", failures);
  requireField(payload?.packaged?.appExecutable?.sha256, "packaged app executable hash must exist", failures);
  requireField(payload?.packaged?.coreExecutable?.exists === true, "packaged core executable must exist", failures);
  requireField(payload?.packaged?.coreExecutable?.sha256, "packaged core executable hash must exist", failures);
  requireField(payload?.packaged?.appArchive?.exists === true, "packaged app archive must exist", failures);
  requireField(payload?.packaged?.appArchive?.sha256, "packaged app archive hash must exist", failures);
  requireField(Array.isArray(payload?.releaseArtifacts), "release artifact list must exist", failures);
  const releaseArtifacts = Array.isArray(payload?.releaseArtifacts) ? payload.releaseArtifacts : [];
  const releaseKinds = new Set(releaseArtifacts.filter((entry) => entry?.exists === true).map((entry) => entry?.kind));
  for (const kind of expectedReleaseArtifactKinds(payload?.platform)) {
    requireField(releaseKinds.has(kind), `release artifact must include ${kind}`, failures);
    const artifact = releaseArtifacts.find((entry) => entry?.kind === kind && entry?.exists === true);
    if (artifact) {
      requireField(typeof artifact.sha256 === "string" && artifact.sha256.length > 0, `release artifact ${kind} hash must exist`, failures);
      requireField(Number.isFinite(artifact.bytes) && artifact.bytes > 0, `release artifact ${kind} size must be recorded`, failures);
    }
  }
  requireField(Array.isArray(payload?.sources), "source hash list must exist", failures);
  return failures;
}

function expectedReleaseArtifactSmokePlatform(osName) {
  if (osName === "windows") return "win32";
  if (osName === "macos") return "darwin";
  if (osName === "linux") return "linux";
  return null;
}

function validateReleaseArtifactSmokeProof(osName, payload) {
  const failures = [];
  requireField(payload?.ok === true, "ok must be true", failures);
  requireField(payload?.proofKind === "v3-release-artifact-smoke", "proofKind must be v3-release-artifact-smoke", failures);
  requireField(payload?.platform === expectedReleaseArtifactSmokePlatform(osName), "release artifact smoke platform must match OS", failures);
  requireField(payload?.localOnly === true, "release artifact smoke localOnly must be true", failures);
  requireField(payload?.cloudAi === false, "release artifact smoke cloudAi must be false", failures);
  requireField(payload?.networkAttempted === false, "release artifact smoke must not attempt network", failures);
  requireField(payload?.rawPathExposed === false, "release artifact smoke must not expose raw paths", failures);
  requireField(
    payload?.keyMaterialExposedToRenderer === false,
    "release artifact smoke must not expose key material",
    failures,
  );
  requireField(payload?.currentPlatform?.ok === true, "release artifact smoke current platform check must pass", failures);
  requireField(
    payload?.currentPlatform?.extractionAttempted === true,
    "release artifact smoke must extract or mount the platform artifact",
    failures,
  );
  const entries = Array.isArray(payload?.currentPlatform?.requiredEntries)
    ? payload.currentPlatform.requiredEntries
    : [];
  requireField(entries.length > 0, "release artifact smoke must record required payload entries", failures);
  for (const entry of entries) {
    requireField(entry?.exists === true, `release artifact payload entry must exist: ${entry?.extractedPath ?? "unknown"}`, failures);
    requireField(
      entry?.hashMatchesUnpacked === true,
      `release artifact payload entry must match unpacked output: ${entry?.extractedPath ?? "unknown"}`,
      failures,
    );
  }
  if (osName === "windows") {
    requireField(payload?.currentPlatform?.installer?.exists === true, "Windows installer must exist", failures);
    for (const expected of ["Candor v3 M0.exe", "resources/app.asar", "resources/bin/candor-core.exe"]) {
      const entry = entries.find((candidate) => candidate?.extractedPath === expected);
      requireField(Boolean(entry), `Windows installer payload must include ${expected}`, failures);
      if (entry) {
        requireField(entry.hashMatchesUnpacked === true, `Windows installer payload must match unpacked hash for ${expected}`, failures);
      }
    }
  }
  if (osName === "macos") {
    requireField(payload?.currentPlatform?.installer?.exists === true, "macOS DMG must exist", failures);
  }
  if (osName === "linux") {
    requireField(payload?.currentPlatform?.appImage?.exists === true, "Linux AppImage must exist", failures);
    requireField(payload?.currentPlatform?.deb?.exists === true, "Linux deb must exist", failures);
  }
  if (Array.isArray(payload?.failures) && payload.failures.length > 0) {
    failures.push(`release artifact smoke has ${payload.failures.length} failure(s)`);
  }
  return failures;
}

function validateV3VerificationProof(payload) {
  const failures = [];
  const requiredSteps = [
    "M0 CI contract smoke",
    "M0 local verification",
    "V3 source security proof",
    "V3 updater policy proof",
    "M1 durable capture and consent",
    "M1 SQLCipher vault",
    "M2 walking skeleton",
    "M3 product surface",
    "M4 local AI fallback",
    "M5 importer",
    "Vitest regression suite",
  ];
  requireField(payload?.ok === true, "ok must be true", failures);
  requireField(payload?.proofKind === "v3-local-verification", "proofKind must be v3-local-verification", failures);
  validateSourceProvenance(payload, "staged verification", failures);
  requireField(typeof payload?.platform === "string" && payload.platform.length > 0, "platform must be recorded", failures);
  requireField(typeof payload?.arch === "string" && payload.arch.length > 0, "arch must be recorded", failures);
  requireField(Array.isArray(payload?.steps), "steps must be recorded", failures);

  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  for (const requiredStep of requiredSteps) {
    const step = steps.find((candidate) => candidate?.name === requiredStep);
    requireField(Boolean(step), `required step missing: ${requiredStep}`, failures);
    if (step) {
      requireField(step.ok === true, `step failed: ${requiredStep}`, failures);
      requireField(step.exitCode === 0, `step exit code must be zero: ${requiredStep}`, failures);
      requireField(typeof step.command === "string" && step.command.length > 0, `step command must be recorded: ${requiredStep}`, failures);
      requireField(numberValue(step.durationMs, -1) >= 0, `step duration must be recorded: ${requiredStep}`, failures);
    }
  }
  return failures;
}

function evaluateProofSet({ proofDir, osName, label, smokePattern, releaseArtifactSmokePattern, networkPattern, manifestPattern, v3Pattern }) {
  const smokeProofs = findProofs(proofDir, smokePattern);
  const releaseArtifactSmokeProofs = findProofs(proofDir, releaseArtifactSmokePattern);
  const networkProofs = findProofs(proofDir, networkPattern);
  const manifestProofs = findProofs(proofDir, manifestPattern);
  const v3Proofs = findProofs(proofDir, v3Pattern);

  const manifestCandidates = manifestProofs.map((proof) => ({
    file: proof.name,
    payload: proof.payload,
    failures: validateManifestProof(proof.payload),
  }));
  const validManifestCandidates = manifestCandidates.filter((candidate) => candidate.failures.length === 0);

  const manifestConsistencyFailures = (smokePayload) => {
    if (validManifestCandidates.length === 0) return [];
    const pairFailures = validManifestCandidates.map((candidate) =>
      validateSmokeManifestPair(smokePayload, candidate.payload),
    );
    if (pairFailures.some((failures) => failures.length === 0)) return [];
    return [`no valid manifest matches packaged artifact hashes: ${pairFailures[0].join("; ")}`];
  };
  const manifestConsistencyEvidence = (smokePayload) => {
    if (validManifestCandidates.length === 0) return null;
    const matchingManifest = validManifestCandidates.find(
      (candidate) => validateSmokeManifestPair(smokePayload, candidate.payload).length === 0,
    );
    return matchingManifest ? artifactHashMatchEvidence(smokePayload, matchingManifest) : null;
  };
  const sourceIdentityFailures = (v3Payload) => {
    if (validManifestCandidates.length === 0) return [];
    const pairFailures = validManifestCandidates.map((candidate) =>
      validateV3ManifestPair(v3Payload, candidate.payload),
    );
    if (pairFailures.some((failures) => failures.length === 0)) return [];
    return [`no valid manifest matches staged verification source identity: ${pairFailures[0].join("; ")}`];
  };
  const sourceIdentityEvidence = (v3Payload) => {
    if (validManifestCandidates.length === 0) return null;
    const matchingManifest = validManifestCandidates.find(
      (candidate) => validateV3ManifestPair(v3Payload, candidate.payload).length === 0,
    );
    return matchingManifest ? sourceIdentityMatchEvidence(v3Payload, matchingManifest) : null;
  };

  const smokeCandidates = smokeProofs.map((proof) => {
    const failures = validateSmokeProof(proof.payload);
    if (failures.length === 0) failures.push(...manifestConsistencyFailures(proof.payload));
    const artifactHashMatch =
      failures.length === 0 ? manifestConsistencyEvidence(proof.payload) : null;
    return {
      file: proof.name,
      failures,
      artifactHashMatch,
    };
  });
  const releaseArtifactSmokeCandidates = releaseArtifactSmokeProofs.map((proof) => ({
    file: proof.name,
    failures: validateReleaseArtifactSmokeProof(osName, proof.payload),
  }));
  const networkCandidates = networkProofs.map((proof) => {
    const failures = validateNetworkProof(osName, proof.payload);
    if (failures.length === 0 && proof.payload?.smokeProof) {
      failures.push(
        ...manifestConsistencyFailures(proof.payload.smokeProof).map(
          (message) => `embedded smokeProof: ${message}`,
        ),
      );
    }
    const embeddedSmokeArtifactHashMatch =
      failures.length === 0 && proof.payload?.smokeProof
        ? manifestConsistencyEvidence(proof.payload.smokeProof)
        : null;
    return {
      file: proof.name,
      failures,
      embeddedSmokeArtifactHashMatch,
    };
  });
  const v3Candidates = v3Proofs.map((proof) => {
    const failures = validateV3VerificationProof(proof.payload);
    if (failures.length === 0) failures.push(...sourceIdentityFailures(proof.payload));
    const sourceIdentityMatch =
      failures.length === 0 ? sourceIdentityEvidence(proof.payload) : null;
    return {
      file: proof.name,
      failures,
      sourceIdentityMatch,
    };
  });

  const smokePass = smokeCandidates.find((candidate) => candidate.failures.length === 0);
  const releaseArtifactSmokePass = releaseArtifactSmokeCandidates.find((candidate) => candidate.failures.length === 0);
  const networkPass = networkCandidates.find((candidate) => candidate.failures.length === 0);
  const manifestPass = manifestCandidates.find((candidate) => candidate.failures.length === 0);
  const v3Pass = v3Candidates.find((candidate) => candidate.failures.length === 0);

  return {
    os: label,
    packagedSmoke: smokePass
      ? { status: "passed", file: smokePass.file, artifactHashMatch: smokePass.artifactHashMatch }
      : smokeCandidates.length > 0
        ? { status: "failed", file: smokeCandidates[0].file, failures: smokeCandidates[0].failures }
        : { status: "missing" },
    releaseArtifactSmoke: releaseArtifactSmokePass
      ? { status: "passed", file: releaseArtifactSmokePass.file }
      : releaseArtifactSmokeCandidates.length > 0
        ? { status: "failed", file: releaseArtifactSmokeCandidates[0].file, failures: releaseArtifactSmokeCandidates[0].failures }
        : { status: "missing" },
    networkDeny: networkPass
      ? {
          status: "passed",
          file: networkPass.file,
          embeddedSmokeArtifactHashMatch: networkPass.embeddedSmokeArtifactHashMatch,
        }
      : networkCandidates.length > 0
        ? { status: "failed", file: networkCandidates[0].file, failures: networkCandidates[0].failures }
        : { status: "missing" },
    artifactManifest: manifestPass
      ? { status: "passed", file: manifestPass.file }
      : manifestCandidates.length > 0
        ? { status: "failed", file: manifestCandidates[0].file, failures: manifestCandidates[0].failures }
        : { status: "missing" },
    stagedVerification: v3Pass
      ? { status: "passed", file: v3Pass.file, sourceIdentityMatch: v3Pass.sourceIdentityMatch }
      : v3Candidates.length > 0
        ? { status: "failed", file: v3Candidates[0].file, failures: v3Candidates[0].failures }
        : { status: "missing" },
  };
}

function statusIcon(status) {
  if (status === "passed") return "PASS";
  if (status === "failed") return "FAIL";
  return "MISS";
}

if (hasArg("--self-test")) {
  runSelfTest();
  process.exit(0);
}

const proofDir = asPath(argValue("--proof-dir", "release-v3/proofs"));
const writePathArg = argValue("--write", "");
const strict = hasArg("--strict");

const rows = [
  evaluateProofSet({
    proofDir,
    osName: "windows",
    label: "Windows",
    smokePattern: /^m0-packaged-runtime-smoke-win32-.+\.json$/,
    releaseArtifactSmokePattern: /^v3-release-artifact-smoke-win32-.+\.json$/,
    networkPattern: /^m0-network-deny-windows-\d{8}-\d{6}\.json$/,
    manifestPattern: /^m0-artifact-manifest-win32-.+\.json$/,
    v3Pattern: /^v3-local-verification-win32-.+\.json$/,
  }),
  evaluateProofSet({
    proofDir,
    osName: "linux",
    label: "Linux",
    smokePattern: /^m0-packaged-runtime-smoke-linux-.+\.json$/,
    releaseArtifactSmokePattern: /^v3-release-artifact-smoke-linux-.+\.json$/,
    networkPattern: /^m0-network-deny-linux-.+\.json$/,
    manifestPattern: /^m0-artifact-manifest-linux-.+\.json$/,
    v3Pattern: /^v3-local-verification-linux-.+\.json$/,
  }),
  evaluateProofSet({
    proofDir,
    osName: "macos",
    label: "macOS",
    smokePattern: /^m0-packaged-runtime-smoke-darwin-.+\.json$/,
    releaseArtifactSmokePattern: /^v3-release-artifact-smoke-darwin-.+\.json$/,
    networkPattern: /^m0-network-deny-macos-.+\.json$/,
    manifestPattern: /^m0-artifact-manifest-darwin-.+\.json$/,
    v3Pattern: /^v3-local-verification-darwin-.+\.json$/,
  }),
];

const failedRows = rows.flatMap((row) => [
  ...(row.packagedSmoke.status === "failed" ? [{ os: row.os, gate: "packagedSmoke", ...row.packagedSmoke }] : []),
  ...(row.releaseArtifactSmoke.status === "failed" ? [{ os: row.os, gate: "releaseArtifactSmoke", ...row.releaseArtifactSmoke }] : []),
  ...(row.networkDeny.status === "failed" ? [{ os: row.os, gate: "networkDeny", ...row.networkDeny }] : []),
  ...(row.artifactManifest.status === "failed" ? [{ os: row.os, gate: "artifactManifest", ...row.artifactManifest }] : []),
  ...(row.stagedVerification.status === "failed" ? [{ os: row.os, gate: "stagedVerification", ...row.stagedVerification }] : []),
]);
const missingRows = rows.flatMap((row) => [
  ...(row.packagedSmoke.status === "missing" ? [{ os: row.os, gate: "packagedSmoke" }] : []),
  ...(row.releaseArtifactSmoke.status === "missing" ? [{ os: row.os, gate: "releaseArtifactSmoke" }] : []),
  ...(row.networkDeny.status === "missing" ? [{ os: row.os, gate: "networkDeny" }] : []),
  ...(row.artifactManifest.status === "missing" ? [{ os: row.os, gate: "artifactManifest" }] : []),
  ...(row.stagedVerification.status === "missing" ? [{ os: row.os, gate: "stagedVerification" }] : []),
]);
const exitReady = failedRows.length === 0 && missingRows.length === 0;

const summary = {
  ok: failedRows.length === 0 && (!strict || exitReady),
  strict,
  exitReady,
  proofDir,
  generatedAt: new Date().toISOString(),
  rows,
  missing: missingRows,
  failed: failedRows,
};

const writePath = asPath(writePathArg || join(proofDir, "m0-proof-audit-summary.json"));
mkdirSync(dirname(writePath), { recursive: true });
writeFileSync(writePath, JSON.stringify(summary, null, 2), "utf8");

console.log("M0 proof audit");
for (const row of rows) {
  console.log(
    `${row.os}: staged=${statusIcon(row.stagedVerification.status)} smoke=${statusIcon(row.packagedSmoke.status)} artifact=${statusIcon(row.releaseArtifactSmoke.status)} network=${statusIcon(row.networkDeny.status)} manifest=${statusIcon(row.artifactManifest.status)}`,
  );
}
console.log(`M0 exit ready: ${exitReady ? "yes" : "no"}`);

if (failedRows.length > 0) {
  for (const failure of failedRows) {
    console.error(`${failure.os} ${failure.gate} failed in ${failure.file}:`);
    for (const message of failure.failures ?? []) {
      console.error(`- ${message}`);
    }
  }
}

if (strict && !exitReady) {
  console.error("Strict M0 proof audit failed: required proof artifacts are missing or invalid.");
  process.exit(1);
}

if (failedRows.length > 0) {
  process.exit(1);
}
