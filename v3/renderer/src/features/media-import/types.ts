export interface MediaImportResult {
  canceled: boolean;
  imported: boolean;
  failureCode: string | null;
  recordingId: string | null;
  jobId: string | null;
  localOnly: true;
  networkAttempted: false;
  rawPathExposed: false;
  keyMaterialExposedToRenderer: false;
}

export type MediaImportState =
  | { status: "idle" }
  | { status: "importing" }
  | { status: "imported" }
  | { status: "canceled" }
  | { status: "unsupported-decoder" }
  | { status: "error"; message: string };

export type ImportMedia = () => Promise<MediaImportResult>;
