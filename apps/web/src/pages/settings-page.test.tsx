import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readServerUrl, readTheme } from "@/lib/settings";
import { SettingsPage } from "./settings-page";

function renderPage() {
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("renders its title and a back link to the history page", () => {
    renderPage();

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back/i })).toHaveAttribute("href", "/");
  });

  it("marks System as the initially selected theme", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "false");
  });

  it("applies and persists a theme immediately on click, with no save step", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(readTheme()).toBe("dark");
  });

  it("initialises the Server URL field from storage", () => {
    localStorage.setItem("meologue.server-url", "https://phone.example:41207");

    renderPage();

    expect(screen.getByLabelText(/server url/i)).toHaveValue("https://phone.example:41207");
  });

  it("does not persist the Server URL until Save is clicked", () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "https://phone.example:41207" },
    });

    expect(readServerUrl()).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(readServerUrl()).toBe("https://phone.example:41207");
  });
});
