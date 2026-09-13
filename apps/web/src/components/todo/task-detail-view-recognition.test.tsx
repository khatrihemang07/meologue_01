import type { Comment, Label, Project, Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { quickAddRecognitionPlugin } from "@/lib/todo-quick-add-recognition";
import { TaskDetailView } from "./task-detail-view";
import { TaskTitleEditor } from "./task-title-editor";

/**
 * DET-07 — issue #226 attaches `todo-quick-add-recognition.ts`'s plugin to
 * the detail title exactly as `add-task-form.tsx` already attaches it to
 * Quick Add. This file deliberately does NOT mock `task-title-editor.tsx`
 * the way `task-detail-view.test.tsx` does for every other Suite: that
 * file's own header comment (and `task-title-editor.tsx`'s) says no test
 * mounts a real `EditorView` because jsdom has no `Range`/`Selection`/
 * `getBoundingClientRect` — true for simulating keystrokes and IME, which
 * is why every OTHER assertion in this codebase about typing goes through
 * `apps/e2e` instead. It is not true for constructing a view once against
 * a seeded document and reading back what it rendered, or for dispatching
 * a plain `keydown` at the mounted node (ProseMirror's keymap plugin is a
 * `document`-level event listener, not a Selection-dependent typing path)
 * — both of those work in jsdom today, verified directly before writing
 * this file. So these tests mount the REAL `TaskTitleEditor` (through the
 * REAL `TaskDetailView`, exactly as production wires it) and prove actual
 * plugin behaviour, not a stub standing in for it. `task-description-
 * editor.tsx` is still stubbed below — DET-07 has nothing to do with the
 * Description field, and mounting its own ProseMirror instance for real
 * would only add jsdom risk this file doesn't need to take on.
 */
function StubTaskDescriptionEditor({
  value,
  onChange,
  onCancel,
  autoFocus = true,
}: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only, mirroring the real editor's own mount-time focus.
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, []);
  return (
    <textarea
      ref={ref}
      aria-label="Description"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    />
  );
}

vi.mock("@/components/todo/task-description-editor", () => ({
  TaskDescriptionEditor: StubTaskDescriptionEditor,
}));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    date: null,
    deadline: null,
    priority: 1,
    labelIds: [],
    dateString: null,
    projectId: null,
    sectionId: null,
    parentId: null,
    description: null,
    ...overrides,
  };
}

// No `project`/`section`/`label`/`comment` factories here (unlike
// `task-detail-view.test.tsx`) — every test below only exercises the
// title, so `renderView`'s defaults (empty arrays, null `project`/
// `section`) are all any of them need. The type imports stay, for the
// array-literal casts just below.
function renderView(overrides: Partial<Parameters<typeof TaskDetailView>[0]> = {}) {
  const props = {
    task: task(),
    project: null,
    section: null,
    projects: [] as Project[],
    labels: [] as Label[],
    prevTask: null,
    nextTask: null,
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    onRename: vi.fn(),
    onComplete: vi.fn(),
    onUncomplete: vi.fn(),
    onOpenSchedule: vi.fn(),
    onSetDate: vi.fn(),
    onSetDateString: vi.fn(),
    datesWithTasks: new Map(),
    onSetProject: vi.fn(),
    onSetLabels: vi.fn(),
    onSetDescription: vi.fn(),
    comments: [] as Comment[],
    onAddComment: vi.fn(),
    onEditComment: vi.fn(),
    onRemoveComment: vi.fn(),
    subtasks: [] as Task[],
    onAddSubtask: vi.fn(),
    onCompleteSubtask: vi.fn(),
    onUncompleteSubtask: vi.fn(),
    events: [],
    ...overrides,
  };
  render(<TaskDetailView {...props} />);
  return props;
}

