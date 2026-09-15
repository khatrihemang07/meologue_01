/**
 * `TaskCustomRepeatDialog`'s own suite (issue #292). `now` is pinned to Tue
 * 15 Sep 2026 throughout — this ticket's own reference-capture instant —
 * via the `now` prop rather than fake timers, the same seam `task-
 * schedule-popover.test.tsx` pins with its own `now` prop for the identical
 * reason (`task-custom-repeat-dialog.tsx`'s own header comment on why the
 * "On date" field's default needs a stable "today").
 *
 * jsdom has no layout — nothing here asserts a rect, an overflow, or that
 * the dialog "looks right" (480×403, the fixed shadow/radius/background);
 * those are verified in a real browser separately. Every assertion below is
 * structure, roles, labels, checked/disabled state, and the emitted phrase
 * string — the parts jsdom actually can see.
 */
import { parseRecurrence } from "@meologue/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TaskCustomRepeatDialog } from "./task-custom-repeat-dialog";

const NOW = new Date(2026, 8, 15, 12, 0); // Tue 15 Sep 2026, local noon — this ticket's own capture instant

function Harness({
  recurrence = null,
  onSave,
}: {
  recurrence?: string | null;
  onSave: (phrase: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {/* Test-only scaffolding, not part of Todoist's own captured shape — gives a test a way to reopen the dialog after a Cancel, mirroring how a real host owns `open` state. */}
      <button type="button" data-testid="test-reopen" onClick={() => setOpen(true)}>
        reopen
      </button>
      <TaskCustomRepeatDialog
        open={open}
        onOpenChange={setOpen}
        onEscape={() => setOpen(false)}
        recurrence={recurrence}
        onSave={onSave}
        now={NOW}
      />
    </>
  );
}

function renderDialog(recurrence: string | null = null) {
  const onSave = vi.fn();
  render(<Harness recurrence={recurrence} onSave={onSave} />);
  return { onSave };
}

function dialog() {
  return screen.getByTestId("custom-repeat-dialog");
}

function openUnitMenu() {
  fireEvent.click(screen.getByRole("combobox", { name: "Unit" }));
  return screen.getByRole("listbox", { name: "Unit" });
}

function chooseUnit(label: string) {
  const listbox = openUnitMenu();
  fireEvent.click(within(listbox).getByRole("option", { name: label }));
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("structure and labels (Todoist's own captured shape, issue #292)", () => {
  it("is a dialog named 'Custom repeat'", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Custom repeat" })).toBe(dialog());
  });

  it("has a 'Based on' group with Todoist's own two radios, Scheduled date checked by default", () => {
    renderDialog();
    const scheduled = screen.getByRole("radio", { name: "Scheduled date" });
    const completed = screen.getByRole("radio", { name: "Completed date" });
    expect(scheduled).toBeChecked();
    expect(completed).not.toBeChecked();
  });

  it("has an 'Every' group with a spinbutton defaulting to 1 and a Unit combobox defaulting to Day", () => {
    renderDialog();
    const every = screen.getByRole("spinbutton", { name: "Every" });
    expect(every).toHaveValue(1);
    expect(every).toHaveAttribute("min", "1");
    expect(every).toHaveAttribute("max", "999");
    expect(every).not.toBeDisabled();

    const combobox = screen.getByRole("combobox", { name: "Unit" });
    expect(combobox).toHaveAttribute("aria-haspopup", "listbox");
    expect(combobox).toHaveTextContent("Day");
  });

  it("offers the Unit dropdown's options verbatim, in Todoist's own captured order", () => {
    renderDialog();
    const listbox = openUnitMenu();
    const options = within(listbox)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["Day", "Week", "Weekday", "Month", "Year"]);
  });

  it("has an 'Ends' group with Never checked by default and Todoist's exact 'On date (inclusive)' label", () => {
    renderDialog();
    const never = screen.getByRole("radio", { name: "Never" });
    const onDate = screen.getByRole("radio", { name: "On date (inclusive)" });
    expect(never).toBeChecked();
    expect(onDate).not.toBeChecked();
    // The date controls only appear once "On date (inclusive)" is selected.
    expect(screen.queryByLabelText("Repeat until date")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select date" })).not.toBeInTheDocument();
  });

  it("reveals both the typed date input and the calendar button once 'On date (inclusive)' is selected", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "On date (inclusive)" }));

    const input = screen.getByLabelText("Repeat until date") as HTMLInputElement;
    expect(input).toHaveAttribute("type", "text");
    expect(input.value).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(screen.getByRole("button", { name: "Select date" })).toBeInTheDocument();
  });

  it("has Cancel and Save actions", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});

