import { describe, expect, it, vi } from "vitest";
import {
  RECORDER_SHORTCUT_TRIGGERED_EVENT,
  showAndFocusDesktopWindow,
  type FocusableDesktopWindow,
} from "./desktop-setup-shortcuts.js";

function createWindow(options: { loading?: boolean; minimized?: boolean } = {}) {
  let loadListener: (() => void) | null = null;
  const send = vi.fn();
  const window: FocusableDesktopWindow = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => options.minimized ?? false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isDestroyed: vi.fn(() => false),
      isLoadingMainFrame: vi.fn(() => options.loading ?? false),
      send,
      once: vi.fn((_event, listener) => {
        loadListener = listener;
      }),
    },
  };
  return { window, send, finishLoad: () => loadListener?.() };
}

describe("desktop setup shortcut wiring", () => {
  it("restores and focuses the desktop before sending the bounded recorder event", () => {
    const { window, send } = createWindow({ minimized: true });

    showAndFocusDesktopWindow(window, true);

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(RECORDER_SHORTCUT_TRIGGERED_EVENT, {
      action: "show-and-focus-recorder",
      recordsAudio: false,
      localOnly: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });
  });

  it("waits for the renderer to load before sending the recorder event", () => {
    const { window, send, finishLoad } = createWindow({ loading: true });

    showAndFocusDesktopWindow(window, true);

    expect(send).not.toHaveBeenCalled();
    finishLoad();
    expect(send).toHaveBeenCalledOnce();
  });

  it("focuses a second-instance window without opening the recorder", () => {
    const { window, send } = createWindow();

    showAndFocusDesktopWindow(window, false);

    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
});
