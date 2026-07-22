import { useCallback, useState } from "react";
import type {
  AppView,
  DetailSection,
  ReviewSection,
  SettingsSection,
} from "../core/contracts";

export type MeetingTab = "summary" | "transcript" | "history" | "notes";

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
  | "export";

export function routeToWorkspaceView(route: AppRoute): WorkspaceView {
  if (route.name === "meetings") return "library";
  if (route.name === "meeting") return "detail";
  if (route.name === "live") return "meeting";
  return route.name;
}

export function meetingTabToDetailSection(tab: MeetingTab): DetailSection {
  return tab;
}

export function detailSectionToMeetingTab(section: DetailSection): MeetingTab {
  return section;
}

export function settingsRouteSection(section: SettingsSection): AppRoute & { name: "settings" } {
  if (section === "recording") return { name: "settings", section: "audio" };
  if (section === "general" || section === "export") return { name: "settings", section: "general" };
  return { name: "settings", section: "advanced" };
}

export function reviewRoute(recordingId: string, _section: ReviewSection): AppRoute {
  return { name: "review", recordingId };
}

export function workspaceViewToRoute(
  view: AppView,
  recordingId: string,
  detailSection: DetailSection,
  settingsSection: SettingsSection,
): AppRoute {
  if (view === "home") return { name: "home" };
  if (view === "library") return { name: "meetings" };
  if (view === "meeting") return { name: "live" };
  if (view === "settings") return settingsRouteSection(settingsSection);
  if (!recordingId) return { name: "meetings" };
  if (view === "detail") return { name: "meeting", recordingId, tab: detailSectionToMeetingTab(detailSection) };
  if (view === "review") return { name: "review", recordingId };
  return { name: "export", recordingId };
}

export function useAppNavigation(selectedRecordingId: string) {
  const [route, setRoute] = useState<AppRoute>({ name: "live" });
  const [detailSection, setDetailSectionState] = useState<DetailSection>("summary");
  const [settingsSection, setSettingsSectionState] = useState<SettingsSection>("general");
  const [reviewSection, setReviewSection] = useState<ReviewSection>("summary");

  const setView = useCallback((view: AppView, recordingId = selectedRecordingId) => {
    setRoute(workspaceViewToRoute(view, recordingId, detailSection, settingsSection));
  }, [detailSection, selectedRecordingId, settingsSection]);

  const setDetailSection = useCallback((section: DetailSection) => {
    setDetailSectionState(section);
    setRoute((current) => current.name === "meeting"
      ? { ...current, tab: detailSectionToMeetingTab(section) }
      : current);
  }, []);

  const setSettingsSection = useCallback((section: SettingsSection) => {
    setSettingsSectionState(section);
    setRoute((current) => current.name === "settings" ? settingsRouteSection(section) : current);
  }, []);

  return {
    route,
    view: routeToWorkspaceView(route) as AppView,
    detailSection,
    settingsSection,
    reviewSection,
    setView,
    setDetailSection,
    setSettingsSection,
    setReviewSection,
  };
}
