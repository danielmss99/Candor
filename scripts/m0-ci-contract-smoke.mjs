import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflowPath = resolve(repoRoot, ".github", "workflows", "v3-m0.yml");
const workflow = readFileSync(workflowPath, "utf8").replaceAll("\r\n", "\n");
const windowsNetworkProof = readFileSync(resolve(repoRoot, "scripts", "m0-network-deny-windows.ps1"), "utf8");
const windowsNetworkAdmin = readFileSync(resolve(repoRoot, "scripts", "m0-network-deny-windows-admin.ps1"), "utf8");
const linuxNetworkProof = readFileSync(resolve(repoRoot, "scripts", "m0-network-deny-linux.mjs"), "utf8");
const macosNetworkProof = readFileSync(resolve(repoRoot, "scripts", "m0-network-deny-macos.mjs"), "utf8");
const proofAudit = readFileSync(resolve(repoRoot, "scripts", "m0-proof-audit.mjs"), "utf8");
const artifactManifest = readFileSync(resolve(repoRoot, "scripts", "m0-artifact-manifest.mjs"), "utf8");
const coreBuildScript = readFileSync(resolve(repoRoot, "crates", "candor-core", "build.rs"), "utf8");
const electronBuilder = readFileSync(resolve(repoRoot, "electron-builder.v3.yml"), "utf8");
const v3Verify = readFileSync(resolve(repoRoot, "scripts", "v3-verify.mjs"), "utf8");
const releaseReadinessAudit = readFileSync(resolve(repoRoot, "scripts", "v3-release-readiness-audit.mjs"), "utf8");
const releaseSigningProof = readFileSync(resolve(repoRoot, "scripts", "v3-release-signing-proof.mjs"), "utf8");
const packagedSmoke = readFileSync(resolve(repoRoot, "scripts", "m0-packaged-smoke.mjs"), "utf8");
const releaseArtifactSmoke = readFileSync(resolve(repoRoot, "scripts", "v3-release-artifact-smoke.mjs"), "utf8");
const transcriptionProofAudit = readFileSync(resolve(repoRoot, "scripts", "m2-transcription-proof-audit.mjs"), "utf8");
const goalAudit = readFileSync(resolve(repoRoot, "scripts", "v3-goal-audit.mjs"), "utf8");
const goalAuditDoc = readFileSync(resolve(repoRoot, "docs", "proofs", "V3_GOAL_AUDIT.md"), "utf8");
const m4LocalInstructFixture = readFileSync(resolve(repoRoot, "scripts", "m4-local-instruct-fixture-smoke.mjs"), "utf8");
const m4LocalInstructFixtureDoc = readFileSync(resolve(repoRoot, "docs", "proofs", "M4_LOCAL_INSTRUCT_FIXTURE_PROOF.md"), "utf8");
const m4LocalInstructPreflight = readFileSync(resolve(repoRoot, "scripts", "m4-local-instruct-preflight.mjs"), "utf8");
const m4LocalInstructPreflightDoc = readFileSync(resolve(repoRoot, "docs", "proofs", "M4_LOCAL_INSTRUCT_PREFLIGHT_PROOF.md"), "utf8");
const m4RealLocalInstruct = readFileSync(resolve(repoRoot, "scripts", "m4-real-local-instruct-proof.mjs"), "utf8");
const m4RealLocalInstructDoc = readFileSync(resolve(repoRoot, "docs", "proofs", "M4_REAL_LOCAL_INSTRUCT_PROOF.md"), "utf8");
const packageJson = readFileSync(resolve(repoRoot, "package.json"), "utf8");

function requireIncludes(pattern, label) {
  if (!workflow.includes(pattern)) {
    throw new Error(`M0 CI contract missing ${label}: ${pattern}`);
  }
}

function requireNotIncludes(pattern, label) {
  if (workflow.includes(pattern)) {
    throw new Error(`M0 CI contract contains banned ${label}: ${pattern}`);
  }
}

function requireFileIncludes(contents, pattern, label) {
  if (!contents.includes(pattern)) {
    throw new Error(`M0 CI contract missing ${label}: ${pattern}`);
  }
}

function requireFileNotIncludes(contents, pattern, label) {
  if (contents.includes(pattern)) {
    throw new Error(`M0 CI contract contains banned ${label}: ${pattern}`);
  }
}

