import { CompletedStyleRow } from "@/components/settings/completed-style-row";
import { DeviceGroup } from "@/components/settings/device-group";
import { SettingsSection } from "@/components/settings/settings-section";
import { SwitchRow } from "@/components/settings/switch-row";
import { COMPLETED_STYLES, type CompletedStyleId, useSettingsStore } from "@/lib/settings";
import { applyCompletedStyle } from "@/lib/theme";

/**
 * What the Composer looks and behaves like while a reader is writing —
 * whether its format toolbar shows, how a completed checklist item is
 * painted, and whether Todo's own add field (opened from the same
 * writing surface) reads eager natural-language dates — the second of five
 * topic sections `settings-page.tsx` composes (issue #202).
 *
 * "Smart date recognition" lives here rather than in a `Todo` topic of its
 * own: it governs the add field's own parser, and the add field is a
 * Composer-shaped input, the same reasoning that already put it on this
 * page (issue #170) well before Todo's other settings existed to weigh it
 * against.
 *
 * Every setting here is Device-local (ADR 0008), read and written straight
 * off `useSettingsStore` with no props threaded down from the page.
 */
export function ComposerSection() {
  const formatBarVisible = useSettingsStore((state) => state.formatBarVisible);
  const setStoredFormatBarVisible = useSettingsStore((state) => state.setFormatBarVisible);
  const completedStyle = useSettingsStore((state) => state.completedStyle);
  const setStoredCompletedStyle = useSettingsStore((state) => state.setCompletedStyle);
  const smartDatesEnabled = useSettingsStore((state) => state.smartDatesEnabled);
  const setStoredSmartDatesEnabled = useSettingsStore((state) => state.setSmartDatesEnabled);

  // No `applyX` step, unlike `selectCompletedStyle` below: there is no
  // on-screen paint for a `localStorage` write to drive immediately from
  // here — `composer.tsx` reads this setting itself, the next time it
  // renders, the same way it already applies the toggle button beside Send.
  function toggleFormatBarVisible() {
    setStoredFormatBarVisible(!formatBarVisible);
  }

  // Apply first, then persist — same order as every other visible choice on
  // this page. "Apply" here is one attribute write (`applyCompletedStyle`);
  // it rewrites no Entry, starts no Sync, and marks no Digest stale, per
  // ADR 0008 and this setting's own doc comment in settings.ts.
  function selectCompletedStyle(next: CompletedStyleId) {
    applyCompletedStyle(next);
    setStoredCompletedStyle(next);
  }

  // No `applyX` step, unlike `selectCompletedStyle` above: there is no
  // on-screen paint for a `localStorage` write to drive immediately
  // (add-task-form.tsx reads this setting itself, the next time it
  // renders), the same reasoning `toggleFormatBarVisible`'s own comment
  // gives for its identical one-line body.
  function toggleSmartDatesEnabled() {
    setStoredSmartDatesEnabled(!smartDatesEnabled);
  }

  return (
    <section aria-labelledby="composer-heading" className="flex flex-col gap-4">
      <h2 id="composer-heading" className="font-semibold text-sm">
        Composer
      </h2>
      <DeviceGroup heading="On this device">
        {/*
          Issue #164 built this setting; issue #202 promotes it here.
          "Promoted" means "also findable in Settings," not "moved" — the
          toggle button beside Send (composer.tsx) stays exactly where it
          is, and this row is a second way to reach the identical switch,
          not a replacement for the first.
        */}
        <SettingsSection
          label="Format toolbar"
          hint="Adds a row of formatting buttons — bold, italic, lists, Reference and more — above the input while writing an Entry. The toggle beside Send does the same thing and stays there."
        >
          <SwitchRow
            label="Show while writing"
            checked={formatBarVisible}
            onToggle={toggleFormatBarVisible}
          />
        </SettingsSection>

        {/*
          Issue #163. Display only, exactly like Appearance's own controls:
          the four stacked rows below change how a checked item is PAINTED
          in both the Composer and History, and nothing about what's
          stored, Synced, or fed to a Digest. UpNote's companion "move
          completed items to the bottom" is deliberately not offered here —
          see `CompletedStyleId`'s own doc comment (settings.ts) for why
          that one doesn't belong beside a display-only choice.
        */}
        <SettingsSection
          label="Completed checklist item"
          hint="Changes how a ticked checkbox's own words look. Nothing about what you wrote, Synced, or already summarised into a Digest changes."
        >
          {COMPLETED_STYLES.map((option) => (
            <CompletedStyleRow
              key={option.id}
              option={option}
              selected={completedStyle === option.id}
              onSelect={() => selectCompletedStyle(option.id)}
            />
          ))}
        </SettingsSection>

        {/*
          Issue #170. Off stops only the eager/natural-language family the
          add field's quick-add parser runs on ordinary words with no
          marker typed on purpose — `monday`, `5pm`, `monthly`, Todoist's
          own documented "Create **monthly** report" false positive
          (packages/core/src/quick-add/types.ts's own QuickAddTokenKind doc
          comment names the family exactly). `#project`, `%label`, `p1`,
          `!reminder`, `{deadline}`, `for 45min` and the rest of the
          sigil-marked family keep working regardless: a reader who typed
          an explicit marker asked for that word to mean something, so
          there is no false-positive risk this setting exists to let them
          turn off.
        */}
        <SettingsSection
          label="Todo"
          hint="Off still recognises #project, %label, p1-p4, !reminder, {deadline} and for 45min in the add field — only words like monday, 5pm or monthly stop being read as dates."
        >
          <SwitchRow
            label="Smart date recognition"
            checked={smartDatesEnabled}
            onToggle={toggleSmartDatesEnabled}
          />
        </SettingsSection>
      </DeviceGroup>
    </section>
  );
}
