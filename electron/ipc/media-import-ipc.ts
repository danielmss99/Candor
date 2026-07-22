import { dialog, ipcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { CoreClient } from "../core/core-client.js";
import { objectValue, type JsonValue } from "../core/json.js";
import { validateIpcSender, type MainWindowProvider } from "../security/validate-sender.js";
import type { IpcHandlerRegistrar } from "./setup-ipc.js";

export const MEDIA_IMPORT_IPC_CHANNEL = "candor-meetings:importMedia";

const MEDIA_IMPORT_OPTIONS: OpenDialogOptions = {
  title: "Import recorded media",
  buttonLabel: "Import",
  properties: ["openFile"],
  filters: [
    { name: "Supported media", extensions: ["wav", "mp3", "m4a", "mp4", "webm"] },
  ],
};

export const MEDIA_IMPORT_DIALOG_OPTIONS: Readonly<OpenDialogOptions> = Object.freeze(MEDIA_IMPORT_OPTIONS);

const SUPPORTED_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".mp4", ".webm"]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOWERCASE_SHA256 = /^[a-f0-9]{64}$/;
export const MEDIA_SOURCE_HASH_CHUNK_BYTES = 512 * 1024;
export const MEDIA_SOURCE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const MEDIA_SOURCE_HASH_TIMEOUT_MS = 5 * 60 * 1_000;
export const MEDIA_IMPORT_POLL_TIMEOUT_MS = 13 * 60 * 60 * 1_000;
export const MEDIA_IMPORT_CANCEL_CONFIRM_TIMEOUT_MS = 10_000;
const MEDIA_IMPORT_CANCEL_CONFIRM_DELAY_MS = 50;
const UNSUPPORTED_DECODER_CODES = new Set([
  "MEDIA_DECODER_UNSUPPORTED",
  "MEDIA_IMPORT_CODEC_UNSUPPORTED",
  "MEDIA_IMPORT_DECODER_UNAVAILABLE",
  "UNSUPPORTED_DECODER",
  "DECODER_UNAVAILABLE",
]);

interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

type ShowMediaImportDialog = (
  window: ReturnType<MainWindowProvider>,
  options: OpenDialogOptions,
) => Promise<OpenDialogResult>;

