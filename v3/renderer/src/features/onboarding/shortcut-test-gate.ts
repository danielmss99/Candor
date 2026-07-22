export class ShortcutTestGate {
  private armed = false;
  private suppressingRecorderOpen = false;
  private suppressionGeneration = 0;

  arm(): void {
    this.armed = true;
  }

  disarm(): void {
    this.armed = false;
  }

  consumeTrigger(): boolean {
    if (!this.armed) return false;
    this.armed = false;
    this.suppressingRecorderOpen = true;
    const generation = ++this.suppressionGeneration;
    queueMicrotask(() => {
      if (this.suppressionGeneration === generation) this.suppressingRecorderOpen = false;
    });
    return true;
  }

  shouldSuppressRecorderOpen(): boolean {
    return this.armed || this.suppressingRecorderOpen;
  }
}

export const recorderShortcutTestGate = new ShortcutTestGate();
