import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { cleanupDeferredCandorDataDirs, launchCandor, type CandorElectronSession } from "./candor-electron";

test.afterAll(() => cleanupDeferredCandorDataDirs());

// Windows applies and verifies a user-only ACL during each atomic setup write.
// Its bounded permission helper may use the full ten-second OS timeout under load.
const SETUP_PERSISTENCE_TIMEOUT_MS = 25_000;

async function expectSetupHeading(page: Page, name: string, focused = false): Promise<void> {
  const heading = page.getByRole("heading", { name });
  if (focused) await expect(heading).toBeFocused({ timeout: SETUP_PERSISTENCE_TIMEOUT_MS });
  else await expect(heading).toBeVisible({ timeout: SETUP_PERSISTENCE_TIMEOUT_MS });
}

const expectedPreloadSurface = {
  app: ["acknowledgeJob", "cancelAllJobs", "cancelJob", "getActiveJobs", "getCapabilities", "getConnectionStatus", "getJob", "getStatus", "getVersion", "listJobs", "prepareDiagnostics", "retryCore", "retryJob", "saveDiagnostics"],
  capture: ["acknowledgeConsent", "getConsent", "getDevices", "getMicTestSample", "getMicTestStatus", "getPreferences", "getStatus", "openMicrophoneSettings", "recover", "setPreferredMicrophone", "start", "startMicTest", "stop", "stopMicTest"],
  meetings: ["applyProtectedTermReview", "delete", "get", "getImportStatus", "getMediaImportStatus", "getNotes", "getPrivacyReceipt", "getProtectedTermReview", "getReplayManifest", "getStorageStatus", "getTranscript", "getTranscriptRevision", "getTrustHistory", "importLegacy", "importMedia", "list", "readAudioChunk", "search", "selectTranscriptRevision", "updateNotes"],
  transcript: ["cancel", "getQuality", "getStatus", "reprocess", "setQuality", "start", "startQualityBenchmark"],
  liveTranscript: ["clear", "enable", "eventsDrain", "snapshot", "start", "stop"],
  diarization: ["assignSpeakerName", "getSpeakerNames", "getStatus", "removeSpeakerName", "setEnabled"],
  terminology: ["assignToMeeting", "decideCorrection", "getCorrectionProposals", "getStatus", "importDictionary", "setEnabled"],
  profiles: ["delete", "get", "list", "select", "upsert"],
  replacements: ["apply", "delete", "get", "list", "preview", "upsert"],
  ai: ["ask", "cancel", "cancelModelDownload", "chooseEnhancedComponent", "chooseSpeechModel", "cleanupTranscript", "downloadModel", "generateRecap", "getBundledAssetsStatus", "getEnhancedAssetsStatus", "getEnhancedStatus", "getFallbackPreference", "getModelCatalog", "getStatus", "getWorkloadStatus", "listSpeechModels", "setFallbackPreference", "verifySpeechModel"],
  exports: ["cancel", "create", "saveCompleted"],
  settings: ["getNetworkPolicy", "getPrivacyAudit", "getRetentionStatus", "getStorageStatus", "getUpdateStatus", "openLocalStorage"],
  licensing: ["activate", "deactivate", "getPortalInfo", "getStatus", "startTrial"],
  setup: ["complete", "defer", "getStatus", "markExistingUserPromptShown", "updateStep", "visit"],
  shortcuts: ["getStatus", "reset", "update"],
  events: ["subscribe"],
};

function violationSummary(violations: Array<{ id: string; impact?: string | null; nodes: unknown[] }>): string {
  return violations.map((violation) => `${violation.impact ?? "unknown"}:${violation.id} (${violation.nodes.length})`).join(", ");
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  // Electron exposes one sandboxed document and no iframes, so legacy injection avoids a second unsupported browser target.
  const results = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations, violationSummary(results.violations)).toEqual([]);
}

async function expectMeetingNotesVisible(page: Page): Promise<void> {
  const notesEditor = page.getByRole("textbox", { name: "Meeting notes" });
  if (await notesEditor.isVisible()) return;

  const notesPane = page
    .getByRole("tablist", { name: "Meeting workspace panes" })
    .getByRole("tab", { name: "Notes", exact: true });
  await expect(notesPane).toBeVisible();
  await notesPane.click();
  await expect(notesEditor).toBeVisible();
}

