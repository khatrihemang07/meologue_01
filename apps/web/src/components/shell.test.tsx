import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { useSyncStatusStore } from "@/lib/sync-status";
import { Shell } from "./shell";

// Ticket 40: the Sync status indicator is ambient — mounted once in Shell,
// which every page renders through — rather than wired into each page, so
// this exercises Shell directly instead of duplicating the same assertions
// across composer-page, history-page, and settings-page tests.
describe("Shell's Sync status indicator", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
    useSyncStatusStore.setState({ lastAttempt: null });
  });

  it("reads as off, a neutral state, with no Server URL configured", () => {
    render(<Shell title="Meologue">content</Shell>);

    expect(screen.getByRole("img", { name: "Sync is off" })).toBeInTheDocument();
  });

  it("reads as working once a Server URL is configured with no failure recorded", () => {
    useSettingsStore.setState({ serverUrl: "https://server.example" });

    render(<Shell title="Meologue">content</Shell>);

    expect(screen.getByRole("img", { name: "Sync is working" })).toBeInTheDocument();
  });

  it("reads as failing once an attempt against the configured Server URL has failed", () => {
    useSettingsStore.setState({ serverUrl: "https://server.example" });
    useSyncStatusStore.getState().recordFailure("https://server.example", "boom");

    render(<Shell title="Meologue">content</Shell>);

    expect(screen.getByRole("img", { name: "Sync is failing" })).toBeInTheDocument();
  });

  it("is visible on every page Shell renders, not only Settings", () => {
    useSettingsStore.setState({ serverUrl: "https://server.example" });
    useSyncStatusStore.getState().recordFailure("https://server.example", "boom");

    render(<Shell title="History">content</Shell>);

    expect(screen.getByRole("img", { name: "Sync is failing" })).toBeInTheDocument();
  });
});
