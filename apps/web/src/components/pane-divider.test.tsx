import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIST_WIDTH, useSettingsStore } from "@/lib/settings";
import { MAX_LIST_WIDTH, MIN_LIST_WIDTH, maxListWidth, PaneDivider } from "./pane-divider";

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
}

beforeEach(() => {
  localStorage.clear();
  setWindowWidth(1400);
  useSettingsStore.setState({ listWidth: DEFAULT_LIST_WIDTH });
});

describe("PaneDivider", () => {
  it("exposes itself as a resizable separator with its current width", () => {
    render(<PaneDivider />);

    const divider = screen.getByRole("separator");
    expect(divider).toHaveAttribute("aria-orientation", "vertical");
    expect(divider).toHaveAttribute("aria-valuenow", String(DEFAULT_LIST_WIDTH));
    expect(divider).toHaveAttribute("aria-valuemin", String(MIN_LIST_WIDTH));
  });

  it("widens and narrows the list with the arrow keys", () => {
    render(<PaneDivider />);
    const divider = screen.getByRole("separator");

    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(useSettingsStore.getState().listWidth).toBe(DEFAULT_LIST_WIDTH + 16);

    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(useSettingsStore.getState().listWidth).toBe(DEFAULT_LIST_WIDTH);
  });

  it("takes a coarser step while Shift is held", () => {
    render(<PaneDivider />);

    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight", shiftKey: true });

    expect(useSettingsStore.getState().listWidth).toBe(DEFAULT_LIST_WIDTH + 64);
  });

  it("jumps to each end with Home and End", () => {
    render(<PaneDivider />);
    const divider = screen.getByRole("separator");

    fireEvent.keyDown(divider, { key: "Home" });
    expect(useSettingsStore.getState().listWidth).toBe(MIN_LIST_WIDTH);

    fireEvent.keyDown(divider, { key: "End" });
    expect(useSettingsStore.getState().listWidth).toBe(MAX_LIST_WIDTH);
  });

  it("never lets the list squeeze past its minimum", () => {
    useSettingsStore.setState({ listWidth: MIN_LIST_WIDTH });
    render(<PaneDivider />);

    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft", shiftKey: true });

    expect(useSettingsStore.getState().listWidth).toBe(MIN_LIST_WIDTH);
  });

  // The bound that matters on a small laptop: the destination beside the
  // list keeps 360px whatever the reader drags, so the list's own ceiling
  // is the window rather than the flat 560px maximum.
  it("leaves room for the open destination on a narrow window", () => {
    setWindowWidth(800);
    render(<PaneDivider />);

    fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });

    expect(useSettingsStore.getState().listWidth).toBe(440);
    expect(maxListWidth(800)).toBe(440);
  });

  it("persists the width so it survives a relaunch, on every platform", () => {
    render(<PaneDivider />);

    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });

    expect(localStorage.getItem("meologue.list-width")).toBe(String(DEFAULT_LIST_WIDTH + 16));
  });

  it("ignores keys that are not a resize", () => {
    render(<PaneDivider />);

    fireEvent.keyDown(screen.getByRole("separator"), { key: "a" });

    expect(useSettingsStore.getState().listWidth).toBe(DEFAULT_LIST_WIDTH);
  });
});
