import type { Comment, Label, Project, Task } from "@meologue/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

// `task-detail-view.test.tsx`'s own factory, reused verbatim: QA-14's own
// suite below (unlike every OTHER suite in this file) needs at least one
// real Project to list in the popup.
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    deviceId: "device-a",
    name: "Errands",
    colour: "#ff8d85",
    favourite: false,
    archived: false,
    parentId: null,
    description: null,
    orderKey: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

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

/**
 * QA-14's own create-hook half: `task-detail-view.tsx`'s own
 * `titleAutocomplete` reads `addProject`/`addLabel` off `useOutletContext`
 * directly (that file's own doc comment on why: a new prop on
 * `TaskDetailViewProps` would need `todo-page.tsx`/`composer-page.tsx`,
 * both owned by another agent right now, to grow it). Proving that wiring
 * needs a REAL `<Outlet context={...}>` ancestor, unlike every other test
 * in this file — `renderView` above deliberately has none, which is what
 * lets `task-detail-view.test.tsx`'s own Router-free suite keep working
 * unchanged (`useOutletContext` returns `undefined` there, not a throw).
 */
function renderViewWithOutlet(
  outletContext: { addProject?: (name: string) => void; addLabel?: (name: string) => void },
  overrides: Partial<Parameters<typeof TaskDetailView>[0]> = {},
) {
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
  render(
    <MemoryRouter initialEntries={["/todo/task/x"]}>
      <Routes>
        <Route element={<Outlet context={outletContext} />}>
          <Route path="/todo/task/x" element={<TaskDetailView {...props} />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return props;
}

/**
 * Simulates typing into the real, mounted `TaskTitleEditor` without going
 * through jsdom's absent contenteditable engine (this file's own header
 * comment on why real typing/IME can't be driven here) — dispatched as a
 * genuine `paste` DOM event instead, which `prosemirror-view`'s own
 * `editHandlers.paste` (dist/index.js) handles entirely through
 * `view.state.tr.replaceSelection(...)`, never through the DOM's own
 * Selection/Range APIs. Verified directly against a raw `EditorView` built
 * with this exact schema/plugin list before writing this file's own QA-14
 * suite: a real `paste` event with a plain-text `clipboardData` inserts the
 * text as a normal transaction, `docChanged` included, which is exactly
 * what the autocomplete plugin's own `apply()` needs to see to compute a
 * fresh `buildState` — nothing about detecting a live `#`/`@` trigger cares
 * how the text arrived.
 */
/**
 * jsdom implements neither method AT ALL on `Range` (verified directly —
 * `"getClientRects" in document.createRange()` is `false`), not merely a
 * zero-value stand-in the way `Element.prototype.getBoundingClientRect`
 * already is (jsdom does implement that one, returning an all-zero rect).
 * `task-title-editor.tsx`'s own `popupStyle` calls `EditorView.coordsAtPos`
 * the instant a popup is open, which reaches exactly this gap
 * (`prosemirror-view`'s own `singleRect`, dist/index.js) — every OTHER
 * test in this codebase that exercises the popup avoids it by never
 * mounting the real `TaskTitleEditor` REACT component while one is open
 * (`task-title-editor.test.tsx`'s own suite drives a bare `EditorView`
 * directly, calling neither `TaskTitleEditor` nor `popupStyle`). This
 * file's own QA-14 suite is the first to mount the real component with a
 * popup actually open, so it is also the first to need this shim — scoped
 * to this file alone (not `src/test/setup.ts`) since nothing else in this
 * codebase yet needs it. Falls through to `getBoundingClientRect` exactly
 * as `singleRect` itself does when `getClientRects()` returns nothing,
 * so both need stubbing, not just one.
 */
beforeAll(() => {
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = (): DOMRectList => [] as unknown as DOMRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = (): DOMRect =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON() {
          return this;
        },
      }) as DOMRect;
  }
});

