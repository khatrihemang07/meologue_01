import { App } from "@capacitor/app";

/**
 * Android's implementation of the back-button seam (issue #189). Web and
 * macOS already have a working "go back" gesture — the browser/WKWebView
 * chrome drives `window.history` directly (`back-button.web.ts`) — but
 * Android's hardware/gesture back button reaches the WebView and is
 * swallowed: nothing in this app has ever called
 * `App.addListener("backButton", ...)`, so Capacitor's own default (go back
 * if the WebView can, otherwise exit) never runs either, once this listener
 * is registered. Registering a listener at all hands this app full
 * responsibility for every press — there is no "do the default thing"
 * fallback left once we're here, which is why every branch below ends in
 * either a dismiss, a `history.back()`, or `App.exitApp()`.
 *
 * `canGoBack` is a caller-supplied function, deliberately NOT read off the
 * `backButton` event Capacitor hands this listener (which also carries a
 * `canGoBack` field — do not use it). Measured live on device: pressing
 * hardware Back from `/todo/inbox` (`window.history.length === 2` — there
 * is somewhere to go) delivered `canGoBack: false` on the event, and the
 * app exited instead of navigating. Capacitor derives its field from the
 * *native* `WebView.canGoBack()`, which tracks page-level (full) loads;
 * this app is a real-URL SPA that does every navigation after first paint
 * through `pushState`/`replaceState` (App.tsx's own header comment), which
 * the native WebView never sees as a "page" at all — so its notion of
 * history depth stays flat at the single page it loaded once, while
 * `window.history.length` (and this app's own router) keeps climbing. They
 * are two different sources of truth, and only one of them agrees with
 * what `window.history.back()` below actually does — which is exactly the
 * drift a from-scratch depth counter was rejected for in an earlier
 * version of this file, just discovered pointing the other way. The fix is
 * the same either way: decide "can I go back?" from the thing this file
 * acts on. `use-back-button.ts` is where that's computed, from
 * react-router's own `useLocation`/`useNavigationType` (the router already
 * knows the in-app navigation depth the native WebView cannot see), and
 * it's passed in here as a function rather than a value so every press
 * reads the *current* depth rather than whatever it was when this
 * subscription was created.
 *
 * Criterion 2 (a dialog/sheet open over a screen must close, not let Back
 * navigate the route underneath it) splits into two cases this app already
 * has, and they need different handling:
 *
 * - Route-backed modals (`/todo/task/:taskSlugId`, ADR 0049; the Composer's
 *   `?task=` overlay, issue #181) close correctly from a plain
 *   `window.history.back()` with no help from this file: their `open` state
 *   is derived from the URL/params, so popping history unmounts them the
 *   same way any other route change would, exactly like a real browser Back
 *   already does for them on web.
 * - Pure component-state dialogs (`TaskScheduleSheet`, `DatePickerSheet`,
 *   `ConfirmDialog`, `TaskCommandMenu`) are NOT tied to a route at all —
 *   calling `history.back()` while one is open would pop whatever route
 *   sits underneath it and leave the dialog floating over the wrong screen
 *   (see this ticket's own report). `DISMISSIBLE_OVERLAY_SELECTOR` below
 *   fingerprints exactly these — and only these — by the DOM markers this
 *   app already gives them (`ui/sheet.tsx`'s own `data-slot="sheet-content"`,
 *   `ui/alert-dialog.tsx`'s deliberate `role="alertdialog"` override, and
 *   `TaskCommandMenu`'s `DropdownMenu.Root`, the only one in this app,
 *   whose Content carries Radix's own `role="menu"`). Notably, none of
 *   these ever matches `TaskDetailView` (task-detail-view.tsx) — that
 *   component sets neither a `data-slot` nor a non-default `role`, so a
 *   route-backed modal built on the identical Radix `Dialog.Root` primitive
 *   is never mistaken for a state-backed one.
 *
 * When a state-backed dialog is open, this dispatches a synthetic Escape
 * `keydown` rather than inventing an Android-specific "how do I close this"
 * path: every one of those four is built on a Radix primitive whose
 * `DismissableLayer` already closes the topmost open layer on a real
 * Escape press, on every platform, today. Reusing that is what keeps this
 * "the same [behaviour] web and macOS already have" (criterion 4) rather
 * than a second navigation model that happens to produce the same visual
 * result. This check runs before `canGoBack` is even consulted, since a
 * dialog can be open regardless of navigation depth.
 */
const DISMISSIBLE_OVERLAY_SELECTOR = [
  '[data-slot="sheet-content"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
].join(", ");

export function subscribeToBackButton(canGoBack: () => boolean): () => void {
  const listenerHandle = App.addListener("backButton", () => {
    if (document.querySelector(DISMISSIBLE_OVERLAY_SELECTOR)) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      return;
    }

    if (canGoBack()) {
      window.history.back();
      return;
    }

    // Nowhere left in this app's own history (criterion 3) — ADR 0036's
    // root screen at `/` is the only place a cold launch or a full pop
    // ever lands, so this is reached exactly there, not "trapping" the
    // reader the way doing nothing would.
    void App.exitApp();
  });

  return () => {
    void listenerHandle.then((listener) => listener.remove());
  };
}
