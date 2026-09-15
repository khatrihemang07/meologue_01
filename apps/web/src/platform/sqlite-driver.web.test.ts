import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsecureContextError } from "@/lib/entry-store-errors";

const { connectMock, sqliteWorkerDriverMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  sqliteWorkerDriverMock: vi.fn(),
}));

// sqlite-driver.web's own worker-protocol logic (open handshake, retries,
// message framing) belongs to sqlite-worker-driver.test.ts. This file only
// exercises what createDriver() itself decides: whether to build a Worker at
// all, and what it hands back once SqliteWorkerDriver.connect() resolves.
vi.mock("./sqlite-worker-driver", () => ({
  SqliteWorkerDriver: sqliteWorkerDriverMock,
}));

/**
 * jsdom has no `Worker` global, so this stub stands in for the real one —
 * and counts its own constructions, because "no Worker was built" is the
 * actual claim of the insecure-context test below. Counting
 * `SqliteWorkerDriver` instead would be a step removed: `new Worker(...)`
 * runs first in `createDriver`, so the driver mock staying uncalled is also
 * consistent with a Worker having been spun up and then abandoned.
 */
let workersConstructed = 0;

class MockWorker {
  onmessage: unknown = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    workersConstructed += 1;
  }
}

describe("sqlite-driver.web", () => {
  const originalIsSecureContext = window.isSecureContext;

  beforeEach(() => {
    workersConstructed = 0;
    vi.stubGlobal("Worker", MockWorker);
    connectMock.mockReset().mockResolvedValue(undefined);
    sqliteWorkerDriverMock.mockReset().mockImplementation(function (this: unknown) {
      Object.assign(this as object, { connect: connectMock });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "isSecureContext", {
      value: originalIsSecureContext,
      configurable: true,
    });
  });

  it("rejects with InsecureContextError and never constructs a Worker when the context is insecure", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    const { createDriver } = await import("./sqlite-driver.web");

    await expect(createDriver()).rejects.toBeInstanceOf(InsecureContextError);

    // The claim under test is that the secure-context check runs BEFORE the
    // Worker is built — asserting only the rejected error type would still
    // pass if the check ran after construction.
    expect(workersConstructed).toBe(0);
    expect(sqliteWorkerDriverMock).not.toHaveBeenCalled();
  });

  it("constructs a Worker and connects a SqliteWorkerDriver when the context is secure", async () => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const { createDriver } = await import("./sqlite-driver.web");

    const driver = await createDriver();

    expect(workersConstructed).toBe(1);
    expect(sqliteWorkerDriverMock).toHaveBeenCalledTimes(1);
    expect(sqliteWorkerDriverMock.mock.calls[0]?.[0]).toBeInstanceOf(MockWorker);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(driver).toBeInstanceOf(sqliteWorkerDriverMock);
  });
});
