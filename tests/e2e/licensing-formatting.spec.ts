import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchCandor } from "./candor-electron";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const evidenceRoot = path.join(repoRoot, "release-v3", "proofs", "licensing-formatting");
const viewports = [
  { id: "reported-1753x1131", width: 1753, height: 1131 },
  { id: "laptop-1366x768", width: 1366, height: 768 },
] as const;

async function expectReadableActivationPromises(page: Page): Promise<void> {
  const metrics = await page.locator(".activation-proof-grid").evaluate((grid) => {
    const gridRect = grid.getBoundingClientRect();
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean);
    const articles = Array.from(grid.querySelectorAll<HTMLElement>("article")).map((article) => {
      const body = article.querySelector<HTMLElement>("span");
      const articleRect = article.getBoundingClientRect();
      const bodyRect = body?.getBoundingClientRect();
      return {
        width: articleRect.width,
        bodyWidth: bodyRect?.width ?? 0,
        horizontalOverflow: article.scrollWidth > article.clientWidth + 1,
        verticalOverflow: article.scrollHeight > article.clientHeight + 1,
      };
    });
    return { gridWidth: gridRect.width, columns, articles };
  });

  expect(metrics.columns).toHaveLength(1);
  expect(metrics.articles).toHaveLength(3);
  for (const article of metrics.articles) {
    expect(article.width).toBeGreaterThanOrEqual(metrics.gridWidth - 1);
    expect(article.bodyWidth).toBeGreaterThanOrEqual(160);
    expect(article.horizontalOverflow).toBe(false);
    expect(article.verticalOverflow).toBe(false);
  }
}

async function expectNoClippedOnboardingText(page: Page): Promise<void> {
  const issues = await page.locator('[data-view="onboarding"]').evaluate((root) => {
    const candidates = root.querySelectorAll<HTMLElement>("h1, p, strong, dt, dd, button");
    return Array.from(candidates).flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return [];
      const style = getComputedStyle(element);
      const ellipsized = style.textOverflow === "ellipsis";
      const clipped = element.scrollWidth > element.clientWidth + 1
        || element.scrollHeight > element.clientHeight + 1;
      return clipped && !ellipsized
        ? [{
            text: element.innerText.trim().replace(/\s+/g, " "),
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
          }]
        : [];
    });
  });
  expect(issues).toEqual([]);
}

test("the first two licensing screens keep readable desktop formatting", async () => {
  test.setTimeout(180_000);
  mkdirSync(evidenceRoot, { recursive: true });

  for (const viewport of viewports) {
    const session = await launchCandor(viewport);
    try {
      await expect(session.page.locator('[data-view="activation"]')).toBeVisible();
      await expectReadableActivationPromises(session.page);
      const directory = path.join(evidenceRoot, viewport.id);
      mkdirSync(directory, { recursive: true });
      await session.page.screenshot({
        path: path.join(directory, "activation.png"),
        animations: "disabled",
        caret: "hide",
      });

      await session.page.getByRole("button", { name: "Start Trial" }).click();
      await expect(session.page.locator('[data-view="onboarding"]')).toBeVisible();
      await expect(session.page.getByRole("heading", { name: "Candor is yours" })).toBeVisible();
      await expectNoClippedOnboardingText(session.page);
      await session.page.screenshot({
        path: path.join(directory, "onboarding-yours.png"),
        animations: "disabled",
        caret: "hide",
      });
    } finally {
      await session.close();
    }
  }
});
