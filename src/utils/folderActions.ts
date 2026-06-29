import {
  createOrgFolder,
  deleteOrgFolder,
  moveMeetingToFolder,
  renameOrgFolder,
  type FolderTreeNode,
  type SavedMeeting,
} from "../api/local";

export function flattenFolderTree(tree: FolderTreeNode[]): FolderTreeNode[] {
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

export function folderDescendantIds(tree: FolderTreeNode[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: FolderTreeNode[]) => {
    for (const n of nodes) {
      if (n.id === id) {
        const collect = (node: FolderTreeNode) => {
          out.add(node.id);
          for (const c of node.children) collect(c);
        };
        collect(n);
        return true;
      }
      if (n.children.length && walk(n.children)) return true;
    }
    return false;
  };
  walk(tree);
  if (out.size === 0) out.add(id);
  return out;
}

export function directItemCounts(
  meetings: SavedMeeting[],
): Record<string, number> {
  const counts: Record<string, number> = { inbox: 0 };
  for (const m of meetings) {
    const fid = m.folderId ?? "inbox";
    counts[fid] = (counts[fid] ?? 0) + 1;
  }
  return counts;
}

export function formatItemCount(n: number): string {
  return n === 1 ? "1 item" : `${n} items`;
}

export async function promptCreateFolder(parentId?: string | null): Promise<string | null> {
  const name = window.prompt(parentId ? "New subfolder name" : "New folder name");
  if (!name?.trim()) return null;
  try {
    const folder = await createOrgFolder(name.trim(), parentId ?? null);
    return folder.id;
  } catch (e) {
    window.alert(String(e));
    return null;
  }
}

export async function promptRenameFolder(folder: FolderTreeNode): Promise<boolean> {
  if (folder.id === "inbox") return false;
  const name = window.prompt("Rename folder", folder.name);
  if (!name?.trim() || name.trim() === folder.name) return false;
  try {
    await renameOrgFolder(folder.id, name.trim());
    return true;
  } catch (e) {
    window.alert(String(e));
    return false;
  }
}

export async function confirmDeleteFolder(folder: FolderTreeNode): Promise<boolean> {
  if (folder.id === "inbox") return false;
  if (
    !window.confirm(
      `Delete “${folder.name}”? Meetings in this folder move to the parent folder.`,
    )
  ) {
    return false;
  }
  try {
    await deleteOrgFolder(folder.id);
    return true;
  } catch (e) {
    window.alert(String(e));
    return false;
  }
}

export async function emptyFolder(
  folderId: string,
  meetings: SavedMeeting[],
  parentId: string,
): Promise<boolean> {
  const inFolder = meetings.filter((m) => (m.folderId ?? "inbox") === folderId);
  if (inFolder.length === 0) return true;
  if (
    !window.confirm(
      `Move ${formatItemCount(inFolder.length)} to the parent folder?`,
    )
  ) {
    return false;
  }
  try {
    for (const m of inFolder) {
      await moveMeetingToFolder(m.id, parentId);
    }
    return true;
  } catch (e) {
    window.alert(String(e));
    return false;
  }
}

export async function moveFolderContentsTo(
  folderId: string,
  meetings: SavedMeeting[],
  targetFolderId: string,
): Promise<boolean> {
  const inFolder = meetings.filter((m) => (m.folderId ?? "inbox") === folderId);
  if (inFolder.length === 0) return true;
  try {
    for (const m of inFolder) {
      await moveMeetingToFolder(m.id, targetFolderId);
    }
    return true;
  } catch (e) {
    window.alert(String(e));
    return false;
  }
}
