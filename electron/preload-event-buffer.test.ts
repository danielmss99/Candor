import { describe, expect, it, vi } from "vitest";
import { BoundedLatestEventBuffer } from "./preload-event-buffer.cjs";

describe("preload fixed-event buffer", () => {
  it("delivers the latest pre-subscription intent exactly once", async () => {
    const buffer = new BoundedLatestEventBuffer<number>();
    buffer.publish(1);
    buffer.publish(2);
    const listener = vi.fn();
    buffer.subscribe(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(2);
  });

  it("broadcasts one pending recorder intent to listeners installed in the same startup turn", async () => {
    const buffer = new BoundedLatestEventBuffer<string>();
    buffer.publish("open-recorder");
    const first = vi.fn();
    const second = vi.fn();
    buffer.subscribe(first);
    buffer.subscribe(second);
    await Promise.resolve();
    expect(first).toHaveBeenCalledWith("open-recorder");
    expect(second).toHaveBeenCalledWith("open-recorder");
  });

  it("does not deliver a buffered intent after the listener unsubscribes", async () => {
    const buffer = new BoundedLatestEventBuffer<string>();
    buffer.publish("open-recorder");
    const listener = vi.fn();
    const unsubscribe = buffer.subscribe(listener);
    unsubscribe();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  it("broadcasts live events without retaining history", () => {
    const buffer = new BoundedLatestEventBuffer<string>();
    const first = vi.fn();
    const second = vi.fn();
    buffer.subscribe(first);
    const unsubscribeSecond = buffer.subscribe(second);
    buffer.publish("first");
    unsubscribeSecond();
    buffer.publish("second");
    expect(first.mock.calls).toEqual([["first"], ["second"]]);
    expect(second.mock.calls).toEqual([["first"]]);
  });
});
