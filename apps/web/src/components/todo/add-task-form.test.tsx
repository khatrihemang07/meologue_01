import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { AddTaskForm } from "./add-task-form";

// Every highlighted span carries this class (quick-add-highlight.ts's
// `QUICK_ADD_HIGHLIGHT_CLASS`) — matched directly here rather than
// imported, so a rename of the constant's own value still leaves this
// suite testing "is *a* highlight class present," the same thing a reader
// looking at the screen would actually judge by, not "does this string
// equal that string."
const HIGHLIGHT_CLASS = "bg-primary/15";

function highlightedSpans(): HTMLElement[] {
  // The backdrop is `aria-hidden` and `pointer-events-none` (add-task-
  // form.tsx's own header comment on why) — invisible to every
  // accessible-name query `screen` offers, so this suite reaches it
  // directly, the same way task-row.test.tsx's own drag tests reach past
  // Testing Library's accessible queries for a detail those queries have
  // no vocabulary for. Filtered by `className.includes` rather than a CSS
  // class selector: Tailwind's own `/` (an opacity modifier, `bg-primary/15`)
  // needs escaping to appear literally in a `querySelector` string, and a
  // substring check on the rendered className needs none of that.
  return Array.from(document.querySelectorAll("span")).filter((span) =>
    span.className.includes(HIGHLIGHT_CLASS),
  );
}

function getInput(): HTMLInputElement {
  return screen.getByLabelText("Add a Task") as HTMLInputElement;
}

/**
 * Clicks `input` at `offset` — the click-to-demote path
 * (add-task-form.tsx's `handleInputClick`) reads the input's own
 * `selectionStart`, which a real browser has already moved to the click's
 * pixel position by the time the `click` handler runs. jsdom lays nothing
 * out (task-row.test.tsx's own comment on the identical gap for
 * `getBoundingClientRect`), so there is no pixel position for a plain
 * `fireEvent.click` to derive a caret offset from — `setSelectionRange`
 * first is what stands in for "the browser already placed the caret
 * here," the one thing this component's own click handler actually reads.
 */
function clickAt(input: HTMLInputElement, offset: number, options: { shiftKey?: boolean } = {}) {
  input.setSelectionRange(offset, offset);
  fireEvent.click(input, options);
}

