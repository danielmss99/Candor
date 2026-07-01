import type { SavedMeeting } from "../api/local";
import type { ContextMenuState } from "../meetingEdit";
import { meetingContextHandler } from "./ContextMenu";

export interface FilesExplorerListProps {
  meetings: SavedMeeting[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onContextMenu: (x: number, y: number, target: ContextMenuState["target"]) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}

function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base || path;
}

function formatModifiedDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fileTypeLabel(meeting: SavedMeeting): string {
  const ext = meeting.path.split(".").pop()?.toLowerCase();
  if (ext === "md") return "Transcript";
  if (ext === "wav" || ext === "mp3" || ext === "m4a") return "Meeting recording";
  return "Meeting file";
}

function TranscriptIcon() {
  return (
    <svg className="files-explorer-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 1.5A1.5 1.5 0 0 1 4.5 0h5.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 1 .439 1.06V12.5A1.5 1.5 0 0 1 12.5 14h-8A1.5 1.5 0 0 1 3 12.5v-11Z"
      />
      <path fill="var(--bg-sidebar)" d="M10.5 0v3.5H14" />
      <rect fill="var(--bg-sidebar)" x="5" y="6" width="6" height="1" rx="0.5" />
      <rect fill="var(--bg-sidebar)" x="5" y="8.5" width="6" height="1" rx="0.5" />
      <rect fill="var(--bg-sidebar)" x="5" y="11" width="4" height="1" rx="0.5" />
    </svg>
  );
}

function RecordingIcon() {
  return (
    <svg className="files-explorer-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 1.5a3 3 0 0 1 3 3v3a3 3 0 0 1-6 0v-3a3 3 0 0 1 3-3Z"
      />
      <path
        fill="currentColor"
        d="M4.5 7.5a3.5 3.5 0 0 0 7 0h1a4.5 4.5 0 0 1-4 4.435V14h-1v-1.565A4.5 4.5 0 0 1 3.5 7.5h1Z"
      />
    </svg>
  );
}

function FileIcon({ meeting }: { meeting: SavedMeeting }) {
  const type = fileTypeLabel(meeting);
  if (type === "Meeting recording") return <RecordingIcon />;
  return <TranscriptIcon />;
}

export function FilesExplorerList({
  meetings,
  selectedId,
  loading,
  onSelect,
  onOpen,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: FilesExplorerListProps) {
  if (loading) {
    return <div className="files-explorer-empty">Loading…</div>;
  }

  if (meetings.length === 0) {
    return (
      <div className="files-explorer-empty">
        <span className="files-explorer-empty-title">This folder is empty.</span>
        <span className="files-explorer-empty-sub">
          Record a meeting or drag files here from another folder.
        </span>
      </div>
    );
  }

  return (
    <div className="files-explorer-body" role="grid" aria-label="Files">
      <div className="files-explorer-columns files-explorer-columns--header" role="row">
        <span className="files-explorer-col files-explorer-col--name" role="columnheader">
          Name
        </span>
        <span className="files-explorer-col files-explorer-col--date" role="columnheader">
          Date modified
        </span>
        <span className="files-explorer-col files-explorer-col--type" role="columnheader">
          Type
        </span>
        <span className="files-explorer-col files-explorer-col--size" role="columnheader">
          Size
        </span>
      </div>

      <div className="files-explorer-rows" role="rowgroup">
        {meetings.map((m) => {
          const name = fileNameFromPath(m.path) || `${m.title}.md`;
          const type = fileTypeLabel(m);
          return (
            <button
              key={m.id}
              type="button"
              role="row"
              className={`files-explorer-row${selectedId === m.id ? " files-explorer-row--selected" : ""}`}
              draggable
              onDragStart={() => onDragStart(m.id)}
              onDragEnd={onDragEnd}
              onClick={() => onSelect(m.id)}
              onDoubleClick={() => onOpen(m.id)}
              onContextMenu={(e) =>
                meetingContextHandler(e, (x, y) =>
                  onContextMenu(x, y, { kind: "saved", meeting: m }),
                )
              }
            >
              <span className="files-explorer-col files-explorer-col--name" role="gridcell">
                <FileIcon meeting={m} />
                <span className="files-explorer-name" title={name}>
                  {name}
                </span>
              </span>
              <span className="files-explorer-col files-explorer-col--date" role="gridcell">
                {formatModifiedDate(m.date)}
              </span>
              <span className="files-explorer-col files-explorer-col--type" role="gridcell">
                {type}
              </span>
              <span className="files-explorer-col files-explorer-col--size" role="gridcell">
                —
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
