import { useCallback, useEffect, useMemo, useState } from "react";
import type { View } from "../App";
import { Sidebar } from "../components/Sidebar";
import { FolderTree } from "../components/FolderTree";
import { FolderActionsDropdown } from "../components/FolderActionsDropdown";
import { FileEditor } from "../components/FileEditor";
import {
  getCandorRootPath,
  loadFolderTree,
  loadSavedMeetings,
  moveMeetingToFolder,
  openCandorFolder,
  type FolderTreeNode,
  type SavedMeeting,
} from "../api/local";
import { directItemCounts, formatItemCount } from "../utils/folderActions";
import { meetingContextHandler } from "../components/ContextMenu";
import type { ContextMenuState } from "../meetingEdit";

interface FilesProps {
  onNavigate: (view: View) => void;
  onOpenMeeting: (id: string) => void;
  refreshKey: number;
  onMeetingContextMenu: (x: number, y: number, target: ContextMenuState["target"]) => void;
}

function collectFolderIds(node: FolderTreeNode, out: Set<string>) {
  out.add(node.id);
  for (const child of node.children) collectFolderIds(child, out);
}

function folderIdsForTree(tree: FolderTreeNode[], selectedId: string): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: FolderTreeNode[]) => {
    for (const n of nodes) {
      if (n.id === selectedId) {
        collectFolderIds(n, out);
        return true;
      }
      if (n.children.length && walk(n.children)) return true;
    }
    return false;
  };
  walk(tree);
  if (out.size === 0) out.add(selectedId);
  return out;
}

function flattenFolders(tree: FolderTreeNode[]): FolderTreeNode[] {
  const out: FolderTreeNode[] = [];
  const walk = (nodes: FolderTreeNode[]) => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

export function Files({ onNavigate, onOpenMeeting, refreshKey, onMeetingContextMenu }: FilesProps) {
  const [meetings, setMeetings] = useState<SavedMeeting[]>([]);
  const [tree, setTree] = useState<FolderTreeNode[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("inbox");
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [candorPath, setCandorPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [dragMeetingId, setDragMeetingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [m, t, root] = await Promise.all([
      loadSavedMeetings(),
      loadFolderTree(),
      getCandorRootPath(),
    ]);
    setMeetings(m);
    setTree(t);
    setCandorPath(root);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const itemCounts = useMemo(() => directItemCounts(meetings), [meetings]);

  const visibleMeetings = useMemo(() => {
    if (!tree.length) return meetings;
    const allowed = folderIdsForTree(tree, selectedFolderId);
    return meetings.filter((m) => allowed.has(m.folderId ?? "inbox"));
  }, [meetings, tree, selectedFolderId]);

  const flatFolders = useMemo(() => flattenFolders(tree), [tree]);
  const selectedFolder = flatFolders.find((f) => f.id === selectedFolderId);

  const handleDropOnFolder = async (folderId: string) => {
    if (!dragMeetingId) return;
    try {
      await moveMeetingToFolder(dragMeetingId, folderId);
      await refresh();
    } catch (e) {
      window.alert(String(e));
    } finally {
      setDragMeetingId(null);
    }
  };

  return (
    <div className="screen screen--sidebar">
      <Sidebar
        active="Files"
        onNavigate={onNavigate}
        filesSelectedFolderId={selectedFolderId}
        onFilesFolderChange={refresh}
      />

      <div className="main main--scroll files-layout">
        <div className="library-head files-page-head">
          <div className="files-page-head-text">
            <span className="page-title">Files</span>
            <span className="page-sub">Organize transcripts and notes on your device</span>
          </div>
          <div className="spacer" />
          <FolderActionsDropdown
            selectedFolderId={selectedFolderId}
            onCreated={() => refresh()}
          />
          <button type="button" className="btn-ghost" onClick={() => openCandorFolder().catch(() => {})}>
            Open in Explorer
          </button>
          <button type="button" className="btn-ghost" onClick={refresh}>
            Refresh
          </button>
        </div>

        {candorPath && (
          <div className="files-path-banner">
            <span className="files-path-label">Local storage</span>
            <code className="files-path-value">{candorPath}</code>
          </div>
        )}

        <div className="files-split">
          <aside className="files-pane files-pane--tree">
            <div className="folder-tree-head">
              <span className="folder-tree-title">Folders</span>
            </div>
            <FolderTree
              tree={tree}
              selectedId={selectedFolderId}
              onSelect={setSelectedFolderId}
              onChange={refresh}
              meetings={meetings}
              itemCounts={itemCounts}
            />
          </aside>

          <section className="files-pane files-pane--list">
            <div className="files-list-head">
              <span className="files-list-title">{selectedFolder?.name ?? "Folder"}</span>
              <span className="files-list-count">{formatItemCount(visibleMeetings.length)}</span>
            </div>
            {loading ? (
              <div className="library-empty">Loading meetings…</div>
            ) : visibleMeetings.length === 0 ? (
              <div className="library-empty">
                No files in this folder. Record a meeting or drag files here from another folder.
              </div>
            ) : (
              <div className="meeting-list meeting-list--compact">
                {visibleMeetings.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`meeting-row meeting-row--menu ${selectedMeetingId === m.id ? "meeting-row--selected" : ""}`}
                    draggable
                    onDragStart={() => setDragMeetingId(m.id)}
                    onDragEnd={() => setDragMeetingId(null)}
                    onClick={() => setSelectedMeetingId(m.id)}
                    onDoubleClick={() => onOpenMeeting(m.id)}
                    onContextMenu={(e) =>
                      meetingContextHandler(e, (x, y) =>
                        onMeetingContextMenu(x, y, { kind: "saved", meeting: m }),
                      )
                    }
                  >
                    <div className="meeting-main">
                      <div className="meeting-title-row">
                        <span className="meeting-title">{m.title}</span>
                      </div>
                      <div className="meeting-blurb">{m.blurb}</div>
                    </div>
                    <div className="meeting-meta">
                      <div className="meeting-when">{m.whenLabel}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            <div
              className="files-drop-hint"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDropOnFolder(selectedFolderId)}
            >
              Drop here to move into this folder
            </div>
          </section>

          <section className="files-pane files-pane--editor">
            <FileEditor
              meetingId={selectedMeetingId}
              onSaved={refresh}
              onOpenRecap={onOpenMeeting}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