describe("Based on -> the '!' anchor (issue #291's own decision, surfaced here)", () => {
  it("Scheduled date (the default) emits a phrase with no '!'", () => {
    const { onSave } = renderDialog();
    save();
    const phrase = onSave.mock.calls[0]?.[0];
    expect(phrase).toBe("every day");
    expect(parseRecurrence(phrase).kind).toBe("parsed");
  });

  it("Completed date emits the '!' anchor", () => {
    const { onSave } = renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "Completed date" }));
    save();
    const phrase = onSave.mock.calls[0]?.[0];
    expect(phrase).toBe("every! day");
    const parsed = parseRecurrence(phrase);
    expect(parsed.kind).toBe("parsed");
    expect(parsed.kind === "parsed" && parsed.rule.anchor).toBe("completion");
  });
});

describe("Every N Unit", () => {
  it("interval 1 emits 'every week', not 'every 1 week' (the parser accepts both; this is the canonical form)", () => {
    const { onSave } = renderDialog();
    chooseUnit("Week");
    save();
    expect(onSave).toHaveBeenCalledWith("every week");
  });

  it("a typed interval emits the plural unit word", () => {
    const { onSave } = renderDialog();
    chooseUnit("Month");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Every" }), { target: { value: "3" } });
    save();
    expect(onSave).toHaveBeenCalledWith("every 3 months");
  });

  it("Weekday disables the interval stepper, with a visible reason, and always emits 'every workday'", () => {
    const { onSave } = renderDialog();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Every" }), { target: { value: "5" } });
    chooseUnit("Weekday");

    const every = screen.getByRole("spinbutton", { name: "Every" });
    expect(every).toBeDisabled();
    // A visible, honest reason — not merely disabled with no explanation.
    expect(screen.getByText(/fixed interval of 1/i)).toBeInTheDocument();
    expect(every).toHaveAttribute("aria-describedby", screen.getByText(/fixed interval of 1/i).id);

    save();
    expect(onSave).toHaveBeenCalledWith("every workday");
  });
});

describe("Ends", () => {
  it("Never emits no 'ending' clause", () => {
    const { onSave } = renderDialog();
    save();
    expect(onSave.mock.calls[0]?.[0]).not.toMatch(/ending/);
  });

  it("On date (inclusive) emits a parsing 'ending <D> <Mon> <YYYY>' clause", () => {
    const { onSave } = renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "On date (inclusive)" }));
    fireEvent.change(screen.getByLabelText("Repeat until date"), {
      target: { value: "13/10/2026" },
    });
    save();

    const phrase = onSave.mock.calls[0]?.[0];
    expect(phrase).toBe("every day ending 13 Oct 2026");
    const parsed = parseRecurrence(phrase);
    expect(parsed.kind).toBe("parsed");
    expect(parsed.kind === "parsed" && parsed.rule.endBound).toEqual({
      month: 10,
      day: 13,
      year: 2026,
    });
  });

  it("picking a day from the calendar button updates the typed date input", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "On date (inclusive)" }));
    fireEvent.click(screen.getByRole("button", { name: "Select date" }));

    // `date-picker-sheet.test.tsx`'s own house format for a react-day-picker
    // day button's accessible name: "<Month> <ordinal>, <year>".
    fireEvent.click(screen.getByRole("button", { name: /September 20th, 2026/ }));

    expect(screen.getByLabelText("Repeat until date")).toHaveValue("20/09/2026");
  });

  it("an invalid typed date (e.g. 31/02, which JS Date would silently roll into March) is rejected, leaving the last valid value committed", () => {
    const { onSave } = renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "On date (inclusive)" }));
    // Seeded from `now` (15 Sep 2026) — this file's own header comment.
    expect(screen.getByLabelText("Repeat until date")).toHaveValue("15/09/2026");

    fireEvent.change(screen.getByLabelText("Repeat until date"), {
      target: { value: "31/02/2026" },
    });
    // The text field echoes whatever was typed, before Save is even
    // clicked (Save closes the dialog and unmounts this field, so this has
    // to be read first)...
    expect(screen.getByLabelText("Repeat until date")).toHaveValue("31/02/2026");

    save();

    // ...but the committed draft never adopted the invalid date — the
    // emitted phrase still carries the last valid one (15 Sep), never a
    // rolled-over "3 Mar".
    const phrase = onSave.mock.calls[0]?.[0] as string;
    expect(phrase).toBe("every day ending 15 Sep 2026");
    expect(parseRecurrence(phrase).kind).toBe("parsed");
  });
});

