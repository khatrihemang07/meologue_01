/**
 * Promotion (issue #173, ADR 0048): sending an Entry containing a bare
 * `- [ ]`/`- [x]` mints a Task for it and rewrites that line as a
 * `[[task:id|label]]` Reference — "a checkbox written in a thought
 * becomes a real Task, automatically, with no promotion gesture to
 * learn" (the issue's own words).
 *
 * **The loop guard.** A list item only qualifies when it carries a
 * checkbox AND is not already a Reference — `referencedTaskOf`
 * (inline-markdown.ts), the identical detection `entry-prose.tsx`'s own
 * render path uses to recognise Promotion's own output shape. A Task
 * created directly in Todo has no checkbox line to promote in the first
 * place, and a line this function has already promoted no longer looks
 * like a bare checkbox on any later Send — so a Task can never create an
 * Entry that creates a Task.
 *
 * **Built on the ProseMirror round trip, not a hand-rolled string
 * splice.** `use-history.ts`'s `sendEntry` hands this whatever
 * `normalizeEntryBody` produced — text that, sent from the Composer
 * (composer-send.ts's `rawBody`), already passed through
 * `entryDocumentToMarkdown` once on its way out of the editor. Parsing it
 * back with `entryMarkdownToDocument`, replacing each qualifying
 * `list_item`'s own leading paragraph with one holding a fresh
 * `task_reference` node, and reserialising is exactly the transform
 * `entry-document.ts`'s own 691-case round-trip property test already
 * proves stable (`roundTrip(roundTrip(x)) === roundTrip(x)`) — reusing it
 * here means this function never has to reason about mark escaping, list
 * markers, or separator whitespace by hand the way a raw string splice
 * would. An Entry with nothing to promote is returned completely
 * unchanged (`body === body`, no parse-and-reserialise round trip at
 * all): Promotion must never reformat an Entry that had no bare checkbox
 * in it, the identical "don't touch what you didn't mean to touch"
 * discipline `toggleTaskAt` (toggle-task.ts) already holds for a single
 * marker.
 *
 * **Promotion applies the parse, not just the highlight (issue #173
 * follow-up).** `- [ ] buy milk tomorrow p1 #Shopping` must mint a Task
 * whose content is `buy milk`, whose `date` is tomorrow and whose
 * `priority` is stored `4` — the SAME recognised tokens
 * `composer-editor.ts`'s `checklistHighlightPlugin` already highlighted
 * as the reader typed. This function reuses issue #170's own pipeline
 * end to end — `parseWithDemotions` (quick-add-highlight.ts) over
 * `parseQuickAdd` (`@meologue/core`), then `taskFieldsFromQuickAdd`
 * (quick-add-task.ts) to turn the parse into the same Task fields
 * add-task-form.tsx already resolves for Todo's own add field — rather
 * than writing a second parser integration, per this ticket's own
 * instruction.
 *
 * **This changes what the Entry's body says**, and that is deliberate,
 * not a side effect to paper over. Consuming a token removes its words
 * from the checkbox line the same way `taskFieldsFromQuickAdd`'s own
 * `content` already removes them from a Task typed straight into Todo
 * (Todoist's own quick-add makes the identical bargain) — the line
 * becomes `- [ ] [[task:id|buy milk]]`, so the journal no longer contains
 * the literal words "tomorrow p1". Under ADR 0048 a Reference's own label
 * is a cache of the Task's real name, there is exactly one copy of that
 * name (the Task's `content`), and Export writes the Task's own words
 * back out, so nothing is silently lost — but a future reader landing
 * here after noticing an Entry "ate" a word should know why: **the
 * demotion gesture is what makes this acceptable.** A reader who meant
 * "tomorrow" as prose, not a date, clicks it back to plain text — in the
 * Composer, before Send — and it stays put, verbatim, in the Entry. That
 * demotion has to survive into promotion for the bargain to hold, which
 * is exactly what `activePromotion` below exists to carry through: the
 * one checklist line `checklistHighlightPluginKey`
 * (composer-editor.ts) was actively tracking when Send fired, identified
 * by its ordinal position among every bare, unreferenced checkbox item in
 * the document (see `activeChecklistPromotion`'s own comment there for
 * why ordinal position, not the line's own text or its live document
 * position, is the one thing guaranteed to still identify the same item
 * after this function re-parses `body` from scratch). A checklist line
 * the reader was NOT actively editing when they hit Send carries no
 * demotion state at all — `checklistHighlightPlugin`'s own state only
 * ever tracks the one line the caret is inside (its header comment: "the
 * one open thing at a time" shape) — so a demotion made, then abandoned
 * by moving the caret elsewhere before Send, does not survive; this is
 * the plugin's own pre-existing scope, not a gap this function papers
 * over.
 *
 * **Keeping the parse in step with the highlight.** `quickAddOptions` is
 * threaded in from the caller rather than computed here (contrast
 * `composer-editor.ts`'s own `quickAddOptionsNow`, which reads real wall-clock
 * time and Settings) precisely so promotion can be handed the EXACT
 * `now`/`smartDates` the Composer's own decorations were just drawn
 * with — `use-history.ts`'s `sendEntry`/`commitEntryEdit` fall back to a
 * freshly computed `quickAddOptionsNow()` only when no live Composer
 * handed one over (a test, or any future non-Composer caller), never
 * silently inside this module, which stays a pure function of its
 * arguments for exactly the reason this module's own pre-existing header
 * comment already gives for the ProseMirror round trip: testable top to
 * bottom, nothing implicit.
 */
