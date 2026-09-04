import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { AddTaskForm } from "./add-task-form";

// Every one of the three live states (quick-add-highlight.ts's own
// `QuickAddHighlightState`) is painted through a class containing this
// substring — `bg-quick-add-pending`/`bg-quick-add-resolved`/
// `bg-quick-add-resolved-accent` all share it — so this is "is *a*
// highlight present at all," the coarse question most of this suite
// actually asks; `spanClasses` below is what the handful of tests that
// care WHICH of the three states a span is in reach for instead.
const ANY_HIGHLIGHT_CLASS = "bg-quick-add-";

function highlightedSpans(): HTMLElement[] {
  // The backdrop is `aria-hidden` and `pointer-events-none` (add-task-
  // form.tsx's own header comment on why) — invisible to every
  // accessible-name query `screen` offers, so this suite reaches it
  // directly, the same way task-row.test.tsx's own drag tests reach past
  // Testing Library's accessible queries for a detail those queries have
  // no vocabulary for. Filtered by `className.includes` rather than a CSS
  // class selector: Tailwind's own `[...]` arbitrary-value syntax
  // (`rounded-[3px]`) needs escaping to appear literally in a
  // `querySelector` string, and a substring check on the rendered
  // className needs none of that.
  return Array.from(document.querySelectorAll("span")).filter((span) =>
    span.className.includes(ANY_HIGHLIGHT_CLASS),
  );
}

// The exact class list on the one span whose text is `text` — for the
// tests that care which of the three states a token is in, not merely
// whether it's highlighted at all. Splitting on whitespace (rather than
// another `.includes` check) is what tells `bg-quick-add-resolved` and
// `bg-quick-add-resolved-accent` apart: the former is a literal substring
// of the latter, so a substring check alone can't distinguish them.
function spanClasses(text: string): string[] {
  const span = Array.from(document.querySelectorAll("span")).find((s) => s.textContent === text);
  return span === undefined ? [] : span.className.split(/\s+/);
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

  // Issue #179's Part A: a resolved token, a still-being-typed (pending)
  // token, and a token that never resolves to anything real now each read
  // differently — see quick-add-highlight.ts's own `QuickAddHighlightState`
  // doc comment for exactly what each means and why.
  describe("the three live states", () => {
    it("reads as pending while the caret still sits right after the word it just finished typing", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);

      // A native `<input>`'s own value-setting behaviour moves the caret
      // to the end of the new value — exactly "immediately after" the
      // token that ends the line, which is what makes this the live,
      // in-progress state a reader sees while still typing, before they
      // click away or type further.
      fireEvent.change(getInput(), { target: { value: "buy milk tomorrow" } });

      expect(spanClasses("tomorrow")).toContain("bg-quick-add-pending");
    });

    it("upgrades to resolved, with this app's one reserved accent, once the caret moves off a Date token", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "buy milk tomorrow" } });
      clickAt(input, 0); // caret moves to the very start — well clear of "tomorrow"

      const classes = spanClasses("tomorrow");
      expect(classes).toContain("bg-quick-add-resolved-accent");
      expect(classes).not.toContain("bg-quick-add-pending");
    });

    it("resolves a Label to the grayscale chip, not the colour-worthy one — colour is reserved for Priority and Dates", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "buy milk %errands" } });
      clickAt(input, 0); // caret away from the label token

      const classes = spanClasses("%errands");
      expect(classes).toContain("bg-quick-add-resolved");
      expect(classes).not.toContain("bg-quick-add-resolved-accent");
    });

    it("an unresolved token (#project — nowhere to land yet) stays plain: neither highlighted nor stripped from what was typed", () => {
      const onAdd = vi.fn();
      render(<AddTaskForm onAdd={onAdd} disabled={false} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "buy milk #Work" } });

      // Neither highlighted — no `bg-quick-add-*` class at all, in any of
      // the three states, just the base `text-transparent` every backdrop
      // span carries — nor removed from the field itself.
      expect(spanClasses("#Work")).toEqual(["text-transparent"]);
      expect(input).toHaveValue("buy milk #Work");

      // Nor stripped from what actually gets stored on submit — the
      // acceptance criterion's own second half: "not removed from what
      // the reader typed."
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ content: "buy milk #Work" }));
    });

    it("clicking into an unresolved token leaves the field showing no highlight at all — there was never anything visibly lit up to demote", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "buy milk #Work" } });
      clickAt(input, 11); // inside "#Work"

      expect(highlightedSpans()).toHaveLength(0);
      expect(input).toHaveValue("buy milk #Work");
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

  // The parity gap issue #188 fixes: a recurrence typed as the phrase
  // everyone actually types ("every day"), not just a bare word
  // ("daily"). Nothing about this field's own code needed to change for
  // these to highlight and demote — every path here already worked off
  // a token's `start`/`end`/`raw`, generic to however many words a token
  // spans (add-task-form.tsx's own header comment on why this field
  // derives everything fresh from `result.tokens` rather than assuming
  // one word per token) — so this suite exists to prove that generic
  // machinery actually covers a multi-word span, not to add anything new
  // to the component itself.
  describe("a recurrence typed as a phrase", () => {
    it("highlights the whole phrase as one span, not just the word 'every'", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "water the plants every day" } });

      expect(highlightedSpans().map((s) => s.textContent)).toEqual(["every day"]);
    });

    it("clicking anywhere in the phrase demotes the whole span, and content keeps every word typed", () => {
      const onAdd = vi.fn();
      render(<AddTaskForm onAdd={onAdd} disabled={false} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "water the plants every day" } });
      clickAt(input, 20); // inside "day"

      expect(highlightedSpans()).toHaveLength(0);

      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "water the plants every day",
          dateString: null,
        }),
      );
    });

    it("a phrase the recurrence engine can't parse is never highlighted at all", () => {
      render(<AddTaskForm onAdd={vi.fn()} disabled={false} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "water plants every fortnight" } });

      expect(highlightedSpans()).toHaveLength(0);
    });

    it("submitting a recognised phrase strips it from content and stores it as dateString", () => {
      const onAdd = vi.fn();
      render(<AddTaskForm onAdd={onAdd} disabled={false} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "water the plants every day" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({ content: "water the plants", dateString: "every day" }),
      );
    });

    it("a demoted phrase's own revealed fallback token can itself be demoted — the cascade doesn't dead-end", () => {
      // Demoting "every monday" (the compound match) doesn't demote
      // "monday" — a *different*, previously-shadowed candidate wins that
      // span in its place (../../packages/core/src/quick-add's own
      // overlap priority). A reader who demotes that one too must land
      // back at fully plain text in one further click, exactly as a bare
      // "monday" with no phrase around it demotes in a single click —
      // this pins the fix for the regression reported after this
      // ticket's first pass: the fallback was reachable but stuck.
      const onAdd = vi.fn();
      render(<AddTaskForm onAdd={onAdd} disabled={false} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "call mum every monday" } });
      expect(highlightedSpans().map((s) => s.textContent)).toEqual(["every monday"]);

      clickAt(input, 20); // inside "monday", also inside "every monday"
      expect(highlightedSpans().map((s) => s.textContent)).toEqual(["monday"]);

      clickAt(input, 20); // inside the now-revealed bare "monday"
      expect(highlightedSpans()).toHaveLength(0);

      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({ content: "call mum every monday", dateString: null }),
      );
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
