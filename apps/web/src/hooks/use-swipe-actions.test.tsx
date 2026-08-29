import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mouseDragLeft, swipeDown, swipeLeft, tap } from "@/test/swipe";
import { SWIPE_TARGET_ATTRIBUTE, useSwipeActions } from "./use-swipe-actions";

/**
 * The DOM half of the gesture — which element gets picked up, what gets
 * written to its style, and when `onOpen` fires. The arithmetic half is
 * `lib/swipe-recognizer.test.ts`'s.
 */

function Thread({
  onOpen,
  enabled = true,
  labels = ["one", "two"],
}: {
  onOpen: (target: HTMLElement) => void;
  enabled?: boolean;
  labels?: string[];
}) {
  const ref = useSwipeActions({ onOpen, enabled });
  return (
    <div ref={ref}>
      {labels.map((label) => (
        <div key={label} {...{ [SWIPE_TARGET_ATTRIBUTE]: "" }} data-entry-id={label}>
          <span>{label}</span>
        </div>
      ))}
      <p>not swipeable</p>
    </div>
  );
}

/** The `[data-swipe-target]` ancestor of the text — what the hook picks up. */
function bubble(label: string): HTMLElement {
  const found = screen.getByText(label).closest<HTMLElement>(`[${SWIPE_TARGET_ATTRIBUTE}]`);
  if (!found) throw new Error(`no swipe target around "${label}"`);
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useSwipeActions", () => {
  it("opens for the swiped element, and hands back that element", () => {
    const onOpen = vi.fn();
    render(<Thread onOpen={onOpen} />);

    swipeLeft(screen.getByText("two"));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]?.[0]).toBe(bubble("two"));
  });

  it("picks up the swipe target even when the finger lands on something inside it", () => {
    // A finger lands on the Entry's own text, never on the bubble's padding —
    // so the target has to be found by walking up, not by hit-testing the
    // element the event was dispatched on.
    const onOpen = vi.fn();
    render(<Thread onOpen={onOpen} />);

    swipeLeft(screen.getByText("one"));

    expect(onOpen.mock.calls[0]?.[0]).toBe(bubble("one"));
  });

  it("moves the bubble under the finger and springs it back on release", () => {
    render(<Thread onOpen={vi.fn()} />);
    const target = bubble("one");
    expect(target.style.transform).toBe("");

    fireEvent.pointerDown(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 300,
      clientY: 100,
    });
    fireEvent.pointerMove(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 287,
      clientY: 100,
    });
    // Exactly zero at the moment of confirmation — travel is measured from
    // here, so the bubble does not pop by the recognition step's own 13px.
    expect(target.style.transform).toBe("translateX(0px)");

    fireEvent.pointerMove(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 257,
      clientY: 100,
    });
    expect(target.style.transform).toBe("translateX(-30px)");

    fireEvent.pointerUp(target, { pointerId: 1, pointerType: "touch", clientX: 257, clientY: 100 });
    expect(target.style.transform).toBe("translateX(0px)");
  });

  it("never writes anything to the bubble but a transform", () => {
    // The defect this ticket exists to avoid: the retired prototype narrowed
    // the bubble's max width by the revealed strip's width once latched,
    // which reflowed the text and turned a one-line Entry into two. A
    // transform cannot do that — it is a paint-time operation — and nothing
    // else may be written here.
    render(<Thread onOpen={vi.fn()} />);
    const target = bubble("one");

    fireEvent.pointerDown(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 300,
      clientY: 100,
    });
    fireEvent.pointerMove(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 287,
      clientY: 100,
    });
    fireEvent.pointerMove(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 240,
      clientY: 100,
    });

    const written = Array.from(target.style).sort();
    expect(written).toEqual(["transform", "transition"]);
  });

  it("does nothing at all for a tap", () => {
    const onOpen = vi.fn();
    render(<Thread onOpen={onOpen} />);

    tap(screen.getByText("one"));

    expect(onOpen).not.toHaveBeenCalled();
    expect(bubble("one").style.transform).toBe("");
  });

  it("does not open on a vertical drag, and leaves the bubble where it was", () => {
    const onOpen = vi.fn();
    render(<Thread onOpen={onOpen} />);

    swipeDown(screen.getByText("one"));

    expect(onOpen).not.toHaveBeenCalled();
    expect(bubble("one").style.transform).toBe("");
  });

  // "A short leftward drag does not open" is deliberately NOT tested here.
  // jsdom reads `timeStamp` off the real clock, so a 10px drag dispatched in
  // a single tick reads as either a flick (which correctly opens) or as
  // motionless, depending on which millisecond the events land in — the
  // assertion would be about the scheduler, not the code. That decision is
  // pinned at exact timestamps in `lib/swipe-recognizer.test.ts` instead.

  it("ignores a mouse entirely, so dragging to select still selects", () => {
    // Issue #78 restored drag-to-select by deleting the per-row
    // ContextMenu's `select-none`; a recogniser that confirmed on 12px of
    // leftward mouse travel would take it straight back. A mouse reaches
    // these actions through the hover buttons and right-click instead.
    const onOpen = vi.fn();
    render(<Thread onOpen={onOpen} />);

    mouseDragLeft(screen.getByText("one"));

    expect(onOpen).not.toHaveBeenCalled();
    expect(bubble("one").style.transform).toBe("");
  });

  it("ignores a swipe that starts outside any swipe target", () => {
    const onOpen = vi.fn();
    render(<Thread onOpen={onOpen} />);

    swipeLeft(screen.getByText("not swipeable"));

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("refuses to start while text is already selected", () => {
    // The tap that dismisses a selection, and the release at the end of a
    // drag-select, both land on a bubble — neither may also be a swipe.
    const onOpen = vi.fn();
    vi.stubGlobal("getSelection", () => ({ isCollapsed: false }));
    render(<Thread onOpen={onOpen} />);

    swipeLeft(screen.getByText("one"));

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("wires nothing when disabled", () => {
    // Mutation check: with `enabled` ignored, the swipe below opens.
    const onOpen = vi.fn();
    render(<Thread onOpen={onOpen} enabled={false} />);

    swipeLeft(screen.getByText("one"));

    expect(onOpen).not.toHaveBeenCalled();
    expect(bubble("one").style.transform).toBe("");
  });

  // THE BUG A REAL BROWSER FOUND AND JSDOM COULD NOT. History's very first
  // render, with the Entry store still opening, returns "History will appear
  // here." and no row container at all — so a hook keyed on a `RefObject`
  // read `.current` while it was still null, ran once, and never ran again.
  // Every gesture on the thread was silently dead. Every unit test in this
  // repo renders History with its Entries already in hand, which is exactly
  // why none of them saw it.
  it("wires a container that only mounts after the first render", () => {
    function LateThread({ onOpen }: { onOpen: (target: HTMLElement) => void }) {
      const ref = useSwipeActions({ onOpen });
      const [ready, setReady] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setReady(true)}>
            load
          </button>
          {ready ? (
            <div ref={ref}>
              <div {...{ [SWIPE_TARGET_ATTRIBUTE]: "" }} data-entry-id="late">
                <span>late</span>
              </div>
            </div>
          ) : (
            <p>History will appear here.</p>
          )}
        </>
      );
    }

    const onOpen = vi.fn();
    render(<LateThread onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "load" }));

    swipeLeft(screen.getByText("late"));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("stops and starts with `enabled` without ever remounting the container", () => {
    // `enabled` is read at the moment of a gesture rather than closed over
    // when the listeners go on, so a thread that loses its actions stops
    // responding without four listeners being torn down and put back.
    function ToggleThread({ onOpen }: { onOpen: (target: HTMLElement) => void }) {
      const [on, setOn] = useState(true);
      const ref = useSwipeActions({ onOpen, enabled: on });
      return (
        <>
          <button type="button" onClick={() => setOn((value) => !value)}>
            toggle
          </button>
          <div ref={ref}>
            <div {...{ [SWIPE_TARGET_ATTRIBUTE]: "" }} data-entry-id="one">
              <span>one</span>
            </div>
          </div>
        </>
      );
    }

    const onOpen = vi.fn();
    render(<ToggleThread onOpen={onOpen} />);
    const container = screen.getByText("one").parentElement?.parentElement;

    swipeLeft(screen.getByText("one"));
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    swipeLeft(screen.getByText("one"));
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    swipeLeft(screen.getByText("one"));
    expect(onOpen).toHaveBeenCalledTimes(2);
    // Same node throughout — the toggling never went through a remount.
    expect(screen.getByText("one").parentElement?.parentElement).toBe(container);
  });

  it("abandons the gesture when the platform cancels the pointer", () => {
    const onOpen = vi.fn();
    render(<Thread onOpen={onOpen} />);
    const target = bubble("one");

    fireEvent.pointerDown(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 300,
      clientY: 100,
    });
    fireEvent.pointerMove(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 287,
      clientY: 100,
    });
    fireEvent.pointerMove(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 200,
      clientY: 100,
    });
    fireEvent.pointerCancel(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 200,
      clientY: 100,
    });

    // Far enough to have opened had the finger simply lifted — a cancel is
    // the platform taking the gesture, not the reader completing it.
    expect(onOpen).not.toHaveBeenCalled();
    expect(target.style.transform).toBe("translateX(0px)");
  });

  it("leaves no transform behind on a bubble the thread unmounts mid-drag", () => {
    // A virtualised thread recycles rows constantly. One parked off-centre
    // would show up under whichever Entry landed in that node next.
    const { unmount } = render(<Thread onOpen={vi.fn()} />);
    const target = bubble("one");

    fireEvent.pointerDown(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 300,
      clientY: 100,
    });
    fireEvent.pointerMove(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 287,
      clientY: 100,
    });
    fireEvent.pointerMove(target, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 240,
      clientY: 100,
    });
    expect(target.style.transform).not.toBe("");

    unmount();

    expect(target.style.transform).toBe("");
    expect(target.style.transition).toBe("");
  });

  it("skips the spring-back animation when the reader asked for reduced motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("reduced-motion"), media: query })),
    );
    render(<Thread onOpen={vi.fn()} />);
    const target = bubble("one");

    swipeLeft(screen.getByText("one"));

    expect(target.style.transform).toBe("");
    expect(target.style.transition).toBe("");
  });
});
