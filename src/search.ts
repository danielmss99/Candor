import {
  actionItems,
  meetings,
  people,
  recap as q3Recap,
  searchResults,
  type SearchResult,
} from "./data/mock";

export type SearchScope = "Transcript" | "Summary" | "Tasks";
export type DateFilter = "Any date" | "Today" | "Yesterday" | "This week";
export type PersonFilter = "Anyone" | keyof typeof people;

export interface SearchFilters {
  person: PersonFilter;
  date: DateFilter;
  scope: SearchScope;
}

export interface SavedSearchEntry {
  id: string;
  title: string;
  when: string;
  blurb: string;
}

export const PERSON_FILTERS: PersonFilter[] = ["Anyone", "MC", "DP", "SL", "RK", "JO"];
export const DATE_FILTERS: DateFilter[] = ["Any date", "Today", "Yesterday", "This week"];
export const SCOPE_FILTERS: SearchScope[] = ["Transcript", "Summary", "Tasks"];

function matchesDate(when: string, filter: DateFilter): boolean {
  if (filter === "Any date") return true;
  if (filter === "Today") return when.startsWith("Today");
  if (filter === "Yesterday") return when.startsWith("Yesterday");
  if (filter === "This week") {
    return when.startsWith("Today") || when.startsWith("Yesterday") || when.startsWith("Mon");
  }
  return true;
}

function highlight(text: string, query: string): { t: string; mark?: boolean }[] {
  const q = query.trim();
  if (!q) return [{ t: text }];
  const lower = text.toLowerCase();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
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

function transcriptResults(query: string, filters: SearchFilters): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return searchResults.filter((r) => {
    if (filters.person !== "Anyone" && r.speaker !== filters.person) return false;
    if (!matchesDate(r.when, filters.date)) return false;
    const full = r.segments.map((s) => s.t).join("").toLowerCase();
    return full.includes(q);
  }).map((r) => {
    const fullText = r.segments.map((s) => s.t).join("");
    const q = query.trim().toLowerCase();
    const idx = fullText.toLowerCase().indexOf(q.split(/\s+/)[0] ?? q);
    const contextBefore = idx > 20 ? fullText.slice(Math.max(0, idx - 40), idx).trim() : undefined;
    const contextAfter =
      idx >= 0 ? fullText.slice(idx + q.length, idx + q.length + 40).trim() : undefined;
    return {
      ...r,
      segments: highlight(`"${fullText}"`, query),
      contextBefore,
      contextAfter,
    };
  });
}

function summaryResults(
  query: string,
  filters: SearchFilters,
  savedMeetings: SavedSearchEntry[],
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const summaries = [
    { meeting: q3Recap.title, when: "Today", text: q3Recap.summary.replace(/\*\*/g, "") },
    ...meetings
      .filter((m) => m.id !== "q3-roadmap")
      .map((m) => ({ meeting: m.title, when: m.when.split(" · ")[0], text: m.blurb })),
    ...savedMeetings.map((m) => ({
      meeting: m.title,
      when: m.when.split(" · ")[0] || m.when,
      text: m.blurb,
    })),
  ];

  return summaries
    .filter((s) => {
      if (!matchesDate(s.when, filters.date)) return false;
      return s.text.toLowerCase().includes(q) || s.meeting.toLowerCase().includes(q);
    })
    .map((s) => ({
      meeting: s.meeting,
      when: s.when,
      jump: "00:00",
      speaker: "MC" as const,
      segments: highlight(s.text, query),
    }));
}

function actionItemResults(query: string, filters: SearchFilters): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return actionItems
    .filter((a) => {
      if (filters.person !== "Anyone" && a.owner !== filters.person) return false;
      const when = meetings.find((m) => m.title === a.meeting)?.when.split(" · ")[0] ?? "Today";
      if (!matchesDate(when, filters.date)) return false;
      return a.text.toLowerCase().includes(q) || a.meeting.toLowerCase().includes(q);
    })
    .map((a) => {
      const when = meetings.find((m) => m.title === a.meeting)?.when.split(" · ")[0] ?? "Today";
      return {
        meeting: a.meeting,
        when,
        jump: "00:00",
        speaker: a.owner,
        segments: highlight(a.text, query),
      };
    });
}

export function runSearch(
  query: string,
  filters: SearchFilters,
  savedMeetings: SavedSearchEntry[] = [],
): { results: SearchResult[]; meta: string } {
  const q = query.trim();
  if (!q) {
    return { results: [], meta: "Enter a search term" };
  }

  let results: SearchResult[];
  switch (filters.scope) {
    case "Summary":
      results = summaryResults(q, filters, savedMeetings);
      break;
    case "Tasks":
      results = actionItemResults(q, filters);
      break;
    default:
      results = transcriptResults(q, filters);
  }

  const meetingCount = new Set(results.map((r) => r.meeting)).size;
  const meta =
    results.length === 0
      ? "No results"
      : `${results.length} result${results.length === 1 ? "" : "s"} across ${meetingCount} meeting${meetingCount === 1 ? "" : "s"}`;

  return { results, meta };
}

/** Map a search result meeting title back to a library meeting id. */
export function meetingIdForTitle(title: string, savedMeetings: SavedSearchEntry[] = []): string {
  const saved = savedMeetings.find((m) => m.title === title);
  if (saved) return saved.id;
  return meetings.find((m) => m.title === title)?.id ?? "q3-roadmap";
}
