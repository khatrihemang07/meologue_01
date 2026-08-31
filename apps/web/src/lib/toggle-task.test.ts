import { describe, expect, it } from "vitest";
import { type EntryListItem, parseEntryMarkdown } from "@/lib/inline-markdown";
import { toggleTaskAt } from "@/lib/toggle-task";

/**
 * Real `markerFrom`/`markerTo` offsets, parsed the same way
 * `entry-prose.tsx` gets them — rather than hand-computed indices, which
 * would only prove the splice agrees with itself, not with what the
 * parser actually reports.
 */
function taskMarkersOf(body: string): EntryListItem["task"][] {
  const markers: EntryListItem["task"][] = [];
  const walk = (blocks: readonly ReturnType<typeof parseEntryMarkdown>[number][]) => {
    for (const block of blocks) {
      if (block.kind === "prose") continue;
      for (const item of block.items) {
        markers.push(item.task);
        walk(item.content);
      }
    }
  };
  walk(parseEntryMarkdown(body));
  return markers;
}

describe("toggleTaskAt", () => {
  it("flips an unchecked marker to `[x]`", () => {
    const body = "- [ ] call mum";
    const [task] = taskMarkersOf(body);
    if (task === undefined) throw new Error("expected a task marker");

    expect(toggleTaskAt(body, task.markerFrom, task.markerTo)).toBe("- [x] call mum");
  });

  it("flips a `[x]`-checked marker back to `[ ]`", () => {
    const body = "- [x] call mum";
    const [task] = taskMarkersOf(body);
    if (task === undefined) throw new Error("expected a task marker");

    expect(toggleTaskAt(body, task.markerFrom, task.markerTo)).toBe("- [ ] call mum");
  });

  it("treats `[X]` as checked too, flipping it back to `[ ]`", () => {
    const body = "- [X] call mum";
    const [task] = taskMarkersOf(body);
    if (task === undefined) throw new Error("expected a task marker");

    expect(toggleTaskAt(body, task.markerFrom, task.markerTo)).toBe("- [ ] call mum");
  });

  it("changes only the marker's three characters — every other byte is identical", () => {
    // A bold run, an italic run, and a Reference elsewhere in the same
    // Entry — none of them may move or change (issue #153's own
    // acceptance criterion).
    const body = "- [ ] pick up **bread**\n- a _reminder_ about [[2026-08-28]]\n- [x] call the vet";
    const [first, , third] = taskMarkersOf(body);
    if (first === undefined || third === undefined) throw new Error("expected two task markers");

    const toggled = toggleTaskAt(body, first.markerFrom, first.markerTo);

    expect(toggled).toBe(
      "- [x] pick up **bread**\n- a _reminder_ about [[2026-08-28]]\n- [x] call the vet",
    );
    // Toggling the first item must not touch the third's own marker.
    expect(toggled.slice(third.markerFrom, third.markerTo)).toBe("[x]");
  });

  it("toggles the last item in a list without disturbing earlier items", () => {
    const body = "- [ ] first\n- [ ] second\n- [ ] third";
    const [first, second, third] = taskMarkersOf(body);
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("expected three task markers");
    }

    const toggled = toggleTaskAt(body, third.markerFrom, third.markerTo);

    expect(toggled).toBe("- [ ] first\n- [ ] second\n- [x] third");
    expect(toggled.slice(first.markerFrom, first.markerTo)).toBe("[ ]");
    expect(toggled.slice(second.markerFrom, second.markerTo)).toBe("[ ]");
  });

  it("toggles a single-item list", () => {
    const body = "- [ ] only thing to do";
    const [task] = taskMarkersOf(body);
    if (task === undefined) throw new Error("expected a task marker");

    expect(toggleTaskAt(body, task.markerFrom, task.markerTo)).toBe("- [x] only thing to do");
  });

  it("toggles a checkbox nested inside another list", () => {
    const body = "- shopping\n  - [ ] milk\n  - [ ] eggs";
    const markers = taskMarkersOf(body).filter((m): m is NonNullable<typeof m> => m !== undefined);
    const [milk, eggs] = markers;
    if (milk === undefined || eggs === undefined) throw new Error("expected two nested tasks");

    const toggled = toggleTaskAt(body, eggs.markerFrom, eggs.markerTo);

    expect(toggled).toBe("- shopping\n  - [ ] milk\n  - [x] eggs");
    expect(toggled.slice(milk.markerFrom, milk.markerTo)).toBe("[ ]");
  });
});
