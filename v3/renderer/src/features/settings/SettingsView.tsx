import { PrivacyReceipt } from "../privacy/PrivacyReceipt";
import { TerminologySettings } from "../terminology/TerminologySettings";
import { asArray, asBool, asNumber, asObject, asString, formatBytes, metric, type AiMode, type BundledAiStatus, type InstructAssetKind, type JsonObject, type MeetingPrivacyReceipt, type ModelRow, type NetworkCapabilities, type SettingsSection, type TerminologyCorrectionProposal, type TerminologyStatus, type TranscriptionLanguagePreference, type TranscriptionQualityStatus, type TranscriptionQualityTier } from "../../core/contracts";

interface SettingsStatuses {
  core: JsonObject;
  consent: JsonObject;
  capture: JsonObject;
  vault: JsonObject;
  updates: JsonObject;
  retention: JsonObject;
  transcription: JsonObject;
}

interface SettingsViewProps {
  section: SettingsSection;
  advancedOpen: boolean;
  busy: string;
  activeCapture: boolean;
  combinedCaptureAvailable: boolean;
  statuses: SettingsStatuses;
  bundledAiStatus: BundledAiStatus;
  transcriptionQuality: TranscriptionQualityStatus;
  transcriptionBenchmarkActive: boolean;
  transcriptionBenchmarkNeedsRetry: boolean;
  terminologyStatus: TerminologyStatus;
  terminologyProposals: TerminologyCorrectionProposal[];
  selectedRecordingId: string;
  models: ModelRow[];
  selectedModel: string;
  defaultModel: string;
  aiMode: AiMode;
  aiModeStatus: string;
  aiFallbackPreference: "ask-first" | "automatic" | "never";
  instructSetupOpen: boolean;
  instructReady: boolean;
  instructRunnerAsset: JsonObject;
  instructModelAsset: JsonObject;
  instructAssetKind: InstructAssetKind;
  instructExpectedSha256: string;
  instructAssetError: string;
  licenseStatus: JsonObject;
  licensePortalInfo: JsonObject;
  licenseActive: boolean;
  privacyReceipt: MeetingPrivacyReceipt | null;
  networkCapabilities: NetworkCapabilities;
  custodyItems: Array<[string, string]>;
  diagnosticPreview: JsonObject | null;
  onSectionChange: (section: SettingsSection) => void;
  onToggleAdvanced: () => void;
  onVerifyModel: () => void;
  onImportModel: () => void;
  onSelectedModelChange: (modelId: string) => void;
  onAiModeChange: (mode: AiMode) => void;
  onAiFallbackPreferenceChange: (preference: "ask-first" | "automatic" | "never") => void;
  onTranscriptionQualityChange: (tier: TranscriptionQualityTier, languagePreference?: TranscriptionLanguagePreference) => void;
  onRunTranscriptionBenchmark: (tier: "balanced" | "maximum") => void;
  onImportDictionary: () => void;
  onSetDictionaryEnabled: (dictionaryId: string, enabled: boolean) => void;
  onAssignDictionary: (dictionaryId: string, enabled: boolean) => void;
  onReviewTerminology: () => void;
  onDecideTerminology: (proposalId: string, decision: "accepted" | "rejected") => void;
  onInstructSetupOpenChange: (open: boolean) => void;
  onInstructAssetKindChange: (kind: InstructAssetKind) => void;
  onInstructExpectedShaChange: (value: string) => void;
  onImportInstructAsset: () => void;
  onRefreshLicense: () => void;
  onDeactivateLicense: () => void;
  onAcknowledgeMic: () => void;
  onAcknowledgeSystem: () => void;
  onRecordSystem: () => void;
  onRecordBoth: () => void;
  onOpenExport: () => void;
  onRefreshLocalSettings: () => void;
  onPrepareDiagnostics: () => void;
  onSaveDiagnostics: () => void;
}

