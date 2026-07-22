export type ProfileCaptureSource = "microphone" | "system-audio" | "combined";
export type ProfileModelTier = "fast" | "balanced" | "maximum";

export interface MeetingProfile {
  schemaVersion: number;
  version: number;
  id: string;
  name: string;
  captureSource: ProfileCaptureSource;
  language: string;
  localModelTier: ProfileModelTier;
  speechModelId: string;
  cleanupModelId: string | null;
  summaryModelId: string | null;
  dictionaryIds: string[];
  replacementRuleSetId: string | null;
  recapTemplate: string;
  liveTranscription: boolean;
  builtIn: boolean;
}

export interface MeetingProfileDraft {
  id?: string;
  expectedVersion?: number;
  name: string;
  captureSource: ProfileCaptureSource;
  language: string;
  localModelTier: ProfileModelTier;
  speechModelId?: string;
  cleanupModelId?: string;
  summaryModelId?: string;
  dictionaryIds: string[];
  replacementRuleSetId: string | null;
  recapTemplate: string;
  liveTranscription: boolean;
}

export type ReplacementMatchMode = "exact" | "whole-word";

export interface ReplacementRule {
  id: string;
  order: number;
  matchMode: ReplacementMatchMode;
  literal: string;
  replacement: string;
  protectedTermReview: boolean;
  enabled: boolean;
}

export interface ReplacementRuleSet {
  schemaVersion: number;
  version: number;
  id: string;
  name: string;
  rules: ReplacementRule[];
  builtIn: boolean;
}

export interface ReplacementChange {
  ruleId: string;
  ruleOrder: number;
  replacementCount: number;
  protectedTermReview: boolean;
}

export interface ReplacementPreview {
  applied: boolean;
  changed: boolean;
  previewText: string;
  previewToken: string;
  changes: ReplacementChange[];
  replacementCount: number;
  protectedTermReviewRequired: boolean;
}

export type ModelAvailability = "installed" | "not-installed" | "unavailable";

export interface TransparentModel {
  modelId: string;
  language: string | null;
  verification: "verified" | "unverified" | "unknown";
  availability: ModelAvailability;
  bytes: number | null;
  hardware: string | null;
  warm: boolean | null;
  warmState: "loaded" | "cold" | "unavailable";
  measuredLatencyMs: number | null;
  latencyMeasurementState: "measured" | "unmeasured";
  latencyMeasurementBasis: "30-second-local-inference-benchmark" | null;
  failureCode: string | null;
}

export interface ProfileWorkspaceController {
  profiles: MeetingProfile[];
  ruleSets: ReplacementRuleSet[];
  models: TransparentModel[];
  selectedProfileId: string;
  loading: boolean;
  busy: boolean;
  notice: string;
  error: string;
  selectProfile(id: string): void;
  saveProfile(draft: MeetingProfileDraft): Promise<void>;
  deleteProfile(profile: MeetingProfile): Promise<void>;
  saveRuleSet(input: { id?: string; expectedVersion?: number; name: string; rules: ReplacementRule[] }): Promise<void>;
  deleteRuleSet(ruleSet: ReplacementRuleSet): Promise<void>;
  previewReplacements(setId: string, input: string): Promise<ReplacementPreview | null>;
  applyReplacements(setId: string, input: string, preview: ReplacementPreview, approveProtectedTerms: boolean): Promise<ReplacementPreview | null>;
  refreshProfiles(): Promise<void>;
}
