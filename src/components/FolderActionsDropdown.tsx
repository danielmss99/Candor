import { useEffect, useRef, useState } from "react";
import { promptCreateFolder } from "../utils/folderActions";

interface FolderActionsDropdownProps {
  /** Parent for “New subfolder”; defaults to inbox when omitted. */
  selectedFolderId?: string;
  onCreated?: (folderId: string | null) => void;
  /** Compact icon-only trigger (sidebar). */
  compact?: boolean;
  className?: string;
}

export function FolderActionsDropdown({
  selectedFolderId = "inbox",
  onCreated,
  compact = false,
  className = "",
}: FolderActionsDropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = async (fn: () => Promise<string | null>) => {
    setOpen(false);
    const id = await fn();
    onCreated?.(id);
  };

  return (
    <div className={`folder-actions-dropdown ${className}`} ref={wrapRef}>
      <button
        type="button"
        className={compact ? "folder-actions-trigger folder-actions-trigger--compact" : "folder-actions-trigger"}
        aria-label="Folder actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        +
      </button>
      {open && (
        <div className="folder-actions-menu" role="menu">
          <button
            type="button"
            className="folder-actions-item"
            role="menuitem"
            onClick={() => run(() => promptCreateFolder(null))}
          >
            New folder
          </button>
          <button
            type="button"
            className="folder-actions-item"
            role="menuitem"
            onClick={() => run(() => promptCreateFolder(selectedFolderId))}
          >
            New subfolder
          </button>
        </div>
      )}
    </div>
  );
}