import type { QuickAddOptions, QuickAddResult, QuickAddToken } from "@meologue/core";
import { parseQuickAdd } from "@meologue/core";
import type { Node as PMNode } from "prosemirror-model";
import { Fragment } from "prosemirror-model";
import { entryDocumentToMarkdown, entryMarkdownToDocument } from "@/lib/entry-document";
import { entrySchema } from "@/lib/entry-schema";
import {
  type DemotedSignature,
  parseWithDemotions,
  tokenSignature,
} from "@/lib/quick-add-highlight";
import { taskFieldsFromQuickAdd } from "@/lib/quick-add-task";

/**
 * One Task minted out of a bare checkbox line — `use-history.ts`'s
 * `sendEntry`/`commitEntryEdit` build a real `Task` from each of these.
 * Every field below except `id`/`checked` is exactly
 * `quick-add-task.ts`'s own `QuickAddTaskFields` shape (`content` in
 * place of that file's `content`, `labelNames` still unresolved — a
 * `%label` name needs a LabelStore round trip this module has no
 * business making, `use-history.ts`'s own `upsertPromotedTasks` is what
 * awaits `resolveLabelIds` the same way `todo-page.tsx`'s `handleAdd`
 * already does for the add field) — because Promotion and Todo's own add
 * field are the identical parse, landing in the identical Task fields,
 * per this module's own header comment.
 */
export interface PromotedTask {
  readonly id: string;
  readonly checked: boolean;
  /** The words left after every recognised, supported token's span was consumed — never empty (see `transformNode`'s own fallback for why). */
  readonly content: string;
  /** The parsed `date`, or `null` when nothing dated this line — `use-history.ts`'s own `promotedTaskToTask` is where "the Entry's own capture date wins when nothing parses" actually happens; this field only ever carries what the parse itself decided. */
  readonly date: string | null;
  readonly deadline: string | null;
  readonly duration: number | null;
  readonly priority: number;
  readonly dateString: string | null;
  readonly labelNames: string[];
}

export interface PromotionResult {
  readonly body: string;
  readonly tasks: readonly PromotedTask[];
}

