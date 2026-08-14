import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { ComposerPage } from "./composer-page";

// EntryStoreLayout is what normally supplies this context (it owns the
// store and useHistory); stubbing it with a bare Outlet lets these tests
// exercise ComposerPage in isolation with a context of their choosing,
// without touching the real store-opening machinery.
function renderComposerPage(context: EntryStoreOutletContext) {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route path="/" element={<ComposerPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const readyContext: EntryStoreOutletContext = {
  entries: [],
  sendEntry: vi.fn(),
  disabled: false,
};

describe("ComposerPage", () => {
  it("renders links to History and Settings", () => {
    renderComposerPage(readyContext);

    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute("href", "/history");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  it("disables the Composer while the store isn't ready", () => {
    renderComposerPage({ entries: [], sendEntry: vi.fn(), disabled: true });

    expect(screen.getByPlaceholderText("What's on your mind?")).toBeDisabled();
  });

  it("shows the store's error message", () => {
    renderComposerPage({
      entries: [],
      sendEntry: vi.fn(),
      disabled: true,
      message: "meologue couldn't open its storage. Reloading may help.",
    });

    expect(
      screen.getByText("meologue couldn't open its storage. Reloading may help."),
    ).toBeInTheDocument();
  });

  it("renders History from the outlet context", () => {
    renderComposerPage({
      entries: [
        { id: "1", deviceId: "device-a", body: "hello", createdAt: "now", seq: 1, syncedAt: "now" },
      ],
      sendEntry: vi.fn(),
      disabled: false,
    });

    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});
