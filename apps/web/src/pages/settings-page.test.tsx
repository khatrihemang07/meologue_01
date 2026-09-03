import type { Entry, EntryStore, Project, ProjectStore, Task, TaskStore } from "@meologue/core";
import { PROTOCOL_VERSION } from "@meologue/core";
import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
import { DEFAULT_COMPLETED_STYLE, useSettingsStore } from "@/lib/settings";
import { useSyncStatusStore } from "@/lib/sync-status";
import type { SaveFileOutcome } from "@/platform/save-file";
import { SettingsPage } from "./settings-page";

const { openEntryStoreMock, saveFileMock } = vi.hoisted(() => ({
  openEntryStoreMock: vi.fn(),
  // Resolves "saved" by default (ticket 47's defect fix — see
  // save-file.web.ts's SaveFileOutcome doc comment and docs/adr/0016); the
  // "Export" describe block below overrides this per test to also cover
  // "cancelled".
  saveFileMock: vi.fn(
    async (_fileName: string, _bytes: Uint8Array): Promise<SaveFileOutcome> => "saved",
  ),
}));

// A stand-in for entry-store-layout.tsx's real entryStoreQueryOptions (which
// needs a real SqliteDriver to run migrations against), same shape as
// use-sync-loop.test.tsx's — Settings subscribes to the same query key
// directly (ADR 0008/0009: it's a sibling route with no outlet context).
vi.mock("@/pages/entry-store-layout", () => ({
  entryStoreQueryOptions: queryOptions({
    queryKey: ENTRY_STORE_QUERY_KEY,
    queryFn: openEntryStoreMock,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    retryOnMount: false,
  }),
}));

vi.mock("@/platform/save-file", () => ({ saveFile: saveFileMock }));

function createFakeStore(entries: Entry[] = []): EntryStore {
  return {
    list: vi.fn(async () => entries),
    upsert: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    getMany: vi.fn(async () => []),
  };
}

// A minimal TaskStore double — issue #175's Export now reads Tasks
// alongside Entries. Every method beyond list()/listCompleted() is a
// trivial stub: no test in this file exercises Todo's own mutation paths
// (those live in use-tasks.test.tsx and todo-page.test.tsx), so each just
// has to satisfy the interface, the same reasoning use-tasks.test.tsx's
// own createFakeStore gives for its untouched methods.
function createFakeTaskStore(active: Task[] = [], completed: Task[] = []): TaskStore {
  return {
    list: vi.fn(async () => active),
    listByProject: vi.fn(async () => []),
    listChildren: vi.fn(async () => []),
    listInSection: vi.fn(async () => []),
    listDescendants: vi.fn(async () => []),
    listCompleted: vi.fn(async () => completed),
    get: vi.fn(async () => undefined),
    upsert: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    uncomplete: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    reorder: vi.fn(async () => {}),
    setDate: vi.fn(async () => {}),
    setDeadline: vi.fn(async () => {}),
    setPriority: vi.fn(async () => {}),
    setLabelIds: vi.fn(async () => {}),
    setProject: vi.fn(async () => {}),
    setSection: vi.fn(async () => {}),
    setParent: vi.fn(async () => {}),
    setDescription: vi.fn(async () => {}),
    advanceRecurring: vi.fn(async () => {}),
    completeForever: vi.fn(async () => {}),
    postpone: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    search: vi.fn(async () => []),
  };
}

// A minimal ProjectStore double, mirroring createFakeTaskStore's own
// reasoning above — only listProjects() is ever read by handleExport.
function createFakeProjectStore(projects: Project[] = []): ProjectStore {
  return {
    listProjects: vi.fn(async () => projects),
    getProject: vi.fn(async () => undefined),
    upsertProjects: vi.fn(async () => {}),
    renameProject: vi.fn(async () => {}),
    setProjectColour: vi.fn(async () => {}),
    setProjectDescription: vi.fn(async () => {}),
    setProjectFavourite: vi.fn(async () => {}),
    archiveProject: vi.fn(async () => {}),
    unarchiveProject: vi.fn(async () => {}),
    setProjectParent: vi.fn(async () => {}),
    reorderProject: vi.fn(async () => {}),
    removeProject: vi.fn(async () => {}),
    pendingProjects: vi.fn(async () => []),
    getProjectCursor: vi.fn(async () => 0),
    setProjectCursor: vi.fn(async () => {}),
    listSections: vi.fn(async () => []),
    getSection: vi.fn(async () => undefined),
    addSection: vi.fn(async () => {}),
    renameSection: vi.fn(async () => {}),
    setSectionDescription: vi.fn(async () => {}),
    reorderSection: vi.fn(async () => {}),
    deleteSection: vi.fn(async () => {}),
    archiveSection: vi.fn(async () => {}),
    unarchiveSection: vi.fn(async () => {}),
    pendingSections: vi.fn(async () => []),
    getSectionCursor: vi.fn(async () => 0),
    setSectionCursor: vi.fn(async () => {}),
  };
}

