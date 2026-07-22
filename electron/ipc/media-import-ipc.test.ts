import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { CoreEvent, CoreResponse } from "../core/protocol.js";
import {
  hashCanonicalMediaSource,
  MEDIA_IMPORT_DIALOG_OPTIONS,
  MEDIA_IMPORT_IPC_CHANNEL,
  MEDIA_IMPORT_POLL_TIMEOUT_MS,
  MEDIA_SOURCE_HASH_CHUNK_BYTES,
  MEDIA_SOURCE_HASH_TIMEOUT_MS,
  MEDIA_SOURCE_MAX_BYTES,
  MediaImportFlowError,
  registerMediaImportIpc,
  type MediaImportIpcDependencies,
} from "./media-import-ipc.js";
import type { IpcHandlerRegistrar } from "./setup-ipc.js";

const SOURCE_SHA256 = "a".repeat(64);
const JOB_ID = "b".repeat(32);
const SOURCE_BYTES = 1_024;

class FakeRegistrar implements IpcHandlerRegistrar {
  readonly handlers = new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => unknown>();

  handle(channel: string, listener: (event: IpcMainInvokeEvent, value?: unknown) => unknown): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  invoke(value?: unknown): Promise<unknown> {
    const listener = this.handlers.get(MEDIA_IMPORT_IPC_CHANNEL);
    if (!listener) throw new Error("media import handler is missing");
    return Promise.resolve(listener({} as IpcMainInvokeEvent, value));
  }
}

