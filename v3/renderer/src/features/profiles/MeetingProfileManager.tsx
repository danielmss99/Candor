import { useEffect, useMemo, useState } from "react";
import type { MeetingProfile, MeetingProfileDraft, ProfileWorkspaceController, ReplacementRuleSet } from "./types";

interface MeetingProfileManagerProps {
  controller: ProfileWorkspaceController;
  onProfileSelected?(profile: MeetingProfile): void;
  liveTranscriptRuntimeAvailable?: boolean;
  verifiedLiveModelIds?: readonly string[];
}

const emptyDraft: MeetingProfileDraft = {
  name: "",
  captureSource: "combined",
  language: "auto",
  localModelTier: "balanced",
  speechModelId: "large-v3-turbo",
  cleanupModelId: "qwen3-4b-official-q4_k_m",
  summaryModelId: "qwen3-4b-official-q4_k_m",
  dictionaryIds: [],
  replacementRuleSetId: null,
  recapTemplate: "Summarize the discussion, decisions, action items, and open questions.",
  liveTranscription: false,
};

const MODEL_TIERS: ReadonlyArray<{
  value: MeetingProfileDraft["localModelTier"];
  label: string;
  description: string;
}> = [
  { value: "fast", label: "Fast", description: "Lower latency" },
  { value: "balanced", label: "Balanced", description: "Recommended" },
  { value: "maximum", label: "Maximum", description: "Highest accuracy" },
];

interface ProfileModelTierSelectorProps {
  value: MeetingProfileDraft["localModelTier"];
  onChange(value: MeetingProfileDraft["localModelTier"]): void;
}