// The `/` route renders a probe element rather than the real ComposerPage:
// nothing in this file needs to re-render everything that page depends on
// (its own store, context, etc.) to prove a Nav link's href is correct.
function renderPage() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/" element={<div>Composer probe</div>} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function healthResponse(protocolVersion: number, capabilities?: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      service: "meologue-server",
      protocol_version: protocolVersion,
      ...(capabilities !== undefined ? { capabilities } : {}),
    }),
  };
}

function errorResponse(status: number) {
  return { ok: false, status, json: async () => ({}) };
}

describe("SettingsPage", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      theme: "system",
      serverUrl: "",
      hiddenDestinations: new Set(),
      completedStyle: DEFAULT_COMPLETED_STYLE,
    });
    useSyncStatusStore.setState({ lastAttempt: null });
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.completedStyle;
    // A quiet default so tests that don't care about the server check don't
    // make a real network call — Settings checks on every mount now.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse(PROTOCOL_VERSION)),
    );
    // Never resolves by default — tests unrelated to Export don't care
    // whether the store is open, and this keeps the button reliably
    // disabled rather than racing a real resolution.
    openEntryStoreMock.mockReset();
    openEntryStoreMock.mockReturnValue(new Promise(() => {}));
    saveFileMock.mockReset();
    saveFileMock.mockResolvedValue("saved");
  });

  afterEach(() => {
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.completedStyle;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Issue #75: Settings is now one of the four Nav destinations itself
  // (Composer, Reflect, Digest, Settings — no History), so this asserts the
  // whole set rather than just the other three the way it did while
  // Settings was reached through a separate app-bar gear.
  it("renders its title in the app bar", () => {
    renderPage();

    // Still scoped to the app bar (role "banner") even though ADR 0036 took
    // the persistent nav's own "Settings" link away: this page's body has
    // headings of its own, and an unscoped match would stop distinguishing
    // the title from them.
    expect(
      within(screen.getByRole("banner")).getByText("Settings", { exact: true }),
    ).toBeInTheDocument();
  });

  // ADR 0036: a destination is pushed over the root screen, so what proves
  // a reader is not stranded is a Back control, not a nav link that was
  // always on screen. Settings keeps this despite ADR 0018 once arguing an
  // always-reachable destination needs no Back — it is no longer always
  // reachable, which was that argument's whole premise.
  it("offers a Back control out to the root screen", () => {
    renderPage();

    expect(screen.getByRole("link", { name: "Back to chats" })).toHaveAttribute("href", "/");
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
    expect(useSettingsStore.getState().theme).toBe("dark");
  });

  // Issue #163.
  describe("completed checklist item style", () => {
    it("marks grayed out (the default) as initially selected", () => {
      renderPage();

      expect(screen.getByRole("button", { name: "Grayed out" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Grayed out and strikethrough" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    it("applies and persists a choice immediately on click, with no save step", () => {
      renderPage();

      fireEvent.click(screen.getByRole("button", { name: "Strikethrough" }));

      expect(screen.getByRole("button", { name: "Strikethrough" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      // "Applies" here is the same one-attribute write `applyAccent`/
      // `applyTextSize` make — see `lib/theme.ts`'s `applyCompletedStyle`.
      expect(document.documentElement.dataset.completedStyle).toBe("strike");
      expect(useSettingsStore.getState().completedStyle).toBe("strike");
      expect(localStorage.getItem("meologue.completed-style")).toBe("strike");
    });

    // Issue #163's own acceptance criterion: four stacked rows, each
    // showing a real sample in ITS OWN style rather than describing it in
    // words. The sample carries `data-completed-style` scoped to a small
    // wrapper (not <html>), which is what lets a row demonstrate an option
    // that isn't the one currently selected — see `CompletedStyleRow`'s own
    // doc comment (settings-page.tsx) for why that wrapper, rather than a
    // second copy of the colour/decoration mapping, is what makes that
    // work.
    it("renders four rows, each with a real sample wearing its own style attribute, hidden from assistive tech", () => {
      renderPage();

      const rows: [string, string][] = [
        ["Grayed out and strikethrough", "grayAndStrike"],
        ["Grayed out", "gray"],
        ["Strikethrough", "strike"],
        ["None", "none"],
      ];
      for (const [label, id] of rows) {
        const row = screen.getByRole("button", { name: label });
        const sample = row.querySelector(`[data-completed-style="${id}"]`);
        expect(sample).not.toBeNull();
        expect(sample).toHaveAttribute("aria-hidden", "true");
      }
    });

    // ADR 0008: a Device setting never rewrites an Entry. There's no
    // Entry-store write to assert didn't happen — `setCompletedStyle`
    // (settings.ts) only ever calls `localStorage.setItem` and the
    // store's own `set` — so this instead pins the touch target every
    // other choice on this page already gets (ADR 0036's 44px minimum),
    // which is the one behavioural requirement specific to this control
    // that isn't already covered by `settings.test.ts`/`theme.test.ts`.
    it("gives each row the 44px touch target every other control on this page has", () => {
      renderPage();

      for (const label of ["Grayed out and strikethrough", "Grayed out", "Strikethrough", "None"]) {
        expect(screen.getByRole("button", { name: label })).toHaveAttribute("data-size", "touch");
      }
    });
  });

  // Issue #134.
  describe("chat list visibility", () => {
    it("lists Composer, Reflect, Digest and Todo, each with a visibility control, and offers none for Settings", () => {
      renderPage();

      expect(screen.getByRole("switch", { name: /Composer/ })).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: /Reflect/ })).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: /Digest/ })).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: /Todo/ })).toBeInTheDocument();
      expect(screen.queryByRole("switch", { name: /Settings/ })).not.toBeInTheDocument();
    });

    it("starts every Destination visible when nothing is hidden", () => {
      renderPage();

      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    it("hides a Destination on click, and persists it", () => {
      renderPage();

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
      renderPage();

      fireEvent.click(screen.getByRole("switch", { name: /Digest/ }));

      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(useSettingsStore.getState().hiddenDestinations).toEqual(new Set());
    });

    it("toggles each Destination independently", () => {
      renderPage();

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
      renderPage();

      expect(screen.getByRole("switch", { name: /Digest/ })).toHaveClass("h-11");
    });

    // The hint must say plainly that hiding affects only the row — not
    // Entries, Grounding, Digests, Export or Sync (issue #134's own
    // acceptance criterion).
    it("states in the hint that hiding affects the row only, not Entries, Grounding, Digests, Export or Sync", () => {
      renderPage();

      const hint = screen.getByText(/Hides the row only/);
      expect(hint).toHaveTextContent(/Grounding/);
      expect(hint).toHaveTextContent(/summarised into Digests/);
      expect(hint).toHaveTextContent(/Export/);
      expect(hint).toHaveTextContent(/Sync/);
    });
  });

  it("initialises the Server URL field from the store", () => {
    useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });

    renderPage();

    expect(screen.getByLabelText(/server url/i)).toHaveValue("https://phone.example:41207");
  });

  it("does not persist the Server URL until Save is clicked", () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "https://phone.example:41207" },
    });

    expect(useSettingsStore.getState().serverUrl).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(useSettingsStore.getState().serverUrl).toBe("https://phone.example:41207");
  });

  it("shows the normalised value after saving", () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "  https://phone.example:41207/  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByLabelText(/server url/i)).toHaveValue("https://phone.example:41207");
  });

  it("saves the Server URL on plain Enter, with no chord needed (issue #76)", () => {
    renderPage();
    const input = screen.getByLabelText(/server url/i);

    fireEvent.change(input, { target: { value: "https://phone.example:41207" } });
    // A single-line input has no newline to protect the way a Composer's
    // textarea does, so plain Enter — not the Composer's Cmd/Ctrl chord —
    // is what saves here. Submitting a `<form>` on Enter in a text field is
    // a native browser default action, not something settings-page.tsx
    // wires up in JS, and jsdom doesn't simulate that default action for a
    // synthetic keydown — so this fires the `submit` event a real Enter
    // press causes the browser to dispatch, which is what settings-page.tsx
    // actually listens for.
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(useSettingsStore.getState().serverUrl).toBe("https://phone.example:41207");
  });

  it("keeps what the user typed when storage refuses the write", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    renderPage();

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "https://phone.example:41207" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Reading the stored value back instead of computing it would blank the
    // field here, telling the user the save took when nothing was written.
    expect(screen.getByLabelText(/server url/i)).toHaveValue("https://phone.example:41207");
  });

  describe("smart date recognition", () => {
    it("is on by default", () => {
      renderPage();

      expect(screen.getByRole("switch", { name: "Smart date recognition" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    it("turns off on click, and persists it", () => {
      renderPage();

      fireEvent.click(screen.getByRole("switch", { name: "Smart date recognition" }));

      expect(screen.getByRole("switch", { name: "Smart date recognition" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      expect(useSettingsStore.getState().smartDatesEnabled).toBe(false);
      expect(localStorage.getItem("meologue.smart-dates-enabled")).toBe("false");
    });

    it("turns on again on a second click", () => {
      useSettingsStore.setState({ smartDatesEnabled: false });
      renderPage();

      fireEvent.click(screen.getByRole("switch", { name: "Smart date recognition" }));

      expect(screen.getByRole("switch", { name: "Smart date recognition" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(useSettingsStore.getState().smartDatesEnabled).toBe(true);
    });
  });

  describe("server reachability", () => {
    it("reports no server configured on mount, and makes no request", async () => {
      const fetchMock = vi.fn(async () => healthResponse(PROTOCOL_VERSION));
      vi.stubGlobal("fetch", fetchMock);

      renderPage();

      const status = await screen.findByTestId("server-status");
      expect(status).toHaveTextContent(/no server/i);
      expect(fetchMock).not.toHaveBeenCalled();
      // Not configured is a deliberate, valid state (ADR 0011) — it reads
      // with the same muted tone as "reachable", not the red tone every
      // other failure reason gets.
      expect(status).not.toHaveClass("text-destructive");
    });

    it("reports no server configured when Save is clicked with an empty field, without a request", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const fetchMock = vi.fn(async () => healthResponse(PROTOCOL_VERSION));
      vi.stubGlobal("fetch", fetchMock);
      renderPage();
      await screen.findByTestId("server-status");
      fetchMock.mockClear();
      const errorToast = vi.spyOn(toast, "error");

      fireEvent.change(screen.getByLabelText(/server url/i), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(screen.getByTestId("server-status")).toHaveTextContent(/no server/i),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorToast).not.toHaveBeenCalled();
    });

    it("shows the saved server's status inline on open, with no toast", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const fetchMock = vi.fn(async () => healthResponse(PROTOCOL_VERSION));
      vi.stubGlobal("fetch", fetchMock);
      const successToast = vi.spyOn(toast, "success");
      const errorToast = vi.spyOn(toast, "error");

      renderPage();

      expect(await screen.findByTestId("server-status")).toHaveTextContent(/reachable/i);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://phone.example:41207/v1/health",
        expect.anything(),
      );
      expect(successToast).not.toHaveBeenCalled();
      expect(errorToast).not.toHaveBeenCalled();
    });

    // Issue #133: a bare "Reachable" was true and useless on a Server that
    // answers its health check but has no model behind either feature —
    // Settings now names the specific gap.
    it("names the missing Digest model on an otherwise-reachable server", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          healthResponse(PROTOCOL_VERSION, {
            reflect: true,
            digest: false,
            embeddings: true,
            todo: true,
          }),
        ),
      );

      renderPage();

      const status = await screen.findByTestId("server-status");
      expect(status).toHaveTextContent(/reachable/i);
      expect(status).toHaveTextContent(/no digest model configured/i);
      // Still a neutral, not an error, tone — a missing model is a
      // configuration fact, not a failure, the same reasoning
      // "not-configured" gets above.
      expect(status).not.toHaveClass("text-destructive");
    });

    it("keeps the bare reachable message when the server omits capabilities entirely", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => healthResponse(PROTOCOL_VERSION)),
      );

      renderPage();

      const status = await screen.findByTestId("server-status");
      expect(status).toHaveTextContent(/^Reachable — this server is up/i);
    });

    it("shows a toast reporting the result when Save is clicked", async () => {
      renderPage();
      // Let the mount check settle first, so the next fetch call can only
      // be the one Save triggers.
      await screen.findByTestId("server-status");

      const successToast = vi.spyOn(toast, "success");

      fireEvent.change(screen.getByLabelText(/server url/i), {
        target: { value: "https://phone.example:41207" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(successToast).toHaveBeenCalledWith(expect.stringMatching(/reachable/i)),
      );
    });

    it("reports an outcome other than ok as an error toast, with distinct copy", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => errorResponse(503)),
      );
      renderPage();
      const errorToast = vi.spyOn(toast, "error");

      fireEvent.change(screen.getByLabelText(/server url/i), {
        target: { value: "https://phone.example:41207" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/503/)));
    });

    it("clears the inline status when the field is edited, and returns it when reverted", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const fetchMock = vi.fn(async () => healthResponse(PROTOCOL_VERSION));
      vi.stubGlobal("fetch", fetchMock);

      renderPage();
      await screen.findByTestId("server-status");

      const input = screen.getByLabelText(/server url/i);

      fireEvent.change(input, { target: { value: "https://phone.example:41207x" } });
      expect(screen.queryByTestId("server-status")).not.toBeInTheDocument();

      fireEvent.change(input, { target: { value: "https://phone.example:41207" } });
      expect(screen.getByTestId("server-status")).toBeInTheDocument();

      // No re-check for the reverted edit — the status came back from the
      // URL/result pairing already held, not a second fetch.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reports a protocol mismatch distinctly from a reachable server", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => healthResponse(PROTOCOL_VERSION + 1)),
      );
      renderPage();

      const status = await screen.findByTestId("server-status");
      expect(status).toHaveTextContent(new RegExp(`v${PROTOCOL_VERSION + 1}`));
      expect(status).not.toHaveTextContent(/^Reachable/);
    });
  });

  // Ticket 40: distinct from the "server reachability" block above, which is
  // a one-off health probe — this is the reason an actual, ongoing Sync
  // attempt is failing, sourced from lib/sync-status.ts.
  describe("sync failure reason", () => {
    it("shows nothing when the last attempt against the saved Server URL succeeded", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore.getState().recordSuccess("https://phone.example:41207");

      renderPage();

      expect(screen.queryByTestId("sync-failure-reason")).not.toBeInTheDocument();
    });

    it("shows the recorded reason beside the Server URL when Sync is failing", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore
        .getState()
        .recordFailure("https://phone.example:41207", "sync request failed with status 500");

      renderPage();

      expect(screen.getByTestId("sync-failure-reason")).toHaveTextContent(
        "sync request failed with status 500",
      );
    });

    it("clears the failure reason the moment a later attempt succeeds, with no reload", async () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore.getState().recordFailure("https://phone.example:41207", "boom");
      renderPage();
      expect(screen.getByTestId("sync-failure-reason")).toBeInTheDocument();

      useSyncStatusStore.getState().recordSuccess("https://phone.example:41207");

      await waitFor(() =>
        expect(screen.queryByTestId("sync-failure-reason")).not.toBeInTheDocument(),
      );
    });

    it("hides the failure reason while the field is mid-edit, away from the saved value", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      useSyncStatusStore.getState().recordFailure("https://phone.example:41207", "boom");
      renderPage();
      expect(screen.getByTestId("sync-failure-reason")).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(/server url/i), {
        target: { value: "https://phone.example:41207/typing" },
      });

      expect(screen.queryByTestId("sync-failure-reason")).not.toBeInTheDocument();
    });

    it("fires no toast when a Sync attempt fails in the background", () => {
      useSettingsStore.setState({ serverUrl: "https://phone.example:41207" });
      const errorToast = vi.spyOn(toast, "error");

      renderPage();
      useSyncStatusStore.getState().recordFailure("https://phone.example:41207", "boom");

      expect(errorToast).not.toHaveBeenCalled();
    });
  });

  // Ticket 46: Settings has no outlet context (ADR 0008/0009), so it
  // subscribes to entryStoreQueryOptions directly, the same way
  // use-sync-loop.ts does.
  describe("Export", () => {
    it("is disabled while the store has not resolved", () => {
      renderPage();

      expect(screen.getByRole("button", { name: "Export as zip" })).toBeDisabled();
    });

    it("is enabled once the store resolves", async () => {
      openEntryStoreMock.mockResolvedValue({
        store: createFakeStore(),
        taskStore: createFakeTaskStore(),
        projectStore: createFakeProjectStore(),
        deviceId: "device-a",
      });

      renderPage();

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Export as zip" })).toBeEnabled(),
      );
    });

    it("reads every Entry, Task and Project, saves a zip, and shows a success toast", async () => {
      const entries: Entry[] = [
        {
          id: "e1",
          deviceId: "device-a",
          body: "went for a walk",
          createdAt: "2026-08-16T06:00:00.000Z",
          seq: 1,
          syncedAt: "2026-08-16T06:00:01.000Z",
          deletedAt: null,
        },
      ];
      const store = createFakeStore(entries);
      const taskStore = createFakeTaskStore();
      const projectStore = createFakeProjectStore();
      openEntryStoreMock.mockResolvedValue({
        store,
        taskStore,
        projectStore,
        deviceId: "device-a",
      });
      const successToast = vi.spyOn(toast, "success");

      renderPage();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Export as zip" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Export as zip" }));

      await waitFor(() => expect(saveFileMock).toHaveBeenCalledTimes(1));
      expect(store.list).toHaveBeenCalledTimes(1);
      // Issue #175: Export now reads every Task and Project alongside
      // every Entry — a backup that silently omitted Tasks would fail ADR
      // 0016's own "quietly omits things is worse than none" rule.
      expect(taskStore.list).toHaveBeenCalledTimes(1);
      expect(taskStore.listCompleted).toHaveBeenCalledTimes(1);
      expect(projectStore.listProjects).toHaveBeenCalledTimes(1);
      const call = saveFileMock.mock.calls[0];
      expect(call).toBeDefined();
      const [fileName, bytes] = call ?? ["", new Uint8Array()];
      expect(fileName).toMatch(/^meologue-export-\d{8}-\d{6}\.zip$/);
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(successToast).toHaveBeenCalledWith(expect.stringContaining(fileName));
    });

    // This is the case that actually pins ticket 47's defect shut: before
    // the fix, saveFile resolved without throwing on cancellation just like
    // it does on success, and handleExport had no way to tell the two
    // apart — so a cancelled save panel / share sheet raised the same
    // "Exported N Entries" success toast a real save would, claiming a
    // backup existed when nothing had been written anywhere.
    it("raises no toast at all — neither success nor error — when the user cancels the save", async () => {
      const store = createFakeStore([]);
      openEntryStoreMock.mockResolvedValue({
        store,
        taskStore: createFakeTaskStore(),
        projectStore: createFakeProjectStore(),
        deviceId: "device-a",
      });
      saveFileMock.mockResolvedValue("cancelled");
      const successToast = vi.spyOn(toast, "success");
      const errorToast = vi.spyOn(toast, "error");

      renderPage();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Export as zip" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Export as zip" }));

      await waitFor(() => expect(saveFileMock).toHaveBeenCalledTimes(1));
      expect(successToast).not.toHaveBeenCalled();
      expect(errorToast).not.toHaveBeenCalled();
    });

    it("shows an error toast carrying the real error when saving fails", async () => {
      const store = createFakeStore([]);
      openEntryStoreMock.mockResolvedValue({
        store,
        taskStore: createFakeTaskStore(),
        projectStore: createFakeProjectStore(),
        deviceId: "device-a",
      });
      saveFileMock.mockRejectedValue(new Error("Export isn't supported on Android yet."));
      const errorToast = vi.spyOn(toast, "error");

      renderPage();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Export as zip" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Export as zip" }));

      await waitFor(() =>
        expect(errorToast).toHaveBeenCalledWith("Export isn't supported on Android yet."),
      );
    });
  });
});
