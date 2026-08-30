import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inlineProse, type ReferenceRenderers } from "./inline-prose";

/**
 * `inlineProse` deliberately has no wrapper element of its own (the caller
 * supplies the box), so every test renders it inside one, the way
 * `entry-row.tsx`'s `<p>` does for a real Entry.
 */
function Harness({
  body,
  query,
  refs,
}: {
  body: string;
  query?: string;
  refs?: ReferenceRenderers;
}): ReactNode {
  return <div data-testid="prose">{inlineProse(body, query, refs)}</div>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inlineProse", () => {
  it("renders bold, italic, and code as strong/em/code elements", () => {
    render(<Harness body="**bold** and *italic* and `code`" />);

    expect(screen.getByText("bold", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("italic", { selector: "em" })).toBeInTheDocument();
    expect(screen.getByText("code", { selector: "code" })).toBeInTheDocument();
  });

  // The single most important test in this file: it guards ADR 0036's
  // floated clock (which needs the Entry bubble to be one line box) and
  // the Digest card's scrollHeight/lineHeight line-count clamp. Both break
  // silently — and "passed every test, wrong on screen" — the moment a
  // block element sneaks into an Entry's or a Digest's prose.
  it("never renders a block element, for any input including block-looking syntax", () => {
    const blockTags = [
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "hr",
      "div",
      "table",
    ];
    const inputs = [
      "# heading",
      "- item",
      "1. item",
      "> quote",
      "---",
      "```\nconst x = 1;\n```",
      "**bold** *italic* `code` [[2026-08-28]]",
      "plain Reflection prose with no marks at all",
    ];

    for (const body of inputs) {
      const { unmount } = render(<Harness body={body} />);
      // Query strictly *within* the prose element — it and its own wrapper
      // are the harness's own <div>s, not something inlineProse produced.
      const prose = screen.getByTestId("prose");
      for (const tag of blockTags) {
        expect(prose.querySelectorAll(tag).length).toBe(0);
      }
      unmount();
    }
  });

  it("injects no HTML — a script tag renders as visible text, not a script element", () => {
    const { container } = render(<Harness body="<script>alert(1)</script>" />);

    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
  });

  it("highlights a Search query match in plain prose", () => {
    render(<Harness body="a recurring Question" query="recur" />);

    const mark = screen.getByText("recurring", { selector: "mark" });
    expect(mark).toBeInTheDocument();
    expect(mark.parentElement).toHaveTextContent("a recurring Question");
  });

  it("highlights a Search query match inside formatted (bolded) text", () => {
    render(<Harness body="a **recurring** Question" query="recur" />);

    const mark = screen.getByText("recurring", { selector: "mark" });
    expect(mark).toBeInTheDocument();
    expect(mark.closest("strong")).not.toBeNull();
  });

  describe("References with no renderers supplied", () => {
    it("renders a date Reference as its literal raw text, with no link or button", () => {
      const { container } = render(<Harness body="See [[2026-08-28]] for Grounding" />);

      expect(screen.getByTestId("prose")).toHaveTextContent("See [[2026-08-28]] for Grounding");
      expect(container.querySelector("a")).not.toBeInTheDocument();
      expect(container.querySelector("button")).not.toBeInTheDocument();
    });

    it("renders an entry Reference as its literal raw text, with no link or button", () => {
      const raw = "[[e:0192abcd-1234-7890-abcd-0123456789ab]]";
      const { container } = render(<Harness body={`See ${raw} for the Answer`} />);

      expect(screen.getByTestId("prose")).toHaveTextContent(`See ${raw} for the Answer`);
      expect(container.querySelector("a")).not.toBeInTheDocument();
      expect(container.querySelector("button")).not.toBeInTheDocument();
    });
  });

  describe("References with renderers supplied", () => {
    it("calls refs.date with the parsed date and raw text, and renders its output", () => {
      const dateRenderer = vi.fn((node: { date: string; raw: string }, key: string) => (
        <button key={key} type="button" data-testid="date-ref">
          Grounded on {node.date}
        </button>
      ));

      render(<Harness body="See [[2026-08-28]]" refs={{ date: dateRenderer }} />);

      expect(dateRenderer).toHaveBeenCalledTimes(1);
      expect(dateRenderer.mock.calls[0]?.[0]).toEqual({
        date: "2026-08-28",
        raw: "[[2026-08-28]]",
      });
      expect(screen.getByTestId("date-ref")).toHaveTextContent("Grounded on 2026-08-28");
    });

    it("calls refs.entry with the bare entryId and raw text, and renders its output", () => {
      const entryId = "0192abcd-1234-7890-abcd-0123456789ab";
      const entryRenderer = vi.fn((node: { entryId: string; raw: string }, key: string) => (
        <button key={key} type="button" data-testid="entry-ref">
          Entry {node.entryId}
        </button>
      ));

      render(<Harness body={`[[e:${entryId}]]`} refs={{ entry: entryRenderer }} />);

      expect(entryRenderer).toHaveBeenCalledTimes(1);
      expect(entryRenderer.mock.calls[0]?.[0]).toEqual({ entryId, raw: `[[e:${entryId}]]` });
      expect(screen.getByTestId("entry-ref")).toHaveTextContent(`Entry ${entryId}`);
    });
  });

  // React logs a key warning through console.error when siblings in a list
  // are not given stable, unique keys. Rendering a Reflection-shaped body
  // with several of every node kind side by side is what would surface a
  // collision, since renderNodes assembles keys from a shared prefix.
  it("keys every node stably enough that React raises no console warning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <Harness
        body="**a** *b* `c` [[2026-08-28]] and **d *e* f** plus a second [[2026-08-29]] and one more **g**"
        query="a"
        refs={{
          date: (node, key) => <span key={key}>{node.raw}</span>,
        }}
      />,
    );

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
