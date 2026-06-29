import type { TranscriptSegment } from "./App";
import type { RecapAction, RecapData, SummaryBullet, SummarySection } from "./data/mock";
import { SUMMARY_TEMPLATES, type SummaryTemplateId } from "./v2/summaryTemplates";

export interface RecordingContext {
  transcript: TranscriptSegment[];
  sessionNotes: string;
  durationSeconds: number;
  recordedAt: Date;
  userInitials: string;
  /** When set, use the saved meeting title instead of auto-generating one. */
  titleOverride?: string;
  template?: SummaryTemplateId;
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

function formatDateTime(d: Date): string {
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

function capitalize(s: string): string {
  const t = s.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function titleFromRecording(ctx: RecordingContext): string {
  if (ctx.titleOverride?.trim()) {
    return `Meeting @ ${formatDateTime(ctx.recordedAt)}`;
  }
  const first = ctx.transcript[0]?.text?.trim();
  if (first) {
    const sentence = sentences(first)[0] ?? first;
    const words = sentence.split(/\s+/).slice(0, 6).join(" ");
    const cleaned = words.replace(/[.!?,;:]+$/, "").trim();
    if (cleaned.length >= 12) {
      return `Meeting @ ${formatDateTime(ctx.recordedAt)}`;
    }
  }
  return `Meeting @ ${formatDateTime(ctx.recordedAt)}`;
}

function subtitleFromRecording(ctx: RecordingContext): string {
  if (ctx.titleOverride?.trim()) return ctx.titleOverride.trim();
  const first = ctx.transcript[0]?.text?.trim();
  if (first) {
    const sentence = sentences(first)[0] ?? first;
    const cleaned = sentence.replace(/[.!?,;:]+$/, "").trim();
    if (cleaned.length >= 12) {
      return cleaned.length > 90 ? `${cleaned.slice(0, 87)}…` : cleaned;
    }
  }
  const noteLine = ctx.sessionNotes.split("\n").map((l) => l.trim()).find(Boolean);
  if (noteLine) {
    return noteLine.length > 90 ? `${noteLine.slice(0, 87)}…` : noteLine;
  }
  return "Meeting notes";
}

function buildSummary(ctx: RecordingContext): string {
  const full = ctx.transcript.map((s) => s.text).join(" ").trim();
  const notes = ctx.sessionNotes.trim();
  const template = ctx.template ?? "general";

  let base = buildBaseSummary(full, notes);

  switch (template) {
    case "standup":
      base = `**Standup recap.** ${base}`;
      break;
    case "one_on_one":
      base = `**1:1 notes.** ${base}`;
      break;
    case "sales":
      base = `**Sales call.** ${base}`;
      break;
    case "retro":
      base = `**Retro.** ${base}`;
      break;
    case "client_call":
      base = `**Client call.** ${base}`;
      break;
    default:
      break;
  }

  return base;
}

function buildBaseSummary(full: string, notes: string): string {
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

function segmentToBullet(seg: TranscriptSegment, terms: string[]): SummaryBullet {
  const text = capitalize(seg.text.trim());
  const normalized = text.endsWith(".") ? text : `${text}.`;
  return { text: boldTopTerms(normalized, terms) };
}

function splitIntoBuckets(segs: TranscriptSegment[], count: number): TranscriptSegment[][] {
  if (segs.length === 0) return Array.from({ length: count }, () => []);
  const size = Math.ceil(segs.length / count);
  return Array.from({ length: count }, (_, i) => segs.slice(i * size, (i + 1) * size));
}

function segmentsToBullets(segs: TranscriptSegment[], max = 4): SummaryBullet[] {
  if (segs.length === 0) return [];
  const fullText = segs.map((s) => s.text).join(" ");
  const terms = topTerms(fullText, 5);
  const picks: TranscriptSegment[] = [];
  if (segs.length <= max) {
    picks.push(...segs);
  } else {
    const step = Math.floor(segs.length / max);
    for (let i = 0; i < max; i++) {
      picks.push(segs[Math.min(i * step, segs.length - 1)]);
    }
  }
  return picks.map((s) => segmentToBullet(s, terms));
}

function buildSections(ctx: RecordingContext): SummarySection[] {
  const template = ctx.template ?? "general";
  const templateDef = SUMMARY_TEMPLATES.find((t) => t.id === template) ?? SUMMARY_TEMPLATES[0];
  const sections: SummarySection[] = [];
  const full = ctx.transcript.map((s) => s.text).join(" ").trim();
  const terms = topTerms(full, 6);

  // Overview from opening + middle content
  const overviewBullets: SummaryBullet[] = [];
  if (full) {
    const sents = sentences(full);
    if (sents[0]) overviewBullets.push({ text: boldTopTerms(capitalize(sents[0]), terms) });
    if (sents.length > 2) {
      overviewBullets.push({ text: boldTopTerms(capitalize(sents[Math.floor(sents.length / 2)]), terms) });
    }
  } else if (ctx.sessionNotes.trim()) {
    ctx.sessionNotes
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3)
      .forEach((line) => {
        overviewBullets.push({ text: boldTopTerms(capitalize(line), terms) });
      });
  }
  if (overviewBullets.length > 0) {
    sections.push({ heading: "Overview", bullets: overviewBullets });
  }

  // Template-driven content sections
  const buckets = splitIntoBuckets(ctx.transcript, templateDef.sections.length);
  templateDef.sections.forEach((heading, i) => {
    const bullets = segmentsToBullets(buckets[i] ?? [], 3);
    if (bullets.length > 0) {
      sections.push({ heading, bullets });
    }
  });

  const decisions = extractDecisions(ctx);
  if (decisions.length > 0) {
    sections.push({
      heading: "Key decisions",
      bullets: decisions.map((d) => ({ text: d })),
    });
  }

  // Questions / open items from notes
  const questions = ctx.sessionNotes
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("? Question:") || /\?$/.test(l));
  if (questions.length > 0) {
    sections.push({
      heading: "Open questions",
      bullets: questions.map((q) => ({
        text: q.replace(/^\? Question:\s*/, ""),
      })),
    });
  }

  return sections;
}

function speakerCount(ctx: RecordingContext): number {
  const speakers = new Set(
    ctx.transcript.map((s) => s.speaker).filter((s): s is string => Boolean(s)),
  );
  return Math.max(1, speakers.size || (ctx.transcript.length > 0 ? 1 : 1));
}

function extractDecisions(ctx: RecordingContext): string[] {
  const pattern =
    /\b(agreed|decided|decision|consensus|approved|confirmed|we'll|we will|going to|plan is|moving forward)\b/i;
  const found: string[] = [];

  for (const seg of ctx.transcript) {
    if (!pattern.test(seg.text)) continue;
    const s = seg.text.trim();
    const normalized = capitalize(s);
    if (!found.some((d) => d.toLowerCase() === normalized.toLowerCase())) {
      found.push(normalized.endsWith(".") ? normalized : `${normalized}.`);
    }
  }

  for (const line of ctx.sessionNotes.split("\n")) {
    const t = line.replace(/^[-*•]\s*/, "").trim();
    if (t && (/\b(decide|decision|agreed|approved)\b/i.test(t) || t.startsWith("✓ Decision:"))) {
      const cleaned = t.replace(/^✓ Decision:\s*/, "");
      const normalized = capitalize(cleaned);
      if (!found.some((d) => d.toLowerCase() === normalized.toLowerCase())) {
        found.push(normalized.endsWith(".") ? normalized : `${normalized}.`);
      }
    }
  }

  return found.slice(0, 5);
}

function extractActions(ctx: RecordingContext): RecapAction[] {
  const pattern =
    /\b(need to|needs to|should|must|have to|action item|follow up|follow-up|todo|task is|make sure|don't forget)\b/i;
  const found: RecapAction[] = [];
  const seen = new Set<string>();

  const add = (text: string, sourceSegmentIndex?: number, soon = false) => {
    const t = text.trim().replace(/^[-*•→]\s*/, "").replace(/^→ Action:\s*/, "");
    if (t.length < 8 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    found.push({
      text: capitalize(t),
      owner: ctx.userInitials,
      due: dueDate(soon ? 2 : 5),
      soon,
      sourceSegmentIndex,
    });
  };

  ctx.transcript.forEach((seg, i) => {
    if (pattern.test(seg.text)) add(seg.text, i, /\b(today|tomorrow|asap|urgent|this week)\b/i.test(seg.text));
  });

  for (const line of ctx.sessionNotes.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("→ Action:") || /^[-*•]/.test(t) || pattern.test(t)) {
      add(t.replace(/^→ Action:\s*/, ""), undefined, /\b(today|tomorrow|asap|urgent)\b/i.test(t));
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

/** Build a placeholder recap while transcription is in progress. */
export function placeholderRecap(ctx: Partial<RecordingContext> & { titleOverride?: string }): RecapData {
  const recordedAt = ctx.recordedAt ?? new Date();
  const title = ctx.titleOverride?.trim()
    ? `Meeting @ ${formatDateTime(recordedAt)}`
    : `Meeting @ ${formatDateTime(recordedAt)}`;
  return {
    title,
    subtitle: ctx.titleOverride?.trim() ?? "Generating summary…",
    meta: `${formatDate(recordedAt)} · ${formatDuration(ctx.durationSeconds ?? 0)}`,
    summary: "",
    sections: [],
    decisions: [],
    actions: [],
    chapters: [],
    suggestions: [],
    highlight: { quote: "", by: "" },
  };
}

/** Build a meeting recap tailored to a specific recording. */
export function generateRecapFromRecording(ctx: RecordingContext): RecapData {
  const dateLabel = formatDate(ctx.recordedAt);
  const duration = formatDuration(ctx.durationSeconds);

  return {
    title: titleFromRecording(ctx),
    subtitle: subtitleFromRecording(ctx),
    meta: `${dateLabel} · ${duration} · ${speakerCount(ctx)} speaker${speakerCount(ctx) === 1 ? "" : "s"}`,
    summary: buildSummary(ctx),
    sections: buildSections(ctx),
    decisions: extractDecisions(ctx),
    actions: extractActions(ctx),
    chapters: buildChapters(ctx),
    suggestions: ["Summarize for Slack", "Draft follow-up email"],
    highlight: pickHighlight(ctx),
  };
}

/** Map segment indices cited by actions to 1-based citation numbers. */
export function buildCitationMap(actions: RecapAction[]): Map<number, number> {
  const map = new Map<number, number>();
  let n = 1;
  for (const a of actions) {
    if (a.sourceSegmentIndex != null && !map.has(a.sourceSegmentIndex)) {
      map.set(a.sourceSegmentIndex, n++);
    }
  }
  return map;
}