interface PathInspection {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

type InspectPath = (sourcePath: string) => Promise<PathInspection>;
type CanonicalizePath = (sourcePath: string) => Promise<string>;
type PollDelay = (milliseconds: number) => Promise<void>;

interface MediaHashFileStat {
  size: number;
  isFile(): boolean;
}

interface MediaHashFileHandle {
  stat(): Promise<MediaHashFileStat>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

interface MediaSourceHashDependencies {
  now?: () => number;
  openFile?: (sourcePath: string) => Promise<MediaHashFileHandle>;
  allocateBuffer?: (bytes: number) => Buffer;
}

export interface MediaSourceHashResult {
  sourceSha256: string;
  sourceSizeBytes: number;
}

type HashMediaSource = (
  sourcePath: string,
  core: Pick<CoreClient, "captureGuardPhase">,
  signal: AbortSignal,
) => Promise<MediaSourceHashResult>;

type MediaImportFlowErrorCode =
  | "MEDIA_IMPORT_CANCELLED"
  | "MEDIA_IMPORT_HASH_TIMEOUT"
  | "MEDIA_IMPORT_SOURCE_CHANGED"
  | "MEDIA_IMPORT_SOURCE_NOT_FILE"
  | "MEDIA_IMPORT_EMPTY"
  | "MEDIA_IMPORT_TOO_LARGE"
  | "MEDIA_IMPORT_SOURCE_UNAVAILABLE"
  | "MEDIA_IMPORT_TIMEOUT"
  | "RECORDING_PRIORITY";

export class MediaImportFlowError extends Error {
  constructor(readonly code: MediaImportFlowErrorCode, message: string) {
    super(message);
    this.name = "MediaImportFlowError";
  }
}

export interface MediaImportIpcDependencies {
  core: Pick<CoreClient, "call" | "captureGuardPhase">
    & Partial<Pick<CoreClient, "subscribe">>;
  getMainWindow: MainWindowProvider;
  ipc?: IpcHandlerRegistrar;
  validateSender?: typeof validateIpcSender;
  showOpenDialog?: ShowMediaImportDialog;
  lstatPath?: InspectPath;
  realpathPath?: CanonicalizePath;
  statPath?: InspectPath;
  pollDelay?: PollDelay;
  pollNow?: () => number;
  cancelNow?: () => number;
  hashMediaSource?: HashMediaSource;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new MediaImportFlowError("MEDIA_IMPORT_CANCELLED", "media import was cancelled");
  }
}

function assertCaptureIdle(core: Pick<CoreClient, "captureGuardPhase">): void {
  if (core.captureGuardPhase() !== "idle") {
    throw new MediaImportFlowError("RECORDING_PRIORITY", "recording has priority over media import");
  }
}

function hashTimeout(): MediaImportFlowError {
  return new MediaImportFlowError(
    "MEDIA_IMPORT_HASH_TIMEOUT",
    "local media hashing exceeded its fixed wall-clock limit",
  );
}

function assertHashDeadline(deadline: number, now: () => number): void {
  if (now() >= deadline) throw hashTimeout();
}

function awaitBeforeHashDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  signal: AbortSignal,
  now: () => number,
): Promise<T> {
  assertNotAborted(signal);
  const remaining = deadline - now();
  if (remaining <= 0) return Promise.reject(hashTimeout());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(
      new MediaImportFlowError("MEDIA_IMPORT_CANCELLED", "media import was cancelled"),
    ));
    const timer = setTimeout(
      () => finish(() => reject(hashTimeout())),
      remaining,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export async function hashCanonicalMediaSource(
  sourcePath: string,
  core: Pick<CoreClient, "captureGuardPhase">,
  signal: AbortSignal,
  dependencies: MediaSourceHashDependencies = {},
): Promise<MediaSourceHashResult> {
  const now = dependencies.now ?? (() => performance.now());
  const openFile = dependencies.openFile
    ?? ((candidate: string) => open(candidate, "r") as Promise<MediaHashFileHandle>);
  const allocateBuffer = dependencies.allocateBuffer ?? ((bytes: number) => Buffer.alloc(bytes));
  const deadline = now() + MEDIA_SOURCE_HASH_TIMEOUT_MS;
  let file: MediaHashFileHandle | null = null;
  let buffer: Buffer | null = null;
  let pendingRead: Promise<{ bytesRead: number }> | null = null;
  let timedOut = false;

  try {
    assertNotAborted(signal);
    assertCaptureIdle(core);
    assertHashDeadline(deadline, now);
    const opening = openFile(sourcePath);
    try {
      file = await awaitBeforeHashDeadline(opening, deadline, signal, now);
    } catch (error) {
      void opening.then((opened) => opened.close()).catch(() => undefined);
      throw error;
    }

    const initial = await awaitBeforeHashDeadline(file.stat(), deadline, signal, now);
    assertHashDeadline(deadline, now);
    if (!initial.isFile()) {
      throw new MediaImportFlowError("MEDIA_IMPORT_SOURCE_NOT_FILE", "media source is not a file");
    }
    if (!Number.isSafeInteger(initial.size) || initial.size <= 0) {
      throw new MediaImportFlowError("MEDIA_IMPORT_EMPTY", "media source must not be empty");
    }
    if (initial.size > MEDIA_SOURCE_MAX_BYTES) {
      throw new MediaImportFlowError("MEDIA_IMPORT_TOO_LARGE", "media source exceeds the size limit");
    }

    buffer = allocateBuffer(MEDIA_SOURCE_HASH_CHUNK_BYTES);
    if (!Buffer.isBuffer(buffer) || buffer.length !== MEDIA_SOURCE_HASH_CHUNK_BYTES) {
      throw new MediaImportFlowError(
        "MEDIA_IMPORT_SOURCE_UNAVAILABLE",
        "private media hashing could not allocate its bounded buffer",
      );
    }
    const hasher = createHash("sha256");
    let position = 0;
    while (position < initial.size) {
      assertNotAborted(signal);
      assertCaptureIdle(core);
      assertHashDeadline(deadline, now);
      const requested = Math.min(buffer.length, initial.size - position);
      pendingRead = file.read(buffer, 0, requested, position);
      const read = await awaitBeforeHashDeadline(pendingRead, deadline, signal, now);
      pendingRead = null;
      assertHashDeadline(deadline, now);
      assertNotAborted(signal);
      assertCaptureIdle(core);
      if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead <= 0 || read.bytesRead > requested) {
        throw new MediaImportFlowError(
          "MEDIA_IMPORT_SOURCE_CHANGED",
          "media source changed while it was being hashed",
        );
      }
      hasher.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }

    assertNotAborted(signal);
    assertCaptureIdle(core);
    const final = await awaitBeforeHashDeadline(file.stat(), deadline, signal, now);
    assertHashDeadline(deadline, now);
    assertNotAborted(signal);
    assertCaptureIdle(core);
    if (!final.isFile() || final.size !== initial.size || position !== initial.size) {
      throw new MediaImportFlowError(
        "MEDIA_IMPORT_SOURCE_CHANGED",
        "media source changed while it was being hashed",
      );
    }
    return {
      sourceSha256: hasher.digest("hex"),
      sourceSizeBytes: initial.size,
    };
  } catch (error) {
    timedOut = error instanceof MediaImportFlowError
      && (error.code === "MEDIA_IMPORT_HASH_TIMEOUT" || error.code === "MEDIA_IMPORT_CANCELLED");
    throw error;
  } finally {
    if (buffer) {
      buffer.fill(0);
      if (pendingRead) {
        const pendingBuffer = buffer;
        void pendingRead.then(
          () => pendingBuffer.fill(0),
          () => pendingBuffer.fill(0),
        );
      }
    }
    if (file) {
      const closing = file.close();
      if (timedOut || pendingRead) void closing.catch(() => undefined);
      else await closing.catch(() => undefined);
    }
  }
}

