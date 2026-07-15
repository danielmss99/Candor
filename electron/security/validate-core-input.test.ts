import { describe, expect, it } from "vitest";
import { rendererCoreOperations } from "../core/protocol.js";
import { validateRendererCoreParams } from "./validate-core-input.js";

describe("renderer core input validation", () => {
  it("accepts and normalizes bounded capture input", () => {
    expect(
      validateRendererCoreParams("capture.startMicAndSystem", {
        label: "  Weekly sync  ",
        micDeviceId: "mic-1",
        systemDeviceId: "system-1",
        chunkMs: 500,
      }),
    ).toEqual({
      label: "Weekly sync",
      micDeviceId: "mic-1",
      systemDeviceId: "system-1",
      chunkMs: 500,
    });
  });

  it("rejects unknown fields and invalid numeric bounds", () => {
    expect(() => validateRendererCoreParams("capture.startMic", { command: "calc.exe" }))
      .toThrow("field command is not allowed");
    expect(() => validateRendererCoreParams("capture.startMic", { chunkMs: 99 }))
      .toThrow("chunkMs must be an integer from 100 to 2000");
    expect(() => validateRendererCoreParams("recording.durable.listPage", { offset: 0, limit: 101 }))
      .toThrow("limit must be an integer from 1 to 100");
  });

  it("rejects malformed identifiers and oversized user content", () => {
    expect(() => validateRendererCoreParams("recording.durable.read", { recordingId: "../vault" }))
      .toThrow("recordingId is invalid");
    expect(() => validateRendererCoreParams("ai.askInstruct", {
      recordingId: "recording_1",
      question: "x".repeat(501),
    })).toThrow("question must contain 1 to 500 characters");
    expect(() => validateRendererCoreParams("recording.notes.save", {
      recordingId: "recording_1",
      markdown: "x".repeat(2_000_001),
    })).toThrow("markdown must be at most 2000000 characters and 3900000 UTF-8 bytes");
    expect(() => validateRendererCoreParams("recording.notes.save", {
      recordingId: "recording_1",
      markdown: "\u{1F642}".repeat(1_000_000),
    })).toThrow("3900000 UTF-8 bytes");
  });

  it("rejects unknown consent identifiers and unsupported exports", () => {
    expect(() => validateRendererCoreParams("consent.acknowledge", { items: ["uploadEverything"] }))
      .toThrow("unknown identifier");
    expect(() => validateRendererCoreParams("export.create", {
      recordingId: "recording_1",
      format: "html",
    })).toThrow("format is not supported");
  });

  it("keeps transcription prompting and language selection inside the trusted core", () => {
    expect(() => validateRendererCoreParams("transcription.runLocal", {
      recordingId: "recording_1",
      language: "en",
    })).toThrow("field language is not allowed");
    expect(() => validateRendererCoreParams("transcription.runLocal", {
      recordingId: "recording_1",
      initialPrompt: "Use these terms",
    })).toThrow("field initialPrompt is not allowed");
  });

  it("requires parameterless operations to remain parameterless", () => {
    expect(validateRendererCoreParams("core.status", null)).toBeNull();
    expect(() => validateRendererCoreParams("core.status", { verbose: true }))
      .toThrow("parameters are not accepted");
    expect(() => validateRendererCoreParams("core.ping", { transport: "generic" }))
      .toThrow("parameters are not accepted");
  });

  it("defines a runtime input contract for every renderer operation", () => {
    const recordingId = "recording_1";
    const validInputByMethod: Record<string, unknown> = {
      "core.ping": null,
      "core.version": null,
      "core.capabilities": null,
      "core.status": null,
      "vault.openLocal": null,
      "vault.status": null,
      "privacy.auditSnapshot": null,
      "privacy.capabilities": null,
      "updates.status": null,
      "import.v2.status": null,
      "consent.status": null,
      "consent.acknowledge": { items: ["localOnlyStorage"] },
      "capture.status": null,
      "capture.devices": null,
      "capture.startMic": {},
      "capture.startSystem": {},
      "capture.startMicAndSystem": {},
      "capture.stop": null,
      "models.status": null,
      "models.listLocal": null,
      "models.verifyLocal": {},
      "ai.status": null,
      "ai.bundledAssetsStatus": null,
      "ai.instructAssetsStatus": null,
      "ai.instructStatus": null,
      "ai.schedulerStatus": null,
      "ai.fallbackPreference.status": null,
      "ai.fallbackPreference.update": { preference: "ask-first" },
      "transcription.status": null,
      "transcription.quality.status": null,
      "transcription.quality.update": { tier: "balanced", languagePreference: "english" },
      "terminology.status": {},
      "terminology.setEnabled": { dictionaryId: "dictionary_1", enabled: true },
      "terminology.assign": { recordingId, dictionaryId: "dictionary_1", enabled: true },
      "terminology.proposals": { recordingId },
      "terminology.decide": { recordingId, proposalId: "proposal_1", decision: "accepted" },
      "recording.durable.status": null,
      "recording.durable.listPage": { offset: 0, limit: 50 },
      "recording.durable.read": { recordingId },
      "recording.durable.replayManifest": { recordingId },
      "recording.durable.transcriptPage": { recordingId, offset: 0, limit: 50 },
      "recording.privacyReceipt": { recordingId },
      "recording.durable.readAudioChunk": { recordingId, index: 0 },
      "recording.durable.search": { query: "budget" },
      "recording.notes.read": { recordingId },
      "recording.notes.save": { recordingId, markdown: "notes" },
      "retention.status": null,
    };
    const rendererMethods = rendererCoreOperations.map(({ method }) => method).sort();

    expect(Object.keys(validInputByMethod).sort()).toEqual(rendererMethods);
    for (const method of rendererMethods) {
      expect(() => validateRendererCoreParams(method, validInputByMethod[method])).not.toThrow();
    }
  });
});
