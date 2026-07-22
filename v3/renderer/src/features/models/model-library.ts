import { asArray, asBool, asNumber, asObject, asString, type LocalJsonValue } from "../../core/contracts";

export type LocalModelCapability = "speech" | "text-processing";
export type LocalModelReleaseState = "ready" | "manual-only" | "release-gated";

export interface LocalModelCatalogEntry {
  modelId: string;
  displayName: string;
  capability: LocalModelCapability;
  engine: string;
  publisher: string;
  distributionSource: string;
  revision: string;
  expectedSha256: string | null;
  bytes: number | null;
  licenseExpression: string;
  languages: string[];
  hardware: string;
  releaseState: LocalModelReleaseState;
  releaseNote: string;
  defaultEligible: boolean;
  downloadAvailable: boolean;
  installed: boolean;
  verified: boolean;
}

export interface LocalModelCatalogState {
  loaded: boolean;
  activeDownloadModelId: string | null;
  recommendedDefaultModelId: string | null;
  models: LocalModelCatalogEntry[];
}

export interface ModelDownloadProgress {
  modelId: string;
  state: "downloading" | "verifying" | "verification-queued" | "canceled" | "failed";
  bytesReceived: number;
  totalBytes: number;
}

export const EMPTY_MODEL_CATALOG: LocalModelCatalogState = {
  loaded: false,
  activeDownloadModelId: null,
  recommendedDefaultModelId: null,
  models: [],
};

function nullableString(value: LocalJsonValue): string | null {
  return typeof value === "string" && value ? value : null;
}

function nullableBytes(value: LocalJsonValue): number | null {
  const parsed = asNumber(value, -1);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseLocalModelCatalog(value: LocalJsonValue): LocalModelCatalogState {
  const root = asObject(value);
  const models = asArray(root.models).flatMap((candidate) => {
    const item = asObject(candidate);
    const modelId = asString(item.modelId);
    const capability = item.capability === "text-processing" ? "text-processing" : item.capability === "speech" ? "speech" : null;
    const releaseState = item.releaseState === "ready" || item.releaseState === "manual-only" || item.releaseState === "release-gated"
      ? item.releaseState
      : null;
    if (!modelId || !capability || !releaseState || item.urlExposed !== false || item.rawPathExposed !== false) return [];
    return [{
      modelId,
      displayName: asString(item.displayName, modelId),
      capability,
      engine: asString(item.engine, "Local runtime"),
      publisher: asString(item.publisher, "Unknown publisher"),
      distributionSource: asString(item.distributionSource, "Packaged catalog"),
      revision: asString(item.revision, "Unknown revision"),
      expectedSha256: nullableString(item.expectedSha256),
      bytes: nullableBytes(item.bytes),
      licenseExpression: asString(item.licenseExpression, "Review required"),
      languages: asArray(item.languages).map((language) => asString(language)).filter(Boolean),
      hardware: asString(item.hardware, "Local device check required"),
      releaseState,
      releaseNote: asString(item.releaseNote),
      defaultEligible: asBool(item.defaultEligible),
      downloadAvailable: asBool(item.downloadAvailable),
      installed: asBool(item.installed),
      verified: asBool(item.verified),
    } satisfies LocalModelCatalogEntry];
  });
  return {
    loaded: true,
    activeDownloadModelId: nullableString(root.activeDownloadModelId),
    recommendedDefaultModelId: nullableString(root.recommendedDefaultModelId),
    models,
  };
}

export function parseModelDownloadProgress(value: LocalJsonValue): ModelDownloadProgress | null {
  const item = asObject(value);
  const state = item.state;
  if (
    typeof item.modelId !== "string"
    || !["downloading", "verifying", "verification-queued", "canceled", "failed"].includes(asString(state))
    || item.rawPathExposed !== false
  ) return null;
  return {
    modelId: item.modelId,
    state: state as ModelDownloadProgress["state"],
    bytesReceived: Math.max(0, asNumber(item.bytesReceived)),
    totalBytes: Math.max(0, asNumber(item.totalBytes)),
  };
}