function custodyFlags() {
  return {
    localOnly: true,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  } as const;
}

function safeIdentifier(value: JsonValue | undefined): string | null {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : null;
}

function safeFailureCode(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized) ? normalized : null;
}

function safeSourceSha256(value: JsonValue | undefined): string | null {
  return typeof value === "string" && LOWERCASE_SHA256.test(value) ? value : null;
}

function unsupportedDecoderResult(jobId: string | null = null) {
  return {
    canceled: false,
    imported: false,
    failureCode: "UNSUPPORTED_DECODER",
    recordingId: null,
    jobId,
    ...custodyFlags(),
  } as const;
}

function canceledImportResult(jobId: string | null) {
  return {
    canceled: true,
    imported: false,
    failureCode: "MEDIA_IMPORT_CANCELLED",
    recordingId: null,
    jobId,
    ...custodyFlags(),
  } as const;
}

function failedImportResult(failureCode: string | null, jobId: string | null) {
  return {
    canceled: false,
    imported: false,
    failureCode,
    recordingId: null,
    jobId,
    ...custodyFlags(),
  } as const;
}

function completedImportResult(
  job: Record<string, JsonValue | undefined>,
  jobId: string,
) {
  const result = objectValue(job.result ?? null);
  const recordingId = safeIdentifier(result.recordingId);
  if (job.state !== "completed" || job.terminal !== true || result.imported !== true || !recordingId) {
    return null;
  }
  return {
    canceled: false,
    imported: true,
    failureCode: null,
    recordingId,
    jobId,
    ...custodyFlags(),
  } as const;
}

function defaultPollDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertPollActive(deadline: number, signal: AbortSignal, now: () => number): void {
  assertNotAborted(signal);
  if (now() >= deadline) {
    throw new MediaImportFlowError(
      "MEDIA_IMPORT_TIMEOUT",
      "local media import exceeded its fixed wall-clock limit",
    );
  }
}

