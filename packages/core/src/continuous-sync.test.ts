import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startContinuousSync } from "./continuous-sync";

const INTERVAL_MS = 5000;

describe("continuous sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs immediately on start when visible", async () => {
    const run = vi.fn(async () => {});
    startContinuousSync({
      run,
      intervalMs: INTERVAL_MS,
      isVisible: () => true,
      subscribe: () => () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not run on start when hidden", async () => {
    const run = vi.fn(async () => {});
    startContinuousSync({
      run,
      intervalMs: INTERVAL_MS,
      isVisible: () => false,
      subscribe: () => () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("polls repeatedly on the interval while visible", async () => {
    const run = vi.fn(async () => {});
    startContinuousSync({
      run,
      intervalMs: INTERVAL_MS,
      isVisible: () => true,
      subscribe: () => () => {},
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(run).toHaveBeenCalledTimes(4); // immediate + 3 ticks
  });

  it("never polls while hidden, no matter how many intervals pass", async () => {
    const run = vi.fn(async () => {});
    startContinuousSync({
      run,
      intervalMs: INTERVAL_MS,
      isVisible: () => false,
      subscribe: () => () => {},
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
    expect(run).not.toHaveBeenCalled();
  });

  it("a wake signal triggers a run immediately, without waiting for the next interval", async () => {
    const run = vi.fn(async () => {});
    let wake: () => void = () => {};
    startContinuousSync({
      run,
      intervalMs: INTERVAL_MS,
      isVisible: () => true,
      subscribe: (w) => {
        wake = w;
        return () => {};
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("ignores a wake signal while hidden — a backgrounded tab still does not sync", async () => {
    const run = vi.fn(async () => {});
    let wake: () => void = () => {};
    startContinuousSync({
      run,
      intervalMs: INTERVAL_MS,
      isVisible: () => false,
      subscribe: (w) => {
        wake = w;
        return () => {};
      },
    });

    wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not stack a second run while one is still in flight", async () => {
    let resolveRun: () => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
    );
    let wake: () => void = () => {};
    startContinuousSync({
      run,
      intervalMs: INTERVAL_MS,
      isVisible: () => true,
      subscribe: (w) => {
        wake = w;
        return () => {};
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    // The interval tick and a wake both land while the first run is still pending.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    wake();
    expect(run).toHaveBeenCalledTimes(1);

    resolveRun();
    await vi.advanceTimersByTimeAsync(0);
    wake();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stop() clears the interval and unsubscribes from wake signals", async () => {
    const run = vi.fn(async () => {});
    let wake: () => void = () => {};
    let unsubscribed = false;
    const handle = startContinuousSync({
      run,
      intervalMs: INTERVAL_MS,
      isVisible: () => true,
      subscribe: (w) => {
        wake = w;
        return () => {
          unsubscribed = true;
        };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    handle.stop();
    expect(unsubscribed).toBe(true);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    wake();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
