import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackToChats } from "./back-to-chats";

// Mirrors todo-nav.test.tsx's own stand-in ("jsdom implements no matchMedia
// at all") — every test below that doesn't call this covers the narrow
// default use-wide-layout.ts already falls back to.
function installWideMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => ({
      matches: true,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
    writable: true,
  });
}

function removeMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BackToChats />
    </MemoryRouter>,
  );
}

afterEach(removeMatchMedia);

describe("BackToChats", () => {
  it("is a real link to the root screen, not a history pop — works on a cold load with no history entry", () => {
    renderAt("/composer");

    expect(screen.getByRole("link", { name: "Back to chats" })).toHaveAttribute("href", "/");
  });

  it("renders below the wide breakpoint on every destination", () => {
    renderAt("/composer");

    expect(screen.getByRole("link", { name: "Back to chats" })).toBeVisible();
  });

  // Composer, Reflection, Digest and Settings genuinely still show the chat
  // list pinned beside them at the wide breakpoint (ADR 0036) — unchanged
  // by issue #248.
  it.each(["/composer", "/reflect", "/digest", "/settings"])(
    "renders nothing at the wide breakpoint on %s",
    (path) => {
      installWideMatchMedia();

      renderAt(path);

      expect(screen.queryByRole("link", { name: "Back to chats" })).not.toBeInTheDocument();
    },
  );

  // Issue #248 / ADR 0076: Todo's own pane shows TodoSidebar instead of the
  // chat list at the wide breakpoint, and the sidebar carries no way out to
  // the other four Destinations — so Back has to keep rendering there,
  // unlike every other destination above.
  it.each(["/todo", "/todo/inbox", "/todo/today", "/todo/projects/some-id", "/todo/activity"])(
    "still renders at the wide breakpoint on Todo (%s)",
    (path) => {
      installWideMatchMedia();

      renderAt(path);

      expect(screen.getByRole("link", { name: "Back to chats" })).toHaveAttribute("href", "/");
    },
  );

  it("does not treat a route merely starting with /todo as Todo", () => {
    installWideMatchMedia();

    renderAt("/todoist");

    expect(screen.queryByRole("link", { name: "Back to chats" })).not.toBeInTheDocument();
  });
});