function waitForPollDelay(
  delay: PollDelay,
  milliseconds: number,
  deadline: number,
  signal: AbortSignal,
  now: () => number,
): Promise<void> {
  assertPollActive(deadline, signal, now);
  const remaining = deadline - now();
  const wait = delay(Math.min(milliseconds, remaining));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(
      new MediaImportFlowError("MEDIA_IMPORT_CANCELLED", "media import was cancelled"),
    ));
    const timer = setTimeout(
      () => finish(() => reject(new MediaImportFlowError(
        "MEDIA_IMPORT_TIMEOUT",
        "local media import exceeded its fixed wall-clock limit",
      ))),
      remaining,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    wait.then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    );
  });
}

async function pollMediaImportJob(
  core: Pick<CoreClient, "call">,
  jobId: string,
  delay: PollDelay,
  signal: AbortSignal,
  now: () => number = () => performance.now(),
) {
  const deadline = now() + MEDIA_IMPORT_POLL_TIMEOUT_MS;
  while (true) {
    assertPollActive(deadline, signal, now);
    const response = await core.call("jobs.get", { jobId });
    assertPollActive(deadline, signal, now);
    if (!response.ok) {
      throw new Error("The selected media import job could not be checked.");
    }
    const job = objectValue(response.result ?? null);
    if (safeIdentifier(job.jobId) !== jobId || job.type !== "media-import") {
      throw new Error("The selected media import job returned an invalid identity.");
    }
    const state = typeof job.state === "string" ? job.state : "";
    if (state === "completed") {
      const completed = completedImportResult(job, jobId);
      if (!completed) {
        throw new Error("The selected media file could not be imported.");
      }
      return completed;
    }
    if (state === "cancelled") {
      return canceledImportResult(jobId);
    }
    if (state === "failed") {
      const error = objectValue(job.error ?? null);
      const failureCode = safeFailureCode(error.code);
      if (failureCode && UNSUPPORTED_DECODER_CODES.has(failureCode)) {
        return unsupportedDecoderResult(jobId);
      }
      if (failureCode === "RECORDING_PRIORITY" || failureCode === "MEDIA_IMPORT_CANCELLED") {
        return canceledImportResult(jobId);
      }
      return failedImportResult(failureCode, jobId);
    }
    if (!new Set(["queued", "running", "cancelling", "paused"]).has(state)) {
      throw new Error("The selected media import job returned an invalid state.");
    }
    await waitForPollDelay(delay, 250, deadline, signal, now);
  }
}

type CancelConfirmation =
  | { kind: "cancelled" }
  | { kind: "completed"; result: ReturnType<typeof completedImportResult> }
  | { kind: "terminal-other" }
  | { kind: "unconfirmed" };

function isVerifiedTerminalMediaImportJob(
  job: Record<string, JsonValue | undefined>,
  jobId: string,
): boolean {
  return safeIdentifier(job.jobId) === jobId
    && job.type === "media-import"
    && job.terminal === true
    && new Set(["cancelled", "completed", "failed"]).has(
      typeof job.state === "string" ? job.state : "",
    );
}

