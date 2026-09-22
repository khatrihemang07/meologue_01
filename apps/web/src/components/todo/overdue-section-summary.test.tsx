import type { Task } from "@meologue/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OverdueSectionSummary } from "./overdue-section-summary";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task",
    deviceId: "device-a",
    content: "content",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    date: "2026-09-20",
    deadline: null,
    priority: 1,
    labelIds: [],
    dateString: null,
    projectId: null,
    sectionId: null,
    parentId: null,
    description: null,
    ...overrides,
  };
}

// The `<summary>` this renders has to be sticky no matter which of
// TodayView's/UpcomingView's two `<details>` wraps it — a single shared
// implementation, this file's own header comment — which is why one test
// file here covers both call sites rather than a duplicated assertion in
// today-view.test.tsx and upcoming-view.test.tsx each.
describe("OverdueSectionSummary — issue #437's sticky Overdue header", () => {
  function renderSummary() {
    return render(
      <OverdueSectionSummary
        overdue={[task()]}
        onSetDate={vi.fn()}
        onSetDateString={vi.fn()}
        datesWithTasks={new Map()}
      />,
    );
  }

  it("is a sticky element, pinned to the scroll region's own top edge on a device with no top bar above it (touch-only)", () => {
    renderSummary();

    const summary = screen.getByText("Overdue").closest("summary") as HTMLElement;
    expect(summary).toHaveClass("sticky");
    expect(summary).toHaveClass("top-0");
  });

  // `pointer-fine:top-14` — task-row-content.tsx's own hover-gate reused,
  // this file's own header comment — is what moves the stuck offset down
  // to 56px (h-14) on a mouse device, clearing the scroll top bar Shell
  // renders above it (shell.tsx's own `TODO_TOPBAR_HEIGHT_PX` neighbour);
  // it is present in the markup unconditionally and resolved by the
  // device itself, the identical "can't observe real CSS in jsdom, only
  // that the class is wired" limit shell.test.tsx's own pointer-fine
  // assertion already accepts.
  it("shifts its own stuck offset to clear the top bar on a mouse device — pointer-fine:top-14", () => {
    renderSummary();

    const summary = screen.getByText("Overdue").closest("summary") as HTMLElement;
    expect(summary).toHaveClass("pointer-fine:top-14");
  });

  it("carries an opaque background so rows scrolling underneath never show through once stuck", () => {
    renderSummary();

    const summary = screen.getByText("Overdue").closest("summary") as HTMLElement;
    expect(summary).toHaveClass("bg-background");
  });

  it("stacks above the rows scrolling under it (a positive z-index)", () => {
    renderSummary();

    const summary = screen.getByText("Overdue").closest("summary") as HTMLElement;
    expect(summary).toHaveClass("z-10");
  });

  // Issue #437's own on-device Android follow-up: `top-0` alone stuck
  // this element's clickable content (the chevron, Reschedule) INSIDE the
  // status bar's own band on an edge-to-edge WebView — confirmed on the
  // real device to swallow every touch there, not even a `pointerdown`
  // reaching the page. `padding-top`, not `top`, is the fix — `top-0`
  // stays where `shell-scroll-region`'s own unpadded top edge really is
  // (this component's own header comment); only the CONTENT inside the
  // stuck box needs to move down, and `bg-background` still paints the
  // whole padded box so the status-bar band itself stays opaque.
  it("pads its own content below the safe-area inset by default (touch) — the same measured status-bar band shell.tsx's heading row already accounts for", () => {
    renderSummary();

    const summary = screen.getByText("Overdue").closest("summary") as HTMLElement;
    expect(summary).toHaveClass("[padding-top:max(0.5rem,env(safe-area-inset-top))]");
  });

  it("resets that padding back to the ordinary 0.5rem on a mouse device — pointer-fine:pt-2, no growth for an inset a mouse-primary device doesn't have", () => {
    renderSummary();

    const summary = screen.getByText("Overdue").closest("summary") as HTMLElement;
    expect(summary).toHaveClass("pointer-fine:pt-2");
  });

  // A standards-review flag: a bare `<summary>` keeps the UA stylesheet's
  // own `display: list-item`, which WebKit has a history of mishandling
  // under `position: sticky`. `flex` already overrides it (an author-
  // origin rule always outranks a user-agent one, regardless of selector
  // specificity — see this component's own comment) — this pins that the
  // class stays present so a future edit can't drop it while "simplifying"
  // and silently reintroduce `list-item` under `position: sticky`.
  it("carries an explicit display (flex), overriding the UA default list-item WebKit has had sticky bugs on", () => {
    renderSummary();

    const summary = screen.getByText("Overdue").closest("summary") as HTMLElement;
    expect(summary).toHaveClass("flex");
  });

  // Android (issue #437's own measurement): the Overdue header stays
  // sticky with no top bar above it to clear — `top-0` is the default this
  // component always carries; `pointer-fine:top-14` only ever overrides it
  // on a device the media query itself resolves as hover-or-fine-pointer.
  // No `touchOnlyDevice()` branch here either — shell.test.tsx's own
  // sibling test on the top bar makes the identical "one render, resolved
  // by CSS, no separate touch code path" point.
  it("keeps sticking at the scroll region's own top edge on touch-only — top-0 is the unconditional default, never overridden by a JS check", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: coarse)" || query === "(hover: none)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );

    renderSummary();

    const summary = screen.getByText("Overdue").closest("summary") as HTMLElement;
    expect(summary).toHaveClass("top-0");
    expect(summary).toHaveClass("sticky");
    expect(summary).toHaveClass("[padding-top:max(0.5rem,env(safe-area-inset-top))]");

    vi.unstubAllGlobals();
  });
});
