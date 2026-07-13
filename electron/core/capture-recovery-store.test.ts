import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CaptureRecoveryStore } from "./capture-recovery-store.js";

describe("capture recovery store", () => {
  it("persists only bounded recovery metadata and clears it after reconnection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "candor-capture-recovery-"));
    try {
      const store = new CaptureRecoveryStore(() => root);
      await store.persist({
        at: "2026-07-13T12:00:00.000Z",
        method: "capture.stop",
        recordingId: "recording_123",
        lastConfirmedActive: true,
      });
      expect(await store.read()).toMatchObject({
        recoveryRequired: true,
        method: "capture.stop",
        recordingId: "recording_123",
        rawPathExposed: false,
      });
      const serialized = await readFile(path.join(root, "recovery", "capture-connection.json"), "utf8");
      expect(serialized).not.toContain(root);
      expect(serialized).not.toContain("audio");
      expect(serialized).not.toContain("transcript");
      await store.clear();
      expect(await store.read()).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
