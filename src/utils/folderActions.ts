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

export function folderBreadcrumbPath(
  tree: FolderTreeNode[],
  folderId: string,
): FolderTreeNode[] {
  const flat = flattenFolderTree(tree);
  const byId = new Map(flat.map((f) => [f.id, f]));
  const path: FolderTreeNode[] = [];
  let current: FolderTreeNode | undefined = byId.get(folderId);
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
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

export const DEFAULT_NEW_FOLDER_NAME = "New folder";

let pendingFolderEditId: string | null = null;

export function setPendingFolderEdit(id: string): void {
  pendingFolderEditId = id;
}

export function takePendingFolderEdit(): string | null {
  const id = pendingFolderEditId;
  pendingFolderEditId = null;
  return id;
}

export function isDefaultNewFolderName(name: string): boolean {
  return name === DEFAULT_NEW_FOLDER_NAME || /^New folder \d+$/.test(name);
}

export function defaultNewFolderName(existingNames: Iterable<string>): string {
  const names = new Set(existingNames);
  if (!names.has(DEFAULT_NEW_FOLDER_NAME)) return DEFAULT_NEW_FOLDER_NAME;
  let i = 2;
  while (names.has(`${DEFAULT_NEW_FOLDER_NAME} ${i}`)) i++;
  return `${DEFAULT_NEW_FOLDER_NAME} ${i}`;
}

export async function createFolderForEdit(
  parentId?: string | null,
  existingNames?: Iterable<string>,
): Promise<string | null> {
  const name = defaultNewFolderName(existingNames ?? []);
  try {
    const folder = await createOrgFolder(name, parentId ?? null);
    setPendingFolderEdit(folder.id);
    return folder.id;
  } catch (e) {
    window.alert(String(e));
    return null;
  }
}

export async function promptRenameFolder(folder: FolderTreeNode): Promise<boolean> {
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
