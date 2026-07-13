import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["line"]],
  outputDir: "release-v3/playwright-results",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
