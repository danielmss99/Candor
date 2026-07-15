import { AudioLines, ChevronRight, FileText, Search } from "lucide-react";
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
      <header className="screen-heading"><div><h1>Meetings</h1><p>Search transcripts, notes, and recordings.</p></div></header>
      <div className="library-toolbar">
        <div className="search-control"><Search size={16} aria-hidden="true" /><input value={searchQuery} onChange={(event) => onSearchQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSearch(); }} placeholder="Search transcripts and notes" aria-label="Search meetings" /><button className="icon-button" type="button" onClick={onSearch} disabled={!searchQuery.trim() || busy} aria-label="Search" title="Search"><Search size={16} aria-hidden="true" /></button></div>
        <div className="filter-control" role="group" aria-label="Meeting filter">
          {(["all", "transcribed", "audio"] as LibraryFilter[]).map((filter) => <button type="button" key={filter} aria-pressed={libraryFilter === filter} onClick={() => onFilterChange(filter)}>{filter === "all" ? "All" : filter === "transcribed" ? "Transcribed" : "Has audio"}</button>)}
        </div>
      </div>
      {searchMatches.length ? <div className="search-results" aria-label="Search results"><header>Matches</header>{searchMatches.slice(0, 8).map((match, index) => { const object = asObject(match); return <button type="button" key={`${asString(object.recordingId)}-${index}`} onClick={() => onOpenRecording(asString(object.recordingId))}><Search size={15} aria-hidden="true" /><span><strong>{asString(object.label, "Meeting match")}</strong><small>{asString(object.snippet, asString(object.text, "Meeting match"))}</small></span><ChevronRight size={15} aria-hidden="true" /></button>; })}</div> : null}
      <div className="library-list">
        <div className="library-count">{filteredRecordings.length} of {recordingTotalCount} meetings</div>
        {filteredRecordings.map((recording) => (
          <button type="button" className="library-row" key={recording.recordingId} onClick={() => onOpenRecording(recording.recordingId)}>
            <span className="library-row-icon">{recording.audioChunkCount ? <AudioLines size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}</span>
            <span className="library-row-copy"><strong>{recording.label}</strong><small>{recording.transcriptSegmentCount ? `${recording.transcriptSegmentCount} transcript segments` : "Transcript not created"}</small></span>
            <span className="library-row-meta"><small>{formatDuration(recording.audioDurationMs)}</small><em>{recording.state}</em><ChevronRight size={15} aria-hidden="true" /></span>
          </button>
        ))}
        {!filteredRecordings.length ? <EmptyState title={recordings.length ? "No meetings match" : "No meetings yet"} description={recordings.length ? "Change the filter or search term to see other local meetings." : "Start a meeting and Candor will keep its audio, transcript, and notes on this computer."} actionLabel={recordings.length || recordingBlocked ? undefined : "Start a meeting"} onAction={recordings.length || recordingBlocked ? undefined : onStartRecording} /> : null}
        {recordingsHaveMore ? <button type="button" className="load-more-button" onClick={onLoadMore} disabled={busy}>Load more meetings</button> : null}
      </div>
    </section>
  );
}
