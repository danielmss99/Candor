import { useEffect, useMemo, useRef, useState } from "react";
import type { View } from "../App";

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  group: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: View) => void;
  onStartRecording: () => void;
  onSearch: (query: string) => void;
  meetingTitles: { id: string; title: string }[];
  onOpenMeeting: (id: string) => void;
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onStartRecording,
  onSearch,
  meetingTitles,
  onOpenMeeting,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) {
      setQuery("");
      window.setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const items = useMemo<PaletteItem[]>(() => {
    const nav: PaletteItem[] = [
      { id: "nav-home", label: "Go to Home", group: "Navigate", action: () => onNavigate("home") },
      { id: "nav-lib", label: "Go to Meetings", group: "Navigate", action: () => onNavigate("library") },
      { id: "nav-tasks", label: "Go to Tasks", group: "Navigate", action: () => onNavigate("actions") },
      { id: "nav-search", label: "Go to Search", group: "Navigate", action: () => onNavigate("search") },
      { id: "nav-people", label: "Go to People", group: "Navigate", action: () => onNavigate("people") },
      { id: "rec", label: "Start recording", group: "Actions", action: onStartRecording },
      ...meetingTitles.slice(0, 12).map((m) => ({
        id: `meet-${m.id}`,
        label: m.title,
        hint: "Open recap",
        group: "Meetings",
        action: () => onOpenMeeting(m.id),
      })),
    ];
    const q = query.trim().toLowerCase();
    if (!q) return nav;
    return nav.filter(
      (i) => i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q),
    );
  }, [query, onNavigate, onStartRecording, meetingTitles, onOpenMeeting]);

  const groups = useMemo(() => {
    const map = new Map<string, PaletteItem[]>();
    for (const item of items) {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    }
    return [...map.entries()];
  }, [items]);

  if (!open) return null;

  const run = (item: PaletteItem) => {
    item.action();
    onClose();
  };

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q) {
      onSearch(q);
      onClose();
    }
  };

  return (
    <div className="modal-backdrop palette-backdrop" onClick={onClose} role="presentation">
      <div className="command-palette" onClick={(e) => e.stopPropagation()} role="dialog">
        <form onSubmit={submitSearch}>
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="Search meetings, jump to screen, start recording…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Command palette"
          />
        </form>
        <div className="palette-results">
          {groups.length === 0 ? (
            <div className="palette-empty">No matches</div>
          ) : (
            groups.map(([group, rows]) => (
              <div key={group} className="palette-group">
                <div className="palette-group-label">{group}</div>
                {rows.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="palette-item"
                    onClick={() => run(item)}
                  >
                    <span>{item.label}</span>
                    {item.hint && <span className="palette-hint">{item.hint}</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