async function expectNoViewportOverflow(page: Page, expectedScaleFactor: number): Promise<void> {
  const layout = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(layout.innerWidth).toBeGreaterThanOrEqual(960);
  expect(layout.innerHeight).toBeGreaterThanOrEqual(600);
  expect(layout.devicePixelRatio).toBeCloseTo(expectedScaleFactor, 1);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight + 1);
}

async function expectSetupActionsReachable(page: Page): Promise<void> {
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  const actions = page.locator(".setup-card button");
  expect(await actions.count()).toBeGreaterThan(0);
  for (let index = 0; index < await actions.count(); index += 1) {
    const action = actions.nth(index);
    if (!(await action.isVisible())) continue;
    await action.scrollIntoViewIfNeeded();
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth + 1);
  }
  const layout = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".setup-shell");
    return {
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      shellClientWidth: shell?.clientWidth ?? 0,
      shellScrollWidth: shell?.scrollWidth ?? Number.POSITIVE_INFINITY,
    };
  });
  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.documentClientWidth + 1);
  expect(layout.shellScrollWidth).toBeLessThanOrEqual(layout.shellClientWidth + 1);
}

async function activateWithKeyboard(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeEnabled({ timeout: SETUP_PERSISTENCE_TIMEOUT_MS });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      await page.keyboard.press("Enter");
      return;
    }
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

