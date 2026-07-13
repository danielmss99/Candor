import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopShell } from "../components/DesktopShell";
import { PrivacyReceipt } from "./privacy/PrivacyReceipt";
import { SettingsView } from "./settings/SettingsView";
import { LiveMeetingView } from "./meeting/LiveMeetingView";
import type { MeetingPrivacyReceipt, NetworkCapabilities } from "../core/contracts";

const network: NetworkCapabilities = {
  policy: "disabled-by-default",
  externalCallsAttempted: 0,
  capabilities: [
    { id: "recording", label: "Recording", mode: "denied", trigger: "never", owner: "core" },
  ],
};

const receipt: MeetingPrivacyReceipt = {
  proofKind: "meeting-privacy-receipt",
  receiptVersion: 1,
  generatedAtMs: 3,
  recording: { recordingId: "rec-1", label: "Meeting", state: "finished", createdAtMs: 1, updatedAtMs: 2, deletionStatus: "present" },
  capture: { channels: ["mic", "system"], audioChunkCount: 2, channelAttribution: true },
  storage: { rootKind: "local-user-data", encryptedAudioChunkCount: 2, allAudioEncrypted: true, cipher: "chacha20poly1305" },
  content: { transcriptSegmentCount: 4, notesSavedLocally: true },
  processing: [],
  exports: [],
  retention: { policy: "manual-delete-only", automaticDeletion: false },
  network,
};

