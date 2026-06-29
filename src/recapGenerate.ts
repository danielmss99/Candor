import type { TranscriptSegment } from "./App";
import type { RecapData } from "./data/mock";

export interface RecordingContext {
  transcript: TranscriptSegment[];
  sessionNotes: string;
  durationSeconds: number;
  recordedAt: Date;
  userInitials: string;
  /** When set, use the saved meeting title instead of auto-generating one. */
  titleOverride?: string;
}

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "have", "been", "were", "they", "what", "when",
  "your", "about", "would", "there", "their", "which", "could", "should", "into",
  "just", "like", "some", "than", "then", "them", "these", "those", "very", "also",
  "will", "going", "really", "think", "know", "need", "want", "yeah", "okay",
]);

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDuration(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  return `${m} min`;
}

function dueDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function sentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()) ?? (text.trim() ? [text.trim()] : []);
}

function titleFromRecording(ctx: RecordingContext): string {
  const first = ctx.transcript[0]?.text?.trim();
  if (first) {
    const sentence = sentences(first)[0] ?? first;
    const words = sentence.split(/\s+/).slice(0, 6).join(" ");
    const cleaned = words.replace(/[.!?,;:]+$/, "").trim();
    if (cleaned.length >= 12) {
      return cleaned.length > 52 ? `${cleaned.slice(0, 49)}…` : cleaned;
    }
  }
  const noteLine = ctx.sessionNotes.split("\n").map((l) => l.trim()).find(Boolean);
  if (noteLine) {
    return noteLine.length > 52 ? `${noteLine.slice(0, 49)}…` : noteLine;
  }
  return `Recording · ${formatDate(ctx.recordedAt)}`;
}

