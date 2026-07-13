import { EmptyState } from "../../components/EmptyState";
import { asObject, asString, formatDuration, type LibraryFilter, type LocalJsonValue, type RecordingSummary } from "../../core/contracts";

interface LibraryViewProps {
  recordings: RecordingSummary[];
  filteredRecordings: RecordingSummary[];
  recordingTotalCount: number;
  recordingsHaveMore: boolean;
  searchQuery: string;
  searchMatches: LocalJsonValue[];
  libraryFilter: LibraryFilter;
  busy: boolean;
  recordingBlocked: boolean;
  onSearchQueryChange: (value: string) => void;
  onSearch: () => void;
  onFilterChange: (filter: LibraryFilter) => void;
  onOpenRecording: (recordingId: string) => void;
  onStartRecording: () => void;
  onLoadMore: () => void;
}

export function LibraryView({
  recordings,
  filteredRecordings,
  recordingTotalCount,
  recordingsHaveMore,
  searchQuery,
  searchMatches,
  libraryFilter,
  busy,
  recordingBlocked,
  onSearchQueryChange,
  onSearch,
  onFilterChange,
  onOpenRecording,
  onStartRecording,
  onLoadMore,
}: LibraryViewProps) {
  return (
    <section className="page-view" data-view="library">
      <header className="screen-heading"><h1>Meetings</h1><p>Search and organize conversations stored on this computer.</p></header>
      <div className="library-toolbar">
        <div className="search-control"><input value={searchQuery} onChange={(event) => onSearchQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSearch(); }} placeholder="Search transcripts and notes" aria-label="Search local meetings" /><button type="button" onClick={onSearch} disabled={!searchQuery.trim() || busy}>Search</button></div>
        <div className="filter-control" role="group" aria-label="Meeting filter">
          {(["all", "transcribed", "audio"] as LibraryFilter[]).map((filter) => <button type="button" key={filter} aria-pressed={libraryFilter === filter} onClick={() => onFilterChange(filter)}>{filter === "all" ? "All" : filter === "transcribed" ? "Transcribed" : "Has audio"}</button>)}
        </div>
      </div>
      {searchMatches.length ? <div className="search-results" aria-label="Search results">{searchMatches.slice(0, 8).map((match, index) => { const object = asObject(match); return <button type="button" key={`${asString(object.recordingId)}-${index}`} onClick={() => onOpenRecording(asString(object.recordingId))}><strong>{asString(object.label, "Meeting match")}</strong><span>{asString(object.snippet, asString(object.text, "Local match"))}</span></button>; })}</div> : null}
      <div className="library-list">
        <div className="library-count">Showing {filteredRecordings.length} of {recordingTotalCount} local recordings</div>
        {filteredRecordings.map((recording) => (
          <button type="button" className="library-row" key={recording.recordingId} onClick={() => onOpenRecording(recording.recordingId)}>
            <span><strong>{recording.label}</strong><small>{recording.transcriptSegmentCount} transcript segments</small></span>
            <span><small>{formatDuration(recording.audioDurationMs)}</small><em>{recording.state}</em></span>
          </button>
        ))}
        {!filteredRecordings.length ? <EmptyState title={recordings.length ? "No meetings match" : "No meetings yet"} description={recordings.length ? "Change the filter or search term to see other local meetings." : "Start a meeting and Candor will keep its audio, transcript, and notes on this computer."} actionLabel={recordings.length || recordingBlocked ? undefined : "Start a meeting"} onAction={recordings.length || recordingBlocked ? undefined : onStartRecording} /> : null}
        {recordingsHaveMore ? <button type="button" className="load-more-button" onClick={onLoadMore} disabled={busy}>Load more meetings</button> : null}
      </div>
    </section>
  );
}
