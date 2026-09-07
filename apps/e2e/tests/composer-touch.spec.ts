import { expect, test } from "./fixtures";
import { composerField } from "./helpers";

/**
 * Issue #213: the Composer adapts to a keyboard-less device. Runs only
 * under the `chromium-touch` project (playwright.config.ts's own comment on
 * why `isMobile: true`, not `hasTouch`, is what's needed to see this at
 * all) — `chromium`'s own project ignores this file outright, so these
 * assertions never run against a genuinely hover-capable browser, where
 * they would be testing the wrong toolbar entirely.
 *
 * Deliberately small: `composer.spec.ts`'s own format-toolbar section
 * already proves each command's own behaviour (composer-commands.test.ts
 * proves it deeper still, against a plain `EditorState`) — what's specific
 * to touch, and needs a real device profile to prove, is which BUTTONS
 * show up, and that soft break reaches the editor the same caret-safe way
 * every other toolbar button already does.
 */

test("the touch toolbar leads with outdent, indent and soft break, and drops inline code", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  await editor.click();
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });

  // Visible with no stored preference and no toggle click — the other half
  // of this file's own coverage, below, but worth asserting here too since
  // every other assertion in this test depends on it.
  await expect(toolbar).toBeVisible();

  await expect(toolbar.getByRole("button", { name: "Outdent" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Indent" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Insert line break" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Checklist" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Bullet list" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Numbered list" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Bold" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Italic" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Strikethrough" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Reference" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Redo" })).toBeVisible();

  // Dropped on touch (composer-toolbar.tsx's own comment on why): a
  // backtick pair is still typeable, and it's the least-used mark on a
  // phone.
  await expect(toolbar.getByRole("button", { name: "Code" })).toHaveCount(0);
});

test("the format bar shows by default with no stored preference, and the soft-break button inserts a newline without stealing the caret", async ({
  page,
}) => {
  await page.goto("/composer");
  const editor = composerField(page);
  const toggle = page.getByRole("button", { name: "Format toolbar" });

  // No `meologue.format-bar-visible` in this fresh context's localStorage —
  // still visible the instant the Composer has focus, and the toggle
  // itself already reads "on" (settings.ts's `defaultFormatBarVisible`).
  await editor.click();
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  await expect(toolbar).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await editor.pressSequentially("alpha");
  await toolbar.getByRole("button", { name: "Insert line break" }).click();

  // Checked BEFORE the next `pressSequentially` call below, deliberately:
  // `Locator.pressSequentially` focuses its own element first, which would
  // silently mask a focus theft by the button click that came before it.
  // composer-toolbar.tsx's `onMouseDown` `preventDefault` is what keeps the
  // caret exactly where the reader left it, the same trick every other
  // toolbar button already relies on — this is the one check that actually
  // proves it held for soft break too.
  await expect(editor).toBeFocused();

  await editor.pressSequentially("bravo");

  // One `<p>`, not two — a soft break, exactly like Enter/Shift+Enter
  // (composer.spec.ts's own Issue #212 section).
  await expect(editor.locator("p")).toHaveCount(1);
  await expect.poll(() => editor.locator("p").textContent()).toBe("alpha\nbravo");
});
