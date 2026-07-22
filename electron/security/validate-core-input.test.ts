import { describe, expect, it } from "vitest";
import { rendererCoreOperations } from "../core/protocol.js";
import { validateRendererCoreParams } from "./validate-core-input.js";

describe("renderer core input validation", () => {
  it("accepts and normalizes bounded capture input", () => {
    expect(
      validateRendererCoreParams("capture.startMicAndSystem", {
        label: "  Weekly sync  ",
        systemDeviceId: "system-1",
        chunkMs: 500,
        profileId: "weekly-sync",
        profileVersion: 3,
      }),
    ).toEqual({
      label: "Weekly sync",
      systemDeviceId: "system-1",
      chunkMs: 500,
      profileId: "weekly-sync",
      profileVersion: 3,
    });
  });

  it("rejects unknown fields and invalid numeric bounds", () => {
    expect(() => validateRendererCoreParams("capture.startMic", { command: "calc.exe" }))
      .toThrow("field command is not allowed");
    expect(() => validateRendererCoreParams("capture.startMic", { chunkMs: 99 }))
      .toThrow("chunkMs must be an integer from 100 to 2000");
    expect(() => validateRendererCoreParams("capture.startMic", { profileId: "general" }))
      .toThrow("profileId and profileVersion must be provided together");
    expect(() => validateRendererCoreParams("recording.durable.listPage", { offset: 0, limit: 101 }))
      .toThrow("limit must be an integer from 1 to 100");
  });

  it("accepts bounded microphone-test preferences and rejects forged identity data", () => {
    const fingerprint = "a".repeat(64);
    expect(validateRendererCoreParams("capture.setPreferredMicrophone", {
      deviceId: "input-2",
      fingerprint,
      ordinal: 2,
    })).toEqual({ deviceId: "input-2", fingerprint, ordinal: 2 });
    expect(validateRendererCoreParams("capture.micTestStart", {})).toEqual({});
    expect(() => validateRendererCoreParams("capture.micTestStart", { deviceId: "input-2" }))
      .toThrow("field deviceId is not allowed");
    expect(() => validateRendererCoreParams("capture.startMic", { deviceId: "input-2" }))
      .toThrow("field deviceId is not allowed");
    expect(() => validateRendererCoreParams("capture.setPreferredMicrophone", {
      deviceId: "input-2",
      fingerprint: "../not-a-fingerprint",
    })).toThrow("fingerprint must be 64 lowercase hexadecimal characters");
    expect(() => validateRendererCoreParams("capture.micTestStart", { executable: "calc.exe" }))
      .toThrow("field executable is not allowed");
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

  it("validates profiles and deterministic replacement rules as bounded structured data", () => {
    const profile = {
      name: "Interview",
      captureSource: "combined",
      language: "en-US",
      localModelTier: "maximum",
      dictionaryIds: ["medical-terms"],
      replacementRuleSetId: "protected-terms",
      recapTemplate: "Summarize evidence and follow-ups.",
      liveTranscription: false,
    };
    expect(validateRendererCoreParams("profiles.upsert", profile)).toEqual(profile);
    expect(() => validateRendererCoreParams("profiles.upsert", {
      ...profile,
      executable: "calc.exe",
    })).toThrow("field executable is not allowed");

    const ruleSet = {
      name: "Protected terms",
      rules: [{
        id: "candor-name",
        order: 10,
        matchMode: "whole-word",
        literal: "candle",
        replacement: "Candor",
        protectedTermReview: true,
        enabled: true,
      }],
    };
    expect(validateRendererCoreParams("replacements.upsert", ruleSet)).toEqual(ruleSet);
    expect(() => validateRendererCoreParams("replacements.upsert", {
      ...ruleSet,
      rules: [...ruleSet.rules, { ...ruleSet.rules[0], id: "duplicate", order: 10 }],
    })).toThrow("rule IDs and order values must be unique");
  });

  it("accepts only core-bound protected-term review approval", () => {
    expect(validateRendererCoreParams("transcription.protectedTermReview", {
      recordingId: "recording_1",
    })).toEqual({ recordingId: "recording_1" });
    expect(validateRendererCoreParams("transcription.applyProtectedTermReview", {
      recordingId: "recording_1",
      revisionId: "tr-000001-1",
      previewToken: "a".repeat(64),
    })).toEqual({
      recordingId: "recording_1",
      revisionId: "tr-000001-1",
      previewToken: "a".repeat(64),
    });
    expect(() => validateRendererCoreParams("transcription.applyProtectedTermReview", {
      recordingId: "recording_1",
      revisionId: "tr-000001-1",
      previewToken: "A".repeat(64),
    })).toThrow("64 lowercase hexadecimal characters");
    expect(() => validateRendererCoreParams("transcription.applyProtectedTermReview", {
      recordingId: "recording_1",
      revisionId: "tr-000001-1",
      previewToken: "a".repeat(64),
      transcript: "renderer-forged text",
    })).toThrow("field transcript is not allowed");
  });

  it("requires parameterless operations to remain parameterless", () => {
    expect(validateRendererCoreParams("core.status", null)).toBeNull();
    expect(() => validateRendererCoreParams("core.status", { verbose: true }))
      .toThrow("parameters are not accepted");
    expect(() => validateRendererCoreParams("core.ping", { transport: "generic" }))
      .toThrow("parameters are not accepted");
    expect(() => validateRendererCoreParams("liveTranscript.eventsDrain", { recordingId: "recording_1" }))
      .toThrow("parameters are not accepted");
  });

  it("allows live transcript lifecycle control but rejects renderer text ingress", () => {
    expect(validateRendererCoreParams("liveTranscript.enable", { recordingId: "recording_1" }))
      .toEqual({ recordingId: "recording_1" });
    expect(() => validateRendererCoreParams("liveTranscript.start", {
      recordingId: "recording_1",
      text: "forged provisional transcript",
    })).toThrow("field text is not allowed");
    expect(() => validateRendererCoreParams("liveTranscript.snapshot", { recordingId: "../vault" }))
      .toThrow("recordingId is invalid");
  });

  it("allows only opt-in preference and explicit anonymous speaker names", () => {
    expect(validateRendererCoreParams("diarization.updatePreference", { enabled: true }))
      .toEqual({ enabled: true });
    expect(validateRendererCoreParams("diarization.assignSpeakerName", {
      recordingId: "recording_1",
      anonymousSpeakerId: "speaker-2",
      displayName: "Avery",
    })).toEqual({
      recordingId: "recording_1",
      anonymousSpeakerId: "speaker-2",
      displayName: "Avery",
    });
    expect(() => validateRendererCoreParams("diarization.assignSpeakerName", {
      recordingId: "recording_1",
      anonymousSpeakerId: "Avery",
      displayName: "Inferred identity",
    })).toThrow("speaker-N format");
    expect(() => validateRendererCoreParams("diarization.assignSpeakerName", {
      recordingId: "recording_1",
      anonymousSpeakerId: "speaker-1",
      displayName: " Avery ",
    })).toThrow("without surrounding whitespace");
    expect(() => validateRendererCoreParams("diarization.updatePreference", {
      enabled: true,
      modelPath: "C:\\private\\model.bin",
    })).toThrow("field modelPath is not allowed");
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
      "media.importStatus": null,
      "consent.status": null,
      "consent.acknowledge": { items: ["localOnlyStorage"] },
      "capture.status": null,
      "capture.devices": null,
      "capture.preferences": null,
      "capture.setPreferredMicrophone": { deviceId: "default" },
      "capture.micTestStart": {},
      "capture.micTestStatus": null,
      "capture.micTestSample": null,
      "capture.micTestStop": null,
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
      "liveTranscript.enable": { recordingId },
      "liveTranscript.start": { recordingId },
      "liveTranscript.snapshot": { recordingId },
      "liveTranscript.clear": { recordingId },
      "liveTranscript.stop": { recordingId },
      "liveTranscript.eventsDrain": null,
      "diarization.status": null,
      "diarization.updatePreference": { enabled: false },
      "diarization.speakerNames": { recordingId },
      "diarization.assignSpeakerName": {
        recordingId,
        anonymousSpeakerId: "speaker-1",
        displayName: "Avery",
      },
      "diarization.removeSpeakerName": { recordingId, anonymousSpeakerId: "speaker-1" },
      "profiles.list": null,
      "profiles.get": { id: "general" },
      "profiles.upsert": {
        name: "Custom",
        captureSource: "combined",
        language: "auto",
        localModelTier: "balanced",
        dictionaryIds: [],
        replacementRuleSetId: null,
        recapTemplate: "Summarize decisions.",
        liveTranscription: true,
      },
      "profiles.delete": { id: "custom-profile", expectedVersion: 1 },
      "profiles.select": { id: "general" },
      "replacements.list": null,
      "replacements.get": { id: "none" },
      "replacements.upsert": { name: "Custom rules", rules: [] },
      "replacements.delete": { id: "custom-rules", expectedVersion: 1 },
      "replacements.preview": { setId: "none", input: "raw transcript" },
      "replacements.apply": {
        setId: "none",
        input: "raw transcript",
        previewToken: "a".repeat(64),
        approveProtectedTerms: false,
      },
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
      "recording.trustHistory": { recordingId },
      "recording.transcriptRevision": { recordingId, revisionId: "revision_1" },
      "recording.selectTranscriptRevision": { recordingId, revisionId: "revision_1" },
      "transcription.prepareReprocess": { recordingId, channel: "mic" },
      "transcription.protectedTermReview": { recordingId },
      "transcription.applyProtectedTermReview": {
        recordingId,
        revisionId: "revision_1",
        previewToken: "a".repeat(64),
      },
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
