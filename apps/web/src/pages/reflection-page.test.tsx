import type { Entry } from "@meologue/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "@/lib/conversation";
import * as entryDayModule from "@/lib/entry-day";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { ReflectionPage } from "./reflection-page";

// Ticket 7's GroundingDisclosure is a descendant of every rendered turn and
// reads the Entry store via useEntryStore() (useOutletContext), so this
// page now needs the same EntryStoreLayout stand-in composer-page.test.tsx
// and history-page.test.tsx already use — a bare Outlet supplying a context
// of the test's choosing, in place of the real store-opening machinery.
// Defaults to no local Entries; individual tests override this to exercise
// GroundingDisclosure's lookup.
const defaultEntryStoreContext: EntryStoreOutletContext = {
  entries: [],
  sendEntry: vi.fn(),
  search: vi.fn(async () => []),
  disabled: false,
};

function renderReflectionPage(
  initialPath = "/reflect",
  context: EntryStoreOutletContext = defaultEntryStoreContext,
) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route path="/reflect" element={<ReflectionPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function askQuestionField() {
  return screen.getByPlaceholderText("Ask a Question about your History");
}

function askButton() {
  return screen.getByRole("button", { name: "Ask" });
}

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "hello",
    createdAt: "now",
    seq: 1,
    syncedAt: "now",
    ...overrides,
  };
}

function ask(question: string) {
  fireEvent.change(askQuestionField(), { target: { value: question } });
  fireEvent.click(askButton());
}