function pasteText(target: HTMLElement, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  target.dispatchEvent(event);
  return event;
}

// Pinned to the identical instant `meologue-parity-docs/todoist/quick-add.md`
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

// QA-14's own second half, wired into the detail title (`task-detail-
// view.tsx`'s own `titleAutocomplete`/`autocompletePopupOpenRef`) — mounted
// through the REAL `TaskDetailView`/`TaskTitleEditor`, exactly as DET-07's
// suite above, for the identical reason: this is the one place that can
// prove Radix's own Escape handling and ProseMirror's popup-close are
// actually ordered the way `task-detail-view.tsx`'s own `dismissGuardRef`
// comment claims, not merely reasoned about.
describe("QA-14 — #/@ autocomplete in the detail title, and DET-15's Escape gap", () => {
  it("typing '#' opens the listbox with the supplied projects", async () => {
    renderView({
      task: task({ content: "buy " }),
      projects: [project({ id: "p1", name: "Errands" })],
    });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleEditor = await screen.findByLabelText("Task name");

    pasteText(titleEditor, "#");

    const listbox = await screen.findByRole("listbox");
    expect(listbox).toHaveAttribute("data-testid", "content-editor-suggestions-dropdown");
    expect(within(listbox).getByText("Errands")).toBeInTheDocument();
  });

  it("Escape closes only the popup — no discard confirmation, no end to editing — and a second Escape with unsaved changes still raises it", async () => {
    const onClose = vi.fn();
    const onRename = vi.fn();
    renderView({
      task: task({ content: "buy " }),
      projects: [project({ id: "p1", name: "Errands" })],
      onClose,
      onRename,
    });

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleEditor = await screen.findByLabelText("Task name");
    pasteText(titleEditor, "#");
    await screen.findByRole("listbox");

    // First Escape: dispatched once, exactly as a real keystroke would be.
    // `dismissGuardRef`'s own DET-15 fix has to see the popup as OPEN at
    // the instant Radix's own `document`-capture Escape listener asks —
    // which fires before this same event ever reaches ProseMirror's
    // bubble-phase handler on `titleEditor` itself, the ordering this
    // suite's own header comment names. One `fireEvent.keyDown` exercises
    // both listeners, in that real order, in one call.
    fireEvent.keyDown(titleEditor, { key: "Escape" });

    // The popup is gone (ProseMirror's own autocomplete plugin closed it)…
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // …but nothing else happened: no discard confirmation,
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    // …editing did not end (Escape never reached `requestCancelEditing`),
    expect(screen.queryByTestId("task-detail-title")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Task name")).toBeInTheDocument();
    // …and neither Save nor Cancel's own callbacks fired.
    expect(onRename).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The paste itself changed the title ("buy " -> "buy #"), so a SECOND
    // Escape — the popup already closed, nothing left for it to claim —
    // reaches `requestCancelEditing` normally and finds unsaved changes,
    // proving the fix above only swallows Escape while the popup is
    // actually open, never more broadly.
    fireEvent.keyDown(screen.getByLabelText("Task name"), { key: "Escape" });

    const confirmDialog = await screen.findByRole("alertdialog");
    expect(within(confirmDialog).getByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("selecting 'Create' calls the outlet's addProject, reached through useOutletContext — task-detail-view.tsx's own TaskDetailViewProps has no field for it", async () => {
    const addProject = vi.fn();
    renderViewWithOutlet(
      { addProject },
      { task: task({ content: "buy " }), projects: [project({ id: "p1", name: "Errands" })] },
    );

    fireEvent.click(screen.getByTestId("task-detail-title"));
    const titleEditor = await screen.findByLabelText("Task name");
    pasteText(titleEditor, "#brandnew");
    await screen.findByRole("listbox");

    fireEvent.keyDown(titleEditor, { key: "Enter" });

    expect(addProject).toHaveBeenCalledWith("brandnew");
  });
});
