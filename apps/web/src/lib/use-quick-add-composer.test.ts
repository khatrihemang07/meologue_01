import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { useQuickAddComposer } from "./use-quick-add-composer";

/**
 * The pure parse/commit logic shared by `add-task-form.tsx` and
 * `quick-add-dialog.tsx` (issue #260's own brief — "don't fork the add
 * logic"). This is the same behaviour `add-task-form.test.tsx` already
 * covered indirectly, through the always-open field, before issue #260's
 * click-to-reveal rebuild moved it out of that file; tested directly here
 * so the shared hook has its own coverage independent of either caller's
 * chrome.
 */
describe("useQuickAddComposer", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ smartDatesEnabled: true });
  });

  it("calls onAdd with the parsed fields, clears value/seed and bumps resetKey on a real commit", () => {
    const onAdd = vi.fn();
    const onCommitted = vi.fn();
    const { result } = renderHook(() => useQuickAddComposer({ onAdd, onCommitted }));

    act(() => {
      result.current.setValue("buy milk @errands");
    });
    const resetKeyBefore = result.current.resetKey;

    act(() => {
      result.current.commit("buy milk @errands");
    });

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ content: "buy milk", labelNames: ["errands"] }),
    );
    expect(result.current.value).toBe("");
    expect(result.current.seed).toBe("");
    expect(result.current.resetKey).toBe(resetKeyBefore + 1);
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("does not call onAdd or onCommitted for a blank/token-only line", () => {
    const onAdd = vi.fn();
    const onCommitted = vi.fn();
    const { result } = renderHook(() => useQuickAddComposer({ onAdd, onCommitted }));

    act(() => {
      result.current.commit("tomorrow");
    });

    expect(onAdd).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it("remount seeds a fresh value/seed and bumps resetKey without calling onAdd", () => {
    const onAdd = vi.fn();
    const { result } = renderHook(() => useQuickAddComposer({ onAdd }));
    const resetKeyBefore = result.current.resetKey;

    act(() => {
      result.current.remount("buy milk");
    });

    expect(result.current.value).toBe("buy milk");
    expect(result.current.seed).toBe("buy milk");
    expect(result.current.resetKey).toBe(resetKeyBefore + 1);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("autocomplete.getProjects/getLabels read the live props, not a snapshot at mount", () => {
    const { result, rerender } = renderHook(
      ({ projects }: { projects: { id: string; name: string }[] }) =>
        useQuickAddComposer({ onAdd: vi.fn(), projects }),
      { initialProps: { projects: [{ id: "p1", name: "Errands" }] } },
    );

    expect(result.current.autocomplete.getProjects()).toEqual([{ id: "p1", name: "Errands" }]);

    rerender({ projects: [{ id: "p2", name: "Home" }] });

    expect(result.current.autocomplete.getProjects()).toEqual([{ id: "p2", name: "Home" }]);
  });

  // Issue #373: multi-line paste, deferred to the dialog rather than
  // silently split or merged.
  describe("multi-line paste", () => {
    it("onMultiLinePaste populates pendingPasteLines, and nothing is added yet", () => {
      const onAdd = vi.fn();
      const { result } = renderHook(() => useQuickAddComposer({ onAdd }));

      act(() => {
        result.current.onMultiLinePaste(["Task A", "Task B", "Task C"]);
      });

      expect(result.current.pendingPasteLines).toEqual(["Task A", "Task B", "Task C"]);
      expect(onAdd).not.toHaveBeenCalled();
    });

    it("confirmSplitPaste calls onAdd once per line, through the same path a normal commit uses, then clears pendingPasteLines", () => {
      const onAdd = vi.fn();
      const { result } = renderHook(() => useQuickAddComposer({ onAdd }));

      act(() => {
        result.current.onMultiLinePaste(["buy milk", "call mom"]);
      });
      act(() => {
        result.current.confirmSplitPaste();
      });

      expect(onAdd).toHaveBeenCalledTimes(2);
      expect(onAdd).toHaveBeenNthCalledWith(1, expect.objectContaining({ content: "buy milk" }));
      expect(onAdd).toHaveBeenNthCalledWith(2, expect.objectContaining({ content: "call mom" }));
      expect(result.current.pendingPasteLines).toBeNull();
    });

    it("confirmSplitPaste skips a line that resolves to no content, same as a normal commit would", () => {
      const onAdd = vi.fn();
      const { result } = renderHook(() => useQuickAddComposer({ onAdd }));

      act(() => {
        result.current.onMultiLinePaste(["buy milk", "tomorrow"]);
      });
      act(() => {
        result.current.confirmSplitPaste();
      });

      // "tomorrow" alone parses to empty content — `commit`'s own "nothing
      // to add" skip, reused unchanged rather than re-implemented.
      expect(onAdd).toHaveBeenCalledTimes(1);
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ content: "buy milk" }));
    });

    it("confirmMergePaste calls onAdd once, with every line joined by a space", () => {
      const onAdd = vi.fn();
      const { result } = renderHook(() => useQuickAddComposer({ onAdd }));

      act(() => {
        result.current.onMultiLinePaste(["buy milk", "call mom"]);
      });
      act(() => {
        result.current.confirmMergePaste();
      });

      expect(onAdd).toHaveBeenCalledTimes(1);
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ content: "buy milk call mom" }));
      expect(result.current.pendingPasteLines).toBeNull();
    });

    it("cancelPendingPaste calls onAdd zero times and clears pendingPasteLines", () => {
      const onAdd = vi.fn();
      const { result } = renderHook(() => useQuickAddComposer({ onAdd }));

      act(() => {
        result.current.onMultiLinePaste(["buy milk", "call mom"]);
      });
      act(() => {
        result.current.cancelPendingPaste();
      });

      expect(onAdd).not.toHaveBeenCalled();
      expect(result.current.pendingPasteLines).toBeNull();
    });
  });
});
