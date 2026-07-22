// @ts-check

/** @template T */
class BoundedLatestEventBuffer {
  /** @type {Set<(value: T) => void>} */
  listeners = new Set();
  /** @type {T | undefined} */
  pending = undefined;
  hasPending = false;
  flushScheduled = false;

  /** @param {T} value */
  publish(value) {
    if (this.listeners.size === 0) {
      this.pending = value;
      this.hasPending = true;
      return;
    }
    for (const listener of this.listeners) listener(value);
  }

  /** @param {(value: T) => void} listener */
  subscribe(listener) {
    this.listeners.add(listener);
    this.schedulePendingFlush();
    return () => this.listeners.delete(listener);
  }

  schedulePendingFlush() {
    if (!this.hasPending || this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (!this.hasPending || this.listeners.size === 0) return;
      const value = /** @type {T} */ (this.pending);
      this.pending = undefined;
      this.hasPending = false;
      for (const listener of this.listeners) listener(value);
    });
  }
}

exports.BoundedLatestEventBuffer = BoundedLatestEventBuffer;