test("renderer is sandboxed behind the exact preload surface", async () => {
  const session = await launchCandor();
  try {
    await expect(session.page.locator('[data-view="activation"]')).toBeVisible();
    await expect.poll(() => session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true);
    const preferences = await session.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const values = window?.webContents.getLastWebPreferences();
      return {
        contextIsolation: values?.contextIsolation,
        sandbox: values?.sandbox,
        nodeIntegration: values?.nodeIntegration,
        webSecurity: values?.webSecurity,
      };
    });
    expect(preferences).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    });

    const renderer = await session.page.evaluate((domainNames) => {
      const candor = window.candor as unknown as Record<string, Record<string, unknown> | number>;
      const domains = Object.fromEntries(
        domainNames.map((name) => [name, Object.keys(candor[name] as Record<string, unknown>).sort()]),
      );
      return {
        globals: {
          require: typeof Reflect.get(window, "require"),
          process: typeof Reflect.get(window, "process"),
          Buffer: typeof Reflect.get(window, "Buffer"),
        },
        topLevel: Object.keys(candor).sort(),
        version: candor.version,
        domains,
      };
    }, Object.keys(expectedPreloadSurface));
    expect(renderer.globals).toEqual({ require: "undefined", process: "undefined", Buffer: "undefined" });
    expect(renderer.version).toBe(4);
    expect(renderer.topLevel).toEqual([...Object.keys(expectedPreloadSurface), "version"].sort());
    for (const [domain, methods] of Object.entries(expectedPreloadSurface)) {
      expect(renderer.domains[domain]).toEqual([...methods].sort());
      expect(renderer.domains[domain]).not.toEqual(expect.arrayContaining(["invoke", "openPath", "readFile", "runProcess", "writeFile"]));
    }

    const setupResponseCustody = await session.page.evaluate(async () => {
      const response = await window.candor!.setup.getStatus();
      return {
        rawPathExposed: response.rawPathExposed,
        keyMaterialExposedToRenderer: response.keyMaterialExposedToRenderer,
      };
    });
    expect(setupResponseCustody).toEqual({
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });

    const shortcutPayload = {
      action: "show-and-focus-recorder",
      recordsAudio: false,
      localOnly: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    } as const;
    await session.page.evaluate(() => {
      Reflect.set(window, "__candorShortcutPayload", null);
      const unsubscribe = window.candor!.events.subscribe("shortcut.triggered", (payload) => {
        Reflect.set(window, "__candorShortcutPayload", payload);
      });
      Reflect.set(window, "__candorShortcutUnsubscribe", unsubscribe);
    });
    const shortcutEventSent = await session.app.evaluate(({ BrowserWindow }, payload) => {
      const webContents = BrowserWindow.getAllWindows()[0]?.webContents;
      if (!webContents) return false;
      webContents.send("candor-events:shortcut-triggered", payload);
      return true;
    }, shortcutPayload);
    expect(shortcutEventSent).toBe(true);
    await expect.poll(() => session.page.evaluate(() => Reflect.get(window, "__candorShortcutPayload")))
      .toEqual(shortcutPayload);
    await session.page.evaluate(() => {
      const unsubscribe = Reflect.get(window, "__candorShortcutUnsubscribe");
      if (typeof unsubscribe === "function") unsubscribe();
    });
    const unsupportedEventRejected = await session.page.evaluate(() => {
      try {
        const subscribe = window.candor!.events.subscribe as unknown as (
          eventName: string,
          listener: (payload: unknown) => void,
        ) => () => void;
        subscribe("recorder.started", () => undefined);
        return false;
      } catch (error) {
        return error instanceof Error && error.message === "Unsupported Candor event";
      }
    });
    expect(unsupportedEventRejected).toBe(true);

    const initialUrl = session.page.url();
    const popupResult = await session.page.evaluate(() => window.open("https://example.com") === null);
    expect(popupResult).toBe(true);
    expect(session.app.windows()).toHaveLength(1);

    const sessionRequestBlocked = await session.app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      try {
        await window.webContents.session.fetch("https://example.com");
        return false;
      } catch {
        return true;
      }
    });
    expect(sessionRequestBlocked).toBe(true);

    await expectNoAxeViolations(session.page);
    await session.page.getByRole("button", { name: "Open local workspace" }).click();
    await expectSetupHeading(session.page, "Set up your microphone");
    await session.page.getByRole("button", { name: "Set up later" }).click();
    await session.page.locator(".setup-defer-confirmation").getByRole("button", { name: "Set up later" }).click();
    await expectSetupHeading(session.page, "Choose a recorder shortcut");
    await session.page.getByRole("button", { name: "Skip for now" }).click();
    await expectSetupHeading(session.page, "Set up system audio");
    await session.page.getByRole("button", { name: "Set up later" }).click();
    await expectSetupHeading(session.page, "Confirm local storage");
    await session.page.getByRole("button", { name: "Set up later" }).click();
    await expectSetupHeading(session.page, "Set up local AI");
    await session.page.getByRole("button", { name: "Finish setup" }).click();
    await expect(session.page.locator('[data-view="home"]')).toBeVisible({ timeout: SETUP_PERSISTENCE_TIMEOUT_MS });
    const darkModeButton = session.page.getByRole("button", { name: "Switch to dark mode" });
    await expect(darkModeButton).toBeVisible();
    await darkModeButton.click();
    await expect(session.page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(session.page.getByRole("button", { name: "Switch to light mode" })).toBeVisible();
    expect(await session.page.evaluate(() => window.localStorage.getItem("candor.appearance"))).toBe("dark");
    await expectNoAxeViolations(session.page);
    await session.page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(session.page.locator("html")).toHaveAttribute("data-theme", "light");
    await session.page.keyboard.press("Tab");
    const focused = await session.page.evaluate(() => document.activeElement !== document.body);
    expect(focused).toBe(true);

    const navigationObserverArmed = await session.app.evaluate(({ BrowserWindow }) => {
      const webContents = BrowserWindow.getAllWindows()[0]?.webContents;
      if (!webContents) return false;
      Reflect.set(globalThis, "__candorE2ENavigation", null);
      webContents.once("will-navigate", (event, url) => {
        setImmediate(() => {
          Reflect.set(globalThis, "__candorE2ENavigation", {
            defaultPrevented: event.defaultPrevented,
            url,
          });
        });
      });
      return true;
    });
    expect(navigationObserverArmed).toBe(true);
    await session.page.evaluate(() => window.location.assign("https://example.com"));
    await expect.poll(() => session.app.evaluate(() => Reflect.get(globalThis, "__candorE2ENavigation"))).toEqual({
      defaultPrevented: true,
      url: "https://example.com/",
    });
    expect(session.page.url()).toBe(initialUrl);
  } finally {
    await session.close();
  }
});