/**
 * The ONE checklist line the Composer's own `checklistHighlightPlugin`
 * was actively tracking at the instant Send fired, carried through to
 * promotion so a demotion the reader clicked is not silently re-promoted
 * — see this module's own header comment ("this changes what the Entry's
 * body says") for why that agreement is load-bearing, not a nicety.
 * Built by `composer-editor.ts`'s own `activeChecklistPromotion`; see its
 * comment for why `ordinal` (not text, not a live document position) is
 * what survives from the live `EditorState` to this function's own
 * from-scratch re-parse of `body`.
 */
export interface ActiveChecklistPromotion {
  /** This item's 0-based position among every bare, unreferenced checkbox `list_item` in the document, in document order — the identical order `transformNode` below visits and promotes them in. */
  readonly ordinal: number;
  readonly demoted: ReadonlySet<DemotedSignature>;
}

/** No demotion at all — the ordinary case for every checklist item except, at most, the one line `ActiveChecklistPromotion` names. A single shared instance rather than a fresh `Set` per item: `parseWithDemotions` only ever reads its size/membership, never mutates it. */
const NO_DEMOTIONS: ReadonlySet<DemotedSignature> = new Set();

/**
 * What a live Composer knows, at the instant Send fires, that Promotion
 * needs in order to agree with what the reader just saw highlighted —
 * `composer.tsx`'s own `send()` builds one of these (`quickAddOptionsNow()`
 * plus `activeChecklistPromotion(view.state)`, both composer-editor.ts) and
 * hands it to `use-history.ts`'s `sendEntry`/`commitEntryEdit`, which pass
 * it straight through to `promoteBareCheckboxes` below. Optional at every
 * one of those call sites: a caller with no live editor to ask (a test, or
 * any future non-Composer door onto `sendEntry`) gets a freshly computed
 * `quickAddOptionsNow()` and no active demotion instead of a stale one.
 */
export interface ComposerPromotionContext {
  readonly quickAddOptions: QuickAddOptions;
  readonly active: ActiveChecklistPromotion | null;
}

/**
 * `first`'s own content, flattened to plain words — mirrors
 * `inline-markdown.ts`'s `inlineNodesToText` at the ProseMirror-node level
 * rather than the `InlineNode` one, since Promotion runs on the document
 * `entryMarkdownToDocument` already built, not on the parser's own tree. A
 * `reference` atom contributes its `raw` mark text (`[[2026-08-28]]`
 * itself is the words there is to show); a `task_reference` atom
 * contributes its own cached `label` — reachable only if a checkbox
 * line's own text already carries an unrelated task Reference beside
 * plain words, which the dialect permits even though nothing in this app
 * produces it on purpose.
 *
 * Deliberately NOT trimmed — the caller (`transformNode`) hands this
 * straight to `parseWithDemotions`/`taskFieldsFromQuickAdd`, which expect
 * exactly the same raw, untrimmed text `checklistHighlightPlugin`'s own
 * `textBlockPlainText` parses for its decorations (the mandatory
 * separator space after `[ ]`/`[x]` included); trimming here would shift
 * every token's own offset out of step with what the reader saw
 * highlighted. NOTE: unlike `textBlockPlainText`, this DOES expand a
 * `reference` atom to its raw mark text rather than a single placeholder
 * character — a checklist line that embeds a `[[…]]` Reference beside
 * plain words is already an edge case neither this app nor
 * `checklistHighlightPlugin`'s own header comment claims to produce on
 * purpose, and the two functions disagreeing on that one case is a known,
 * accepted gap rather than one this module solves.
 */
function flattenLabel(node: PMNode): string {
  let text = "";
  node.forEach((child) => {
    if (child.isText) {
      text += child.text ?? "";
    } else if (child.type.name === "reference") {
      text += String(child.attrs.raw);
    } else if (child.type.name === "task_reference") {
      text += String(child.attrs.label);
    } else {
      text += flattenLabel(child);
    }
  });
  return text;
}

