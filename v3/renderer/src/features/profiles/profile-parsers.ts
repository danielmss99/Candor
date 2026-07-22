import type {
  MeetingProfile,
  ProfileCaptureSource,
  ProfileModelTier,
  ReplacementChange,
  ReplacementMatchMode,
  ReplacementPreview,
  ReplacementRule,
  ReplacementRuleSet,
  TransparentModel,
} from "./types";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : fallback;
}

function captureSource(value: unknown): ProfileCaptureSource {
  return value === "microphone" || value === "system-audio" || value === "combined" ? value : "combined";
}

function modelTier(value: unknown): ProfileModelTier {
  return value === "fast" || value === "maximum" || value === "balanced" ? value : "balanced";
}

function matchMode(value: unknown): ReplacementMatchMode {
  return value === "exact" ? "exact" : "whole-word";
}

export function parseMeetingProfile(value: unknown): MeetingProfile | null {
  const item = record(value);
  const id = text(item.id);
  const name = text(item.name);
  if (!id || !name) return null;
  return {
    schemaVersion: integer(item.schemaVersion, 1),
    version: integer(item.version, 1),
    id,
    name,
    captureSource: captureSource(item.captureSource),
    language: text(item.language, "auto"),
    localModelTier: modelTier(item.localModelTier),
    speechModelId: text(item.speechModelId, "large-v3-turbo"),
    cleanupModelId: typeof item.cleanupModelId === "string" ? item.cleanupModelId : null,
    summaryModelId: typeof item.summaryModelId === "string" ? item.summaryModelId : null,
    dictionaryIds: Array.isArray(item.dictionaryIds) ? item.dictionaryIds.filter((entry): entry is string => typeof entry === "string") : [],
    replacementRuleSetId: typeof item.replacementRuleSetId === "string" ? item.replacementRuleSetId : null,
    recapTemplate: text(item.recapTemplate),
    liveTranscription: bool(item.liveTranscription),
    builtIn: bool(item.builtIn),
  };
}

export function parseProfileList(value: unknown): MeetingProfile[] {
  const root = record(value);
  const source = Array.isArray(root.profiles) ? root.profiles : [];
  return source.map(parseMeetingProfile).filter((item): item is MeetingProfile => item !== null);
}

export function parseActiveProfileId(value: unknown): string | null {
  const activeProfileId = record(value).activeProfileId;
  return typeof activeProfileId === "string" && activeProfileId.length > 0
    ? activeProfileId
    : null;
}

function parseRule(value: unknown): ReplacementRule | null {
  const item = record(value);
  const id = text(item.id);
  const literal = text(item.literal);
  if (!id || !literal) return null;
  return {
    id,
    order: integer(item.order),
    matchMode: matchMode(item.matchMode),
    literal,
    replacement: text(item.replacement),
    protectedTermReview: bool(item.protectedTermReview),
    enabled: bool(item.enabled, true),
  };
}

export function parseRuleSet(value: unknown): ReplacementRuleSet | null {
  const item = record(value);
  const id = text(item.id);
  const name = text(item.name);
  if (!id || !name) return null;
  return {
    schemaVersion: integer(item.schemaVersion, 1),
    version: integer(item.version, 1),
    id,
    name,
    rules: (Array.isArray(item.rules) ? item.rules : []).map(parseRule).filter((rule): rule is ReplacementRule => rule !== null),
    builtIn: bool(item.builtIn),
  };
}

export function parseRuleSetList(value: unknown): ReplacementRuleSet[] {
  const root = record(value);
  const source = Array.isArray(root.ruleSets) ? root.ruleSets : [];
  return source.map(parseRuleSet).filter((item): item is ReplacementRuleSet => item !== null);
}

function parseChange(value: unknown): ReplacementChange | null {
  const item = record(value);
  const ruleId = text(item.ruleId);
  if (!ruleId) return null;
  return {
    ruleId,
    ruleOrder: integer(item.ruleOrder),
    replacementCount: integer(item.replacementCount),
    protectedTermReview: bool(item.protectedTermReview),
  };
}

export function parseReplacementPreview(value: unknown): ReplacementPreview | null {
  const root = record(value);
  const previewToken = text(root.previewToken);
  const previewText = text(root.previewText);
  if (previewToken.length !== 64 || !/^[a-f0-9]+$/.test(previewToken)) return null;
  return {
    applied: bool(root.applied),
    changed: bool(root.changed),
    previewText,
    previewToken,
    changes: (Array.isArray(root.changes) ? root.changes : []).map(parseChange).filter((change): change is ReplacementChange => change !== null),
    replacementCount: integer(root.replacementCount),
    protectedTermReviewRequired: bool(root.protectedTermReviewRequired),
  };
}

export function parseTransparentModels(value: unknown): TransparentModel[] {
  const root = record(value);
  const source = Array.isArray(value) ? value : Array.isArray(root.models) ? root.models : [];
  return source.flatMap((raw): TransparentModel[] => {
    const item = record(raw);
    const modelId = optionalText(item.modelId);
    if (!modelId) return [];
    const verified = typeof item.verified === "boolean" ? item.verified : null;
    const installed = typeof item.installed === "boolean" ? item.installed : null;
    const warmState = item.warmState === "loaded" || item.warmState === "cold"
      ? item.warmState
      : "unavailable";
    const warm = warmState === "loaded" && item.warm === true
      ? true
      : warmState === "cold" && item.warm === false
        ? false
        : null;
    const measuredLatency = finiteNumber(item.measuredLatencyMs);
    const latencyMeasurementState = item.latencyMeasurementState === "measured"
      && measuredLatency !== null
      && measuredLatency >= 0
      && item.latencyMeasurementBasis === "30-second-local-inference-benchmark"
      ? "measured"
      : "unmeasured";
    return [{
      modelId,
      language: optionalText(item.language),
      verification: verified === true ? "verified" : verified === false ? "unverified" : "unknown",
      availability: installed === true ? "installed" : installed === false ? "not-installed" : "unavailable",
      bytes: finiteNumber(item.bytes),
      hardware: optionalText(item.hardwareRequirement),
      warm,
      warmState,
      measuredLatencyMs: latencyMeasurementState === "measured" ? measuredLatency : null,
      latencyMeasurementState,
      latencyMeasurementBasis: latencyMeasurementState === "measured"
        ? "30-second-local-inference-benchmark"
        : null,
      failureCode: optionalText(item.failureCode),
    }];
  });
}
