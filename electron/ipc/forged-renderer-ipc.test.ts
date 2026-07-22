import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcDependencies } from "./ipc-types.js";
import { SETUP_IPC_CHANNELS, registerSetupIpc, type IpcHandlerRegistrar } from "./setup-ipc.js";
import { SHORTCUTS_IPC_CHANNELS, registerShortcutsIpc } from "./shortcuts-ipc.js";

type ElectronHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const electronIpc = vi.hoisted(() => {
  const handlers = new Map<string, ElectronHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, listener: ElectronHandler) => {
      handlers.set(channel, listener);
    }),
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: electronIpc.handle,
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
}));

import { registerCoreIpc } from "./core-ipc.js";
import { MODEL_CATALOG_IPC_CHANNELS, registerModelsIpc } from "./models-ipc.js";

const ACTIVE_WEB_CONTENTS_ID = 41;
const REJECTED_SENDER_MESSAGE = "IPC sender is not the active Candor main frame.";

class FakeRegistrar implements IpcHandlerRegistrar {
  readonly handlers = new Map<string, ElectronHandler>();

  handle(channel: string, listener: ElectronHandler): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    return Promise.resolve(handler(event, ...args));
  }
}

interface ForgedSenderFixture {
  event: IpcMainInvokeEvent;
  getMainWindow: () => BrowserWindow | null;
}

function eventFor(senderId: number, senderFrame: unknown): IpcMainInvokeEvent {
  return {
    sender: { id: senderId },
    senderFrame,
  } as unknown as IpcMainInvokeEvent;
}

function windowFixture(destroyed = false): {
  mainFrame: object;
  window: BrowserWindow;
} {
  const mainFrame = {};
  const window = {
    isDestroyed: () => destroyed,
    webContents: {
      id: ACTIVE_WEB_CONTENTS_ID,
      mainFrame,
    },
  } as unknown as BrowserWindow;
  return { mainFrame, window };
}

const forgedSenders: Array<{
  name: string;
  create: () => ForgedSenderFixture;
}> = [
  {
    name: "correct sender ID with the wrong sender frame",
    create: () => {
      const fixture = windowFixture();
      return {
        event: eventFor(ACTIVE_WEB_CONTENTS_ID, {}),
        getMainWindow: () => fixture.window,
      };
    },
  },
  {
    name: "wrong sender ID with the correct sender frame",
    create: () => {
      const fixture = windowFixture();
      return {
        event: eventFor(ACTIVE_WEB_CONTENTS_ID + 1, fixture.mainFrame),
        getMainWindow: () => fixture.window,
      };
    },
  },
  {
    name: "destroyed main window",
    create: () => {
      const fixture = windowFixture(true);
      return {
        event: eventFor(ACTIVE_WEB_CONTENTS_ID, fixture.mainFrame),
        getMainWindow: () => fixture.window,
      };
    },
  },
  {
    name: "missing main window",
    create: () => ({
      event: eventFor(ACTIVE_WEB_CONTENTS_ID, {}),
      getMainWindow: () => null,
    }),
  },
];