describe("simplified product surface", () => {
  it("keeps the default sidebar focused on the primary workflow", () => {
    const markup = renderToStaticMarkup(
      <DesktopShell view="library" recordings={[]} openMeetingIds={[]} selectedRecordingId="" activeCapture={false} combinedCaptureAvailable={false} busy={false} notice="" error="" onHome={vi.fn()} onStartRecording={vi.fn()} onNavigate={vi.fn()} onOpenRecording={vi.fn()} onCloseMeeting={vi.fn()} onDismissNotice={vi.fn()} onDismissError={vi.fn()}><div>Content</div></DesktopShell>,
    );
    expect(markup).toContain("Home");
    expect(markup).toContain("Meetings");
    expect(markup).toContain("Settings");
    expect(markup).not.toContain("Current meeting");
    expect(markup).not.toContain("Exports");
    expect(markup).not.toContain("Custody proof");
    expect(markup).not.toContain("AI models");
  });

  it("limits visible meeting tabs to three and exposes overflow", () => {
    const recordings = Array.from({ length: 5 }, (_, index) => ({
      recordingId: `rec-${index}`,
      label: `Meeting ${index}`,
      state: "finished",
      audioDurationMs: 1,
      audioChunkCount: 1,
      transcriptSegmentCount: 0,
      updatedAtMs: index,
    }));
    const markup = renderToStaticMarkup(
      <DesktopShell view="meeting" recordings={recordings} openMeetingIds={["rec-0", "rec-1", "rec-2"]} selectedRecordingId="rec-0" activeCapture={false} combinedCaptureAvailable={false} busy={false} notice="" error="" onHome={vi.fn()} onStartRecording={vi.fn()} onNavigate={vi.fn()} onOpenRecording={vi.fn()} onCloseMeeting={vi.fn()} onDismissNotice={vi.fn()} onDismissError={vi.fn()}><div /></DesktopShell>,
    );
    expect((markup.match(/class="session-tab"/g) ?? []).length).toBe(3);
    expect(markup).toContain("+2");
  });

  it("renders a pathless, core-backed privacy receipt", () => {
    const markup = renderToStaticMarkup(<PrivacyReceipt receipt={receipt} network={network} />);
    expect(markup).toContain("Private on this computer");
    expect(markup).toContain("No external calls");
    expect(markup).toContain("Encrypted");
    expect(markup).not.toMatch(/[A-Z]:\\|\/Users\//);
  });

  it("hides technical settings until Advanced is expanded", () => {
    const baseProps = {
      section: "general" as const,
      busy: "",
      activeCapture: false,
      combinedCaptureAvailable: false,
      statuses: { core: {}, consent: {}, capture: {}, vault: {}, updates: {}, retention: {}, transcription: {} },
      models: [],
      selectedModel: "tiny.en",
      defaultModel: "tiny.en",
      aiMode: "fast" as const,
      aiModeStatus: "Fast local",
      instructSetupOpen: false,
      instructAssetsReady: false,
      instructRunnerAsset: {},
      instructModelAsset: {},
      instructAssetKind: "runner" as const,
      instructExpectedSha256: "",
      instructAssetError: "",
      licenseStatus: {},
      licensePortalInfo: {},
      licenseActive: true,
      privacyReceipt: receipt,
      networkCapabilities: network,
      custodyItems: [] as Array<[string, string]>,
      diagnosticPreview: null,
      onSectionChange: vi.fn(), onToggleAdvanced: vi.fn(), onVerifyModel: vi.fn(), onImportModel: vi.fn(), onSelectedModelChange: vi.fn(), onAiModeChange: vi.fn(), onInstructSetupOpenChange: vi.fn(), onInstructAssetKindChange: vi.fn(), onInstructExpectedShaChange: vi.fn(), onImportInstructAsset: vi.fn(), onRefreshLicense: vi.fn(), onDeactivateLicense: vi.fn(), onAcknowledgeMic: vi.fn(), onAcknowledgeSystem: vi.fn(), onRecordSystem: vi.fn(), onRecordBoth: vi.fn(), onOpenExport: vi.fn(), onRefreshLocalSettings: vi.fn(), onPrepareDiagnostics: vi.fn(), onSaveDiagnostics: vi.fn(),
    };
    const basicMarkup = renderToStaticMarkup(<SettingsView {...baseProps} advancedOpen={false} />);
    const advancedMarkup = renderToStaticMarkup(<SettingsView {...baseProps} advancedOpen />);
    expect(basicMarkup).not.toContain("Privacy and diagnostics");
    expect(advancedMarkup).toContain("Privacy and diagnostics");
    expect(advancedMarkup).toContain("Local AI");
    const privacyMarkup = renderToStaticMarkup(<SettingsView {...baseProps} section="privacy" advancedOpen diagnosticPreview={{ contentPolicy: "metadata-only-no-user-content" }} />);
    expect(privacyMarkup).toContain("Safe diagnostic report");
    expect(privacyMarkup).toContain("Inspect exact report");
  });

  it("provides compact Transcript, Notes, and AI panes without splitting the meeting workflow", () => {
    const markup = renderToStaticMarkup(
      <LiveMeetingView title="Meeting" selectedRecording={undefined} selectedRecordingId="rec-1" activeRecordingId="" activeCapture={false} consentReady durationMs={0} audioUrl="" markers={[]} compactPane="notes" notesPanelMode="notes" notesMarkdown="" notesDirty={false} notesSaved={false} recapSuggestions={[]} aiMode="fast" aiModeStatus="Fast local" captureStatusLabel="Ready" jobStatusLabel="Processing stays local" busy={false} transcriptContent={<div>Transcript content</div>} onReview={vi.fn()} onReviewConsent={vi.fn()} onLoadAudio={vi.fn()} onMarkMoment={vi.fn()} onCompactPaneChange={vi.fn()} onNotesPanelModeChange={vi.fn()} onTranscribe={vi.fn()} onNotesChange={vi.fn()} onSaveNotes={vi.fn()} onGenerateRecap={vi.fn()} onAiModeChange={vi.fn()} onStartStop={vi.fn()} />,
    );
    expect(markup).toContain("Meeting workspace panes");
    expect(markup).toContain("Transcript");
    expect(markup).toContain("Notes");
    expect(markup).toContain(">AI<");
    expect(markup).toContain("Review meeting");
  });
});
