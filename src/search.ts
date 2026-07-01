import {
  actionItems,
  meetings,
  people,
  recap as q3Recap,
  searchResults,
  type SearchResult,
} from "./data/mock";
import type { TranscriptSegment } from "./App";

export type SearchScope = "All" | "Transcript" | "Summary" | "Notes" | "Tasks";
export type DateFilter = "Any date" | "Today" | "Yesterday" | "This week";
export type PersonFilter = "Anyone" | keyof typeof people;

export interface SearchFilters {
  person: PersonFilter;
  date: DateFilter;
  scope: SearchScope;
}

export interface SearchableMeeting {
  id: string;
  title: string;
  when: string;
  blurb: string;
  transcript: TranscriptSegment[];
  notes: string;
}

export const PERSON_FILTERS: PersonFilter[] = ["Anyone", "MC", "DP", "SL", "RK", "JO"];
export const DATE_FILTERS: DateFilter[] = ["Any date", "Today", "Yesterday", "This week"];
export const SCOPE_FILTERS: SearchScope[] = ["All", "Transcript", "Summary", "Notes", "Tasks"];

function matchesDate(when: string, filter: DateFilter): boolean {
  if (filter === "Any date") return true;
  if (filter === "Today") return when.startsWith("Today");
  if (filter === "Yesterday") return when.startsWith("Yesterday");
  if (filter === "This week") {
    return when.startsWith("Today") || when.startsWith("Yesterday") || when.startsWith("Mon");
  }
  return true;
}

function queryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function textMatchesQuery(text: string, query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return false;
  const lower = text.toLowerCase();
  return terms.every((t) => lower.includes(t));
}

function highlight(text: string, query: string): { t: string; mark?: boolean }[] {
  const q = query.trim();
  if (!q) return [{ t: text }];
  const lower = text.toLowerCase();
  const terms = queryTerms(q);
  if (terms.length === 0) return [{ t: text }];

  const segments: { t: string; mark?: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    let hit: { start: number; end: number } | null = null;
    for (const term of terms) {
      const idx = lower.indexOf(term, i);
      if (idx !== -1 && (hit === null || idx < hit.start)) {
        hit = { start: idx, end: idx + term.length };
      }
    }
    if (!hit) {
      segments.push({ t: text.slice(i) });
      break;
    }
    if (hit.start > i) segments.push({ t: text.slice(i, hit.start) });
    segments.push({ t: text.slice(hit.start, hit.end), mark: true });
    i = hit.end;
  }
  return segments;
}