describe("AddTaskForm", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ smartDatesEnabled: true });
  });

  it("calls onAdd with the parsed fields on submit, and clears the field", () => {
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);

    fireEvent.change(getInput(), { target: { value: "buy milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ content: "buy milk", date: null, priority: 1, labelNames: [] }),
    );
    expect(getInput()).toHaveValue("");
  });

  it("does not call onAdd for blank input", () => {
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);

    fireEvent.change(getInput(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).not.toHaveBeenCalled();
  });

  it("does not call onAdd for a line that parses to nothing but recognised tokens", () => {
    // "tomorrow" alone strips entirely into `date`, leaving no `content` —
    // silently doing nothing here mirrors use-tasks.ts's own
    // addTask/renameTask, both of which already treat trimmed-empty
    // content as "nothing to add."
    const onAdd = vi.fn();
    render(<AddTaskForm onAdd={onAdd} disabled={false} />);

    fireEvent.change(getInput(), { target: { value: "tomorrow" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).not.toHaveBeenCalled();
  });

  it("disables the field and button while the store isn't ready", () => {
    render(<AddTaskForm onAdd={vi.fn()} disabled={true} />);

    expect(getInput()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  describe("live highlighting", () => {
    it("highlights a recognised date token in place, live as you type", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);

      fireEvent.change(getInput(), { target: { value: "buy milk tomorrow" } });

      const spans = highlightedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]?.textContent).toBe("tomorrow");
    });

    it("highlights the same word twice, independently, by offset not by text match", () => {
      // The parser's own offsets, never re-found by searching — this
      // suite's own regression case for quick-add-highlight.ts's header
      // comment on exactly this trap.
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);

      fireEvent.change(getInput(), { target: { value: "monday plans for next monday" } });

      const spans = highlightedSpans();
      expect(spans.map((s) => s.textContent)).toEqual(["monday", "next monday"]);
    });

    it("highlights a sigil-marked token (priority) with no false-positive risk to demote", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);

      fireEvent.change(getInput(), { target: { value: "buy milk p1" } });

      expect(highlightedSpans().map((s) => s.textContent)).toEqual(["p1"]);
    });

    it("highlights no eager tokens once smart date recognition is off, but still highlights p1", () => {
      useSettingsStore.setState({ smartDatesEnabled: false });
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);

      fireEvent.change(getInput(), { target: { value: "buy milk tomorrow p1" } });

      expect(highlightedSpans().map((s) => s.textContent)).toEqual(["p1"]);
    });
  });

  describe("click-to-demote", () => {
    it("clicking a highlighted token demotes it to plain text", () => {
      const onAdd = vi.fn();
      render(<AddTaskForm onAdd={onAdd} disabled={false} />);

      const input = getInput();
      fireEvent.change(input, { target: { value: "Create monthly report" } });
      expect(highlightedSpans().map((s) => s.textContent)).toEqual(["monthly"]);

      // "Create monthly report" — offset 7-14 is "monthly"; clicking
      // anywhere inside that span demotes it (this is issue #170's own
      // named example: Todoist's documented false positive).
      clickAt(input, 10);

      expect(highlightedSpans()).toHaveLength(0);

      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Create monthly report", dateString: null }),
      );
    });

    it("a demotion survives typing elsewhere in the line", () => {
      // The rule quick-add-highlight.ts's own header comment states and
      // argues for: demotion is keyed on the token's text, not its
      // position, precisely so typing before it doesn't spring it back to
      // being highlighted.
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      const field = getInput();

      fireEvent.change(field, { target: { value: "monthly report" } });
      clickAt(field, 3); // inside "monthly"
      expect(highlightedSpans()).toHaveLength(0);

      fireEvent.change(field, { target: { value: "write a monthly report" } });

      expect(highlightedSpans()).toHaveLength(0);
    });

    it("a demotion even survives the word being deleted and retyped — it's the same word", () => {
      // Deliberate: the rule is "this literal word, wherever it appears in
      // this input," not "the text that used to sit at these
      // coordinates" (quick-add-highlight.ts's own header comment argues
      // for exactly this over offset-tracking).
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      const field = getInput();

      fireEvent.change(field, { target: { value: "monthly report" } });
      clickAt(field, 3);
      expect(highlightedSpans()).toHaveLength(0);

      fireEvent.change(field, { target: { value: "report" } });
      fireEvent.change(field, { target: { value: "monthly report again" } });

      expect(highlightedSpans()).toHaveLength(0);
    });

    it("a different word is unaffected — demotion doesn't leak onto every recurrence word", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      const field = getInput();

      fireEvent.change(field, { target: { value: "monthly report" } });
      clickAt(field, 3);
      expect(highlightedSpans()).toHaveLength(0);

      // "yearly" is a different entry in en.ts's own recurrenceWords
      // table — never demoted, so it should highlight normally even
      // though "monthly" (a different signature entirely) stays
      // suppressed.
      fireEvent.change(field, { target: { value: "yearly report" } });

      expect(highlightedSpans().map((s) => s.textContent)).toEqual(["yearly"]);
    });

    it("Shift+Click still demotes — the offset lookup doesn't care about modifier keys", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      const field = getInput();

      fireEvent.change(field, { target: { value: "monthly report" } });
      clickAt(field, 3, { shiftKey: true });

      expect(highlightedSpans()).toHaveLength(0);
    });

    it("clicking plain text (no token at that offset) does nothing", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      const field = getInput();

      fireEvent.change(field, { target: { value: "buy milk tomorrow" } });
      clickAt(field, 2); // inside "buy"

      expect(highlightedSpans().map((s) => s.textContent)).toEqual(["tomorrow"]);
    });
  });

  // A native `<input>` auto-scrolls its own text once the line outgrows
  // the field; the backdrop is a separate element and does not follow on
  // its own. On the built app that did not merely misalign the highlights
  // — every token scrolled out of the painted region and *no* highlight
  // was visible at all, which is the safety valve failing exactly where a
  // long line makes an over-eager parse most likely.
  //
  // jsdom lays nothing out and never scrolls anything, so this can only
  // assert the wiring: that the backdrop is told to follow. What it
  // genuinely rules out is the regression that actually happened —
  // someone removing the handler, or the refs drifting apart — while the
  // pixel result stays something to check on a real build.
  describe("the highlight backdrop follows the input's own scroll", () => {
    function backdrop(): HTMLElement {
      const element = document.querySelector<HTMLElement>("[aria-hidden='true']");
      if (element === null) {
        throw new Error("add-task-form: no highlight backdrop rendered");
      }
      return element;
    }

    it("mirrors scrollLeft when the input scrolls", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      const field = getInput();

      fireEvent.change(field, { target: { value: "a very long line that overflows tomorrow p1" } });
      Object.defineProperty(field, "scrollLeft", { value: 120, configurable: true });
      fireEvent.scroll(field);

      expect(backdrop().scrollLeft).toBe(120);
    });

    it("re-syncs after a text change that fires no scroll event of its own", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      const field = getInput();

      // A paste replaces the text without the browser necessarily
      // emitting a scroll event — the layout effect is what covers it.
      Object.defineProperty(field, "scrollLeft", { value: 90, configurable: true });
      fireEvent.change(field, { target: { value: "pasted line tomorrow p1 %errands" } });

      expect(backdrop().scrollLeft).toBe(90);
    });
  });
});
