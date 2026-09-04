import { useEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router";
import { subscribeToBackButton } from "@/platform/back-button";

/**
 * Wires up the Android hardware back button for the app's whole lifetime
 * (issue #189). Must be mounted *inside* `<BrowserRouter>` (App.tsx renders
 * it as `<BackButtonHandler />`, a sibling of `<Routes>`, not called
 * directly from `App()` itself) — it needs `useLocation`/`useNavigationType`
 * to answer "is there anywhere in this app's own history to go back to?",
 * and those only work inside the Router's context.
 *
 * That question turned out to be the hard part. The obvious answer —
 * Capacitor's own `canGoBack` field on the `backButton` event — is
 * measurably wrong for this app: it reads the *native* WebView's
 * `canGoBack()`, which tracks full page loads, and this app is a real-URL
 * SPA that does every navigation after first paint through
 * `pushState`/`replaceState` (App.tsx's own header comment) — the WebView
 * never sees more than the one page it loaded, so that field stays `false`
 * forever while `window.history.length` climbs underneath it. Trusting it
 * (an earlier version of this file did) makes the back button exit the app
 * from `/todo/inbox`, one screen in — worse than doing nothing.
 *
 * `window.history.length` itself is not the fix either: it only grows
 * (`history.back()` doesn't shrink it, it just moves a pointer), so it
 * cannot answer "am I at the root" — the same navigation depth would read
 * differently depending on how much *forward* browsing happened earlier in
 * the session. What this hook tracks instead is a local counter of this
 * app's own `PUSH`/`POP` navigations, seeded at 0 on mount and adjusted by
 * `useNavigationType()` on every location change: a `PUSH` means the reader
 * went one step deeper (an in-app "back" now has somewhere to land), a
 * `POP` means they came back one step (whether by this hook calling
 * `window.history.back()` on a previous press, or a real browser Back on
 * web/macOS), and a `REPLACE` (several exist — `stepTaskDetail` in
 * todo-page.tsx, the Composer's own overlay-close) leaves depth alone,
 * exactly matching that it doesn't add or remove a history entry either.
 * The first render is skipped rather than counted as a `PUSH`/`POP` of its
 * own — it's wherever this session's navigation stack starts (`/` on a
 * normal cold launch, ADR 0036), not a step taken from somewhere else.
 *
 * This is a *count*, not a mirror of `window.history`: it only has to
 * agree with `window.history` about the one fact `back-button.android.ts`
 * needs — whether calling `window.history.back()` right now would move
 * this app to a screen it was already showing earlier in this session, or
 * fall out of the app entirely — and unlike the WebView's own
 * `canGoBack()`, it is built from the same `PUSH`/`POP`/`REPLACE`
 * classification `BrowserRouter` itself uses to decide what `history.back()`
 * does, so it cannot disagree with it the way Capacitor's native read does.
 */
export function useBackButton(): void {
  const location = useLocation();
  const navigationType = useNavigationType();
  const depthRef = useRef(0);
  const isFirstRender = useRef(true);

  // `location` is never read in the effect body below, but it has to stay
  // a dependency anyway: `navigationType` is one of three string literals,
  // so two consecutive pushes (or two consecutive pops) report the
  // identical "PUSH"/"POP" value, and without `location` in the dependency
  // array React would see no change between them and skip the second
  // increment/decrement entirely. `location` changes on every navigation
  // React Router makes, which is exactly the signal this effect needs to
  // run again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above — location is a re-run trigger, not a value this effect reads.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (navigationType === "PUSH") {
      depthRef.current += 1;
    } else if (navigationType === "POP") {
      depthRef.current = Math.max(0, depthRef.current - 1);
    }
    // "REPLACE" adds/removes no history entry, so depth is left untouched.
  }, [location, navigationType]);

  useEffect(() => subscribeToBackButton(() => depthRef.current > 0), []);
}
