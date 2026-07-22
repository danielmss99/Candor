import { describe, expect, it } from "vitest";
import {
  assertCandorctlResults,
  assertMcpResults,
  assertNoNewCoreProcesses,
  assertPersistentStateUnchanged,
} from "./packaged-companion-runtime-smoke.mjs";

function run({ code = 0, stdout = "", stderr = "" } = {}) {
  return {
    code,
    signal: null,
    durationMs: 1,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    stdout,
    stderr,
  };
}

const receipt = {
  rawPathExposed: false,
  keyMaterialExposedToRenderer: false,
};

const expected = {
  recordingId: "fixture-recording",
  label: "Packaged Companion Encrypted Fixture",
  query: "orbitpathless",
  transcriptText: [
    "Orbitpathless confirms the encrypted local transcript is searchable.",
    "The packaged companions must leave every persistent byte unchanged.",
  ],
};

function populatedResults() {
  return {
    list: {
      count: 1,
      totalCount: 1,
      meetings: [{
        recordingId: expected.recordingId,
        label: expected.label,
        state: "finished",
        encryptedAtRest: true,
        transcriptSegmentCount: 2,
        ...receipt,
      }],
      ...receipt,
    },
    search: {
      count: 1,
      matches: [{
        recordingId: expected.recordingId,
        kind: "transcript",
        snippet: expected.transcriptText[0],
        ...receipt,
      }],
      ...receipt,
    },
    summary: {
      recordingId: expected.recordingId,
      label: expected.label,
      state: "finished",
      encryptedAtRest: true,
      transcriptSegmentCount: 2,
      ...receipt,
    },
    transcript: {
      recordingId: expected.recordingId,
      count: 2,
      segments: expected.transcriptText.map((text, index) => ({ index, text, ...receipt })),
      ...receipt,
    },
    export: {
      recordingId: expected.recordingId,
      format: "markdown",
      destination: "stdout-only",
      content: expected.transcriptText.join("\n"),
      bytes: expected.transcriptText.join("\n").length,
      ...receipt,
    },
    statistics: {
      totalMeetingCount: 1,
      meetingsScanned: 1,
      encryptedAtRestMeetingCount: 1,
      transcriptSegmentCount: 2,
      ...receipt,
    },
  };
}

function candorctlRuns(results = populatedResults()) {
  return Object.fromEntries(
    Object.entries(results).map(([key, value]) => [key, run({ stdout: JSON.stringify(value) })]),
  );
}

function mcpToolFrame(id, value, isError = false) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isError,
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  };
}

function mcpRun(
  results = populatedResults(),
  mutationError = { code: "OPERATION_DENIED", ...receipt },
  mutationIsError = true,
) {
  const toolNames = [
    "list_meetings",
    "search_meetings",
    "meeting_summary",
    "get_transcript",
    "export_meeting",
    "library_statistics",
  ];
  const resultValues = [
    results.list,
    results.search,
    results.summary,
    results.transcript,
    results.export,
    results.statistics,
  ];
  const frames = [
    { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "candor-mcp" } } },
    { jsonrpc: "2.0", id: 2, result: { tools: toolNames.map((name) => ({ name })) } },
    { jsonrpc: "2.0", id: 3, error: { code: -32601, data: receipt } },
    ...resultValues.map((value, index) => mcpToolFrame(10 + index, value)),
    mcpToolFrame(20, mutationError, mutationIsError),
  ];
  return run({ stdout: frames.map((frame) => JSON.stringify(frame)).join("\n") });
}

function persistentFixtureSnapshot() {
  return [
    { path: "candor-v3.sqlcipher", kind: "file", bytes: 8192, sha256: "a".repeat(64), modifiedMs: 1 },
    { path: "keys", kind: "directory", modifiedMs: 3 },
    { path: "keys/vault-key.dpapi", kind: "file", bytes: 64, sha256: "c".repeat(64), modifiedMs: 4 },
    { path: "recordings", kind: "directory", modifiedMs: 5 },
    { path: "recordings/fixture-recording", kind: "directory", modifiedMs: 6 },
    {
      path: "recordings/fixture-recording/manifest.json",
      kind: "file",
      bytes: 512,
      sha256: "d".repeat(64),
      modifiedMs: 7,
    },
    {
      path: "recordings/fixture-recording/chunk-000000.cchunk",
      kind: "file",
      bytes: 96,
      sha256: "e".repeat(64),
      modifiedMs: 8,
    },
  ];
}