function resultKey(r: SearchResult): string {
  return `${r.meeting}|${r.jump}|${r.segments.map((s) => s.t).join("")}`;
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const k = resultKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function mockSpeakerKey(speaker?: string): keyof typeof people {
  if (speaker && speaker in people) return speaker as keyof typeof people;
  return "MC";
}

function transcriptResults(
  query: string,
  filters: SearchFilters,
  searchable: SearchableMeeting[],
): SearchResult[] {
  const q = query.trim();
  if (!q) return [];

  const mockHits = searchResults.filter((r) => {
    if (filters.person !== "Anyone" && r.speaker !== filters.person) return false;
    if (!matchesDate(r.when, filters.date)) return false;
    const full = r.segments.map((s) => s.t).join("");
    return textMatchesQuery(full, q);
  });

  const savedHits: SearchResult[] = [];
  for (const m of searchable) {
    if (!matchesDate(m.when, filters.date)) continue;
    for (const seg of m.transcript) {
      if (!textMatchesQuery(seg.text, q)) continue;
      if (filters.person !== "Anyone") {
        const sp = seg.speaker ?? "";
        const personName = people[filters.person]?.name ?? "";
        if (sp !== filters.person && sp !== personName && !sp.includes(personName.split(" ")[0])) {
          continue;
        }
      }
      const idx = seg.text.toLowerCase().indexOf(queryTerms(q)[0] ?? q.toLowerCase());
      savedHits.push({
        meeting: m.title,
        when: m.when.split(" · ")[0] || m.when,
        jump: seg.time || "00:00",
        speaker: mockSpeakerKey(seg.speaker),
        speakerLabel: seg.speaker,
        segments: highlight(seg.text, q),
        contextBefore: idx > 20 ? seg.text.slice(Math.max(0, idx - 40), idx).trim() : undefined,
        contextAfter:
          idx >= 0
            ? seg.text.slice(idx + q.length, idx + q.length + 40).trim()
            : undefined,
      });
    }
    if (textMatchesQuery(m.title, q)) {
      savedHits.push({
        meeting: m.title,
        when: m.when.split(" · ")[0] || m.when,
        jump: "00:00",
        speaker: "MC",
        segments: highlight(m.title, q),
      });
    }
  }

  return dedupeResults([
    ...mockHits.map((r) => {
      const fullText = r.segments.map((s) => s.t).join("");
      const idx = fullText.toLowerCase().indexOf(queryTerms(q)[0] ?? q.toLowerCase());
      return {
        ...r,
        segments: highlight(fullText.replace(/^"|"$/g, ""), q),
        contextBefore: idx > 20 ? fullText.slice(Math.max(0, idx - 40), idx).trim() : undefined,
        contextAfter:
          idx >= 0 ? fullText.slice(idx + q.length, idx + q.length + 40).trim() : undefined,
      };
    }),
    ...savedHits,
  ]);
}

function summaryResults(
  query: string,
  filters: SearchFilters,
  searchable: SearchableMeeting[],
): SearchResult[] {
  const q = query.trim();
  if (!q) return [];

  const summaries = [
    { meeting: q3Recap.title, when: "Today", text: q3Recap.summary.replace(/\*\*/g, "") },
    ...meetings
      .filter((m) => m.id !== "q3-roadmap")
      .map((m) => ({ meeting: m.title, when: m.when.split(" · ")[0], text: m.blurb })),
    ...searchable.map((m) => ({
      meeting: m.title,
      when: m.when.split(" · ")[0] || m.when,
      text: m.blurb,
    })),
  ];

  return summaries
    .filter((s) => {
      if (!matchesDate(s.when, filters.date)) return false;
      return textMatchesQuery(s.text, q) || textMatchesQuery(s.meeting, q);
    })
    .map((s) => ({
      meeting: s.meeting,
      when: s.when,
      jump: "00:00",
      speaker: "MC" as const,
      segments: highlight(s.text, q),
    }));
}

function notesResults(
  query: string,
  filters: SearchFilters,
  searchable: SearchableMeeting[],
): SearchResult[] {
  const q = query.trim();
  if (!q) return [];

  return searchable
    .filter((m) => {
      if (!matchesDate(m.when, filters.date)) return false;
      return m.notes.trim().length > 0 && textMatchesQuery(m.notes, q);
    })
    .map((m) => ({
      meeting: m.title,
      when: m.when.split(" · ")[0] || m.when,
      jump: "00:00",
      speaker: "MC" as const,
      segments: highlight(m.notes, q),
    }));
}

function actionItemResults(query: string, filters: SearchFilters): SearchResult[] {
  const q = query.trim();
  if (!q) return [];

  return actionItems
    .filter((a) => {
      if (filters.person !== "Anyone" && a.owner !== filters.person) return false;
      const when = meetings.find((m) => m.title === a.meeting)?.when.split(" · ")[0] ?? "Today";
      if (!matchesDate(when, filters.date)) return false;
      return textMatchesQuery(a.text, q) || textMatchesQuery(a.meeting, q);
    })
    .map((a) => {
      const when = meetings.find((m) => m.title === a.meeting)?.when.split(" · ")[0] ?? "Today";
      return {
        meeting: a.meeting,
        when,
        jump: "00:00",
        speaker: a.owner,
        segments: highlight(a.text, q),
      };
    });
}

export function runSearch(
  query: string,
  filters: SearchFilters,
  searchable: SearchableMeeting[] = [],
): { results: SearchResult[]; meta: string } {
  const q = query.trim();
  if (!q) {
    return { results: [], meta: "Enter a search term" };
  }

  let results: SearchResult[];
  switch (filters.scope) {
    case "Summary":
      results = summaryResults(q, filters, searchable);
      break;
    case "Notes":
      results = notesResults(q, filters, searchable);
      break;
    case "Tasks":
      results = actionItemResults(q, filters);
      break;
    case "All":
      results = dedupeResults([
        ...transcriptResults(q, filters, searchable),
        ...summaryResults(q, filters, searchable),
        ...notesResults(q, filters, searchable),
        ...actionItemResults(q, filters),
      ]);
      break;
    default:
      results = transcriptResults(q, filters, searchable);
  }

  const meetingCount = new Set(results.map((r) => r.meeting)).size;
  const meta =
    results.length === 0
      ? "No results"
      : `${results.length} result${results.length === 1 ? "" : "s"} across ${meetingCount} meeting${meetingCount === 1 ? "" : "s"}`;

  return { results, meta };
}

/** Map a search result meeting title back to a library meeting id. */
export function meetingIdForTitle(title: string, searchable: SearchableMeeting[] = []): string {
  const saved = searchable.find((m) => m.title === title);
  if (saved) return saved.id;
  return meetings.find((m) => m.title === title)?.id ?? "q3-roadmap";
}
