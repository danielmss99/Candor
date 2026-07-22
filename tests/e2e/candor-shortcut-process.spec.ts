import { expect, test } from "@playwright/test";
import {
  cleanupDeferredCandorDataDirs,
  launchCandor,
  launchSecondaryCandorInstance,
  type CandorElectronSession,
} from "./candor-electron";

test.skip(process.platform !== "win32", "The exact-identity second-instance proof currently requires Windows.");

test.afterAll(() => {
  cleanupDeferredCandorDataDirs();
});

test("the second-instance lock restores the primary without changing workspace state", async () => {
  let session: CandorElectronSession | null = null;
  try {
    session = await launchCandor({ seedMeeting: true });
    await expect(session.page.locator('[data-view="meeting"]')).toBeVisible();
    await session.page.getByRole("button", { name: "Meetings", exact: true }).click();
    await expect(session.page.locator('[data-view="library"]')).toBeVisible();

    const initialShortcut = await session.page.evaluate(() => window.candor!.shortcuts.getStatus());
    expect(initialShortcut).toMatchObject({ enabled: false, registered: false, state: "disabled" });
    const enabledShortcut = await session.page.evaluate(() => window.candor!.shortcuts.update({
      enabled: true,
      accelerator: "Control+Alt+Shift+F24",
    }));
    expect(enabledShortcut).toMatchObject({
      enabled: true,
      accelerator: "Control+Alt+Shift+F24",
      registered: true,
      state: "registered",
      recordsAudio: false,
    });
    const initialDurableState = await session.page.evaluate(async (recordingId) => {
      const [capture, library, meeting] = await Promise.all([
        window.candor!.capture.getStatus(),
        window.candor!.meetings.list(0, 100),
        window.candor!.meetings.get(recordingId),
      ]);
      return { capture, library, meeting };
    }, session.recordingId);
    expect(initialDurableState.capture).toMatchObject({ active: false, activeSession: null });

    const recorder = session.page.locator(".sidebar-record-action");
    await expect(recorder).toBeVisible();
    const initialRecorderState = await recorder.evaluate((button: HTMLButtonElement) => ({
      ariaLabel: button.getAttribute("aria-label"),
      ariaPressed: button.getAttribute("aria-pressed"),
      disabled: button.disabled,
      text: button.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }));
    await session.page.evaluate(() => {
      const testWindow = window as Window & {
        __candorCaptureSampleBusy?: boolean;
        __candorCaptureSampleInterval?: number;
        __candorCaptureSamples?: boolean[];
        __candorShortcutEventCount?: number;
        __candorShortcutUnsubscribe?: () => void;
      };
      testWindow.__candorShortcutEventCount = 0;
      testWindow.__candorCaptureSamples = [];
      testWindow.__candorCaptureSampleBusy = false;
      testWindow.__candorShortcutUnsubscribe = window.candor!.events.subscribe("shortcut.triggered", () => {
        testWindow.__candorShortcutEventCount = (testWindow.__candorShortcutEventCount ?? 0) + 1;
      });
      testWindow.__candorCaptureSampleInterval = window.setInterval(async () => {
        if (testWindow.__candorCaptureSampleBusy) return;
        testWindow.__candorCaptureSampleBusy = true;
        try {
          const status = await window.candor!.capture.getStatus() as Record<string, unknown>;
          testWindow.__candorCaptureSamples?.push(status.active === true);
        } finally {
          testWindow.__candorCaptureSampleBusy = false;
        }
      }, 50);
    });
    await session.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.minimize();
    });
    await expect.poll(() => session!.app.evaluate(({ BrowserWindow }) => (
      BrowserWindow.getAllWindows()[0]?.isMinimized() ?? false
    ))).toBe(true);

    const secondary = await launchSecondaryCandorInstance(session.dataDir);
    expect(secondary).toEqual({
      exitCode: 0,
      signalCode: null,
      cleanupTerminatedPids: [],
    });
    await expect.poll(() => session!.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        minimized: window?.isMinimized() ?? true,
        visible: window?.isVisible() ?? false,
      };
    })).toEqual({ minimized: false, visible: true });
    await expect.poll(() => session!.page.evaluate(() => document.hasFocus())).toBe(true);

    const observation = await session.page.evaluate(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 750));
      const testWindow = window as Window & {
        __candorCaptureSampleInterval?: number;
        __candorCaptureSamples?: boolean[];
        __candorShortcutEventCount?: number;
        __candorShortcutUnsubscribe?: () => void;
      };
      if (testWindow.__candorCaptureSampleInterval !== undefined) {
        window.clearInterval(testWindow.__candorCaptureSampleInterval);
      }
      testWindow.__candorShortcutUnsubscribe?.();
      const result = {
        captureSamples: [...(testWindow.__candorCaptureSamples ?? [])],
        shortcutEventCount: testWindow.__candorShortcutEventCount ?? 0,
      };
      testWindow.__candorShortcutUnsubscribe = undefined;
      testWindow.__candorCaptureSampleInterval = undefined;
      return result;
    });
    expect(observation.shortcutEventCount).toBe(0);
    expect(observation.captureSamples.length).toBeGreaterThan(0);
    expect(observation.captureSamples).not.toContain(true);

    expect(await session.page.evaluate(() => window.candor!.shortcuts.getStatus())).toMatchObject({
      enabled: true,
      accelerator: "Control+Alt+Shift+F24",
      registered: true,
      state: "registered",
      recordsAudio: false,
    });

    await expect(session.page.locator('[data-view="library"]')).toBeVisible();
    await expect(recorder).not.toBeFocused();
    await expect(session.page.getByText("Recorder opened. Recording has not started.", { exact: true })).toHaveCount(0);
    expect(await recorder.evaluate((button: HTMLButtonElement) => ({
      ariaLabel: button.getAttribute("aria-label"),
      ariaPressed: button.getAttribute("aria-pressed"),
      disabled: button.disabled,
      text: button.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }))).toEqual(initialRecorderState);

    const finalDurableState = await session.page.evaluate(async (recordingId) => {
      const [capture, library, meeting] = await Promise.all([
        window.candor!.capture.getStatus(),
        window.candor!.meetings.list(0, 100),
        window.candor!.meetings.get(recordingId),
      ]);
      return { capture, library, meeting };
    }, session.recordingId);
    expect(finalDurableState.capture).toMatchObject({ active: false, activeSession: null });
    expect(finalDurableState.library).toEqual(initialDurableState.library);
    expect(finalDurableState.meeting).toEqual(initialDurableState.meeting);
  } finally {
    if (session) {
      await session.page.evaluate(() => {
        const testWindow = window as Window & {
          __candorCaptureSampleInterval?: number;
          __candorShortcutUnsubscribe?: () => void;
        };
        if (testWindow.__candorCaptureSampleInterval !== undefined) {
          window.clearInterval(testWindow.__candorCaptureSampleInterval);
        }
        testWindow.__candorShortcutUnsubscribe?.();
      }).catch(() => undefined);
      await session.close();
    }
  }
});
