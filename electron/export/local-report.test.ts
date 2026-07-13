import { describe, expect, it } from "vitest";
import { decodeLocalExportResult, localExportSpecifications } from "./local-report.js";

describe("local report decoding", () => {
  it("decodes local Markdown and strips path traversal from filenames", () => {
    const markdown = "# Meeting";
    const decoded = decodeLocalExportResult("markdown", {
      format: "markdown",
      mimeType: localExportSpecifications.markdown.mimeType,
      fileName: "../meeting.md",
      markdown,
      bytes: Buffer.byteLength(markdown),
      generatedLocally: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });
    expect(decoded.fileName).toBe("meeting.md");
    expect(decoded.bytes.toString("utf8")).toBe(markdown);
  });

  it("rejects mismatched custody facts and fake documents", () => {
    expect(() =>
      decodeLocalExportResult("pdf", {
        format: "pdf",
        mimeType: localExportSpecifications.pdf.mimeType,
        fileName: "meeting.pdf",
        dataBase64: Buffer.from("not a pdf").toString("base64"),
        bytes: 9,
        generatedLocally: true,
        networkAttempted: false,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      }),
    ).toThrow("PDF document");
  });
});
