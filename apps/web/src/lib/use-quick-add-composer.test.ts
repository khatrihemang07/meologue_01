import type { Section } from "@meologue/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { useQuickAddComposer } from "./use-quick-add-composer";

function section(overrides: Partial<Section> = {}): Section {
  return {
    id: "s1",
    deviceId: "device-a",
    projectId: "p2",
    name: "Cutover night",
    description: null,
    orderKey: "A",
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

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
    // Issue #388: `@errands` only matches once "errands" is a real Label
    // this hook knows about — the composer always supplies `labelNames`
    // (even `[]`, once a caller wires `labels` at all), so an unmatched
    // `@errands` would otherwise stay literal in `content` instead of
    // resolving.
    const { result } = renderHook(() =>
      useQuickAddComposer({ onAdd, onCommitted, labels: [{ id: "l1", name: "errands" }] }),
    );

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

  it("commits the explicit Description field with the task and clears it", () => {
    const onAdd = vi.fn();
    const { result } = renderHook(() => useQuickAddComposer({ onAdd }));

    act(() => result.current.setDescription("Bring the **receipt**"));
    act(() => result.current.commit("Return parcel"));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Return parcel",
        description: "Bring the **receipt**",
      }),
    );
    expect(result.current.description).toBe("");
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

  // Issue #388: `composer.options.projectNames`/`labelNames` are rebuilt
  // fresh every render from `projectsRef`/`labelsRef` (this hook's own
  // header comment on why those are refs, not plain state) — this proves
  // a freshly-passed `projects`/`labels` prop is reflected on the very
  // next render's `options`, not captured once at mount the way an easy
  // mistake (building `optionsRef.current` only inside a `useEffect`, say)
  // could silently produce instead.
  it("options.projectNames/labelNames/activeProjectName reflect freshly-passed props, not a value captured at mount", () => {
    const { result, rerender } = renderHook(
      (props: {
        projects: { id: string; name: string }[];
        labels: { id: string; name: string }[];
        ambientProjectName: string | null;
      }) => useQuickAddComposer({ onAdd: vi.fn(), ...props }),
      {
        initialProps: {
          projects: [{ id: "p1", name: "Errands" }],
          labels: [{ id: "l1", name: "urgent" }],
          ambientProjectName: "Errands",
        },
      },
    );

    expect(result.current.options.projectNames).toEqual(["Errands"]);
    expect(result.current.options.labelNames).toEqual(["urgent"]);
    expect(result.current.options.activeProjectName).toBe("Errands");

    rerender({
      projects: [{ id: "p2", name: "Home" }],
      labels: [{ id: "l2", name: "chores" }],
      ambientProjectName: "Home",
    });

    expect(result.current.options.projectNames).toEqual(["Home"]);
    expect(result.current.options.labelNames).toEqual(["chores"]);
    expect(result.current.options.activeProjectName).toBe("Home");
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

  // Issue #374: `web/01-anatomy.md`'s own captured pool — the placeholder
  // rotates through example strings on each fresh open, never per
  // keystroke.
  describe("placeholder", () => {
    it("advances only on a closed->open transition, not on every render", () => {
      const { result, rerender } = renderHook(
        ({ open }: { open: boolean }) => useQuickAddComposer({ onAdd: vi.fn(), open }),
        { initialProps: { open: false } },
      );
      const first = result.current.placeholder;

      // Re-rendering with `open` unchanged (still `false`) must not
      // advance it — this is the "not per keystroke" half of the rule,
      // exercised the only way a hook-level test can: a render with
      // nothing that should count as a transition.
      rerender({ open: false });
      expect(result.current.placeholder).toBe(first);

      rerender({ open: true });
      const second = result.current.placeholder;
      expect(second).not.toBe(first);

      // Staying open (typing) must not advance it further.
      rerender({ open: true });
      expect(result.current.placeholder).toBe(second);

      rerender({ open: false });
      rerender({ open: true });
      const third = result.current.placeholder;
      expect(third).not.toBe(second);
    });

    it("stays on the pool's first entry for a caller with no open/closed concept at all", () => {
      const { result } = renderHook(() => useQuickAddComposer({ onAdd: vi.fn() }));

      expect(result.current.placeholder).toBe("Submit essay on AI by Thursday p1");
    });
  });

  // Issue #388's remaining half — the interactive `/` dropdown's own web
  // layer plumbing.
  describe("Section autocomplete (issue #388)", () => {
    it("autocomplete.getSections/onCreateSection are both undefined when sectionNamesByProject isn't supplied — matches this hook's own undefined-in/undefined-out contract for every other name list", () => {
      const { result } = renderHook(() => useQuickAddComposer({ onAdd: vi.fn() }));

      expect(result.current.autocomplete.getSections).toBeUndefined();
      expect(result.current.autocomplete.onCreateSection).toBeUndefined();
    });

    it("getSections scopes to a typed #Project in the SAME text, falling back to ambientProjectName when none is typed", () => {
      const { result } = renderHook(() =>
        useQuickAddComposer({
          onAdd: vi.fn(),
          projects: [
            { id: "p1", name: "Groceries" },
            { id: "p2", name: "Work" },
          ],
          ambientProjectName: "Groceries",
          sectionNamesByProject: new Map([
            ["groceries", ["Produce"]],
            ["work", ["Cutover night"]],
          ]),
        }),
      );

      expect(result.current.autocomplete.getSections?.("")).toEqual([
        { id: "Produce", name: "Produce" },
      ]);
      expect(result.current.autocomplete.getSections?.("#Work /")).toEqual([
        { id: "Cutover night", name: "Cutover night" },
      ]);
    });

    it("onCreateSection resolves the active Project's real id and forwards it, not the Project's name", () => {
      const onCreateSection = vi.fn();
      const { result } = renderHook(() =>
        useQuickAddComposer({
          onAdd: vi.fn(),
          projects: [
            { id: "p1", name: "Inbox" },
            { id: "p2", name: "Work" },
          ],
          ambientProjectName: "Inbox",
          sectionNamesByProject: new Map([["inbox", []]]),
          onCreateSection,
        }),
      );

      act(() => {
        result.current.autocomplete.onCreateSection?.("#Work /Cutover", "Cutover");
      });

      expect(onCreateSection).toHaveBeenCalledWith("p2", "Cutover");
    });

    it("fetches a typed, NON-ambient Project's own Sections on demand via listSections, and getSections reflects them once resolved", async () => {
      const listSections = vi.fn(async (projectId: string) => [
        section({ id: "s1", projectId, name: "Cutover night" }),
      ]);
      const { result } = renderHook(() =>
        useQuickAddComposer({
          onAdd: vi.fn(),
          projects: [
            { id: "p1", name: "Groceries" },
            { id: "p2", name: "Work" },
          ],
          ambientProjectName: "Groceries",
          // Only the ambient Project's own Sections are known eagerly —
          // the identical shape `todo-page.tsx` builds.
          sectionNamesByProject: new Map([["groceries", []]]),
          listSections,
        }),
      );

      act(() => {
        result.current.setValue("buy milk #Work /");
      });

      await waitFor(() => expect(listSections).toHaveBeenCalledWith("p2"));
      await waitFor(() =>
        expect(result.current.autocomplete.getSections?.("buy milk #Work /")).toEqual([
          { id: "Cutover night", name: "Cutover night" },
        ]),
      );
      // The ambient Project is already covered by the caller's own eager
      // Map and is never fetched through `listSections`.
      expect(listSections).not.toHaveBeenCalledWith("p1");
    });

    it("never calls listSections for a Project already covered by the caller's own sectionNamesByProject", async () => {
      const listSections = vi.fn(async () => [section()]);
      const { result } = renderHook(() =>
        useQuickAddComposer({
          onAdd: vi.fn(),
          projects: [{ id: "p1", name: "Groceries" }],
          ambientProjectName: "Groceries",
          sectionNamesByProject: new Map([["groceries", ["Produce"]]]),
          listSections,
        }),
      );

      act(() => {
        result.current.setValue("buy milk /");
      });

      await waitFor(() =>
        expect(result.current.autocomplete.getSections?.("buy milk /")).toEqual([
          { id: "Produce", name: "Produce" },
        ]),
      );
      expect(listSections).not.toHaveBeenCalled();
    });

    it("options.sectionNamesByProject (the parser's own input) reflects the on-demand fetch too, not just the dropdown", async () => {
      const listSections = vi.fn(async (projectId: string) => [
        section({ id: "s1", projectId, name: "Cutover night" }),
      ]);
      const { result } = renderHook(() =>
        useQuickAddComposer({
          onAdd: vi.fn(),
          projects: [
            { id: "p1", name: "Groceries" },
            { id: "p2", name: "Work" },
          ],
          ambientProjectName: "Groceries",
          sectionNamesByProject: new Map([["groceries", []]]),
          listSections,
        }),
      );

      act(() => {
        result.current.setValue("buy milk #Work /");
      });

      await waitFor(() =>
        expect(result.current.options.sectionNamesByProject?.get("work")).toEqual([
          "Cutover night",
        ]),
      );
    });
  });
});