class FakeWebContents extends EventEmitter {
  private destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroyForTest(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  private destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  closeForTest(): void {
    this.destroyed = true;
    this.emit("closed");
  }
}

function stats(file: boolean, symbolicLink = false): Stats {
  return {
    isFile: () => file,
    isSymbolicLink: () => symbolicLink,
  } as Stats;
}

function response(result: CoreResponse["result"]): CoreResponse {
  return {
    requestId: "request-1",
    id: "request-1",
    protocolVersion: "test",
    ok: true,
    result,
  };
}

function eligibility(sourceSizeBytes = SOURCE_BYTES) {
  return {
    schemaVersion: 1,
    eligible: true,
    sourceSizeBytes,
    localStorageVerified: true,
    regularFile: true,
    reparsePoint: false,
    cloudPlaceholder: false,
    localOnly: true,
    networkAttempted: false,
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

function queued(jobId = JOB_ID) {
  return {
    jobId,
    type: "media-import",
    state: "queued",
    createdAt: "2026-07-20T12:00:00.000Z",
    rawPathExposed: false,
    keyMaterialExposedToRenderer: false,
  };
}

function completed(jobId = JOB_ID) {
  return {
    jobId,
    type: "media-import",
    state: "completed",
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:01.000Z",
    terminal: true,
    result: { imported: true, recordingId: "rec_1" },
    rawPathExposed: false,
  };
}

function dependencies(overrides: Partial<MediaImportIpcDependencies> = {}) {
  const ipc = new FakeRegistrar();
  const call = vi.fn(async (method: string) => {
    if (method === "media.validateLocalSourcePath") return response(eligibility());
    if (method === "media.importFromPath") return response(queued());
    if (method === "jobs.cancel") {
      return response({
        jobId: JOB_ID,
        state: "cancelled",
        cancelRequested: true,
        terminal: true,
        rawPathExposed: false,
      });
    }
    return response(completed());
  });
  const captureGuardPhase = vi.fn(() => "idle" as const);
  const showOpenDialog = vi.fn(async (_window: unknown, _options: OpenDialogOptions) => ({
    canceled: false,
    filePaths: ["C:\\incoming\\meeting.mp4"],
  }));
  const hashMediaSource = vi.fn(async () => ({
    sourceSha256: SOURCE_SHA256,
    sourceSizeBytes: SOURCE_BYTES,
  }));
  const values: MediaImportIpcDependencies = {
    ipc,
    core: { call, captureGuardPhase } as MediaImportIpcDependencies["core"],
    getMainWindow: () => null,
    validateSender: vi.fn(),
    showOpenDialog,
    lstatPath: vi.fn(async () => stats(true)),
    realpathPath: vi.fn(async () => "C:\\canonical\\meeting.mp4"),
    statPath: vi.fn(async () => stats(true)),
    pollDelay: vi.fn(async () => undefined),
    hashMediaSource,
    ...overrides,
  };
  return { ipc, call, captureGuardPhase, showOpenDialog, hashMediaSource, values };
}

function idleCore(call: MediaImportIpcDependencies["core"]["call"]): MediaImportIpcDependencies["core"] {
  return { call, captureGuardPhase: () => "idle" } as MediaImportIpcDependencies["core"];
}

describe("media import IPC", () => {
  it("validates locality first and binds the asynchronously hashed canonical source directly to import", async () => {
    const fixture = dependencies();
    const lstatPath = fixture.values.lstatPath as ReturnType<typeof vi.fn>;
    registerMediaImportIpc(fixture.values);

    await expect(fixture.ipc.invoke()).resolves.toEqual({
      canceled: false,
      imported: true,
      failureCode: null,
      recordingId: "rec_1",
      jobId: JOB_ID,
      localOnly: true,
      networkAttempted: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });
    expect(fixture.showOpenDialog).toHaveBeenCalledWith(null, expect.objectContaining({
      properties: ["openFile"],
      filters: [{ name: "Supported media", extensions: ["wav", "mp3", "m4a", "mp4", "webm"] }],
    }));
    expect(MEDIA_IMPORT_DIALOG_OPTIONS.filters).toEqual([
      { name: "Supported media", extensions: ["wav", "mp3", "m4a", "mp4", "webm"] },
    ]);
    expect(fixture.call).toHaveBeenNthCalledWith(1, "media.validateLocalSourcePath", {
      sourcePath: "C:\\incoming\\meeting.mp4",
    });
    expect(fixture.call.mock.invocationCallOrder[0]).toBeLessThan(lstatPath.mock.invocationCallOrder[0]);
    expect(fixture.hashMediaSource).toHaveBeenCalledWith(
      "C:\\canonical\\meeting.mp4",
      fixture.values.core,
      expect.any(AbortSignal),
    );
    expect(fixture.call).toHaveBeenNthCalledWith(2, "media.importFromPath", {
      sourcePath: "C:\\canonical\\meeting.mp4",
      expectedSourceSha256: SOURCE_SHA256,
    });
    expect(fixture.call).toHaveBeenCalledWith("jobs.get", { jobId: JOB_ID });
    expect(fixture.call.mock.calls.flat().join(" ")).not.toContain("media.inspectFromPath");
  });

  it("accepts exactly the no-argument renderer shape and rejects all supplied values", async () => {
    const valid = dependencies();
    registerMediaImportIpc(valid.values);
    await expect(valid.ipc.invoke()).resolves.toMatchObject({ imported: true });

    for (const rendererValue of [null, {}, [], "", 0, false, { sourcePath: "C:\\private.wav" }]) {
      const validateSender = vi.fn();
      const fixture = dependencies({ validateSender });
      registerMediaImportIpc(fixture.values);
      await expect(fixture.ipc.invoke(rendererValue))
        .rejects.toThrow("does not accept a renderer-supplied path");
      expect(validateSender).toHaveBeenCalledTimes(1);
      expect(fixture.showOpenDialog).not.toHaveBeenCalled();
      expect(fixture.call).not.toHaveBeenCalled();
    }
  });

  it("allows only one native picker and hash flow at a time", async () => {
    let resolveDialog!: (value: { canceled: boolean; filePaths: string[] }) => void;
    const showOpenDialog = vi.fn(() => new Promise<{ canceled: boolean; filePaths: string[] }>(
      (resolve) => { resolveDialog = resolve; },
    ));
    const fixture = dependencies({ showOpenDialog });
    registerMediaImportIpc(fixture.values);

    const first = fixture.ipc.invoke();
    await Promise.resolve();
    await expect(fixture.ipc.invoke()).rejects.toThrow("already in progress");
    resolveDialog({ canceled: true, filePaths: [] });
    await expect(first).resolves.toMatchObject({ canceled: true });
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
  });

  it("rejects links, directories, and unsupported extensions only after the core locality gate", async () => {
    for (const fixture of [
      dependencies({ lstatPath: vi.fn(async () => stats(true, true)) }),
      dependencies({ statPath: vi.fn(async () => stats(false)) }),
      dependencies({ realpathPath: vi.fn(async () => "C:\\canonical\\meeting.txt") }),
    ]) {
      registerMediaImportIpc(fixture.values);
      await expect(fixture.ipc.invoke()).rejects.toThrow();
      expect(fixture.call).toHaveBeenCalledTimes(1);
      expect(fixture.call).toHaveBeenCalledWith("media.validateLocalSourcePath", {
        sourcePath: "C:\\incoming\\meeting.mp4",
      });
      expect(fixture.hashMediaSource).not.toHaveBeenCalled();
    }
  });

  it("returns pathless picker cancellation and unsupported decoder states", async () => {
    const canceled = dependencies({
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    });
    registerMediaImportIpc(canceled.values);
    await expect(canceled.ipc.invoke()).resolves.toMatchObject({
      canceled: true,
      imported: false,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });
    expect(canceled.call).not.toHaveBeenCalled();

    const call = vi.fn(async (method: string) => {
      if (method === "media.validateLocalSourcePath") return response(eligibility());
      if (method === "media.importFromPath") return response(queued());
      return response({
        ...completed(),
        state: "failed",
        error: {
          code: "MEDIA_IMPORT_CODEC_UNSUPPORTED",
          sourcePath: "C:\\must-not-leak\\meeting.m4a",
        },
        result: null,
      });
    });
    const unsupported = dependencies({ core: idleCore(call) });
    registerMediaImportIpc(unsupported.values);
    const result = await unsupported.ipc.invoke();
    expect(result).toMatchObject({
      imported: false,
      failureCode: "UNSUPPORTED_DECODER",
      jobId: JOB_ID,
      rawPathExposed: false,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("surfaces same-size post-hash substitution as a pathless identity mismatch", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "media.validateLocalSourcePath") return response(eligibility(SOURCE_BYTES));
      if (method === "media.importFromPath") return response(queued());
      return response({
        ...completed(),
        state: "failed",
        result: null,
        error: {
          code: "MEDIA_IMPORT_SOURCE_IDENTITY_MISMATCH",
          message: "C:\\must-not-leak\\same-size-replacement.mp4",
        },
      });
    });
    const fixture = dependencies({ core: idleCore(call) });
    registerMediaImportIpc(fixture.values);

    const result = await fixture.ipc.invoke();

    expect(result).toMatchObject({
      imported: false,
      failureCode: "MEDIA_IMPORT_SOURCE_IDENTITY_MISMATCH",
      jobId: JOB_ID,
      rawPathExposed: false,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("fails closed when the local hash helper returns a malformed digest or wrong size", async () => {
    for (const hashed of [
      { sourceSha256: "A".repeat(64), sourceSizeBytes: SOURCE_BYTES },
      { sourceSha256: "a".repeat(63), sourceSizeBytes: SOURCE_BYTES },
      { sourceSha256: `${"a".repeat(63)}g`, sourceSizeBytes: SOURCE_BYTES },
      { sourceSha256: SOURCE_SHA256, sourceSizeBytes: SOURCE_BYTES + 1 },
    ]) {
      const fixture = dependencies({ hashMediaSource: vi.fn(async () => hashed) });
      registerMediaImportIpc(fixture.values);
      await expect(fixture.ipc.invoke()).rejects.toThrow("invalid private identity");
      expect(fixture.call).toHaveBeenCalledTimes(1);
      expect(fixture.call).toHaveBeenCalledWith("media.validateLocalSourcePath", expect.anything());
    }
  });

  it("returns recording-priority cancellation before opening or hashing", async () => {
    const fixture = dependencies({
      core: {
        call: vi.fn(),
        captureGuardPhase: () => "recording",
      } as MediaImportIpcDependencies["core"],
    });
    registerMediaImportIpc(fixture.values);

    await expect(fixture.ipc.invoke()).resolves.toMatchObject({
      canceled: true,
      failureCode: "MEDIA_IMPORT_CANCELLED",
      jobId: null,
    });
    expect(fixture.showOpenDialog).not.toHaveBeenCalled();
    expect(fixture.hashMediaSource).not.toHaveBeenCalled();
  });

  it("cancels the accepted job when teardown races with submit completion", async () => {
    const window = new FakeWindow();
    const call = vi.fn(async (method: string) => {
      if (method === "media.validateLocalSourcePath") return response(eligibility());
      if (method === "media.importFromPath") {
        window.webContents.destroyForTest();
        return response(queued());
      }
      if (method === "jobs.cancel") {
        return response({
          jobId: JOB_ID,
          state: "cancelled",
          cancelRequested: false,
          terminal: true,
          rawPathExposed: false,
        });
      }
      throw new Error(`unexpected call: ${method}`);
    });
    const fixture = dependencies({
      core: idleCore(call),
      getMainWindow: () => window as never,
    });
    registerMediaImportIpc(fixture.values);

    await expect(fixture.ipc.invoke()).resolves.toMatchObject({
      canceled: true,
      jobId: JOB_ID,
      rawPathExposed: false,
    });
    expect(call).toHaveBeenCalledWith("jobs.cancel", { jobId: JOB_ID });
  });

  it("cancels the accepted job before returning a bounded polling timeout", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "media.validateLocalSourcePath") return response(eligibility());
      if (method === "media.importFromPath") return response(queued());
      if (method === "jobs.cancel") {
        return response({
          jobId: JOB_ID,
          state: "cancelled",
          cancelRequested: false,
          terminal: true,
          rawPathExposed: false,
        });
      }
      return response({
        ...queued(),
        state: "running",
        updatedAt: "2026-07-20T12:00:01.000Z",
        terminal: false,
      });
    });
    let clockReads = 0;
    const fixture = dependencies({
      core: idleCore(call),
      pollNow: () => (clockReads++ < 2 ? 0 : MEDIA_IMPORT_POLL_TIMEOUT_MS + 1),
    });
    registerMediaImportIpc(fixture.values);

    await expect(fixture.ipc.invoke()).resolves.toMatchObject({
      imported: false,
      failureCode: "MEDIA_IMPORT_TIMEOUT",
      jobId: JOB_ID,
    });
    expect(call).toHaveBeenCalledWith("jobs.cancel", { jobId: JOB_ID });
  });

  it("returns a completed import when cancellation loses the terminal race", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "media.validateLocalSourcePath") return response(eligibility());
      if (method === "media.importFromPath") return response(queued());
      if (method === "jobs.cancel") {
        return response({
          jobId: JOB_ID,
          state: "completed",
          cancelRequested: false,
          terminal: true,
          rawPathExposed: false,
        });
      }
      if (method === "jobs.get") return response(completed());
      throw new Error(`unexpected call: ${method}`);
    });
    let clockReads = 0;
    const fixture = dependencies({
      core: idleCore(call),
      pollNow: () => (clockReads++ === 0 ? 0 : MEDIA_IMPORT_POLL_TIMEOUT_MS),
    });
    registerMediaImportIpc(fixture.values);

    await expect(fixture.ipc.invoke()).resolves.toMatchObject({
      canceled: false,
      imported: true,
      failureCode: null,
      recordingId: "rec_1",
      jobId: JOB_ID,
    });
    expect(call).toHaveBeenCalledWith("jobs.cancel", { jobId: JOB_ID });
    expect(call).toHaveBeenCalledWith("jobs.get", { jobId: JOB_ID });
  });

