import { useEffect, useMemo, useRef, useState } from "react";
import type { SidebarFolderProps, View } from "../App";
import { Avatar } from "../components/Avatar";
import { Sidebar } from "../components/Sidebar";
import { loadMeetingDetail, loadSavedMeetings } from "../api/local";
import { people } from "../data/mock";
import {
  DATE_FILTERS,
  PERSON_FILTERS,
  SCOPE_FILTERS,
  meetingIdForTitle,
  runSearch,
  type DateFilter,
  type PersonFilter,
  type SearchableMeeting,
  type SearchScope,
} from "../search";
import { loadRecentSearches, pushRecentSearch } from "../v2/metadata";
import { answerCrossMeeting } from "../v2/crossAsk";
import { pushCrossAsk } from "../v2/metadata";

interface SearchProps {
  onNavigate: (view: View) => void;
  query: string;
  onQueryChange: (query: string) => void;
  onJump: (meetingId: string, timestamp: string) => void;
  meetingsRefreshKey: number;
  sidebarFolder: SidebarFolderProps;
  embedded?: boolean;
}

function cycleFilter<T extends string>(options: T[], current: T): T {
  const i = options.indexOf(current);
  return options[(i + 1) % options.length];
}

function speakerAvatar(who: keyof typeof people, label?: string) {
  if (label && !(label in people)) {
    const initials = label
      .split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
    return <Avatar label={initials || "?"} size={24} />;
  }
  return <Avatar who={who} size={24} />;
}

export function Search({ onNavigate, query, onQueryChange, onJump, meetingsRefreshKey, sidebarFolder, embedded }: SearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [person, setPerson] = useState<PersonFilter>("Anyone");
  const [date, setDate] = useState<DateFilter>("Any date");
  const [scope, setScope] = useState<SearchScope>("All");
  const [searchIndex, setSearchIndex] = useState<SearchableMeeting[]>([]);
  const [indexLoading, setIndexLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => loadRecentSearches());
  const [crossAskQ, setCrossAskQ] = useState("");
  const [crossAskA, setCrossAskA] = useState<string | null>(null);
  const [crossLoading, setCrossLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIndexLoading(true);
    (async () => {
      const rows = await loadSavedMeetings();
      const enriched = await Promise.all(
        rows.map(async (m) => {
          const detail = await loadMeetingDetail(m.id);
          return {
            id: m.id,
            title: m.title,
            when: m.whenLabel,
            blurb: m.blurb,
            transcript: detail?.transcript ?? [],
            notes: detail?.userNotes ?? "",
          };
        }),
      );
      if (!cancelled) {
        setSearchIndex(enriched);
        setIndexLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meetingsRefreshKey]);

  useEffect(() => {
    if (query.trim()) {
      setRecent(pushRecentSearch(query));
    }
    setSelectedIdx(-1);
  }, [query]);

  const { results, meta } = useMemo(
    () => runSearch(query, { person, date, scope }, searchIndex),
    [query, person, date, scope, searchIndex],
  );

  useEffect(() => {
    setSelectedIdx(-1);
  }, [person, date, scope]);

  const personLabel = person === "Anyone" ? "Anyone ▾" : `${people[person].name.split(" ")[0]} ▾`;
  const dateLabel = date === "Any date" ? "Any date ▾" : `${date} ▾`;

  const jumpResult = (idx: number) => {
    const r = results[idx];
    if (!r) return;
    onJump(meetingIdForTitle(r.meeting, searchIndex), r.jump);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && selectedIdx >= 0) {
      e.preventDefault();
      jumpResult(selectedIdx);
    }
  };

  useEffect(() => {
    if (selectedIdx < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-result-idx="${selectedIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const submitCrossAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = crossAskQ.trim();
    if (!q) return;
    setCrossLoading(true);
    const meetings = await loadSavedMeetings();
    const answer = await answerCrossMeeting(q, meetings);
    setCrossAskA(answer);
    pushCrossAsk(q, answer);
    setCrossLoading(false);
  };

  const main = (
      <div className="main main--scroll">
        <div className="search-bar">
          <span className="search-bar-icon">⌕</span>
          <input
            ref={inputRef}
            className="search-bar-input"
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search transcripts, summaries, notes, tasks…"
            aria-label="Search"
          />
          {query.length > 0 && (
            <button
              type="button"
              className="search-clear"
              onClick={() => onQueryChange("")}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        {recent.length > 0 && !query && (
          <div className="recent-searches">
            <span className="section-label section-label--calm">Recent</span>
            {recent.map((r) => (
              <button
                key={r}
                type="button"
                className="recent-search-chip"
                onClick={() => onQueryChange(r)}
              >
                {r}
              </button>
            ))}
          </div>
        )}

        <div className="search-meta-row">
          <span className="search-count">
            {indexLoading && query.trim() ? "Indexing meetings…" : meta}
          </span>
          <div className="spacer" />
          <button
            type="button"
            className="chip"
            onClick={() => setPerson((p) => cycleFilter(PERSON_FILTERS, p))}
          >
            {personLabel}
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => setDate((d) => cycleFilter(DATE_FILTERS, d))}
          >
            {dateLabel}
          </button>
          <button
            type="button"
            className="chip chip--active"
            onClick={() => setScope((s) => cycleFilter(SCOPE_FILTERS, s))}
          >
            {scope}
          </button>
        </div>

        <div className="result-list" ref={listRef}>
          {results.map((r, i) => (
            <div
              key={i}
              data-result-idx={i}
              className={`result-card${selectedIdx === i ? " result-card--selected" : ""}`}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              <div className="result-head">
                <span className="result-meeting">{r.meeting}</span>
                <span className="result-when">{r.when}</span>
                <div className="spacer" />
                <button
                  className="jump-link"
                  onClick={() => jumpResult(i)}
                >
                  Jump to {r.jump} →
                </button>
              </div>
              <div className="result-body">
                {speakerAvatar(r.speaker, r.speakerLabel)}
                <div className="result-quote">
                  {r.contextBefore && (
                    <span className="result-context">…{r.contextBefore} </span>
                  )}
                  {r.segments.map((s, j) =>
                    s.mark ? (
                      <mark key={j} className="mark">
                        {s.t}
                      </mark>
                    ) : (
                      <span key={j}>{s.t}</span>
                    ),
                  )}
                  {r.contextAfter && <span className="result-context"> {r.contextAfter}…</span>}
                </div>
              </div>
            </div>
          ))}
          {query.trim() && !indexLoading && results.length === 0 && (
            <div className="search-empty">No matches for "{query.trim()}".</div>
          )}
        </div>

        <div className="cross-ask-card">
          <span className="section-label section-label--calm">Ask across meetings</span>
          <form onSubmit={submitCrossAsk}>
            <input
              className="ask-input-field"
              style={{ width: "100%", marginTop: 8 }}
              placeholder="What did we decide about pricing across Q2 meetings?"
              value={crossAskQ}
              onChange={(e) => setCrossAskQ(e.target.value)}
              aria-label="Cross-meeting question"
            />
          </form>
          {crossLoading && <div className="ask-answer">Searching…</div>}
          {crossAskA && <div className="cross-ask-answer">{crossAskA}</div>}
        </div>
      </div>
  );

  if (embedded) return main;
  return (
    <div className="screen screen--sidebar">
      <Sidebar active="Search" onNavigate={onNavigate} {...sidebarFolder} />
      {main}
    </div>
  );
}
