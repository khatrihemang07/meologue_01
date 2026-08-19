import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { ReflectionPage } from "./reflection-page";

// No EntryStoreLayout stand-in needed here (contrast composer-page.test.tsx
// and history-page.test.tsx): ticket 2 gives ReflectionPage nothing to read
// from the Entry store yet, only useSyncEnabled() — MemoryRouter alone is
// enough to satisfy Nav's NavLinks, SettingsLink, and the Sync-off hint's
// Link to Settings.
function renderReflectionPage(initialPath = "/reflect") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/reflect" element={<ReflectionPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ReflectionPage", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
  });

  it("renders persistent nav links to Composer, History and Reflect, plus a Settings action", () => {
    renderReflectionPage();

    expect(screen.getByRole("link", { name: "Composer" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute("href", "/history");
    expect(screen.getByRole("link", { name: "Reflect" })).toHaveAttribute("href", "/reflect");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  // Ticket 54's acceptance criteria, extended to the third destination:
  // the current destination is visibly indicated.
  it("marks Reflect as the current destination in the persistent nav", () => {
    renderReflectionPage();

    expect(screen.getByRole("link", { name: "Reflect" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Composer" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "History" })).not.toHaveAttribute("aria-current");
  });

  it("shows a hint that Reflection needs a Server URL when Sync is off", () => {
    renderReflectionPage();

    expect(screen.getByText(/sync is off/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add a server url/i })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.queryByText(/ask a question about your history/i)).not.toBeInTheDocument();
  });

  it("shows an empty-Conversation invitation once Sync is on", () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");

    renderReflectionPage();

    expect(screen.queryByText(/sync is off/i)).not.toBeInTheDocument();
    expect(screen.getByText(/ask a question about your history/i)).toBeInTheDocument();
  });
});
