import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MeetingProfileManager, ProfileModelTierSelector } from "./MeetingProfileManager";
import { ModelTransparencyCards } from "./ModelTransparencyCards";
import { parseProfileList, parseReplacementPreview, parseRuleSetList, parseTransparentModels } from "./profile-parsers";
import { ReplacementRulesManager } from "./ReplacementRulesManager";
import { ReplacementPreviewResult } from "./ReplacementPreviewResult";
import type { ProfileWorkspaceController } from "./types";

const token = "a".repeat(64);

function controller(overrides: Partial<ProfileWorkspaceController> = {}): ProfileWorkspaceController {
  return {
    profiles: [{
      schemaVersion: 1,
      version: 1,
      id: "general",
      name: "General",
      captureSource: "combined",
      language: "auto",
      localModelTier: "balanced",
      speechModelId: "large-v3-turbo",
      cleanupModelId: "qwen3-4b-official-q4_k_m",
      summaryModelId: "qwen3-4b-official-q4_k_m",
      dictionaryIds: [],
      replacementRuleSetId: "protected-terms",
      recapTemplate: "Summarize decisions and action items.",
      liveTranscription: true,
      builtIn: true,
    }],
    ruleSets: [{ schemaVersion: 1, version: 1, id: "none", name: "No replacements", rules: [], builtIn: true }],
    models: [],
    selectedProfileId: "general",
    loading: false,
    busy: false,
    notice: "",
    error: "",
    selectProfile: vi.fn(),
    saveProfile: vi.fn().mockResolvedValue(undefined),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
    saveRuleSet: vi.fn().mockResolvedValue(undefined),
    deleteRuleSet: vi.fn().mockResolvedValue(undefined),
    previewReplacements: vi.fn().mockResolvedValue(null),
    applyReplacements: vi.fn().mockResolvedValue(null),
    refreshProfiles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("profile response parsing", () => {
  it("accepts bounded meeting profiles and replacement rules", () => {
    const profiles = parseProfileList({ profiles: [{ id: "standup", name: "Standup", version: 2, captureSource: "microphone", localModelTier: "fast", builtIn: true }] });
    expect(profiles[0]).toMatchObject({ id: "standup", language: "auto", captureSource: "microphone", localModelTier: "fast" });

    const sets = parseRuleSetList({ ruleSets: [{ id: "names", name: "Names", version: 1, rules: [{ id: "acme", order: 0, matchMode: "whole-word", literal: "acmi", replacement: "Acme", enabled: true }] }] });
    expect(sets[0]?.rules[0]).toMatchObject({ id: "acme", literal: "acmi", replacement: "Acme" });
  });

  it("requires a valid preview token before exposing apply data", () => {
    expect(parseReplacementPreview({ previewToken: "short", previewText: "text" })).toBeNull();
    expect(parseReplacementPreview({ previewToken: token, previewText: "Acme", replacementCount: 1, protectedTermReviewRequired: true })).toMatchObject({ previewToken: token, replacementCount: 1, protectedTermReviewRequired: true });
  });

  it("uses honest unavailable states for missing model telemetry", () => {
    const models = parseTransparentModels({ models: [{ modelId: "whisper-local", installed: true, verified: true, bytes: 1_000_000 }] });
    expect(models[0]).toMatchObject({
      verification: "verified",
      availability: "installed",
      hardware: null,
      warm: null,
      warmState: "unavailable",
      measuredLatencyMs: null,
      latencyMeasurementState: "unmeasured",
      latencyMeasurementBasis: null,
    });
  });

  it("accepts only core-owned warm and benchmark evidence fields", () => {
    const [measured] = parseTransparentModels({
      models: [{
        modelId: "large-v3-turbo",
        language: "multilingual",
        installed: true,
        verified: true,
        bytes: 1_000_000,
        hardwareRequirement: "At least 8 GB system memory and a passing local performance check",
        warm: true,
        warmState: "loaded",
        measuredLatencyMs: 7_500,
        latencyMeasurementState: "measured",
        latencyMeasurementBasis: "30-second-local-inference-benchmark",
      }],
    });
    expect(measured).toMatchObject({
      hardware: "At least 8 GB system memory and a passing local performance check",
      warm: true,
      warmState: "loaded",
      measuredLatencyMs: 7_500,
      latencyMeasurementState: "measured",
    });

    const [aliases] = parseTransparentModels({
      models: [{
        modelId: "small.en",
        installed: true,
        verified: true,
        warmed: true,
        lastLatencyMs: 1,
        recommendedHardware: "guessed",
      }],
    });
    expect(aliases).toMatchObject({ hardware: null, warm: null, measuredLatencyMs: null });
  });
});

describe("profile settings components", () => {
  it("presents keyboard-native profile selection and immutable built-in copy flow", () => {
    const markup = renderToStaticMarkup(<MeetingProfileManager controller={controller()} />);
    expect(markup).toContain('type="radio"');
    expect(markup).toContain("Duplicate and customize");
    expect(markup).toContain("Microphone and system audio");
    expect(markup).toContain("Live transcript</dt><dd>Needs its verified local model");
    expect(markup).not.toContain("Delete profile");

    const readyMarkup = renderToStaticMarkup(
      <MeetingProfileManager
        controller={controller()}
        liveTranscriptRuntimeAvailable
        verifiedLiveModelIds={["large-v3-turbo"]}
      />,
    );
    expect(readyMarkup).toContain("Live transcript</dt><dd>On, local and provisional");
  });

  it("uses a compact keyboard-native model tier selector in the profile editor", () => {
    const markup = renderToStaticMarkup(<ProfileModelTierSelector value="balanced" onChange={vi.fn()} />);
    expect(markup).toContain('<fieldset class="profile-tier-picker">');
    expect(markup).toContain('type="radio"');
    expect(markup).toMatch(/<input[^>]+checked=""[^>]+value="balanced"/);
    expect(markup).toContain("Recommended");
    expect(markup).not.toContain("<select");
  });

  it("shows protected-term review before replacements can be applied", () => {
    const markup = renderToStaticMarkup(<ReplacementRulesManager controller={controller()} />);
    expect(markup).toContain("Preview replacements");
    expect(markup).toContain("These rules never become speech-recognition vocabulary hints.");
    expect(markup).not.toContain("Approve protected-term changes");

    const previewMarkup = renderToStaticMarkup(<ReplacementPreviewResult preview={{ applied: false, changed: true, previewText: "Acme", previewToken: token, changes: [{ ruleId: "company-name", ruleOrder: 0, replacementCount: 1, protectedTermReview: true }], replacementCount: 1, protectedTermReviewRequired: true }} protectedApproved={false} busy={false} onProtectedApprovedChange={vi.fn()} onApply={vi.fn()} />);
    expect(previewMarkup).toContain("Approve protected-term changes");
    expect(previewMarkup).toContain("disabled");
    expect(previewMarkup).toContain("company-name: 1 change, protected review");
  });

  it("labels missing model evidence instead of guessing", () => {
    const markup = renderToStaticMarkup(<ModelTransparencyCards models={[{
      modelId: "tiny",
      language: null,
      verification: "unknown",
      availability: "unavailable",
      bytes: null,
      hardware: null,
      warm: null,
      warmState: "unavailable",
      measuredLatencyMs: null,
      latencyMeasurementState: "unmeasured",
      latencyMeasurementBasis: null,
      failureCode: null,
    }]} />);
    expect(markup).toContain("Verification unavailable");
    expect(markup).toContain("Language support unavailable");
    expect(markup).toContain("Requirement unavailable");
    expect(markup).toContain("Signal unavailable");
    expect(markup).toContain("Not measured");
  });

  it("labels a real local benchmark without implying interactive latency", () => {
    const markup = renderToStaticMarkup(<ModelTransparencyCards models={[{
      modelId: "large-v3-turbo",
      language: "multilingual",
      verification: "verified",
      availability: "installed",
      bytes: 1_000_000,
      hardware: "At least 8 GB system memory and a passing local performance check",
      warm: false,
      warmState: "cold",
      measuredLatencyMs: 7_500,
      latencyMeasurementState: "measured",
      latencyMeasurementBasis: "30-second-local-inference-benchmark",
      failureCode: null,
    }]} />);
    expect(markup).toContain("Cold, loaded on demand");
    expect(markup).toContain("30 s local inference: 7,500 ms");
  });
});