export function SettingsView(props: SettingsViewProps) {
  const renderLocalAi = () => {
    const availableModels = props.models.length ? props.models : [{ modelId: props.defaultModel, language: "english", installed: false, verified: false, bytes: 0, failureCode: "" }];
    const repairRequired = props.bundledAiStatus.repairRequired;
    const speechReady = props.bundledAiStatus.speech.ready || availableModels.some((model) => model.verified);
    const languageReady = props.instructReady;
    const checking = props.bundledAiStatus.state === "checking";
    const statusUnavailable = props.bundledAiStatus.state === "unavailable";
    const transcriptionLabel = checking && !speechReady ? "Checking..." : speechReady ? "Ready on this device" : "Not set up";
    const summaryLabel = checking && !languageReady ? "Checking..." : languageReady ? "Ready on this device" : "Local fallback available";
    const benchmarkLabel = props.transcriptionBenchmarkActive
      ? "Checking this computer..."
      : props.transcriptionBenchmarkNeedsRetry
          ? "Performance check needs retry"
        : props.transcriptionQuality.benchmarkState === "measured"
          ? "Measured locally"
          : "Performance check pending";
    const completionEstimate = props.transcriptionQuality.estimatedCompletionAvailable
      && props.transcriptionQuality.estimatedMinutesPerHour !== null
      ? `About ${props.transcriptionQuality.estimatedMinutesPerHour} minutes for a 1-hour meeting`
      : null;
    const maximumTier = props.transcriptionQuality.tiers.find((tier) => tier.id === "maximum");
    const maximumCheckAvailable = props.transcriptionQuality.benchmarkState === "measured"
      && Boolean(maximumTier?.guardReason?.includes("benchmark"));
    const manualBenchmarkTier = props.transcriptionBenchmarkNeedsRetry
      ? props.transcriptionQuality.benchmarkFailureTier ?? "balanced"
      : maximumCheckAvailable
        ? "maximum"
        : null;
    return (
      <div className="settings-panel-content">
        <header><h2>Local AI</h2><p>Offline transcription and meeting assistance on this computer</p></header>
        {checking ? (
          <section className="settings-group local-ai-checking" role="status" aria-live="polite">
            <h3>Checking included AI tools</h3>
            <p>Candor is verifying the local package on this device.</p>
          </section>
        ) : statusUnavailable ? (
          <section className="settings-group local-ai-unavailable" role="alert">
            <h3>Included AI status is unavailable</h3>
            <p>Recording and existing meetings remain available. Manual local setup stays in Advanced model override.</p>
          </section>
        ) : repairRequired ? (
          <section className="settings-group local-ai-repair" role="alert">
            <h3>Included AI tools need app repair</h3>
            <p>Candor can still open, export, and delete your meetings. Reinstall the signed Candor app to restore the included AI tools.</p>
          </section>
        ) : null}
        <section className="settings-group">
          <h3>Readiness</h3>
          <dl className="settings-facts">
            <div><dt>Transcription</dt><dd>{transcriptionLabel}</dd></div>
            <div><dt>Meeting summaries</dt><dd>{summaryLabel}</dd></div>
            <div><dt>Required downloads</dt><dd>None</dd></div>
          </dl>
        </section>
        <section className="settings-group" aria-labelledby="transcription-quality-heading">
          <div className="settings-group-heading">
            <div>
              <h3 id="transcription-quality-heading">Transcription quality</h3>
              <p>Saved for future meetings. Candor never interrupts recording with a model choice.</p>
            </div>
            <span className="settings-status-label">
              {benchmarkLabel}
            </span>
          </div>
          <div className="quality-choice-list" role="radiogroup" aria-label="Transcription quality">
            {props.transcriptionQuality.tiers.map((tier) => {
              const selected = props.transcriptionQuality.tier === tier.id;
              const description = tier.id === "fast"
                ? "Lowest resource use"
                : tier.id === "balanced"
                  ? "Best mix of speed and accuracy"
                  : "Highest quality, with a longer processing time";
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={!tier.available}
                  className={selected ? "quality-choice selected" : "quality-choice"}
                  disabled={Boolean(props.busy) || !tier.available}
                  key={tier.id}
                  onClick={() => props.onTranscriptionQualityChange(tier.id)}
                >
                  <span className="quality-choice-radio" aria-hidden="true" />
                  <span>
                    <strong>{tier.label}{tier.recommended ? " · Recommended" : ""}</strong>
                    <small>{tier.available ? description : qualityGuardCopy(tier.guardReason)}</small>
                  </span>
                </button>
              );
            })}
          </div>
          {completionEstimate ? (
            <p className="transcription-time-estimate" role="status">{completionEstimate}</p>
          ) : null}
          <div className="settings-row-title language-preference-row">
            <div>
              <strong>Meeting language</strong>
              <span>Choose multilingual when meetings may use languages other than English.</span>
            </div>
            <div className="segmented-control" role="group" aria-label="Meeting language">
              <button type="button" aria-pressed={props.transcriptionQuality.languagePreference === "english"} disabled={Boolean(props.busy)} onClick={() => props.onTranscriptionQualityChange(props.transcriptionQuality.tier, "english")}>English</button>
              <button type="button" aria-pressed={props.transcriptionQuality.languagePreference === "multilingual"} disabled={Boolean(props.busy)} onClick={() => props.onTranscriptionQualityChange(props.transcriptionQuality.tier, "multilingual")}>Multilingual</button>
            </div>
          </div>
          {manualBenchmarkTier && props.bundledAiStatus.ready ? (
            <div className="settings-actions benchmark-retry-action">
              <button
                type="button"
                onClick={() => props.onRunTranscriptionBenchmark(manualBenchmarkTier)}
                disabled={Boolean(props.busy) || props.activeCapture || props.transcriptionBenchmarkActive}
              >
                {props.transcriptionBenchmarkNeedsRetry
                  ? `Retry ${manualBenchmarkTier === "maximum" ? "maximum accuracy" : "performance"} check`
                  : "Check Maximum accuracy"}
              </button>
            </div>
          ) : null}
        </section>
        <TerminologySettings
          status={props.terminologyStatus}
          proposals={props.terminologyProposals}
          selectedRecordingId={props.selectedRecordingId}
          busy={Boolean(props.busy)}
          onImport={props.onImportDictionary}
          onSetEnabled={props.onSetDictionaryEnabled}
          onAssignToMeeting={props.onAssignDictionary}
          onReview={props.onReviewTerminology}
          onDecide={props.onDecideTerminology}
        />
        <section className="settings-group">
          <div className="settings-row-title">
            <div>
              <strong>When Local AI cannot finish</strong>
              <span>Choose whether Candor may create a simpler local result.</span>
            </div>
          </div>
          <div className="quality-choice-list" role="radiogroup" aria-label="Local AI fallback behavior">
            {([
              ["ask-first", "Ask first", "Offer a quick fallback only after Local AI fails"],
              ["automatic", "Automatic", "Create a disclosed quick fallback for approved failures"],
              ["never", "Never", "Keep the task failed until Local AI can be retried"],
            ] as const).map(([value, label, description]) => (
              <button
                type="button"
                role="radio"
                aria-checked={props.aiFallbackPreference === value}
                className={props.aiFallbackPreference === value ? "quality-choice selected" : "quality-choice"}
                disabled={Boolean(props.busy)}
                key={value}
                onClick={() => props.onAiFallbackPreferenceChange(value)}
              >
                <span className="quality-choice-radio" aria-hidden="true" />
                <span><strong>{label}{value === "ask-first" ? " · Recommended" : ""}</strong><small>{description}</small></span>
              </button>
            ))}
          </div>
        </section>
        <section className="settings-group">
          <div className="settings-row-title">
            <div><strong>Generation mode</strong><span id="local-ai-mode-status-settings">{props.aiModeStatus}</span></div>
            <div className="segmented-control" role="group" aria-label="Settings local AI mode">
              <button type="button" aria-pressed={props.aiMode === "local-llm"} onClick={() => props.onAiModeChange("local-llm")}>Local AI</button>
              <button type="button" aria-pressed={props.aiMode === "heuristic-fallback"} disabled={props.aiFallbackPreference === "never"} onClick={() => props.onAiModeChange("heuristic-fallback")}>Quick fallback</button>
            </div>
          </div>
        </section>
        {props.advancedOpen ? <details className="instruct-setup" open={props.instructSetupOpen} onToggle={(event) => props.onInstructSetupOpenChange(event.currentTarget.open)}>
          <summary><span><strong>Advanced model override</strong><em>{speechReady && languageReady ? "Optional" : "Manual setup"}</em></span></summary>
          <div className="instruct-setup-body">
            <div className="settings-row-title">
              <div><strong>Speech model</strong><span>Use a locally supplied model instead of the included default</span></div>
              <div className="settings-actions">
                <button type="button" onClick={props.onVerifyModel} disabled={Boolean(props.busy)}>Check integrity</button>
                <button type="button" onClick={props.onImportModel} disabled={Boolean(props.busy)}>Choose speech model</button>
              </div>
            </div>
            <div className="model-choice-list">
              {availableModels.slice(0, 6).map((model) => (
                <button type="button" key={model.modelId} aria-pressed={props.selectedModel === model.modelId} onClick={() => props.onSelectedModelChange(model.modelId)}>
                  <span><strong>Local speech model</strong><small>{model.modelId} / {model.language}</small></span>
                  <em>{model.verified ? "Ready" : model.installed ? "Needs integrity check" : "Not installed"}</em>
                </button>
              ))}
            </div>
            <dl className="asset-status-list" aria-label="Advanced local AI components">
              <div><dt>Processing component</dt><dd className={asBool(props.instructRunnerAsset.verified) ? "ok" : ""}>{asBool(props.instructRunnerAsset.verified) ? `Ready, ${formatBytes(asNumber(props.instructRunnerAsset.bytes))}` : "Not installed"}</dd></div>
              <div><dt>Language model</dt><dd className={asBool(props.instructModelAsset.verified) ? "ok" : ""}>{asBool(props.instructModelAsset.verified) ? `Ready, ${formatBytes(asNumber(props.instructModelAsset.bytes))}` : "Not installed"}</dd></div>
            </dl>
            <div className="segmented-control asset-kind-control" role="group" aria-label="Local AI component type">
              <button type="button" aria-pressed={props.instructAssetKind === "runner"} onClick={() => props.onInstructAssetKindChange("runner")}>Processing component</button>
              <button type="button" aria-pressed={props.instructAssetKind === "model"} onClick={() => props.onInstructAssetKindChange("model")}>Language model</button>
            </div>
            <label className="asset-hash-field" htmlFor="instruct-asset-sha256">
              <span>Integrity fingerprint</span>
              <input id="instruct-asset-sha256" value={props.instructExpectedSha256} onChange={(event) => props.onInstructExpectedShaChange(event.target.value)} aria-invalid={Boolean(props.instructAssetError)} aria-describedby="instruct-asset-sha256-status" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="64 hexadecimal characters" />
              <small id="instruct-asset-sha256-status" className={props.instructAssetError ? "asset-hash-error" : ""} role={props.instructAssetError ? "alert" : undefined}>{props.instructAssetError || "Fingerprint required before local copy"}</small>
            </label>
            <button type="button" className="secondary-button full-width" onClick={props.onImportInstructAsset} disabled={Boolean(props.busy)}>{props.busy === "instruct-asset" ? "Checking integrity..." : `Choose ${props.instructAssetKind === "runner" ? "processing component" : "language model"}`}</button>
          </div>
        </details> : null}
      </div>
    );
  };
  const renderLicense = () => {
    const portalActions = asArray(props.licensePortalInfo.actions).map((item) => asObject(item));
    return <div className="settings-panel-content"><header><h2>License</h2><p>Optional ownership tools. Sign-in is not required for normal app use.</p></header><section className="settings-group"><div className="settings-row-title"><div><strong>{metric(props.licenseStatus.planName, "Candor Professional")}</strong><span>{props.licenseActive ? "Activated or trialing locally" : "No local activation"}</span></div><div className="settings-actions"><button type="button" onClick={props.onRefreshLicense} disabled={Boolean(props.busy)}>Refresh</button><button type="button" onClick={props.onDeactivateLicense} disabled={Boolean(props.busy) || !props.licenseActive}>Deactivate device</button></div></div><dl className="settings-facts license-facts"><div><dt>Status</dt><dd>{metric(props.licenseStatus.state, "inactive")}</dd></div><div><dt>License ID</dt><dd>{metric(props.licenseStatus.licenseId, "Not activated")}</dd></div><div><dt>Device</dt><dd>{metric(props.licenseStatus.deviceLabel, "This device")}</dd></div><div><dt>Secure storage</dt><dd>{asBool(props.licenseStatus.secureStorageAvailable) ? "Available" : "Metadata only"}</dd></div><div><dt>Account required</dt><dd>No</dd></div><div><dt>Portal</dt><dd>{asBool(props.licensePortalInfo.available) ? "Available" : "Production pending"}</dd></div></dl></section><section className="settings-group"><h3>Portal actions</h3><div className="portal-action-list">{portalActions.map((action) => <article key={asString(action.id)}><span className={asBool(action.enabled) ? "status-dot ok" : "status-dot"} /><div><strong>{asString(action.label)}</strong><small>{asString(action.note)}</small></div></article>)}</div></section></div>;
  };
  const renderPanel = () => {
    if (props.section === "models") return renderLocalAi();
    if (props.section === "license") return renderLicense();
    if (props.section === "recording") return <div className="settings-panel-content"><header><h2>Recording</h2><p>Explicit local capture consent</p></header><section className="settings-group"><div className="consent-grid">{asArray(props.statuses.consent.items).map((item) => { const object = asObject(item); return <article key={asString(object.id)}><span className={asBool(object.acknowledged) ? "status-dot ok" : "status-dot"} /><div><strong>{asString(object.label)}</strong><small>{asBool(object.acknowledged) ? "Acknowledged locally" : "Required"}</small></div></article>; })}</div><div className="settings-actions"><button type="button" onClick={props.onAcknowledgeMic} disabled={Boolean(props.busy)}>Acknowledge microphone</button><button type="button" onClick={props.onAcknowledgeSystem} disabled={Boolean(props.busy)}>Acknowledge system audio</button></div></section><section className="settings-group"><h3>Capture sources</h3><dl className="settings-facts"><div><dt>Microphone</dt><dd>{asBool(asObject(asObject(props.statuses.capture.sources).microphone).implemented) ? "Available" : "Unavailable"}</dd></div><div><dt>System audio</dt><dd>{asBool(asObject(asObject(props.statuses.capture.sources).system).implemented) ? "Available" : "Unavailable"}</dd></div><div><dt>Combined</dt><dd>{props.combinedCaptureAvailable ? "Available" : "Unavailable"}</dd></div></dl><div className="settings-actions"><button type="button" onClick={props.onRecordSystem} disabled={Boolean(props.busy) || props.activeCapture}>Record system audio</button><button type="button" onClick={props.onRecordBoth} disabled={Boolean(props.busy) || props.activeCapture || !props.combinedCaptureAvailable}>Record both</button></div></section></div>;
    if (props.section === "privacy") return <div className="settings-panel-content" aria-label="Privacy and network"><header><h2>Privacy and network</h2><p>Measured local-custody and optional connection facts</p></header><PrivacyReceipt receipt={props.privacyReceipt} network={props.networkCapabilities} /><dl className="settings-facts privacy-facts">{props.custodyItems.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>;
    if (props.section === "storage") return <div className="settings-panel-content"><header><h2>Storage and retention</h2><p>How Candor protects and keeps meeting data on this device</p></header><dl className="settings-facts"><div><dt>Protection</dt><dd>{asBool(props.statuses.vault.encrypted) ? "Encrypted locally" : "Local storage"}</dd></div><div><dt>Deletion</dt><dd>{asString(props.statuses.retention.policy) === "manual-delete-only" ? "Only when you choose" : metric(props.statuses.retention.policy, "Manual only")}</dd></div><div><dt>Automatic deletion</dt><dd>{asBool(props.statuses.retention.automaticDeletion) ? "On" : "Off"}</dd></div></dl><details className="technical-settings"><summary>Technical details</summary><dl className="settings-facts"><div><dt>Storage engine</dt><dd>{metric(props.statuses.vault.backend, "Encrypted local store")}</dd></div><div><dt>Connection protocol</dt><dd>{metric(props.statuses.core.sidecarTransport, "Local process")}</dd></div></dl></details></div>;
    if (props.section === "diagnostics") return <div className="settings-panel-content"><header><h2>Diagnostics</h2><p>Inspect a content-free report before saving it</p></header><section className="settings-group diagnostic-export"><div className="settings-row-title"><div><strong>Safe diagnostic report</strong><span>App metadata only. Meeting content, secrets, and complete paths are excluded.</span></div><div className="settings-actions"><button type="button" onClick={props.onPrepareDiagnostics} disabled={Boolean(props.busy)}>Prepare preview</button><button type="button" onClick={props.onSaveDiagnostics} disabled={Boolean(props.busy)}>Save JSON</button></div></div>{props.diagnosticPreview ? <details><summary>Inspect exact report</summary><pre>{JSON.stringify(props.diagnosticPreview, null, 2)}</pre></details> : null}</section></div>;
    if (props.section === "export") return <div className="settings-panel-content"><header><h2>Export</h2><p>Local files only</p></header><dl className="settings-facts"><div><dt>Markdown</dt><dd>Available locally</dd></div><div><dt>WAV</dt><dd>Available locally</dd></div><div><dt>Word</dt><dd>Editable, local</dd></div><div><dt>PDF</dt><dd>Searchable, local</dd></div><div><dt>Public links</dt><dd>Unavailable</dd></div></dl><button className="primary-button" type="button" onClick={props.onOpenExport}>Open export flow</button></div>;
    return <div className="settings-panel-content"><header><h2>General</h2><p>Everyday controls for this computer</p></header><dl className="settings-facts"><div><dt>Meeting storage</dt><dd>{asBool(props.statuses.vault.encrypted) ? "Encrypted on this device" : "Stored on this device"}</dd></div><div><dt>Updates</dt><dd>{asBool(props.statuses.updates.backgroundChecks) ? "Background checks on" : "Manual checks only"}</dd></div><div><dt>Deletion</dt><dd>{asString(props.statuses.retention.policy) === "manual-delete-only" ? "Delete only when you choose" : "Managed locally"}</dd></div><div><dt>Account</dt><dd>Not required</dd></div></dl><button type="button" className="secondary-button" onClick={props.onRefreshLocalSettings} disabled={Boolean(props.busy)}>Refresh local settings</button></div>;
  };
  const basicSections: Array<[SettingsSection, string]> = [["general", "General"], ["recording", "Recording"], ["models", "AI & Transcription"], ["export", "Export"], ["license", "License"]];
  const advancedSections: Array<[SettingsSection, string]> = [["storage", "Storage and retention"], ["privacy", "Privacy and network"], ["diagnostics", "Diagnostics"]];
  return <section className="page-view" data-view="settings"><header className="screen-heading"><h1>Settings</h1><p>Local controls for Candor on this computer</p></header><div className="settings-layout"><nav aria-label="Settings sections"><span>Basic</span>{basicSections.map(([id, label]) => <button type="button" aria-current={props.section === id ? "page" : undefined} key={id} onClick={() => props.onSectionChange(id)}>{label}</button>)}<button type="button" className="advanced-settings-toggle" aria-expanded={props.advancedOpen} onClick={props.onToggleAdvanced}>{props.advancedOpen ? "Hide advanced settings" : "Show advanced settings"}</button>{props.advancedOpen ? <><span>Advanced</span>{advancedSections.map(([id, label]) => <button type="button" aria-current={props.section === id ? "page" : undefined} key={id} onClick={() => props.onSectionChange(id)}>{label}</button>)}</> : null}</nav><section className="settings-panel">{renderPanel()}</section></div></section>;
}

function qualityGuardCopy(reason: string | null): string {
  if (!reason) return "Unavailable on this computer";
  if (reason.includes("16gb")) return "Requires at least 16 GB of memory";
  if (reason.includes("8gb")) return "Requires at least 8 GB of memory";
  if (reason.includes("benchmark")) return "Available after a passing local performance check";
  return "Unavailable on this computer";
}
