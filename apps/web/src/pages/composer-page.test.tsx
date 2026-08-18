import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
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
  search: vi.fn(async () => []),
  disabled: false,
};

describe("ComposerPage", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders persistent nav links to Composer and History, plus a Settings action", () => {
    renderComposerPage(readyContext);

    expect(screen.getByRole("link", { name: "Composer" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute("href", "/history");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  // Ticket 54's acceptance criteria: the current destination is visibly
  // indicated. Composer is "/", the page under test, so its nav link
  // carries aria-current="page" and History's doesn't.
  it("marks Composer as the current destination in the persistent nav", () => {
    renderComposerPage(readyContext);

    expect(screen.getByRole("link", { name: "Composer" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "History" })).not.toHaveAttribute("aria-current");
  });

  it("disables the Composer while the store isn't ready", () => {
    renderComposerPage({
      entries: [],
      sendEntry: vi.fn(),
      search: vi.fn(async () => []),
      disabled: true,
    });

    expect(screen.getByPlaceholderText("What's on your mind?")).toBeDisabled();
  });

  it("shows the store's error message", () => {
    renderComposerPage({
      entries: [],
      sendEntry: vi.fn(),
      search: vi.fn(async () => []),
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
      search: vi.fn(async () => []),
      disabled: false,
    });

    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("shows a hint that Sync is off when no Server URL is set", () => {
    renderComposerPage(readyContext);

    expect(screen.getByText(/sync is off/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add a server url/i })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("hides the hint once a Server URL is set", () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");

    renderComposerPage(readyContext);

    expect(screen.queryByText(/sync is off/i)).not.toBeInTheDocument();
  });
});