async function confirmMediaImportCancellation(
  core: Pick<CoreClient, "call">,
  jobId: string,
  delay: PollDelay,
  now: () => number,
): Promise<CancelConfirmation> {
  const deadline = now() + MEDIA_IMPORT_CANCEL_CONFIRM_TIMEOUT_MS;
  let cancellationReportedCompleted = false;
  try {
    const response = await core.call("jobs.cancel", { jobId });
    if (response.ok) {
      const cancellation = objectValue(response.result ?? null);
      if (
        safeIdentifier(cancellation.jobId) === jobId
        && cancellation.terminal === true
        && typeof cancellation.cancelRequested === "boolean"
        && cancellation.rawPathExposed === false
      ) {
        if (cancellation.state === "cancelled") return { kind: "cancelled" };
        if (cancellation.state === "completed") cancellationReportedCompleted = true;
        else if (cancellation.state === "failed") return { kind: "terminal-other" };
      }
    }
  } catch {
    // Reconcile through jobs.get below. A failed cancellation request is never
    // treated as confirmation that durable import work stopped.
  }

  for (let attempt = 0; attempt < 200 && now() < deadline; attempt += 1) {
    try {
      const response = await core.call("jobs.get", { jobId });
      if (response.ok) {
        const job = objectValue(response.result ?? null);
        if (safeIdentifier(job.jobId) !== jobId || job.type !== "media-import") {
          return { kind: "unconfirmed" };
        }
        if (isVerifiedTerminalMediaImportJob(job, jobId)) {
          if (job.state === "cancelled") return { kind: "cancelled" };
          if (job.state === "completed") {
            return { kind: "completed", result: completedImportResult(job, jobId) };
          }
          return { kind: "terminal-other" };
        }
      }
    } catch {
      // Continue until the fixed confirmation deadline.
    }
    if (now() >= deadline) break;
    try {
      await delay(Math.min(MEDIA_IMPORT_CANCEL_CONFIRM_DELAY_MS, deadline - now()));
    } catch {
      return { kind: "unconfirmed" };
    }
  }
  return cancellationReportedCompleted
    ? { kind: "completed", result: null }
    : { kind: "unconfirmed" };
}

async function defaultShowOpenDialog(
  window: ReturnType<MainWindowProvider>,
  options: OpenDialogOptions,
): Promise<OpenDialogResult> {
  return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
}

function validatedEligibilitySize(value: JsonValue | undefined): number | null {
  const eligibility = objectValue(value ?? null);
  return (
    eligibility.schemaVersion === 1
    && eligibility.eligible === true
    && typeof eligibility.sourceSizeBytes === "number"
    && Number.isSafeInteger(eligibility.sourceSizeBytes)
    && eligibility.sourceSizeBytes > 0
    && eligibility.sourceSizeBytes <= MEDIA_SOURCE_MAX_BYTES
    && eligibility.localStorageVerified === true
    && eligibility.regularFile === true
    && eligibility.reparsePoint === false
    && eligibility.cloudPlaceholder === false
    && eligibility.localOnly === true
    && eligibility.networkAttempted === false
    && eligibility.rawPathExposed === false
    && eligibility.keyMaterialExposedToRenderer === false
  ) ? eligibility.sourceSizeBytes : null;
}

function isRecordingPriorityCode(code: string | null): boolean {
  return code === "MEDIA_IMPORT_CAPTURE_ACTIVE"
    || code === "MEDIA_IMPORT_CANCELLED"
    || code === "RECORDING_PRIORITY";
}