  it("reconciles a nonterminal cancellation response through jobs.get", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "media.validateLocalSourcePath") return response(eligibility());
      if (method === "media.importFromPath") return response(queued());
      if (method === "jobs.cancel") {
        return response({
          jobId: JOB_ID,
          state: "cancelling",
          cancelRequested: true,
          terminal: false,
          rawPathExposed: false,
        });
      }
      if (method === "jobs.get") {
        return response({
          ...queued(),
          state: "cancelled",
          updatedAt: "2026-07-20T12:00:01.000Z",
          terminal: true,
        });
      }
      throw new Error(`unexpected call: ${method}`);
    });
    let clockReads = 0;
    const fixture = dependencies({
      core: idleCore(call),
      pollNow: () => (clockReads++ === 0 ? 0 : MEDIA_IMPORT_POLL_TIMEOUT_MS),
    });
    registerMediaImportIpc(fixture.values);

    await expect(fixture.ipc.invoke()).resolves.toMatchObject({
      imported: false,
      failureCode: "MEDIA_IMPORT_TIMEOUT",
      jobId: JOB_ID,
    });
    expect(call).toHaveBeenCalledWith("jobs.get", { jobId: JOB_ID });
  });

  it("retains single flight after unconfirmed cancellation until a verified terminal event", async () => {
    const terminalListener: { current: ((event: CoreEvent) => void) | null } = { current: null };
    let resolveGet!: (value: CoreResponse) => void;
    const pendingGet = new Promise<CoreResponse>((resolve) => { resolveGet = resolve; });
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((listener: (event: CoreEvent) => void) => {
      terminalListener.current = listener;
      return unsubscribe;
    });
    const call = vi.fn(async (method: string) => {
      if (method === "media.validateLocalSourcePath") return response(eligibility());
      if (method === "media.importFromPath") return response(queued());
      if (method === "jobs.cancel") {
        return {
          ...response(null),
          ok: false,
          result: undefined,
          error: { code: "CANCEL_REJECTED", message: "not confirmed", retryable: false },
        };
      }
      if (method === "jobs.get") return pendingGet;
      throw new Error(`unexpected call: ${method}`);
    });
    let pollReads = 0;
    let cancelReads = 0;
    const showOpenDialog = vi.fn()
      .mockResolvedValueOnce({ canceled: false, filePaths: ["C:\\incoming\\meeting.mp4"] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const fixture = dependencies({
      core: {
        ...idleCore(call),
        subscribe,
      } as MediaImportIpcDependencies["core"],
      showOpenDialog,
      pollNow: () => (pollReads++ === 0 ? 0 : MEDIA_IMPORT_POLL_TIMEOUT_MS),
      cancelNow: () => (cancelReads++ === 0 ? 0 : 10_001),
    });
    registerMediaImportIpc(fixture.values);

    await expect(fixture.ipc.invoke()).resolves.toMatchObject({
      failureCode: "MEDIA_IMPORT_CANCEL_UNCONFIRMED",
      jobId: JOB_ID,
    });
    await expect(fixture.ipc.invoke()).rejects.toThrow("already in progress");

    terminalListener.current?.({
      payload: {
        ...queued(),
        type: "transcription",
        state: "completed",
        terminal: true,
      },
    } as CoreEvent);
    await expect(fixture.ipc.invoke()).rejects.toThrow("already in progress");

    terminalListener.current?.({
      payload: {
        ...queued(),
        state: "cancelled",
        terminal: true,
      },
    } as CoreEvent);
    resolveGet(response({ ...queued(), state: "cancelled", terminal: true }));
    await Promise.resolve();

    await expect(fixture.ipc.invoke()).resolves.toMatchObject({ canceled: true });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("subscribes before immediate terminal reconciliation closes the missed-event race", async () => {
    const order: string[] = [];
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((_listener: (event: CoreEvent) => void) => {
      order.push("subscribe");
      return unsubscribe;
    });
    const call = vi.fn(async (method: string) => {
      if (method === "media.validateLocalSourcePath") return response(eligibility());
      if (method === "media.importFromPath") return response(queued());
      if (method === "jobs.cancel") {
        return {
          ...response(null),
          ok: false,
          result: undefined,
          error: { code: "CANCEL_REJECTED", message: "not confirmed", retryable: false },
        };
      }
      if (method === "jobs.get") {
        order.push("jobs.get");
        return response({ ...queued(), state: "cancelled", terminal: true });
      }
      throw new Error(`unexpected call: ${method}`);
    });
    let pollReads = 0;
    let cancelReads = 0;
    const showOpenDialog = vi.fn()
      .mockResolvedValueOnce({ canceled: false, filePaths: ["C:\\incoming\\meeting.mp4"] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const fixture = dependencies({
      core: {
        ...idleCore(call),
        subscribe,
      } as MediaImportIpcDependencies["core"],
      showOpenDialog,
      pollNow: () => (pollReads++ === 0 ? 0 : MEDIA_IMPORT_POLL_TIMEOUT_MS),
      cancelNow: () => (cancelReads++ === 0 ? 0 : 10_001),
    });
    registerMediaImportIpc(fixture.values);

    await expect(fixture.ipc.invoke()).resolves.toMatchObject({
      failureCode: "MEDIA_IMPORT_CANCEL_UNCONFIRMED",
    });
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["subscribe", "jobs.get"]);
    await expect(fixture.ipc.invoke()).resolves.toMatchObject({ canceled: true });
  });

  it("retains single flight when submission transport outcome is ambiguous", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "media.validateLocalSourcePath") return response(eligibility());
      if (method === "media.importFromPath") throw new Error("transport disconnected");
      throw new Error(`unexpected call: ${method}`);
    });
    const fixture = dependencies({ core: idleCore(call) });
    registerMediaImportIpc(fixture.values);

    await expect(fixture.ipc.invoke()).resolves.toMatchObject({
      failureCode: "MEDIA_IMPORT_SUBMIT_UNCONFIRMED",
      jobId: null,
    });
    await expect(fixture.ipc.invoke()).rejects.toThrow("already in progress");
  });
});