function requireFileOrder(contents, before, after, label) {
  const beforeIndex = contents.indexOf(before);
  const afterIndex = contents.indexOf(after);
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex >= afterIndex) {
    throw new Error(`M0 CI file contract order failed for ${label}`);
  }
}

function requireOrder(before, after, label) {
  const beforeIndex = workflow.indexOf(before);
  const afterIndex = workflow.indexOf(after);
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex >= afterIndex) {
    throw new Error(`M0 CI contract order failed for ${label}`);
  }
}

const requiredPatterns = [
  ["os: [windows-latest, macos-26, ubuntu-latest]", "three-OS matrix with pinned macOS SDK"],
  ["fail-fast: false", "non-short-circuiting matrix"],
  ["node-version: 22", "Electron-compatible Node.js version"],
  ["sudo apt-get install -y", "Linux native dependency install"],
  ["libasound2-dev", "Linux audio build dependency"],
  ["libsecret-1-dev", "Linux key storage dependency"],
  ["iproute2", "Linux network namespace interface dependency"],
  ["util-linux", "Linux unshare dependency"],
  ["xvfb", "Linux Electron smoke dependency"],
  ["Verify macOS build SDK", "pinned macOS SDK verification"],
  ['xcrun --sdk macosx --show-sdk-version', "macOS SDK version discovery"],
  ['test "$sdk_major" -ge 26', "macOS SDK 26 minimum"],
  ['echo "MACOSX_DEPLOYMENT_TARGET=13.0" >> "$GITHUB_ENV"', "macOS 13 deployment target"],
  ["npm run v3:verify", "staged local verifier"],
  ["npm run electron:v3:dist", "release artifact build"],
  ["Configure Linux Chromium sandbox for runtime proof", "Linux sandbox preparation"],
  ["sudo chown root:root release-v3/linux-unpacked/chrome-sandbox", "Linux sandbox root ownership"],
  ["sudo chmod 4755 release-v3/linux-unpacked/chrome-sandbox", "Linux sandbox setuid mode"],
  ["stat -c '%u:%g:%a' release-v3/linux-unpacked/chrome-sandbox", "Linux sandbox ownership and mode assertion"],
  ["npm run v3:release-artifact-smoke", "release artifact contents smoke"],
  ["npm run m0:packaged-smoke", "packaged smoke"],
  ["xvfb-run -a npm run m0:packaged-smoke", "Linux packaged smoke display wrapper"],
  ["npm run m0:network-deny:windows -- -ValidateOnly", "Windows proof validation"],
  ["npm run m0:network-deny:windows", "Windows network-deny proof"],
  ["npm run m0:network-deny:macos -- --validate-only", "macOS proof validation"],
  ["node scripts/m0-network-deny-macos.mjs --managed-pf", "macOS managed PF proof"],
  ["npm run m0:network-deny:linux -- --validate-only", "Linux proof validation"],
  ["node scripts/m0-network-deny-linux.mjs", "Linux network namespace proof"],
  ['"GITHUB_RUN_ID=$GITHUB_RUN_ID"', "CI run provenance forwarded through sudo"],
  ['"GITHUB_SHA=$GITHUB_SHA"', "CI source identity forwarded through sudo"],
  ["if: always()\n        run: npm run m0:artifact-manifest", "always-run artifact manifest"],
  ["npm run m0:artifact-manifest", "artifact manifest"],
  ["if: always()\n        run: npm run m0:proof-audit -- --write release-v3/proofs/m0-proof-audit-summary.json", "always-run per-OS proof summary"],
  ["npm run m0:proof-audit -- --write release-v3/proofs/m0-proof-audit-summary.json", "per-OS proof summary"],
  ["if: always()\n        uses: actions/upload-artifact@v4", "always-run artifact upload"],
  ["actions/upload-artifact@v4", "artifact upload"],
  ["actions/download-artifact@v4", "artifact download"],
  ["name: candor-v3-m0-proof-${{ matrix.os }}-${{ github.sha }}", "small per-OS proof receipt artifact"],
  ["name: candor-v3-m0-package-${{ matrix.os }}-${{ github.sha }}", "separate per-OS package artifact"],
  ["pattern: candor-v3-m0-proof-*", "proof-only combined artifact collection"],
  ["node scripts/m0-proof-audit.mjs --proof-dir collected-m0-artifacts --write collected-m0-artifacts/m0-combined-proof-audit-summary.json", "combined proof summary"],
  ["path: collected-m0-artifacts/m0-combined-proof-audit-summary.json", "combined proof upload path"],
  ["node scripts/m0-proof-audit.mjs --proof-dir collected-m0-artifacts --strict", "strict combined proof audit"],
];

