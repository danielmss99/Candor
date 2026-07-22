import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseShortcutTriggeredPayload,
  withRendererCustody,
} from "./preload-response-contract.cjs";

describe("preload V4 renderer contracts", () => {
  it("routes every renderer IPC request through the single custody boundary", () => {
    const preloadSource = readFileSync(
      fileURLToPath(new URL("./preload.cts", import.meta.url)),
      "utf8",
    );
    expect(preloadSource.match(/ipcRenderer\.invoke\(/gu)).toHaveLength(1);
    expect(preloadSource).toContain("withRendererCustody(await ipcRenderer.invoke(channel, params))");
  });

  it("adds the complete custody receipt without mutating a legacy response", () => {
    const legacy = { version: "0.4.0" };
    const result = withRendererCustody(legacy);

    expect(result).toEqual({
      version: "0.4.0",
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });
    expect(legacy).toEqual({ version: "0.4.0" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    null,
    "string",
    [],
    { rawPathExposed: true },
    { rawPathExposed: "unknown" },
    { keyMaterialExposedToRenderer: true },
    { keyMaterialExposedToRenderer: null },
  ])("rejects a response that cannot satisfy renderer custody", (value) => {
    expect(() => withRendererCustody(value)).toThrow(/invalid|unsafe/);
  });

  it.each([
    { privatePath: "C:\\Users\\private\\vault" },
    { devices: [{ rawDevicePath: "C:\\private\\microphone" }] },
    { nested: { privateKey: "secret-key" } },
    { nested: { publicKeyBase64: "AA==" } },
    { nested: [{ clientSecret: "secret" }] },
    { nested: { accessToken: "token" } },
    { nested: [{ keyMaterial: "material" }] },
  ])("rejects structurally sensitive fields at any response depth", (injected) => {
    expect(() => withRendererCustody({
      implemented: true,
      ...injected,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    })).toThrow(/unsafe/);
  });

  it("does not scan transcript text values for path-like content", () => {
    const transcript = "Open C:\\Users\\Danny\\Documents\\meeting.txt, then discuss the access token.";
    expect(withRendererCustody({ transcript })).toMatchObject({
      transcript,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });
  });

  it("preserves reviewed renderer metadata and false negative receipts", () => {
    expect(withRendererCustody({
      previewToken: "a".repeat(64),
      signatureKeyId: "candor-dictionary-1",
      osKeyStorageAvailable: true,
      osKeyStorage: "dpapi",
      osKeyBackend: "windows-credential-manager",
      osKeyCreated: true,
      keyId: "candor-dictionaries-2026",
      contextTokens: 2_048,
      contextTokensEnv: "CANDOR_LLAMA_CONTEXT_TOKENS",
      rawPathsIncluded: false,
      secretsIncluded: false,
      rendererPathAccepted: false,
      sourcePathAcceptedFromRenderer: false,
      sourcePathExposed: false,
      managedPathExposed: false,
      promptPathExposed: false,
      rendererRawPathAccess: false,
    })).toMatchObject({
      previewToken: "a".repeat(64),
      signatureKeyId: "candor-dictionary-1",
      osKeyStorageAvailable: true,
      osKeyStorage: "dpapi",
      osKeyBackend: "windows-credential-manager",
      osKeyCreated: true,
      keyId: "candor-dictionaries-2026",
      contextTokens: 2_048,
      contextTokensEnv: "CANDOR_LLAMA_CONTEXT_TOKENS",
      rawPathsIncluded: false,
      secretsIncluded: false,
      rendererPathAccepted: false,
      sourcePathAcceptedFromRenderer: false,
      sourcePathExposed: false,
      managedPathExposed: false,
      promptPathExposed: false,
      rendererRawPathAccess: false,
    });
  });

  it("accepts only the exact fixed shortcut payload and reconstructs it", () => {
    const payload = {
      action: "show-and-focus-recorder",
      recordsAudio: false,
      localOnly: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
    const result = parseShortcutTriggeredPayload(payload);

    expect(result).toEqual(payload);
    expect(result).not.toBe(payload);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    {},
    {
      action: "start-recording",
      recordsAudio: true,
      localOnly: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    },
    {
      action: "show-and-focus-recorder",
      recordsAudio: false,
      localOnly: true,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
      rawPath: "C:/private",
    },
  ])("rejects malformed or expanded shortcut event payloads", (payload) => {
    expect(parseShortcutTriggeredPayload(payload)).toBeNull();
  });
});
