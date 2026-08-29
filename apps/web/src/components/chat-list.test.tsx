import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { ChatList } from "./chat-list";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ChatList />
    </MemoryRouter>,
  );
}

describe("ChatList", () => {
  // Inherited from the retired `nav.test.tsx`: the count is the assertion,
  // not the membership. ADR 0018 bounded it to Material 3's three-to-five
  // and every ADR since has kept it there — including ADR 0036, which
  // declined to add a fifth row for Reflect's Sessions.
  it("offers exactly four destinations", () => {
    renderAt("/");

    expect(within(screen.getByRole("navigation")).getAllByRole("link")).toHaveLength(4);
  });

  it("gives every row a real href rather than a placeholder", () => {
    renderAt("/");

    expect(screen.getByRole("link", { name: /Composer/ })).toHaveAttribute("href", "/composer");
    expect(screen.getByRole("link", { name: /Reflect/ })).toHaveAttribute("href", "/reflect");
    expect(screen.getByRole("link", { name: /Digest/ })).toHaveAttribute("href", "/digest");
    expect(screen.getByRole("link", { name: /Settings/ })).toHaveAttribute("href", "/settings");
  });

  // What ADR 0036 owes the accessibility tree in place of the persistent
  // `<nav>` it retired: a real href (above) and a current marker (here).
  it("marks the open destination, and only that one, as current", () => {
    renderAt("/digest");

    expect(screen.getByRole("link", { name: /Digest/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Composer/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /Reflect/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /Settings/ })).not.toHaveAttribute("aria-current");
  });

  // `/digest/:period/:date` is still the Digest destination, which is why
  // only Composer carries `end`. A reader deep in a Digest should not see
  // the list claim nothing is open.
  it("keeps a destination marked current from a route nested under it", () => {
    renderAt("/digest/day/2026-08-27");

    expect(screen.getByRole("link", { name: /Digest/ })).toHaveAttribute("aria-current", "page");
  });

  // Composer is the one destination with `end`, so an unrelated route must
  // not light it up the way a prefix match would.
  it("does not mark Composer current from another destination", () => {
    renderAt("/settings");

    expect(screen.getByRole("link", { name: /Composer/ })).not.toHaveAttribute("aria-current");
  });

  // ADR 0008/0009: this pane has to keep rendering beside `/settings` when
  // the Entry store fails to open entirely, since Settings is where a bad
  // Server URL gets fixed. This test carries no EntryStoreOutletContext, no
  // QueryClientProvider and no mocked `entry-store-layout.tsx` at all — if
  // a future change ever made `ChatList` read the Entry store (directly or
  // via `useQuery(entryStoreQueryOptions)`), it would throw here instead of
  // silently reintroducing the very defect this component's own module doc
  // comment says it avoids.
  it("renders with no Entry-store read, even when nothing has provided one", () => {
    expect(() => renderAt("/")).not.toThrow();
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });

  it("scopes its landmark to the list rather than announcing app-wide navigation", () => {
    renderAt("/");

    expect(screen.getByRole("navigation")).toHaveAccessibleName("Chats");
  });

  // The ragged-right-edge defect: a row allowed to run full width while its
  // neighbours clip. Every summary gets the same treatment, Settings' too.
  it("truncates every row's summary, including the one with no timestamp", () => {
    renderAt("/");

    const summaries = screen
      .getAllByRole("link")
      .map((link) => link.querySelector("span > span:last-child"));
    expect(summaries).toHaveLength(4);
    for (const summary of summaries) {
      expect(summary).toHaveClass("truncate");
    }
  });

  // Issue #133: Destination rows derive their lock state from the
  // synchronous settings store — no Entry-store read, no network call — so
  // this exercises `useDestinations()` purely by seeding that store before
  // each render, the same way `useSyncEnabled`'s own callers are tested
  // elsewhere in this app.
  describe("locking", () => {
    beforeEach(() => {
      useSettingsStore.setState({ serverUrl: "", capabilities: null });
    });

    afterEach(() => {
      useSettingsStore.setState({ serverUrl: "", capabilities: null });
    });

    it("locks every Server-backed row when no Server URL is configured", () => {
      renderAt("/");

      expect(screen.getByRole("link", { name: /Reflect/ })).toHaveAttribute("data-locked", "true");
      expect(screen.getByRole("link", { name: /Digest/ })).toHaveAttribute("data-locked", "true");
      // Settings is how a locked row gets fixed — it must never lock itself.
      expect(screen.getByRole("link", { name: /Settings/ })).not.toHaveAttribute("data-locked");
    });

    // meologue is a local-first log: an Entry is captured, searched, edited
    // and Exported on the Device with no Server at all, and `composer-page`
    // keeps its thread and input working with Sync off. An unset Server URL
    // is also the default (ADR 0011), so locking this row would greet every
    // fresh install by calling its one working Destination unavailable.
    it("never locks Composer, which works with no Server at all", () => {
      renderAt("/");

      expect(screen.getByRole("link", { name: /Composer/ })).not.toHaveAttribute("data-locked");
    });

    it("still gives every locked row a real href — it stays a working link", () => {
      renderAt("/");

      const reflect = screen.getByRole("link", { name: /Reflect/ });
      expect(reflect).toHaveAttribute("data-locked", "true");
      expect(reflect).toHaveAttribute("href", "/reflect");
    });

    it("mutes a locked row without any destructive/error styling", () => {
      renderAt("/");

      const reflect = screen.getByRole("link", { name: /Reflect/ });
      expect(reflect).toHaveClass("text-muted-foreground");
      expect(reflect.className).not.toMatch(/destructive/);
    });

    it("unlocks every row once a Server URL is configured and capabilities are unknown", () => {
      // A fresh Server, or one this Device hasn't heard back from yet
      // (`capabilities: null`) — "unknown means unlocked."
      useSettingsStore.setState({ serverUrl: "https://server.example", capabilities: null });

      renderAt("/");

      for (const name of [/Composer/, /Reflect/, /Digest/, /Settings/]) {
        expect(screen.getByRole("link", { name })).not.toHaveAttribute("data-locked");
      }
    });

    it("locks only the Destination a configured Server reports it cannot serve", () => {
      useSettingsStore.setState({
        serverUrl: "https://server.example",
        capabilities: { reflect: true, digest: false, embeddings: true },
      });

      renderAt("/");

      expect(screen.getByRole("link", { name: /Composer/ })).not.toHaveAttribute("data-locked");
      expect(screen.getByRole("link", { name: /Reflect/ })).not.toHaveAttribute("data-locked");
      expect(screen.getByRole("link", { name: /Digest/ })).toHaveAttribute("data-locked", "true");
      expect(screen.getByRole("link", { name: /Settings/ })).not.toHaveAttribute("data-locked");
    });
  });
});
