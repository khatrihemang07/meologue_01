import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./app-error-boundary";

function Bomb({ message }: { message: string }): never {
  throw new Error(message);
}

function Fine() {
  return <p>all good</p>;
}

describe("AppErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    render(
      <AppErrorBoundary>
        <Fine />
      </AppErrorBoundary>,
    );

    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  // Issue #177: before this component existed, an uncaught render/effect
  // error anywhere below `<App>` (main.tsx) unmounted the entire tree —
  // React 19's own behaviour with no error boundary in the way. This is
  // the one place that catches it and shows something readable instead.
  it("shows a readable surface, not a blank page, when a descendant throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <AppErrorBoundary>
        <Bomb message="node.type.spec.toDOM is not a function" />
      </AppErrorBoundary>,
    );

    expect(screen.queryByText("all good")).not.toBeInTheDocument();
    expect(screen.getByText("meologue hit an unexpected error.")).toBeInTheDocument();
    expect(screen.getByText("node.type.spec.toDOM is not a function")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("logs the real error to the console rather than swallowing it", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <AppErrorBoundary>
        <Bomb message="boom" />
      </AppErrorBoundary>,
    );

    expect(consoleError).toHaveBeenCalledWith(
      "meologue: uncaught render error",
      expect.any(Error),
      expect.anything(),
    );
  });

  it("reloads the page when Reload is clicked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });

    render(
      <AppErrorBoundary>
        <Bomb message="boom" />
      </AppErrorBoundary>,
    );
    screen.getByRole("button", { name: "Reload" }).click();

    expect(reload).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });
});