/**
 * Whether `paragraph` (a `list_item`'s own leading block) already holds
 * Promotion's own output shape — the loop guard's positive case, mirroring
 * `inline-markdown.ts`'s `referencedTaskOf` at the ProseMirror-node level.
 * The mandatory separator space after `[ ]`/`[x]` survives parsing as a
 * leading, whitespace-only text node (`entry-document.ts`'s own
 * `needsTaskSeparator`), stripped here the same way `referencedTaskOf`
 * strips it before checking whether one `task_reference` node is all that
 * remains.
 */
function isAlreadyReferenced(paragraph: PMNode): boolean {
  const children: PMNode[] = [];
  paragraph.forEach((child) => {
    children.push(child);
  });
  const first = children[0];
  const own = first?.isText && (first.text ?? "").trim() === "" ? children.slice(1) : children;
  return own.length === 1 && own[0]?.type.name === "task_reference";
}

/**
 * A per-token refusal, layered on top of `parseWithDemotions`'s own
 * per-item demotion set (issue #174) — the backfill's own answer to "the
 * thing that makes the parser safe in the add field... does not exist in
 * a migration" (this module's own header comment already names the risk;
 * `backfill-tasks.ts` is where the actual gate lives, built from
 * `@meologue/core`'s own English word tables rather than anything this
 * module needs to know about). Returning `true` for a token means
 * "refuse this regardless of what any live Composer might otherwise have
 * let through" — every caller reachable from a live Composer passes no
 * gate at all, so nothing about live Promotion (issue #173) changes by
 * this parameter merely existing.
 */
export type ChecklistConfidenceGate = (token: QuickAddToken) => boolean;

/**
 * `parseWithDemotions`, widened with an optional `confidenceGate`. Left
 * `undefined` (every live-Composer call site), this is byte-identical to
 * calling `parseWithDemotions` directly — no second parse, no extra work
 * on the hot path a reader's every Send already runs. Supplied (the
 * backfill alone), the natural parse is computed once here to find which
 * tokens the gate refuses, and those are folded into `demoted` alongside
 * whatever a live Composer's own per-item demotion already contributed —
 * two different questions ("what did THIS reader click back to plain
 * text" vs "what does this app never trust without one to click"), never
 * one excluding the other.
 */
function parseChecklistLine(
  text: string,
  quickAddOptions: QuickAddOptions,
  demoted: ReadonlySet<DemotedSignature>,
  confidenceGate: ChecklistConfidenceGate | undefined,
): QuickAddResult {
  if (confidenceGate === undefined) {
    return parseWithDemotions(text, quickAddOptions, demoted);
  }
  const natural = parseQuickAdd(text, quickAddOptions);
  const refused = natural.tokens.filter(confidenceGate).map(tokenSignature);
  if (refused.length === 0) {
    return parseWithDemotions(text, quickAddOptions, demoted);
  }
  const merged = demoted.size === 0 ? new Set(refused) : new Set([...demoted, ...refused]);
  return parseWithDemotions(text, quickAddOptions, merged);
}

