import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FolderTreeNode, SavedMeeting } from "../api/local";
import { deleteOrgFolder, moveOrgFolder, renameOrgFolder } from "../api/local";
import {
  confirmDeleteFolder,
  createFolderForEdit,
  emptyFolder,
  flattenFolderTree,
  folderDescendantIds,
  isDefaultNewFolderName,
} from "../utils/folderActions";
import { ContextMenu } from "./ContextMenu";

export interface EditingFolderState {
  id: string;
  isNew: boolean;
}

interface FolderTreeProps {
  tree: FolderTreeNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: () => void;
  meetings?: SavedMeeting[];
  itemCounts?: Record<string, number>;
  editingFolder?: EditingFolderState | null;
  onEditingFolderChange?: (state: EditingFolderState | null) => void;
  expandFolderId?: string | null;
  onExpandFolderIdConsumed?: () => void;
}

interface CtxState {
  x: number;
  y: number;
  folder: FolderTreeNode;
}

function FolderNameInput({
  initialName,
  onCommit,
  onCancel,
}: {
  initialName: string;
  onCommit: (name: string) => void;
  onCancel: (currentValue: string) => void;
}) {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const finish = (commit: boolean) => {
    if (committedRef.current) return;
    committedRef.current = true;
    if (commit) {
      const trimmed = value.trim();
      if (!trimmed || trimmed === initialName) {
        onCancel(value);
        return;
      }
      onCommit(trimmed);
      return;
    }
    onCancel(value);
  };

  return (
    <input
      ref={inputRef}
      className="folder-tree-rename-input"
      value={value}
      aria-label="Folder name"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

function FolderRow({
  node,
  depth,
  selectedId,
  expanded,
  itemCounts,
  editingFolder,
  onToggle,
  onSelect,
  onContextMenu,
  onCommitRename,
  onCancelEdit,
  onStartRename,
}: {
  node: FolderTreeNode;
  depth: number;
  selectedId: string | null;
  expanded: Set<string>;
  itemCounts: Record<string, number>;
  editingFolder?: EditingFolderState | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FolderTreeNode) => void;
  onCommitRename: (folderId: string, name: string) => void;
  onCancelEdit: (folderId: string, currentValue: string, initialName: string, isNew: boolean) => void;
  onStartRename: (folderId: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.id);
  const isSelected = selectedId === node.id;
  const isInbox = node.id === "inbox";
  const count = itemCounts[node.id] ?? 0;
  const isEditing = editingFolder?.id === node.id;
  const isNew = isEditing && editingFolder?.isNew === true;

  return (
    <>
      <div
        className={`folder-tree-row ${isSelected ? "folder-tree-row--selected" : ""}`}
        style={{ paddingLeft: `${8 + depth * 18}px` }}
        onClick={() => {
          if (!isEditing) onSelect(node.id);
        }}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <button
          type="button"
          className={`folder-tree-chevron ${hasChildren || isOpen ? "" : "folder-tree-chevron--spacer"}`}
          aria-label={isOpen ? "Collapse folder" : "Expand folder"}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren || isOpen) onToggle(node.id);
          }}
        >
          {hasChildren || isOpen ? (isOpen ? "▾" : "▸") : ""}
        </button>
        <span className={`folder-tree-icon ${isOpen && hasChildren ? "folder-tree-icon--open" : ""}`} aria-hidden>
          {isOpen && hasChildren ? "📂" : "📁"}
        </span>
        {isEditing ? (
          <FolderNameInput
            initialName={node.name}
            onCommit={(name) => onCommitRename(node.id, name)}
            onCancel={(currentValue) => onCancelEdit(node.id, currentValue, node.name, isNew)}
          />
        ) : (
          <span
            className="folder-tree-label"
            onDoubleClick={(e) => {
              if (isInbox) return;
              e.stopPropagation();
              onStartRename(node.id);
            }}
          >
            {node.name}
          </span>
        )}
        {count > 0 && <span className="folder-tree-count">{count}</span>}
      </div>
      {(hasChildren && isOpen) &&
        node.children.map((child) => (
          <FolderRow
            key={child.id}
            node={child}
            depth={depth + 1}
            selectedId={selectedId}
            expanded={expanded}
            itemCounts={itemCounts}
            editingFolder={editingFolder}
            onToggle={onToggle}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            onCommitRename={onCommitRename}
            onCancelEdit={onCancelEdit}
            onStartRename={onStartRename}
          />
        ))}
      {isInbox && isSelected && (
        <div className="folder-tree-hint" style={{ paddingLeft: `${26 + depth * 18}px` }}>
          Default folder for new recordings
        </div>
      )}
    </>
  );
}