export function ProfileModelTierSelector({ value, onChange }: ProfileModelTierSelectorProps) {
  return (
    <fieldset className="profile-tier-picker">
      <legend>Local model tier</legend>
      <div>
        {MODEL_TIERS.map((tier) => (
          <label key={tier.value} data-selected={value === tier.value}>
            <input
              type="radio"
              name="profile-local-model-tier"
              value={tier.value}
              checked={value === tier.value}
              onChange={() => onChange(tier.value)}
            />
            <span><strong>{tier.label}</strong><small>{tier.description}</small></span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function toDraft(profile: MeetingProfile): MeetingProfileDraft {
  return {
    id: profile.builtIn ? undefined : profile.id,
    expectedVersion: profile.builtIn ? undefined : profile.version,
    name: profile.builtIn ? `${profile.name} copy` : profile.name,
    captureSource: profile.captureSource,
    language: profile.language,
    localModelTier: profile.localModelTier,
    speechModelId: profile.speechModelId,
    cleanupModelId: profile.cleanupModelId ?? undefined,
    summaryModelId: profile.summaryModelId ?? undefined,
    dictionaryIds: [...profile.dictionaryIds],
    replacementRuleSetId: profile.replacementRuleSetId,
    recapTemplate: profile.recapTemplate,
    liveTranscription: profile.liveTranscription,
  };
}

function ruleSetLabel(ruleSets: ReplacementRuleSet[], id: string | null): string {
  if (!id) return "No deterministic replacements";
  return ruleSets.find((set) => set.id === id)?.name ?? "Replacement set unavailable";
}

function liveModelId(profile: Pick<MeetingProfileDraft, "localModelTier" | "language">): string {
  if (profile.localModelTier === "maximum") return "large-v3";
  if (profile.localModelTier === "balanced") return "large-v3-turbo";
  return /^en(?:-|$)/i.test(profile.language) ? "small.en" : "small";
}

export function MeetingProfileManager({
  controller,
  onProfileSelected,
  liveTranscriptRuntimeAvailable = false,
  verifiedLiveModelIds = [],
}: MeetingProfileManagerProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MeetingProfileDraft>(emptyDraft);
  const [dictionaryText, setDictionaryText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selected = useMemo(
    () => controller.profiles.find((profile) => profile.id === controller.selectedProfileId) ?? null,
    [controller.profiles, controller.selectedProfileId],
  );
  const parakeetReady = controller.models.some((model) =>
    model.modelId === "parakeet-tdt-0.6b-v3-int8"
    && model.availability === "installed"
    && model.verification === "verified");
  const tierWhisperModelId = liveModelId(draft);
  const speechModelOptions = [
    { value: tierWhisperModelId, label: `Whisper ${tierWhisperModelId}` },
    ...(parakeetReady || draft.speechModelId === "parakeet-tdt-0.6b-v3-int8"
      ? [{
          value: "parakeet-tdt-0.6b-v3-int8",
          label: parakeetReady ? "NVIDIA Parakeet V3" : "NVIDIA Parakeet V3, model unavailable",
        }]
      : []),
  ];
  const liveReady = (profile: Pick<MeetingProfileDraft, "localModelTier" | "language">) =>
    liveTranscriptRuntimeAvailable && verifiedLiveModelIds.includes(liveModelId(profile));

  useEffect(() => {
    setConfirmDelete(false);
  }, [controller.selectedProfileId]);

  const beginCreate = () => {
    setDraft({
      ...emptyDraft,
      speechModelId: parakeetReady ? "parakeet-tdt-0.6b-v3-int8" : emptyDraft.speechModelId,
    });
    setDictionaryText("");
    setEditing(true);
  };

  const beginEdit = () => {
    if (!selected) return;
    const next = toDraft(selected);
    setDraft({ ...next, liveTranscription: liveReady(next) && next.liveTranscription });
    setDictionaryText(next.dictionaryIds.join(", "));
    setEditing(true);
  };

  const save = async () => {
    const dictionaryIds = [...new Set(dictionaryText.split(",").map((item) => item.trim()).filter(Boolean))];
    await controller.saveProfile({
      ...draft,
      name: draft.name.trim(),
      language: draft.language.trim(),
      speechModelId: draft.speechModelId ?? liveModelId(draft),
      cleanupModelId: draft.cleanupModelId ?? "qwen3-4b-official-q4_k_m",
      summaryModelId: draft.summaryModelId ?? "qwen3-4b-official-q4_k_m",
      dictionaryIds,
      liveTranscription: liveReady(draft) && draft.liveTranscription,
    });
    setEditing(false);
  };

  return (
    <section className="profile-surface" aria-labelledby="meeting-profile-heading">
      <div className="profile-section-heading">
        <div>
          <h3 id="meeting-profile-heading">Meeting profiles</h3>
          <p>Choose a repeatable local setup for each kind of conversation.</p>
        </div>
        <button type="button" onClick={beginCreate} disabled={controller.busy}>New custom profile</button>
      </div>

      {controller.profiles.length === 0 && !controller.loading ? <p className="profile-empty">No meeting profiles are available.</p> : (
        <fieldset className="profile-choice-grid" disabled={controller.busy}>
          <legend className="sr-only">Active meeting profile</legend>
          {controller.profiles.map((profile) => (
            <label key={profile.id} className="profile-choice" data-selected={profile.id === controller.selectedProfileId}>
              <input
                type="radio"
                name="meeting-profile"
                value={profile.id}
                checked={profile.id === controller.selectedProfileId}
                onChange={() => {
                  controller.selectProfile(profile.id);
                  onProfileSelected?.(profile);
                }}
              />
              <span>
                <strong>{profile.name}</strong>
                <small>{profile.builtIn ? "Built in" : `Custom, version ${profile.version}`}</small>
              </span>
              <em>{profile.localModelTier}</em>
            </label>
          ))}
        </fieldset>
      )}

      {selected && !editing ? (
        <article className="profile-summary" aria-label={`${selected.name} profile details`}>
          <dl>
            <div><dt>Capture</dt><dd>{selected.captureSource === "combined" ? "Microphone and system audio" : selected.captureSource === "system-audio" ? "System audio" : "Microphone"}</dd></div>
            <div><dt>Language</dt><dd>{selected.language === "auto" ? "Detect automatically" : selected.language}</dd></div>
            <div><dt>Local model</dt><dd>{selected.localModelTier}</dd></div>
            <div><dt>Speech model</dt><dd>{selected.speechModelId}</dd></div>
            <div><dt>Cleanup model</dt><dd>{selected.cleanupModelId ?? "Original transcript only"}</dd></div>
            <div><dt>Summary model</dt><dd>{selected.summaryModelId ?? "No automatic summary"}</dd></div>
            <div><dt>Live transcript</dt><dd>{selected.liveTranscription
              ? liveReady(selected) ? "On, local and provisional" : "Needs its verified local model"
              : "Off"}</dd></div>
            <div><dt>Replacements</dt><dd>{ruleSetLabel(controller.ruleSets, selected.replacementRuleSetId)}</dd></div>
          </dl>
          <p><strong>Recap template</strong><span>{selected.recapTemplate || "No recap template"}</span></p>
          <div className="profile-actions">
            <button type="button" onClick={beginEdit} disabled={controller.busy}>{selected.builtIn ? "Duplicate and customize" : "Edit profile"}</button>
            {!selected.builtIn ? confirmDelete ? (
              <>
                <button type="button" className="profile-danger" onClick={() => void controller.deleteProfile(selected)} disabled={controller.busy}>Confirm delete</button>
                <button type="button" onClick={() => setConfirmDelete(false)} disabled={controller.busy}>Cancel</button>
              </>
            ) : <button type="button" className="profile-danger" onClick={() => setConfirmDelete(true)} disabled={controller.busy}>Delete profile</button> : null}
          </div>
        </article>
      ) : null}

      {editing ? (
        <form className="profile-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <h4>{draft.id ? "Edit custom profile" : "Create custom profile"}</h4>
          <label><span>Name</span><input required maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <div className="profile-field-grid">
            <label><span>Capture source</span><select value={draft.captureSource} onChange={(event) => setDraft({ ...draft, captureSource: event.target.value as MeetingProfileDraft["captureSource"] })}><option value="combined">Microphone and system audio</option><option value="microphone">Microphone</option><option value="system-audio">System audio</option></select></label>
            <ProfileModelTierSelector value={draft.localModelTier} onChange={(localModelTier) => {
              const next = { ...draft, localModelTier };
              setDraft({
                ...next,
                speechModelId: draft.speechModelId === "parakeet-tdt-0.6b-v3-int8"
                  ? draft.speechModelId
                  : liveModelId(next),
              });
            }} />
            <label><span>Final transcription model</span><select value={draft.speechModelId ?? tierWhisperModelId} onChange={(event) => setDraft({ ...draft, speechModelId: event.target.value })}>{speechModelOptions.map((model) => <option key={model.value} value={model.value} disabled={model.value === "parakeet-tdt-0.6b-v3-int8" && !parakeetReady}>{model.label}</option>)}</select><small>Parakeet runs after capture. Live provisional text uses the matching verified Whisper model.</small></label>
            <label><span>Language</span><input required maxLength={35} pattern="(?:auto|[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9])" value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.target.value })} aria-describedby="profile-language-hint" /><small id="profile-language-hint">Use auto or a language tag such as en-US.</small></label>
            <label><span>Replacement set</span><select value={draft.replacementRuleSetId ?? ""} onChange={(event) => setDraft({ ...draft, replacementRuleSetId: event.target.value || null })}><option value="">No deterministic replacements</option>{controller.ruleSets.filter((set) => set.id !== "none").map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}</select></label>
          </div>
          <label><span>Dictionary IDs</span><input value={dictionaryText} maxLength={1_039} onChange={(event) => setDictionaryText(event.target.value)} aria-describedby="dictionary-id-hint" /><small id="dictionary-id-hint">Optional lowercase IDs separated by commas. Vocabulary hints remain separate from replacements.</small></label>
          <label><span>Recap template</span><textarea maxLength={4_096} rows={4} value={draft.recapTemplate} onChange={(event) => setDraft({ ...draft, recapTemplate: event.target.value })} /></label>
          <label className="profile-checkbox">
            <input
              type="checkbox"
              checked={draft.liveTranscription}
              disabled={!liveReady(draft)}
              onChange={(event) => setDraft({ ...draft, liveTranscription: event.target.checked })}
              aria-describedby="profile-live-transcript-status"
            />
            <span>Show a provisional live transcript during capture</span>
          </label>
          <small id="profile-live-transcript-status">{liveReady(draft)
            ? "Runs locally in bounded five-second windows. Final wording replaces provisional text after capture."
            : "Verify the local speech model for this profile tier to enable live transcription."}</small>
          <div className="profile-actions"><button type="submit" className="primary-button" disabled={controller.busy || !draft.name.trim()}>Save profile</button><button type="button" onClick={() => setEditing(false)} disabled={controller.busy}>Cancel</button></div>
        </form>
      ) : null}
    </section>
  );
}
