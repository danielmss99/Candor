import type { SavedMeeting } from "../api/local";
import type { UserTask } from "../api/actions";

export interface CatchUpDigest {
  decisions: string[];
  openTasks: { text: string; meeting: string; due: string }[];
  meetingCount: number;
}

/** Build a 7-day catch-up digest from meetings and tasks. */
export function buildCatchUpDigest(
  meetings: SavedMeeting[],
  userTasks: UserTask[],
  completedIds: Set<string>,
  mockDecisions: string[] = [],
): CatchUpDigest {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = meetings.filter((m) => {
    const d = Date.parse(m.date);
    return !Number.isNaN(d) && d >= weekAgo;
  });

  const decisions = recent
    .map((m) => m.blurb)
    .filter((b) => /\b(decided|agreed|approved|consensus)\b/i.test(b))
    .slice(0, 5);

  const openTasks = userTasks
    .filter((t) => !completedIds.has(t.id))
    .slice(0, 6)
    .map((t) => ({ text: t.text, meeting: t.meeting, due: t.due }));

  return {
    decisions: decisions.length > 0 ? decisions : mockDecisions.slice(0, 3),
    openTasks,
    meetingCount: recent.length,
  };
}