// Pinned to the identical instant `docs/reference/todoist/quick-add.md`
// and `todo-quick-add-recognition.test.ts` already use, so "tod" resolves
// to the same 2026-09-10 `matchId` both files assert on.
beforeEach(() => {
  // `toFake: ["Date"]` only — leaving `setTimeout` real is load-bearing
  // here and not in `filter-view.test.tsx`/`today-view.test.tsx`'s own
  // plain `vi.useFakeTimers()`: those files never `await screen.findBy*`,
  // while entering edit mode below goes through `LazyTaskTitleEditor`'s
  // `Suspense` boundary, whose resolution `@testing-library`'s `findBy*`
  // polls for with a real `setTimeout` — faking every timer, not just
  // `Date`, hangs that poll until it times out.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 10, 12, 0));
  useSettingsStore.setState({ smartDatesEnabled: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DET-07 — recognition in the detail title", () => {
  it("renders the identical recognition span the composer produces, for the same phrase", async () => {
    renderView({ task: task({ content: "call mum tod p1" }) });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleEditor = await screen.findByLabelText("Task name");

    // Same three attributes `todo-quick-add-recognition.ts`'s own
    // `decorationAttrs` gives the composer's identical plugin instance —
    // `data-testid`, the highlighted flag, and the `td-recognition-match`
    // class that carries the measured 4px padding (QA-01).
    const matches = titleEditor.querySelectorAll('[data-testid="natural-language-match"]');
    expect(matches).toHaveLength(2);
    const matchIds = Array.from(matches).map((el) => el.getAttribute("data-match-id"));
    // `P1`, not `P4`: the seeded content types `p1`, and issue #251 fixed
    // `matchIdForToken` (todo-quick-add-recognition.ts) to cross the
    // storage inversion (`storedPriorityOf = 5 - ui`) back to the UI scale
    // before building the identifier. This assertion read `P4` until then —
    // pinning the very bug #251 names, on the same typed input, from a
    // second file. Neither ticket's own test run could catch the clash:
    // #251 ran only its two files, and this file was last run before that
    // fix existed. It surfaced on the first combined run of both.
    expect(matchIds).toEqual(["2026-09-10", "P1"]);
    for (const el of matches) {
      expect(el.getAttribute("data-highlighted-match")).toBe("true");
      expect(el.className).toBe("td-recognition-match");
    }
  });

  it("does not touch the underlying text: the editor's own text content is exactly what was seeded", async () => {
    renderView({ task: task({ content: "call mum tod p1" }) });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleEditor = await screen.findByLabelText("Task name");

    // Decorations are a view-layer overlay (ProseMirror's own contract);
    // proving the rendered text is still the verbatim source string,
    // with no markers or resolved values spliced in, is what makes the
    // "save stays verbatim" claim below more than an assumption.
    expect(titleEditor.textContent).toBe("call mum tod p1");
  });

  it("commits the title verbatim on Enter even while a recognition span is rendered — DET-07 does not change what saving does", () => {
    // Mounted directly, exactly as `task-detail-view.tsx` wires it
    // (`extraPlugins={[quickAddRecognitionPlugin(...)]}`) — this exercises
    // `task-title-editor.tsx`'s own `commit()`, which hands back
    // `titleTextFromDoc(view.state.doc)`, the plain document text with no
    // knowledge of decorations at all, and always has. Issue #247 is what
    // made a rename actually resolve a recognised phrase — but that
    // resolution now lives one layer up, in task-title-commit.ts's
    // `commitTaskTitle`, called by whichever page builds `TaskDetailView`'s
    // own `onRename` prop (todo-page.tsx's/composer-page.tsx's own
    // `commitRename`). `TaskTitleEditor` mounted bare, as it is right here,
    // has no `onRename` prop and no page above it to resolve anything — its
    // own contract is still exactly "hand back the plain text," untouched
    // by #247, which is why this assertion stays as it is even though what
    // THIS APP does with a rename, one layer up, no longer is.
    const onCommit = vi.fn();
    const { getByRole } = render(
      <TaskTitleEditor
        value="call mum tod p1"
        onCommit={onCommit}
        onCancel={vi.fn()}
        autoFocus={false}
        extraPlugins={[quickAddRecognitionPlugin(() => ({ now: "2026-09-10", smartDates: true }))]}
      />,
    );

    // Confirms the span really is there for this Enter to commit past —
    // otherwise a plugin that silently failed to attach would make this
    // test pass for the wrong reason (identical to the "prove the change
    // is real" caution `task-detail-view.test.tsx`'s own `StubTask
    // TitleEditor` comment gives for `commitOnBlur`/`autoFocus`).
    expect(getByRole("textbox").querySelector("[data-match-id]")).not.toBeNull();

    fireEvent.keyDown(getByRole("textbox"), { key: "Enter" });

    expect(onCommit).toHaveBeenCalledWith("call mum tod p1");
  });
});
