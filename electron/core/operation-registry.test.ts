import { Buffer } from "node:buffer";
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

function microphoneTestWavBase64(sampleCount: number): string {
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  return wav.toString("base64");
}

function meetingProfileFixture(id: string, builtIn: boolean) {
  return {
    schemaVersion: 2,
    version: 1,
    id,
    name: id === "one-on-one" ? "1:1" : id[0].toUpperCase() + id.slice(1),
    captureSource: "microphone",
    language: "auto",
    localModelTier: "balanced",
    speechModelId: "large-v3-turbo",
    cleanupModelId: "qwen3-4b-official-q4_k_m",
    summaryModelId: "qwen3-4b-official-q4_k_m",
    dictionaryIds: [],
    replacementRuleSetId: null,
    recapTemplate: "Summarize this meeting.",
    liveTranscription: true,
    builtIn,
  };
}

function replacementCustodyFixture() {
  return {
    separateFromAsrVocabularyHints: true,
    asrVocabularyHintsApplied: false,
    localOnly: true,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

function replacementRuleSetFixture(id: string, builtIn: boolean) {
  return {
    schemaVersion: 1,
    version: 1,
    id,
    name: builtIn ? "No replacements" : "Company terms",
    rules: builtIn ? [] : [{
      id: "company-name",
      order: 10,
      matchMode: "whole-word",
      literal: "Candorr",
      replacement: "Candor",
      protectedTermReview: false,
      enabled: true,
    }],
    builtIn,
  };
}

describe("core operation registry", () => {
  it("rejects structurally sensitive fields from generic renderer results", () => {
    const captureStatus = {
      implemented: true,
      active: false,
      activeSession: null,
      sources: { mic: { implemented: true }, system: { implemented: true } },
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    const coreStatus = {
      version: "0.4.0",
      protocolVersion: "candor-core-v1",
      uptimeMs: 1,
      networkPolicy: "disabled-by-default",
      updaterPolicy: "manual-check-only-disabled-in-m0",
      vaultState: "ready",
      sidecarTransport: "stdio-json-lines",
      startupRecovery: { attempted: true, ok: true },
    };
    const durableStatus = {
      rootKind: "app-data",
      recordingCount: 0,
      storageHealth: { state: "ready", checks: [{ ok: true }] },
      rawPathExposed: false,
    };

    const capture = CORE_OPERATIONS.get("capture.status")?.resultSchema;
    const core = CORE_OPERATIONS.get("core.status")?.resultSchema;
    const durable = CORE_OPERATIONS.get("recording.durable.status")?.resultSchema;
    expect(capture?.parse(captureStatus)).toEqual(captureStatus);
    expect(core?.parse({ ...coreStatus, pid: 1234 })).toEqual({ ...coreStatus, pid: 1234 });
    expect(durable?.parse(durableStatus)).toEqual(durableStatus);
    expect(CORE_OPERATIONS.get("capture.status")?.rendererResultFields)
      .toEqual(Object.keys(captureStatus));
    expect(CORE_OPERATIONS.get("core.status")?.rendererResultFields)
      .toEqual(Object.keys(coreStatus));
    expect(CORE_OPERATIONS.get("recording.durable.status")?.rendererResultFields)
      .toEqual(Object.keys(durableStatus));

    expect(() => capture?.parse({ ...captureStatus, devicePath: "C:\\private" }))
      .toThrow(/renderer custody sentinel/);
    expect(() => capture?.parse({
      ...captureStatus,
      sources: { mic: { implemented: true, rawDevicePath: "C:\\private" } },
    })).toThrow(/renderer custody sentinel/);
    expect(() => core?.parse({ ...coreStatus, privatePath: "C:\\private" }))
      .toThrow(/renderer custody sentinel/);
    expect(() => core?.parse({
      ...coreStatus,
      startupRecovery: { attempted: true, ok: true, secret: "private" },
    })).toThrow(/renderer custody sentinel/);
    expect(() => durable?.parse({ ...durableStatus, keyMaterial: "private" }))
      .toThrow(/renderer custody sentinel/);
    expect(() => durable?.parse({
      ...durableStatus,
      storageHealth: { state: "ready", checks: [{ accessToken: "private" }] },
    })).toThrow(/renderer custody sentinel/);
  });

  it("allows transcript values that contain a Windows path", () => {
    const text = "The file is C:\\Users\\Danny\\Documents\\meeting.txt.";
    const result = {
      recordingId: "recording-1",
      segmentCount: 1,
      durationMs: 1_000,
      segments: [{ index: 0, startMs: 0, endMs: 1_000, text }],
      rawPathExposed: false,
    };
    expect(CORE_OPERATIONS.get("recording.durable.transcriptPage")?.resultSchema.parse(result))
      .toEqual(result);
  });

  it("strictly bounds and canonicalizes native capture devices", () => {
    const input = {
      id: "input-0",
      label: "Built-in microphone",
      fingerprint: "a".repeat(64),
      ordinal: 0,
      isDefault: true,
      systemMonitorEligible: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    const output = {
      id: "output-0",
      label: "Built-in speakers",
      isDefault: true,
      loopbackEligible: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    const result = {
      defaultInputAvailable: true,
      defaultOutputAvailable: true,
      inputs: [input],
      outputs: [output],
      devices: [input],
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    const operation = CORE_OPERATIONS.get("capture.devices");
    expect(operation?.resultSchema.parse(result)).toEqual(result);
    expect(() => operation?.resultSchema.parse({ ...result, deviceStorePath: "C:\\private" }))
      .toThrow("result shape");
    expect(() => operation?.resultSchema.parse({
      ...result,
      inputs: [{ ...input, rawDevicePath: "C:\\private" }],
    })).toThrow("inputs[0] shape");
    expect(() => operation?.resultSchema.parse({
      ...result,
      inputs: [{ ...input, keyMaterialExposedToRenderer: true }],
    })).toThrow("renderer custody sentinel");
    expect(() => operation?.resultSchema.parse({ ...result, inputs: [input, input] }))
      .toThrow("inputs[1]");
    expect(() => operation?.resultSchema.parse({
      ...result,
      inputs: Array.from({ length: 129 }, (_, ordinal) => ({
        ...input,
        id: `input-${ordinal}`,
        ordinal,
      })),
    })).toThrow("inputs");
  });

  it("strictly validates microphone preference identity and custody", () => {
    const configured = {
      implemented: true,
      state: "ready",
      configured: true,
      preferredMicrophoneId: "input-3",
      preferredMicrophone: {
        deviceId: "input-3",
        deviceLabel: "USB microphone",
        fingerprint: "b".repeat(64),
        ordinal: 3,
        resolution: "fingerprint",
        reselectionRequired: false,
      },
      failureCode: null,
      localOnly: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    for (const method of ["capture.preferences", "capture.setPreferredMicrophone"]) {
      const operation = CORE_OPERATIONS.get(method);
      expect(operation?.resultSchema.parse(configured)).toEqual(configured);
      expect(() => operation?.resultSchema.parse({ ...configured, rawPathExposed: true }))
        .toThrow("renderer custody sentinel");
      expect(() => operation?.resultSchema.parse({
        ...configured,
        preferredMicrophone: { ...configured.preferredMicrophone, devicePath: "C:\\private" },
      })).toThrow("preferredMicrophone shape");
      expect(() => operation?.resultSchema.parse({
        ...configured,
        preferredMicrophoneId: "input-4",
      })).toThrow("microphone preference");
    }

    expect(CORE_OPERATIONS.get("capture.preferences")?.resultSchema.parse({
      ...configured,
      preferredMicrophoneId: "input-2",
      preferredMicrophone: { ...configured.preferredMicrophone, deviceId: "input-2" },
    })).toMatchObject({
      preferredMicrophoneId: "input-2",
      preferredMicrophone: { ordinal: 3, resolution: "fingerprint" },
    });

    expect(CORE_OPERATIONS.get("capture.preferences")?.resultSchema.parse({
      implemented: true,
      state: "corrupt",
      configured: false,
      preferredMicrophoneId: "default",
      preferredMicrophone: {
        deviceId: "default",
        deviceLabel: null,
        fingerprint: null,
        ordinal: null,
        resolution: "unavailable",
        reselectionRequired: false,
      },
      failureCode: "CAPTURE_PREFERENCES_CORRUPT",
      localOnly: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    })).toMatchObject({ state: "corrupt", configured: false });
  });

  it("accepts only internally consistent active and inactive microphone test statuses", () => {
    const active = {
      implemented: true,
      active: true,
      state: "listening",
      deviceLabel: "USB microphone",
      sourceSampleRateHz: 48_000,
      sourceChannelCount: 2,
      selectionResolution: "default",
      reselectionRequired: false,
      sampleRateHz: 16_000,
      channelCount: 1,
      rms: 0,
      peak: 0,
      clipping: false,
      signalDetected: false,
      signalState: "silence",
      captureComplete: false,
      sampleCount: 1_600,
      bufferedDurationMs: 100,
      durationMs: 100,
      maxDurationMs: 5_000,
      accessError: null,
      lastError: null,
      ephemeral: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    expect(CORE_OPERATIONS.get("capture.micTestStart")?.resultSchema.parse(active)).toEqual(active);
    expect(CORE_OPERATIONS.get("capture.micTestStatus")?.resultSchema.parse(active)).toEqual(active);

    const inactive = {
      implemented: true,
      active: false,
      state: "idle",
      deviceLabel: null,
      sourceSampleRateHz: null,
      sourceChannelCount: null,
      sampleRateHz: 16_000,
      channelCount: 1,
      rms: 0,
      peak: 0,
      clipping: false,
      signalDetected: false,
      signalState: "inactive",
      captureComplete: false,
      sampleCount: 0,
      bufferedDurationMs: 0,
      durationMs: 0,
      maxDurationMs: 5_000,
      accessError: null,
      lastError: null,
      ephemeral: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    const status = CORE_OPERATIONS.get("capture.micTestStatus");
    expect(status?.resultSchema.parse(inactive)).toEqual(inactive);
    expect(status?.resultSchema.parse({
      ...active,
      active: false,
      state: "permission-denied",
      rms: 0,
      peak: 0,
      sampleCount: 0,
      bufferedDurationMs: 0,
      accessError: {
        code: "MICROPHONE_PERMISSION_DENIED",
        message: "Microphone access is blocked by operating-system privacy settings",
      },
      lastError: "microphone permission denied",
    })).toMatchObject({ state: "permission-denied" });
    expect(() => status?.resultSchema.parse({ ...active, rms: 0.8, peak: 0.2 }))
      .toThrow("microphone test status");
    expect(() => status?.resultSchema.parse({ ...active, bufferedDurationMs: 99 }))
      .toThrow("microphone test status");
    expect(() => status?.resultSchema.parse({ ...active, keyMaterialExposedToRenderer: true }))
      .toThrow("renderer custody sentinel");
    expect(() => status?.resultSchema.parse({ ...active, rawAudioPath: "C:\\private" }))
      .toThrow("result shape");
  });

  it("requires the exact cleared microphone stop response", () => {
    const stopped = {
      implemented: true,
      active: false,
      state: "idle",
      stopped: true,
      bufferCleared: true,
      captureComplete: false,
      sampleRateHz: 16_000,
      channelCount: 1,
      maxDurationMs: 5_000,
      accessError: null,
      lastError: null,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    const operation = CORE_OPERATIONS.get("capture.micTestStop");
    expect(operation?.resultSchema.parse(stopped)).toEqual(stopped);
    expect(() => operation?.resultSchema.parse({ ...stopped, bufferCleared: false }))
      .toThrow("stopped microphone test status");
    expect(() => operation?.resultSchema.parse({ ...stopped, retainedSample: "AA==" }))
      .toThrow("result shape");
  });

  it("validates the bounded five-second PCM WAV microphone sample byte for byte", () => {
    const sampleCount = 80_000;
    const sample = {
      format: "wav",
      mimeType: "audio/wav",
      sampleRateHz: 16_000,
      channelCount: 1,
      bitsPerSample: 16,
      sampleCount,
      durationMs: 5_000,
      byteCount: 160_044,
      dataBase64: microphoneTestWavBase64(sampleCount),
      clipping: false,
      signalDetected: false,
      bufferCleared: true,
      maxDurationMs: 5_000,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    expect(sample.dataBase64).toHaveLength(213_392);
    const operation = CORE_OPERATIONS.get("capture.micTestSample");
    expect(operation?.resultSchema.parse(sample)).toEqual(sample);
    expect(() => operation?.resultSchema.parse({ ...sample, byteCount: 160_042 }))
      .toThrow("microphone test sample");
    expect(() => operation?.resultSchema.parse({ ...sample, dataBase64: "A".repeat(213_396) }))
      .toThrow("microphone test sample");
    expect(() => operation?.resultSchema.parse({
      ...sample,
      dataBase64: `AAAA${sample.dataBase64.slice(4)}`,
    })).toThrow("microphone test WAV");
    expect(() => operation?.resultSchema.parse({ ...sample, rawAudioPath: "C:\\private" }))
      .toThrow("result shape");
  });

  it("canonically bounds meeting profile lists and profile responses", () => {
    const profiles = ["general", "one-on-one", "interview", "standup", "lecture"]
      .map((id) => meetingProfileFixture(id, true));
    const list = {
      implemented: true,
      schemaVersion: 2,
      profiles,
      activeProfileId: "general",
      profileCount: profiles.length,
      customProfileLimit: 24,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    const listOperation = CORE_OPERATIONS.get("profiles.list");
    expect(listOperation?.resultSchema.parse(list)).toEqual(list);
    expect(() => listOperation?.resultSchema.parse({
      ...list,
      profiles: [{ ...profiles[0], privatePrompt: "must not cross" }, ...profiles.slice(1)],
    })).toThrow("profiles[0] shape");
    expect(() => listOperation?.resultSchema.parse({ ...list, profileCount: 4 }))
      .toThrow("meeting profile list");
    expect(() => listOperation?.resultSchema.parse({ ...list, activeProfileId: "missing" }))
      .toThrow("meeting profile list");

    const custom = {
      ...meetingProfileFixture("custom-sales", false),
      dictionaryIds: ["sales", "names"],
      replacementRuleSetId: "company-terms",
    };
    const response = {
      implemented: true,
      profile: custom,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    expect(CORE_OPERATIONS.get("profiles.get")?.resultSchema.parse(response)).toEqual(response);
    expect(CORE_OPERATIONS.get("profiles.upsert")?.resultSchema.parse(response)).toEqual(response);
    expect(() => CORE_OPERATIONS.get("profiles.get")?.resultSchema.parse({
      ...response,
      profile: { ...custom, dictionaryIds: ["sales", "sales"] },
    })).toThrow("profile.dictionaryIds[1]");
    expect(() => CORE_OPERATIONS.get("profiles.upsert")?.resultSchema.parse({
      ...response,
      profile: profiles[0],
    })).toThrow("meeting profile response");
  });

  it("canonically bounds deterministic replacement rule sets and previews", () => {
    const none = replacementRuleSetFixture("none", true);
    const custom = replacementRuleSetFixture("company-terms", false);
    const list = {
      implemented: true,
      schemaVersion: 1,
      ruleSets: [none, custom],
      ruleSetCount: 2,
      customRuleSetLimit: 16,
      ruleLimitPerSet: 64,
      ...replacementCustodyFixture(),
    };
    const listOperation = CORE_OPERATIONS.get("replacements.list");
    expect(listOperation?.resultSchema.parse(list)).toEqual(list);
    expect(() => listOperation?.resultSchema.parse({
      ...list,
      ruleSets: [none, {
        ...custom,
        rules: [{ ...custom.rules[0], privateRegex: ".*" }],
      }],
    })).toThrow("ruleSets[1].rules[0] shape");
    expect(() => listOperation?.resultSchema.parse({ ...list, ruleSetCount: 1 }))
      .toThrow("replacement rule set list");

    const response = {
      implemented: true,
      ruleSet: custom,
      ...replacementCustodyFixture(),
    };
    expect(CORE_OPERATIONS.get("replacements.get")?.resultSchema.parse(response)).toEqual(response);
    expect(CORE_OPERATIONS.get("replacements.upsert")?.resultSchema.parse(response)).toEqual(response);
    expect(() => CORE_OPERATIONS.get("replacements.upsert")?.resultSchema.parse({
      ...response,
      ruleSet: none,
    })).toThrow("replacement rule set response");

    const preview = {
      implemented: true,
      applied: false,
      changed: true,
      previewText: "Candor",
      previewToken: "c".repeat(64),
      changes: [{
        ruleId: "company-name",
        ruleOrder: 10,
        replacementCount: 2,
        protectedTermReview: true,
      }],
      replacementCount: 2,
      protectedTermReviewRequired: true,
      previewRequiredBeforeApply: true,
      rulesAreOrdered: true,
      rendererRegexAccepted: false,
      ...replacementCustodyFixture(),
    };
    const previewOperation = CORE_OPERATIONS.get("replacements.preview");
    expect(previewOperation?.resultSchema.parse(preview)).toEqual(preview);
    expect(CORE_OPERATIONS.get("replacements.apply")?.resultSchema.parse({
      ...preview,
      applied: true,
    })).toMatchObject({ applied: true, replacementCount: 2 });
    expect(() => previewOperation?.resultSchema.parse({ ...preview, replacementCount: 1 }))
      .toThrow("replacement preview");
    expect(() => previewOperation?.resultSchema.parse({
      ...preview,
      changes: [{ ...preview.changes[0], rulePattern: "must not cross" }],
    })).toThrow("changes[0] shape");
    expect(() => previewOperation?.resultSchema.parse({ ...preview, sourceInput: "Candorr" }))
      .toThrow("result shape");
  });

  it("requires an exact internally consistent original-audio reprocessing plan", () => {
    const plan = {
      recordingId: "recording_1",
      channel: "mic",
      inputKind: "originalDurableAudio",
      audioChunkIndices: [0, 2, 4],
      audioChunkCount: 3,
      sourceAudioSha256: "d".repeat(64),
      sourceAudioIntegrity: "pending-background-content-hash-verification",
      sampleRateHz: 16_000,
      channelCount: 1,
      bitsPerSample: 16,
      durationMs: 5_000,
      currentRevisionId: "tr-000001-1",
      revisionCount: 1,
      dispatchInput: {
        recordingId: "recording_1",
        channel: "mic",
      },
      originalAudioModified: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    const operation = CORE_OPERATIONS.get("transcription.prepareReprocess");
    expect(operation?.resultSchema.parse(plan)).toEqual(plan);
    expect(operation?.resultSchema.parse({
      ...plan,
      sourceAudioSha256: null,
      sourceAudioIntegrity: "pending-background-encrypted-chunk-authentication",
    })).toMatchObject({ sourceAudioSha256: null });
    expect(() => operation?.resultSchema.parse({ ...plan, audioChunkCount: 2 }))
      .toThrow("reprocessing plan");
    expect(() => operation?.resultSchema.parse({ ...plan, audioChunkIndices: [0, 2, 2] }))
      .toThrow("audioChunkIndices[2]");
    expect(() => operation?.resultSchema.parse({
      ...plan,
      dispatchInput: { ...plan.dispatchInput, channel: "system" },
    })).toThrow("reprocessing plan");
    expect(() => operation?.resultSchema.parse({
      ...plan,
      dispatchInput: { ...plan.dispatchInput, sourcePath: "C:\\private" },
    })).toThrow("dispatchInput shape");
    expect(() => operation?.resultSchema.parse({
      ...plan,
      sourceAudioSha256: null,
      sourceAudioIntegrity: "pending-background-content-hash-verification",
    })).toThrow("reprocessing plan");
  });

  it("treats media decoding as an accepted background job with a bounded request timeout", () => {
    expect(CORE_OPERATIONS.has("media.inspectFromPath")).toBe(false);
    const validation = CORE_OPERATIONS.get("media.validateLocalSourcePath");
    expect(validation?.mode).toBe("request");
    expect(validation?.scope).toBe("private");
    expect(validation?.timeoutMs).toBe(5_000);
    const eligible = {
      schemaVersion: 1,
      sourceSizeBytes: 1_024,
      eligible: true,
      localStorageVerified: true,
      regularFile: true,
      reparsePoint: false,
      cloudPlaceholder: false,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    expect(validation?.resultSchema.parse(eligible)).toEqual(eligible);
    expect(() => validation?.resultSchema.parse({
      ...eligible,
      sourceSizeBytes: 0,
    })).toThrow("private local media eligibility");
    expect(() => validation?.resultSchema.parse({
      ...eligible,
      rawPathExposed: true,
    })).toThrow("renderer custody sentinel");
    expect(() => validation?.resultSchema.parse({
      ...eligible,
      sourcePath: "C:\\private\\meeting.mp3",
    })).toThrow("result shape");

    const operation = CORE_OPERATIONS.get("media.importFromPath");
    expect(operation?.mode).toBe("job");
    expect(operation?.timeoutMs).toBe(10_000);
    expect(() => operation?.resultSchema.parse({
      jobId: "job_1",
      type: "media-import",
      state: "queued",
      createdAt: "2026-07-20T12:00:00.000Z",
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    })).not.toThrow();

    const completed = validateCompletedJobResult({
      jobId: "job_1",
      type: "media-import",
      state: "completed",
      result: {
        schemaVersion: 1,
        displayName: "meeting.mp3",
        mediaKind: "mp3",
        status: "ready",
        imported: true,
        recordingId: "recording_1",
        sourceSizeBytes: 1_024,
        importedPcmBytes: 6_400,
        durationMs: 200,
        sampleRateHz: 16_000,
        channelCount: 1,
        bitsPerSample: 16,
        durableChunkCount: 1,
        originalAudioRetained: false,
        containerMetadataPreserved: false,
        sourceModified: false,
        decoderExecutionAttempted: true,
        localOnly: true,
        networkAttempted: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
        unexpected: "removed",
      },
    });
    expect(completed).toMatchObject({
      result: { imported: true, recordingId: "recording_1", rawPathExposed: false },
    });
    expect(completed).not.toHaveProperty("result.unexpected");
  });

  it("accepts a bounded queued deletion that retains the user's confirmation", () => {
    const result = CORE_OPERATIONS.get("recording.durable.delete")?.resultSchema.parse({
      recordingId: "recording-queued",
      state: "deletionQueued",
      deleted: false,
      recordingDataRemoved: false,
      confirmationRetained: true,
      metadataCleanupComplete: false,
      retryRequired: true,
      permanent: true,
      rawPathExposed: false,
    });
    expect(result).toMatchObject({
      state: "deletionQueued",
      recordingDataRemoved: false,
      confirmationRetained: true,
      rawPathExposed: false,
    });
  });

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
    })).toThrow(/rawPathExposed|renderer custody sentinel/);
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

  it("accepts only core-resolved AI job intents", () => {
    const operation = CORE_OPERATIONS.get("ai.recap.start");
    expect(() => operation?.paramsSchema.parse({
      recordingId: "recording-1",
      intent: "untrusted-mode",
    })).toThrow("Invalid parameters");
    expect(operation?.paramsSchema.parse({
      recordingId: "recording-1",
      intent: "explicit-heuristic",
    })).toMatchObject({ intent: "explicit-heuristic" });
    expect(operation?.paramsSchema.parse({
      recordingId: "recording-1",
    })).toMatchObject({ intent: "default" });
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

  it("canonically validates core-owned speech model transparency evidence", () => {
    const result = {
      localOnly: true,
      cloudAi: false,
      modelRootKind: "user-data",
      modelPathAcceptedFromRenderer: false,
      installedModelCount: 1,
      models: [{
        modelId: "large-v3-turbo",
        language: "multilingual",
        role: "large-local-transcription",
        installed: true,
        verified: true,
        bytes: 1_000_000,
        verificationRequired: false,
        failureCode: null,
        hardwareRequirement: "At least 8 GB system memory and a passing local performance check",
        hardwareRequirements: {
          policy: "candor-local-whisper-v1",
          minimumMemoryBytes: 8 * 1_073_741_824,
          minimumLogicalCpuCount: 1,
          localCpuRequired: true,
          acceleratorRequired: false,
          passingLocalBenchmarkRequired: true,
          privateHardwareProbe: "must not cross",
        },
        warm: false,
        warmState: "cold",
        warmStateBasis: "in-process-whisper-context",
        measuredLatencyMs: 7_500,
        latencyMeasurementState: "measured",
        latencyMeasurementBasis: "30-second-local-inference-benchmark",
        actualSha256: "a".repeat(64),
        privateTelemetry: { modelPath: "must not cross" },
      }],
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
      internalStoreRoot: "must not cross",
    };
    const operation = CORE_OPERATIONS.get("models.listLocal");
    const canonical = operation?.resultSchema.parse(result);
    expect(canonical).not.toHaveProperty("internalStoreRoot");
    expect(canonical).not.toHaveProperty("models.0.actualSha256");
    expect(canonical).not.toHaveProperty("models.0.privateTelemetry");
    expect(canonical).not.toHaveProperty("models.0.hardwareRequirements.privateHardwareProbe");
    expect(canonical).toHaveProperty("models.0.measuredLatencyMs", 7_500);
    expect(() => operation?.resultSchema.parse({
      ...result,
      models: [{
        ...result.models[0],
        modelId: "small.en",
        language: "english",
        role: "higher-quality-transcription",
        hardwareRequirement: "Local CPU; Candor does not enforce a minimum memory threshold",
        hardwareRequirements: {
          ...result.models[0].hardwareRequirements,
          minimumMemoryBytes: null,
          passingLocalBenchmarkRequired: false,
        },
        measuredLatencyMs: null,
        latencyMeasurementState: "unmeasured",
        latencyMeasurementBasis: null,
      }],
    })).not.toThrow();
    expect(() => operation?.resultSchema.parse({
      ...result,
      models: [{ ...result.models[0], warm: true }],
    })).toThrow("models[0]");
    expect(() => operation?.resultSchema.parse({
      ...result,
      models: [{
        ...result.models[0],
        measuredLatencyMs: null,
        latencyMeasurementState: "unmeasured",
      }],
    })).toThrow("models[0]");
    expect(() => operation?.resultSchema.parse({
      ...result,
      models: [{ ...result.models[0], hardwareRequirement: "Recommended GPU" }],
    })).toThrow("models[0]");
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
        modelSha256: "a".repeat(64),
        runtimeSha256: "b".repeat(64),
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
          modelSha256: "a".repeat(64),
          runtimeSha256: "b".repeat(64),
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
          modelSha256: null,
          runtimeSha256: null,
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

  it("canonically bounds Trust History and strips private transcript identities", () => {
    const comparison = {
      rawTextSha256: "a".repeat(64),
      normalizedTextSha256: "b".repeat(64),
      rawTextBytes: 9,
      normalizedTextBytes: 8,
      rawSegmentCount: 1,
      normalizedSegmentCount: 1,
      changed: true,
      rawText: "must not cross",
    };
    const result = {
      recordingId: "recording_1",
      currentRevisionId: "tr-000001-1",
      currentCleanedRevisionId: null,
      revisionCount: 1,
      revisions: [{
        revisionId: "tr-000001-1",
        version: 1,
        source: "initial",
        kind: "raw-asr",
        parentRevisionId: null,
        engine: "whisper-rs",
        modelId: "base-en",
        modelSha256: "c".repeat(64),
        comparison,
        rawComparisonAvailable: true,
        createdAtMs: 1,
        rawTextChunkIndices: [41],
        rawTranscript: "must not cross",
      }],
      receiptCount: 1,
      processingReceipts: [{
        receiptId: "pr-000001-1",
        attempt: 1,
        operation: "transcription",
        stage: "transcription",
        outcome: "succeeded",
        engine: "whisper-rs",
        modelId: "base-en",
        modelSha256: "c".repeat(64),
        revisionId: "tr-000001-1",
        inputRevisionId: null,
        inputRevisionKind: null,
        promptTemplateSha256: null,
        validationResult: "passed",
        fallbackApplied: false,
        startedAtMs: 0,
        finishedAtMs: 1,
        elapsedMs: 1,
        comparison,
        rawTextChunkIndices: [41],
        transcript: "must not cross",
      }],
      immutableRevisions: true,
      originalAudioRetained: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
      privateManifest: { path: "must not cross" },
    };
    const operation = CORE_OPERATIONS.get("recording.trustHistory");
    const canonical = operation?.resultSchema.parse(result);
    expect(canonical).not.toHaveProperty("privateManifest");
    expect(canonical).not.toHaveProperty("revisions.0.rawTextChunkIndices");
    expect(canonical).not.toHaveProperty("revisions.0.rawTranscript");
    expect(canonical).not.toHaveProperty("revisions.0.comparison.rawText");
    expect(canonical).not.toHaveProperty("processingReceipts.0.rawTextChunkIndices");
    expect(canonical).not.toHaveProperty("processingReceipts.0.transcript");
    expect(() => operation?.resultSchema.parse({ ...result, receiptCount: 2 }))
      .toThrow("trust history bounds");
    expect(() => operation?.resultSchema.parse({ ...result, currentRevisionId: "tr-missing" }))
      .toThrow("currentRevisionId");

    const reviewed = operation?.resultSchema.parse({
      ...result,
      currentRevisionId: "tr-000002-2",
      revisionCount: 2,
      revisions: [
        result.revisions[0],
        {
          ...result.revisions[0],
          revisionId: "tr-000002-2",
          version: 2,
          source: "review",
          kind: "normalized",
          parentRevisionId: "tr-000001-1",
          engine: "candor-protected-term-review",
          modelId: null,
          modelSha256: null,
          createdAtMs: 2,
        },
      ],
      receiptCount: 2,
      processingReceipts: [
        result.processingReceipts[0],
        {
          ...result.processingReceipts[0],
          receiptId: "pr-000002-2",
          attempt: 2,
          operation: "protected-term-review",
          stage: "normalization",
          engine: "candor-protected-term-review",
          modelId: null,
          modelSha256: null,
          revisionId: "tr-000002-2",
          inputRevisionId: "tr-000001-1",
          inputRevisionKind: "raw-asr",
          startedAtMs: 1,
          finishedAtMs: 2,
        },
      ],
    });
    expect(reviewed).toMatchObject({
      currentRevisionId: "tr-000002-2",
      revisions: [{ source: "initial" }, { source: "review" }],
      processingReceipts: [
        { operation: "transcription" },
        { operation: "protected-term-review" },
      ],
    });

    const summarized = operation?.resultSchema.parse({
      ...result,
      currentRevisionId: "tr-000002-2",
      revisionCount: 2,
      revisions: (reviewed as { revisions: unknown[] }).revisions,
      receiptCount: 3,
      processingReceipts: [
        ...(reviewed as { processingReceipts: unknown[] }).processingReceipts,
        {
          receiptId: "pr-000003-3",
          attempt: 3,
          operation: "local-ai-recap",
          stage: "recap",
          outcome: "succeeded",
          engine: "llama-cpp-local",
          modelId: "qwen3-4b-official-q4_k_m",
          modelSha256: "d".repeat(64),
          revisionId: null,
          inputRevisionId: "tr-000002-2",
          inputRevisionKind: "normalized",
          promptTemplateSha256: "e".repeat(64),
          validationResult: "passed",
          fallbackApplied: false,
          errorCode: null,
          errorSummary: null,
          comparison: null,
          startedAtMs: 2,
          finishedAtMs: 3,
          elapsedMs: 1,
        },
      ],
    });
    expect(summarized).toMatchObject({
      processingReceipts: [
        { operation: "transcription" },
        { operation: "protected-term-review" },
        { operation: "local-ai-recap", revisionId: null, inputRevisionId: "tr-000002-2" },
      ],
    });
  });

  it("rebuilds exact bounded transcript revision segments at the Electron boundary", () => {
    const detail = {
      recordingId: "recording_1",
      revision: {
        revisionId: "tr-000001-1",
        version: 1,
        source: "initial",
        kind: "raw-asr",
        parentRevisionId: null,
        engine: "whisper-rs",
        modelId: null,
        modelSha256: null,
        comparison: {
          rawTextSha256: "a".repeat(64),
          normalizedTextSha256: "a".repeat(64),
          rawTextBytes: 5,
          normalizedTextBytes: 5,
          rawSegmentCount: 1,
          normalizedSegmentCount: 1,
          changed: false,
        },
        rawComparisonAvailable: false,
        createdAtMs: 1,
      },
      current: true,
      currentCleaned: false,
      segmentCount: 1,
      returnedSegmentCount: 1,
      hasMore: false,
      segments: [{
        index: 7,
        kind: "transcriptSegment",
        channel: "mic",
        speaker: null,
        text: "hello",
        startMs: 10,
        durationMs: 20,
        endMs: 30,
        confidence: null,
        rawPathExposed: false,
        privateMetadata: { rawTextChunkIndices: [41] },
      }],
      comparisonView: {
        available: false,
        reason: "legacy-revision",
        maxTextBytesPerSide: 64 * 1024,
        encryptedAtRest: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      },
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    const operation = CORE_OPERATIONS.get("recording.transcriptRevision");
    const canonical = operation?.resultSchema.parse(detail);
    expect(canonical).not.toHaveProperty("segments.0.privateMetadata");
    expect(canonical).toHaveProperty("segments.0.kind", "transcriptSegment");
    expect(() => operation?.resultSchema.parse({
      ...detail,
      segments: [{
        ...detail.segments[0],
        index: { rawTextChunkIndices: [41] },
        kind: "rawTranscriptText",
      }],
    })).toThrow("segments[0]");
    expect(() => operation?.resultSchema.parse({
      ...detail,
      segments: [{ ...detail.segments[0], kind: "rawTranscriptText" }],
    })).toThrow("segments[0]");
  });

  it("gives the cold-start handshake a larger budget than ordinary requests", () => {
    const handshake = CORE_OPERATIONS.get("core.version");
    const ordinaryRequest = CORE_OPERATIONS.get("core.ping");
    expect(handshake?.timeoutMs).toBe(15_000);
    expect(handshake?.timeoutMs).toBeGreaterThan(ordinaryRequest?.timeoutMs ?? Number.POSITIVE_INFINITY);
  });

  it("bounds full local bundle verification without using the ordinary request budget", () => {
    expect(CORE_OPERATIONS.get("ai.bundledAssetsStatus")?.timeoutMs).toBe(120_000);
  });

  it("bounds capture-time profile bindings and protected replacement review output", () => {
    const result = {
      recordingId: "recording-1",
      engine: "whisper-rs",
      segmentCount: 2,
      modelId: "large-v3-turbo",
      language: "fr",
      processingProfile: {
        schemaVersion: 1,
        profileId: "interview-fr",
        profileVersion: 3,
        modelId: "large-v3-turbo",
        language: "fr",
        transcriptionLanguage: "fr",
        dictionaryIds: ["legal"],
        replacementRuleSetId: "names",
        replacementRuleSetVersion: 2,
        immutableAtCaptureStart: true,
        rawPathExposed: false,
      },
      normalization: {
        ruleSetId: "names",
        ruleSetVersion: 2,
        automaticReplacementCount: 1,
        automaticChanges: [{ ruleId: "company", ruleOrder: 1, replacementCount: 1, protectedTermReview: false }],
        protectedTermReviewRequired: true,
        protectedTermMatches: [{ ruleId: "patient", ruleOrder: 2, replacementCount: 1, protectedTermReview: true }],
        protectedTermsAutoReplaced: false,
        rulesAppliedInDeterministicOrder: true,
      },
      rawPathExposed: false,
    };
    expect(validateCompletedJobResult({
      jobId: "a".repeat(32), type: "transcription", state: "completed", result,
    })).toMatchObject({ result: { processingProfile: { profileVersion: 3 }, normalization: { protectedTermsAutoReplaced: false } } });
    expect(() => validateCompletedJobResult({
      jobId: "a".repeat(32),
      type: "transcription",
      state: "completed",
      result: {
        ...result,
        normalization: { ...result.normalization, protectedTermsAutoReplaced: true },
      },
    })).toThrow("normalization");
  });

  it("validates core-owned protected-term review previews and durable apply receipts", () => {
    const preview = {
      implemented: true,
      recordingId: "recording_1",
      revisionId: "tr-000001-1",
      ruleSetId: "protected-names",
      ruleSetVersion: 2,
      reviewRequired: true,
      replacementCount: 1,
      changes: [{ ruleId: "company-name", ruleOrder: 1, replacementCount: 1, protectedTermReview: true }],
      changedSegmentCount: 1,
      previewSegments: [{
        channel: "mic",
        speaker: "Speaker 1",
        startMs: 10,
        durationMs: 20,
        before: "Acme joined.",
        after: "ACME joined.",
        beforeTruncated: false,
        afterTruncated: false,
      }],
      previewTruncated: false,
      previewToken: "a".repeat(64),
      durableApplyCreatesRevision: true,
      rendererSuppliedTranscriptAccepted: false,
      captureTimeRuleSnapshotUsed: true,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    expect(CORE_OPERATIONS.get("transcription.protectedTermReview")?.resultSchema.parse(preview))
      .toMatchObject({ reviewRequired: true, replacementCount: 1, previewToken: "a".repeat(64) });
    expect(() => CORE_OPERATIONS.get("transcription.protectedTermReview")?.resultSchema.parse({
      ...preview,
      previewSegments: [{ ...preview.previewSegments[0], after: preview.previewSegments[0].before }],
    })).toThrow("previewSegments[0]");

    const applied = {
      implemented: true,
      recordingId: "recording_1",
      applied: true,
      replacementCount: 1,
      writtenSegmentCount: 1,
      ruleSetId: "protected-names",
      ruleSetVersion: 2,
      trustHistory: {
        recordingId: "recording_1",
        revisionId: "tr-000002-2",
        version: 2,
        receiptId: "pr-000002-2",
        source: "review",
        current: true,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      },
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    expect(CORE_OPERATIONS.get("transcription.applyProtectedTermReview")?.resultSchema.parse(applied))
      .toMatchObject({ applied: true, trustHistory: { source: "review", version: 2 } });
    expect(() => CORE_OPERATIONS.get("transcription.applyProtectedTermReview")?.resultSchema.parse({
      ...applied,
      trustHistory: { ...applied.trustHistory, source: "reprocess" },
    })).toThrow("protected-term review apply");
  });

  it("canonically validates the live transcript custody boundary", () => {
    const session = CORE_OPERATIONS.get("liveTranscript.start")?.resultSchema.parse({
      schemaVersion: 1,
      recordingId: "recording_1",
      enabled: true,
      active: true,
      provisionalSegmentCount: 0,
      pendingEventCount: 0,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
      unexpected: "removed",
    });
    expect(session).not.toHaveProperty("unexpected");

    const payload = {
      event: "transcript.partial",
      schemaVersion: 1,
      recordingId: "recording_1",
      sequence: 1,
      provisional: true,
      isFinal: false,
      startMs: 0,
      endMs: 500,
      text: "local partial",
      segmentCount: 1,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    } as const;
    const drain = {
      schemaVersion: 1,
      events: [{
        schemaVersion: 1,
        deliverySequence: 1,
        channel: "transcript.partial",
        payload,
        localOnly: true,
        networkAttempted: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      }],
      drainedEventCount: 1,
      remainingEventCount: 0,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    expect(() => CORE_OPERATIONS.get("liveTranscript.eventsDrain")?.resultSchema.parse(drain))
      .not.toThrow();
    expect(() => CORE_OPERATIONS.get("liveTranscript.eventsDrain")?.resultSchema.parse({
      ...drain,
      events: [{ ...drain.events[0], payload: { ...payload, networkAttempted: true } }],
    })).toThrow("local custody");
    expect(() => CORE_OPERATIONS.get("liveTranscript.eventsDrain")?.resultSchema.parse({
      ...drain,
      events: [{ ...drain.events[0], channel: "renderer.selected" }],
    })).toThrow("events[0]");
  });

  it("fails closed on unavailable diarization and user-controlled speaker names", () => {
    const status = {
      implemented: true,
      schemaVersion: 1,
      state: "engine-unavailable",
      reasonCode: "DIARIZATION_ENGINE_UNAVAILABLE",
      enabledByUser: true,
      savedLocally: true,
      engineAvailable: false,
      diarizationAvailable: false,
      diarizationRunning: false,
      modelVerified: false,
      licenseEvidenceVerified: false,
      redistributionAllowed: false,
      benchmarkPassed: false,
      benchmarkRequired: true,
      gate: {
        schemaVersion: 1,
        status: "model-not-verified",
        reasonCode: "DIARIZATION_MODEL_NOT_VERIFIED",
        diarizationAllowed: false,
        modelId: null,
        benchmarkRequired: true,
        licenseEvidenceVerified: false,
        redistributionAllowed: false,
        anonymousSpeakerLabelsOnly: true,
        biometricIdentityClaimed: false,
        localOnly: true,
        networkAttempted: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      },
      speakerNamingAvailable: true,
      anonymousSpeakerLabelsOnly: true,
      identityInferred: false,
      biometricIdentityClaimed: false,
      encryptedAtRest: true,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
      modelPath: "removed",
    };
    const canonical = CORE_OPERATIONS.get("diarization.status")?.resultSchema.parse(status);
    expect(canonical).not.toHaveProperty("modelPath");
    expect(() => CORE_OPERATIONS.get("diarization.status")?.resultSchema.parse({
      ...status,
      diarizationAvailable: true,
    })).toThrow("local diarization gate");
    expect(() => CORE_OPERATIONS.get("diarization.status")?.resultSchema.parse({
      ...status,
      biometricIdentityClaimed: true,
    })).toThrow("local diarization gate");

    const names = {
      implemented: true,
      recordingId: "recording_1",
      assignmentCount: 1,
      assignments: [{
        schemaVersion: 1,
        anonymousSpeakerId: "speaker-1",
        displayName: "Avery",
        source: "user",
        userControlled: true,
        identityInferred: false,
        biometricIdentityClaimed: false,
        localOnly: true,
        networkAttempted: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      }],
      userControlled: true,
      identityInferred: false,
      biometricIdentityClaimed: false,
      anonymousSpeakerLabelsOnly: true,
      encryptedAtRest: true,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    expect(() => CORE_OPERATIONS.get("diarization.speakerNames")?.resultSchema.parse(names))
      .not.toThrow();
    expect(() => CORE_OPERATIONS.get("diarization.speakerNames")?.resultSchema.parse({
      ...names,
      assignments: [{ ...names.assignments[0], identityInferred: true }],
    })).toThrow("assignments[0]");
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