for (const [pattern, label] of requiredPatterns) {
  requireIncludes(pattern, label);
}

for (const [contents, pattern, label] of [
  [windowsNetworkProof, '@("scripts/m0-packaged-smoke.mjs", $resolvedAppPath)', "Windows packaged smoke explicit executable binding"],
  [windowsNetworkProof, "$psi.Arguments", "Windows PowerShell 5.1 process argument compatibility"],
  [windowsNetworkProof, "Assert-ArtifactEvidenceMatch", "Windows packaged smoke artifact identity validation"],
  [windowsNetworkProof, "releaseIdentity = $releaseIdentity", "Windows network proof release identity evidence"],
  [windowsNetworkProof, "$observedTcp.ToArray()", "PowerShell 7-safe empty TCP evidence serialization"],
  [windowsNetworkProof, "$observedUdp.ToArray()", "PowerShell 7-safe empty UDP evidence serialization"],
  [windowsNetworkAdmin, '"--release-dir", $resolvedReleaseDir', "Windows manifest explicit release root binding"],
  [windowsNetworkAdmin, '"--proof-dir", $resolvedProofDir', "Windows proof refresh explicit proof directory binding"],
  [windowsNetworkAdmin, "$steps.ToArray()", "PowerShell 7-safe admin step serialization"],
  [linuxNetworkProof, "denyLayerProbe", "Linux deny-layer sentinel proof"],
  [linuxNetworkProof, "1.1.1.1:443", "Linux deny-layer sentinel target"],
  [linuxNetworkProof, "SUDO_USER", "Linux network proof invoking user discovery"],
  [linuxNetworkProof, "runuser", "Linux network proof privilege drop"],
  [linuxNetworkProof, "GITHUB_RUN_ID", "Linux network proof CI provenance forwarding"],
  [linuxNetworkProof, "CANDOR_M0_PACKAGED_SMOKE_PROOF", "Linux network proof smoke receipt binding"],
  [macosNetworkProof, "denyLayerProbe", "macOS deny-layer sentinel proof"],
  [macosNetworkProof, "SUDO_USER", "macOS network proof invoking user discovery"],
  [macosNetworkProof, "uid: invokingUid", "macOS network proof non-root UID drop"],
  [macosNetworkProof, "gid: executionGid", "macOS network proof isolated GID drop"],
  [macosNetworkProof, 'const captureInterface = "pktap,all"', "macOS PKTAP all-interface capture"],
  [macosNetworkProof, '"NPD"', "macOS PKTAP process metadata"],
  [macosNetworkProof, "processMetadataFilter", "macOS outbound Candor metadata filter"],
  [macosNetworkProof, '"256"', "macOS bounded PKTAP snapshot length"],
  [macosNetworkProof, "parsePktapPacket", "macOS packet process attribution parser"],
  [macosNetworkProof, "parseTcpdumpCaptureStats", "macOS tcpdump capture statistics parser"],
  [macosNetworkProof, "parsePfRuleStats", "macOS PF rule counter parser"],
  [macosNetworkProof, "selectUnusedExecutionGid", "macOS isolated execution group selection"],
  [macosNetworkProof, "group ${executionGid}", "macOS PF execution-group scope"],
  [macosNetworkProof, "sentinelRuleStats", "macOS PF blocked-sentinel counters"],
  [macosNetworkProof, "applicationBaselineRuleStats", "macOS PF post-sentinel counter reset"],
  [macosNetworkProof, "applicationRuleStats", "macOS PF packaged-app attempt counters"],
  [macosNetworkProof, 'runCommand("pfctl", ["-a", pfAnchor, "-z"])', "macOS PF counter reset command"],
  [macosNetworkProof, "processTreeSnapshot", "macOS Candor process tree observer"],
  [macosNetworkProof, "processIdentityMismatches", "macOS isolated process identity gate"],
  [macosNetworkProof, "denyProbeCounted", "macOS blocked-sentinel counter gate"],
  [macosNetworkProof, "applicationPacketCount", "macOS Candor-attributed packet gate"],
  [macosNetworkProof, "packetOverflowCount", "macOS packet capture overflow gate"],
  [macosNetworkProof, "captureStats.kernelDropped === 0", "macOS kernel packet-drop gate"],
  [macosNetworkProof, "tcpdumpExitedBeforeCleanup", "macOS full-window capture liveness gate"],
  [macosNetworkProof, "(!managedPf || denyLayerProbe.blocked === true)", "macOS managed-PF sentinel gate"],
  [proofAudit, "validateDenyLayerProbe", "combined proof audit deny-layer validation"],
  [proofAudit, "denyLayerProbe.blocked must be true", "combined proof audit blocked sentinel requirement"],
  [proofAudit, "network proof prerequisite failed", "combined proof audit prerequisite failure classification"],
  [proofAudit, "packaged application must run as a non-root user", "combined proof audit Linux application identity validation"],
  [proofAudit, "while PF and tcpdump stay privileged", "combined proof audit macOS application identity validation"],
  [proofAudit, "administrator-required", "combined proof audit Windows administrator prerequisite classification"],
  [proofAudit, "validateWindowsReleaseIdentity", "combined proof audit Windows release identity validation"],
  [proofAudit, "validateSourceProvenance", "combined proof audit source provenance validation"],
  [proofAudit, "validateV3ManifestPair", "combined proof audit staged verification source identity validation"],
  [proofAudit, "smoke git head must match manifest git head", "combined proof audit packaged smoke source identity validation"],
  [proofAudit, "sourceIdentityMatch", "combined proof audit source identity evidence"],
  [proofAudit, "release artifact must include", "combined proof audit release artifact validation"],
  [artifactManifest, "releaseArtifacts", "artifact manifest release artifact list"],
  [artifactManifest, "expectedReleaseArtifactKinds", "artifact manifest expected release artifact kinds"],
  [artifactManifest, '"crates/candor-core/build.rs"', "artifact manifest core build script identity"],
  [coreBuildScript, "cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift", "macOS system Swift runtime rpath"],
  [coreBuildScript, 'args(["--find", "swiftc"])', "macOS Xcode Swift runtime discovery"],
  [v3Verify, "V3 source security proof", "v3 aggregate source security step"],
  [v3Verify, "v3:source-security-proof", "v3 aggregate source security command"],
  [v3Verify, "V3 updater policy proof", "v3 aggregate updater policy step"],
  [v3Verify, "v3:updater-policy-proof", "v3 aggregate updater policy command"],
  [releaseReadinessAudit, "V3 source security proof", "release readiness source security gate"],
  [releaseReadinessAudit, "validateSourceSecurity", "release readiness source security validator"],
  [releaseReadinessAudit, "V3 updater policy proof", "release readiness updater policy gate"],
  [releaseReadinessAudit, "validateUpdaterPolicy", "release readiness updater policy validator"],
  [releaseReadinessAudit, "V3 release artifact smoke", "release readiness artifact smoke gate"],
  [releaseReadinessAudit, "validateReleaseArtifactSmoke", "release readiness artifact smoke validator"],
  [releaseReadinessAudit, "V3 signed release and installer proof", "release readiness signing gate"],
  [releaseReadinessAudit, "validateReleaseSigning", "release readiness signing validator"],
  [releaseReadinessAudit, "release signing proof must match artifact manifest and release artifact smoke hashes", "release readiness signing artifact consistency validator"],
  [releaseSigningProof, "artifactConsistency", "release signing artifact consistency check"],
  [releaseSigningProof, "releaseArtifactsMatchManifest", "release signing manifest hash match evidence"],
  [releaseSigningProof, "smokeArtifactsMatchRelease", "release signing smoke hash match evidence"],
  [releaseSigningProof, "packageSignatureEvidence", "release signing detached Linux signature evidence"],
  [releaseSigningProof, "Linux AppImage detached signature proof is missing or unverified", "release signing Linux AppImage signature failure"],
  [releaseSigningProof, "Linux deb detached signature proof is missing or unverified", "release signing Linux deb signature failure"],
  [releaseSigningProof, "macosSignatureEvidence", "release signing macOS signature evidence"],
  [releaseSigningProof, "macOS notarization/staple proof is missing or invalid", "release signing macOS staple failure"],
  [releaseSigningProof, "macOS DMG Gatekeeper assessment proof is missing or invalid", "release signing macOS Gatekeeper failure"],
  [packagedSmoke, "minimumSmokeScreenshotWidth = 960", "packaged smoke desktop screenshot width floor"],
  [packagedSmoke, "minimumSmokeScreenshotHeight = 600", "packaged smoke desktop screenshot height floor"],
  [packagedSmoke, "verificationFailure", "packaged smoke failure receipt"],
  [transcriptionProofAudit, "stringValues", "transcription proof raw string path scanner"],
  [transcriptionProofAudit, "runPathScannerSelfTest", "transcription proof path scanner regression test"],
  [releaseReadinessAudit, "verified detached signatures for Linux AppImage", "release readiness Linux AppImage signature validator"],
  [releaseReadinessAudit, "verified detached signatures for Linux deb", "release readiness Linux deb signature validator"],
  [releaseReadinessAudit, "release signing proof must show a notarized or stapled macOS DMG", "release readiness macOS notarization validator"],
  [releaseReadinessAudit, "release signing proof must show macOS DMG Gatekeeper acceptance", "release readiness macOS Gatekeeper validator"],
  [releaseReadinessAudit, "release signing proof must show a signed macOS app bundle", "release readiness macOS app signing validator"],
  [releaseArtifactSmoke, "releaseGaps", "M0 structural package proof keeps release signing gaps explicit"],
  [releaseArtifactSmoke, "strictFailures", "strict artifact smoke promotes release gaps to failures"],
  [goalAudit, "proofKind: \"v3-goal-audit\"", "goal audit proof kind"],
  [goalAudit, "coordination.subagent_alignment", "goal audit subagent alignment requirement"],
  [goalAudit, "missionComplete", "goal audit mission completion field"],
  [goalAudit, "m4LocalInstructPreflight", "goal audit M4 local instruct preflight evidence"],
  [goalAudit, "m4LocalInstructFixture", "goal audit M4 local instruct fixture evidence"],
  [goalAudit, "m4RealLocalInstruct", "goal audit M4 real local instruct evidence"],
  [goalAudit, "strictRealModelSatisfied === true", "goal audit strict real-model gate"],
  [goalAuditDoc, "Subagent Alignment", "goal audit subagent alignment docs"],
  [m4LocalInstructFixture, "ai.recapInstruct", "M4 local instruct recap RPC smoke"],
  [m4LocalInstructFixture, "ai.askInstruct", "M4 local instruct Ask RPC smoke"],
  [m4LocalInstructFixture, "fixture: true", "M4 local instruct fixture marker"],
  [m4LocalInstructFixture, "realModel: false", "M4 local instruct fixture non-real-model marker"],
  [m4LocalInstructFixture, "rendererBridgeImplemented", "M4 local instruct renderer bridge proof"],
  [m4LocalInstructFixture, "rendererQualityModeImplemented", "M4 local instruct renderer quality-mode proof"],
  [m4LocalInstructFixture, "rendererFallbackImplemented", "M4 local instruct renderer fallback proof"],
  [m4LocalInstructFixture, "rendererCitedOutputImplemented", "M4 local instruct renderer cited-output proof"],
  [m4LocalInstructFixtureDoc, "strict proof with a real llama.cpp binary", "M4 local instruct real model boundary docs"],
  [m4LocalInstructPreflight, "ai.instructStatus", "M4 local instruct status RPC smoke"],
  [m4LocalInstructPreflight, "ai.proofInstructPreflight", "M4 local instruct preflight RPC smoke"],
  [m4LocalInstructPreflight, "networkAttempted", "M4 local instruct network denial evidence"],
  [m4LocalInstructPreflight, "downloadsAttempted", "M4 local instruct download denial evidence"],
  [m4LocalInstructPreflightDoc, "manual-install-only", "M4 local instruct manual install documentation"],
  [m4RealLocalInstruct, "modelHasGgufMagic", "M4 real local instruct GGUF signature gate"],
  [m4RealLocalInstruct, "minimumModelBytes", "M4 real local instruct model-size gate"],
  [m4RealLocalInstruct, "ai.recapInstruct", "M4 real local instruct recap invocation"],
  [m4RealLocalInstruct, "ai.askInstruct", "M4 real local instruct Ask invocation"],
  [m4RealLocalInstruct, "strictRealModelSatisfied", "M4 real local instruct strict result"],
  [m4RealLocalInstruct, "inferenceAttempted", "M4 real local instruct inference-attempt marker"],
  [m4RealLocalInstruct, "--self-test", "M4 real local instruct quality self-test"],
  [m4RealLocalInstructDoc, "does not download either asset", "M4 real local instruct no-download documentation"],
  [packageJson, "\"v3:goal-audit\"", "goal audit npm script"],
  [packageJson, "\"email\": \"danielmss99@users.noreply.github.com\"", "Linux package maintainer email"],
  [packageJson, "\"desktopName\": \"Candor\"", "Linux desktop application identity"],
  [electronBuilder, "category: Office", "Linux desktop category"],
  [electronBuilder, "syncDesktopName: true", "Linux desktop name synchronization"],
  [packageJson, "\"v3:goal-audit:strict\"", "strict goal audit npm script"],
  [packageJson, "\"m4:local-instruct-preflight\"", "M4 local instruct preflight npm script"],
  [packageJson, "\"m4:local-instruct-preflight:strict\"", "strict M4 local instruct preflight npm script"],
  [packageJson, "\"m4:local-instruct-fixture\"", "M4 local instruct fixture npm script"],
  [packageJson, "\"m4:real-local-instruct-proof\"", "M4 real local instruct npm script"],
  [packageJson, "\"m4:real-local-instruct-proof:allow-missing\"", "M4 real local instruct allow-missing npm script"],
  [packageJson, "\"m4:real-local-instruct-proof:self-test\"", "M4 real local instruct self-test npm script"],
]) {
  requireFileIncludes(contents, pattern, label);
}