export function FolderTree({
  tree,
  selectedId,
  onSelect,
  onChange,
  meetings = [],
  itemCounts = {},
  editingFolder = null,
  onEditingFolderChange,
  expandFolderId = null,
  onExpandFolderIdConsumed,
}: FolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["inbox"]));
  const [ctx, setCtx] = useState<CtxState | null>(null);

  const flatFolders = useMemo(() => flattenFolderTree(tree), [tree]);
  const folderNames = useMemo(() => flatFolders.map((f) => f.name), [flatFolders]);

  useEffect(() => {
    if (!expandFolderId) return;
    setExpanded((prev) => new Set(prev).add(expandFolderId));
    onExpandFolderIdConsumed?.();
  }, [expandFolderId, onExpandFolderIdConsumed]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandParent = useCallback((parentId: string) => {
    setExpanded((prev) => new Set(prev).add(parentId));
  }, []);

  const startEditing = useCallback(
    (id: string, isNew: boolean) => {
      onEditingFolderChange?.({ id, isNew });
      onSelect(id);
    },
    [onEditingFolderChange, onSelect],
  );

  const handleNewSubfolder = useCallback(
    async (parentId: string) => {
      const id = await createFolderForEdit(parentId, folderNames);
      if (id) {
        expandParent(parentId);
        startEditing(id, true);
        onChange();
      }
    },
    [expandParent, folderNames, onChange, startEditing],
  );

  const handleCommitRename = useCallback(
    async (folderId: string, name: string) => {
      onEditingFolderChange?.(null);
      try {
        await renameOrgFolder(folderId, name);
        onChange();
      } catch (e) {
        window.alert(String(e));
        startEditing(folderId, false);
      }
    },
    [onChange, onEditingFolderChange, startEditing],
  );

  const handleCancelEdit = useCallback(
    async (folderId: string, currentValue: string, initialName: string, isNew: boolean) => {
      onEditingFolderChange?.(null);
      const trimmed = currentValue.trim();
      const shouldDelete =
        isNew &&
        isDefaultNewFolderName(initialName) &&
        (!trimmed || trimmed === initialName);
      if (shouldDelete) {
        try {
          await deleteOrgFolder(folderId);
          if (selectedId === folderId) onSelect("inbox");
          onChange();
        } catch (e) {
          window.alert(String(e));
        }
      }
    },
    [onChange, onEditingFolderChange, onSelect, selectedId],
  );

  const handleStartRename = useCallback(
    (folderId: string) => {
      startEditing(folderId, false);
    },
    [startEditing],
  );

  const handleContextMenu = (e: React.MouseEvent, folder: FolderTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY, folder });
  };

  const moveTargets = useMemo(() => {
    if (!ctx) return [];
    const blocked = folderDescendantIds(tree, ctx.folder.id);
    return flatFolders.filter((f) => f.id !== ctx.folder.id && !blocked.has(f.id));
  }, [ctx, flatFolders, tree]);

  const ctxItems = useMemo(() => {
    if (!ctx) return [];
    const folder = ctx.folder;
    const parentId = folder.parentId ?? "inbox";
    const directCount = itemCounts[folder.id] ?? 0;
    const items = [
      {
        id: "new",
        label: "Create new subfolder",
        onClick: () => handleNewSubfolder(folder.id),
      },
      {
        id: "rename",
        label: "Rename",
        disabled: folder.id === "inbox",
        onClick: () => {
          setCtx(null);
          handleStartRename(folder.id);
        },
      },
      { id: "sep1", label: "", separator: true },
      ...moveTargets.map((t) => ({
        id: `move-${t.id}`,
        label: `Move to ${t.name}`,
        disabled: folder.id === "inbox",
        onClick: async () => {
          try {
            await moveOrgFolder(folder.id, t.id);
            onChange();
          } catch (e) {
            window.alert(String(e));
          }
        },
      })),
      { id: "sep2", label: "", separator: true },
      {
        id: "empty",
        label: "Empty folder",
        disabled: folder.id === "inbox" || directCount === 0,
        onClick: async () => {
          if (await emptyFolder(folder.id, meetings, parentId)) onChange();
        },
      },
      {
        id: "delete",
        label: "Delete",
        danger: true,
        disabled: folder.id === "inbox",
        onClick: async () => {
          if (await confirmDeleteFolder(folder)) {
            if (selectedId === folder.id) onSelect("inbox");
            onChange();
          }
        },
      },
    ];
    if (moveTargets.length === 0) {
      return items.filter((i) => i.id !== "sep1" && !i.id.startsWith("move-"));
    }
    return items;
  }, [
    ctx,
    handleNewSubfolder,
    handleStartRename,
    itemCounts,
    meetings,
    moveTargets,
    onChange,
    onSelect,
    selectedId,
  ]);

  return (
    <div className="folder-tree">
      <div className="folder-tree-body">
        {tree.map((node) => (
          <FolderRow
            key={node.id}
            node={node}
            depth={0}
            selectedId={selectedId}
            expanded={expanded}
            itemCounts={itemCounts}
            editingFolder={editingFolder}
            onToggle={toggle}
            onSelect={onSelect}
            onContextMenu={handleContextMenu}
            onCommitRename={handleCommitRename}
            onCancelEdit={handleCancelEdit}
            onStartRename={handleStartRename}
          />
        ))}
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={ctxItems}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}
