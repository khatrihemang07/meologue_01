import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { entryProse } from "./entry-prose";
import type { ReferenceRenderers } from "./inline-prose";

/**
 * `entryProse` has no wrapper of its own — same contract as `inlineProse`
 * — so every test renders it inside a `<div>`, the way `entry-row.tsx`'s
 * `EntryBody` and `entry-bubble.tsx`'s bubble body do for a real Entry.
 */
function Harness({
  body,
  query,
  refs,
  onToggleTask,
}: {
  body: string;
  query?: string;
  refs?: ReferenceRenderers;
  onToggleTask?: (markerFrom: number, markerTo: number) => void;
}): ReactNode {
  return <div data-testid="prose">{entryProse(body, query, refs, onToggleTask)}</div>;
}

describe("entryProse", () => {
  it("renders bold, italic, and code as strong/em/code elements, same as inlineProse", () => {
    render(<Harness body="**bold** and *italic* and `code`" />);

    expect(screen.getByText("bold", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("italic", { selector: "em" })).toBeInTheDocument();
    expect(screen.getByText("code", { selector: "code" })).toBeInTheDocument();
  });

  it("renders plain prose with no list as one <p>, not a bare text node", () => {
    const { container } = render(<Harness body="a plain Entry with no structure at all" />);

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toHaveTextContent("a plain Entry with no structure at all");
  });

  describe("the mark set — lists", () => {
    it("renders `- item` as a real bulleted list", () => {
      const { container } = render(<Harness body={"- milk\n- eggs"} />);

      const list = container.querySelector("ul");
      expect(list).not.toBeNull();
      const items = list?.querySelectorAll(":scope > li") ?? [];
      expect(Array.from(items).map((li) => li.textContent)).toEqual(["milk", "eggs"]);
    });

    it("renders `1. item` as a real ordered list, carrying a non-default start", () => {
      const { container } = render(<Harness body={"5. five\n6. six"} />);

      const list = container.querySelector("ol");
      expect(list).not.toBeNull();
      expect(list).toHaveAttribute("start", "5");
      const items = list?.querySelectorAll(":scope > li") ?? [];
      expect(Array.from(items).map((li) => li.textContent)).toEqual(["five", "six"]);
    });

    it("nests a list inside a list item", () => {
      const { container } = render(<Harness body={"- top\n  - nested"} />);

      const outerList = container.querySelector("ul");
      expect(outerList).not.toBeNull();
      const outerItems = outerList?.querySelectorAll(":scope > li") ?? [];
      expect(outerItems).toHaveLength(1);
      const nestedList = outerItems[0]?.querySelector("ul");
      expect(nestedList).not.toBeNull();
      expect(nestedList).toHaveTextContent("nested");
    });

    describe("task-list checkboxes", () => {
      it("renders `- [ ]` as an unchecked, disabled checkbox", () => {
        render(<Harness body="- [ ] call mum" />);

        const checkbox = screen.getByRole("checkbox");
        expect(checkbox).not.toBeChecked();
        expect(checkbox).toBeDisabled();
        expect(screen.getByTestId("prose")).toHaveTextContent("call mum");
      });

      it("renders `- [x]` as a checked, disabled checkbox", () => {
        render(<Harness body="- [x] done" />);

        const checkbox = screen.getByRole("checkbox");
        expect(checkbox).toBeChecked();
        expect(checkbox).toBeDisabled();
      });

      it("mixes a checkbox item with a plain item in the same list", () => {
        render(<Harness body={"- [x] done\n- plain"} />);

        expect(screen.getAllByRole("checkbox")).toHaveLength(1);
        expect(screen.getByText("plain")).toBeInTheDocument();
      });

      // Issue #153: with a handler wired up, the checkbox stops being
      // merely a rendered state and becomes a live control.
      it("enables the checkbox once a toggle handler is supplied", () => {
        render(<Harness body="- [ ] call mum" onToggleTask={vi.fn()} />);

        expect(screen.getByRole("checkbox")).not.toBeDisabled();
      });

      // The accessible name is the item's own words (issue #153's own
      // accessibility requirement), not a generic "Checked"/"Unchecked" —
      // the checked/unchecked state is already carried by the checkbox
      // role's own native semantics.
      it("names the checkbox after the item's own text", () => {
        render(<Harness body="- [ ] call mum" onToggleTask={vi.fn()} />);

        expect(screen.getByRole("checkbox", { name: "call mum" })).toBeInTheDocument();
      });

      it("calls the toggle handler with the marker's own source offsets on click", () => {
        const onToggleTask = vi.fn();
        const body = "- [ ] call mum";
        render(<Harness body={body} onToggleTask={onToggleTask} />);

        fireEvent.click(screen.getByRole("checkbox"));

        expect(onToggleTask).toHaveBeenCalledTimes(1);
        const [markerFrom, markerTo] = onToggleTask.mock.calls[0] ?? [];
        expect(body.slice(markerFrom, markerTo)).toBe("[ ]");
      });

      it("toggles the right item when several checkboxes share one body", () => {
        const onToggleTask = vi.fn();
        const body = "- [ ] first\n- [ ] second\n- [ ] third";
        render(<Harness body={body} onToggleTask={onToggleTask} />);

        fireEvent.click(screen.getByRole("checkbox", { name: "third" }));

        const [markerFrom, markerTo] = onToggleTask.mock.calls[0] ?? [];
        // The offset the third checkbox reports must land on its own
        // marker, not the first or second item's.
        expect(body.slice(markerFrom, markerTo)).toBe("[ ]");
        expect(body.slice(0, markerFrom)).toBe("- [ ] first\n- [ ] second\n- ");
      });

      // A checkbox `<input>` fires `onChange` for a Space press while
      // focused, same as a click — no separate keyboard handler needed for
      // this to be keyboard-operable.
      it("stays keyboard-operable — a Space press fires the same handler as a click", () => {
        const onToggleTask = vi.fn();
        render(<Harness body="- [ ] call mum" onToggleTask={onToggleTask} />);

        const checkbox = screen.getByRole("checkbox");
        checkbox.focus();
        expect(checkbox).toHaveFocus();
        fireEvent.keyDown(checkbox, { key: " ", code: "Space" });
        fireEvent.click(checkbox);

        expect(onToggleTask).toHaveBeenCalledTimes(1);
      });

      it("does not call anything when disabled (no handler wired)", () => {
        render(<Harness body="- [ ] call mum" />);

        fireEvent.click(screen.getByRole("checkbox"));

        // Nothing to assert a call against — this just documents that a
        // disabled checkbox has no handler at all, not one that silently
        // no-ops.
        expect(screen.getByRole("checkbox")).toBeDisabled();
      });

      // Issue #163. jsdom applies no external stylesheet, so this cannot
      // assert the actual grayed-out/struck-through look — that's what
      // index.css's own rule does, driven by `--checked-list-text-
      // decoration`/`--checked-list-text-color`. What CAN be pinned down
      // here is the DOM SHAPE that rule depends on: a checked task item's
      // `<li>` must carry `list-none` and must render its checkbox
      // immediately followed by a sibling `<div>`, because index.css's
      // selector (`li.list-none input[type="checkbox"]:checked ~ div`) is
      // a structural match, not a class hook added for this feature's own
      // sake. A refactor here that keeps every test above green while
      // moving the checkbox inside the content `<div>`, or dropping
      // `list-none`, would silently turn every completed checklist item's
      // styling back off in History with nothing above to catch it.
      it("keeps the DOM shape index.css's completed-style rule depends on", () => {
        render(<Harness body="- [x] done" />);

        const checkbox = screen.getByRole("checkbox");
        const li = checkbox.closest("li");
        expect(li).not.toBeNull();
        expect(li?.classList.contains("list-none")).toBe(true);
        expect(checkbox.nextElementSibling?.tagName).toBe("DIV");
      });
    });

    it("resolves a Reference inside a list item, not just outside one", () => {
      const dateRenderer = vi.fn((node: { date: string; raw: string }, key: string) => (
        <button key={key} type="button" data-testid="date-ref">
          {node.date}
        </button>
      ));

      render(<Harness body="- see [[2026-08-28]] for context" refs={{ date: dateRenderer }} />);

      expect(dateRenderer).toHaveBeenCalledTimes(1);
      const chip = screen.getByTestId("date-ref");
      expect(chip.closest("li")).not.toBeNull();
    });

    it("highlights a Search match inside a list item", () => {
      render(<Harness body="- a recurring task" query="recur" />);

      const mark = screen.getByText("recurring", { selector: "mark" });
      expect(mark).toBeInTheDocument();
      expect(mark.closest("li")).not.toBeNull();
    });
  });

  // The construct this ticket deliberately keeps out of the mark set —
  // mirrors inline-prose.test.tsx's own "never renders a block element"
  // guard, but for the handful of tags a real Markdown renderer would have
  // produced for this input, had their block parsers not been removed.
  describe("structure that is not in the mark set — renders as literal characters, never as its own element", () => {
    const cases: Array<{ body: string; forbidden: readonly string[] }> = [
      { body: "# heading", forbidden: ["h1", "h2", "h3", "h4", "h5", "h6"] },
      { body: "###### heading", forbidden: ["h1", "h2", "h3", "h4", "h5", "h6"] },
      { body: "Setext heading\n===", forbidden: ["h1", "h2"] },
      { body: "> a blockquote", forbidden: ["blockquote"] },
      { body: "```\nfenced code\n```", forbidden: ["pre"] },
      { body: "    four-space indented code", forbidden: ["pre"] },
      { body: "---", forbidden: ["hr"] },
    ];

    for (const { body, forbidden } of cases) {
      it(`does not render ${JSON.stringify(body)} as ${forbidden.join("/")}`, () => {
        const { container } = render(<Harness body={body} />);

        for (const tag of forbidden) {
          expect(container.querySelectorAll(tag)).toHaveLength(0);
        }
        // Every one of these also carries no list, checkbox, or table —
        // it degrades to plain prose, not silently to some *other*
        // structural element instead of the one it looks like.
        expect(container.querySelectorAll("ul, ol, table, input")).toHaveLength(0);
      });
    }

    it("keeps a real list next to a removed construct — only the list gets its own element", () => {
      const { container } = render(<Harness body={"# heading\n- item\n> quote"} />);

      expect(container.querySelectorAll("h1, h2, h3, blockquote")).toHaveLength(0);
      expect(container.querySelectorAll("ul")).toHaveLength(1);
      expect(screen.getByTestId("prose")).toHaveTextContent("# heading");
      expect(screen.getByTestId("prose")).toHaveTextContent("> quote");
    });
  });

  it("injects no HTML — a script tag renders as visible text, not a script element", () => {
    const { container } = render(<Harness body="<script>alert(1)</script>" />);

    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
  });

  it("does not treat [label](url) as a link, same as inlineProse", () => {
    render(<Harness body="[label](http://x)" />);

    expect(screen.getByText("[label](http://x)")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
