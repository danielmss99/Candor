import { PrivacyReceipt } from "../privacy/PrivacyReceipt";
import { asArray, asBool, asNumber, asObject, asString, formatBytes, metric, type AiMode, type InstructAssetKind, type JsonObject, type MeetingPrivacyReceipt, type ModelRow, type NetworkCapabilities, type SettingsSection } from "../../core/contracts";

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
  models: ModelRow[];
  selectedModel: string;
  defaultModel: string;
  aiMode: AiMode;
  aiModeStatus: string;
  instructSetupOpen: boolean;
  instructAssetsReady: boolean;
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
    return <div className="settings-panel-content"><header><h2>Local AI</h2><p>Speech and writing tools installed on this computer</p></header><section className="settings-group"><div className="settings-row-title"><div><strong>Transcription</strong><span>{asBool(props.statuses.transcription.whisperFeatureEnabled) ? "Runs locally" : "Not available in this build"}</span></div><div className="settings-actions"><button type="button" onClick={props.onVerifyModel} disabled={Boolean(props.busy)}>Check integrity</button><button type="button" onClick={props.onImportModel} disabled={Boolean(props.busy)}>Choose speech model</button></div></div><div className="model-choice-list">{availableModels.slice(0, 6).map((model) => <button type="button" key={model.modelId} aria-pressed={props.selectedModel === model.modelId} onClick={() => props.onSelectedModelChange(model.modelId)}><span><strong>Local speech model</strong><small>{model.modelId} / {model.language}</small></span><em>{model.verified ? "Ready" : model.installed ? "Needs integrity check" : "Not installed"}</em></button>)}</div></section><section className="settings-group"><div className="settings-row-title"><div><strong>Generation mode</strong><span id="local-ai-mode-status-settings">{props.aiModeStatus}</span></div><div className="segmented-control" role="group" aria-label="Settings local AI mode"><button type="button" aria-pressed={props.aiMode === "quality"} onClick={() => props.onAiModeChange("quality")}>Quality</button><button type="button" aria-pressed={props.aiMode === "fast"} onClick={() => props.onAiModeChange("fast")}>Fast</button></div></div></section><details className="instruct-setup" open={props.instructSetupOpen} onToggle={(event) => props.onInstructSetupOpenChange(event.currentTarget.open)}><summary><span><strong>Enhanced local summaries</strong><em>{props.instructAssetsReady ? "Ready" : "Optional setup"}</em></span></summary><div className="instruct-setup-body"><dl className="asset-status-list" aria-label="Managed local AI assets"><div><dt>Processing engine</dt><dd className={asBool(props.instructRunnerAsset.verified) ? "ok" : ""}>{asBool(props.instructRunnerAsset.verified) ? `Ready, ${formatBytes(asNumber(props.instructRunnerAsset.bytes))}` : "Not installed"}</dd></div><div><dt>Language model</dt><dd className={asBool(props.instructModelAsset.verified) ? "ok" : ""}>{asBool(props.instructModelAsset.verified) ? `Ready, ${formatBytes(asNumber(props.instructModelAsset.bytes))}` : "Not installed"}</dd></div></dl><div className="segmented-control asset-kind-control" role="group" aria-label="Local AI asset type"><button type="button" aria-pressed={props.instructAssetKind === "runner"} onClick={() => props.onInstructAssetKindChange("runner")}>Processing engine</button><button type="button" aria-pressed={props.instructAssetKind === "model"} onClick={() => props.onInstructAssetKindChange("model")}>Language model</button></div><label className="asset-hash-field" htmlFor="instruct-asset-sha256"><span>Integrity fingerprint</span><input id="instruct-asset-sha256" value={props.instructExpectedSha256} onChange={(event) => props.onInstructExpectedShaChange(event.target.value)} aria-invalid={Boolean(props.instructAssetError)} aria-describedby="instruct-asset-sha256-status" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="64 hexadecimal characters" /><small id="instruct-asset-sha256-status" className={props.instructAssetError ? "asset-hash-error" : ""} role={props.instructAssetError ? "alert" : undefined}>{props.instructAssetError || "SHA-256 fingerprint required before local copy"}</small></label><button type="button" className="secondary-button full-width" onClick={props.onImportInstructAsset} disabled={Boolean(props.busy)}>{props.busy === "instruct-asset" ? "Checking integrity..." : `Choose ${props.instructAssetKind === "runner" ? "processing engine" : "language model"}`}</button></div></details></div>;
  };
  const renderLicense = () => {
    const portalActions = asArray(props.licensePortalInfo.actions).map((item) => asObject(item));
    return <div className="settings-panel-content"><header><h2>License</h2><p>Optional ownership tools. Sign-in is not required for normal app use.</p></header><section className="settings-group"><div className="settings-row-title"><div><strong>{metric(props.licenseStatus.planName, "Candor Professional")}</strong><span>{props.licenseActive ? "Activated or trialing locally" : "No local activation"}</span></div><div className="settings-actions"><button type="button" onClick={props.onRefreshLicense} disabled={Boolean(props.busy)}>Refresh</button><button type="button" onClick={props.onDeactivateLicense} disabled={Boolean(props.busy) || !props.licenseActive}>Deactivate device</button></div></div><dl className="settings-facts license-facts"><div><dt>Status</dt><dd>{metric(props.licenseStatus.state, "inactive")}</dd></div><div><dt>License ID</dt><dd>{metric(props.licenseStatus.licenseId, "Not activated")}</dd></div><div><dt>Device</dt><dd>{metric(props.licenseStatus.deviceLabel, "This device")}</dd></div><div><dt>Secure storage</dt><dd>{asBool(props.licenseStatus.secureStorageAvailable) ? "Available" : "Metadata only"}</dd></div><div><dt>Account required</dt><dd>No</dd></div><div><dt>Portal</dt><dd>{asBool(props.licensePortalInfo.available) ? "Available" : "Production pending"}</dd></div></dl></section><section className="settings-group"><h3>Portal actions</h3><div className="portal-action-list">{portalActions.map((action) => <article key={asString(action.id)}><span className={asBool(action.enabled) ? "status-dot ok" : "status-dot"} /><div><strong>{asString(action.label)}</strong><small>{asString(action.note)}</small></div></article>)}</div></section></div>;
  };
  const renderPanel = () => {
    if (props.section === "models") return renderLocalAi();
    if (props.section === "license") return renderLicense();
    if (props.section === "recording") return <div className="settings-panel-content"><header><h2>Recording</h2><p>Explicit local capture consent</p></header><section className="settings-group"><div className="consent-grid">{asArray(props.statuses.consent.items).map((item) => { const object = asObject(item); return <article key={asString(object.id)}><span className={asBool(object.acknowledged) ? "status-dot ok" : "status-dot"} /><div><strong>{asString(object.label)}</strong><small>{asBool(object.acknowledged) ? "Acknowledged locally" : "Required"}</small></div></article>; })}</div><div className="settings-actions"><button type="button" onClick={props.onAcknowledgeMic} disabled={Boolean(props.busy)}>Acknowledge microphone</button><button type="button" onClick={props.onAcknowledgeSystem} disabled={Boolean(props.busy)}>Acknowledge system audio</button></div></section><section className="settings-group"><h3>Capture sources</h3><dl className="settings-facts"><div><dt>Microphone</dt><dd>{asBool(asObject(asObject(props.statuses.capture.sources).microphone).implemented) ? "Available" : "Unavailable"}</dd></div><div><dt>System audio</dt><dd>{asBool(asObject(asObject(props.statuses.capture.sources).system).implemented) ? "Available" : "Unavailable"}</dd></div><div><dt>Combined</dt><dd>{props.combinedCaptureAvailable ? "Available" : "Unavailable"}</dd></div></dl><div className="settings-actions"><button type="button" onClick={props.onRecordSystem} disabled={Boolean(props.busy) || props.activeCapture}>Record system audio</button><button type="button" onClick={props.onRecordBoth} disabled={Boolean(props.busy) || props.activeCapture || !props.combinedCaptureAvailable}>Record both</button></div></section></div>;
    if (props.section === "privacy") return <div className="settings-panel-content" aria-label="Local custody"><header><h2>Privacy and diagnostics</h2><p>Facts reported by the local core</p></header><PrivacyReceipt receipt={props.privacyReceipt} network={props.networkCapabilities} /><dl className="settings-facts privacy-facts">{props.custodyItems.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><section className="settings-group diagnostic-export"><div className="settings-row-title"><div><strong>Safe diagnostic report</strong><span>App and custody metadata only. Meeting content and full paths are excluded.</span></div><div className="settings-actions"><button type="button" onClick={props.onPrepareDiagnostics} disabled={Boolean(props.busy)}>Prepare preview</button><button type="button" onClick={props.onSaveDiagnostics} disabled={Boolean(props.busy)}>Save JSON</button></div></div>{props.diagnosticPreview ? <details><summary>Inspect exact report</summary><pre>{JSON.stringify(props.diagnosticPreview, null, 2)}</pre></details> : null}</section></div>;
    if (props.section === "export") return <div className="settings-panel-content"><header><h2>Export</h2><p>Local files only</p></header><dl className="settings-facts"><div><dt>Markdown</dt><dd>Available locally</dd></div><div><dt>WAV</dt><dd>Available locally</dd></div><div><dt>Word</dt><dd>Editable, local</dd></div><div><dt>PDF</dt><dd>Searchable, local</dd></div><div><dt>Public links</dt><dd>Unavailable</dd></div></dl><button className="primary-button" type="button" onClick={props.onOpenExport}>Open export flow</button></div>;
    return <div className="settings-panel-content"><header><h2>General</h2><p>Everyday controls for this computer</p></header><dl className="settings-facts"><div><dt>Storage</dt><dd>{asBool(props.statuses.vault.encrypted) ? "Encrypted locally" : "Local storage"}</dd></div><div><dt>Updates</dt><dd>{asBool(props.statuses.updates.backgroundChecks) ? "Background checks on" : "Manual checks only"}</dd></div><div><dt>Deletion</dt><dd>{asString(props.statuses.retention.policy) === "manual-delete-only" ? "Delete only when you choose" : metric(props.statuses.retention.policy, "Manual only")}</dd></div><div><dt>Account</dt><dd>Not required</dd></div></dl><details className="technical-settings"><summary>Technical details</summary><dl className="settings-facts"><div><dt>App connection</dt><dd>{metric(props.statuses.core.sidecarTransport, "stdio-json-lines")}</dd></div><div><dt>Encrypted store</dt><dd>{metric(props.statuses.vault.backend, "SQLCipher")}</dd></div></dl></details><button type="button" className="secondary-button" onClick={props.onRefreshLocalSettings} disabled={Boolean(props.busy)}>Refresh local settings</button></div>;
  };
  const basicSections: Array<[SettingsSection, string]> = [["general", "General"], ["recording", "Recording"], ["export", "Export"], ["license", "License"]];
  const advancedSections: Array<[SettingsSection, string]> = [["models", "Local AI"], ["privacy", "Privacy and diagnostics"]];
  return <section className="page-view" data-view="settings"><header className="screen-heading"><h1>Settings</h1><p>Local controls for Candor on this computer</p></header><div className="settings-layout"><nav aria-label="Settings sections"><span>BASIC</span>{basicSections.map(([id, label]) => <button type="button" aria-current={props.section === id ? "page" : undefined} key={id} onClick={() => props.onSectionChange(id)}>{label}</button>)}<button type="button" className="advanced-settings-toggle" aria-expanded={props.advancedOpen} onClick={props.onToggleAdvanced}>{props.advancedOpen ? "Hide advanced settings" : "Show advanced settings"}</button>{props.advancedOpen ? <><span>ADVANCED</span>{advancedSections.map(([id, label]) => <button type="button" aria-current={props.section === id ? "page" : undefined} key={id} onClick={() => props.onSectionChange(id)}>{label}</button>)}</> : null}</nav><section className="settings-panel">{renderPanel()}</section></div></section>;
}
