import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { launchCandor, type CandorElectronSession } from "./candor-electron";

const expectedPreloadSurface = {
  app: ["acknowledgeJob", "getCapabilities", "getConnectionStatus", "getJob", "getStatus", "getVersion", "listJobs", "prepareDiagnostics", "retryCore", "saveDiagnostics"],
  capture: ["acknowledgeConsent", "getConsent", "getDevices", "getStatus", "recover", "start", "stop"],
  meetings: ["delete", "get", "getImportStatus", "getNotes", "getPrivacyReceipt", "getReplayManifest", "getStorageStatus", "getTranscript", "importLegacy", "list", "readAudioChunk", "search", "updateNotes"],
  transcript: ["cancel", "getStatus", "start"],
  ai: ["ask", "cancel", "chooseEnhancedComponent", "chooseSpeechModel", "generateRecap", "getBundledAssetsStatus", "getEnhancedAssetsStatus", "getEnhancedStatus", "getStatus", "getWorkloadStatus", "listSpeechModels", "verifySpeechModel"],
  exports: ["cancel", "create", "saveCompleted"],
  settings: ["getNetworkPolicy", "getPrivacyAudit", "getRetentionStatus", "getStorageStatus", "getUpdateStatus", "openLocalStorage"],
  licensing: ["activate", "deactivate", "getPortalInfo", "getStatus", "startTrial"],
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

test("renderer is sandboxed behind the exact preload surface", async () => {
  const session = await launchCandor();
  try {
    await expect(session.page.locator('[data-view="activation"]')).toBeVisible();
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
    expect(renderer.version).toBe(2);
    expect(renderer.topLevel).toEqual([...Object.keys(expectedPreloadSurface), "version"].sort());
    for (const [domain, methods] of Object.entries(expectedPreloadSurface)) {
      expect(renderer.domains[domain]).toEqual([...methods].sort());
      expect(renderer.domains[domain]).not.toEqual(expect.arrayContaining(["invoke", "openPath", "readFile", "runProcess", "writeFile"]));
    }

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
    await expect(session.page.locator('[data-view="home"]')).toBeVisible();
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

    await session.page.getByRole("button", { name: "Export report" }).click();
    await expect(session.page.locator('[data-view="export"]')).toBeVisible();
    await expect(session.page.getByRole("button", { name: "Save Word" })).toBeVisible();
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
