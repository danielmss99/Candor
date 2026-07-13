import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

export type MainWindowProvider = () => BrowserWindow | null;

export function senderMatchesMainFrame(
  senderId: number,
  senderFrame: unknown,
  windowIdentity: { destroyed: boolean; webContentsId: number; mainFrame: unknown } | null,
): boolean {
  return Boolean(
    windowIdentity &&
    !windowIdentity.destroyed &&
    senderId === windowIdentity.webContentsId &&
    senderFrame === windowIdentity.mainFrame,
  );
}

export function validateIpcSender(event: IpcMainInvokeEvent, getMainWindow: MainWindowProvider): void {
  const window = getMainWindow();
  const identity = window
    ? {
        destroyed: window.isDestroyed(),
        webContentsId: window.webContents.id,
        mainFrame: window.webContents.mainFrame,
      }
    : null;
  if (!senderMatchesMainFrame(event.sender.id, event.senderFrame, identity)) {
    throw new Error("IPC sender is not the active Candor main frame.");
  }
}
