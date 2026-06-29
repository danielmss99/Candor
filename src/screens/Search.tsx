import { useEffect, useMemo, useRef, useState } from "react";
import type { View } from "../App";
import { Avatar } from "../components/Avatar";
import { Sidebar } from "../components/Sidebar";
import { loadSavedMeetings } from "../api/local";
import { people } from "../data/mock";
import {
  DATE_FILTERS,
  PERSON_FILTERS,
  SCOPE_FILTERS,
  meetingIdForTitle,
  runSearch,
  type DateFilter,
  type PersonFilter,
  type SavedSearchEntry,
  type SearchScope,
} from "../search";

interface SearchProps {
  onNavigate: (view: View) => void;
  query: string;
  onQueryChange: (query: string) => void;
  onJump: (meetingId: string, timestamp: string) => void;
  meetingsRefreshKey: number;
}

function cycleFilter<T extends string>(options: T[], current: T): T {
  const i = options.indexOf(current);
  return options[(i + 1) % options.length];
}

export function Search({ onNavigate, query, onQueryChange, onJump, meetingsRefreshKey }: SearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [person, setPerson] = useState<PersonFilter>("Anyone");
  const [date, setDate] = useState<DateFilter>("Any date");
  const [scope, setScope] = useState<SearchScope>("Transcript");
  const [savedMeetings, setSavedMeetings] = useState<SavedSearchEntry[]>([]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    loadSavedMeetings().then((rows) =>
      setSavedMeetings(
        rows.map((m) => ({
          id: m.id,
          title: m.title,
          when: m.whenLabel,
          blurb: m.blurb,
        })),
      ),
    );
  }, [meetingsRefreshKey]);

  const { results, meta } = useMemo(
    () => runSearch(query, { person, date, scope }, savedMeetings),
    [query, person, date, scope, savedMeetings],
  );

  const personLabel = person === "Anyone" ? "Anyone ▾" : `${people[person].name.split(" ")[0]} ▾`;
  const dateLabel = date === "Any date" ? "Any date ▾" : `${date} ▾`;

  return (
    <div className="screen screen--sidebar">
      <Sidebar active="Search" onNavigate={onNavigate} />

      <div className="main">
        <div className="search-bar">
          <span className="search-bar-icon">⌕</span>
          <input
            ref={inputRef}
            className="search-bar-input"
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search transcripts, summaries, tasks…"
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

        <div className="search-meta-row">
          <span className="search-count">{meta}</span>
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

        <div className="result-list">
          {results.map((r, i) => (
            <div key={i} className="result-card">
              <div className="result-head">
                <span className="result-meeting">{r.meeting}</span>
                <span className="result-when">{r.when}</span>
                <div className="spacer" />
                <button
                  className="jump-link"
                  onClick={() => onJump(meetingIdForTitle(r.meeting, savedMeetings), r.jump)}
                >
                  Jump to {r.jump} →
                </button>
              </div>
              <div className="result-body">
                <Avatar who={r.speaker} size={24} />
                <div className="result-quote">
                  {r.segments.map((s, j) =>
                    s.mark ? (
                      <mark key={j} className="mark">
                        {s.t}
                      </mark>
                    ) : (
                      <span key={j}>{s.t}</span>
                    ),
                  )}
                </div>
              </div>
            </div>
          ))}
          {query.trim() && results.length === 0 && (
            <div className="search-empty">No matches for “{query.trim()}”.</div>
          )}
        </div>
      </div>
    </div>
  );
}
