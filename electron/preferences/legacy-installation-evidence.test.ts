import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLegacyInstallationEvidenceDetector } from "./legacy-installation-evidence.js";

describe("legacy installation evidence", () => {
  it("does not classify a new first launch from generic user-data existence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-legacy-new-"));
    try {
      const userData = path.join(root, "electron-user-data");
      const coreData = path.join(root, "candor-core-data");
      await mkdir(userData);
      await writeFile(path.join(userData, "Chromium Cache"), "generic", "utf8");
      const detect = createLegacyInstallationEvidenceDetector({
        userDataPath: () => userData,
        coreDataPath: () => coreData,
      });
      await expect(detect()).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies an exact pre-existing empty Candor core root as an upgrade", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-legacy-empty-core-"));
    try {
      const coreData = path.join(root, "Candor", "v3");
      await mkdir(coreData, { recursive: true });
      const detect = createLegacyInstallationEvidenceDetector({
        userDataPath: () => path.join(root, "electron-user-data"),
        coreDataPath: () => coreData,
      });
      await expect(detect()).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies quarantined-only recording state in a pre-created harness root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-legacy-quarantine-"));
    try {
      const coreData = path.join(root, "core-data");
      await mkdir(path.join(coreData, "recordings", "quarantined-recording"), { recursive: true });
      const detect = createLegacyInstallationEvidenceDetector({
        userDataPath: () => path.join(root, "electron-user-data"),
        coreDataPath: () => coreData,
        coreRootExistenceIsEvidence: false,
      });
      await expect(detect()).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