function topTerms(text: string, count: number): string[] {
  const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [];
  const freq = new Map<string, number>();
  for (const w of words) {
    if (!STOP_WORDS.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([w]) => w);
}

function boldTopTerms(text: string, terms: string[]): string {
  let out = text;
  for (const term of terms.slice(0, 3)) {
    out = out.replace(new RegExp(`\\b(${term})\\b`, "gi"), "**$1**");
  }
  return out;
}

function buildSummary(ctx: RecordingContext): string {
  const full = ctx.transcript.map((s) => s.text).join(" ").trim();
  const notes = ctx.sessionNotes.trim();

  if (!full && notes) {
    const preview = notes.split("\n").filter(Boolean).slice(0, 2).join("; ");
    return boldTopTerms(
      `This session was captured primarily through your notes. Key points: **${preview.slice(0, 200)}**`,
      topTerms(notes, 3),
    );
  }

  if (!full) {
    return "No speech was detected in this recording. Add notes during your next session to capture context.";
  }

  const sents = sentences(full);
  const picks: string[] = [];
  if (sents.length === 1) {
    picks.push(sents[0]);
  } else if (sents.length === 2) {
    picks.push(sents[0], sents[1]);
  } else {
    picks.push(sents[0], sents[Math.floor(sents.length / 2)], sents[sents.length - 1]);
  }

  let summary = [...new Set(picks)].join(" ").slice(0, 480);
  if (notes) {
    const notePreview = notes.split("\n").filter(Boolean).slice(0, 2).join("; ");
    summary += ` Your notes add: ${notePreview.slice(0, 160)}${notePreview.length > 160 ? "…" : ""}.`;
  }

  return boldTopTerms(summary, topTerms(full, 5));
}

function extractDecisions(ctx: RecordingContext): string[] {
  const pattern =
    /\b(agreed|decided|decision|consensus|approved|confirmed|we'll|we will|going to|plan is|moving forward)\b/i;
  const found: string[] = [];

  for (const seg of ctx.transcript) {
    if (!pattern.test(seg.text)) continue;
    const s = seg.text.trim();
    const normalized = s.charAt(0).toUpperCase() + s.slice(1);
    if (!found.some((d) => d.toLowerCase() === normalized.toLowerCase())) {
      found.push(normalized.endsWith(".") ? normalized : `${normalized}.`);
    }
  }

  for (const line of ctx.sessionNotes.split("\n")) {
    const t = line.replace(/^[-*•]\s*/, "").trim();
    if (t && /\b(decide|decision|agreed|approved)\b/i.test(t)) {
      const normalized = t.charAt(0).toUpperCase() + t.slice(1);
      if (!found.some((d) => d.toLowerCase() === normalized.toLowerCase())) {
        found.push(normalized.endsWith(".") ? normalized : `${normalized}.`);
      }
    }
  }

  return found.slice(0, 5);
}

function extractActions(ctx: RecordingContext): RecapData["actions"] {
  const pattern =
    /\b(need to|needs to|should|must|have to|action item|follow up|follow-up|todo|task is|make sure|don't forget)\b/i;
  const found: RecapData["actions"] = [];
  const seen = new Set<string>();

  const add = (text: string, soon = false) => {
    const t = text.trim().replace(/^[-*•]\s*/, "");
    if (t.length < 8 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    found.push({
      text: t.charAt(0).toUpperCase() + t.slice(1),
      owner: ctx.userInitials,
      due: dueDate(soon ? 2 : 5),
      soon,
    });
  };

  for (const seg of ctx.transcript) {
    if (pattern.test(seg.text)) add(seg.text, /\b(today|tomorrow|asap|urgent|this week)\b/i.test(seg.text));
  }

  for (const line of ctx.sessionNotes.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (/^[-*•]/.test(t) || pattern.test(t)) {
      add(t.replace(/^[-*•]\s*/, ""), /\b(today|tomorrow|asap|urgent)\b/i.test(t));
    }
  }

  return found.slice(0, 8);
}

function chapterLabel(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 5).join(" ");
  return words.length > 36 ? `${words.slice(0, 33)}…` : words || "Section";
}

function buildChapters(ctx: RecordingContext): RecapData["chapters"] {
  const segs = ctx.transcript;
  if (segs.length === 0) {
    return [{ label: "Session start", time: "00:00" }];
  }

  const bucketCount = Math.min(4, Math.max(1, Math.ceil(segs.length / 3)));
  const size = Math.ceil(segs.length / bucketCount);
  const chapters: RecapData["chapters"] = [];

  for (let i = 0; i < bucketCount; i++) {
    const slice = segs.slice(i * size, (i + 1) * size);
    if (slice.length === 0) continue;
    chapters.push({
      time: slice[0].time,
      label: chapterLabel(slice[0].text),
    });
  }

  return chapters;
}

function pickHighlight(ctx: RecordingContext): RecapData["highlight"] {
  if (ctx.transcript.length === 0) {
    const note = ctx.sessionNotes.split("\n").map((l) => l.trim()).find(Boolean);
    return {
      quote: note ?? "No highlight captured for this session.",
      by: `You · ${ctx.userInitials}`,
    };
  }

  const best = ctx.transcript.reduce((a, b) => (b.text.length > a.text.length ? b : a));
  return {
    quote: best.text.trim(),
    by: `Transcript · ${best.time}`,
  };
}

/** Build a meeting recap tailored to a specific recording. */
export function generateRecapFromRecording(ctx: RecordingContext): RecapData {
  const dateLabel = formatDate(ctx.recordedAt);
  const duration = formatDuration(ctx.durationSeconds);

  const title = ctx.titleOverride?.trim() || titleFromRecording(ctx);

  return {
    title,
    meta: `${dateLabel} · ${duration} · 1 speaker`,
    summary: buildSummary(ctx),
    decisions: extractDecisions(ctx),
    actions: extractActions(ctx),
    chapters: buildChapters(ctx),
    suggestions: ["Summarize for Slack", "Draft follow-up email"],
    highlight: pickHighlight(ctx),
  };
}
