import { fireEvent, render, screen } from "@testing-library/react";
import { EditorState, Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskTitleSchema, titleDocFromText } from "@/components/todo/task-title-editor";
import type { AutocompleteEntry } from "@/lib/quick-add-autocomplete";
import type { QuickAddTaskFields } from "@/lib/quick-add-task";
import { useSettingsStore } from "@/lib/settings";
import type { QuickAddComposer } from "@/lib/use-quick-add-composer";
import { useQuickAddComposer } from "@/lib/use-quick-add-composer";
import { QuickAddContent } from "./quick-add-content";

/**
 * `quick-add-dialog.test.tsx`'s own stub, mirrored — see that file's
 * header comment for why no test here mounts the real ProseMirror editor.
 */
function StubTaskTitleEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  ariaLabel,
  placeholder,
}: {
  value: string;
  onChange?: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  return (
    <input
      aria-label={ariaLabel ?? "Task name"}
      placeholder={placeholder}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange?.(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onCommit(text);
        }
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    />
  );
}

function StubTaskDescriptionEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <textarea
      aria-label="Description"
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

// `TaskTitleEditor` itself is stubbed (this file's own header comment on
// why no test here mounts the real ProseMirror editor) — but `import
// Original` keeps `titleDocFromText`/`taskTitleSchema` real, since the
// "date chip picker insertion" suite below needs them to build its own
// throwaway `EditorView` from `composer.extraPlugins`.
vi.mock("@/components/todo/task-title-editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/todo/task-title-editor")>();
  return {
    ...actual,
    TaskTitleEditor: StubTaskTitleEditor,
  };
});

vi.mock("@/components/todo/task-description-editor", () => ({
  TaskDescriptionEditor: StubTaskDescriptionEditor,
}));

interface HarnessProps {
  touch?: boolean;
  onAdd?: (fields: QuickAddTaskFields) => void;
  ambientProjectName?: string;
  projects?: readonly AutocompleteEntry[];
  /**
   * Issue #411, defect 3's own DOM-decoration suite below: `StubTaskTitle
   * Editor` above never mounts the real ProseMirror plugins, so there is
   * no decorated DOM here to query directly. This callback hands the
   * REAL `useQuickAddComposer` object out to a test on every render
   * instead — the same real `extraPlugins` array (built from real
   * `insertedSpans` state) `LazyTaskTitleEditor` would have received had
   * it not been stubbed — so a test can mount those two plugins into its
   * own throwaway `EditorView` and inspect the actual decoration a real
   * mount would have produced, without needing the full lazy-loaded
   * editor.
   */
  onComposer?: (composer: QuickAddComposer) => void;
}

/**
 * Drives `QuickAddContent` with the real `useQuickAddComposer` — the
 * shared content's own actual caller shape (`quick-add-dialog.tsx`,
 * `add-task-form.tsx`), rather than a hand-built fake composer that could
 * silently drift from what either real wrapper hands it.
 */
function Harness({
  touch = false,
  onAdd = vi.fn(),
  ambientProjectName,
  projects,
  onComposer,
}: HarnessProps) {
  const composer = useQuickAddComposer({ onAdd, open: true, ambientProjectName, projects });
  onComposer?.(composer);
  return (
    <QuickAddContent
      composer={composer}
      touch={touch}
      placeholder={composer.placeholder}
      ambientProjectName={ambientProjectName}
      onCancel={vi.fn()}
    />
  );
}

async function getInput(): Promise<HTMLInputElement> {
  return (await screen.findByLabelText("Task name")) as HTMLInputElement;
}

function typeText(text: string) {
  fireEvent.change(screen.getByLabelText("Task name"), { target: { value: text } });
}

