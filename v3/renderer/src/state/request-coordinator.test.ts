import { describe, expect, it } from "vitest";
import { ExclusiveActionRegistry, RequestCoordinator } from "./request-coordinator";

describe("RequestCoordinator", () => {
  it("prevents stale meeting responses from replacing the current meeting", () => {
    const coordinator = new RequestCoordinator();
    const first = coordinator.begin("selected-meeting");
    const second = coordinator.begin("selected-meeting");
    expect(coordinator.isCurrent(first)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);
  });

  it("invalidates pending work on cancellation", () => {
    const coordinator = new RequestCoordinator();
    const token = coordinator.begin("local-ai");
    coordinator.invalidate("local-ai");
    expect(coordinator.isCurrent(token)).toBe(false);
  });
});

describe("ExclusiveActionRegistry", () => {
  it("blocks duplicate capture and notes-save commands until release", () => {
    const registry = new ExclusiveActionRegistry();
    const releaseCapture = registry.acquire("capture");
    expect(releaseCapture).not.toBeNull();
    expect(registry.acquire("capture")).toBeNull();
    expect(registry.acquire("notes-save")).not.toBeNull();
    releaseCapture?.();
    expect(registry.acquire("capture")).not.toBeNull();
  });

  it("serializes notes and export writes through one document scope", () => {
    const registry = new ExclusiveActionRegistry();
    const release = registry.acquire("document-write");
    expect(release).not.toBeNull();
    expect(registry.acquire("document-write")).toBeNull();
    release?.();
    expect(registry.acquire("document-write")).not.toBeNull();
  });
});
