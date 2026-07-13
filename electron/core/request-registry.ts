import { CoreClientError } from "./core-errors.js";

interface PendingRequest<T> {
  method: string;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

export class RequestRegistry<T> {
  private readonly pending = new Map<string, PendingRequest<T>>();

  register(
    requestId: string,
    method: string,
    timeoutMs: number,
    onTimeout: (method: string) => void,
  ): Promise<T> {
    if (this.pending.has(requestId)) {
      throw new CoreClientError("CORE_PROTOCOL_FAULT", "duplicate core request id", false);
    }
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        onTimeout(method);
        reject(new CoreClientError("CORE_TIMEOUT", `candor-core timed out for ${method}`, true));
      }, timeoutMs);
      this.pending.set(requestId, { method, resolve, reject, timeout });
    });
  }

  methodFor(requestId: string): string | null {
    return this.pending.get(requestId)?.method ?? null;
  }

  resolve(requestId: string, value: T): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    this.pending.delete(requestId);
    entry.resolve(value);
    return true;
  }

  reject(requestId: string, reason: Error): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    this.pending.delete(requestId);
    entry.reject(reason);
    return true;
  }

  rejectAll(reason: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(reason);
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