export function registerMediaImportIpc(dependencies: MediaImportIpcDependencies): () => void {
  const registrar = dependencies.ipc ?? ipcMain as unknown as IpcHandlerRegistrar;
  const checkSender = dependencies.validateSender ?? validateIpcSender;
  const chooseFile = dependencies.showOpenDialog ?? defaultShowOpenDialog;
  const inspectLink = dependencies.lstatPath ?? ((sourcePath: string) => lstat(sourcePath));
  const canonicalize = dependencies.realpathPath ?? ((sourcePath: string) => realpath(sourcePath));
  const inspectFile = dependencies.statPath ?? ((sourcePath: string) => stat(sourcePath));
  const pollDelay = dependencies.pollDelay ?? defaultPollDelay;
  const hashMediaSource = dependencies.hashMediaSource ?? hashCanonicalMediaSource;
  let activeController: AbortController | null = null;
  let retainedUnsubscribe: (() => void) | null = null;

  registrar.handle(MEDIA_IMPORT_IPC_CHANNEL, async (event: IpcMainInvokeEvent, rendererValue?: unknown) => {
    checkSender(event, dependencies.getMainWindow);
    if (rendererValue !== undefined) {
      throw new Error("Media import does not accept a renderer-supplied path or other parameters.");
    }
    if (activeController) {
      throw new Error("A media import is already in progress.");
    }

    const controller = new AbortController();
    activeController = controller;
    const signal = controller.signal;
    const mainWindow = dependencies.getMainWindow();
    const abortForTeardown = () => controller.abort();
    mainWindow?.once("closed", abortForTeardown);
    mainWindow?.webContents.once("destroyed", abortForTeardown);
    if (mainWindow?.isDestroyed() || mainWindow?.webContents.isDestroyed()) controller.abort();

    let acceptedJobId: string | null = null;
    let submitStarted = false;
    let retainSingleFlight = false;
    let cancelPromise: Promise<CancelConfirmation> | null = null;
    const cancelAcceptedJob = (): Promise<CancelConfirmation> => {
      if (!acceptedJobId) return Promise.resolve({ kind: "cancelled" });
      if (!cancelPromise) {
        cancelPromise = confirmMediaImportCancellation(
          dependencies.core,
          acceptedJobId,
          pollDelay,
          dependencies.cancelNow ?? (() => performance.now()),
        );
      }
      return cancelPromise;
    };
    const cancelOnAbort = () => void cancelAcceptedJob();
    signal.addEventListener("abort", cancelOnAbort);

    try {
      assertNotAborted(signal);
      assertCaptureIdle(dependencies.core);
      const selection = await chooseFile(mainWindow, {
        ...MEDIA_IMPORT_DIALOG_OPTIONS,
        properties: [...(MEDIA_IMPORT_DIALOG_OPTIONS.properties ?? [])],
        filters: MEDIA_IMPORT_DIALOG_OPTIONS.filters?.map((filter) => ({
          name: filter.name,
          extensions: [...filter.extensions],
        })),
      });
      assertNotAborted(signal);
      const selected = selection.filePaths[0];
      if (selection.canceled || !selected) {
        return {
          canceled: true,
          imported: false,
          failureCode: null,
          recordingId: null,
          jobId: null,
          ...custodyFlags(),
        };
      }

      assertCaptureIdle(dependencies.core);
      const eligibilityResponse = await dependencies.core.call(
        "media.validateLocalSourcePath",
        { sourcePath: selected },
      );
      assertNotAborted(signal);
      if (!eligibilityResponse.ok) {
        const failureCode = safeFailureCode(eligibilityResponse.error?.code);
        if (isRecordingPriorityCode(failureCode)) return canceledImportResult(null);
        throw new Error("The selected media file is not eligible for local-only import.");
      }
      const eligibleSize = validatedEligibilitySize(eligibilityResponse.result);
      if (eligibleSize === null) {
        throw new Error("The selected media file returned invalid local-only eligibility.");
      }

      const selectedLink = await inspectLink(selected);
      assertNotAborted(signal);
      if (selectedLink.isSymbolicLink()) {
        throw new Error("Symbolic links cannot be imported as recorded media.");
      }
      const sourcePath = await canonicalize(selected);
      assertNotAborted(signal);
      const selectedFile = await inspectFile(sourcePath);
      assertNotAborted(signal);
      if (!selectedFile.isFile()) {
        throw new Error("The selected media target is not a file.");
      }
      if (!SUPPORTED_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
        throw new Error("Media files must use WAV, MP3, M4A, MP4, or WebM.");
      }

      const hashed = await hashMediaSource(sourcePath, dependencies.core, signal);
      const expectedSourceSha256 = safeSourceSha256(hashed.sourceSha256);
      if (
        !expectedSourceSha256
        || !Number.isSafeInteger(hashed.sourceSizeBytes)
        || hashed.sourceSizeBytes !== eligibleSize
      ) {
        throw new Error("The selected media file returned an invalid private identity.");
      }

      assertNotAborted(signal);
      assertCaptureIdle(dependencies.core);
      submitStarted = true;
      const response = await dependencies.core.call("media.importFromPath", {
        sourcePath,
        expectedSourceSha256,
      });
      submitStarted = false;
      if (!response.ok) {
        const failureCode = safeFailureCode(response.error?.code);
        if (failureCode && UNSUPPORTED_DECODER_CODES.has(failureCode)) {
          return unsupportedDecoderResult();
        }
        if (isRecordingPriorityCode(failureCode)) return canceledImportResult(null);
        throw new Error("The selected media file could not be imported.");
      }

      const accepted = objectValue(response.result ?? null);
      const jobId = safeIdentifier(accepted.jobId);
      if (jobId) acceptedJobId = jobId;
      if (
        !jobId
        || accepted.type !== "media-import"
        || accepted.state !== "queued"
        || accepted.rawPathExposed !== false
        || accepted.keyMaterialExposedToRenderer !== false
      ) {
        throw new Error("The selected media file could not be imported.");
      }
      assertNotAborted(signal);
      return await pollMediaImportJob(
        dependencies.core,
        jobId,
        pollDelay,
        signal,
        dependencies.pollNow,
      );
    } catch (error) {
      const cancellation = await cancelAcceptedJob();
      if (acceptedJobId && cancellation.kind === "completed") {
        return cancellation.result
          ?? failedImportResult("MEDIA_IMPORT_CANCEL_LOST_RACE", acceptedJobId);
      }
      if (acceptedJobId && cancellation.kind === "terminal-other") {
        return failedImportResult("MEDIA_IMPORT_CANCEL_TERMINAL_OTHER", acceptedJobId);
      }
      if (acceptedJobId && cancellation.kind === "unconfirmed") {
        retainSingleFlight = true;
        const retainedJobId = acceptedJobId;
        let retainedReleased = false;
        const releaseRetainedJob = () => {
          retainedReleased = true;
          retainedUnsubscribe?.();
          retainedUnsubscribe = null;
          if (activeController === controller) activeController = null;
        };
        if (dependencies.core.subscribe) {
          const unsubscribe = dependencies.core.subscribe((event) => {
            const job = event.payload as unknown as Record<string, JsonValue | undefined>;
            if (!isVerifiedTerminalMediaImportJob(job, retainedJobId)) return;
            releaseRetainedJob();
          });
          if (retainedReleased) unsubscribe();
          else retainedUnsubscribe = unsubscribe;
        }
        // Subscription is installed first. The immediate reconciliation closes
        // the race where the terminal event arrived just before installation.
        void dependencies.core.call("jobs.get", { jobId: retainedJobId })
          .then((response) => {
            if (!response.ok) return;
            const job = objectValue(response.result ?? null);
            if (isVerifiedTerminalMediaImportJob(job, retainedJobId)) {
              releaseRetainedJob();
            }
          })
          .catch(() => undefined);
        return failedImportResult("MEDIA_IMPORT_CANCEL_UNCONFIRMED", acceptedJobId);
      }
      if (!acceptedJobId && submitStarted) {
        retainSingleFlight = true;
        return failedImportResult("MEDIA_IMPORT_SUBMIT_UNCONFIRMED", null);
      }
      if (error instanceof MediaImportFlowError) {
        if (isRecordingPriorityCode(error.code)) return canceledImportResult(acceptedJobId);
        if (error.code === "MEDIA_IMPORT_HASH_TIMEOUT" || error.code === "MEDIA_IMPORT_TIMEOUT") {
          return failedImportResult("MEDIA_IMPORT_TIMEOUT", acceptedJobId);
        }
        return failedImportResult(error.code, acceptedJobId);
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", cancelOnAbort);
      mainWindow?.removeListener("closed", abortForTeardown);
      mainWindow?.webContents.removeListener("destroyed", abortForTeardown);
      if (!retainSingleFlight && activeController === controller) activeController = null;
    }
  });

  return () => {
    activeController?.abort();
    retainedUnsubscribe?.();
    retainedUnsubscribe = null;
    registrar.removeHandler(MEDIA_IMPORT_IPC_CHANNEL);
  };
}
