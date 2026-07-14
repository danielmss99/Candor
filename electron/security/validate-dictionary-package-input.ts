import path from "node:path";

export const MAX_DICTIONARY_PACKAGE_BYTES = 2_500_000;

export interface ValidatedDictionaryPackageInput {
  sourceFileName: string;
  bytes: Buffer;
}

export function validateDictionaryPackageInput(input: unknown): ValidatedDictionaryPackageInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The dictionary package request is invalid.");
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some((key) => key !== "sourceFileName" && key !== "archiveBytes")
    || keys.length !== 2
  ) {
    throw new Error("The dictionary package request has unsupported fields.");
  }
  if (
    typeof record.sourceFileName !== "string"
    || !record.sourceFileName
    || record.sourceFileName.length > 150
    || path.basename(record.sourceFileName) !== record.sourceFileName
    || path.extname(record.sourceFileName).toLowerCase() !== ".candordict"
  ) {
    throw new Error("The dropped file must be a CANDORDICT package.");
  }
  if (!(record.archiveBytes instanceof Uint8Array)) {
    throw new Error("The dictionary package data is invalid.");
  }
  if (
    record.archiveBytes.byteLength === 0
    || record.archiveBytes.byteLength > MAX_DICTIONARY_PACKAGE_BYTES
  ) {
    throw new Error("The dictionary package exceeds the local size limit.");
  }
  return {
    sourceFileName: record.sourceFileName,
    bytes: Buffer.from(record.archiveBytes),
  };
}
