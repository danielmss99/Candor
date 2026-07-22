import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocalModelLibrary } from "./LocalModelLibrary";
import type { LocalModelCatalogEntry } from "./model-library";

function model(overrides: Partial<LocalModelCatalogEntry>): LocalModelCatalogEntry {
  return {
    modelId: "small.en",
    displayName: "Whisper Small English",
    capability: "speech",
    engine: "whisper.cpp",
    publisher: "OpenAI",
    distributionSource: "ggerganov/whisper.cpp",
    revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
    expectedSha256: "a".repeat(64),
    bytes: 487_614_201,
    licenseExpression: "MIT",
    languages: ["English"],
    hardware: "Local CPU",
    releaseState: "ready",
    releaseNote: "Verified English speech model",
    defaultEligible: false,
    downloadAvailable: true,
    installed: false,
    verified: false,
    ...overrides,
  };
}

describe("LocalModelLibrary", () => {
  it("shows the local handoff roles and makes Parakeet downloadable", () => {
    const markup = renderToStaticMarkup(
      <LocalModelLibrary
        catalog={{
          loaded: true,
          activeDownloadModelId: null,
          recommendedDefaultModelId: null,
          models: [
            model({}),
            model({
              modelId: "qwen3-4b-official-q4_k_m",
              displayName: "Qwen3 4B",
              capability: "text-processing",
              engine: "llama.cpp",
              releaseState: "manual-only",
              downloadAvailable: false,
              releaseNote: "Cleanup and summary model",
            }),
            model({
              modelId: "parakeet-tdt-0.6b-v3-int8",
              displayName: "NVIDIA Parakeet V3",
              engine: "sherpa-onnx",
              publisher: "NVIDIA",
              releaseState: "ready",
              expectedSha256: "b".repeat(64),
              bytes: 487_170_055,
              defaultEligible: true,
              downloadAvailable: true,
              releaseNote: "Offline final transcription",
            }),
          ],
        }}
        progress={null}
        activeCapture={false}
        busy={false}
        selectedModelId="small.en"
        onDownload={vi.fn()}
        onCancel={vi.fn()}
        onImportSpeechModel={vi.fn()}
        onSelectSpeechModel={vi.fn()}
        onOpenManualSetup={vi.fn()}
      />,
    );

    expect(markup).toContain("Speech to text");
    expect(markup).toContain("Transcript cleanup and summaries");
    expect(markup).toContain("NVIDIA Parakeet V3");
    expect(markup).toContain("NVIDIA Parakeet TDT 0.6B V3 by NVIDIA");
    expect(markup).toMatch(/<button[^>]*>Download<\/button>/);
    expect(markup).not.toContain("https://");
  });

  it("disables new downloads during recording", () => {
    const markup = renderToStaticMarkup(
      <LocalModelLibrary
        catalog={{ loaded: true, activeDownloadModelId: null, recommendedDefaultModelId: null, models: [model({})] }}
        progress={null}
        activeCapture
        busy={false}
        selectedModelId="small.en"
        onDownload={vi.fn()}
        onCancel={vi.fn()}
        onImportSpeechModel={vi.fn()}
        onSelectSpeechModel={vi.fn()}
        onOpenManualSetup={vi.fn()}
      />,
    );
    expect(markup).toContain("Downloads are unavailable while a recording is active");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Download<\/button>/);
  });
});
