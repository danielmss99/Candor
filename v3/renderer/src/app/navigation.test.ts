import { describe, expect, it } from "vitest";
import {
  detailSectionToMeetingTab,
  meetingTabToDetailSection,
  routeToWorkspaceView,
  settingsRouteSection,
} from "./navigation";

describe("typed navigation", () => {
  it("maps product routes to the existing workspace views", () => {
    expect(routeToWorkspaceView({ name: "home" })).toBe("home");
    expect(routeToWorkspaceView({ name: "meetings", page: 2 })).toBe("library");
    expect(routeToWorkspaceView({ name: "meeting", recordingId: "recording-1", tab: "notes" })).toBe("detail");
    expect(routeToWorkspaceView({ name: "live" })).toBe("meeting");
    expect(routeToWorkspaceView({ name: "review", recordingId: "recording-1" })).toBe("review");
    expect(routeToWorkspaceView({ name: "export", recordingId: "recording-1" })).toBe("export");
  });

  it("keeps meeting tabs restricted to the three normal sections", () => {
    expect(meetingTabToDetailSection("transcript")).toBe("transcript");
    expect(detailSectionToMeetingTab("summary")).toBe("summary");
    expect(detailSectionToMeetingTab("notes")).toBe("notes");
  });

  it("routes technical settings to advanced disclosure", () => {
    expect(settingsRouteSection("recording")).toEqual({ name: "settings", section: "audio" });
    expect(settingsRouteSection("models")).toEqual({ name: "settings", section: "advanced" });
    expect(settingsRouteSection("privacy")).toEqual({ name: "settings", section: "advanced" });
  });
});