function transformNode(
  node: PMNode,
  mintId: () => string,
  tasks: PromotedTask[],
  quickAddOptions: QuickAddOptions,
  activePromotion: ActiveChecklistPromotion | null,
  ordinal: { current: number },
  confidenceGate: ChecklistConfidenceGate | undefined,
): PMNode {
  if (node.type.name === "list_item" && node.attrs.checked !== null) {
    const first = node.firstChild;
    if (first !== null && !isAlreadyReferenced(first)) {
      // This item's own ordinal — read before incrementing, so the FIRST
      // qualifying item this walk visits is ordinal 0, matching
      // `activeChecklistPromotion`'s own count in composer-editor.ts.
      const itemOrdinal = ordinal.current;
      ordinal.current += 1;

      const id = mintId();
      const text = flattenLabel(first);
      const demoted =
        activePromotion !== null && activePromotion.ordinal === itemOrdinal
          ? activePromotion.demoted
          : NO_DEMOTIONS;
      const parsed = parseChecklistLine(text, quickAddOptions, demoted, confidenceGate);
      const fields = taskFieldsFromQuickAdd(text, parsed, quickAddOptions);
      // A line entirely consumed by recognised tokens ("tomorrow p1" with
      // nothing else) parses to empty `content` — falling back to the
      // full flattened text here, rather than mint a Task with an empty
      // name, is the identical "never a Task that vanished as it was
      // typed" restraint quick-add-task.ts's own header comment already
      // states for the add field; `date`/`priority`/etc. below still
      // carry whatever the parse resolved, since the words are kept, not
      // discarded.
      const content = fields.content.trim() !== "" ? fields.content : text.trim();
      const checked = node.attrs.checked === true;
      tasks.push({
        id,
        checked,
        content,
        date: fields.date,
        deadline: fields.deadline,
        duration: fields.duration,
        priority: fields.priority,
        dateString: fields.dateString,
        labelNames: fields.labelNames,
      });
      const promotedFirst = entrySchema.node("paragraph", null, [
        entrySchema.node("task_reference", { taskId: id, label: content, checked }),
      ]);
      // Everything after the item's own first line — a nested list, most
      // often — is walked the same as any other node below, so a
      // checkbox nested several lists deep inside another item's own
      // trailing content is still found and promoted.
      const rest: PMNode[] = [];
      node.forEach((child, _offset, index) => {
        if (index > 0) {
          rest.push(
            transformNode(
              child,
              mintId,
              tasks,
              quickAddOptions,
              activePromotion,
              ordinal,
              confidenceGate,
            ),
          );
        }
      });
      return entrySchema.node("list_item", node.attrs, [promotedFirst, ...rest]);
    }
  }
  if (node.isLeaf) {
    return node;
  }
  const children: PMNode[] = [];
  node.forEach((child) => {
    children.push(
      transformNode(
        child,
        mintId,
        tasks,
        quickAddOptions,
        activePromotion,
        ordinal,
        confidenceGate,
      ),
    );
  });
  return node.copy(Fragment.fromArray(children));
}

/**
 * Sending an Entry containing a bare `- [ ]`/`- [x]` mints a Task for
 * each one and rewrites that line as a Reference — see this module's own
 * header comment for the loop guard, the parse this now applies, and why
 * the transform runs on the ProseMirror document rather than on `body` as
 * raw text. `mintId` is threaded in rather than called directly (`mintId`
 * from `@meologue/core`) so a test can supply a deterministic sequence
 * instead of real uuids. `quickAddOptions` is mandatory, not defaulted —
 * see the header comment's "keeping the parse in step with the
 * highlight." `activePromotion` defaults to `null`: every caller except
 * the live Composer (`use-history.ts`'s own fallback for a test or a
 * future non-Composer door) has no demotion to report and no ordinal
 * naming which item it would even apply to. `confidenceGate` (issue #174)
 * defaults to `undefined` — see `ChecklistConfidenceGate`'s own doc
 * comment; every caller reachable from a live Composer leaves it unset
 * and gets exactly today's behaviour, unchanged. `backfill-tasks.ts` is
 * the one caller that supplies it, for the one caller with no reader
 * watching to click a wrong guess back to plain text.
 */
export function promoteBareCheckboxes(
  body: string,
  mintId: () => string,
  quickAddOptions: QuickAddOptions,
  activePromotion: ActiveChecklistPromotion | null = null,
  confidenceGate?: ChecklistConfidenceGate,
): PromotionResult {
  const doc = entryMarkdownToDocument(body);
  const tasks: PromotedTask[] = [];
  const ordinal = { current: 0 };
  const promoted = transformNode(
    doc,
    mintId,
    tasks,
    quickAddOptions,
    activePromotion,
    ordinal,
    confidenceGate,
  );
  if (tasks.length === 0) {
    return { body, tasks: [] };
  }
  return { body: entryDocumentToMarkdown(promoted), tasks };
}
