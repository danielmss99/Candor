import { useCallback, useState } from "react";
import type { FolderTreeNode } from "../api/local";
import { createOrgFolder, deleteOrgFolder, renameOrgFolder } from "../api/local";
import { ContextMenu } from "./ContextMenu";

interface FolderTreeProps {
  tree: FolderTreeNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: () => void;
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
  onToggle,
  onSelect,
  onContextMenu,
  onNewSubfolder,
}: {
  node: FolderTreeNode;
  depth: number;
  selectedId: string | null;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FolderTreeNode) => void;
  onNewSubfolder: (parentId: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.id);
  const isSelected = selectedId === node.id;
  const isInbox = node.id === "inbox";

  return (
    <>
      <div
        className={`folder-tree-row ${isSelected ? "folder-tree-row--selected" : ""}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => onSelect(node.id)}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <button
          type="button"
          className={`folder-tree-chevron ${hasChildren ? "" : "folder-tree-chevron--spacer"}`}
          aria-label={isOpen ? "Collapse folder" : "Expand folder"}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
        >
          {hasChildren ? (isOpen ? "▾" : "▸") : ""}
        </button>
        <span className="folder-tree-icon" aria-hidden>
          📁
        </span>
        <span className="folder-tree-label">{node.name}</span>
        <button
          type="button"
          className="folder-tree-add"
          title="New subfolder"
          onClick={(e) => {
            e.stopPropagation();
            onNewSubfolder(node.id);
          }}
        >
          +
        </button>
      </div>
      {hasChildren && isOpen &&
        node.children.map((child) => (
          <FolderRow
            key={child.id}
            node={child}
            depth={depth + 1}
            selectedId={selectedId}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            onNewSubfolder={onNewSubfolder}
          />
        ))}
      {isInbox && isSelected && (
        <div className="folder-tree-hint" style={{ paddingLeft: `${28 + depth * 16}px` }}>
          Default folder for new recordings
        </div>
      )}
    </>
  );
}

export function FolderTree({ tree, selectedId, onSelect, onChange }: FolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["inbox"]));
  const [ctx, setCtx] = useState<CtxState | null>(null);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const promptNewFolder = useCallback(
    async (parentId?: string) => {
      const name = window.prompt("Folder name");
      if (!name?.trim()) return;
      try {
        await createOrgFolder(name.trim(), parentId ?? null);
        if (parentId) {
          setExpanded((prev) => new Set(prev).add(parentId));
        }
        onChange();
      } catch (e) {
        window.alert(String(e));
      }
    },
    [onChange],
  );

  const handleContextMenu = (e: React.MouseEvent, folder: FolderTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY, folder });
  };

  return (
    <div className="folder-tree">
      <div className="folder-tree-head">
        <span className="folder-tree-title">Folders</span>
        <button type="button" className="btn-ghost-sm" onClick={() => promptNewFolder(selectedId ?? undefined)}>
          + New folder
        </button>
      </div>

      <div className="folder-tree-body">
        {tree.map((node) => (
          <FolderRow
            key={node.id}
            node={node}
            depth={0}
            selectedId={selectedId}
            expanded={expanded}
            onToggle={toggle}
            onSelect={onSelect}
            onContextMenu={handleContextMenu}
            onNewSubfolder={promptNewFolder}
          />
        ))}
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={[
            {
              id: "new",
              label: "New subfolder…",
              onClick: () => promptNewFolder(ctx.folder.id),
            },
            {
              id: "rename",
              label: "Rename…",
              disabled: ctx.folder.id === "inbox",
              onClick: async () => {
                const name = window.prompt("Rename folder", ctx.folder.name);
                if (!name?.trim() || name.trim() === ctx.folder.name) return;
                try {
                  await renameOrgFolder(ctx.folder.id, name.trim());
                  onChange();
                } catch (e) {
                  window.alert(String(e));
                }
              },
            },
            {
              id: "delete",
              label: "Delete folder",
              danger: true,
              disabled: ctx.folder.id === "inbox",
              onClick: async () => {
                if (
                  !window.confirm(
                    `Delete “${ctx.folder.name}”? Meetings move to the parent folder.`,
                  )
                ) {
                  return;
                }
                try {
                  await deleteOrgFolder(ctx.folder.id);
                  if (selectedId === ctx.folder.id) onSelect("inbox");
                  onChange();
                } catch (e) {
                  window.alert(String(e));
                }
              },
            },
          ]}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}
