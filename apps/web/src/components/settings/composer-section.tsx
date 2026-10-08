import { useState } from "react";
import { DeviceGroup } from "@/components/settings/device-group";
import { SettingsSection } from "@/components/settings/settings-section";
import { SwitchRow } from "@/components/settings/switch-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeDictationError, describeGatewayHealth } from "@/lib/describe-dictation-error";
import { checkDictationGateway } from "@/lib/dictation-transport";
import { normaliseServerUrl, useSettingsStore } from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * What the Composer looks and behaves like while a reader is writing —
 * whether its format toolbar shows, and whether Todo's own add field
 * (opened from the same writing surface) reads eager natural-language
 * dates — one of the topic sections `settings-page.tsx` composes (issue
 * #202). The "Completed checklist item" section this page used to carry
 * alongside these two is gone: issue #351 retired the four-value option it
 * offered, so there is no longer a display choice to make here at all
 * (`lib/settings.ts`'s own comment on `meologue.completed-style` has the
 * full reasoning).
 *
 * "Smart date recognition" lives here rather than in a `Todo` topic of its
 * own: it governs the add field's own parser, and the add field is a
 * Composer-shaped input, the same reasoning that already put it on this
 * page (issue #170) well before Todo's other settings existed to weigh it
 * against.
 *
 * Issue #358's "Completed tasks" toggle below has no such Composer-shaped
 * reason — it governs how Todo's own lists render, not anything about
 * writing — but there is still no dedicated `Todo` topic section on this
 * page (five exist: Appearance, Composer, AI, Sync, Data), and `AiSection`'s
 * own "Chat list" row already sets the precedent that a Device-local Todo
 * setting with nowhere else to go lands wherever is least wrong rather than
 * growing a sixth section for one row. This one keeps "Smart date
 * recognition" company here because both are Todo-only settings this page
 * has nowhere better to put, not because either belongs to the Composer.
 *
 * Every setting here is Device-local (ADR 0008), read and written straight
 * off `useSettingsStore` with no props threaded down from the page.
 */
export function ComposerSection() {
  const formatBarVisible = useSettingsStore((state) => state.formatBarVisible);
  const setStoredFormatBarVisible = useSettingsStore((state) => state.setFormatBarVisible);
  const smartDatesEnabled = useSettingsStore((state) => state.smartDatesEnabled);
  const setStoredSmartDatesEnabled = useSettingsStore((state) => state.setSmartDatesEnabled);
  const completedTasksVisible = useSettingsStore((state) => state.completedTasksVisible);
  const setStoredCompletedTasksVisible = useSettingsStore(
    (state) => state.setCompletedTasksVisible,
  );

  const storedDictationUrl = useSettingsStore((state) => state.dictationUrl);
  const setStoredDictationUrl = useSettingsStore((state) => state.setDictationUrl);
  const storedDictationToken = useSettingsStore((state) => state.dictationToken);
  const setStoredDictationToken = useSettingsStore((state) => state.setDictationToken);

  // Local drafts, committed on Save — the same shape `sync-section.tsx`
  // uses for the Server URL, for the same reason: the field must keep
  // showing what is being typed until the user chooses to apply it.
  const [dictationUrl, setDictationUrl] = useState(storedDictationUrl);
  const [dictationToken, setDictationToken] = useState(storedDictationToken);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  function saveDictation() {
    setStoredDictationUrl(dictationUrl);
    setStoredDictationToken(dictationToken);
    // Shown normalised, computed rather than read back from storage, for
    // the reason `saveServerUrl` gives.
    setDictationUrl(normaliseServerUrl(dictationUrl));
    setDictationToken(dictationToken.trim());
  }

  // Tests what is in the fields, saved or not, so a user can check an
  // address before committing to it.
  async function testDictation() {
    const url = normaliseServerUrl(dictationUrl);
    if (url === "") {
      setTestResult({ ok: false, message: "Enter a gateway URL first." });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const health = await checkDictationGateway(url, dictationToken.trim());
      setTestResult({ ok: health.status === "ok", message: describeGatewayHealth(health) });
    } catch (error) {
      setTestResult({ ok: false, message: describeDictationError(error) ?? "Test cancelled." });
    } finally {
      setTesting(false);
    }
  }

  // No `applyX` step: there is no on-screen paint for a `localStorage`
  // write to drive immediately from here — `composer.tsx` reads this
  // setting itself, the next time it renders this row.
  function toggleFormatBarVisible() {
    setStoredFormatBarVisible(!formatBarVisible);
  }

  // No `applyX` step, for the identical reason `toggleFormatBarVisible`'s
  // own comment gives: `add-task-form.tsx` reads this setting itself, the
  // next time it renders.
  function toggleSmartDatesEnabled() {
    setStoredSmartDatesEnabled(!smartDatesEnabled);
  }

  // No `applyX` step, for the identical reason above: `task-list.tsx`
  // reads this setting itself, the next time Inbox, a Project, a Filter or
  // Search renders its own list.
  function toggleCompletedTasksVisible() {
    setStoredCompletedTasksVisible(!completedTasksVisible);
  }

  return (
    <section aria-labelledby="composer-heading" className="flex flex-col gap-4">
      <h2 id="composer-heading" className="font-semibold text-sm">
        Composer
      </h2>
      <DeviceGroup heading="On this device">
        {/*
          Issue #164 built this setting; issue #202 promoted it here
          alongside the toggle button that used to sit beside Send. The
          "toolbar means always" rework removes that inline button
          outright, so this row is now the ONLY switch for the setting —
          not a second door to it, the sole one.
        */}
        <SettingsSection
          label="Format toolbar"
          hint="Adds a row of formatting buttons — bold, italic, lists, Reference and more — above the input, always visible while composing."
        >
          <SwitchRow
            label="Show the format toolbar"
            checked={formatBarVisible}
            onToggle={toggleFormatBarVisible}
          />
        </SettingsSection>

        {/*
          Issue #170. Off stops only the eager/natural-language family the
          add field's quick-add parser runs on ordinary words with no
          marker typed on purpose — `monday`, `5pm`, `monthly`, Todoist's
          own documented "Create **monthly** report" false positive
          (packages/core/src/quick-add/types.ts's own QuickAddTokenKind doc
          comment names the family exactly). `#project`, `@label`, `p1`,
          `!reminder`, `for 45min` and the rest of the sigil-marked family
          keep working regardless: a reader who typed an explicit marker
          asked for that word to mean something, so there is no
          false-positive risk this setting exists to let them turn off.
          (`{deadline}` dropped out of this example list with issue #376 —
          the parser still tokenises it, but nothing in this app applies
          it anymore, so naming it here would advertise a working feature
          that isn't one.)
        */}
        <SettingsSection
          label="Todo"
          hint="Off still recognises #project, @label, p1-p4, !reminder and for 45min in the add field — only words like monday, 5pm or monthly stop being read as dates."
        >
          <SwitchRow
            label="Smart date recognition"
            checked={smartDatesEnabled}
            onToggle={toggleSmartDatesEnabled}
          />
        </SettingsSection>

        <SettingsSection
          label="Completed tasks"
          hint="Off hides a completed Task everywhere in Todo, the instant it's completed. On keeps it visible, below the active Tasks, with a control to load older ones."
        >
          <SwitchRow
            label="Show completed Tasks"
            checked={completedTasksVisible}
            onToggle={toggleCompletedTasksVisible}
          />
        </SettingsSection>

        {/*
          Issue #454. Empty URL means the Composer has no mic button at all
          (ADR 0090). The token is a secret: password input, and excluded
          from Backups (`BACKUP_EXCLUDED_KEYS` in lib/settings.ts). Buttons
          are named "Save dictation" / "Test dictation gateway" rather than
          bare Save/Test because this page already has several Save buttons
          and Playwright matches names by substring.
        */}
        <SettingsSection
          label="Dictation"
          hint="Records in the Composer and sends audio to an OpenWhispr gateway on your network. The mic button appears at the start of the format toolbar. The token stays on this Device and is not included in Backups."
        >
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              saveDictation();
            }}
          >
            <label htmlFor="dictation-url" className="sr-only">
              Gateway URL
            </label>
            <Input
              id="dictation-url"
              type="text"
              placeholder="Gateway URL — leave empty to turn dictation off"
              value={dictationUrl}
              onChange={(event) => setDictationUrl(event.target.value)}
              className="h-11"
            />
            <label htmlFor="dictation-token" className="sr-only">
              Gateway token
            </label>
            <Input
              id="dictation-token"
              type="password"
              autoComplete="off"
              placeholder="Token"
              value={dictationToken}
              onChange={(event) => setDictationToken(event.target.value)}
              className="h-11"
            />
            <div className="flex gap-2">
              <Button type="submit" size="touch">
                Save dictation
              </Button>
              <Button
                type="button"
                size="touch"
                variant="outline"
                onClick={testDictation}
                disabled={testing}
              >
                Test dictation gateway
              </Button>
            </div>
          </form>
          {testResult && (
            <p
              data-testid="dictation-status"
              className={cn("text-sm", testResult.ok ? "text-foreground" : "text-destructive")}
            >
              {testResult.message}
            </p>
          )}
        </SettingsSection>
      </DeviceGroup>
    </section>
  );
}
