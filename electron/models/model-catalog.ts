export type ModelCapability = "speech" | "text-processing";
export type ModelReleaseState = "ready" | "manual-only" | "release-gated";

export interface TrustedModelDownload {
  url: string;
  allowedHosts: readonly string[];
}

export interface TrustedModelCatalogEntry {
  modelId: string;
  displayName: string;
  capability: ModelCapability;
  engine: string;
  publisher: string;
  distributionSource: string;
  revision: string;
  expectedSha256: string | null;
  bytes: number | null;
  licenseExpression: string;
  languages: readonly string[];
  hardware: string;
  releaseState: ModelReleaseState;
  releaseNote: string;
  defaultEligible: boolean;
  download?: TrustedModelDownload;
}

const HF_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const HF_REDIRECT_HOSTS = Object.freeze([
  "huggingface.co",
  "cdn-lfs.hf.co",
  "cdn-lfs-us-1.hf.co",
  "cdn-lfs-eu-1.hf.co",
  "cas-bridge.xethub.hf.co",
]);

function whisperDownload(fileName: string): TrustedModelDownload {
  return Object.freeze({
    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${HF_REVISION}/${fileName}?download=true`,
    allowedHosts: HF_REDIRECT_HOSTS,
  });
}

export const TRUSTED_MODEL_CATALOG: readonly TrustedModelCatalogEntry[] = Object.freeze([
  Object.freeze({
    modelId: "small.en",
    displayName: "Whisper Small English",
    capability: "speech",
    engine: "whisper.cpp",
    publisher: "OpenAI",
    distributionSource: "ggerganov/whisper.cpp",
    revision: HF_REVISION,
    expectedSha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    bytes: 487_614_201,
    licenseExpression: "MIT",
    languages: Object.freeze(["English"]),
    hardware: "Local CPU",
    releaseState: "ready",
    releaseNote: "Verified English speech model",
    defaultEligible: false,
    download: whisperDownload("ggml-small.en.bin"),
  }),
  Object.freeze({
    modelId: "small",
    displayName: "Whisper Small Multilingual",
    capability: "speech",
    engine: "whisper.cpp",
    publisher: "OpenAI",
    distributionSource: "ggerganov/whisper.cpp",
    revision: HF_REVISION,
    expectedSha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    bytes: 487_601_967,
    licenseExpression: "MIT",
    languages: Object.freeze(["Multilingual"]),
    hardware: "Local CPU",
    releaseState: "ready",
    releaseNote: "Verified multilingual speech model",
    defaultEligible: false,
    download: whisperDownload("ggml-small.bin"),
  }),
  Object.freeze({
    modelId: "large-v3-turbo",
    displayName: "Whisper Large V3 Turbo",
    capability: "speech",
    engine: "whisper.cpp",
    publisher: "OpenAI",
    distributionSource: "ggerganov/whisper.cpp",
    revision: HF_REVISION,
    expectedSha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    bytes: 1_624_555_275,
    licenseExpression: "MIT",
    languages: Object.freeze(["Multilingual"]),
    hardware: "At least 8 GB memory and a passing local benchmark",
    releaseState: "ready",
    releaseNote: "Balanced final transcription",
    defaultEligible: false,
    download: whisperDownload("ggml-large-v3-turbo.bin"),
  }),
  Object.freeze({
    modelId: "large-v3",
    displayName: "Whisper Large V3",
    capability: "speech",
    engine: "whisper.cpp",
    publisher: "OpenAI",
    distributionSource: "ggerganov/whisper.cpp",
    revision: HF_REVISION,
    expectedSha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
    bytes: 3_095_033_483,
    licenseExpression: "MIT",
    languages: Object.freeze(["Multilingual"]),
    hardware: "At least 16 GB memory and a passing local benchmark",
    releaseState: "ready",
    releaseNote: "Maximum-accuracy final transcription",
    defaultEligible: false,
    download: whisperDownload("ggml-large-v3.bin"),
  }),
  Object.freeze({
    modelId: "qwen3-4b-official-q4_k_m",
    displayName: "Qwen3 4B",
    capability: "text-processing",
    engine: "llama.cpp",
    publisher: "Qwen",
    distributionSource: "Qwen/Qwen3-4B-GGUF",
    revision: "bc640142c66e1fdd12af0bd68f40445458f3869b",
    expectedSha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
    bytes: 2_497_280_256,
    licenseExpression: "Apache-2.0",
    languages: Object.freeze(["Multilingual text"]),
    hardware: "Recommended 16 GB system memory",
    releaseState: "manual-only",
    releaseNote: "Cleanup and summary model; verified download transport is pending",
    defaultEligible: true,
  }),
  Object.freeze({
    modelId: "parakeet-tdt-0.6b-v3-int8",
    displayName: "NVIDIA Parakeet V3",
    capability: "speech",
    engine: "sherpa-onnx",
    publisher: "NVIDIA",
    distributionSource: "k2-fsa/sherpa-onnx conversion",
    revision: "876ff91b4ab4b89c328afdb2b27ff879d3e42f87+sherpa-onnx-1.13.4",
    expectedSha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
    bytes: 487_170_055,
    licenseExpression: "CC-BY-4.0 AND Apache-2.0 AND MIT",
    languages: Object.freeze(["25 European languages"]),
    hardware: "Windows x64 CPU; recommended 8 GB system memory",
    releaseState: "ready",
    releaseNote: "Offline final transcription with punctuation and capitalization",
    defaultEligible: true,
    download: Object.freeze({
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
      allowedHosts: Object.freeze([
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
      ]),
    }),
  }),
]);

export function trustedModel(modelId: string): TrustedModelCatalogEntry | undefined {
  return TRUSTED_MODEL_CATALOG.find((entry) => entry.modelId === modelId);
}

export function publicModelEntry(entry: TrustedModelCatalogEntry) {
  return {
    modelId: entry.modelId,
    displayName: entry.displayName,
    capability: entry.capability,
    engine: entry.engine,
    publisher: entry.publisher,
    distributionSource: entry.distributionSource,
    revision: entry.revision,
    expectedSha256: entry.expectedSha256,
    bytes: entry.bytes,
    licenseExpression: entry.licenseExpression,
    languages: [...entry.languages],
    hardware: entry.hardware,
    releaseState: entry.releaseState,
    releaseNote: entry.releaseNote,
    defaultEligible: entry.defaultEligible,
    downloadAvailable: entry.releaseState === "ready" && Boolean(entry.download),
    urlExposed: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}
