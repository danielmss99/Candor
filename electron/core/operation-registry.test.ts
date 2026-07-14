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
      outputSchemaVersion: 1,
      strictOutputValidated: true,
      groundingMethod: "strict-source-id-and-exact-critical-evidence-v1",
      modelOutputGrounded: true,
      citationsAddedByCore: false,
      unsupportedClaimsRemoved: 0,
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
