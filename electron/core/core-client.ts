import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { CoreClientError, errorMessage } from "./core-errors.js";
import { objectValue, type JsonValue } from "./json.js";
import {
  createCoreRequest,
  MAX_CORE_REQUEST_LINE_BYTES,
  MAX_CORE_RESPONSE_LINE_BYTES,
  parseCoreHandshake,
  parseCoreEventLine,
  parseCoreResponseLine,
  type CoreResponse,
  type CoreEvent,
} from "./protocol.js";
import { CORE_OPERATIONS, validateCompletedJobResult, type CoreOperationDefinition } from "./operation-registry.js";
import { RequestRegistry } from "./request-registry.js";

export type CoreSupervisorLifecycle =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed"
  | "capture-connection-degraded";

export interface CaptureDegradedMetadata {
  at: string;
  method: string;
  recordingId: string | null;
  lastConfirmedActive: true;
}

interface CoreSupervisorState {
  state: CoreSupervisorLifecycle;
  restartCount: number;
  startedAt: string | null;
  executable: string | null;
  pid: number | null;
  lastExit: {
    code: number | null;
    signal: string | null;
    at: string;
    error?: string;
  } | null;
  lastHandshake: {
    ok: boolean;
    at: string;
    version?: JsonValue;
    error?: string;
  } | null;
  degradedCapture: CaptureDegradedMetadata | null;
  captureRecoveryRequired: boolean;
}

type SpawnCore = (executable: string) => ChildProcessWithoutNullStreams;

interface CoreClientOptions {
  executablePath: () => string;
  allowedMethods: ReadonlySet<string>;
  isDev: boolean;
  spawnCore?: SpawnCore;
  timeoutMsForTesting?: (method: string, configuredTimeoutMs: number) => number;
  onCaptureConnectionDegraded?: (metadata: CaptureDegradedMetadata) => void | Promise<void>;
  onCaptureRecoveryResolved?: () => void | Promise<void>;
}

const MAX_CORE_STDERR_BYTES = 64 * 1024;
const CAPTURE_START_METHODS = new Set([
  "capture.startMic",
  "capture.startSystem",
  "capture.startMicAndSystem",
]);

export type CaptureGuardPhase = "idle" | "starting" | "recording" | "finalizing";

function defaultSpawnCore(executable: string): ChildProcessWithoutNullStreams {
  return spawn(executable, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      CANDOR_CORE_TRANSPORT: "stdio-json-lines",
    },
  });
}

