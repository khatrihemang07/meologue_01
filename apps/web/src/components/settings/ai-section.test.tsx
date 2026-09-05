import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { AiSection } from "./ai-section";

function modelsResponse(models: { id: string; streaming: boolean; context_window: number }[]) {
  return { ok: true, status: 200, json: async () => ({ models }) };
}

function renderAiSection() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <AiSection />
    </QueryClientProvider>,
  );
}

describe("AiSection", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ hiddenDestinations: new Set(), defaultReflectModel: "" });
    // A quiet default so a test that doesn't care about the model picker
    // doesn't make a real network call.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modelsResponse([])),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Issue #134. Moved from settings-page.test.tsx (issue #202) — unchanged,
  // beyond the rename from a raw `role="switch"` copy check ("Hidden"/
  // "Visible") that `DestinationVisibilityRow` used to own directly to the
  // identical copy `SwitchRow` now produces from its own `onLabel`/
  // `offLabel` props.
  describe("chat list visibility", () => {
    it("lists Composer, Reflect, Digest and Todo, each with a visibility control, and offers none for Settings", () => {
      renderAiSection();

      expect(screen.getByRole("switch", { name: /Composer/ })).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: /Reflect/ })).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: /Digest/ })).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: /Todo/ })).toBeInTheDocument();
      expect(screen.queryByRole("switch", { name: /Settings/ })).not.toBeInTheDocument();
    });

    it("starts every Destination visible when nothing is hidden", () => {
      renderAiSection();

      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    it("hides a Destination on click, and persists it", () => {
      renderAiSection();

      fireEvent.click(screen.getByRole("switch", { name: /Digest/ }));

      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      expect(useSettingsStore.getState().hiddenDestinations).toEqual(new Set(["digest"]));
      expect(localStorage.getItem("meologue.hidden-destinations")).toBe("digest");
    });

    it("shows a hidden Destination again on a second click", () => {
      useSettingsStore.setState({ hiddenDestinations: new Set(["digest"]) });
      renderAiSection();

      fireEvent.click(screen.getByRole("switch", { name: /Digest/ }));

      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(useSettingsStore.getState().hiddenDestinations).toEqual(new Set());
    });

    it("toggles each Destination independently", () => {
      renderAiSection();

      fireEvent.click(screen.getByRole("switch", { name: /Reflect/ }));

      expect(useSettingsStore.getState().hiddenDestinations).toEqual(new Set(["reflect"]));
      expect(screen.getByRole("switch", { name: /Composer/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    // Every control on this page must clear ADR 0036's 44px minimum touch
    // target — the switch is a `Button` at `size="touch"` (`h-11`, 44px)
    // for exactly that reason; this asserts the class rather than a
    // measured pixel height, the same way this repo already tests Server
    // URL's `Save` button (`className="h-11"` on its `Input` sibling).
    it("gives each visibility switch the 44px touch target every other control here has", () => {
      renderAiSection();

      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveClass("h-11");
    });

    // The hint must say plainly that hiding affects only the row — not
    // Entries, Grounding, Digests, Export or Sync (issue #134's own
    // acceptance criterion).
    it("states in the hint that hiding affects the row only, not Entries, Grounding, Digests, Export or Sync", () => {
      renderAiSection();

      const hint = screen.getByText(/Hides the row only/);
      expect(hint).toHaveTextContent(/Grounding/);
      expect(hint).toHaveTextContent(/summarised into Digests/);
      expect(hint).toHaveTextContent(/Export/);
      expect(hint).toHaveTextContent(/Sync/);
    });
  });

  // Issue #202.
  describe("default Reflect model", () => {
    it("renders a disabled note instead of a picker when the Server offers no models", async () => {
      renderAiSection();

      expect(await screen.findByText(/No models available/i)).toBeInTheDocument();
      expect(screen.queryByLabelText("Default Reflect model")).not.toBeInTheDocument();
    });

    it("offers Server default plus every model the Server returns, once it answers", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          modelsResponse([
            { id: "codex-terra", streaming: false, context_window: 272000 },
            { id: "claude-sonnet", streaming: true, context_window: 200000 },
          ]),
        ),
      );

      renderAiSection();

      const picker = await screen.findByLabelText("Default Reflect model");
      const options = Array.from(picker.querySelectorAll("option")).map(
        (option) => option.textContent,
      );
      expect(options).toEqual(["Server default", "codex-terra", "claude-sonnet"]);
    });

    it("pre-fills the picker from an already-stored Device default", async () => {
      useSettingsStore.setState({ defaultReflectModel: "claude-sonnet" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          modelsResponse([{ id: "claude-sonnet", streaming: true, context_window: 200000 }]),
        ),
      );

      renderAiSection();

      expect(await screen.findByLabelText("Default Reflect model")).toHaveValue("claude-sonnet");
    });

    it("persists a chosen model as the Device default", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          modelsResponse([{ id: "claude-sonnet", streaming: true, context_window: 200000 }]),
        ),
      );
      renderAiSection();
      const picker = await screen.findByLabelText("Default Reflect model");

      fireEvent.change(picker, { target: { value: "claude-sonnet" } });

      expect(useSettingsStore.getState().defaultReflectModel).toBe("claude-sonnet");
      expect(localStorage.getItem("meologue.default-reflect-model")).toBe("claude-sonnet");
    });

    it("clears the stored Device default when set back to Server default", async () => {
      useSettingsStore.setState({ defaultReflectModel: "claude-sonnet" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          modelsResponse([{ id: "claude-sonnet", streaming: true, context_window: 200000 }]),
        ),
      );
      renderAiSection();
      const picker = await screen.findByLabelText("Default Reflect model");

      fireEvent.change(picker, { target: { value: "" } });

      expect(useSettingsStore.getState().defaultReflectModel).toBe("");
      expect(localStorage.getItem("meologue.default-reflect-model")).toBeNull();
    });
  });
});