describe("bounded main-process media hashing", () => {
  it("enforces a monotonic fixed deadline before opening the source", async () => {
    const openFile = vi.fn();
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValue(MEDIA_SOURCE_HASH_TIMEOUT_MS);

    await expect(hashCanonicalMediaSource(
      "C:\\canonical\\meeting.wav",
      { captureGuardPhase: () => "idle" },
      new AbortController().signal,
      { now, openFile },
    )).rejects.toMatchObject({ code: "MEDIA_IMPORT_HASH_TIMEOUT" });
    expect(openFile).not.toHaveBeenCalled();
  });

  it("checks capture between chunks, closes the handle, and zeroes its one bounded buffer", async () => {
    const boundedBuffer = Buffer.alloc(MEDIA_SOURCE_HASH_CHUNK_BYTES, 0x7f);
    const read = vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
      buffer.fill(0x55, 0, length);
      return { bytesRead: length };
    });
    const close = vi.fn(async () => undefined);
    const file = {
      stat: vi.fn(async () => ({
        size: MEDIA_SOURCE_HASH_CHUNK_BYTES + 1,
        isFile: () => true,
      })),
      read,
      close,
    };
    let captureChecks = 0;

    await expect(hashCanonicalMediaSource(
      "C:\\canonical\\meeting.wav",
      { captureGuardPhase: () => (++captureChecks >= 3 ? "recording" : "idle") },
      new AbortController().signal,
      {
        openFile: vi.fn(async () => file),
        allocateBuffer: () => boundedBuffer,
      },
    )).rejects.toMatchObject({ code: "RECORDING_PRIORITY" });

    expect(read).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(boundedBuffer.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects zero and over-2-GiB handles before any read", async () => {
    for (const [size, code] of [
      [0, "MEDIA_IMPORT_EMPTY"],
      [MEDIA_SOURCE_MAX_BYTES + 1, "MEDIA_IMPORT_TOO_LARGE"],
    ] as const) {
      const read = vi.fn();
      const close = vi.fn(async () => undefined);
      await expect(hashCanonicalMediaSource(
        "C:\\canonical\\meeting.wav",
        { captureGuardPhase: () => "idle" },
        new AbortController().signal,
        {
          openFile: vi.fn(async () => ({
            stat: vi.fn(async () => ({ size, isFile: () => true })),
            read,
            close,
          })),
        },
      )).rejects.toMatchObject({ code });
      expect(read).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    }
  });

  it("fails when the same handle changes size between hashing and final stat", async () => {
    const boundedBuffer = Buffer.alloc(MEDIA_SOURCE_HASH_CHUNK_BYTES);
    const stat = vi.fn()
      .mockResolvedValueOnce({ size: 4, isFile: () => true })
      .mockResolvedValueOnce({ size: 5, isFile: () => true });
    const close = vi.fn(async () => undefined);

    await expect(hashCanonicalMediaSource(
      "C:\\canonical\\meeting.wav",
      { captureGuardPhase: () => "idle" },
      new AbortController().signal,
      {
        openFile: vi.fn(async () => ({
          stat,
          read: vi.fn(async (buffer: Buffer) => {
            buffer.fill(0x33, 0, 4);
            return { bytesRead: 4 };
          }),
          close,
        })),
        allocateBuffer: () => boundedBuffer,
      },
    )).rejects.toBeInstanceOf(MediaImportFlowError);
    expect(close).toHaveBeenCalledTimes(1);
    expect(boundedBuffer.every((byte) => byte === 0)).toBe(true);
  });
});