describe("forged renderer IPC frames", () => {
  beforeEach(() => {
    electronIpc.handlers.clear();
    electronIpc.handle.mockClear();
  });

  it.each(forgedSenders)("blocks every setup path for $name", async ({ create }) => {
    const forged = create();
    const ipc = new FakeRegistrar();
    const preferences = {
      status: vi.fn(),
      visitStep: vi.fn(),
      updateStep: vi.fn(),
      deferStep: vi.fn(),
      completeSetup: vi.fn(),
      markExistingUserPromptShown: vi.fn(),
    };
    registerSetupIpc({
      ipc,
      preferences,
      getMainWindow: forged.getMainWindow,
    });

    const setupCalls: Array<[string, unknown?]> = [
      [SETUP_IPC_CHANNELS.getStatus],
      [SETUP_IPC_CHANNELS.visit, { step: "microphone" }],
      [SETUP_IPC_CHANNELS.updateStep, { step: "license", visit: "microphone" }],
      [SETUP_IPC_CHANNELS.defer, { step: "shortcut" }],
      [SETUP_IPC_CHANNELS.complete],
      [SETUP_IPC_CHANNELS.markExistingUserPromptShown],
    ];
    for (const [channel, payload] of setupCalls) {
      await expect(ipc.invoke(channel, forged.event, payload)).rejects.toThrow(REJECTED_SENDER_MESSAGE);
    }

    expect(preferences.status).not.toHaveBeenCalled();
    expect(preferences.visitStep).not.toHaveBeenCalled();
    expect(preferences.updateStep).not.toHaveBeenCalled();
    expect(preferences.deferStep).not.toHaveBeenCalled();
    expect(preferences.completeSetup).not.toHaveBeenCalled();
    expect(preferences.markExistingUserPromptShown).not.toHaveBeenCalled();
  });

  it.each(forgedSenders)("blocks every shortcut path for $name", async ({ create }) => {
    const forged = create();
    const ipc = new FakeRegistrar();
    const shortcuts = {
      initialize: vi.fn(),
      configure: vi.fn(),
      reset: vi.fn(),
    };
    registerShortcutsIpc({
      ipc,
      shortcuts,
      getMainWindow: forged.getMainWindow,
    });

    await expect(ipc.invoke(SHORTCUTS_IPC_CHANNELS.getStatus, forged.event))
      .rejects.toThrow(REJECTED_SENDER_MESSAGE);
    await expect(ipc.invoke(
      SHORTCUTS_IPC_CHANNELS.update,
      forged.event,
      { enabled: true, accelerator: "CommandOrControl+Shift+Space" },
    )).rejects.toThrow(REJECTED_SENDER_MESSAGE);
    await expect(ipc.invoke(SHORTCUTS_IPC_CHANNELS.reset, forged.event))
      .rejects.toThrow(REJECTED_SENDER_MESSAGE);

    expect(shortcuts.initialize).not.toHaveBeenCalled();
    expect(shortcuts.configure).not.toHaveBeenCalled();
    expect(shortcuts.reset).not.toHaveBeenCalled();
  });

  it.each(forgedSenders)("blocks every microphone-test path for $name", async ({ create }) => {
    const forged = create();
    const coreCall = vi.fn();
    const observeCoreOperation = vi.fn();
    registerCoreIpc({
      core: {
        call: coreCall,
        rendererSnapshot: vi.fn(),
      },
      preferences: {},
      shortcuts: {},
      liveTranscriptEvents: { observeCoreOperation },
      getMainWindow: forged.getMainWindow,
      getLicenseService: vi.fn(),
    } as unknown as IpcDependencies);

    const microphoneTestChannels: Array<[string, unknown?]> = [
      ["candor-core:capture-mic-test-start", {}],
      ["candor-core:capture-mic-test-status"],
      ["candor-core:capture-mic-test-sample"],
      ["candor-core:capture-mic-test-stop"],
    ];
    for (const [channel, payload] of microphoneTestChannels) {
      const handler = electronIpc.handlers.get(channel);
      if (!handler) throw new Error(`missing handler ${channel}`);
      await expect(Promise.resolve(handler(forged.event, payload)))
        .rejects.toThrow(REJECTED_SENDER_MESSAGE);
    }

    expect(coreCall).not.toHaveBeenCalled();
    expect(observeCoreOperation).not.toHaveBeenCalled();
  });

  it.each(forgedSenders)("blocks every model-catalog path for $name", async ({ create }) => {
    const forged = create();
    const catalog = vi.fn();
    const download = vi.fn();
    const cancel = vi.fn();
    registerModelsIpc({
      core: { call: vi.fn() },
      modelAcquisition: { catalog, download, cancel },
      getMainWindow: forged.getMainWindow,
    } as unknown as IpcDependencies);

    const calls: Array<[string, unknown?]> = [
      [MODEL_CATALOG_IPC_CHANNELS.getCatalog],
      [MODEL_CATALOG_IPC_CHANNELS.download, { modelId: "small.en" }],
      [MODEL_CATALOG_IPC_CHANNELS.cancelDownload, { modelId: "small.en" }],
    ];
    for (const [channel, payload] of calls) {
      const handler = electronIpc.handlers.get(channel);
      if (!handler) throw new Error(`missing handler ${channel}`);
      await expect(Promise.resolve(handler(forged.event, payload)))
        .rejects.toThrow(REJECTED_SENDER_MESSAGE);
    }
    expect(catalog).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels an active model transfer before dispatching a valid capture start", async () => {
    const fixture = windowFixture();
    const cancelForCapture = vi.fn();
    const coreCall = vi.fn(async () => ({ ok: false, error: { code: "CAPTURE_FAILED" } }));
    registerCoreIpc({
      core: { call: coreCall, rendererSnapshot: vi.fn() },
      modelAcquisition: { cancelForCapture },
      getMainWindow: () => fixture.window,
    } as unknown as IpcDependencies);
    const handler = electronIpc.handlers.get("candor-core:capture-start-mic");
    if (!handler) throw new Error("missing capture start handler");

    await expect(Promise.resolve(handler(eventFor(ACTIVE_WEB_CONTENTS_ID, fixture.mainFrame), {})))
      .rejects.toThrow();
    expect(cancelForCapture).toHaveBeenCalledTimes(1);
    expect(coreCall).toHaveBeenCalledWith("capture.startMic", {});
    expect(cancelForCapture.mock.invocationCallOrder[0]).toBeLessThan(coreCall.mock.invocationCallOrder[0]);
  });
});
