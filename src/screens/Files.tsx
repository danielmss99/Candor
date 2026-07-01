import { useEffect, useMemo, useState } from "react";
import type { SidebarFolderProps, View } from "../App";
import { Sidebar } from "../components/Sidebar";
import { FileEditor } from "../components/FileEditor";
import {
  getCandorRootPath,
  loadStorageLibraries,
  moveMeetingToFolder,
  openCandorFolder,
  pickStorageFolder,
  changeStorageLibraryPath,
  setActiveStorageLibrary,
  type FolderTreeNode,
  type StorageLibrariesState,
} from "../api/local";
import { FilesExplorerList } from "../components/FilesExplorerList";
import {
  flattenFolderTree,
  folderBreadcrumbPath,
  formatItemCount,
} from "../utils/folderActions";
import type { ContextMenuState } from "../meetingEdit";

interface FilesProps {
  onNavigate: (view: View) => void;
  onOpenMeeting: (id: string) => void;
  refreshKey: number;
  onMeetingContextMenu: (x: number, y: number, target: ContextMenuState["target"]) => void;
  sidebarFolder: SidebarFolderProps;
  embedded?: boolean;
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

export function Files({
  onNavigate,
  onOpenMeeting,
  refreshKey,
  onMeetingContextMenu,
  sidebarFolder,
  embedded,
}: FilesProps) {
  const {
    filesTree: tree,
    filesSelectedFolderId: selectedFolderId,
    onSelectedFolderChange: setSelectedFolderId,
    onFilesFolderChange: refresh,
    filesMeetings: meetings,
  } = sidebarFolder;

  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [candorPath, setCandorPath] = useState("");
  const [storage, setStorage] = useState<StorageLibrariesState | null>(null);
  const [dragMeetingId, setDragMeetingId] = useState<string | null>(null);

  const loading = tree.length === 0 && meetings.length === 0;
  const activeLibrary = storage?.libraries.find((l) => l.id === storage.activeId);

  useEffect(() => {
    getCandorRootPath().then(setCandorPath).catch(() => {});
    loadStorageLibraries().then(setStorage).catch(() => {});
  }, [refreshKey]);

  const handleChangeLocation = async () => {
    if (!storage?.activeId) return;
    const picked = await pickStorageFolder();
    if (!picked) return;
    const migrate = window.confirm(
      "Move existing Candor files to the new folder?\n\nOK = copy everything to the new location\nCancel = use the new folder empty (existing files stay at the old path)",
    );
    try {
      await changeStorageLibraryPath(storage.activeId, picked, migrate);
      getCandorRootPath().then(setCandorPath).catch(() => {});
      loadStorageLibraries().then(setStorage).catch(() => {});
      await refresh();
    } catch (e) {
      window.alert(String(e));
    }
  };

  const handleSwitchLibrary = async (id: string) => {
    if (id === storage?.activeId) return;
    try {
      await setActiveStorageLibrary(id);
      loadStorageLibraries().then(setStorage).catch(() => {});
      getCandorRootPath().then(setCandorPath).catch(() => {});
      await refresh();
    } catch (e) {
      window.alert(String(e));
    }
  };

  const visibleMeetings = useMemo(() => {
    if (!tree.length) return meetings;
    const allowed = folderIdsForTree(tree, selectedFolderId);
    return meetings.filter((m) => allowed.has(m.folderId ?? "inbox"));
  }, [meetings, tree, selectedFolderId]);

  const flatFolders = useMemo(() => flattenFolderTree(tree), [tree]);
  const selectedFolder = flatFolders.find((f) => f.id === selectedFolderId);
  const breadcrumb = useMemo(
    () => folderBreadcrumbPath(tree, selectedFolderId),
    [tree, selectedFolderId],
  );

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

  const main = (
      <div className="main main--scroll files-layout">
        <div className="library-head files-page-head">
          <div className="files-page-head-text">
            <span className="page-title">Files</span>
            <span className="page-sub">Organize transcripts and notes on your device</span>
          </div>
          <div className="spacer" />
          <button type="button" className="btn-ghost" onClick={() => openCandorFolder().catch(() => {})}>
            Open in Explorer
          </button>
          <button type="button" className="btn-ghost" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>

        {candorPath && (
          <div className="files-path-banner">
            <div className="files-path-main">
              <span className="files-path-label">
                {activeLibrary?.name ?? "Local storage"}
              </span>
              <code className="files-path-value">{candorPath}</code>
            </div>
            <div className="files-path-actions">
              {storage && storage.libraries.length > 1 && (
                <select
                  className="files-lib-select"
                  value={storage.activeId}
                  onChange={(e) => void handleSwitchLibrary(e.target.value)}
                  aria-label="Switch storage location"
                >
                  {storage.libraries.map((lib) => (
                    <option key={lib.id} value={lib.id}>
                      {lib.name}
                    </option>
                  ))}
                </select>
              )}
              <button type="button" className="btn-ghost" onClick={() => void handleChangeLocation()}>
                Change location
              </button>
            </div>
          </div>
        )}

        <div className="files-split">
          <section className="files-pane files-pane--list">
            <div className="files-explorer">
              <nav className="files-explorer-breadcrumb" aria-label="Current folder">
                <button
                  type="button"
                  className="files-explorer-crumb"
                  onClick={() => setSelectedFolderId("inbox")}
                >
                  Candor
                </button>
                {breadcrumb.map((folder) => (
                  <span key={folder.id} className="files-explorer-crumb-wrap">
                    <span className="files-explorer-crumb-sep" aria-hidden="true">
                      ›
                    </span>
                    <button
                      type="button"
                      className={`files-explorer-crumb${folder.id === selectedFolderId ? " files-explorer-crumb--current" : ""}`}
                      onClick={() => setSelectedFolderId(folder.id)}
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
              </nav>

              <div className="files-explorer-toolbar">
                <span className="files-explorer-toolbar-title">
                  {selectedFolder?.name ?? "Folder"}
                </span>
                <span className="files-explorer-toolbar-count">
                  {formatItemCount(visibleMeetings.length)}
                </span>
              </div>

              <FilesExplorerList
                meetings={visibleMeetings}
                selectedId={selectedMeetingId}
                loading={loading}
                onSelect={setSelectedMeetingId}
                onOpen={onOpenMeeting}
                onContextMenu={onMeetingContextMenu}
                onDragStart={setDragMeetingId}
                onDragEnd={() => setDragMeetingId(null)}
              />

              <div
                className="files-drop-hint"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDropOnFolder(selectedFolderId)}
              >
                Drop here to move into this folder
              </div>
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
  );

  if (embedded) return main;
  return (
    <div className="screen screen--sidebar">
      <Sidebar active="Files" onNavigate={onNavigate} {...sidebarFolder} />
      {main}
    </div>
  );
}
