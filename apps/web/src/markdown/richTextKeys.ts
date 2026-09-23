import { exitCode, newlineInCode, splitBlock } from "@tiptap/pm/commands";
import { NodeSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { openCodeFence } from "./tiptap";

/*
 * The keyboard of the rich text field: what Tab and Enter mean, depending on
 * where the caret is and what kind of field it is in (RichText.tsx says what
 * `inline` is). Everything a key does here it does BEFORE ProseMirror and
 * Tiptap's keymaps hear it; a rule that returns `false` hands the key back to
 * them.
 *
 * PRECEDENCE — the rules are tried top to bottom, and the first one whose
 * guard holds and whose action does not pass decides:
 *
 *   Tab (no Ctrl, Meta or Alt; Shift allowed)
 *     1. inside a fenced block      → false: Tiptap indents
 *     2. otherwise                  → the host's `onTab(shift)`; true when it
 *                                     took the key, false (leave the field)
 *                                     when it did not
 *   Enter (any modifiers)
 *     3. a formula is node-selected → open the formula dialog on it
 *     4. a hole chip is selected    → open the blank card on it
 *     5. inline, a fence line       → open the code block (plain Enter too)
 *     6. block, Ctrl/Cmd, a fence   → open the code block
 *     7. inline, inside a code block→ Ctrl/Cmd: leave the block; Shift: a
 *                                     newline in the code; plain: false
 *                                     (Tiptap's own Enter). Never falls
 *                                     through to 8 or 9.
 *     8. inline, Ctrl/Cmd/Shift     → split the paragraph (a second line)
 *     9. inline, the host has one   → the host's `onEnter`
 *   anything else                   → false
 *
 * Rules 5 and 6 run `openCodeFence` as their action: when it finds no fence
 * it changes nothing, and the dispatcher moves on to the next rule.
 */

/** What the key rules need from the field around them, read at keystroke time. */
export interface RichTextKeyDeps {
  /** The field is a row of a list (a choice), not a block of prose. */
  inline: boolean;
  /** The host's Tab: true when it took the key. */
  onTab: ((shift: boolean) => boolean) | undefined;
  /** The host's Enter, in an inline field. */
  onEnter: (() => void) | undefined;
  /** Opens the formula dialog on the math node at `pos`. */
  openMath: (pos: number, latex: unknown, typeName: string) => void;
  /** Opens the blank card on the hole at `pos`. */
  openHole: (pos: number, body: string, created: boolean) => void;
}

interface KeyContext {
  view: EditorView;
  event: KeyboardEvent;
  deps: RichTextKeyDeps;
}

/**
 * One rule of the table. `run` returns the handler's answer, or `PASS` to let
 * the next rule try — which only the fence rules do, since their guard is the
 * command itself.
 */
interface KeyRule {
  name: string;
  guard: (ctx: KeyContext) => boolean;
  run: (ctx: KeyContext) => boolean | typeof PASS;
}

const PASS = Symbol("pass");

/** The two node types a formula can be, as the schema names them. */
const MATH_TYPES = ["inlineMath", "blockMath"] as const;
export const isMathNode = (name: string): boolean =>
  (MATH_TYPES as readonly string[]).includes(name);

/** Whether the caret sits inside a fenced block, where every key means something else. */
export const inCodeBlock = (state: EditorState): boolean =>
  state.selection.$from.parent.type.name === "codeBlock";

const mod = (event: KeyboardEvent): boolean => event.ctrlKey || event.metaKey;

const plainTab = ({ event }: KeyContext): boolean =>
  event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey;

const enter = ({ event }: KeyContext): boolean => event.key === "Enter";

/** Takes the key away from ProseMirror AND from the listeners on `window`. */
function swallow(event: KeyboardEvent): true {
  event.preventDefault();
  event.stopPropagation();
  return true;
}

const KEYMAP: readonly KeyRule[] = [
  {
    // Inside a fenced block Tab is an INDENT — two spaces, or one level
    // back on Shift+Tab (`enableTabIndentation` in tiptap.ts). A teacher
    // writing C there is not asking for another choice.
    name: "tab-in-code",
    guard: (ctx) => plainTab(ctx) && inCodeBlock(ctx.view.state),
    run: () => false,
  },
  {
    // The host answers first (a list of choices adds a row, or moves on)
    // and says whether it took the key. Unhandled, Tab leaves the field,
    // which is what a keyboard user expects of a rich text box.
    name: "tab-host",
    guard: plainTab,
    run: ({ event, deps }) => {
      if (deps.onTab?.(event.shiftKey)) {
        event.preventDefault();
        return true;
      }
      return false;
    },
  },
  {
    // A formula is an atom: there is nothing to type into it, so Enter
    // on a selected one opens the editor that CAN change it.
    name: "enter-on-formula",
    guard: (ctx) => {
      const { selection } = ctx.view.state;
      return (
        enter(ctx) && selection instanceof NodeSelection && isMathNode(selection.node.type.name)
      );
    },
    run: ({ view, event, deps }) => {
      const selection = view.state.selection as NodeSelection;
      event.preventDefault();
      deps.openMath(selection.from, selection.node.attrs.latex, selection.node.type.name);
      return true;
    },
  },
  {
    // A hole is an atom too: Enter on the selected chip edits its body.
    name: "enter-on-hole",
    guard: (ctx) => {
      const { selection } = ctx.view.state;
      return (
        enter(ctx) &&
        selection instanceof NodeSelection &&
        selection.node.type.name === "clozeHole" &&
        selection.node.attrs.body !== null
      );
    },
    run: ({ view, event, deps }) => {
      const selection = view.state.selection as NodeSelection;
      event.preventDefault();
      deps.openHole(selection.from, String(selection.node.attrs.body ?? ""), false);
      return true;
    },
  },
  {
    /*
     * A FENCE opens, whichever of the three spellings the teacher used —
     * plain Enter included, because a line that is nothing but ``` or
     * ```c is not a choice waiting for the next one (tiptap.ts,
     * `openCodeFence`, which also closes a fence over what is above it).
     */
    name: "inline-fence",
    guard: (ctx) => enter(ctx) && ctx.deps.inline,
    run: ({ view, event }) =>
      openCodeFence(view.state, view.dispatch, true) ? swallow(event) : PASS,
  },
  {
    /*
     * The same thing on Ctrl+Enter in a BLOCK field, and here rather
     * than in the extension's keymap because only this handler has the
     * EVENT: the question editor answers Ctrl+Enter on `window` with
     * "Try the question", and a teacher who just opened a fence must not
     * be carried off to another tab. Plain Enter there is the input
     * rule's, which needs no such care.
     */
    name: "block-mod-fence",
    guard: (ctx) => enter(ctx) && !ctx.deps.inline && mod(ctx.event),
    run: ({ view, event }) =>
      openCodeFence(view.state, view.dispatch, false) ? swallow(event) : PASS,
  },
  {
    /*
     * INSIDE a block, Enter is a line of code and never the next choice.
     * Ctrl+Enter is the way OUT (a paragraph after the block), plain
     * Enter falls through to Tiptap — which is what keeps its own
     * three-empty-lines exit working — and Shift+Enter, which no keymap
     * binds inside code, is spelled out as the newline it looks like.
     */
    name: "inline-in-code",
    guard: (ctx) => enter(ctx) && ctx.deps.inline && inCodeBlock(ctx.view.state),
    run: ({ view, event }) => {
      if (mod(event)) {
        swallow(event);
        exitCode(view.state, view.dispatch);
        return true;
      }
      if (event.shiftKey) {
        swallow(event);
        newlineInCode(view.state, view.dispatch);
        return true;
      }
      return false;
    },
  },
  {
    /*
     * A SECOND LINE inside a choice. Plain Enter belongs to the host (it
     * moves to the next choice), so the modifier is what is left — and
     * both spellings answer, because a teacher who wants a line break
     * reaches for Shift+Enter and a developer for Ctrl+Enter.
     *
     * It splits the block rather than inserting a hard break: what a
     * choice is asked to hold is a snippet, and a fence cannot open
     * inside a paragraph. The new paragraph serializes as a blank line,
     * which is the markdown for exactly what is on screen.
     *
     * And STOPPED, not merely prevented: the question editor answers
     * Ctrl+Enter on `window` with "Try the question", and a teacher
     * who asked a choice for a second line must not be carried off to
     * another tab. The field publishes its own Ctrl+Enter in the
     * shortcut strip while it has the caret, so the strip says which
     * of the two is live.
     */
    name: "inline-second-line",
    guard: (ctx) => enter(ctx) && ctx.deps.inline && (mod(ctx.event) || ctx.event.shiftKey),
    run: ({ view, event }) => {
      swallow(event);
      splitBlock(view.state, view.dispatch);
      return true;
    },
  },
  {
    name: "inline-host-enter",
    guard: (ctx) => enter(ctx) && ctx.deps.inline && ctx.deps.onEnter !== undefined,
    run: ({ event, deps }) => {
      event.preventDefault();
      deps.onEnter?.();
      return true;
    },
  },
];

/**
 * `editorProps.handleKeyDown` of the rich text field: the first rule of
 * `KEYMAP` that applies decides, and a key no rule takes is ProseMirror's.
 */
export function handleRichTextKeyDown(
  view: EditorView,
  event: KeyboardEvent,
  deps: RichTextKeyDeps,
): boolean {
  const ctx: KeyContext = { view, event, deps };
  for (const rule of KEYMAP) {
    if (!rule.guard(ctx)) continue;
    const handled = rule.run(ctx);
    if (handled !== PASS) return handled;
  }
  return false;
}
