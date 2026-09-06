import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerToolbar } from "./composer-toolbar";

/** Same stand-in as entry-row.test.tsx's own `stubHoverCapable` — see its comment. */
function stubHoverCapable(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches, media: query })),
  );
}

const POINTER_ONLY_LABELS = ["Code"];
const TOUCH_ONLY_LABELS = ["Insert line break"];
const SHARED_LABELS = [
  "Bold",
  "Italic",
  "Strikethrough",
  "Bullet list",
  "Numbered list",
  "Checklist",
  "Outdent",
  "Indent",
  "Reference",
  "Undo",
  "Redo",
];

describe("ComposerToolbar", () => {
  // Issue #213: a rendered subset needs no `commandStates` of its own —
  // `FALLBACK_STATE` (composer-toolbar.tsx) covers every id, pointer or
  // touch, that isn't in the map yet.
  it("renders the pointer set, unchanged, on a hover-capable device", () => {
    stubHoverCapable(true);

    render(<ComposerToolbar commandStates={{}} onRun={vi.fn()} />);

    for (const label of [...SHARED_LABELS, ...POINTER_ONLY_LABELS]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    for (const label of TOUCH_ONLY_LABELS) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });

  it("renders the touch set, including indent/outdent/soft-break and omitting code, on a non-hover-capable device", () => {
    stubHoverCapable(false);

    render(<ComposerToolbar commandStates={{}} onRun={vi.fn()} />);

    for (const label of [...SHARED_LABELS, ...TOUCH_ONLY_LABELS]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    for (const label of POINTER_ONLY_LABELS) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });

  it("runs the soft-break command when its button is pressed, on the touch set", () => {
    stubHoverCapable(false);
    const onRun = vi.fn();

    render(
      <ComposerToolbar
        commandStates={{ softBreak: { active: false, enabled: true } }}
        onRun={onRun}
      />,
    );
    screen.getByRole("button", { name: "Insert line break" }).click();

    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: "softBreak" }));
  });
});
