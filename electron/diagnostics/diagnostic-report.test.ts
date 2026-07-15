import { describe, expect, it } from "vitest";
import { buildDiagnosticReport, diagnosticReportBytes, diagnosticReportSha256 } from "./diagnostic-report.js";

describe("safe diagnostic report", () => {
  it("includes allowlisted custody facts and excludes injected user content", () => {
    const report = buildDiagnosticReport({
      appVersion: "0.4.0",
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
      backgroundJobs: {
        activeCount: 0,
        jobs: [{
          type: "recap",
          state: "completed",
          provenance: {
            engine: "heuristic",
            modelId: null,
            modelSha256: null,
            runtimeSha256: null,
            fallbackUsed: true,
            fallbackReason: "llm-unavailable",
            promptVersion: "candor-heuristic-v1",
            generatedAt: "2026-07-14T05:00:00Z",
          },
          result: { summary: "private summary" },
        }],
      },
    });
    const text = diagnosticReportBytes(report).toString("utf8");

    expect(text).toContain("metadata-only-no-user-content");
    expect(text).toContain("sqlcipher-vault");
    expect(text).not.toContain("private transcript");
    expect(text).not.toContain("private notes");
    expect(text).not.toContain("Private Person");
    expect(text).not.toContain("private summary");
    expect(text).toContain("llm-unavailable");
    expect(text).not.toContain("C:\\\\Users");
    expect(text).not.toContain('"pid"');
    expect(diagnosticReportSha256(Buffer.from(text))).toMatch(/^[a-f0-9]{64}$/);
  });

  it("drops malformed provenance timestamps from metadata-only diagnostics", () => {
    const report = buildDiagnosticReport({
      appVersion: "0.4.0",
      platform: "win32",
      arch: "x64",
      packaged: true,
      supervisor: {},
      coreStatus: {},
      coreVersion: {},
      vaultStatus: {},
      recordingStatus: {},
      captureStatus: {},
      privacyAudit: {},
      updateStatus: {},
      backgroundJobs: {
        activeCount: 0,
        jobs: [{
          type: "recap",
          state: "completed",
          provenance: {
            engine: "local-llm",
            modelId: "qwen3-4b",
            modelSha256: "a".repeat(64),
            runtimeSha256: "b".repeat(64),
            fallbackUsed: false,
            fallbackReason: null,
            promptVersion: "candor-grounded-v1",
            generatedAt: `${"2".repeat(100)}-01-01T00:00:00Z`,
          },
        }],
      },
    }) as Record<string, unknown>;

    const tasks = report.backgroundTasks as { recent: Array<{ generatedAt: string | null }> };
    expect(tasks.recent[0]?.generatedAt).toBeNull();
  });
});
