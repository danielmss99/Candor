import { useEffect, useMemo, useState } from "react";
import { ReplacementPreviewResult } from "./ReplacementPreviewResult";
import type { ProfileWorkspaceController, ReplacementPreview, ReplacementRule, ReplacementRuleSet } from "./types";

interface ReplacementRulesManagerProps {
  controller: ProfileWorkspaceController;
}

function nextRule(order: number): ReplacementRule {
  return { id: `rule-${order + 1}`, order, matchMode: "whole-word", literal: "", replacement: "", protectedTermReview: false, enabled: true };
}

export function ReplacementRulesManager({ controller }: ReplacementRulesManagerProps) {
  const [selectedId, setSelectedId] = useState("none");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [rules, setRules] = useState<ReplacementRule[]>([]);
  const [sourceText, setSourceText] = useState("");
  const [preview, setPreview] = useState<ReplacementPreview | null>(null);
  const [protectedApproved, setProtectedApproved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selected = useMemo(() => controller.ruleSets.find((set) => set.id === selectedId) ?? controller.ruleSets[0] ?? null, [controller.ruleSets, selectedId]);

  useEffect(() => {
    if (!controller.ruleSets.some((set) => set.id === selectedId)) setSelectedId(controller.ruleSets[0]?.id ?? "");
  }, [controller.ruleSets, selectedId]);

  const invalidatePreview = (value: string) => {
    setSourceText(value);
    setPreview(null);
    setProtectedApproved(false);
  };

  const beginEdit = (ruleSet?: ReplacementRuleSet) => {
    setName(ruleSet?.builtIn ? "" : ruleSet?.name ?? "");
    setRules(ruleSet?.builtIn ? [nextRule(0)] : ruleSet?.rules.map((rule) => ({ ...rule })) ?? [nextRule(0)]);
    setEditing(true);
  };

  const updateRule = (index: number, update: Partial<ReplacementRule>) => {
    setRules((current) => current.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...update } : rule));
  };

  const save = async () => {
    const isExistingCustom = selected && !selected.builtIn;
    await controller.saveRuleSet({
      id: isExistingCustom ? selected.id : undefined,
      expectedVersion: isExistingCustom ? selected.version : undefined,
      name: name.trim(),
      rules: rules.map((rule, index) => ({ ...rule, order: index, id: rule.id.trim() || `rule-${index + 1}` })),
    });
    setEditing(false);
  };

  const requestPreview = async () => {
    if (!selected || !sourceText) return;
    setPreview(await controller.previewReplacements(selected.id, sourceText));
    setProtectedApproved(false);
  };

  const apply = async () => {
    if (!selected || !preview) return;
    const result = await controller.applyReplacements(selected.id, sourceText, preview, protectedApproved);
    if (result) setPreview(result);
  };

  return (
    <section className="profile-surface" aria-labelledby="replacement-heading">
      <div className="profile-section-heading">
        <div><h3 id="replacement-heading">Deterministic replacements</h3><p>Review exact text changes after transcription. These rules never become speech-recognition vocabulary hints.</p></div>
        <button type="button" onClick={() => beginEdit()} disabled={controller.busy}>New replacement set</button>
      </div>

      <label className="profile-block-field"><span>Replacement set</span><select value={selected?.id ?? ""} disabled={controller.busy} onChange={(event) => { setSelectedId(event.target.value); setEditing(false); setPreview(null); setConfirmDelete(false); }}>{controller.ruleSets.map((set) => <option key={set.id} value={set.id}>{set.name}{set.builtIn ? " (built in)" : ""}</option>)}</select></label>

      {selected ? <div className="profile-actions"><button type="button" onClick={() => beginEdit(selected)} disabled={controller.busy}>{selected.builtIn ? "Create from this set" : "Edit set"}</button>{!selected.builtIn ? confirmDelete ? <><button type="button" className="profile-danger" onClick={() => void controller.deleteRuleSet(selected)} disabled={controller.busy}>Confirm delete</button><button type="button" onClick={() => setConfirmDelete(false)} disabled={controller.busy}>Cancel</button></> : <button type="button" className="profile-danger" onClick={() => setConfirmDelete(true)} disabled={controller.busy}>Delete set</button> : null}</div> : null}

      {editing ? (
        <form className="profile-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <h4>{selected && !selected.builtIn ? "Edit replacement set" : "Create replacement set"}</h4>
          <label><span>Name</span><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <div className="replacement-rule-list">
            {rules.map((rule, index) => (
              <fieldset key={`${rule.id}-${index}`} className="replacement-rule">
                <legend>Rule {index + 1}</legend>
                <label><span>Rule ID</span><input required pattern="[a-z][a-z0-9-]*[a-z0-9]" maxLength={64} value={rule.id} onChange={(event) => updateRule(index, { id: event.target.value })} /></label>
                <label><span>Match</span><select value={rule.matchMode} onChange={(event) => updateRule(index, { matchMode: event.target.value === "exact" ? "exact" : "whole-word" })}><option value="whole-word">Whole word</option><option value="exact">Exact text</option></select></label>
                <label><span>Find</span><input required maxLength={128} value={rule.literal} onChange={(event) => updateRule(index, { literal: event.target.value })} /></label>
                <label><span>Replace with</span><input maxLength={512} value={rule.replacement} onChange={(event) => updateRule(index, { replacement: event.target.value })} /></label>
                <label className="profile-checkbox"><input type="checkbox" checked={rule.protectedTermReview} onChange={(event) => updateRule(index, { protectedTermReview: event.target.checked })} /><span>Require protected-term approval</span></label>
                <label className="profile-checkbox"><input type="checkbox" checked={rule.enabled} onChange={(event) => updateRule(index, { enabled: event.target.checked })} /><span>Rule enabled</span></label>
                <button type="button" onClick={() => setRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index))} disabled={rules.length === 1}>Remove rule</button>
              </fieldset>
            ))}
          </div>
          <button type="button" onClick={() => setRules((current) => [...current, nextRule(current.length)])} disabled={rules.length >= 64}>Add rule</button>
          <div className="profile-actions"><button type="submit" className="primary-button" disabled={controller.busy || !name.trim() || rules.some((rule) => !rule.id.trim() || !rule.literal)}>Save replacement set</button><button type="button" onClick={() => setEditing(false)} disabled={controller.busy}>Cancel</button></div>
        </form>
      ) : null}

      <div className="replacement-preview">
        <h4>Preview changes</h4>
        <label><span>Original text</span><textarea rows={5} value={sourceText} maxLength={262_144} onChange={(event) => invalidatePreview(event.target.value)} /></label>
        <button type="button" onClick={() => void requestPreview()} disabled={controller.busy || !selected || !sourceText}>Preview replacements</button>
        {preview ? <ReplacementPreviewResult preview={preview} protectedApproved={protectedApproved} busy={controller.busy} onProtectedApprovedChange={setProtectedApproved} onApply={() => void apply()} /> : null}
      </div>
    </section>
  );
}