function redactCoreDiagnostic(value: string): string {
  return value
    .replace(/\b[A-Za-z]:[\\/][^\r\n\t"']+/g, "<path>")
    .replace(/(?:^|\s)\/(?:Users|home|root|tmp|var|private)\/[^\s"']+/g, " <path>")
    .replace(/\b(?:sk-(?:live|prod)-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g, "<secret>");
}

function executableBasename(value: string): string {
  return path.win32.basename(value.replaceAll("/", "\\"));
}

function stringFromNestedResult(value: JsonValue | undefined, objectField: string, field: string): string | null {
  const nested = objectValue(objectValue(value ?? null)[objectField] ?? null)[field];
  return typeof nested === "string" && nested.length > 0 ? nested : null;
}

export class CoreClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly registry = new RequestRegistry<CoreResponse>();
  private readonly supervisor: CoreSupervisorState = {
    state: "stopped",
    restartCount: 0,
    startedAt: null,
    executable: null,
    pid: null,
    lastExit: null,
    lastHandshake: null,
    degradedCapture: null,
    captureRecoveryRequired: false,
  };
  private hasStarted = false;
  private handshakePromise: Promise<ReturnType<typeof parseCoreHandshake>> | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private captureActive = false;
  private activeRecordingId: string | null = null;
  private protocolFault: string | null = null;
  private readonly eventListeners = new Set<(event: CoreEvent) => void>();
  private recoveryPersistence: Promise<void> = Promise.resolve();

  constructor(private readonly options: CoreClientOptions) {}

  snapshot(): JsonValue {
    return {
      state: this.supervisor.state,
      restartCount: this.supervisor.restartCount,
      startedAt: this.supervisor.startedAt,
      executableName: this.supervisor.executable ? executableBasename(this.supervisor.executable) : null,
      rawPathExposed: false,
      pid: this.supervisor.pid,
      lastExit: this.supervisor.lastExit,
      lastHandshake: this.supervisor.lastHandshake,
      captureActive: this.captureActive,
      activeRecordingId: this.activeRecordingId,
      degradedCapture: this.supervisor.degradedCapture
        ? {
            at: this.supervisor.degradedCapture.at,
            method: this.supervisor.degradedCapture.method,
            recordingId: this.supervisor.degradedCapture.recordingId,
            lastConfirmedActive: true,
          }
        : null,
      captureRecoveryRequired: this.supervisor.captureRecoveryRequired,
    };
  }

  rendererSnapshot(): JsonValue {
    const snapshot = objectValue(this.snapshot());
    const lastExit = objectValue(snapshot.lastExit ?? null);
    return {
      state: snapshot.state ?? "failed",
      restartCount: snapshot.restartCount ?? 0,
      startedAt: snapshot.startedAt ?? null,
      executableName: snapshot.executableName ?? null,
      rawPathExposed: false,
      lastExit: snapshot.lastExit === null
        ? null
        : {
            code: lastExit.code ?? null,
            signal: lastExit.signal ?? null,
            at: lastExit.at ?? null,
            hadError: typeof lastExit.error === "string",
          },
      lastHandshake: snapshot.lastHandshake ?? null,
      captureActive: snapshot.captureActive === true,
      degradedCapture: snapshot.degradedCapture ?? null,
      captureRecoveryRequired: snapshot.captureRecoveryRequired === true,
    };
  }

  captureGuardPhase(): CaptureGuardPhase {
    if (this.registry.hasMethod("capture.stop")) return "finalizing";
    if (this.registry.hasAnyMethod(CAPTURE_START_METHODS)) return "starting";
    return this.captureActive ? "recording" : "idle";
  }

  async call(method: string, params: JsonValue = null): Promise<CoreResponse> {
    const operation = CORE_OPERATIONS.get(method);
    if (!operation || !this.options.allowedMethods.has(method)) {
      throw new CoreClientError("CORE_METHOD_DENIED", `IPC method is not allowed: ${method}`, false);
    }
    const validatedParams = operation.paramsSchema.parse(params);
    if (operation.requiresHandshake) await this.ensureHandshake();
    return this.rawCall(operation, validatedParams);
  }

  subscribe(listener: (event: CoreEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  restoreCaptureRecovery(metadata: Omit<CaptureDegradedMetadata, "lastConfirmedActive">): void {
    const restored: CaptureDegradedMetadata = { ...metadata, lastConfirmedActive: true };
    this.supervisor.state = "capture-connection-degraded";
    this.supervisor.degradedCapture = restored;
    this.supervisor.captureRecoveryRequired = true;
    this.activeRecordingId = restored.recordingId;
  }

  waitForRecoveryPersistence(): Promise<void> {
    return this.recoveryPersistence;
  }

  completeCaptureRecovery(): void {
    this.captureActive = false;
    this.activeRecordingId = null;
    this.supervisor.captureRecoveryRequired = false;
    this.supervisor.degradedCapture = null;
    if (this.supervisor.state === "capture-connection-degraded") this.supervisor.state = "running";
    this.resolveCaptureRecovery();
  }

  async retryConnection(): Promise<JsonValue> {
    if (this.supervisor.state === "capture-connection-degraded") {
      const response = await this.call("capture.status");
      if (!response.ok) {
        throw new CoreClientError(
          "CORE_UNAVAILABLE",
          response.error?.message ?? "candor-core capture status could not be confirmed",
          true,
        );
      }
      this.supervisor.state = "running";
      this.supervisor.degradedCapture = null;
      return this.rendererSnapshot();
    }
    await this.ensureHandshake();
    const response = await this.call("core.status");
    if (!response.ok) {
      throw new CoreClientError("CORE_UNAVAILABLE", response.error?.message ?? "candor-core is unavailable", true);
    }
    return this.rendererSnapshot();
  }

  async ensureHandshake(): Promise<ReturnType<typeof parseCoreHandshake>> {
    if (this.child && this.supervisor.lastHandshake?.ok) {
      return parseCoreHandshake(this.supervisor.lastHandshake.version ?? null);
    }
    if (this.handshakePromise) return this.handshakePromise;

    const operation = CORE_OPERATIONS.get("core.version");
    if (!operation) {
      throw new CoreClientError("CORE_METHOD_DENIED", "Core version operation is not registered", false);
    }
    this.handshakePromise = (async () => {
      try {
        const response = await this.rawCall(operation, operation.paramsSchema.parse(null));
        if (!response.ok) {
          throw new CoreClientError(
            "CORE_PROTOCOL_MISMATCH",
            response.error?.message ?? "candor-core version handshake failed",
            false,
          );
        }
        const handshake = parseCoreHandshake(response.result ?? null);
        this.supervisor.lastHandshake = {
          ok: true,
          at: new Date().toISOString(),
          version: response.result ?? null,
        };
        return handshake;
      } catch (error) {
        this.handshakePromise = null;
        this.supervisor.lastHandshake = {
          ok: false,
          at: new Date().toISOString(),
          error: errorMessage(error),
        };
        throw error;
      }
    })();
    return this.handshakePromise;
  }

  private rawCall(operation: CoreOperationDefinition, params: JsonValue): Promise<CoreResponse> {
    try {
      this.start();
    } catch (error) {
      return Promise.reject(error);
    }
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      return Promise.reject(new CoreClientError("CORE_UNAVAILABLE", "candor-core is not available", true));
    }

    const request = createCoreRequest(operation.method, params);
    const line = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_CORE_REQUEST_LINE_BYTES) {
      return Promise.reject(
        new CoreClientError("CORE_PROTOCOL_FAULT", "candor-core request exceeds the JSONL boundary limit", false),
      );
    }
    const configuredTimeout = operation.timeoutMs;
    const timeoutMs = this.options.timeoutMsForTesting?.(operation.method, configuredTimeout) ?? configuredTimeout;
    const response = this.registry.register(
      request.requestId,
      operation.method,
      timeoutMs,
      (method) => this.handleTimeout(method),
    );
    child.stdin.write(line, "utf8", (error) => {
      if (error) {
        this.registry.reject(
          request.requestId,
          new CoreClientError("CORE_UNAVAILABLE", "candor-core request could not be written", true, {
            cause: error,
          }),
        );
      }
    });
    return response;
  }

  async exerciseRestartForSmoke(): Promise<JsonValue> {
    const before = this.snapshot();
    await this.stopForRestart();
    await this.ensureHandshake();
    const status = await this.call("core.status");
    return {
      before,
      after: this.snapshot(),
      status: status.result ?? null,
    };
  }

  async shutdown(): Promise<void> {
    if (this.captureGuardPhase() !== "idle") {
      throw new CoreClientError(
        "CORE_CAPTURE_ACTIVE",
        "candor-core shutdown is denied while capture is active or changing state",
        false,
      );
    }
    const child = this.child;
    if (!child || child.killed) return;
    this.supervisor.state = "stopping";
    void this.call("core.shutdown").catch(() => undefined);
    await this.waitForExit(child, 5000).catch(() => {
      child.kill("SIGKILL");
    });
  }

  async finalizeCaptureForClose(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const phase = this.captureGuardPhase();
      if (phase === "idle") return;
      if (phase === "recording") {
        const response = await this.call("capture.stop");
        if (!response.ok) {
          throw new CoreClientError(
            "CORE_CAPTURE_FINALIZE_FAILED",
            "candor-core could not durably finalize the active capture",
            Boolean(response.error?.retryable),
          );
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new CoreClientError(
      "CORE_CAPTURE_FINALIZE_TIMEOUT",
      "candor-core did not durably finalize capture before the close deadline",
      true,
    );
  }

  private start(): void {
    if (this.child) return;
    const executable = this.options.executablePath();
    const isRestart = this.hasStarted;
    this.supervisor.state = "starting";
    this.supervisor.startedAt = new Date().toISOString();
    this.supervisor.executable = executable;
    this.supervisor.pid = null;
    this.supervisor.lastExit = null;
    this.supervisor.lastHandshake = null;
    this.supervisor.degradedCapture = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.protocolFault = null;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.options.spawnCore ?? defaultSpawnCore)(executable);
    } catch {
      this.supervisor.state = "failed";
      this.supervisor.lastExit = {
        code: null,
        signal: null,
        at: new Date().toISOString(),
        error: "candor-core could not be started",
      };
      throw new CoreClientError("CORE_UNAVAILABLE", "candor-core could not be started", true);
    }
    if (isRestart) this.supervisor.restartCount += 1;
    this.hasStarted = true;
    this.child = child;
    this.supervisor.pid = child.pid ?? null;
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk, child));
    this.installStderrHandler(child);
    child.on("spawn", () => {
      if (this.child === child) {
        this.supervisor.state = "running";
        this.supervisor.pid = child.pid ?? null;
      }
    });
    child.on("error", (error) => {
      if (this.child === child) {
        this.supervisor.state = "failed";
        this.supervisor.lastExit = {
          code: null,
          signal: null,
          at: new Date().toISOString(),
          error: error.message,
        };
      }
    });
    child.on("exit", (code, signal) => this.handleExit(child, code, signal));
  }

  private handleStdout(chunk: Buffer, child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > MAX_CORE_RESPONSE_LINE_BYTES) {
        this.failProtocol(child, "candor-core response exceeded the JSONL boundary limit");
        return;
      }
      const line = this.stdoutBuffer.subarray(0, newline).toString("utf8").trim();
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (!line) continue;
      try {
        const event = parseCoreEventLine(line);
        if (event) {
          for (const listener of this.eventListeners) {
            try {
              listener(event);
            } catch {
              // A renderer listener cannot fault the trusted core transport.
            }
          }
          continue;
        }
        let response = parseCoreResponseLine(line);
        const method = this.registry.methodFor(response.requestId);
        if (!method) {
          this.failProtocol(child, "candor-core returned an unknown or duplicate request id");
          return;
        }
        const operation = CORE_OPERATIONS.get(method);
        if (!operation) {
          this.failProtocol(child, "candor-core returned a response for an unregistered operation");
          return;
        }
        if (response.ok) {
          try {
            const result = operation.resultSchema.parse(response.result);
            response = {
              ...response,
              result: method === "jobs.get" ? validateCompletedJobResult(result) : result,
            };
          } catch (error) {
            const contractError = error instanceof CoreClientError
              ? error
              : new CoreClientError("CORE_RESULT_SCHEMA_INVALID", `candor-core returned an invalid result for ${method}`, false);
            this.registry.reject(response.requestId, contractError);
            this.protocolFault = contractError.message;
            this.supervisor.state = "failed";
            child.kill();
            return;
          }
        }
        if (!this.registry.resolve(response.requestId, response)) {
          this.failProtocol(child, "candor-core returned an unknown or duplicate request id");
          return;
        }
        this.updateCaptureState(method, response);
      } catch (error) {
        this.failProtocol(child, errorMessage(error));
        return;
      }
    }
    if (this.stdoutBuffer.byteLength > MAX_CORE_RESPONSE_LINE_BYTES) {
      this.failProtocol(child, "candor-core response exceeded the JSONL boundary limit");
    }
  }

  private failProtocol(child: ChildProcessWithoutNullStreams, message: string): void {
    if (this.child !== child) return;
    this.protocolFault = message;
    this.supervisor.state = "failed";
    this.registry.rejectAll(new CoreClientError("CORE_PROTOCOL_FAULT", message, false));
    child.kill();
  }

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    const wasStopping = this.supervisor.state === "stopping";
    const captureWasActive = this.captureActive;
    if (captureWasActive) this.enterCaptureRecovery("core.processExit");
    this.child = null;
    this.handshakePromise = null;
    this.captureActive = false;
    this.activeRecordingId = null;
    this.supervisor.pid = null;
    this.supervisor.state = this.protocolFault ? "failed" : wasStopping ? "stopped" : "exited";
    this.supervisor.lastExit = {
      code,
      signal,
      at: new Date().toISOString(),
      ...(this.protocolFault ? { error: this.protocolFault } : {}),
    };
    this.registry.rejectAll(
      new CoreClientError("CORE_PROCESS_EXITED", `candor-core exited (${code ?? signal ?? "unknown"})`, true),
    );
  }

  private installStderrHandler(child: ChildProcessWithoutNullStreams): void {
    let bytesLogged = 0;
    let suppressionNoted = false;
    child.stderr.on("data", (chunk: Buffer) => {
      if (!this.options.isDev) {
        if (!suppressionNoted) {
          console.error("[candor-core] diagnostic output suppressed in packaged build");
          suppressionNoted = true;
        }
        return;
      }
      const remaining = MAX_CORE_STDERR_BYTES - bytesLogged;
      if (remaining > 0) {
        const bounded = chunk.subarray(0, remaining);
        bytesLogged += bounded.byteLength;
        const diagnostic = redactCoreDiagnostic(bounded.toString("utf8")).trim();
        if (diagnostic) console.error(`[candor-core] ${diagnostic}`);
      }
      if (chunk.byteLength > remaining && !suppressionNoted) {
        console.error(`[candor-core] further diagnostic output suppressed after ${MAX_CORE_STDERR_BYTES} bytes`);
        suppressionNoted = true;
      }
    });
  }

  private updateCaptureState(method: string, response: CoreResponse): void {
    if (!response.ok) return;
    if (method === "capture.stop") {
      this.captureActive = false;
      this.activeRecordingId = null;
      this.supervisor.captureRecoveryRequired = false;
      this.supervisor.degradedCapture = null;
      if (this.supervisor.state === "capture-connection-degraded") this.supervisor.state = "running";
      this.resolveCaptureRecovery();
    }
    else if (method === "capture.startMic" || method === "capture.startSystem" || method === "capture.startMicAndSystem") {
      this.captureActive = true;
      this.activeRecordingId = stringFromNestedResult(response.result, "capture", "recordingId");
    } else if (method === "capture.status") {
      const status = objectValue(response.result ?? null);
      this.captureActive = status.active === true;
      this.activeRecordingId = this.captureActive
        ? stringFromNestedResult(response.result, "activeSession", "recordingId")
        : null;
      if (this.supervisor.state === "capture-connection-degraded") {
        this.supervisor.state = "running";
        this.supervisor.degradedCapture = null;
        this.supervisor.captureRecoveryRequired = false;
        this.resolveCaptureRecovery();
      }
    }
  }

  private handleTimeout(method: string): void {
    if (this.captureActive) {
      this.enterCaptureRecovery(method);
      return;
    }
    this.supervisor.state = "failed";
    this.protocolFault = "candor-core became unresponsive";
    this.child?.kill();
  }

  private enterCaptureRecovery(method: string): void {
    const metadata: CaptureDegradedMetadata = {
      at: new Date().toISOString(),
      method,
      recordingId: this.activeRecordingId,
      lastConfirmedActive: true,
    };
    this.supervisor.state = "capture-connection-degraded";
    this.supervisor.degradedCapture = metadata;
    this.supervisor.captureRecoveryRequired = true;
    this.recoveryPersistence = Promise.resolve(this.options.onCaptureConnectionDegraded?.(metadata)).catch(() => undefined);
  }

  private resolveCaptureRecovery(): void {
    this.recoveryPersistence = Promise.resolve(this.options.onCaptureRecoveryResolved?.()).catch(() => undefined);
  }

  private async stopForRestart(): Promise<void> {
    await this.ensureHandshake();
    const capture = await this.call("capture.status");
    this.updateCaptureState("capture.status", capture);
    if (this.captureActive) {
      throw new CoreClientError(
        "CORE_CAPTURE_ACTIVE",
        "candor-core restart is denied while capture is active",
        false,
      );
    }
    await this.shutdown();
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`candor-core did not exit within ${timeoutMs} ms`)), timeoutMs);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