requireFileNotIncludes(
  windowsNetworkProof,
  ".ArgumentList",
  "Windows PowerShell 5.1 incompatible ProcessStartInfo.ArgumentList",
);
requireFileNotIncludes(
  windowsNetworkProof,
  '@($observedTcp)',
  "PowerShell 7-incompatible generic TCP list array subexpression",
);
requireFileNotIncludes(
  windowsNetworkProof,
  '@($observedUdp)',
  "PowerShell 7-incompatible generic UDP list array subexpression",
);
requireFileOrder(
  windowsNetworkProof,
  "$ruleEvidence = @($rulesCreated",
  "Remove-NetFirewallRule -Group $ruleGroup",
  "Windows firewall evidence capture before cleanup",
);
requireFileOrder(
  releaseArtifactSmoke,
  "const searchRoots = [",
  'const fromPath = commandOnPath(["7za", "7z", "7zz"]);',
  "electron-builder 7-Zip preference before system PATH",
);

for (const [pattern, label] of [
  ["node-version: 20", "Electron-incompatible Node.js version"],
  ["macos-latest", "drifting macOS runner label"],
  ["macos-26-arm64", "macOS image name used as a workflow runner label"],
  ["pattern: candor-v3-m0-*", "monolithic package-and-proof artifact download"],
  ["name: candor-v3-m0-${{ matrix.os }}", "monolithic package-and-proof artifact upload"],
  ["--no-sandbox", "Chromium sandbox bypass flag"],
  ["ELECTRON_DISABLE_SANDBOX", "Chromium sandbox bypass environment variable"],
  ["enforce_strict_m0", "optional strict input"],
  ["inputs.enforce_strict_m0", "conditional strict input"],
  ["github.event_name == 'workflow_dispatch'", "manual-only strict gate"],
]) {
  requireNotIncludes(pattern, label);
}

requireOrder(
  "npm run v3:verify",
  "npm run electron:v3:dist",
  "verify before packaging",
);
requireOrder(
  "npm run electron:v3:dist",
  "npm run v3:release-artifact-smoke",
  "package before release artifact smoke",
);
requireOrder(
  "npm run v3:release-artifact-smoke",
  "npm run m0:packaged-smoke",
  "release artifact smoke before packaged runtime smoke",
);
requireOrder(
  "node scripts/m0-proof-audit.mjs --proof-dir collected-m0-artifacts --write collected-m0-artifacts/m0-combined-proof-audit-summary.json",
  "path: collected-m0-artifacts/m0-combined-proof-audit-summary.json",
  "write combined summary before upload",
);
requireOrder(
  "path: collected-m0-artifacts/m0-combined-proof-audit-summary.json",
  "node scripts/m0-proof-audit.mjs --proof-dir collected-m0-artifacts --strict",
  "upload combined summary before strict gate",
);

console.log("M0 CI contract smoke passed.");
