/**
 * The shared Task description editor — issue #229 (DET-11/DET-12).
 * Todoist's own reference (`docs/reference/todoist/lifecycle.md` §1) is a
 * `tiptap ProseMirror` editor with **no formatting toolbar anywhere** that
 * renders Markdown **live, as input rules** while typing: `**bold**`,
 * `` `code` ``, and a `- `/`* ` bullet marker. This file is the smallest
 * schema and plugin set that reproduces exactly those three, deliberately
 * not the whole of `entrySchema` (entry-schema.ts) — numbered lists,
 * checklists, References, headings and the rest are out of this ticket's
 * own scope (DET-12's own three named constructs), and `entrySchema`'s own
 * editor (`composer-editor.ts`) is ~69 KB gzip, an order of magnitude past
 * `task-detail-view.tsx`'s entire remaining bundle budget
 * (`check-bundle-size.mjs`'s own comment on this chunk has the number).
 *
 * **Why a bespoke schema, not `entrySchema`.** Same reasoning
 * `task-title-editor.tsx`'s own header comment gives for `taskTitleSchema`:
 * the smallest schema that is still genuinely ProseMirror. `list_item`
 * here holds `text*` directly (no nested `paragraph`, unlike
 * `entrySchema`'s own `itemContent`) — deliberately, so that a bullet
 * point is itself a textblock. That single choice is what lets `Enter`
 * inside a bullet create a new bullet via `baseKeymap`'s ordinary
 * `splitBlock` alone (`bullet_list`'s content `"list_item+"` already
 * accepts a second sibling item), with no need for
 * `prosemirror-schema-list`'s `splitListItem`/`liftListItem` commands —
 * those exist to split a `paragraph` *inside* a `list_item`, a problem
 * this schema never has because there is no inner `paragraph` to split.
 *
 * **Existing markdown text round-trips through this schema, not through
 * it.** A Description already on a Task (including one saved by the old
 * plain `<textarea>`, pre-#229) may contain constructs this schema has no
 * node for — a numbered list, a heading, a hand-typed reference. Rather
 * than lose or crash on that, `descriptionDocFromText` treats every line
 * that doesn't start with `- `/`* ` as its own literal paragraph (bold/
 * code marks aside) and never merges, drops or reflows a line — a
 * construct this schema can't represent renders as inert plain text, not
 * as a decoding error. `descriptionTextFromDoc` is its exact inverse, so a
 * round trip that never touched a bullet or a mark is byte-identical.
 *
 * **The bare-URL rewrite is not here, on purpose.** DET-13 (Todoist
 * fetches a bare URL's page title on save) is network-dependent and is
 * this app's own recorded divergence (`docs/reference/todoist/parity-ledger.md`,
 * DET-13, `divergent`) — nothing in this file recognises or rewrites a
 * URL at all.
 */
import { baseKeymap } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import { InputRule, inputRules } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { MarkType, Node as PMNode } from "prosemirror-model";
import { Schema } from "prosemirror-model";
import { EditorState, Plugin, Selection } from "prosemirror-state";
import { canJoin } from "prosemirror-transform";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * The smallest schema that reproduces DET-12's own three named constructs
 * — bold, a bullet list, inline code — and nothing else. See this file's
 * own header comment for why `list_item` holds `text*` directly rather
 * than `entrySchema`'s nested `paragraph`.
 */
export const descriptionSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "text*",
      group: "block",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    bullet_list: {
      content: "list_item+",
      group: "block",
      toDOM: () => ["ul", 0],
      parseDOM: [{ tag: "ul" }],
    },
    list_item: {
      content: "text*",
      toDOM: () => ["li", 0],
      parseDOM: [{ tag: "li" }],
    },
    text: { group: "inline" },
  },
  marks: {
    strong: {
      toDOM: () => ["strong", 0],
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
    },
    code: {
      toDOM: () => ["code", 0],
      parseDOM: [{ tag: "code" }],
    },
  },
});

const strongMarkType: MarkType = descriptionSchema.marks.strong as MarkType;
const codeMarkType: MarkType = descriptionSchema.marks.code as MarkType;
const paragraphType = descriptionSchema.nodes.paragraph;
const bulletListType = descriptionSchema.nodes.bullet_list;
const listItemType = descriptionSchema.nodes.list_item;

/**
 * Tokenises one line's own text into runs of at most one mark each —
 * `**bold**` and `` `code` ``, non-overlapping, never nested (DET-12 names
 * only these two marks; a construct outside them, or one nested inside
 * another, is left as literal text rather than mis-parsed).
 */
