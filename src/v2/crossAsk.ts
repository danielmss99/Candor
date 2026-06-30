import type { SavedMeeting } from "../api/local";
import { loadMeetingDetail } from "../api/local";
import { getRecapForMeeting } from "../data/mock";

/** Simple cross-meeting Q&A using keyword matching across saved transcripts. */
export async function answerCrossMeeting(
  question: string,
  meetings: SavedMeeting[],
): Promise<string> {
  const q = question.trim().toLowerCase();
  if (!q) return "Ask a question about your meetings.";

  const terms = q.split(/\s+/).filter((w) => w.length > 2);
  const hits: { title: string; snippet: string; score: number }[] = [];

  for (const m of meetings.slice(0, 20)) {
    const detail = await loadMeetingDetail(m.id);
    const full =
      detail?.transcript.map((s) => s.text).join(" ") ??
      (m.path.startsWith("mock://")
        ? [
            getRecapForMeeting(m.id).summary,
            ...getRecapForMeeting(m.id).decisions,
            ...getRecapForMeeting(m.id).actions.map((a) => a.text),
          ].join(" ")
        : "");
    if (!full) continue;
    const lower = full.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (lower.includes(t)) score += 1;
    }
    if (score === 0) continue;
    const idx = lower.indexOf(terms[0] ?? "");
    const snippet =
      idx >= 0
        ? full.slice(Math.max(0, idx - 40), idx + 120).trim()
        : full.slice(0, 140).trim();
    hits.push({ title: m.title, snippet, score });
  }

  hits.sort((a, b) => b.score - a.score);
  if (hits.length === 0) {
    return "I couldn't find relevant mentions across your saved meetings. Try different keywords.";
  }

  const top = hits.slice(0, 3);
  const lines = top.map((h) => `**${h.title}**: …${h.snippet}…`);
  return `Across ${hits.length} meeting${hits.length === 1 ? "" : "s"}, here's what I found:\n\n${lines.join("\n\n")}`;
}
