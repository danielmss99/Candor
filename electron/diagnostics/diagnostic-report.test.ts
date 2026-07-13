import { describe, expect, it } from "vitest";
import { buildDiagnosticReport, diagnosticReportBytes, diagnosticReportSha256 } from "./diagnostic-report.js";

describe("safe diagnostic report", () => {
  it("includes allowlisted custody facts and excludes injected user content", () => {
    const report = buildDiagnosticReport({
      appVersion: "2.0.0",
      platform: "win32",
      arch: "x64",
      packaged: true,
      supervisor: {
        state: "running",
        restartCount: 2,
        pid: 999,
        executableName: "C:\\Users\\private\\candor-core.exe",
        lastHandshake: { ok: true, version: { protocolVersion: "m0-jsonrpc-stdio-1" } },
      },
      coreStatus: {
        networkPolicy: "disabled-by-default",
        startupRecovery: { attempted: true, ok: true, recoveredCount: 1 },
        transcript: "private transcript",
      },
      coreVersion: {
        version: "0.1.0",
        protocolVersion: "m0-jsonrpc-stdio-1",
        schemaVersion: 1,
        build: { target: "windows-x64", features: ["sqlcipher-vault", "C:\\private"] },
      },
      vaultStatus: { state: "closed", backend: "sqlcipher", encrypted: true, sqlcipherAvailable: true },
      recordingStatus: { durableChunks: true, durableAudioChunks: true, recordingCount: 4 },
      captureStatus: { active: false, implementation: "cpal", participantName: "Private Person" },
      privacyAudit: { externalCallsAttempted: 0, notes: "private notes" },
      updateStatus: { policy: "manual-check-only", backgroundChecks: false, attemptedChecks: 0 },
    });
    const text = diagnosticReportBytes(report).toString("utf8");

    expect(text).toContain("metadata-only-no-user-content");
    expect(text).toContain("sqlcipher-vault");
    expect(text).not.toContain("private transcript");
    expect(text).not.toContain("private notes");
    expect(text).not.toContain("Private Person");
    expect(text).not.toContain("C:\\\\Users");
    expect(text).not.toContain('"pid"');
    expect(diagnosticReportSha256(Buffer.from(text))).toMatch(/^[a-f0-9]{64}$/);
  });
});
