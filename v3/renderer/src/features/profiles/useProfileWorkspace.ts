import { useCallback, useEffect, useState } from "react";
import { parseActiveProfileId, parseProfileList, parseReplacementPreview, parseRuleSetList, parseTransparentModels } from "./profile-parsers";
import type { MeetingProfile, MeetingProfileDraft, ProfileWorkspaceController, ReplacementPreview, ReplacementRule, ReplacementRuleSet, TransparentModel } from "./types";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 240);
  return "The local profile service is unavailable. Try again.";
}

function candorApi(): NonNullable<Window["candor"]> {
  if (typeof window === "undefined" || !window.candor) throw new Error("Candor's local desktop bridge is unavailable.");
  return window.candor;
}

export function useProfileWorkspace(enabled = true): ProfileWorkspaceController {
  const [profiles, setProfiles] = useState<MeetingProfile[]>([]);
  const [ruleSets, setRuleSets] = useState<ReplacementRuleSet[]>([]);
  const [models, setModels] = useState<TransparentModel[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("general");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refreshProfiles = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const api = candorApi();
      const [profileResponse, ruleResponse, modelResponse] = await Promise.all([
        api.profiles.list(),
        api.replacements.list(),
        api.ai.listSpeechModels(),
      ]);
      const nextProfiles = parseProfileList(profileResponse);
      setProfiles(nextProfiles);
      setRuleSets(parseRuleSetList(ruleResponse));
      setModels(parseTransparentModels(modelResponse));
      const activeProfileId = parseActiveProfileId(profileResponse);
      setSelectedProfileId(
        activeProfileId && nextProfiles.some((profile) => profile.id === activeProfileId)
          ? activeProfileId
          : nextProfiles[0]?.id ?? "",
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refreshProfiles();
  }, [enabled, refreshProfiles]);

  const runMutation = useCallback(async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  const saveProfile = useCallback(async (draft: MeetingProfileDraft) => {
    await runMutation(async () => {
      const response = await candorApi().profiles.upsert(draft);
      const responseProfile = parseProfileList({ profiles: [(response as Record<string, unknown>).profile] })[0];
      await refreshProfiles();
      if (responseProfile) setSelectedProfileId(responseProfile.id);
    }, draft.id ? "Meeting profile updated." : "Meeting profile created.");
  }, [refreshProfiles, runMutation]);

  const deleteProfile = useCallback(async (profile: MeetingProfile) => {
    if (profile.builtIn) return;
    await runMutation(async () => {
      await candorApi().profiles.delete(profile.id, profile.version);
      await refreshProfiles();
    }, "Meeting profile deleted.");
  }, [refreshProfiles, runMutation]);

  const selectProfile = useCallback((id: string) => {
    const previous = selectedProfileId;
    setSelectedProfileId(id);
    setBusy(true);
    setError("");
    setNotice("");
    void candorApi().profiles.select(id).then(() => {
      setNotice("Active meeting profile saved.");
    }).catch((caught: unknown) => {
      setSelectedProfileId(previous);
      setError(errorMessage(caught));
    }).finally(() => {
      setBusy(false);
    });
  }, [selectedProfileId]);

  const saveRuleSet = useCallback(async (input: { id?: string; expectedVersion?: number; name: string; rules: ReplacementRule[] }) => {
    await runMutation(async () => {
      await candorApi().replacements.upsert(input);
      await refreshProfiles();
    }, input.id ? "Replacement set updated." : "Replacement set created.");
  }, [refreshProfiles, runMutation]);

  const deleteRuleSet = useCallback(async (ruleSet: ReplacementRuleSet) => {
    if (ruleSet.builtIn) return;
    await runMutation(async () => {
      await candorApi().replacements.delete(ruleSet.id, ruleSet.version);
      await refreshProfiles();
    }, "Replacement set deleted.");
  }, [refreshProfiles, runMutation]);

  const previewReplacements = useCallback(async (setId: string, input: string): Promise<ReplacementPreview | null> => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await candorApi().replacements.preview(setId, input);
      const parsed = parseReplacementPreview(response);
      if (!parsed) throw new Error("Candor returned an invalid replacement preview.");
      return parsed;
    } catch (caught) {
      setError(errorMessage(caught));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const applyReplacements = useCallback(async (setId: string, input: string, preview: ReplacementPreview, approveProtectedTerms: boolean): Promise<ReplacementPreview | null> => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await candorApi().replacements.apply({
        setId,
        input,
        previewToken: preview.previewToken,
        approveProtectedTerms,
      });
      const parsed = parseReplacementPreview(response);
      if (!parsed || !parsed.applied) throw new Error("Candor did not confirm the replacement result.");
      setNotice("Replacements approved and applied to this preview.");
      return parsed;
    } catch (caught) {
      setError(errorMessage(caught));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    profiles,
    ruleSets,
    models,
    selectedProfileId,
    loading,
    busy,
    notice,
    error,
    selectProfile,
    saveProfile,
    deleteProfile,
    saveRuleSet,
    deleteRuleSet,
    previewReplacements,
    applyReplacements,
    refreshProfiles,
  };
}
