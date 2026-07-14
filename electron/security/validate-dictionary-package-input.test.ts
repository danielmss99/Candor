import { describe, expect, it } from "vitest";
import {
  MAX_DICTIONARY_PACKAGE_BYTES,
  validateDictionaryPackageInput,
} from "./validate-dictionary-package-input.js";

describe("validateDictionaryPackageInput", () => {
  it("accepts a bounded pathless package payload", () => {
    const input = validateDictionaryPackageInput({
      sourceFileName: "pharmaceutics.candordict",
      archiveBytes: new Uint8Array([1, 2, 3]),
    });
    expect(input.sourceFileName).toBe("pharmaceutics.candordict");
    expect([...input.bytes]).toEqual([1, 2, 3]);
  });

  it.each([
    "../pharmaceutics.candordict",
    "folder/pharmaceutics.candordict",
    "pharmaceutics.zip",
  ])("rejects unsafe or unsupported names: %s", (sourceFileName) => {
    expect(() => validateDictionaryPackageInput({
      sourceFileName,
      archiveBytes: new Uint8Array([1]),
    })).toThrow();
  });

  it("rejects extra fields and oversized payloads", () => {
    expect(() => validateDictionaryPackageInput({
      sourceFileName: "safe.candordict",
      archiveBytes: new Uint8Array([1]),
      path: "C:\\private",
    })).toThrow(/unsupported fields/i);
    expect(() => validateDictionaryPackageInput({
      sourceFileName: "safe.candordict",
      archiveBytes: new Uint8Array(MAX_DICTIONARY_PACKAGE_BYTES + 1),
    })).toThrow(/size limit/i);
  });
});
