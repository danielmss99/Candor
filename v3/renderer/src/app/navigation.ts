import type {
  DetailSection,
  ReviewSection,
  SettingsSection,
} from "../core/contracts";

export type MeetingTab = "summary" | "transcript" | "notes";

export type AppRoute =
  | { name: "home" }
  | { name: "meetings"; page?: number }
  | { name: "meeting"; recordingId: string; tab: MeetingTab }
  | { name: "live" }
  | { name: "review"; recordingId: string }
  | { name: "export"; recordingId: string }
  | { name: "settings"; section?: "general" | "audio" | "storage" | "advanced" };

export type WorkspaceView =
  | "home"
  | "meeting"
  | "library"
  | "detail"
  | "review"
  | "settings"
  | "export"
  | "proof";

export function routeToWorkspaceView(route: AppRoute): WorkspaceView {
  if (route.name === "meetings") return "library";
  if (route.name === "meeting") return "detail";
  if (route.name === "live") return "meeting";
  return route.name;
}

export function meetingTabToDetailSection(tab: MeetingTab): DetailSection {
  return tab;
}

export function detailSectionToMeetingTab(section: DetailSection): MeetingTab | null {
  if (section === "summary" || section === "transcript" || section === "notes") return section;
  return null;
}

export function settingsRouteSection(section: SettingsSection): AppRoute & { name: "settings" } {
  if (section === "recording") return { name: "settings", section: "audio" };
  if (section === "general" || section === "export") return { name: "settings", section: "general" };
  return { name: "settings", section: "advanced" };
}

export function reviewRoute(recordingId: string, _section: ReviewSection): AppRoute {
  return { name: "review", recordingId };
}

