import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@/components/ui/toast";
import { COMPLETION_TOAST_DURATION_MS } from "@/platform/completion-toast-duration";
import { useCompletionToast } from "./use-completion-toast";

// Issue #356 moved the completion toast's undo window behind the
// build-time platform seam (`@/platform/completion-toast-duration`) so it
// can differ per target without becoming two constants that can drift.
// These tests deliberately import the seam's own value rather than writing
// a literal `10_000`/`3_500` here — asserting a hard-coded figure under
// vitest's "test" mode would only prove the web fallback works, and would
// look like a broken seam the day Android's figure is asserted the same
// way.
vi.mock("@/components/ui/toast", () => {
  const toast = vi.fn() as unknown as typeof import("@/components/ui/toast").toast;
  let nextCustomToastId = 1;
  // biome-ignore lint/suspicious/noExplicitAny: attaching mock methods to a mock function, the same shape sonner's own `toast` carries in production.
  (toast as any).custom = vi.fn(() => `custom-toast-${nextCustomToastId++}`);
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  (toast as any).dismiss = vi.fn();
  return { toast };
});

describe("the completion-toast-duration platform seam", () => {
  it("resolves to the web figure under vitest's test mode", () => {
    // vitest's mode ("test") isn't in vite.config.ts's BUILD_TARGETS, so
    // the seam's own fallback-to-"web" rule applies here exactly as it
    // does for an unqualified `vite build` — this is that fallback, not a
    // special case for tests.
    expect(COMPLETION_TOAST_DURATION_MS).toBe(10_000);
  });
});

describe("useCompletionToast", () => {
  beforeEach(() => {
    vi.mocked(toast.custom).mockClear();
    vi.mocked(toast.dismiss).mockClear();
  });

  it("raises the toast with the seam's resolved duration, not a literal", () => {
    const { result } = renderHook(() => useCompletionToast());

    result.current.raise("1 task completed", vi.fn());

    expect(toast.custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ duration: COMPLETION_TOAST_DURATION_MS }),
    );
  });

  it("scopes the keyboard undo window to the same duration the toast itself was given", () => {
    const onUndo = vi.fn();
    const { result } = renderHook(() => useCompletionToast());

    result.current.raise("1 task completed", onUndo);

    const call = vi.mocked(toast.custom).mock.calls[0];
    if (!call) throw new Error("toast.custom was not called");
    const [, options] = call as [unknown, { duration: number; onAutoClose: () => void }];

    // The toast and the keyboard binding aren't two constants that happen
    // to agree — `fireUndo` reads the same ref this `onAutoClose` (sonner's
    // own "the `duration` elapsed" callback) clears, so simulating sonner
    // firing it after `options.duration` is up is the one door onto
    // proving the keyboard window ends exactly when the toast's own timer
    // does.
    expect(options.duration).toBe(COMPLETION_TOAST_DURATION_MS);
    options.onAutoClose();

    result.current.fireUndo();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("keeps the keyboard undo live while the toast's own window hasn't elapsed", () => {
    const onUndo = vi.fn();
    const { result } = renderHook(() => useCompletionToast());

    result.current.raise("1 task completed", onUndo);
    result.current.fireUndo();

    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
