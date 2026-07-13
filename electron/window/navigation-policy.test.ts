import { describe, expect, it } from "vitest";
import path from "node:path";
import { createRendererNavigationPolicy, isLoopbackHttpUrl } from "./navigation-policy.js";

describe("renderer navigation policy", () => {
  it("accepts only credential-free loopback development URLs", () => {
    expect(isLoopbackHttpUrl("http://127.0.0.1:5173")).toBe(true);
    expect(isLoopbackHttpUrl("http://localhost:5173")).toBe(true);
    expect(isLoopbackHttpUrl("https://127.0.0.1:5173")).toBe(false);
    expect(isLoopbackHttpUrl("http://user:pass@127.0.0.1:5173")).toBe(false);
    expect(isLoopbackHttpUrl("http://example.com:5173")).toBe(false);
  });

  it("pins packaged navigation to the renderer document", () => {
    const policy = createRendererNavigationPolicy({
      isDev: false,
      electronOutputDir: path.resolve("dist-v3", "electron"),
    });

    expect(policy.isNavigationAllowed(policy.rendererFileUrl)).toBe(true);
    expect(policy.isNavigationAllowed(`${policy.rendererFileUrl}#meeting`)).toBe(true);
    expect(policy.isNavigationAllowed("file:///C:/Windows/win.ini")).toBe(false);
    expect(policy.isNavigationAllowed("https://example.com")).toBe(false);
  });

  it("limits development requests and navigation to the configured origin", () => {
    const policy = createRendererNavigationPolicy({
      isDev: true,
      electronOutputDir: path.resolve("dist-v3", "electron"),
      configuredDevUrl: "http://127.0.0.1:5181",
    });

    expect(policy.isDevRequest("ws://127.0.0.1:5181/hmr")).toBe(true);
    expect(policy.isDevRequest("http://127.0.0.1:5181/src/main.tsx")).toBe(true);
    expect(policy.isDevRequest("http://127.0.0.1:5182/src/main.tsx")).toBe(false);
    expect(policy.isNavigationAllowed("http://127.0.0.1:5181/meeting")).toBe(true);
    expect(policy.isNavigationAllowed("file:///C:/Windows/win.ini")).toBe(false);
  });

  it("fails closed for an external development URL", () => {
    expect(() =>
      createRendererNavigationPolicy({
        isDev: true,
        electronOutputDir: path.resolve("dist-v3", "electron"),
        configuredDevUrl: "http://example.com:5173",
      }),
    ).toThrow("loopback HTTP");
  });
});
