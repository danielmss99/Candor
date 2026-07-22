import { describe, expect, it, vi } from "vitest";
import {
  completeDeferredSetup,
  completeReadySetupStep,
  firstIncompleteSetupStep,
  inactiveLicenseStep,
  isNonBlockingSetupUpgrade,
  persistActiveSetupStep,
  recordingSetupIsComplete,
  setupStepAfterLoad,
  shouldOpenNonBlockingSetupUpgrade,
  shouldShowNonBlockingSetupPrompt,
} from "./useOnboardingSettings";

describe("onboarding data access", () => {
  it("skips activation whenever local recordings already exist", () => {
    expect(inactiveLicenseStep(1, false)).toBe("app");
    expect(inactiveLicenseStep(0, true)).toBe("app");
    expect(inactiveLicenseStep(0, false)).toBe("activate");
  });

  it("reopens the first not-completed setup step, including a deferred step", () => {
    expect(firstIncompleteSetupStep({
      setup: {
        progress: "in-progress",
        completed: ["license", "microphone"],
        deferred: ["shortcut"],
        lastStep: "storage",
      },
    })).toBe("shortcut");
    expect(firstIncompleteSetupStep({
      setup: {
        progress: "completed",
        completed: ["license", "microphone", "shortcut", "system-audio", "storage", "local-ai"],
        deferred: [],
        lastStep: "local-ai",
      },
    })).toBe("app");
  });

  it("uses first-incomplete restart routing while keeping completed deferrals and upgrades non-blocking", () => {
    const interruptedFirstRun = {
      setup: {
        progress: "in-progress",
        completed: ["license"],
        deferred: ["microphone"],
        lastStep: "shortcut",
        existingUserPromptShown: false,
        nonBlockingUpgrade: false,
      },
    };
    expect(setupStepAfterLoad(interruptedFirstRun, false)).toBe("microphone");

    const finishedWithDeferrals = {
      setup: { ...interruptedFirstRun.setup, progress: "completed" },
    };
    expect(setupStepAfterLoad(finishedWithDeferrals, false)).toBe("app");
    expect(setupStepAfterLoad(finishedWithDeferrals, true)).toBe("microphone");

    const existingUserUpgrade = {
      setup: { ...interruptedFirstRun.setup, nonBlockingUpgrade: true },
    };
    expect(setupStepAfterLoad(existingUserUpgrade, false)).toBe("app");
    expect(setupStepAfterLoad(existingUserUpgrade, true)).toBe("microphone");
  });

  it("keeps an existing meeting library accessible even when setup is an in-progress first-run record", () => {
    const inProgressSetup = {
      setup: {
        progress: "in-progress",
        completed: ["license"],
        deferred: [],
        lastStep: "microphone",
        existingUserPromptShown: false,
        nonBlockingUpgrade: false,
      },
    };
    expect(setupStepAfterLoad(inProgressSetup, false, true)).toBe("app");
    expect(setupStepAfterLoad(inProgressSetup, false, false)).toBe("microphone");
    expect(setupStepAfterLoad(inProgressSetup, true, true)).toBe("microphone");
    expect(shouldShowNonBlockingSetupPrompt(inProgressSetup, true, false, true)).toBe(true);
  });

  it("persists backward and direct setup navigation through the bounded setup surface", async () => {
    const persisted = {
      setup: { progress: "in-progress", lastStep: "license" },
      rawPathExposed: false as const,
      keyMaterialExposedToRenderer: false as const,
    };
    const visit = vi.fn().mockResolvedValue(persisted);
    const statusUpdates = vi.fn();

    await expect(persistActiveSetupStep("yours", { visit }, statusUpdates)).resolves.toEqual(persisted);
    expect(visit).toHaveBeenCalledWith({ step: "license" });
    expect(statusUpdates).toHaveBeenCalledWith(persisted);

    await expect(persistActiveSetupStep("app", { visit }, statusUpdates)).resolves.toBeNull();
    expect(visit).toHaveBeenCalledTimes(1);
  });

  it("opens an empty-library upgrade without blocking on first-run setup", () => {
    const upgrade = {
      setup: {
        progress: "not-started",
        completed: [],
        deferred: [],
        lastStep: null,
        existingUserPromptShown: false,
        nonBlockingUpgrade: true,
      },
    };
    expect(isNonBlockingSetupUpgrade(upgrade)).toBe(true);
    expect(shouldOpenNonBlockingSetupUpgrade(upgrade, false)).toBe(true);
    expect(shouldOpenNonBlockingSetupUpgrade(upgrade, true)).toBe(false);
    expect(shouldShowNonBlockingSetupPrompt(upgrade, true, false)).toBe(true);
  });

  it("keeps a quarantined-only upgrade non-blocking and persists one-time prompt dismissal", () => {
    const quarantinedOnlyUpgrade = {
      setup: {
        progress: "not-started",
        completed: [],
        deferred: [],
        lastStep: null,
        existingUserPromptShown: true,
        nonBlockingUpgrade: true,
      },
    };
    expect(shouldOpenNonBlockingSetupUpgrade(quarantinedOnlyUpgrade, false)).toBe(true);
    expect(shouldShowNonBlockingSetupPrompt(quarantinedOnlyUpgrade, true, false)).toBe(false);
  });

  it("keeps a genuine new install in first-run setup", () => {
    const newInstall = {
      setup: {
        progress: "not-started",
        completed: [],
        deferred: [],
        lastStep: null,
        existingUserPromptShown: false,
        nonBlockingUpgrade: false,
      },
    };
    expect(shouldOpenNonBlockingSetupUpgrade(newInstall, false)).toBe(false);
    expect(shouldShowNonBlockingSetupPrompt(newInstall, true, false)).toBe(false);
  });

  it("covers defer, finish, reopen, completion, and warning clearance", () => {
    const finishedWithRecordingSetupDeferred = {
      setup: {
        progress: "completed",
        completed: ["license", "shortcut", "storage", "local-ai"],
        deferred: ["microphone", "system-audio"],
        lastStep: "local-ai",
      },
    };
    expect(firstIncompleteSetupStep(finishedWithRecordingSetupDeferred, false)).toBe("microphone");
    expect(recordingSetupIsComplete(finishedWithRecordingSetupDeferred, true)).toBe(false);

    const microphoneCompleted = {
      setup: {
        progress: "completed",
        completed: ["license", "shortcut", "storage", "local-ai", "microphone"],
        deferred: ["system-audio"],
        lastStep: "microphone",
      },
    };
    expect(firstIncompleteSetupStep(microphoneCompleted, false)).toBe("system-audio");
    expect(recordingSetupIsComplete(microphoneCompleted, true)).toBe(false);

    const recordingSetupCompleted = {
      setup: {
        progress: "completed",
        completed: ["license", "shortcut", "storage", "local-ai", "microphone", "system-audio"],
        deferred: [],
        lastStep: "system-audio",
      },
    };
    expect(firstIncompleteSetupStep(recordingSetupCompleted, false)).toBe("app");
    expect(recordingSetupIsComplete(recordingSetupCompleted, true)).toBe(true);
  });

  it("does not mark setup complete when a multi-write finish step fails", async () => {
    const complete = vi.fn(async () => ({
      setup: { progress: "completed" },
      rawPathExposed: false as const,
      keyMaterialExposedToRenderer: false as const,
    }));
    const defer = vi.fn()
      .mockResolvedValueOnce({ setup: { completed: ["license"], deferred: ["microphone"] } })
      .mockRejectedValueOnce(new Error("shortcut persistence failed"));
    const statusUpdates = vi.fn();

    await expect(completeDeferredSetup(
      { setup: { completed: ["license"], deferred: [] } },
      { defer, complete },
      statusUpdates,
    )).rejects.toThrow("shortcut persistence failed");

    expect(defer).toHaveBeenCalledTimes(2);
    expect(complete).not.toHaveBeenCalled();
    expect(statusUpdates).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["microphone", "microphone setup write failed"],
    ["system audio", "system audio setup write failed"],
  ])("surfaces an already-ready %s persistence failure without advancing", async (_label, message) => {
    const surfaced = vi.fn();
    const run = vi.fn(async (_operation: string, task: () => Promise<void>) => {
      try {
        await task();
      } catch (reason) {
        surfaced(reason);
      }
    });
    const advance = vi.fn();

    await expect(completeReadySetupStep(
      run,
      async () => { throw new Error(message); },
      advance,
    )).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledOnce();
    expect(surfaced).toHaveBeenCalledOnce();
    expect(surfaced.mock.calls[0]?.[0]).toEqual(new Error(message));
    expect(advance).not.toHaveBeenCalled();
  });
});

