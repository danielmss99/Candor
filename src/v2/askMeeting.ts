import type { TranscriptSegment } from "../App";
import type { RecapData } from "../data/mock";

export interface AskCitation {
  time: string;
  text: string;
  speaker?: string;
}

export interface AskResult {
  answer: string;
  citations: AskCitation[];
  /** Scaffold hook for future local LLM (llama.cpp) — set when model path configured. */
  usedLlm: boolean;
}

function parseTime(time: string): number {
  const parts = time.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function scoreSegment(seg: TranscriptSegment, terms: string[]): number {
  const lower = seg.text.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (lower.includes(t)) score += t.length > 4 ? 2 : 1;
  }
  return score;
}

/** Local heuristic Ask with timestamp citations (scaffold for future on-device LLM). */
export function askMeeting(
  recap: RecapData,
  transcript: TranscriptSegment[],
  question: string,
): AskResult {
  const q = question.trim().toLowerCase();
  if (!q) {
    return { answer: "Ask a question about this meeting.", citations: [], usedLlm: false };
  }

  const llmPath = localStorage.getItem("candor-v2.localLlmPath");
  if (llmPath) {
    // Scaffold: wire to Tauri llama.cpp command when model is configured.
    return {
      answer: `Local LLM configured at ${llmPath} — full inference not yet wired. Using heuristic search below.`,
      citations: [],
      usedLlm: false,
    };
  }

  if (q.includes("slack") || q.includes("summarize for slack")) {
    return {
      answer: `*${recap.title}*\n${recap.summary.replace(/\*\*/g, "*")}\n\nDecisions: ${recap.decisions.map((d) => `• ${d}`).join(" ") || "none"}`,
      citations: [],
      usedLlm: false,
    };
  }

  if (q.includes("email") || q.includes("follow-up") || q.includes("follow up")) {
    return {
      answer: `Subject: Follow-up — ${recap.title}\n\nThanks for today's discussion. ${recap.summary.replace(/\*\*/g, "")}\n\nNext steps:\n${recap.actions.map((a) => `• ${a.text} (${a.owner})`).join("\n") || "None captured."}`,
      citations: [],
      usedLlm: false,
    };
  }

  const terms = q.split(/\s+/).filter((w) => w.length > 2);
  const ranked = transcript
    .map((seg, i) => ({ seg, i, score: scoreSegment(seg, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (ranked.length === 0) {
    if (q.includes("decision")) {
      return {
        answer: recap.decisions.length
          ? recap.decisions.join(" ")
          : "No formal decisions were logged.",
        citations: [],
        usedLlm: false,
      };
    }
    if (q.includes("action") || q.includes("task")) {
      return {
        answer: recap.actions.length
          ? recap.actions.map((a) => `${a.text} (${a.owner})`).join("\n")
          : "No action items captured.",
        citations: [],
        usedLlm: false,
      };
    }
    return {
      answer: `I couldn't find relevant moments for "${question.trim()}". Try keywords from the transcript or ask about decisions and tasks.`,
      citations: [],
      usedLlm: false,
    };
  }

  const citations: AskCitation[] = ranked.map((r) => ({
    time: r.seg.time,
    text: r.seg.text,
    speaker: r.seg.speaker,
  }));

  const lines = citations.map((c) => `[${c.time}] ${c.speaker ? `${c.speaker}: ` : ""}${c.text}`);
  return {
    answer: `Found ${ranked.length} relevant moment${ranked.length === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}`,
    citations,
    usedLlm: false,
  };
}

export function seekSecondsForCitation(c: AskCitation): number {
  return parseTime(c.time);
}