describe("QuickAddContent", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ smartDatesEnabled: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 10, 12, 0)); // Thu 10 Sep 2026, local noon
  });

  it("at rest: Cancel and More actions render, chips and Add task do not", async () => {
    render(<Harness />);
    await getInput();

    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select project")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set date" })).not.toBeInTheDocument();
  });

  it("typing text reveals actionable Project and Date chips", async () => {
    render(<Harness ambientProjectName="Errands" />);
    typeText("buy milk");

    expect(await screen.findByText("Errands")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select project" }));
    expect(await getInput()).toHaveValue("buy milk #");
    // Issue #416: the date chip is `LazyTaskSchedulePopover`'s own trigger
    // now, behind a `<Suspense fallback={null}>` — `findByRole` rather than
    // a synchronous `getByRole` because the button doesn't exist at all
    // until that `import()` resolves.
    expect(await screen.findByRole("button", { name: "Set date" })).toBeInTheDocument();
  });

  it("defaults the Project chip to Inbox with no ambientProjectName supplied", async () => {
    render(<Harness />);
    typeText("buy milk");

    expect(await screen.findByText("Inbox")).toBeInTheDocument();
  });

  // Issue #388: typing a known multi-word Project name in full updates the
  // chip immediately — no dropdown click needed, matching the ticket's own
  // headline acceptance criterion (`#Aurora migration` exact-matches as one
  // two-word span).
  it("a fully-typed, known multi-word Project name updates the chip with no selection", async () => {
    render(
      <Harness ambientProjectName="Inbox" projects={[{ id: "p1", name: "Aurora migration" }]} />,
    );
    typeText("Test #Aurora migration");

    expect(await screen.findByText("Aurora migration")).toBeInTheDocument();
  });

  // The other half of the same criterion: a partial/unknown name does NOT
  // update the chip — no dropdown interaction happened in this test (it
  // only asserts the parser's own recognition, not the popup), so the chip
  // must stay on the ambient Project until something real is picked.
  it("a partial or unknown Project name leaves the chip on the ambient Project", async () => {
    render(
      <Harness ambientProjectName="Inbox" projects={[{ id: "p1", name: "Aurora migration" }]} />,
    );
    typeText("Test #Aurora");

    expect(await screen.findByText("Inbox")).toBeInTheDocument();
    expect(screen.queryByText("Aurora migration")).not.toBeInTheDocument();
  });

  // Issue #374's own measured fact: the submit control is absent from the
  // DOM while the title is empty, not disabled.
  it("Add task is present once there's text, absent again once cleared, never disabled", async () => {
    render(<Harness />);
    const input = await getInput();

    typeText("buy milk");
    const submit = await screen.findByRole("button", { name: "Add task" });
    expect(submit).not.toBeDisabled();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
  });

  it("touch: no Cancel row, and Add task renders as the single circular send button", async () => {
    render(<Harness touch={true} />);
    await getInput();

    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    typeText("buy milk");
    const submit = await screen.findByRole("button", { name: "Add task" });
    expect(submit.className).toContain("rounded-full");
  });

  describe("More actions menu (issue #374 — supports Description and omits Reminders)", () => {
    function openMenu() {
      fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }));
    }

    it("offers Description, Priority, Labels, Project and Section", async () => {
      render(<Harness />);
      await getInput();
      openMenu();

      const menu = await screen.findByRole("menu");
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
        (item) => item.textContent,
      );
      expect(items).toEqual(["Description", "Priority", "Labels", "Project", "Section"]);
    });

    it("Description opens an editor whose text is committed with the Task", async () => {
      const onAdd = vi.fn();
      render(<Harness onAdd={onAdd} />);
      typeText("buy milk");
      openMenu();

      fireEvent.click(await screen.findByRole("menuitem", { name: "Description" }));
      fireEvent.change(await screen.findByLabelText("Description"), {
        target: { value: "Get the oat kind" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add task" }));

      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({ content: "buy milk", description: "Get the oat kind" }),
      );
    });

    it("Labels inserts a bare '@' and refocuses, ready for the existing autocomplete", async () => {
      render(<Harness />);
      typeText("buy milk");
      openMenu();

      fireEvent.click(await screen.findByRole("menuitem", { name: "Labels" }));

      expect(await getInput()).toHaveValue("buy milk @");
    });

    it("Project inserts a bare '#'", async () => {
      render(<Harness />);
      typeText("buy milk");
      openMenu();

      fireEvent.click(await screen.findByRole("menuitem", { name: "Project" }));

      expect(await getInput()).toHaveValue("buy milk #");
    });

    it("Section inserts a bare '/'", async () => {
      render(<Harness />);
      typeText("buy milk");
      openMenu();

      fireEvent.click(await screen.findByRole("menuitem", { name: "Section" }));

      expect(await getInput()).toHaveValue("buy milk /");
    });
  });

  /**
   * Issue #372's own user-visible criteria, proven here (that ticket's own
   * comment on issue #374: "nothing consumes them yet ... proven here, not
   * there"): choosing a day from the picker inserts literal words into the
   * title, and removing the date chip removes those words again.
   */
  describe("date chip — writes literal text (issue #372/#374)", () => {
    it("picking 'Today' from the picker inserts the literal date into the title", async () => {
      render(<Harness />);
      typeText("buy milk");

      fireEvent.click(await screen.findByRole("button", { name: "Set date" }));
      // `task-schedule-popover.test.tsx`'s own captured label shape:
      // "Today" plus the weekday hint, distinct from the calendar grid's
      // own "Today, Thursday, September 10th, 2026" cell.
      fireEvent.click(await screen.findByRole("button", { name: "Today Thu" }));

      // `literalDateText`'s own "d MMM yyyy" format — 10 Sep 2026 is
      // "today" under this suite's faked system time.
      expect(await getInput()).toHaveValue("buy milk 10 Sep 2026");
      expect(screen.getByRole("button", { name: "Remove date" })).toBeInTheDocument();
    });

    it("the date chip's right corners square off once the Remove date button is fused to it (web/07-native-colours.md:47)", async () => {
      render(<Harness />);
      typeText("buy milk");

      expect(screen.getByRole("button", { name: "Set date" })).not.toHaveClass("rounded-r-none");

      fireEvent.click(screen.getByRole("button", { name: "Set date" }));
      fireEvent.click(await screen.findByRole("button", { name: "Today Thu" }));

      expect(screen.getByRole("button", { name: "Today" })).toHaveClass("rounded-r-none");
    });

    it("Remove date strips the words back out, and its own button disappears", async () => {
      render(<Harness />);
      typeText("buy milk 10 Sep 2026");

      const removeDate = await screen.findByRole("button", { name: "Remove date" });
      fireEvent.click(removeDate);

      expect(await getInput()).toHaveValue("buy milk");
      expect(screen.queryByRole("button", { name: "Remove date" })).not.toBeInTheDocument();
    });
  });

  /**
   * Issue #411, defect 3, end-to-end: driving the REAL "Set date" -> "Today"
   * flow above through the REAL `useQuickAddComposer`, then mounting the
   * REAL `composer.extraPlugins` it produced (recognition + inserted) into
   * a throwaway `EditorView` seeded with `composer.value` to inspect the
   * decoration a real (non-stubbed) `TaskTitleEditor` mount would have
   * rendered. `todo-quick-add-recognition.test.ts`'s own "DOM decoration"
   * suite already proves the plugin mechanism in isolation; this proves
   * this component's own wiring (`remountFromDateChip` in quick-add-
   * content.tsx) actually reaches it.
   */
  describe("date chip picker insertion is not a detected match (issue #411)", () => {
    let view: EditorView | undefined;
    let host: HTMLDivElement | undefined;

    afterEach(() => {
      view?.destroy();
      host?.remove();
      view = undefined;
      host = undefined;
    });

    function decorationsFor(composer: QuickAddComposer): HTMLDivElement {
      const doc = titleDocFromText(composer.value);
      const state = EditorState.create({
        schema: taskTitleSchema,
        doc,
        selection: Selection.atEnd(doc),
        plugins: [...composer.extraPlugins],
      });
      host = document.createElement("div");
      document.body.appendChild(host);
      view = new EditorView({ mount: host }, { state });
      return host;
    }

    it("picking 'Today' produces a plain data-match-inserted span, not a highlighted natural-language-match", async () => {
      let latestComposer: QuickAddComposer | undefined;
      render(<Harness onComposer={(composer) => (latestComposer = composer)} />);
      typeText("buy milk");

      fireEvent.click(await screen.findByRole("button", { name: "Set date" }));
      fireEvent.click(await screen.findByRole("button", { name: "Today Thu" }));
      await getInput(); // settles the "Today Thu" click's own re-render.

      const composer = latestComposer as QuickAddComposer;
      expect(composer.value).toBe("buy milk 10 Sep 2026");

      const decoratedHost = decorationsFor(composer);
      expect(decoratedHost.querySelector("[data-highlighted-match]")).toBeNull();
      expect(decoratedHost.querySelector('[data-testid="natural-language-match"]')).toBeNull();
      const inserted = decoratedHost.querySelector('[data-match-inserted="true"]');
      expect(inserted).not.toBeNull();
      expect((inserted as HTMLElement).textContent).toBe("10 Sep 2026");
    });

    it("typing the identical phrase by hand, with no picker involved, still highlights normally — this is only about HOW the words arrived", async () => {
      let latestComposer: QuickAddComposer | undefined;
      render(<Harness onComposer={(composer) => (latestComposer = composer)} />);
      typeText("buy milk 10 Sep 2026");
      await getInput();

      const composer = latestComposer as QuickAddComposer;
      const decoratedHost = decorationsFor(composer);

      expect(decoratedHost.querySelector('[data-match-inserted="true"]')).toBeNull();
      const highlighted = decoratedHost.querySelector("[data-highlighted-match]");
      expect(highlighted).not.toBeNull();
      expect((highlighted as HTMLElement).textContent).toBe("10 Sep 2026");
    });
  });

  describe("priority chip — writes literal text (issue #372/#374)", () => {
    it("More actions -> Priority -> P2 inserts 'p2' into the title", async () => {
      render(<Harness />);
      typeText("buy milk");
      fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Priority" }));

      fireEvent.click(await screen.findByRole("button", { name: "P2" }));

      expect(await getInput()).toHaveValue("buy milk p2");
      expect(screen.getByRole("button", { name: "Priority P2" })).toBeInTheDocument();
    });

    it("Remove priority strips the token back out", async () => {
      render(<Harness />);
      typeText("buy milk p2");

      const removePriority = await screen.findByRole("button", { name: "Remove priority" });
      fireEvent.click(removePriority);

      expect(await getInput()).toHaveValue("buy milk");
      expect(screen.queryByRole("button", { name: "Remove priority" })).not.toBeInTheDocument();
    });
  });

  // D1: recurrence renders as a glyph inside the date chip, never its own
  // chip — `format-task-date.ts`'s own `recurring` option appends "↻" to
  // the date chip's own text rather than a second control existing.
  it("a recurring date shows the ↻ glyph inside the date chip, not a second chip", async () => {
    render(<Harness />);
    typeText("buy milk every day");

    const dateChip = await screen.findByRole("button", { name: /↻/ });
    expect(dateChip).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Repeat" })).not.toBeInTheDocument();
  });

  it("does not render Attachment, Location, extraction, extensions or a dictation mic anywhere", async () => {
    render(<Harness />);
    typeText("buy milk");
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }));
    await screen.findByRole("menu");

    for (const forbidden of [
      "Attachment",
      "Location",
      "Extract tasks…",
      "Add extension…",
      "Dictate tasks with Ramble",
    ]) {
      expect(screen.queryByText(forbidden)).not.toBeInTheDocument();
    }
  });
});
