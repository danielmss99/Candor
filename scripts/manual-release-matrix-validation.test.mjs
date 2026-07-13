import { describe, expect, it } from "vitest";
import { validateManualReleaseEvidence, validateManualReleaseProof } from "./manual-release-matrix-validation.mjs";

const ref = "proof://candidate/example";

function passed(extra = {}) {
  return { passed: true, evidenceRefs: [ref], ...extra };
}

function validEvidence() {
  const run = (targetMinutes) => ({
    ...passed(),
    targetMinutes,
    actualSeconds: targetMinutes * 60,
    durationDeltaSeconds: 0,
    configuredChunkSeconds: 5,
    droppedChunks: 0,
    fileBytes: 1024,
    transcriptionSeconds: 12,
    cpuPeakPercent: 50,
    memoryPeakMiB: 512,
    storageStartBytes: 10_000,
    storageEndBytes: 9_000,
    playbackVerified: true,
    transcriptVerified: true,
    exportVerified: true,
    audioSha256: "a".repeat(64),
    logRef: "artifact://logs/run.json",
    recoveryResult: targetMinutes === 30 ? "passed" : "not-required",
    forceKillRecovery: targetMinutes === 30,
    recoveredLossSeconds: targetMinutes === 30 ? 4 : null,
  });
  return {
    schemaVersion: 1,
    candidate: {
      productName: "Candor",
      version: "0.4.0",
      commit: "b".repeat(40),
      installer: { filename: "Candor Setup 0.4.0.exe", sha256: "c".repeat(64), bytes: 1000, signatureValid: true, timestampValid: true, evidenceRefs: [ref] },
    },
    environment: { windowsVersion: "Windows 11 24H2", architecture: "x64", machineRef: "lab-win11", operatorRef: "operator-1", testedAt: "2026-07-13T12:00:00Z" },
    windowsMatrix: {
      cleanInstall: passed(),
      upgradeFromPreviousElectronPrerelease: passed({ previousVersion: "0.3.0", backupVerified: true, dataPreserved: true, migrationVerified: true, rollbackRetained: true }),
      uninstallDataPreserved: passed({ vaultPreserved: true }),
      standardUser: passed(),
      administrator: passed(),
      offlineLaunch: passed({ outboundConnections: 0 }),
      licenseServiceUnavailable: passed({ existingDataOpened: true, existingDataExported: true, existingDataDeleted: true }),
      updateServiceUnavailable: passed(),
    },
    hardwareMatrix: {
      microphones: ["built-in", "usb", "bluetooth"].map((kind) => passed({ kind, deviceRef: `${kind} test device` })),
      systemAudio: passed(),
      combinedAudio: passed(),
      deviceDisconnectAndSwitch: passed({ lossReportedAccurately: true }),
      sleepResume: passed({ deterministicOutcome: true }),
      lockUnlock: passed({ recordingStateAccurate: true }),
    },
    recordings: [5, 30, 60, 180].map(run),
    coreHangRecovery: passed({ captureOutcomeExplicit: true, committedDataPreserved: true }),
    diskPressure: passed({ falseSavedStatePrevented: true }),
    accessibility: { keyboardRecordReviewExport: true, focusRestoration: true, highContrast: true, reducedMotion: true, zoom200: true, evidenceRefs: [ref] },
    diagnostics: { contentAndSecretsExcluded: true, evidenceRefs: [ref] },
  };
}

describe("manual release evidence", () => {
  it("accepts a complete, source-bound Windows matrix", () => {
    expect(validateManualReleaseEvidence(validEvidence(), { productName: "Candor", version: "0.4.0", commit: "b".repeat(40) })).toEqual([]);
  });

  it("rejects unproven upgrade, excessive recovery loss, and absolute evidence paths", () => {
    const evidence = validEvidence();
    evidence.windowsMatrix.upgradeFromPreviousElectronPrerelease.dataPreserved = false;
    evidence.recordings[1].recoveredLossSeconds = 6;
    evidence.hardwareMatrix.systemAudio.evidenceRefs = ["C:\\Users\\operator\\meeting.wav"];
    expect(validateManualReleaseEvidence(evidence, { productName: "Candor", version: "0.4.0", commit: "b".repeat(40) })).toEqual(expect.arrayContaining([
      "upgrade evidence must prove dataPreserved",
      "30-minute recovery loss exceeds one configured chunk",
      "hardware matrix systemAudio contains an unsafe evidence reference",
    ]));
  });

  it("requires an honest passing proof at the release boundary", () => {
    expect(validateManualReleaseProof({ proofKind: "v3-manual-release-matrix", ok: false, releaseReady: false, inputPresent: false, failures: ["missing"] })).toContain("manual release matrix did not pass");
  });
});
