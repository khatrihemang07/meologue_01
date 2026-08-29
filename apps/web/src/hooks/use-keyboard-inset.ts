import { useEffect, useRef, useState } from "react";

/**
 * What a virtual keyboard is doing to the viewport, expressed so that one
 * code path is correct on both engines this app ships on.
 *
 * `index.html` asks for `interactive-widget=resizes-content`, which is a
 * Chromium-only viewport key. Where it is honoured (Android's WebView, and
 * Chrome on the web build) the *layout* viewport shrinks when the keyboard
 * opens, so CSS has already made room and nothing here needs to ask for it
 * again. WKWebView — what Tauri renders in, and what any future iOS target
 * would use — ignores the key entirely: the layout viewport is untouched and
 * only the visual viewport shrinks, leaving the keyboard sitting *over* the
 * bottom of the page with nothing accounting for it.
 *
 * Reporting the *residual* occlusion rather than the keyboard's height is
 * what collapses those two cases into one number. Subtracting the visual
 * viewport's own height and offset from the layout viewport's height gives
 * zero on the engine that already resized, and the keyboard's height on the
 * engine that did not — so a caller can subtract it unconditionally.
 */
export interface KeyboardInset {
  /**
   * CSS pixels the keyboard occludes that layout has *not* already accounted
   * for. Zero on an engine that honoured `interactive-widget=resizes-content`,
   * even while a keyboard is up — see `visible` for that question.
   */
  inset: number;
  /**
   * Whether a keyboard is up at all, on either engine. Distinct from
   * `inset > 0`: a caller that needs to drop its own bottom safe-area padding
   * (the home indicator is behind the keyboard, so reserving space for it
   * there double-pads) needs this, not the residual height.
   */
  visible: boolean;
}

/**
 * Below this, a difference is browser rounding rather than a keyboard. Without
 * a deadband, fractional device-pixel-ratio rounding leaves a permanent 1px
 * discrepancy that would shrink the shell by a pixel forever and re-render on
 * every viewport event.
 */
const NOISE_PX = 8;

const NOTHING: KeyboardInset = { inset: 0, visible: false };

function read(baselineHeight: number): KeyboardInset {
  const viewport = window.visualViewport;
  if (!viewport) return NOTHING;

  const occluded = window.innerHeight - viewport.height - viewport.offsetTop;
  const inset = occluded > NOISE_PX ? Math.round(occluded) : 0;

  // On the engine that resized the content there is no residual inset to
  // measure, so the only evidence a keyboard is up is the layout viewport
  // having shrunk below the tallest it has been at this width.
  const layoutShrank = window.innerHeight < baselineHeight - NOISE_PX;

  return { inset, visible: inset > 0 || layoutShrank };
}

/**
 * Tracks the virtual keyboard against the visual viewport.
 *
 * The baseline is the tallest layout viewport seen *at the current width*,
 * and it resets when the width changes. That reset is what a rotation needs:
 * without it, portrait's taller height stays the baseline and every landscape
 * frame reads as a keyboard that is permanently up. Growing rather than
 * tracking the latest value is what keeps the baseline from following the
 * layout down when Chromium shrinks it for a keyboard that really is there.
 *
 * Known and bounded: **rotating while the keyboard is already open** reseeds
 * the baseline from an already-shrunk `innerHeight`, so on the engine that
 * resizes content `visible` reads false until the keyboard closes once. The
 * cost is one gesture bar's worth of padding reserved above an open keyboard
 * for that interval, and it heals itself the moment the keyboard closes and
 * the baseline grows back.
 *
 * It is left this way on purpose. A rotation genuinely invalidates the old
 * height, so there is no earlier value to fall back on, and the alternatives
 * are worse: keeping the pre-rotation height applies portrait's baseline to
 * landscape, and gating on `document.activeElement` being a text field
 * guesses at the IME from focus, which is not the same thing (a hardware
 * keyboard focuses a field and raises nothing). `inset > 0` is unaffected
 * either way, so WKWebView — the engine that actually needs a number rather
 * than a flag — is correct throughout.
 */
export function useKeyboardInset(): KeyboardInset {
  const baseline = useRef({ width: 0, height: 0 });
  const [state, setState] = useState<KeyboardInset>(NOTHING);

  useEffect(() => {
    function rebaseline() {
      const current = baseline.current;
      if (current.width !== window.innerWidth) {
        // A width change is a rotation or a window resize, never a keyboard —
        // no keyboard changes how wide the viewport is.
        baseline.current = { width: window.innerWidth, height: window.innerHeight };
      } else if (window.innerHeight > current.height) {
        baseline.current = { width: current.width, height: window.innerHeight };
      }
    }

    function update() {
      rebaseline();
      const next = read(baseline.current.height);
      setState((previous) =>
        previous.inset === next.inset && previous.visible === next.visible ? previous : next,
      );
    }

    update();

    const viewport = window.visualViewport;
    // `scroll` as well as `resize`: `offsetTop` moves without the height
    // changing when the visual viewport is panned, and the occlusion maths
    // reads both.
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);

    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return state;
}