function parseInlineRuns(text: string): { text: string; mark: MarkType | null }[] {
  const runs: { text: string; mark: MarkType | null }[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      runs.push({ text: text.slice(lastIndex, match.index), mark: null });
    }
    if (match[1] !== undefined) {
      runs.push({ text: match[1], mark: strongMarkType });
    } else if (match[2] !== undefined) {
      runs.push({ text: match[2], mark: codeMarkType });
    }
    lastIndex = pattern.lastIndex;
    match = pattern.exec(text);
  }
  if (lastIndex < text.length) {
    runs.push({ text: text.slice(lastIndex), mark: null });
  }
  return runs;
}

function inlineNodes(text: string): PMNode[] {
  if (text.length === 0) {
    return [];
  }
  return parseInlineRuns(text)
    .filter((run) => run.text.length > 0)
    .map((run) => descriptionSchema.text(run.text, run.mark ? [run.mark.create()] : undefined));
}

const BULLET_LINE = /^[-*]\s+(.*)$/;

/**
 * Markdown text → a `descriptionSchema` document — one input line per
 * paragraph (an empty line becomes an empty paragraph, so nothing is ever
 * merged or dropped), except a run of consecutive `- `/`* ` lines, which
 * becomes one `bullet_list` of `list_item`s. This file's own header
 * comment explains why anything outside bold/code/bullet stays literal
 * rather than failing to parse.
 */
export function descriptionDocFromText(text: string): PMNode {
  const lines = text.length === 0 ? [] : text.split("\n");
  const blocks: PMNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const bulletMatch = BULLET_LINE.exec(line);
    if (bulletMatch) {
      const items: PMNode[] = [];
      while (i < lines.length) {
        const currentMatch = BULLET_LINE.exec(lines[i] ?? "");
        if (!currentMatch) {
          break;
        }
        items.push(listItemType.create(null, inlineNodes(currentMatch[1] ?? "")));
        i++;
      }
      blocks.push(bulletListType.create(null, items));
      continue;
    }
    blocks.push(paragraphType.create(null, inlineNodes(line)));
    i++;
  }
  if (blocks.length === 0) {
    blocks.push(paragraphType.create());
  }
  return descriptionSchema.node("doc", null, blocks);
}

function inlineText(node: PMNode): string {
  let out = "";
  node.forEach((child) => {
    let text = child.text ?? "";
    if (child.marks.some((mark) => mark.type === codeMarkType)) {
      text = `\`${text}\``;
    } else if (child.marks.some((mark) => mark.type === strongMarkType)) {
      text = `**${text}**`;
    }
    out += text;
  });
  return out;
}

/** The exact inverse of `descriptionDocFromText` — this file's own header comment on why a round trip that never touched a bullet or a mark is byte-identical. */
export function descriptionTextFromDoc(doc: PMNode): string {
  const lines: string[] = [];
  doc.forEach((block) => {
    if (block.type === bulletListType) {
      block.forEach((item) => {
        lines.push(`- ${inlineText(item)}`);
      });
    } else {
      lines.push(inlineText(block));
    }
  });
  return lines.join("\n");
}

function isEmptyDoc(doc: PMNode): boolean {
  return doc.childCount === 1 && doc.firstChild?.type === paragraphType && doc.content.size === 2;
}

/**
 * Toggles `markType` onto whatever `regexp`'s one capture group matched,
 * deleting the delimiter characters around it — the hand-written
 * mark-toggle `composer-editor.ts`'s own `markInputRule` already
 * establishes as this repo's pattern (that file's own header comment: not
 * a second Markdown parser, just the one piece of `prosemirror-inputrules`
 * a mark toggle needs), reproduced here in miniature rather than imported,
 * since importing from `composer-editor.ts` would pull its entire ~69 KB
 * module into this chunk for one function.
 */
function markInputRule(regexp: RegExp, markType: MarkType): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const captured = match[1];
    if (captured === undefined || captured.trim() === "") {
      return null;
    }
    const openLength = match[0].indexOf(captured);
    const tr = state.tr;
    tr.delete(start + openLength + captured.length, end);
    tr.delete(start, start + openLength);
    return tr.addMark(start, start + captured.length, markType.create()).removeStoredMark(markType);
  });
}

