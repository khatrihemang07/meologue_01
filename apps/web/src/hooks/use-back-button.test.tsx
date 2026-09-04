import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBackButton } from "./use-back-button";

let capturedCanGoBack: (() => boolean) | undefined;
const unsubscribeMock = vi.fn();
const subscribeToBackButtonMock = vi.fn((canGoBack: () => boolean) => {
  capturedCanGoBack = canGoBack;
  return unsubscribeMock;
});

vi.mock("@/platform/back-button", () => ({
  subscribeToBackButton: (canGoBack: () => boolean) => subscribeToBackButtonMock(canGoBack),
}));

// A router is required — see use-back-button.ts's own header comment on why
// it needs `useLocation`/`useNavigationType` — and these three buttons
// exercise the three navigation actions its depth counter has to tell apart
// (`navigate(-1)` is how a browser/Android Back itself surfaces as a `POP`,
// the same as `window.history.back()` in back-button.android.ts).
function Harness() {
  const navigate = useNavigate();
  useBackButton();
  return (
    <div>
      <button type="button" onClick={() => navigate("/a")}>
        push
      </button>
      <button type="button" onClick={() => navigate("/b", { replace: true })}>
        replace
      </button>
      <button type="button" onClick={() => navigate(-1)}>
        pop
      </button>
    </div>
  );
}

function renderHarness() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Harness />
    </MemoryRouter>,
  );
}

describe("useBackButton", () => {
  beforeEach(() => {
    capturedCanGoBack = undefined;
    subscribeToBackButtonMock.mockClear();
    unsubscribeMock.mockClear();
  });

  it("subscribes once on mount and reports no history depth at the initial render", () => {
    renderHarness();

    expect(subscribeToBackButtonMock).toHaveBeenCalledOnce();
    expect(capturedCanGoBack?.()).toBe(false);
  });

  it("reports depth after a push, and none again once popped back", () => {
    renderHarness();

    fireEvent.click(screen.getByText("push"));
    expect(capturedCanGoBack?.()).toBe(true);

    fireEvent.click(screen.getByText("pop"));
    expect(capturedCanGoBack?.()).toBe(false);
  });

  it("leaves depth unchanged across a replace, matching that it adds no history entry", () => {
    renderHarness();

    fireEvent.click(screen.getByText("push"));
    expect(capturedCanGoBack?.()).toBe(true);

    fireEvent.click(screen.getByText("replace"));
    expect(capturedCanGoBack?.()).toBe(true);
  });

  it("tracks more than one level of depth", () => {
    renderHarness();

    fireEvent.click(screen.getByText("push"));
    fireEvent.click(screen.getByText("push"));
    expect(capturedCanGoBack?.()).toBe(true);

    fireEvent.click(screen.getByText("pop"));
    expect(capturedCanGoBack?.()).toBe(true);

    fireEvent.click(screen.getByText("pop"));
    expect(capturedCanGoBack?.()).toBe(false);
  });

  it("passes a live function, not a value captured once at mount", () => {
    renderHarness();
    const canGoBack = capturedCanGoBack;

    expect(canGoBack?.()).toBe(false);
    fireEvent.click(screen.getByText("push"));
    expect(canGoBack?.()).toBe(true);
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHarness();

    unmount();

    expect(unsubscribeMock).toHaveBeenCalledOnce();
  });
});
