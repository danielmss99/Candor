import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { CoreClientError, errorMessage } from "./core-errors.js";
import { objectValue, type JsonValue } from "./json.js";
import {
  CORE_PROTOCOL_VERSION,
  createCoreRequest,
  MAX_CORE_REQUEST_LINE_BYTES,
  MAX_CORE_RESPONSE_LINE_BYTES,
  parseCoreResponseLine,
  type CoreResponse,
} from "./protocol.js";
import { RequestRegistry } from "./request-registry.js";

export type CoreSupervisorLifecycle =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed";

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
}

type SpawnCore = (executable: string) => ChildProcessWithoutNullStreams;

interface CoreClientOptions {
  executablePath: () => string;
  allowedMethods: ReadonlySet<string>;
  isDev: boolean;
  spawnCore?: SpawnCore;
}

const MAX_CORE_STDERR_BYTES = 64 * 1024;

function defaultSpawnCore(executable: string): ChildProcessWithoutNullStreams {
  return spawn(executable, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      CANDOR_CORE_TRANSPORT: "stdio-json-lines",
      CANDOR_NETWORK_POLICY: "disabled-by-default",
    },
  });
}

function redactCoreDiagnostic(value: string): string {
  return value
    .replace(/\b[A-Za-z]:[\\/][^\r\n\t"']+/g, "<path>")
    .replace(/(?:^|\s)\/(?:Users|home|root|tmp|var|private)\/[^\s"']+/g, " <path>")
    .replace(/\b(?:sk-(?:live|prod)-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g, "<secret>");
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
  };
  private hasStarted = false;
  private handshakePromise: Promise<void> | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private captureActive = false;
  private protocolFault: string | null = null;

  constructor(private readonly options: CoreClientOptions) {}

  snapshot(): JsonValue {
    return {
      state: this.supervisor.state,
      restartCount: this.supervisor.restartCount,
      startedAt: this.supervisor.startedAt,
      executableName: this.supervisor.executable ? path.basename(this.supervisor.executable) : null,
      rawPathExposed: false,
      pid: this.supervisor.pid,
      lastExit: this.supervisor.lastExit,
      lastHandshake: this.supervisor.lastHandshake,
      captureActive: this.captureActive,
    };
  }

  call(method: string, params: JsonValue = null, timeoutMs = 5000): Promise<CoreResponse> {
    if (!this.options.allowedMethods.has(method)) {
      return Promise.reject(new CoreClientError("CORE_METHOD_DENIED", `IPC method is not allowed: ${method}`, false));
    }
    this.start();
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      return Promise.reject(new CoreClientError("CORE_UNAVAILABLE", "candor-core is not available", true));
    }

    const request = createCoreRequest(method, params);
    const line = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_CORE_REQUEST_LINE_BYTES) {
      return Promise.reject(
        new CoreClientError("CORE_PROTOCOL_FAULT", "candor-core request exceeds the JSONL boundary limit", false),
      );
    }
    const response = this.registry.register(request.requestId, method, timeoutMs, () => this.handleTimeout());
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

  async ensureHandshake(): Promise<void> {
    if (this.child && this.supervisor.lastHandshake?.ok) return;
    if (this.handshakePromise) return this.handshakePromise;

    this.handshakePromise = (async () => {
      try {
        const response = await this.call("core.version");
        if (!response.ok) {
          throw new CoreClientError(
            "CORE_PROTOCOL_MISMATCH",
            response.error?.message ?? "candor-core version handshake failed",
            false,
          );
        }
        const version = objectValue(response.result ?? null);
        if (version.protocolVersion !== CORE_PROTOCOL_VERSION) {
          throw new CoreClientError("CORE_PROTOCOL_MISMATCH", "candor-core uses an incompatible protocol version", false);
        }
        this.supervisor.lastHandshake = {
          ok: true,
          at: new Date().toISOString(),
          version: response.result ?? null,
        };
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
    const child = this.child;
    if (!child || child.killed) return;
    this.supervisor.state = "stopping";
    void this.call("core.shutdown", null, 2000).catch(() => undefined);
    await this.waitForExit(child, 5000).catch(() => {
      child.kill("SIGKILL");
    });
  }

  private start(): void {
    if (this.child) return;
    const executable = this.options.executablePath();
    if (this.hasStarted) this.supervisor.restartCount += 1;
    this.hasStarted = true;
    this.supervisor.state = "starting";
    this.supervisor.startedAt = new Date().toISOString();
    this.supervisor.executable = executable;
    this.supervisor.pid = null;
    this.supervisor.lastExit = null;
    this.supervisor.lastHandshake = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.protocolFault = null;

    const child = (this.options.spawnCore ?? defaultSpawnCore)(executable);
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
        const response = parseCoreResponseLine(line);
        const method = this.registry.methodFor(response.requestId);
        if (!method || !this.registry.resolve(response.requestId, response)) {
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
    this.child = null;
    this.handshakePromise = null;
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
    if (method === "capture.stop") this.captureActive = false;
    else if (method === "capture.startMic" || method === "capture.startSystem" || method === "capture.startMicAndSystem") {
      this.captureActive = true;
    } else if (method === "capture.status") {
      this.captureActive = objectValue(response.result ?? null).active === true;
    }
  }

  private handleTimeout(): void {
    this.supervisor.state = "failed";
    if (!this.captureActive) {
      this.protocolFault = "candor-core became unresponsive";
      this.child?.kill();
    }
  }

  private async stopForRestart(): Promise<void> {
    await this.ensureHandshake();
    const capture = await this.call("capture.status", null, 5000);
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
