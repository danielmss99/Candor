import { describe, expect, it, vi } from "vitest";
import { DesktopQuitLifecycle } from "./desktop-quit-lifecycle.js";

describe("DesktopQuitLifecycle", () => {
  it("preserves services after a canceled macOS quit and cleans them up once on final quit", async () => {
    const lifecycle = new DesktopQuitLifecycle();
    const services = {
      liveTranscriptEvents: { dispose: vi.fn() },
      shortcuts: { disposeSync: vi.fn() },
      core: { shutdown: vi.fn(async () => undefined) },
    };
    const control = { preventQuit: vi.fn(), requestQuit: vi.fn() };
    const beforeQuit = () => lifecycle.markBeforeQuit();
    const closeAborted = () => lifecycle.cancelQuit();
    const willQuit = () => lifecycle.holdFinalQuit(services, control);

    beforeQuit();
    expect(lifecycle.shouldShutdownServicesOnClose("darwin")).toBe(true);
    closeAborted();

    expect(lifecycle.shouldShutdownServicesOnClose("darwin")).toBe(false);
    expect(services.liveTranscriptEvents.dispose).not.toHaveBeenCalled();
    expect(services.shortcuts.disposeSync).not.toHaveBeenCalled();
    expect(services.core.shutdown).not.toHaveBeenCalled();
    expect(control.preventQuit).not.toHaveBeenCalled();
    expect(control.requestQuit).not.toHaveBeenCalled();

    beforeQuit();
    await willQuit();
    expect(services.liveTranscriptEvents.dispose).toHaveBeenCalledOnce();
    expect(services.shortcuts.disposeSync).toHaveBeenCalledOnce();
    expect(services.core.shutdown).toHaveBeenCalledOnce();
    expect(control.preventQuit).toHaveBeenCalledOnce();
    expect(control.requestQuit).toHaveBeenCalledOnce();

    expect(willQuit()).toBeNull();
    expect(services.liveTranscriptEvents.dispose).toHaveBeenCalledOnce();
    expect(services.shortcuts.disposeSync).toHaveBeenCalledOnce();
    expect(services.core.shutdown).toHaveBeenCalledOnce();
  });

  it("holds final quit until irreversible disposal and core shutdown complete", async () => {
    const lifecycle = new DesktopQuitLifecycle();
    const liveTranscriptDispose = vi.fn();
    const shortcutDispose = vi.fn();
    let resolveShutdown!: () => void;
    const coreShutdown = vi.fn(() => new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    }));
    const preventQuit = vi.fn();
    const requestQuit = vi.fn();

    lifecycle.markBeforeQuit();
    const completion = lifecycle.holdFinalQuit({
      liveTranscriptEvents: { dispose: liveTranscriptDispose },
      shortcuts: { disposeSync: shortcutDispose },
      core: { shutdown: coreShutdown },
    }, {
      preventQuit,
      requestQuit,
    });

    expect(completion).not.toBeNull();
    expect(preventQuit).toHaveBeenCalledOnce();
    expect(liveTranscriptDispose).toHaveBeenCalledOnce();
    expect(shortcutDispose).toHaveBeenCalledOnce();
    expect(coreShutdown).toHaveBeenCalledOnce();
    expect(requestQuit).not.toHaveBeenCalled();

    resolveShutdown();
    await completion;
    expect(requestQuit).toHaveBeenCalledOnce();
  });

  it("coalesces repeated final quit events and lets the post-shutdown event exit", async () => {
    const lifecycle = new DesktopQuitLifecycle();
    const services = {
      liveTranscriptEvents: { dispose: vi.fn() },
      shortcuts: { disposeSync: vi.fn() },
      core: { shutdown: vi.fn(async () => undefined) },
    };
    const first = { preventQuit: vi.fn(), requestQuit: vi.fn() };
    const second = { preventQuit: vi.fn(), requestQuit: vi.fn() };

    const firstCompletion = lifecycle.holdFinalQuit(services, first);
    const repeatedCompletion = lifecycle.holdFinalQuit(services, second);

    expect(repeatedCompletion).toBe(firstCompletion);
    expect(first.preventQuit).toHaveBeenCalledOnce();
    expect(second.preventQuit).toHaveBeenCalledOnce();
    await firstCompletion;
    expect(services.liveTranscriptEvents.dispose).toHaveBeenCalledOnce();
    expect(services.shortcuts.disposeSync).toHaveBeenCalledOnce();
    expect(services.core.shutdown).toHaveBeenCalledOnce();
    expect(first.requestQuit).toHaveBeenCalledOnce();
    expect(second.requestQuit).not.toHaveBeenCalled();

    const finalControl = { preventQuit: vi.fn(), requestQuit: vi.fn() };
    expect(lifecycle.holdFinalQuit(services, finalControl)).toBeNull();
    expect(finalControl.preventQuit).not.toHaveBeenCalled();
  });

  it("continues to bounded core shutdown when synchronous disposal throws", async () => {
    const lifecycle = new DesktopQuitLifecycle();
    const coreShutdown = vi.fn(async () => undefined);
    const control = { preventQuit: vi.fn(), requestQuit: vi.fn() };
    const completion = lifecycle.holdFinalQuit({
      liveTranscriptEvents: { dispose: () => { throw new Error("event disposal failed"); } },
      shortcuts: { disposeSync: () => { throw new Error("shortcut disposal failed"); } },
      core: { shutdown: coreShutdown },
    }, control);

    await completion;
    expect(coreShutdown).toHaveBeenCalledOnce();
    expect(control.requestQuit).toHaveBeenCalledOnce();
  });

  it("requests final quit only after a rejected core shutdown has settled", async () => {
    const lifecycle = new DesktopQuitLifecycle();
    let rejectShutdown!: (error: Error) => void;
    const coreShutdown = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectShutdown = reject;
    }));
    const control = { preventQuit: vi.fn(), requestQuit: vi.fn() };

    const completion = lifecycle.holdFinalQuit({
      liveTranscriptEvents: { dispose: vi.fn() },
      shortcuts: { disposeSync: vi.fn() },
      core: { shutdown: coreShutdown },
    }, control);

    expect(control.requestQuit).not.toHaveBeenCalled();
    rejectShutdown(new Error("bounded core shutdown failed"));
    await completion;
    expect(coreShutdown).toHaveBeenCalledOnce();
    expect(control.requestQuit).toHaveBeenCalledOnce();
  });

  it("still shuts down services for a normal Windows close", () => {
    expect(new DesktopQuitLifecycle().shouldShutdownServicesOnClose("win32")).toBe(true);
  });
});
