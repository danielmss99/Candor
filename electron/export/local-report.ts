import { createHash } from "node:crypto";
import path from "node:path";
import { objectValue, stringField, type JsonValue } from "../core/json.js";

export type LocalReportFormat = "markdown" | "docx" | "pdf";

export interface LocalExportSpecification {
  extension: string;
  mimeType: string;
  filterName: string;
}

export const localExportSpecifications: Record<LocalReportFormat, LocalExportSpecification> = {
  markdown: {
    extension: "md",
    mimeType: "text/markdown; charset=utf-8",
    filterName: "Markdown document",
  },
  docx: {
    extension: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filterName: "Microsoft Word document",
  },
  pdf: {
    extension: "pdf",
    mimeType: "application/pdf",
    filterName: "PDF document",
  },
};

export const MAX_LOCAL_EXPORT_INPUT_BYTES = 768 * 1024;
export const MAX_LOCAL_EXPORT_BYTES = 16 * 1024 * 1024;

export interface DecodedLocalExport {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
}

export function localReportFormat(value: JsonValue): LocalReportFormat | null {
  return value === "markdown" || value === "docx" || value === "pdf" ? value : null;
}

export function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function numberField(value: JsonValue, field: string): number {
  const child = objectValue(value)[field];
  return typeof child === "number" && Number.isSafeInteger(child) ? child : -1;
}

export function decodeLocalExportResult(format: LocalReportFormat, result: JsonValue): DecodedLocalExport {
  const resultObject = objectValue(result);
  const specification = localExportSpecifications[format];
  if (stringField(result, "format") !== format) {
    throw new Error("candor-core returned an unexpected export format.");
  }
  if (stringField(result, "mimeType") !== specification.mimeType) {
    throw new Error("candor-core returned an unexpected export MIME type.");
  }
  if (
    resultObject.generatedLocally !== true ||
    resultObject.networkAttempted !== false ||
    resultObject.rawPathExposed !== false ||
    resultObject.keyMaterialExposedToRenderer !== false
  ) {
    throw new Error("candor-core did not return the required local export custody facts.");
  }

  let bytes: Buffer;
  if (format === "markdown") {
    bytes = Buffer.from(stringField(result, "markdown"), "utf8");
  } else {
    const dataBase64 = stringField(result, "dataBase64");
    if (!dataBase64 || dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
      throw new Error("candor-core returned invalid document bytes.");
    }
    bytes = Buffer.from(dataBase64, "base64");
    if (bytes.toString("base64") !== dataBase64) {
      throw new Error("candor-core returned non-canonical document bytes.");
    }
  }

  const declaredBytes = numberField(result, "bytes");
  if (bytes.length === 0 || declaredBytes !== bytes.length || bytes.length > MAX_LOCAL_EXPORT_BYTES) {
    throw new Error("candor-core returned an invalid local export size.");
  }
  if (format === "docx" && bytes.subarray(0, 2).toString("ascii") !== "PK") {
    throw new Error("candor-core did not return a native DOCX package.");
  }
  if (format === "pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("candor-core did not return a PDF document.");
  }

  const rawName = stringField(result, "fileName");
  const baseName = path.basename(rawName || `candor-report.${specification.extension}`);
  const fileName = baseName.toLowerCase().endsWith(`.${specification.extension}`)
    ? baseName
    : `${baseName}.${specification.extension}`;
  return { bytes, fileName, mimeType: specification.mimeType };
}
