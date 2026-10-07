import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type BackButtonListener = () => void;

let backButtonListener: BackButtonListener | undefined;
const removeMock = vi.fn();
const addListenerMock = vi.fn((_eventName: string, listener: BackButtonListener) => {
  backButtonListener = listener;
  return Promise.resolve({ remove: removeMock });
});
const exitAppMock = vi.fn();

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: (eventName: string, listener: BackButtonListener) =>
      addListenerMock(eventName, listener),
    exitApp: () => exitAppMock(),
  },
}));

function historyBackSpy() {
  return vi.spyOn(window.history, "back").mockImplementation(() => {});
}

// Capacitor's own `canGoBack` field on the `backButton` event is
// deliberately never read (see back-button.android.ts's own header
// comment on why it's wrong for this app) — every test below drives the
// listener through the `canGoBack` function this module's own signature
// takes instead, standing in for use-back-button.ts's router-derived depth.

describe("back-button.android", () => {
  beforeEach(() => {
    vi.resetModules();
    backButtonListener = undefined;
    addListenerMock.mockClear();
    removeMock.mockClear();
    exitAppMock.mockClear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("registers a backButton listener on subscribe", async () => {
    const { subscribeToBackButton } = await import("./back-button.android");
    subscribeToBackButton(() => false);

    expect(addListenerMock).toHaveBeenCalledWith("backButton", expect.any(Function));
  });

  it("navigates back through history when there is somewhere to go and no dialog is open", async () => {
    const { subscribeToBackButton } = await import("./back-button.android");
    subscribeToBackButton(() => true);
    const back = historyBackSpy();

    backButtonListener?.();

    expect(back).toHaveBeenCalledOnce();
    expect(exitAppMock).not.toHaveBeenCalled();
  });

  it("exits the app when there is nowhere left to go back to (the root screen)", async () => {
    const { subscribeToBackButton } = await import("./back-button.android");
    subscribeToBackButton(() => false);
    const back = historyBackSpy();

    backButtonListener?.();

    expect(back).not.toHaveBeenCalled();
    expect(exitAppMock).toHaveBeenCalledOnce();
  });

  it("consults canGoBack fresh on every press rather than a value captured at subscribe time", async () => {
    const { subscribeToBackButton } = await import("./back-button.android");
    let canGoBack = false;
    subscribeToBackButton(() => canGoBack);
    const back = historyBackSpy();

    backButtonListener?.();
    expect(exitAppMock).toHaveBeenCalledOnce();
    expect(back).not.toHaveBeenCalled();

    canGoBack = true;
    backButtonListener?.();
    expect(back).toHaveBeenCalledOnce();
    expect(exitAppMock).toHaveBeenCalledOnce();
  });

  it("dismisses an open sheet (ui/sheet.tsx's own data-slot marker) instead of navigating", async () => {
    const { subscribeToBackButton } = await import("./back-button.android");
    subscribeToBackButton(() => true);
    const back = historyBackSpy();

    const sheet = document.createElement("div");
    sheet.setAttribute("data-slot", "sheet-content");
    sheet.setAttribute("data-state", "open");
    document.body.appendChild(sheet);
    // Radix's DismissableLayer (the mechanism every one of this app's
    // dialogs/sheets/menus actually closes through) listens for Escape on
    // `ownerDocument`, not on the layer's own node — see
    // back-button.android.ts's own header comment for why this file
    // dispatches there rather than on the overlay element directly.
    let escapeSeen = false;
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          escapeSeen = true;
          event.preventDefault();
        }
      },
      { once: true },
    );

    backButtonListener?.();

    expect(escapeSeen).toBe(true);
    expect(back).not.toHaveBeenCalled();
    expect(exitAppMock).not.toHaveBeenCalled();
  });

  it('dismisses an open confirm dialog (role="alertdialog") instead of navigating', async () => {
    const { subscribeToBackButton } = await import("./back-button.android");
    subscribeToBackButton(() => false);
    const back = historyBackSpy();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    let escapeSeen = false;
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          escapeSeen = true;
        }
      },
      { once: true },
    );

    backButtonListener?.();

    expect(escapeSeen).toBe(true);
    expect(back).not.toHaveBeenCalled();
    expect(exitAppMock).not.toHaveBeenCalled();
  });

  it('dismisses an open command menu (role="menu") instead of navigating', async () => {
    const { subscribeToBackButton } = await import("./back-button.android");
    subscribeToBackButton(() => true);
    const back = historyBackSpy();

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-state", "open");
    document.body.appendChild(menu);
    let escapeSeen = false;
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          escapeSeen = true;
        }
      },
      { once: true },
    );

    backButtonListener?.();

    expect(escapeSeen).toBe(true);
    expect(back).not.toHaveBeenCalled();
  });

  it("ignores a closed sheet left in the DOM mid-exit-animation and falls through to history", async () => {
    const { subscribeToBackButton } = await import("./back-button.android");
    subscribeToBackButton(() => true);
    const back = historyBackSpy();

    const sheet = document.createElement("div");
    sheet.setAttribute("data-slot", "sheet-content");
    sheet.setAttribute("data-state", "closed");
    document.body.appendChild(sheet);

    backButtonListener?.();

    expect(back).toHaveBeenCalledOnce();
  });

  it("does not mistake TaskDetailView's route-backed dialog (no data-slot, default role) for a dismissible overlay", async () => {
    const { subscribeToBackButton } = await import("./back-button.android");
    subscribeToBackButton(() => true);
    const back = historyBackSpy();

    // task-detail-view.tsx's own Dialog.Content: plain `role="dialog"`
    // (Radix's default), no `data-slot` at all.
    const routeBackedModal = document.createElement("div");
    routeBackedModal.setAttribute("role", "dialog");
    routeBackedModal.setAttribute("data-state", "open");
    document.body.appendChild(routeBackedModal);

    backButtonListener?.();

    expect(back).toHaveBeenCalledOnce();
  });

  it("removes the native listener on unsubscribe", async () => {
    const { subscribeToBackButton } = await import("./back-button.android");
    const unsubscribe = subscribeToBackButton(() => false);

    unsubscribe();
    await Promise.resolve();

    expect(removeMock).toHaveBeenCalledOnce();
  });
});