describe("ReflectionPage", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
    useConversationStore.setState({ turns: [] });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("shows a hint that Reflection needs a Server URL when Sync is off, with no Question field", () => {
    renderReflectionPage();

    expect(screen.getByText(/sync is off/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add a server url/i })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.queryByText(/ask a question about your history/i)).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Ask a Question about your History"),
    ).not.toBeInTheDocument();
  });

  it("shows an empty-Conversation invitation and a Question field once Sync is on", () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");

    renderReflectionPage();

    expect(screen.queryByText(/sync is off/i)).not.toBeInTheDocument();
    expect(screen.getByText(/ask a question about your history/i)).toBeInTheDocument();
    expect(askQuestionField()).toBeInTheDocument();
  });

  it("shows a staged in-flight indicator while a Question is being answered, then renders the Answer", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    let resolveFetch!: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchPromise),
    );

    renderReflectionPage();
    ask("How has my knee been?");

    expect(await screen.findByText("How has my knee been?")).toBeInTheDocument();
    expect(screen.getByText(/searching your entries/i)).toBeInTheDocument();
    // No turn is added to the Conversation until the Answer actually comes
    // back — an in-flight Question isn't a Conversation turn yet.
    expect(useConversationStore.getState().turns).toEqual([]);

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({
        answer: "It's improved since February.",
        grounding_entry_ids: ["entry-1"],
        grounded: true,
        fallback_used: false,
      }),
    });

    expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
    expect(screen.queryByText(/searching your entries/i)).not.toBeInTheDocument();
    expect(useConversationStore.getState().turns).toEqual([
      {
        question: "How has my knee been?",
        answer: "It's improved since February.",
        groundingEntryIds: ["entry-1"],
        grounded: true,
        fallbackUsed: false,
      },
    ]);
  });

  it("sends every prior turn on a follow-up Question", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({
        answer: "Yes, in March.",
        grounding_entry_ids: [],
        grounded: true,
        fallback_used: false,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    renderReflectionPage();

    ask("How has my knee been this year?");
    await screen.findByText("Yes, in March.");

    ask("Did it start with physical therapy?");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondRequestInit = fetchMock.mock.calls[1]?.[1];
    const secondRequestBody = JSON.parse(secondRequestInit?.body ?? "{}");
    expect(secondRequestBody.prior_turns).toEqual([
      { question: "How has my knee been this year?", answer: "Yes, in March." },
    ]);
    expect(secondRequestBody.question).toBe("Did it start with physical therapy?");
  });

  it("posts this Device's UTC offset alongside the Question, for the server's extraction call to resolve dates against (ADR 0023, ADR 0016's precedent)", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.spyOn(entryDayModule, "deviceUtcOffsetMinutes").mockReturnValue(330); // IST
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({
        answer: "It went well.",
        grounding_entry_ids: [],
        grounded: true,
        fallback_used: false,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    renderReflectionPage();
    ask("What did I write yesterday?");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const requestInit = fetchMock.mock.calls[0]?.[1];
    const requestBody = JSON.parse(requestInit?.body ?? "{}");
    expect(requestBody.utc_offset_minutes).toBe(330);
  });

  it("shows a distinct hint when the Server 404s (doesn't support Reflection yet)", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    renderReflectionPage();
    ask("Anything?");

    expect(await screen.findByText(/doesn't support reflection yet/i)).toBeInTheDocument();
    expect(useConversationStore.getState().turns).toEqual([]);
  });

  it("shows an error toast on a network failure, adding no turn", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const errorToast = vi.spyOn(toast, "error");

    renderReflectionPage();
    ask("Anything?");

    await waitFor(() => expect(errorToast).toHaveBeenCalled());
    expect(useConversationStore.getState().turns).toEqual([]);
  });

  // A Question is the user's own words and, unlike an Entry, was never
  // written down anywhere else — so a failure must not swallow it. Found on
  // a real device: the chat backend was down, the Question disappeared, and
  // all that was left was a toast that faded.
  it("puts a Question back in the composer when it fails, rather than losing it", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    vi.spyOn(toast, "error");

    renderReflectionPage();
    ask("How did the flat move go?");

    await waitFor(() => expect(askQuestionField()).toHaveValue("How did the flat move go?"));
  });

  it("restores a Question that fails twice in a row", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    vi.spyOn(toast, "error");

    renderReflectionPage();
    ask("Anything?");
    await waitFor(() => expect(askQuestionField()).toHaveValue("Anything?"));

    // Re-asking the identical text must restore it again — which is why the
    // restore is keyed on a changing signal and not on the text.
    fireEvent.click(askButton());
    await waitFor(() => expect(askQuestionField()).toHaveValue("Anything?"));
  });

  it("does not restore anything after a Question succeeds", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answer: "It went well.",
          grounding_entry_ids: [],
          grounded: true,
          fallback_used: false,
        }),
      })),
    );

    renderReflectionPage();
    ask("How did the flat move go?");

    expect(await screen.findByText("It went well.")).toBeInTheDocument();
    expect(askQuestionField()).toHaveValue("");
  });

  // Ticket 6 (ADR 0024): an explicit note per turn, independent of the
  // Answer's own wording, so the user can tell a real Answer from a
  // confident wrong one without trusting how the model phrased itself.
  it("shows no note when the server judged its Grounding grounded", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answer: "It's improved since February.",
          grounding_entry_ids: ["entry-1"],
          grounded: true,
          fallback_used: false,
        }),
      })),
    );

    renderReflectionPage();
    ask("How has my knee been?");

    expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
    expect(screen.queryByText(/nothing in your history matched/i)).not.toBeInTheDocument();
  });

  it("shows a fallback note when the server disclosed recent Entries instead of an Answer", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answer: "Nothing matched, but here's what you wrote lately.",
          grounding_entry_ids: ["entry-1"],
          grounded: false,
          fallback_used: true,
        }),
      })),
    );

    renderReflectionPage();
    ask("Anything about scuba diving?");

    expect(
      await screen.findByText("Nothing matched, but here's what you wrote lately."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /nothing in your history matched this question — this is what you wrote in the last few days/i,
      ),
    ).toBeInTheDocument();
  });

  it("shows an ungrounded note (no fallback) when nothing matched and nothing recent existed either", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answer: "I couldn't find anything about that.",
          grounding_entry_ids: [],
          grounded: false,
          fallback_used: false,
        }),
      })),
    );

    renderReflectionPage();
    ask("Anything about scuba diving?");

    expect(await screen.findByText("I couldn't find anything about that.")).toBeInTheDocument();
    const note = screen.getByText(/nothing in your history matched this question/i);
    expect(note).toBeInTheDocument();
    expect(note.textContent).not.toMatch(/last few days/i);
  });

  // Ticket 7: the disclosure beneath each turn is the only way to tell a
  // confident wrong Answer from a right one by eye — its label must carry
  // ADR 0024's grounded/fallback distinction, not just render *something*.
  it("shows a Grounding disclosure labelled 'Grounded' for a grounded turn", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answer: "It's improved since February.",
          grounding_entry_ids: ["entry-1"],
          grounded: true,
          fallback_used: false,
        }),
      })),
    );

    renderReflectionPage("/reflect", {
      ...defaultEntryStoreContext,
      entries: [entry({ id: "entry-1", body: "Knee felt better today" })],
    });
    ask("How has my knee been?");

    expect(await screen.findByText("It's improved since February.")).toBeInTheDocument();
    expect(screen.getByText("Grounded in 1 Entry")).toBeInTheDocument();
  });

  it("shows a Grounding disclosure labelled as recent Entries, not Grounding, for a fallback turn", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answer: "Nothing matched, but here's what you wrote lately.",
          grounding_entry_ids: ["entry-1"],
          grounded: false,
          fallback_used: true,
        }),
      })),
    );

    renderReflectionPage("/reflect", {
      ...defaultEntryStoreContext,
      entries: [entry({ id: "entry-1", body: "Just a regular Tuesday" })],
    });
    ask("Anything about scuba diving?");

    expect(
      await screen.findByText("Nothing matched, but here's what you wrote lately."),
    ).toBeInTheDocument();
    expect(screen.getByText("1 recent Entry")).toBeInTheDocument();
    expect(screen.queryByText(/^Grounded/)).not.toBeInTheDocument();
  });
});
