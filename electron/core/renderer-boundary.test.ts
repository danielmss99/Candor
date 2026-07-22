import { describe, expect, it } from "vitest";
import { rendererSafeCoreError, sanitizeCoreResultForRenderer } from "./renderer-boundary.js";

describe("renderer core boundary", () => {
  it("forwards only bounded structured error codes", () => {
    expect(rendererSafeCoreError("CONSENT_REQUIRED").message).toBe(
      "CANDOR_CORE_ERROR:CONSENT_REQUIRED",
    );
    expect(rendererSafeCoreError("C:\\Users\\private\\vault.db").message).toBe(
      "CANDOR_CORE_ERROR:CORE_REQUEST_FAILED",
    );
    expect(rendererSafeCoreError("A".repeat(65)).message).toBe(
      "CANDOR_CORE_ERROR:CORE_REQUEST_FAILED",
    );
  });

  it("removes process identity from renderer core status", () => {
    expect(sanitizeCoreResultForRenderer("core.status", {
      pid: 1234,
      version: "0.1.0",
      rawPathExposed: false,
    })).toEqual({ version: "0.1.0", rawPathExposed: false });
    expect(sanitizeCoreResultForRenderer("capture.status", { pid: 1234 })).toEqual({ pid: 1234 });
  });

  it("reconstructs exact renderer results from reviewed fields", () => {
    expect(sanitizeCoreResultForRenderer("capture.status", {
      implemented: true,
      active: false,
      sources: {},
      privateTelemetry: "drop-me",
    }, ["implemented", "active", "sources"])).toEqual({
      implemented: true,
      active: false,
      sources: {},
    });
  });
});
