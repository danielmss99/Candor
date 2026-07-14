import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "./json.js";
import { parseCoreHandshake } from "./protocol.js";
import {
  CORE_OPERATIONS,
  privateCoreMethods,
  rendererCoreMethods,
  rendererCoreOperations,
  validateCompletedJobResult,
} from "./operation-registry.js";

interface Fixture {
  kind: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  value?: unknown;
  expectedCode?: string;
}

function fixtures(group: "valid" | "invalid"): Fixture[] {
  const directory = path.resolve(process.cwd(), "fixtures", "protocol", group);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")) as Fixture);
}

describe("core operation registry", () => {
  it("validates completed job results by work type", () => {
    expect(validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "export",
      state: "completed",
      result: { format: "pdf", fileName: "report.pdf", bytes: 10, rawPathExposed: false },
    })).toMatchObject({ result: { format: "pdf", bytes: 10 } });
    expect(validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "export",
      state: "completed",
      result: {
        format: "wav",
        fileName: "meeting.wav",
        bytes: 10,
        dataBase64: "UklGRg==",
        rawPathExposed: false,
        unexpected: "must not cross",
      },
    })).toEqual(expect.objectContaining({
      result: expect.objectContaining({ dataBase64: "UklGRg==" }),
    }));
    expect(validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "export",
      state: "completed",
      result: {
        format: "wav",
        fileName: "meeting.wav",
        bytes: 10,
        dataBase64: "UklGRg==",
        rawPathExposed: false,
        unexpected: "must not cross",
      },
    })).not.toHaveProperty("result.unexpected");
    expect(() => validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "export",
      state: "completed",
      result: {
        format: "pdf",
        fileName: "report.pdf",
        bytes: 10,
        rawPathExposed: false,
        metadata: { transcript: "must not cross" },
      },
    })).toThrow("forbidden transcript");
    expect(() => validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "export",
      state: "completed",
      result: { format: "pdf", fileName: "report.pdf", bytes: "ten", rawPathExposed: false },
    })).toThrow("bytes");
    expect(validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "local-ai-benchmark",
      state: "completed",
      result: {
        benchmarkState: "measured",
        tier: "balanced",
        passed: true,
        whisperMeasured: true,
        localLlmMeasured: true,
        localOnly: true,
        cloudAi: false,
        rawModelNamesExposed: false,
        rawHashExposed: false,
        rawMetricExposed: false,
        rawPathExposed: false,
      },
    })).toMatchObject({ result: { benchmarkState: "measured", passed: true } });
    expect(validateCompletedJobResult({
      jobId: "b".repeat(32),
      type: "dictionary-import",
      state: "completed",
      result: {
        imported: true,
        dictionaryId: "dict-1",
        name: "Pharmaceutics",
        entryCount: 10,
        enabled: true,
        trustLabel: "community-unverified",
        scope: "specialist",
        encryptedAtRest: true,
        localOnly: true,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      },
    })).toMatchObject({ result: { dictionaryId: "dict-1", entryCount: 10 } });
    expect(validateCompletedJobResult({
      jobId: "c".repeat(32),
      type: "dictionary-index",
      state: "completed",
      result: {
        state: "ready",
        dictionaryCount: 1,
        entryCount: 10,
        indexedDictionaryId: "dict-1",
        encryptedAtRest: true,
        localOnly: true,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      },
    })).toMatchObject({ result: { indexedDictionaryId: "dict-1" } });
  });

  it("rejects completed results with contradictory local custody or dictionary trust", () => {
    expect(() => validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "transcription",
      state: "completed",
      result: {
        recordingId: "recording-1",
        engine: "whisper-rs",
        segmentCount: 2,
        rawPathExposed: true,
      },
    })).toThrow("rawPathExposed");
    expect(() => validateCompletedJobResult({
      jobId: "b".repeat(32),
      type: "local-ai-benchmark",
      state: "completed",
      result: {
        benchmarkState: "measured",
        tier: "balanced",
        passed: true,
        whisperMeasured: true,
        localLlmMeasured: true,
        localOnly: false,
        cloudAi: false,
        rawModelNamesExposed: false,
        rawHashExposed: false,
        rawMetricExposed: false,
        rawPathExposed: false,
      },
    })).toThrow("localOnly");
    expect(() => validateCompletedJobResult({
      jobId: "c".repeat(32),
      type: "dictionary-import",
      state: "completed",
      result: {
        imported: true,
        dictionaryId: "dict-1",
        name: "Pharmaceutics",
        entryCount: 10,
        enabled: true,
        trustLabel: "verified-organization",
        scope: "specialist",
        encryptedAtRest: true,
        localOnly: true,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      },
    })).toThrow("dictionary trust result");
    expect(() => validateCompletedJobResult({
      jobId: "d".repeat(32),
      type: "dictionary-import",
      state: "completed",
      result: {
        imported: true,
        dictionaryId: "dict-1",
        name: "Pharmaceutics",
        entryCount: 10,
        enabled: true,
        trustLabel: "verified-candor",
        scope: "project",
        encryptedAtRest: true,
        localOnly: true,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      },
    })).toThrow("dictionary trust result");
  });

  it("preserves the safe fields required to save completed local exports", () => {
    expect(validateCompletedJobResult({
      jobId: "e".repeat(32),
      type: "export",
      state: "completed",
      result: {
        format: "markdown",
        mimeType: "text/markdown; charset=utf-8",
        fileName: "report.md",
        markdown: "# Report\n",
        bytes: 9,
        generatedLocally: true,
        networkAttempted: false,
        localOnly: true,
        cloudAi: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      },
    })).toMatchObject({
      result: {
        markdown: "# Report\n",
        generatedLocally: true,
        networkAttempted: false,
      },
    });
  });

  it("rejects contradictory fallback policy combinations", () => {
    const operation = CORE_OPERATIONS.get("ai.recap.start");
    expect(() => operation?.paramsSchema.parse({
      recordingId: "recording-1",
      mode: "heuristic-fallback",
      fallbackPolicy: "require-local-llm",
    })).toThrow("Invalid parameters");
    expect(operation?.paramsSchema.parse({
      recordingId: "recording-1",
      mode: "heuristic-fallback",
      fallbackPolicy: "allow-disclosed",
    })).toMatchObject({ mode: "heuristic-fallback", fallbackPolicy: "allow-disclosed" });
  });

  it("keeps benchmark inputs tier-only at the private boundary", () => {
    const operation = CORE_OPERATIONS.get("transcription.quality.benchmark.start");
    expect(operation?.paramsSchema.parse({ tier: "balanced" })).toEqual({ tier: "balanced" });
    expect(() => operation?.paramsSchema.parse({ tier: "fast" })).toThrow("Invalid parameters");
    expect(() => operation?.paramsSchema.parse({
      tier: "balanced",
      prompt: "user supplied",
    })).toThrow("Invalid parameters");
  });

  it("validates rounded transcription estimates without exposing raw measurements", () => {
    const operation = CORE_OPERATIONS.get("transcription.quality.status");
    const result = {
      implemented: true,
      state: "ready",
      tier: "balanced",
      languagePreference: "english",
      recommendedTier: "balanced",
      benchmarkState: "measured",
      estimatedRealTimeFactor: null,
      estimatedMinutesPerHour: 15,
      estimatedCompletionAvailable: true,
      hardware: {},
      tiers: [],
      localOnly: true,
      cloudAi: false,
      rawPathExposed: false,
    };
    expect(operation?.resultSchema.parse(result)).toMatchObject({ estimatedMinutesPerHour: 15 });
    expect(() => operation?.resultSchema.parse({
      ...result,
      estimatedRealTimeFactor: 0.25,
    })).toThrow("local completion estimate");
    expect(() => operation?.resultSchema.parse({
      ...result,
      estimatedMinutesPerHour: null,
    })).toThrow("local completion estimate");
  });

  it("rejects ungrounded llama.cpp job results at the Electron boundary", () => {
    const grounded = {
      recordingId: "recording_1",
      engine: "llama-cpp-local",
      summary: "Adalimumab remains at 40 mg.",
      recapMarkdown: "Adalimumab remains at 40 mg. [s0]",
      decisions: [{ text: "Adalimumab remains at 40 mg.", sourceIds: ["s0"] }],
      actions: [{ text: "Priya reviews the evidence.", confidence: "high", sourceIds: ["s0"] }],
      risks: [],
      questions: [],
      citations: [{
        citationId: "s0",
        segmentIndex: 0,
        startMs: 10,
        quote: "Adalimumab remains at 40 mg.",
        rawPathExposed: false,
      }],
      sourceIds: ["s0"],
      localOnly: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
      cloudAi: false,
      outputSchemaVersion: 1,
      strictOutputValidated: true,
      groundingMethod: "strict-source-id-and-exact-critical-evidence-v1",
      modelOutputGrounded: true,
      citationsAddedByCore: false,
      unsupportedClaimsRemoved: 0,
      provenance: {
        engine: "local-llm",
        modelId: "qwen3-4b-official-q4_k_m",
        fallbackUsed: false,
        fallbackReason: null,
        promptVersion: "candor-grounded-v1",
        generatedAt: "2026-07-14T12:00:01Z",
        transcript: "must not cross",
      },
    };
    expect(() => validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "recap",
      state: "completed",
      result: grounded,
    })).not.toThrow();
    expect(() => validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "recap",
      state: "completed",
      result: { ...grounded, sourceIds: ["s999"] },
    })).toThrow("sourceIds");
    expect(() => validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "recap",
      state: "completed",
      result: { ...grounded, strictOutputValidated: false },
    })).toThrow("strict grounding metadata");
    const canonical = validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "recap",
      state: "completed",
      result: grounded,
    });
    expect(canonical).not.toHaveProperty("result.provenance.transcript");
    expect(() => validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "recap",
      state: "completed",
      result: {
        ...grounded,
        provenance: {
          engine: "local-llm",
          modelId: "qwen3-4b-official-q4_k_m",
          fallbackUsed: false,
          fallbackReason: null,
          generatedAt: "2026-07-14T12:00:01Z",
        },
      },
    })).toThrow("provenance");
    expect(() => validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "recap",
      state: "completed",
      result: {
        ...grounded,
        provenance: {
          ...grounded.provenance,
          engine: "heuristic",
          modelId: null,
          fallbackUsed: true,
          fallbackReason: "user-requested",
        },
      },
    })).toThrow("provenance engine");
  });

  it("is the complete source for renderer and private allowlists", () => {
    expect(CORE_OPERATIONS.size).toBeGreaterThan(40);
    expect(privateCoreMethods).toEqual(new Set(CORE_OPERATIONS.keys()));
    expect(rendererCoreMethods).toEqual(new Set(rendererCoreOperations.map(({ method }) => method)));
    for (const operation of CORE_OPERATIONS.values()) {
      expect(operation.paramsSchema.name).toBe(`${operation.method}.params`);
      expect(operation.resultSchema.name).toBe(`${operation.method}.result`);
      expect(operation.timeoutMs).toBeGreaterThan(0);
      expect(operation.requiresHandshake).toBe(operation.method !== "core.version");
    }
  });

  it("keeps superseded direct job operations private", () => {
    const deprecatedDirectJobs = [
      "ai.askHeuristic",
      "ai.recapHeuristic",
      "ai.askInstruct",
      "ai.recapInstruct",
      "transcription.runLocal",
      "export.create",
    ];
    for (const method of deprecatedDirectJobs) {
      expect(rendererCoreMethods.has(method), method).toBe(false);
      expect(privateCoreMethods.has(method), method).toBe(true);
      expect(CORE_OPERATIONS.get(method)?.channel, method).toBeUndefined();
    }
  });

  it("accepts all shared valid fixtures", () => {
    for (const fixture of fixtures("valid")) {
      if (fixture.kind === "handshake") {
        expect(() => parseCoreHandshake(fixture.value as JsonValue)).not.toThrow();
        continue;
      }
      const operation = fixture.method ? CORE_OPERATIONS.get(fixture.method) : undefined;
      expect(operation, `missing operation ${fixture.method ?? "unknown"}`).toBeDefined();
      expect(() => operation?.paramsSchema.parse(fixture.params)).not.toThrow();
      expect(() => operation?.resultSchema.parse(fixture.result)).not.toThrow();
    }
  });

  it("rejects all shared invalid fixtures with stable error codes", () => {
    for (const fixture of fixtures("invalid")) {
      const operation = fixture.method ? CORE_OPERATIONS.get(fixture.method) : undefined;
      expect(operation, `missing operation ${fixture.method ?? "unknown"}`).toBeDefined();
      const parse = fixture.kind === "operation-params"
        ? () => operation?.paramsSchema.parse(fixture.value)
        : () => operation?.resultSchema.parse(fixture.value);
      expect(parse).toThrow(expect.objectContaining({ code: fixture.expectedCode }));
    }
  });
});