test("setup remains vertically reachable without horizontal clipping at 200% zoom", async () => {
  test.setTimeout(120_000);
  const session = await launchCandor({ width: 1366, height: 768 });
  try {
    await session.page.emulateMedia({ reducedMotion: "reduce" });
    await session.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect.poll(() => session.page.evaluate(() => window.devicePixelRatio)).toBeGreaterThanOrEqual(1.9);
    expect(await session.page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    const openWorkspace = session.page.getByRole("button", { name: "Open local workspace" });
    await activateWithKeyboard(session.page, openWorkspace);

    const microphoneHeading = session.page.getByRole("heading", { name: "Set up your microphone" });
    await expect(microphoneHeading).toBeFocused({ timeout: SETUP_PERSISTENCE_TIMEOUT_MS });
    const motionDurations = await session.page.locator(".microphone-setup-control button").first().evaluate((element) => {
      const milliseconds = (value: string) => Math.max(...value.split(",").map((entry) => {
        const duration = entry.trim();
        return duration.endsWith("ms") ? Number.parseFloat(duration) : Number.parseFloat(duration) * 1_000;
      }));
      const style = getComputedStyle(element);
      return {
        animationMs: milliseconds(style.animationDuration),
        transitionMs: milliseconds(style.transitionDuration),
      };
    });
    expect(motionDurations.animationMs).toBeLessThanOrEqual(0.01);
    expect(motionDurations.transitionMs).toBeLessThanOrEqual(0.01);
    await expectSetupActionsReachable(session.page);
    await expectNoAxeViolations(session.page);
    await activateWithKeyboard(
      session.page,
      session.page.getByRole("button", { name: "Set up later", exact: true }),
    );
    const deferConfirmation = session.page.locator(".setup-defer-confirmation");
    await expect(deferConfirmation).toHaveAccessibleName("Finish microphone setup later?");
    await expectNoAxeViolations(session.page);
    await expect(deferConfirmation.getByRole("button", { name: "Keep setting up" })).toBeFocused();
    await session.page.keyboard.press("Tab");
    await expect(deferConfirmation.getByRole("button", { name: "Set up later" })).toBeFocused();
    await session.page.keyboard.press("Enter");

    await expectSetupHeading(session.page, "Choose a recorder shortcut", true);
    await expectSetupActionsReachable(session.page);
    await expectNoAxeViolations(session.page);
    await activateWithKeyboard(session.page, session.page.getByRole("button", { name: "Skip for now" }));

    await expectSetupHeading(session.page, "Set up system audio", true);
    await expectSetupActionsReachable(session.page);
    await expectNoAxeViolations(session.page);
    await activateWithKeyboard(session.page, session.page.getByRole("button", { name: "Set up later" }));

    await expectSetupHeading(session.page, "Confirm local storage", true);
    await expectSetupActionsReachable(session.page);
    await expectNoAxeViolations(session.page);
    await activateWithKeyboard(session.page, session.page.getByRole("button", { name: "Set up later" }));

    await expectSetupHeading(session.page, "Set up local AI", true);
    await expectSetupActionsReachable(session.page);
    await expectNoAxeViolations(session.page);
    await activateWithKeyboard(session.page, session.page.getByRole("button", { name: "Finish setup" }));
    await expect(session.page.locator('[data-view="home"]')).toBeVisible({ timeout: SETUP_PERSISTENCE_TIMEOUT_MS });

    await session.page.getByRole("button", { name: "Finish setup" }).click();
    await expectSetupHeading(session.page, "Set up your microphone", true);
    await expect(session.page.locator('[aria-label="Microphone, current step, previously deferred"]')).toBeVisible();
    await expectSetupActionsReachable(session.page);
  } finally {
    await session.close();
  }
});

test("back and direct setup navigation persist the active step", async () => {
  const session = await launchCandor();
  try {
    await session.page.getByRole("button", { name: "Open local workspace" }).click();
    await expectSetupHeading(session.page, "Set up your microphone");
    await session.page.getByRole("button", { name: "Back" }).click();
    await expectSetupHeading(session.page, "Candor is yours");
    await expect.poll(async () => {
      const status = await session.page.evaluate(() => window.candor!.setup.getStatus());
      return ((status as Record<string, unknown>).setup as Record<string, unknown>).lastStep;
    }, { timeout: SETUP_PERSISTENCE_TIMEOUT_MS }).toBe("license");

    await session.page.getByRole("button", { name: "Continue setup" }).click();
    await expectSetupHeading(session.page, "Set up your microphone");
    await session.page.getByRole("button", { name: "Set up later" }).click();
    await session.page.locator(".setup-defer-confirmation").getByRole("button", { name: "Set up later" }).click();
    await expectSetupHeading(session.page, "Choose a recorder shortcut");
    await session.page.locator(".setup-wordmark").click();
    await expectSetupHeading(session.page, "Candor is yours");
    await expect.poll(async () => {
      const status = await session.page.evaluate(() => window.candor!.setup.getStatus());
      return ((status as Record<string, unknown>).setup as Record<string, unknown>).lastStep;
    }, { timeout: SETUP_PERSISTENCE_TIMEOUT_MS }).toBe("license");
  } finally {
    await session.close();
  }
});

test("existing meetings remain available while the one-time device setup prompt is persisted", async () => {
  const session = await launchCandor({ seedMeeting: true });
  try {
    await expect(session.page.locator('[data-view="meeting"]')).toBeVisible();
    await expect(session.page.getByRole("heading", { name: "Product Strategy Sync" })).toBeVisible();

    await expect(
      session.page.getByText("Finish device setup when convenient. Your existing meetings remain available."),
    ).toBeVisible({ timeout: SETUP_PERSISTENCE_TIMEOUT_MS });
    await expect.poll(async () => {
      const status = await session.page.evaluate(() => window.candor!.setup.getStatus());
      const setup = (status as Record<string, unknown>).setup as Record<string, unknown> | undefined;
      return {
        existingUserPromptShown: setup?.existingUserPromptShown,
        nonBlockingUpgrade: setup?.nonBlockingUpgrade,
      };
    }).toEqual({
      existingUserPromptShown: true,
      nonBlockingUpgrade: true,
    });

    const primaryNavigation = session.page.getByRole("navigation", { name: "Primary" });
    await primaryNavigation.getByRole("button", { name: "Home", exact: true }).click();
    await expect(session.page.locator('[data-view="home"]')).toBeVisible();
    const homeWarning = session.page.locator(".system-alert", { hasText: "Finish device setup" });
    await expect(homeWarning).toContainText("Existing meetings remain available.");
    await expect(session.page.getByRole("button", { name: /Start recording/ }).first()).toBeVisible();

    await primaryNavigation.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(session.page.locator('[data-view="settings"]')).toBeVisible();
    const settingsWarning = session.page.locator(".system-alert", { hasText: "Finish device setup" });
    await expect(settingsWarning).toContainText("Existing meetings remain available.");
    await expect(session.page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await expectNoAxeViolations(session.page);
  } finally {
    await session.close();
  }
});

test("existing meetings bypass an incomplete non-upgrade setup record", async () => {
  const session = await launchCandor({ seedMeeting: true, seedIncompleteSetup: true });
  try {
    await expect(session.page.locator('[data-view="meeting"]')).toBeVisible();
    await expect(session.page.getByRole("heading", { name: "Product Strategy Sync" })).toBeVisible();
    await expect(
      session.page.getByText("Finish device setup when convenient. Your existing meetings remain available."),
    ).toBeVisible({ timeout: SETUP_PERSISTENCE_TIMEOUT_MS });

    await expect.poll(async () => {
      const status = await session.page.evaluate(() => window.candor!.setup.getStatus());
      const setup = (status as Record<string, unknown>).setup as Record<string, unknown>;
      return {
        progress: setup.progress,
        nonBlockingUpgrade: setup.nonBlockingUpgrade,
        existingUserPromptShown: setup.existingUserPromptShown,
      };
    }, { timeout: SETUP_PERSISTENCE_TIMEOUT_MS }).toEqual({
      progress: "in-progress",
      nonBlockingUpgrade: false,
      existingUserPromptShown: true,
    });

    const primaryNavigation = session.page.getByRole("navigation", { name: "Primary" });
    await primaryNavigation.getByRole("button", { name: "Meetings", exact: true }).click();
    await expect(session.page.locator('[data-view="library"]')).toBeVisible();
    await expect(session.page.getByRole("button", { name: /Product Strategy Sync/ }).last()).toBeVisible();
  } finally {
    await session.close();
  }
});

test("Record, Review, and Export workflow is keyboard-accessible and axe-clean", async () => {
  const session = await launchCandor({ seedMeeting: true });
  try {
    await expect(session.page.locator('[data-view="meeting"]')).toBeVisible();
    await expectMeetingNotesVisible(session.page);
    await expectNoAxeViolations(session.page);

    const primaryNavigation = session.page.getByRole("navigation", { name: "Primary" });
    await primaryNavigation.getByRole("button", { name: "Home", exact: true }).click();
    await expect(session.page.locator('[data-view="home"]')).toBeVisible();
    await expectNoAxeViolations(session.page);

    await primaryNavigation.getByRole("button", { name: "Meetings", exact: true }).click();
    await expect(session.page.locator('[data-view="library"]')).toBeVisible();
    await expectNoAxeViolations(session.page);

    await session.page.getByRole("button", { name: /Product Strategy Sync/ }).last().click();
    await expect(session.page.locator('[data-view="detail"]')).toBeVisible();
    await expect(session.page.getByRole("button", { name: "Review report" })).toBeVisible();
    await expectNoAxeViolations(session.page);

    await session.page.getByRole("button", { name: "Review report" }).click();
    await expect(session.page.locator('[data-view="review"]')).toBeVisible();
    await expectNoAxeViolations(session.page);

    await session.page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(session.page.locator(".review-preview")).toBeVisible();
    await expect(session.page.getByRole("heading", { name: "Report preview", exact: true })).toBeVisible();
    await session.page.getByRole("button", { name: "Close preview" }).click();
    await expect(session.page.locator(".review-preview")).toHaveCount(0);

    await session.page.getByRole("button", { name: "Decisions", exact: true }).click();
    await expect(session.page.getByRole("heading", { name: "Decisions", exact: true })).toBeVisible();
    await session.page.getByRole("button", { name: "Overview", exact: true }).click();

    await session.page.getByRole("button", { name: "Export report" }).click();
    await expect(session.page.locator('[data-view="export"]')).toBeVisible();
    await expect(session.page.getByRole("button", { name: "Save Word" })).toBeVisible();

    await session.page.getByRole("button", { name: /PDF/ }).click();
    await expect(session.page.getByRole("button", { name: "Save PDF" })).toBeVisible();
    await session.page.getByText("Customize report", { exact: true }).click();
    await session.page.getByRole("button", { name: "A4", exact: true }).click();
    await expect(session.page.getByRole("button", { name: "A4", exact: true })).toHaveAttribute("aria-pressed", "true");
    const notesCheckbox = session.page.getByRole("checkbox", { name: "Manual notes" });
    const notesWereIncluded = await notesCheckbox.isChecked();
    await notesCheckbox.click();
    await expect(notesCheckbox).toBeChecked({ checked: !notesWereIncluded });
    await expectNoAxeViolations(session.page);

    await primaryNavigation.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(session.page.locator('[data-view="settings"]')).toBeVisible();
    await expectNoAxeViolations(session.page);

    await session.page.getByRole("navigation", { name: "Open meetings" }).getByRole("button", { name: "Product Strategy Sync", exact: true }).click();
    await expect(session.page.locator('[data-view="meeting"]')).toBeVisible();
    await expectMeetingNotesVisible(session.page);
  } finally {
    await session.close();
  }
});

for (const scaleFactor of [1.25, 1.5]) {
  test(`1366x768 remains usable at ${scaleFactor * 100}% scale`, async () => {
    test.skip(
      process.platform === "darwin",
      "Chromium's forced device scale factor is not a valid macOS display-scaling control.",
    );
    const session: CandorElectronSession = await launchCandor({
      seedMeeting: true,
      width: 1366,
      height: 768,
      scaleFactor,
    });
    try {
      await expect(session.page.locator('[data-view="meeting"]')).toBeVisible();
      const primaryNavigation = session.page.getByRole("navigation", { name: "Primary" });
      await primaryNavigation.getByRole("button", { name: "Home", exact: true }).click();
      await expect(session.page.locator('[data-view="home"]')).toBeVisible();
      await expect(session.page.getByRole("button", { name: /Start recording/ }).first()).toBeVisible();
      await expect(primaryNavigation.getByRole("button", { name: "Meetings", exact: true })).toBeVisible();
      await expectNoViewportOverflow(session.page, scaleFactor);
      await session.page.screenshot({
        path: path.join("release-v3", "proofs", `playwright-home-scale-${Math.round(scaleFactor * 100)}.png`),
        fullPage: false,
      });
    } finally {
      await session.close();
    }
  });
}
