export interface RequestToken {
  scope: string;
  sequence: number;
}

export class RequestCoordinator {
  private readonly latest = new Map<string, number>();

  begin(scope: string): RequestToken {
    const sequence = (this.latest.get(scope) ?? 0) + 1;
    this.latest.set(scope, sequence);
    return { scope, sequence };
  }

  isCurrent(token: RequestToken): boolean {
    return this.latest.get(token.scope) === token.sequence;
  }

  invalidate(scope: string): void {
    this.latest.set(scope, (this.latest.get(scope) ?? 0) + 1);
  }
}

export class ExclusiveActionRegistry {
  private readonly active = new Set<string>();

  acquire(scope: string): (() => void) | null {
    if (this.active.has(scope)) return null;
    this.active.add(scope);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(scope);
    };
  }

  isActive(scope: string): boolean {
    return this.active.has(scope);
  }
}
