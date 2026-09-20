import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { taskTitleText } from "./task-title-text";

/**
 * Issue #398: a saved title's `[text](url)` renders as a live link
 * wherever a title is read, not the raw bracket syntax. `taskTitleText`'s
 * own header comment has the full design reasoning (why `titleLinkSegments`
 * lives in its own module, why the no-link path still goes straight
 * through `inlineProse` unchanged, and the one known limitation around
 * formatting that spans a link boundary).
 */
describe("taskTitleText", () => {
  it("renders a title with no link exactly as inlineProse always has, markdown included", () => {
    render(<div data-testid="title">{taskTitleText("buy milk **now**")}</div>);

    const el = screen.getByTestId("title");
    expect(el).toHaveTextContent("buy milk now");
    expect(el.querySelector("strong")?.textContent).toBe("now");
  });

  it("renders [text](url) as a link reading the text, opening in a new tab", () => {
    render(
      <div data-testid="title">{taskTitleText("Read [my article](https://example.com/post)")}</div>,
    );

    const link = screen.getByRole("link", { name: "my article" });
    expect(link).toHaveAttribute("href", "https://example.com/post");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByTestId("title")).toHaveTextContent("Read my article");
  });

  it("clicking the link does not also fire a click on an ancestor (does not open/toggle the task)", () => {
    const onRowClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test-only stand-in for task-row-content.tsx's own real <button onClick={...}>.
      // biome-ignore lint/a11y/useKeyWithClickEvents: test-only stand-in, click is all this test exercises.
      <div onClick={onRowClick} data-testid="row">
        {taskTitleText("Read [my article](https://example.com/post)")}
      </div>,
    );

    fireEvent.click(screen.getByRole("link", { name: "my article" }));

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("clicking plain title text (no link) still reaches the ancestor normally", () => {
    const onRowClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test-only stand-in for task-row-content.tsx's own real <button onClick={...}>.
      // biome-ignore lint/a11y/useKeyWithClickEvents: test-only stand-in, click is all this test exercises.
      <div onClick={onRowClick} data-testid="row">
        {taskTitleText("buy milk")}
      </div>,
    );

    fireEvent.click(screen.getByTestId("row"));

    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it("a malformed or empty-part link renders as plain text, not broken", () => {
    render(
      <div data-testid="title">
        {taskTitleText("See [](https://example.com) and [Todoist]() and [unclosed (paren")}
      </div>,
    );

    const el = screen.getByTestId("title");
    expect(el).toHaveTextContent(
      "See [](https://example.com) and [Todoist]() and [unclosed (paren",
    );
    expect(el.querySelector("a")).toBeNull();
  });

  it("a link surrounded by other text still renders that text too, unbroken", () => {
    render(<div data-testid="title">{taskTitleText("Before [text](https://x.com) after")}</div>);

    const el = screen.getByTestId("title");
    expect(el).toHaveTextContent("Before text after");
    expect(screen.getByRole("link", { name: "text" })).toHaveAttribute("href", "https://x.com");
  });

  it("does not mutate or otherwise touch the title string itself — purely presentational", () => {
    const title = "Read [my article](https://example.com/post)";
    taskTitleText(title);
    expect(title).toBe("Read [my article](https://example.com/post)");
  });
});