describe("seeding from an existing phrase", () => {
  it("restores Based on / Every / Ends from a recognised phrase", () => {
    renderDialog("every! 2 weeks ending 13 oct 2026");

    expect(screen.getByRole("radio", { name: "Completed date" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Every" })).toHaveValue(2);
    expect(screen.getByRole("combobox", { name: "Unit" })).toHaveTextContent("Week");
    expect(screen.getByRole("radio", { name: "On date (inclusive)" })).toBeChecked();
    expect(screen.getByLabelText("Repeat until date")).toHaveValue("13/10/2026");
  });

  it("seeds 'every workday' with Weekday selected and the stepper disabled", () => {
    renderDialog("every workday");

    expect(screen.getByRole("combobox", { name: "Unit" })).toHaveTextContent("Weekday");
    expect(screen.getByRole("spinbutton", { name: "Every" })).toBeDisabled();
  });

  it("null (no existing rule) seeds the captured defaults", () => {
    renderDialog(null);

    expect(screen.getByRole("radio", { name: "Scheduled date" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Every" })).toHaveValue(1);
    expect(screen.getByRole("combobox", { name: "Unit" })).toHaveTextContent("Day");
    expect(screen.getByRole("radio", { name: "Never" })).toBeChecked();
  });

  it("a frequency the dropdown can't represent (a named weekday list) falls back to Day/1, but Based on and Ends still seed correctly", () => {
    // "every friday" is the Repeat menu's own "Week" quick option (SCHED-14)
    // — a specific weekday list, not this dialog's plain "Week" (weekly)
    // frequency. See task-custom-repeat-dialog.tsx's own header comment.
    renderDialog("every! friday ending 1 jan 2027");

    expect(screen.getByRole("combobox", { name: "Unit" })).toHaveTextContent("Day");
    expect(screen.getByRole("spinbutton", { name: "Every" })).toHaveValue(1);
    // Based on and Ends don't depend on the frequency, so they still seed
    // correctly even though the frequency itself had to fall back.
    expect(screen.getByRole("radio", { name: "Completed date" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "On date (inclusive)" })).toBeChecked();
    expect(screen.getByLabelText("Repeat until date")).toHaveValue("01/01/2027");
  });

  it("an unparseable phrase falls back to the captured defaults rather than throwing", () => {
    renderDialog("not a recurrence phrase at all");

    expect(screen.getByRole("radio", { name: "Scheduled date" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Every" })).toHaveValue(1);
    expect(screen.getByRole("combobox", { name: "Unit" })).toHaveTextContent("Day");
    expect(screen.getByRole("radio", { name: "Never" })).toBeChecked();
  });

  it("reopening after Cancel shows the Task's real rule, not an abandoned draft", () => {
    renderDialog("every month");

    // Abandon a draft edit.
    chooseUnit("Year");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Every" }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("custom-repeat-dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("test-reopen"));

    expect(screen.getByRole("combobox", { name: "Unit" })).toHaveTextContent("Month");
    expect(screen.getByRole("spinbutton", { name: "Every" })).toHaveValue(1);
  });
});

describe("Escape closes this dialog and calls onEscape, without saving (task-time-dialog.tsx's own SCHED-11 follow-up)", () => {
  it("fires onEscape and never calls onSave", () => {
    const { onSave } = renderDialog();
    fireEvent.keyDown(dialog(), { key: "Escape" });

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByTestId("custom-repeat-dialog")).not.toBeInTheDocument();
  });
});

describe("every emitted phrase parses (issue #292's own real guard)", () => {
  // units × interval(1, 5) × both anchors × both Ends branches — Weekday is
  // exercised separately (its own interval is fixed and disabled, not a
  // third value to cross with 1/5).
  const nonWorkdayUnits = ["Day", "Week", "Month", "Year"];
  const combos: Array<{
    unit: string;
    interval: number;
    anchor: "scheduled" | "completed";
    ends: "never" | "onDate";
  }> = [];
  for (const unit of nonWorkdayUnits) {
    for (const interval of [1, 5]) {
      for (const anchor of ["scheduled", "completed"] as const) {
        for (const ends of ["never", "onDate"] as const) {
          combos.push({ unit, interval, anchor, ends });
        }
      }
    }
  }
  for (const anchor of ["scheduled", "completed"] as const) {
    for (const ends of ["never", "onDate"] as const) {
      combos.push({ unit: "Weekday", interval: 1, anchor, ends });
    }
  }

  it.each(combos)(
    "unit=$unit interval=$interval anchor=$anchor ends=$ends",
    ({ unit, interval, anchor, ends }) => {
      const { onSave } = renderDialog();

      if (anchor === "completed") {
        fireEvent.click(screen.getByRole("radio", { name: "Completed date" }));
      }
      if (unit !== "Day") {
        chooseUnit(unit);
      }
      if (unit !== "Weekday" && interval !== 1) {
        fireEvent.change(screen.getByRole("spinbutton", { name: "Every" }), {
          target: { value: String(interval) },
        });
      }
      if (ends === "onDate") {
        fireEvent.click(screen.getByRole("radio", { name: "On date (inclusive)" }));
      }

      save();

      expect(onSave).toHaveBeenCalledTimes(1);
      const phrase = onSave.mock.calls[0]?.[0] as string;
      const parsed = parseRecurrence(phrase);
      expect(parsed.kind).toBe("parsed");
    },
  );
});

/**
 * The narrowing these cover is a real way to lose a rule, not a cosmetic
 * gap: the five units this dialog offers cannot express a named-weekday or
 * ordinal-weekday frequency, so a Task carrying one seeds the Day/1 fallback
 * and Save — pressed without touching a single control — would replace it.
 * The warning is the only thing standing between a reader and a rule that
 * quietly becomes daily, so it is asserted on both sides: present exactly
 * when a rule is about to be narrowed, absent every other time.
 */
describe("a rule the controls can't express is announced, not silently narrowed (issue #292)", () => {
  const WARNING = "custom-repeat-unrepresentable";

  it("names the phrase it is about to replace, in the phrase's own words", () => {
    renderDialog("every friday");

    const warning = screen.getByTestId(WARNING);
    expect(warning.textContent).toContain("every friday");
    expect(warning.textContent).toContain("Saving replaces it");
  });

  it("warns for an ordinal weekday too", () => {
    renderDialog("every 3rd friday");

    expect(screen.getByTestId(WARNING).textContent).toContain("every 3rd friday");
  });

  it("stays silent for every rule the controls CAN express", () => {
    for (const phrase of ["every day", "every 2 weeks", "every workday", "every! 3 months"]) {
      const { unmount } = render(<Harness recurrence={phrase} onSave={vi.fn()} />);
      expect(screen.queryByTestId(WARNING), `warned for ${phrase}`).toBeNull();
      unmount();
    }
  });

  it("stays silent for a Task with no recurrence at all", () => {
    renderDialog(null);
    expect(screen.queryByTestId(WARNING)).toBeNull();
  });

  it("stays silent for text the grammar already refuses — there is no rule to lose", () => {
    renderDialog("every blue moon");
    expect(screen.queryByTestId(WARNING)).toBeNull();
  });

  it("still seeds the halves that DO survive the narrowing, so the warning isn't the only signal", () => {
    renderDialog("every! friday ending 1 jan 2027");

    expect(screen.getByRole("radio", { name: "Completed date" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "On date (inclusive)" })).toBeChecked();
    expect(screen.getByTestId(WARNING)).toBeTruthy();
  });
});

/**
 * Three defects found by driving this dialog in a real browser (issue #292
 * follow-up), all invisible in jsdom for the same underlying reason: jsdom
 * never lays anything out, never establishes a stacking context, and never
 * asks "what's actually painted on top at these coordinates" the way a real
 * compositor does. So none of the tests below can assert the thing that was
 * actually wrong (a picker rendering behind an opaque dialog, a 480px box
 * overhanging a 400px viewport, dead space between a field and a button
 * row) — they assert the class/style CONTRACT the fix relies on instead
 * (the computed z-index value, the max-width rule being present, the
 * overflow/min-height rules that let content scroll instead of clip). The
 * real check for all three is the browser pass this ticket asked for, not
 * this file.
 */
describe("layout defects found live and fixed here — class/style contract only (issue #292 follow-up)", () => {
  it("the 'Select date' popover carries a z-index above this dialog's own z-[70], overriding ui/popover.tsx's shared z-[60] default", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "On date (inclusive)" }));
    fireEvent.click(screen.getByRole("button", { name: "Select date" }));

    const popover = screen.getByTestId("custom-repeat-date-popover");
    // Radix portals `Popover.Content` to `document.body`, so `getByTestId`
    // (which searches the whole document) is the only way to reach it — it
    // is not a descendant of `dialog()`. jsdom cannot tell us this actually
    // *paints* above the dialog (no stacking context in jsdom at all); this
    // only confirms the class this fix depends on is the one actually
    // rendered, not silently reverted or typo'd.
    expect(popover.className).toMatch(/(?:^|\s)z-\[80\](?:\s|$)/);
    expect(popover.className).not.toMatch(/(?:^|\s)z-\[60\](?:\s|$)/);
  });

  it("the dialog's own frame carries both the captured 480px width and a viewport-bounded max-width clamp", () => {
    renderDialog();
    // jsdom never lays this out, so nothing here can assert the resulting
    // `x`/width at a narrow viewport (the live-measured `x: -40` overhang)
    // — only that the two Tailwind classes the fix depends on are both
    // present: the captured desktop width, unchanged, and the clamp that
    // keeps it from overhanging a viewport narrower than that.
    expect(dialog().className).toMatch(/(?:^|\s)w-\[480px\](?:\s|$)/);
    expect(dialog().className).toMatch(/(?:^|\s)max-w-\[calc\(100%-2rem\)\](?:\s|$)/);
  });

  it("the dialog's own height is still exactly the captured 403px, unchanged by the width/overflow fix", () => {
    renderDialog();
    // The one part of this defect jsdom actually CAN see: this is a plain
    // inline style, not a layout outcome. Confirms the fixed-height,
    // non-resize property (task-custom-repeat-dialog.tsx's own header
    // comment: Todoist's dialog does not resize between "Ends" branches,
    // measured 480x403 before and after) is still intact after this
    // ticket's changes, not accidentally swapped for `minHeight` while
    // fixing the other two defects.
    expect(dialog().style.height).toBe("403px");
  });

  it("the form absorbs overflow instead of the dialog clipping it: overflow-auto + min-h-0 on a flex-1 child, not a bare fixed box", () => {
    renderDialog();
    const form = dialog().querySelector("form");
    expect(form).not.toBeNull();
    // jsdom lays out nothing, so it can't show content actually overflowing
    // and scrolling — only that the three classes the no-clip guarantee
    // depends on (flex-1's automatic min-height zeroed by `min-h-0`, and
    // `overflow-auto` to make the zeroed-out overflow scrollable rather
    // than invisible) are the ones actually on the element.
    expect(form?.className).toMatch(/(?:^|\s)min-h-0(?:\s|$)/);
    expect(form?.className).toMatch(/(?:^|\s)overflow-auto(?:\s|$)/);
    expect(form?.className).toMatch(/(?:^|\s)justify-between(?:\s|$)/);
  });
});
