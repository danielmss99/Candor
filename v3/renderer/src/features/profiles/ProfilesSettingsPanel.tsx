import { MeetingProfileManager } from "./MeetingProfileManager";
import { ModelTransparencyCards } from "./ModelTransparencyCards";
import { ReplacementRulesManager } from "./ReplacementRulesManager";
import type { ProfileWorkspaceController } from "./types";
import type { MeetingProfile } from "./types";
import { useProfileWorkspace } from "./useProfileWorkspace";

interface ProfilesSettingsPanelProps {
  controller?: ProfileWorkspaceController;
  onProfileSelected?(profile: MeetingProfile): void;
  liveTranscriptRuntimeAvailable?: boolean;
  verifiedLiveModelIds?: readonly string[];
}

export function ProfilesSettingsPanel({
  controller: suppliedController,
  onProfileSelected,
  liveTranscriptRuntimeAvailable,
  verifiedLiveModelIds,
}: ProfilesSettingsPanelProps) {
  const localController = useProfileWorkspace(!suppliedController);
  const controller = suppliedController ?? localController;
  return (
    <div className="profile-workspace">
      {controller.error ? <div className="profile-message error" role="alert">{controller.error}</div> : null}
      {controller.notice ? <div className="profile-message" role="status">{controller.notice}</div> : null}
      <MeetingProfileManager
        controller={controller}
        onProfileSelected={onProfileSelected}
        liveTranscriptRuntimeAvailable={liveTranscriptRuntimeAvailable}
        verifiedLiveModelIds={verifiedLiveModelIds}
      />
      <ReplacementRulesManager controller={controller} />
      <ModelTransparencyCards models={controller.models} loading={controller.loading} />
    </div>
  );
}
