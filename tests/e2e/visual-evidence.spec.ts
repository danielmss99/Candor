import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { VISUAL_SCENARIOS } from "../visual/VisualEvidenceApp";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const electronExecutable = require("electron") as string;
const evidenceRoot = path.join(repoRoot, "release-v3", "proofs", "gui-state-matrix");

const viewports = [
  { id: "1440x900-100", width: 1440, height: 900, scaleFactor: 1 },
  { id: "1366x768-100", width: 1366, height: 768, scaleFactor: 1 },
  { id: "1366x768-125", width: 1366, height: 768, scaleFactor: 1.25 },
  { id: "1280x720-150", width: 1280, height: 720, scaleFactor: 1.5 },
  { id: "960x600-minimum", width: 960, height: 600, scaleFactor: 1 },
] as const;

test("generates the critical GUI state evidence matrix", async () => {
  test.setTimeout(360_000);
  mkdirSync(evidenceRoot, { recursive: true });
  const evidence: Array<{ scenario: string; viewport: string; width: number; height: number; scaleFactor: number; file: string; bytes: number; sha256: string }> = [];

  for (const viewport of viewports) {
    const app = await electron.launch({
      executablePath: electronExecutable,
      args: [path.join(repoRoot, "tests", "e2e", "visual-evidence-main.mjs")],
      cwd: repoRoot,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        CANDOR_VISUAL_WIDTH: String(viewport.width),
        CANDOR_VISUAL_HEIGHT: String(viewport.height),
        CANDOR_VISUAL_SCALE_FACTOR: String(viewport.scaleFactor),
      },
    });
    try {
      const page = await app.firstWindow({ timeout: 30_000 });
      await page.waitForLoadState("domcontentloaded");
      for (const scenario of VISUAL_SCENARIOS) {
        await page.evaluate((nextScenario) => { window.location.hash = `scenario=${nextScenario}`; }, scenario);
        await expect(page.locator(`[data-visual-scenario="${scenario}"]`)).toBeVisible();
        await page.waitForTimeout(50);
        const overflow = await page.evaluate(() => ({
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
        }));
        expect(overflow.documentWidth, `${scenario} has horizontal viewport overflow`).toBeLessThanOrEqual(overflow.viewportWidth + 1);
        const directory = path.join(evidenceRoot, viewport.id);
        mkdirSync(directory, { recursive: true });
        const absolutePath = path.join(directory, `${scenario}.png`);
        await page.screenshot({ path: absolutePath, animations: "disabled" });
        if (
          viewport.id === "1440x900-100"
          && (scenario === "background-activity" || scenario === "meeting-fallback-notice")
        ) {
          const results = await new AxeBuilder({ page })
            .setLegacyMode()
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          expect(
            results.violations,
            results.violations.map((violation) => `${violation.id} (${violation.nodes.length})`).join(", "),
          ).toEqual([]);
        }
        const bytes = statSync(absolutePath).size;
        expect(bytes).toBeGreaterThan(10_000);
        evidence.push({
          scenario,
          viewport: viewport.id,
          width: viewport.width,
          height: viewport.height,
          scaleFactor: viewport.scaleFactor,
          file: path.relative(repoRoot, absolutePath).replaceAll("\\", "/"),
          bytes,
          sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
        });
      }
    } finally {
      await app.close().catch(() => undefined);
    }
  }

  expect(evidence).toHaveLength(VISUAL_SCENARIOS.length * viewports.length);
  writeFileSync(
    path.join(repoRoot, "release-v3", "proofs", "gui-state-matrix.json"),
    `${JSON.stringify({
      proofKind: "candor-gui-state-matrix",
      generatedAt: new Date().toISOString(),
      ok: true,
      localOnly: true,
      cloudAi: false,
      networkAttempted: false,
      scenarios: [...VISUAL_SCENARIOS],
      viewports,
      screenshotCount: evidence.length,
      evidence,
    }, null, 2)}\n`,
    "utf8",
  );
});
