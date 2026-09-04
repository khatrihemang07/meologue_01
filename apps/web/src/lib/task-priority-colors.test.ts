import { describe, expect, it } from "vitest";
import { priorityColour } from "./task-priority-colors";

describe("priorityColour", () => {
  // P1 and P2 are the two values this ticket verified live, in a real
  // Todoist, dark theme, computed style — see this module's own header
  // comment. Asserted against literally, not merely "is a string," so a
  // future edit that quietly drifts either value fails a test rather than
  // only a visual diff nobody happened to look at.
  it("p1 is the verified rgb(255, 112, 102)", () => {
    expect(priorityColour(1)).toBe("rgb(255, 112, 102)");
  });

  it("p2 is the verified rgb(255, 154, 19)", () => {
    expect(priorityColour(2)).toBe("rgb(255, 154, 19)");
  });

  it("p4 (and, by extension, 'no priority') is the verified neutral rgb(169, 169, 169)", () => {
    expect(priorityColour(4)).toBe("rgb(169, 169, 169)");
  });

  it("p3 is distinct from every other level", () => {
    const p3 = priorityColour(3);
    expect(p3).not.toBe(priorityColour(1));
    expect(p3).not.toBe(priorityColour(2));
    expect(p3).not.toBe(priorityColour(4));
  });

  it("falls back to p4's neutral grey for an out-of-range input", () => {
    expect(priorityColour(0)).toBe(priorityColour(4));
    expect(priorityColour(5)).toBe(priorityColour(4));
  });
});
