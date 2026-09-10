import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { formatTaskReference } from "@/lib/inline-markdown";
import { entryProse, type TaskReferenceRenderer } from "./entry-prose";
import type { ReferenceRenderers } from "./inline-prose";

const TASK_ID = "0192abcd-1234-7890-abcd-0123456789ac";

/**
 * `entryProse` has no wrapper of its own — same contract as `inlineProse`
 * — so every test renders it inside a `<div>`, the way `entry-row.tsx`'s
 * `EntryBody` and `entry-bubble.tsx`'s bubble body do for a real Entry.
 */
function Harness({
  body,
  query,
  refs,
  renderTaskReference,
}: {
  body: string;
  query?: string;
  refs?: ReferenceRenderers;
  renderTaskReference?: TaskReferenceRenderer;
}): ReactNode {
  return <div data-testid="prose">{entryProse(body, query, refs, renderTaskReference)}</div>;
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

    // ADR 0071's "empty parent item" — a `list_item` with no text of its
    // own, whose only content is the nested list `sinkFirstListItem`
    // (composer-commands.ts) built it to hold. Issue #233 rendered this
    // markerless in the Composer (`.ProseMirror` rule, index.css); issue
    // #236 is what closes the matching gap here, on the READ side. The
    // exact markdown below is what `entryDocumentToMarkdown` (entry-
    // document.ts) actually writes for a sunk first item — verified
    // directly against that function's own `writeListItem`, not invented —
    // rather than a shape this test merely assumes is equivalent.
    it("renders an empty parent item markerless, with its nested list still visible", () => {
      const { container } = render(<Harness body={"- \n  - alpha\n- bravo"} />);

      const outerList = container.querySelector("ul");
      expect(outerList).not.toBeNull();
      const outerItems = outerList?.querySelectorAll(":scope > li") ?? [];
      expect(outerItems).toHaveLength(2);
      const [parentItem, bravoItem] = Array.from(outerItems);
      expect(parentItem?.classList.contains("list-none")).toBe(true);
      expect(parentItem?.querySelector("ul")).toHaveTextContent("alpha");
      // The following sibling item is an ordinary one — untouched by the
      // wrapper's own markerless rule.
      expect(bravoItem?.classList.contains("list-none")).toBe(false);
      expect(bravoItem).toHaveTextContent("bravo");
    });

    // ADR 0071 is explicit that this rule must not over-fire: a plain empty
    // item a reader left blank by pressing Enter twice, with no nested list
    // following it, keeps its ordinary marker.
    it("still shows the marker on an ordinary empty item with no nested list", () => {
      const { container } = render(<Harness body={"- one\n- \n- three"} />);

      const list = container.querySelector("ul");
      expect(list).not.toBeNull();
      const items = list?.querySelectorAll(":scope > li") ?? [];
      expect(items).toHaveLength(3);
      for (const item of Array.from(items)) {
        expect(item.classList.contains("list-none")).toBe(false);
      }
    });

    // Issue #162: the read side's own disc/circle/square cascade —
    // `renderBlocks`'s `depth` argument, threaded through `renderListItem`
    // back into `renderBlocks` for each nested list, must land on the
    // right class at each of three depths, and repeat the third (square)
    // rather than inventing a fourth glyph for a fourth level. Asserts
    // the CLASS rather than the computed `list-style-type` — jsdom applies
    // no stylesheet, so `getComputedStyle` would report nothing useful
    // either way, and the class is what index.css's own comment (pointing
    // back at this file) says the two render paths must agree on.
    it("cascades bullet glyph disc -> circle -> square by nesting depth, capped at three", () => {
      const { container } = render(<Harness body={"- one\n  - two\n    - three\n      - four"} />);

      const lists = Array.from(container.querySelectorAll("ul"));
      expect(lists).toHaveLength(4);
      expect(lists[0]?.classList.contains("list-disc")).toBe(true);
      expect(lists[1]?.classList.contains("list-[circle]")).toBe(true);
      expect(lists[2]?.classList.contains("list-[square]")).toBe(true);
      // Depth 4 repeats depth 3's square rather than growing a new glyph.
      expect(lists[3]?.classList.contains("list-[square]")).toBe(true);
    });

    // Ordered lists never vary their glyph by depth (always decimal), and
    // each nested `<ol>` restarts its own numbering at 1 — both are plain
    // browser default behaviour for `list-style: decimal` and a fresh
    // `<ol>` element respectively, per index.css's own comment on why no
    // depth-cascade CSS or JS is needed for the ordered case, unlike the
    // bullet one just above.
    it("keeps ordered lists decimal at every depth, restarting at 1 per level", () => {
      const { container } = render(<Harness body={"1. one\n   1. two\n      1. three"} />);

      const lists = Array.from(container.querySelectorAll("ol"));
      expect(lists).toHaveLength(3);
      for (const list of lists) {
        expect(list.classList.contains("list-decimal")).toBe(true);
        // No explicit start marker was given at any level in the source,
        // so each restarts at 1 independent of its own nesting depth —
        // `entry-prose.tsx` always renders the `<ol>`'s `start` attribute
        // (React renders an explicit prop even at its default), so this
        // checks the VALUE rather than whether the attribute is present.
        expect(list.getAttribute("start")).toBe("1");
      }
    });

    // The model already allows a checklist nested under an ordered item
    // and vice versa (entry-schema.ts's `list_item` content, "paragraph
    // block*", makes no distinction by parent list type) — this pins down
    // that the READ side actually renders that mix rather than merely
    // permitting it structurally.
    it("renders a checklist nested under an ordered item", () => {
      const { container } = render(<Harness body={"1. plan\n   - [ ] pack bags"} />);

      const orderedList = container.querySelector("ol");
      expect(orderedList).not.toBeNull();
      const checkbox = screen.getByRole("checkbox");
      expect(checkbox.closest("ol")).toBe(orderedList);
      expect(orderedList?.querySelector("ul input[type='checkbox']")).toBe(checkbox);
    });

    it("renders an ordered list nested under a checklist item", () => {
      const { container } = render(
        <Harness body={"- [ ] plan\n  1. pack bags\n  2. book flight"} />,
      );

      const bulletList = container.querySelector("ul");
      const nestedOrdered = bulletList?.querySelector("ol");
      expect(nestedOrdered).not.toBeNull();
      const nestedItems = nestedOrdered?.querySelectorAll(":scope > li") ?? [];
      expect(Array.from(nestedItems).map((li) => li.textContent)).toEqual([
        "pack bags",
        "book flight",
      ]);
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

      // The accessible name is the item's own words (issue #153's own
      // accessibility requirement), not a generic "Checked"/"Unchecked" —
      // the checked/unchecked state is already carried by the checkbox
      // role's own native semantics.
      it("names the checkbox after the item's own text", () => {
        render(<Harness body="- [ ] call mum" />);

        expect(screen.getByRole("checkbox", { name: "call mum" })).toBeInTheDocument();
      });

      // Issue #231, ADR 0074: a bare checkbox used to become a live
      // control once a caller wired a toggle handler (issue #153) and
      // ticking it spliced the marker directly into the Entry's body. It
      // is now permanently disabled, unconditionally — `entryProse` no
      // longer accepts any handler for it at all, because a bare checkbox
      // has no Task to open (ADR 0053 made every checkbox a Task, but the
      // association lives only in the `[[task:id|label]]` mark a bare
      // checkbox, by definition, doesn't have yet — see entry-prose.tsx's
      // own module comment).
      it("stays disabled and inert no matter how many checkboxes share one body", () => {
        const body = "- [ ] first\n- [ ] second\n- [ ] third";
        render(<Harness body={body} />);

        const checkboxes = screen.getAllByRole("checkbox");
        expect(checkboxes).toHaveLength(3);
        for (const checkbox of checkboxes) {
          expect(checkbox).toBeDisabled();
        }

        fireEvent.click(screen.getByRole("checkbox", { name: "third" }));

        // A click on a disabled checkbox never flips its own checked prop
        // (jsdom's own native behaviour, not this component's), which is
        // the DOM-level proof that nothing here is listening for one.
        expect(screen.getByRole("checkbox", { name: "third" })).not.toBeChecked();
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

    // Issue #173, ADR 0048: a checkbox line whose whole content is
    // `[[task:id|label]]` — Promotion's own output shape — is a
    // *referenced* task item, a different render branch entirely from the
    // bare-checkbox one above. `entryProse`'s default renderer
    // (`defaultTaskReferenceItem`) has no store to resolve a live Task
    // against, so every one of these renders the body's own cache and
    // stays unconditionally disabled — the same "no renderer supplied, no
    // interactivity" rule a date/Entry Reference already follows.
    describe("referenced task-list checkboxes", () => {
      it("renders the cached label, not the raw [[task:…]] mark", () => {
        render(<Harness body={`- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`} />);

        expect(screen.getByText("buy milk")).toBeInTheDocument();
        expect(screen.queryByText(/\[\[task:/)).not.toBeInTheDocument();
      });

      it("reads its checked state from the marker's own cache — unchecked", () => {
        render(<Harness body={`- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`} />);

        expect(screen.getByRole("checkbox")).not.toBeChecked();
      });

      it("reads its checked state from the marker's own cache — checked", () => {
        render(<Harness body={`- [x] ${formatTaskReference(TASK_ID, "buy milk")}`} />);

        expect(screen.getByRole("checkbox")).toBeChecked();
      });

      // The "leads nowhere" half of ADR 0048's unresolved-reference rule —
      // this file has no store to resolve against at all, which is the
      // same state a Device that hasn't Synced the Task yet would see, so
      // `entryProse`'s own default renderer is a faithful stand-in for it.
      it("stays disabled — the default renderer has no Task store to open one through", () => {
        render(<Harness body={`- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`} />);

        const checkbox = screen.getByRole("checkbox");
        expect(checkbox).toBeDisabled();
        fireEvent.click(checkbox);
        expect(checkbox).not.toBeChecked();
      });

      // Issue #231, ADR 0074: falling back to the bare-checkbox branch
      // used to mean "still tickable, still splices the body." A bare
      // checkbox is now permanently disabled instead (see this file's own
      // describe block above), and this line falls back to exactly that
      // branch — `referencedTaskOf` (entry-prose.tsx) only recognises the
      // reference when it is the item's *entire* content.
      it("falls back to the (now permanently disabled) bare checkbox once a reference sits alongside other text on the same line", () => {
        const body = `- [ ] ${formatTaskReference(TASK_ID, "buy milk")} plus more`;
        render(<Harness body={body} />);

        expect(screen.getByRole("checkbox")).toBeDisabled();
      });

      it("still renders a nested list beneath a referenced line", () => {
        render(
          <Harness
            body={`- [ ] ${formatTaskReference(TASK_ID, "buy milk")}\n  - a note about it`}
          />,
        );

        expect(screen.getByText("buy milk")).toBeInTheDocument();
        expect(screen.getByText("a note about it")).toBeInTheDocument();
      });

      it("keeps the DOM shape index.css's completed-style rule depends on", () => {
        render(<Harness body={`- [x] ${formatTaskReference(TASK_ID, "buy milk")}`} />);

        const checkbox = screen.getByRole("checkbox");
        const li = checkbox.closest("li");
        expect(li).not.toBeNull();
        expect(li?.classList.contains("list-none")).toBe(true);
        expect(checkbox.nextElementSibling?.tagName).toBe("DIV");
      });

      it("hands a supplied renderer the reference's own taskId/label/checked and any nested content", () => {
        const renderTaskReference = vi.fn(({ taskId, label, checked, content }, key: string) => (
          <li key={key} data-testid="custom-task-ref">
            {taskId}:{label}:{String(checked)}
            {content}
          </li>
        ));

        render(
          <Harness
            body={`- [x] ${formatTaskReference(TASK_ID, "buy milk")}\n  - nested`}
            renderTaskReference={renderTaskReference}
          />,
        );

        expect(renderTaskReference).toHaveBeenCalledTimes(1);
        const [props] = renderTaskReference.mock.calls[0] ?? [];
        expect(props).toMatchObject({ taskId: TASK_ID, label: "buy milk", checked: true });
        expect(screen.getByTestId("custom-task-ref")).toHaveTextContent(
          `${TASK_ID}:buy milk:truenested`,
        );
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
