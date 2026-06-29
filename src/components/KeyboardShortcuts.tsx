interface KeyboardShortcutsProps {
  onClose: () => void;
}

const SHORTCUTS = [
  { keys: "?", desc: "Show keyboard shortcuts" },
  { keys: "⌘ K", desc: "Command palette" },
  { keys: "⌘ ⇧ B", desc: "Drop bookmark (while recording)" },
  { keys: "Esc", desc: "Close overlays / cancel pre-roll" },
  { keys: "/", desc: "Focus search (from Meetings)" },
];

export function KeyboardShortcuts({ onClose }: KeyboardShortcutsProps) {
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="shortcuts-modal"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-head">
          <h2 className="shortcuts-title">Keyboard shortcuts</h2>
          <button type="button" className="search-clear" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <ul className="shortcuts-list">
          {SHORTCUTS.map((s) => (
            <li key={s.keys} className="shortcuts-row">
              <kbd className="shortcuts-kbd">{s.keys}</kbd>
              <span>{s.desc}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
