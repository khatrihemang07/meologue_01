import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatePickerSheet, localDayKey } from "./date-picker-sheet";

// A day near the middle of the month whose number can't collide with an
// "outside day" from the neighbouring month the grid also renders (those
// only ever fill the 1-6 leading/trailing days of the visible weeks), so
// `getByRole("button", { name: /.../ })` below can never match two cells.
const MARCH_15_2026 = "2026-03-15";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("DatePickerSheet — the grid", () => {
  it("renders the seeded month and can move to the next and previous month", () => {
    render(
      <DatePickerSheet
        open={true}
        onOpenChange={vi.fn()}
        initialDate={MARCH_15_2026}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText(/March 2026/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Go to the Next Month" }));
    expect(screen.getByText(/April 2026/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Go to the Previous Month" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to the Previous Month" }));
    expect(screen.getByText(/February 2026/)).toBeInTheDocument();
  });

  it("does not disable any day — every date is selectable, including one with no Entries", () => {
    render(
      <DatePickerSheet
        open={true}
        onOpenChange={vi.fn()}
        initialDate={MARCH_15_2026}
        onConfirm={vi.fn()}
      />,
    );

    // A grid with no Entry data at all is exactly the case the issue
    // requires stay tappable — this component never receives density
    // information, so there's nothing that *could* disable a day, and this
    // asserts that stays true: no cell renders as `disabled`.
    const dayButtons = screen
      .getAllByRole("button")
      .filter((button) => /^\d+$/.test(button.textContent ?? ""));
    expect(dayButtons.length).toBeGreaterThan(27);
    for (const button of dayButtons) {
      expect(button).not.toBeDisabled();
    }
  });
});

describe("DatePickerSheet — tap then confirm", () => {
  it("does not call onConfirm just from tapping a day", () => {
    const onConfirm = vi.fn();
    render(
      <DatePickerSheet
        open={true}
        onOpenChange={vi.fn()}
        initialDate={MARCH_15_2026}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /March 20th, 2026/ }));

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("emits the tapped day's YYYY-MM-DD key only once Confirm is pressed", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <DatePickerSheet
        open={true}
        onOpenChange={onOpenChange}
        initialDate={MARCH_15_2026}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /March 20th, 2026/ }));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));

    expect(onConfirm).toHaveBeenCalledWith("2026-03-20");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismissing without confirming emits nothing", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <DatePickerSheet
        open={true}
        onOpenChange={onOpenChange}
        initialDate={MARCH_15_2026}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /March 20th, 2026/ }));
    // Escape is Radix Dialog's own dismiss path — the same mechanism an
    // overlay tap or a back-gesture would trigger.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("resets the highlighted day the next time it opens, rather than carrying over a dismissed tap", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <DatePickerSheet
        open={true}
        onOpenChange={vi.fn()}
        initialDate={MARCH_15_2026}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /March 20th, 2026/ }));
    expect(screen.getByRole("button", { name: /^Confirm/ })).toHaveTextContent("March 20, 2026");

    rerender(
      <DatePickerSheet
        open={false}
        onOpenChange={vi.fn()}
        initialDate={MARCH_15_2026}
        onConfirm={onConfirm}
      />,
    );
    rerender(
      <DatePickerSheet
        open={true}
        onOpenChange={vi.fn()}
        initialDate={MARCH_15_2026}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("button", { name: /^Confirm/ })).toHaveTextContent("March 15, 2026");
  });
});

describe("localDayKey — the local-day rule, not a UTC conversion", () => {
  // Pacific/Kiritimati sits at UTC+14, the furthest-east timezone that
  // exists — chosen specifically because a local midnight there is still
  // the *previous* day in UTC. `vi.stubEnv` reassigns `TZ` for the process;
  // only *new* `Date`s built after that pick up the new zone, which is
  // exactly what this test needs (nothing here relies on any `Date`
  // constructed before this `beforeEach` runs).
  beforeEach(() => {
    vi.stubEnv("TZ", "Pacific/Kiritimati");
  });

  it("names a near-midnight local day by the day a reader would name it, not the UTC day", () => {
    // Local midnight (00:30) on the 1st, at UTC+14, is 10:30 the *previous*
    // day in UTC. A day key derived via `toISOString().slice(0, 10)` (or
    // any other UTC accessor) would silently answer the 31st here — this
    // pins that `localDayKey` never takes that route.
    const localMidnightOnThe1st = new Date(2026, 0, 1, 0, 30, 0);

    expect(localMidnightOnThe1st.toISOString().slice(0, 10)).toBe("2025-12-31");
    expect(localDayKey(localMidnightOnThe1st)).toBe("2026-01-01");
  });

  it("round-trips a seeded day key through the picker's own initialDate parsing, not just localDayKey in isolation", () => {
    // Seeding from "2026-01-01" and confirming immediately, under the same
    // UTC+14 offset the test above pins, must emit "2026-01-01" back — this
    // exercises `parseDayKey` (initialDate -> Date) as well as
    // `localDayKey` (Date -> emitted key), since a mistake in either one
    // could silently cancel the other out on a naive round trip.
    const onConfirm = vi.fn();
    render(
      <DatePickerSheet
        open={true}
        onOpenChange={vi.fn()}
        initialDate="2026-01-01"
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));

    expect(onConfirm).toHaveBeenCalledWith("2026-01-01");
  });
});
