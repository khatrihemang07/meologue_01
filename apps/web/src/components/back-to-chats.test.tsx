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
  //
  // Todo joins this list here — the owner overruled ADR 0076: the chat
  // list pane is always on screen at the wide breakpoint now, `/todo/*`
  // included (`TodoSidebar` mounts separately, as a second column inside
  // Todo's own subtree, `todo-page.tsx`), so the premise issue #248's own
  // carve-out existed for (the pane showed `TodoSidebar` instead, with no
  // way out to the other four Destinations) is gone. This replaces this
  // file's former "still renders at the wide breakpoint on Todo" — that
  // assertion was ADR 0076's decision and is now backwards, not merely
  // weakened.
  it.each([
    "/composer",
    "/reflect",
    "/digest",
    "/settings",
    "/todo",
    "/todo/inbox",
    "/todo/today",
    "/todo/projects/some-id",
    "/todo/activity",
  ])("renders nothing at the wide breakpoint on %s", (path) => {
    installWideMatchMedia();

    renderAt(path);

    expect(screen.queryByRole("link", { name: "Back to chats" })).not.toBeInTheDocument();
  });
});
