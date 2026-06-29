import { useCallback, useMemo, useState } from "react";
import type { FolderTreeNode, SavedMeeting } from "../api/local";
import { moveOrgFolder } from "../api/local";
import {
  confirmDeleteFolder,
  emptyFolder,
  flattenFolderTree,
  folderDescendantIds,
  promptCreateFolder,
  promptRenameFolder,
} from "../utils/folderActions";
import { ContextMenu } from "./ContextMenu";

interface FolderTreeProps {
  tree: FolderTreeNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: () => void;
  meetings?: SavedMeeting[];
  itemCounts?: Record<string, number>;
}

interface CtxState {
  x: number;
  y: number;
  folder: FolderTreeNode;
}

function FolderRow({
  node,
  depth,
  selectedId,
  expanded,
  itemCounts,
  onToggle,
  onSelect,
  onContextMenu,
}: {
  node: FolderTreeNode;
  depth: number;
  selectedId: string | null;
  expanded: Set<string>;
  itemCounts: Record<string, number>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FolderTreeNode) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.id);
  const isSelected = selectedId === node.id;
  const isInbox = node.id === "inbox";
  const count = itemCounts[node.id] ?? 0;

  return (
    <>
      <div
        className={`folder-tree-row ${isSelected ? "folder-tree-row--selected" : ""}`}
        style={{ paddingLeft: `${8 + depth * 18}px` }}
        onClick={() => onSelect(node.id)}
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
        <span className="folder-tree-label">{node.name}</span>
        {count > 0 && <span className="folder-tree-count">{count}</span>}
      </div>
      {hasChildren && isOpen &&
        node.children.map((child) => (
          <FolderRow
            key={child.id}
            node={child}
            depth={depth + 1}
            selectedId={selectedId}
            expanded={expanded}
            itemCounts={itemCounts}
            onToggle={onToggle}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
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
}: FolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["inbox"]));
  const [ctx, setCtx] = useState<CtxState | null>(null);

  const flatFolders = useMemo(() => flattenFolderTree(tree), [tree]);

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

  const handleNewSubfolder = useCallback(
    async (parentId: string) => {
      const id = await promptCreateFolder(parentId);
      if (id) {
        expandParent(parentId);
        onChange();
      }
    },
    [expandParent, onChange],
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
        onClick: async () => {
          if (await promptRenameFolder(folder)) onChange();
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
  }, [ctx, handleNewSubfolder, itemCounts, meetings, moveTargets, onChange, onSelect, selectedId]);

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
            onToggle={toggle}
            onSelect={onSelect}
            onContextMenu={handleContextMenu}
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