describe("packaged companion runtime proof", () => {
  it("accepts all six populated pathless candorctl reads and a denied mutation", () => {
    const result = assertCandorctlResults(
      candorctlRuns(),
      run({ code: 2, stderr: JSON.stringify({ error: { code: "OPERATION_DENIED", ...receipt } }) }),
      expected,
    );
    expect(Object.keys(result.results)).toEqual([
      "list",
      "search",
      "summary",
      "transcript",
      "export",
      "statistics",
    ]);
    expect(result.denied.error.code).toBe("OPERATION_DENIED");
  });

  it("rejects a candorctl result without both custody markers", () => {
    const results = populatedResults();
    delete results.list.keyMaterialExposedToRenderer;
    expect(() => assertCandorctlResults(
      candorctlRuns(results),
      run({ code: 2, stderr: JSON.stringify({ error: { code: "OPERATION_DENIED", ...receipt } }) }),
      expected,
    )).toThrow("custody receipt");
  });

  it("rejects a fixture path embedded in command output", () => {
    const results = populatedResults();
    results.summary.label = "C:/temp/private-fixture/recordings/fixture-recording";
    expect(() => assertCandorctlResults(
      candorctlRuns(results),
      run({ code: 2, stderr: JSON.stringify({ error: { code: "OPERATION_DENIED", ...receipt } }) }),
      expected,
      { forbiddenPaths: ["C:/temp/private-fixture"] },
    )).toThrow("fixture path");
  });

  it.each([
    { privatePath: "C:/private/vault" },
    { nested: { sourcePath: "C:/private/source" } },
    { nested: [{ recordingPath: "C:/private/recording" }] },
    { nested: { keyMaterial: "secret" } },
    { nested: [{ publicKeyBase64: "AA==" }] },
  ])("rejects renderer-sensitive command fields recursively", (injected) => {
    const results = populatedResults();
    Object.assign(results.summary, injected);
    expect(() => assertCandorctlResults(
      candorctlRuns(results),
      run({ code: 2, stderr: JSON.stringify({ error: { code: "OPERATION_DENIED", ...receipt } }) }),
      expected,
    )).toThrow("structurally sensitive renderer field");
  });

  it("accepts every MCP read tool plus protocol and mutation denials", () => {
    const result = assertMcpResults(mcpRun(), expected);
    expect(Object.keys(result.toolResults)).toHaveLength(6);
    expect(result.mutationDenial.code).toBe("OPERATION_DENIED");
  });

  it("rejects an MCP mutation-shaped tool call that is not denied", () => {
    expect(() => assertMcpResults(
      mcpRun(populatedResults(), { deleted: true, ...receipt }, false),
      expected,
    )).toThrow("wrong MCP error state");
  });

  it("rejects an MCP mutation denial with the wrong bounded error code", () => {
    expect(() => assertMcpResults(
      mcpRun(populatedResults(), { code: "INPUT_INVALID", ...receipt }),
      expected,
    )).toThrow("mutation-denial code");
  });

  it("rejects nested renderer-sensitive MCP tool output", () => {
    const results = populatedResults();
    results.search.matches[0].nested = [{ publicKeyBase64: "AA==" }];
    expect(() => assertMcpResults(mcpRun(results), expected)).toThrow(
      "structurally sensitive renderer field",
    );
  });

  it("scans and rejects structurally sensitive MCP stderr", () => {
    const result = mcpRun();
    result.stderr = JSON.stringify({ nested: [{ privatePath: "C:/private/vault" }] });
    result.stderrBytes = result.stderr.length;
    expect(() => assertMcpResults(result, expected)).toThrow("structurally sensitive renderer field");
  });

  it("rejects otherwise benign MCP stderr", () => {
    const result = mcpRun();
    result.stderr = "unexpected diagnostic";
    result.stderrBytes = result.stderr.length;
    expect(() => assertMcpResults(result, expected)).toThrow("wrote to stderr");
  });

  it("proves exact SQLCipher and split sidecar state with WAL absence", () => {
    const before = persistentFixtureSnapshot();
    const result = assertPersistentStateUnchanged(before, structuredClone(before));
    expect(result).toMatchObject({
      exactMatch: true,
      sqlcipherVaultUnchanged: true,
      walAndShmStateUnchanged: true,
      keySidecarsUnchanged: true,
      recordingSidecarsUnchanged: true,
    });
    expect(result.before.walAndShm.presence).toBe("notPresent");
    expect(result.before.keySidecars.presence).toBe("present");
    expect(result.before.recordingSidecars.presence).toBe("present");
    expect(result.before.complete.inventorySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("detects a WAL file appearing after the read-only proof starts", () => {
    const before = persistentFixtureSnapshot();
    const after = structuredClone(before);
    after.push({
      path: "candor-v3.sqlcipher-wal",
      kind: "file",
      bytes: 128,
      sha256: "f".repeat(64),
      modifiedMs: 9,
    });
    expect(() => assertPersistentStateUnchanged(before, after)).toThrow("WAL or SHM");
  });

  it("fails closed when initial process enumeration is unavailable", async () => {
    await expect(assertNoNewCoreProcesses(null)).rejects.toThrow("enumeration was unavailable");
  });

  it("fails closed when a later process enumeration is unavailable", async () => {
    await expect(assertNoNewCoreProcesses(new Set(), {
      enumerate: () => null,
    })).rejects.toThrow("enumeration was unavailable");
  });

  it("fails closed if enumeration becomes unavailable during cleanup polling", async () => {
    let calls = 0;
    await expect(assertNoNewCoreProcesses(new Set(), {
      enumerate: () => {
        calls += 1;
        return calls === 1 ? new Set(["new-core-process"]) : null;
      },
      timeoutMs: 100,
      pollIntervalMs: 1,
    })).rejects.toThrow("enumeration was unavailable");
  });
});