const strongInputRule = markInputRule(/\*\*([^*]+)\*\*$/, strongMarkType);
const codeInputRule = markInputRule(/`([^`]+)`$/, codeMarkType);

/**
 * `- `/`* ` at the very start of a plain paragraph converts that paragraph
 * into a one-item `bullet_list`, joining it into an immediately preceding
 * `bullet_list` when one is already there (`canJoin` below) — the same
 * "typing the marker on the very next line continues the same list, not a
 * second adjacent one" behaviour `entrySchema`'s own `bulletListInputRule`
 * (composer-editor.ts) gives via `wrappingInputRule`. This can't reuse
 * `wrappingInputRule` itself: that helper wraps the matched node in new
 * ancestors while leaving its own type alone, which only works when
 * `list_item`'s content already accepts a `paragraph` child
 * (`entrySchema`'s own nested shape) — this schema's `list_item` holds
 * `text*` directly (this file's own header comment on why), so converting
 * a `paragraph` into one is a type change, not a wrap, and needs its own
 * `replaceWith`.
 */
const bulletListInputRule = new InputRule(/^[-*]\s$/, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  if ($start.parent.type !== paragraphType) {
    return null;
  }
  const rest = $start.parent.content.cut(end - start);
  const listItem = listItemType.create(null, rest);
  const tr = state.tr.replaceWith(
    $start.before(),
    $start.after(),
    bulletListType.create(null, [listItem]),
  );
  const joinPos = $start.before();
  if (canJoin(tr.doc, joinPos)) {
    tr.join(joinPos);
  }
  return tr;
});

function placeholderPlugin(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        if (!isEmptyDoc(state.doc)) {
          return DecorationSet.empty;
        }
        const widget = document.createElement("span");
        widget.className = "pointer-events-none select-none text-muted-foreground";
        widget.textContent = text;
        return DecorationSet.create(state.doc, [Decoration.widget(1, widget)]);
      },
    },
  });
}

export interface TaskDescriptionEditorProps {
  /** The description's starting Markdown text — read once, at mount, exactly as `TaskTitleEditor`'s own `value` prop is (that component's own doc comment: every caller mounts this fresh exactly when editing begins). */
  value: string;
  /** Fires on every transaction that changes the document, handing back Markdown text (`descriptionTextFromDoc`) — the live draft a caller's own Save button reads, mirroring `TaskTitleEditor`'s identical `onChange`. */
  onChange: (value: string) => void;
  /** Escape — the caller's job is to discard the whole combined edit form (title and description together, DET-09), exactly as `TaskTitleEditor`'s own `onCancel` does for the title half. */
  onCancel: () => void;
  /** Defaults to `"Description"` — DET-11's own verbatim placeholder wording. */
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

/**
 * The shared Task description editor — this file's own header comment
 * carries the full rationale. Wired up imperatively, mirroring
 * `TaskTitleEditor`'s own `EditorView` lifecycle (that component's own doc
 * comment has the general reasoning). Always rendered behind
 * `LazyTaskDescriptionEditor` (`lazy-task-description-editor.ts`), never
 * imported statically from `task-detail-view.tsx` itself.
 */
export function TaskDescriptionEditor({
  value,
  onChange,
  onCancel,
  placeholder = "Description",
  autoFocus = true,
  className,
}: TaskDescriptionEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // Mount-only, mirroring TaskTitleEditor's identical effect: `value`,
  // `placeholder` and `autoFocus` are read exactly once, at construction.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately mount-only, matching task-title-editor.tsx's own EditorView effect.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    const doc = descriptionDocFromText(value);
    const state = EditorState.create({
      schema: descriptionSchema,
      doc,
      selection: Selection.atEnd(doc),
      plugins: [
        keymap({
          Escape: () => {
            onCancelRef.current();
            return true;
          },
        }),
        keymap({ "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo }),
        inputRules({ rules: [strongInputRule, codeInputRule, bulletListInputRule] }),
        keymap(baseKeymap),
        placeholderPlugin(placeholder),
      ],
    });

    const view = new EditorView(
      { mount: host },
      {
        state,
        attributes: () => ({
          class: cn("tiptap", className),
          role: "textbox",
          "aria-label": "Description",
          "aria-multiline": "true",
        }),
        dispatchTransaction: (tr) => {
          const current = viewRef.current;
          if (current === null) {
            return;
          }
          const nextState = current.state.apply(tr);
          current.updateState(nextState);
          if (tr.docChanged) {
            onChangeRef.current(descriptionTextFromDoc(nextState.doc));
          }
        },
      },
    );
    viewRef.current = view;
    if (autoFocus) {
      view.focus();
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  return <div ref={hostRef} />;
}
