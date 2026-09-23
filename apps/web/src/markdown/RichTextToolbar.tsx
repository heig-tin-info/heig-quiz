import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import {
  Bold,
  Code,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  RectangleEllipsis,
  Sigma,
  SquareCode,
  Table as TableIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { RichTextShortcut } from "@quiz/core/client";

import { useT } from "../i18n";
import { useShortcuts, type Shortcut } from "../shortcuts";
import { IconButton, modKey, type IconType } from "../ui";
import { isMathNode } from "./richTextKeys";
import { TableMenu } from "./RichTextPopovers";
import type { FormulaTarget } from "./useFormulaTarget";

/*
 * The toolbar of the rich text field: which actions a mode offers, what they
 * do, which of them is pressed, and the shortcut strip the field publishes
 * while it has the caret. RichText.tsx decides WHERE the row is drawn (above a
 * block field, inside an inline one while it has the caret).
 */

/** One toolbar action; `toolbarActions` filters out the ones a mode cannot serve. */
interface Action {
  key: string;
  icon: IconType;
  labelKey:
    | "md.bold"
    | "md.italic"
    | "md.code"
    | "md.codeBlock"
    | "md.math"
    | "md.image"
    | "md.link"
    | "md.table"
    | "md.blank.insert";
  shortcut?: string;
}

/** Which marks the caret sits in, keyed like the actions (plus `inTable`). */
export type RichTextMarks = Partial<Record<string, boolean>>;

/** The actions the toolbar of a field in this mode offers, in order. */
export function toolbarActions(mode: {
  showImage: boolean;
  holes: boolean;
  inline: boolean;
}): Action[] {
  /** Every action the toolbar can offer, before the mode filters it. */
  const ACTIONS: Action[] = [
    { key: "bold", icon: Bold, labelKey: "md.bold", shortcut: `${modKey()}+B` },
    { key: "italic", icon: Italic, labelKey: "md.italic", shortcut: `${modKey()}+I` },
    { key: "code", icon: Code, labelKey: "md.code" },
    { key: "codeBlock", icon: SquareCode, labelKey: "md.codeBlock" },
    { key: "math", icon: Sigma, labelKey: "md.math" },
    { key: "image", icon: ImageIcon, labelKey: "md.image" },
    { key: "table", icon: TableIcon, labelKey: "md.table" },
    { key: "link", icon: LinkIcon, labelKey: "md.link" },
    // Only a cloze field has holes, and only there is the button drawn.
    { key: "blank", icon: RectangleEllipsis, labelKey: "md.blank.insert", shortcut: "{{" },
  ];

  return ACTIONS.filter(
    (a) =>
      (a.key !== "image" || mode.showImage) &&
      (a.key !== "blank" || mode.holes) &&
      // A one-paragraph field has nowhere to put a fenced block, and a table
      // in a row of a list is a shape no one asked a CHOICE for. The schema
      // still knows both, so a stored one is never dropped (tiptap.ts).
      ((a.key !== "codeBlock" && a.key !== "table") || !mode.inline),
  );
}

/*
 * Which marks the caret sits in, for the pressed state of the toolbar.
 * `useEditorState` and not `shouldRerenderOnTransaction`: the second
 * re-renders this component on every keystroke, which in a long prompt is
 * the whole document reconciled per character.
 */
export function useRichTextMarks(editor: Editor | null): RichTextMarks {
  return useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e === null
        ? {}
        : {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            code: e.isActive("code"),
            codeBlock: e.isActive("codeBlock"),
            math: e.isActive("inlineMath") || e.isActive("blockMath"),
            link: e.isActive("link"),
            // Not `table`, which is a toolbar ACTION key: a caret inside a
            // table must not light the "insert a table" button up.
            inTable: e.isActive("table"),
          },
  }) as RichTextMarks;
}

/*
 * What the app's shortcut strip shows while the caret is in this field: the
 * two formatting keys every rich field answers to, plus whatever the host
 * added (a list of choices answers Tab and Enter). Registered on focus, so
 * the strip follows the caret and not merely the screen.
 */
/*
 * INSIDE A FENCED BLOCK the strip says something else entirely, and it has
 * to: Enter is a line of code and not the next choice, Tab is an indent and
 * not a new row, and a host's "Tab — Add a choice" would be a lie while the
 * caret is in there. The marks are dropped with them — a code block carries
 * none, so Ctrl+B does nothing in it.
 */
export function useRichTextShortcuts({
  inCode,
  inline,
  holes,
  shortcuts,
  focused,
  disabled,
  source,
}: {
  inCode: boolean;
  inline: boolean;
  holes: boolean;
  shortcuts: readonly RichTextShortcut[];
  /** The strip follows the caret, and stays silent in a disabled field and in the source pane. */
  focused: boolean;
  disabled: boolean;
  source: boolean;
}): void {
  const t = useT();
  const live: Shortcut[] = inCode
    ? [
        ...(inline
          ? [
              { keys: "Enter", label: t("md.code.newLine") },
              { keys: `${modKey()}+Enter`, label: t("md.code.leave") },
            ]
          : []),
        { keys: "Tab", label: t("md.code.indent") },
      ]
    : [
        { keys: `${modKey()}+B`, label: t("md.bold") },
        { keys: `${modKey()}+I`, label: t("md.italic") },
        // Only an inline field: a block field splits its paragraph on plain
        // Enter, and teaching a second key for the same thing is noise.
        ...(inline ? [{ keys: `${modKey()}+Enter`, label: t("md.newLine") }] : []),
        ...(holes ? [{ keys: "{{", label: t("md.blank.insert") }] : []),
        ...shortcuts.map((s) => ({ keys: s.keys, label: s.label })),
      ];
  useShortcuts(live, focused && !disabled && !source);
}

/** What a toolbar action reaches outside the editor. */
export interface ToolbarActionDeps {
  /** Opens the file picker of the image button. */
  pickImage: () => void;
  /** Opens the formula dialog on the math node at `pos`. */
  openMath: (pos: number, latex: unknown, typeName: string) => void;
  /** Opens the formula dialog on `target`. */
  openFormula: (target: FormulaTarget) => Promise<void>;
  /** Opens the link prompt, prefilled with `initial`. */
  askLink: (initial: string) => void;
}

type ActionRunner = (editor: Editor, deps: ToolbarActionDeps) => void;

/** What each toolbar button does, keyed like `toolbarActions`. */
const RUNNERS: Record<string, ActionRunner> = {
  bold: (editor) => {
    editor.chain().focus().toggleBold().run();
  },
  italic: (editor) => {
    editor.chain().focus().toggleItalic().run();
  },
  code: (editor) => {
    editor.chain().focus().toggleCode().run();
  },
  codeBlock: (editor) => {
    editor.chain().focus().toggleCodeBlock().run();
  },
  image: (_editor, deps) => deps.pickImage(),
  table: (editor) => {
    // Three by three with a header row: the shape a teacher draws on a
    // slide, and the one GFM writes with the least ceremony.
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  },
  math: (editor, deps) => {
    const { selection } = editor.state;
    if (selection instanceof NodeSelection && isMathNode(selection.node.type.name)) {
      deps.openMath(selection.from, selection.node.attrs.latex, selection.node.type.name);
      return;
    }
    // A selected run of text is what the formula starts from: select
    // `x^2`, press Σ, and it is already in the dialog.
    const text = editor.state.doc.textBetween(selection.from, selection.to);
    void deps.openFormula({
      latex: text,
      display: false,
      node: null,
      range: selection.empty ? null : { from: selection.from, to: selection.to },
      created: false,
    });
  },
  blank: (editor) => {
    /*
     * An EMPTY chip, which `onUpdate` opens the card on at once — the very
     * path typing `{{` takes, so the button and the two braces cannot end
     * up meaning two different things.
     */
    editor.chain().focus().insertContent({ type: "clozeHole", attrs: { body: "" } }).run();
  },
  link: (editor, deps) => {
    const href = editor.getAttributes("link").href;
    deps.askLink(typeof href === "string" ? href : "");
  },
};

/** Runs the toolbar action `key` on `editor`; an unknown key does nothing. */
export function runToolbarAction(
  editor: Editor | null,
  key: string,
  deps: ToolbarActionDeps,
): void {
  if (!editor) return;
  RUNNERS[key]?.(editor, deps);
}

/** The row of actions, drawn the same above a block field and inside an inline one. */
export function RichTextToolbar({
  fieldId,
  editor,
  marks,
  actions,
  disabled,
  uploading,
  sourceButton,
  onRun,
}: {
  fieldId: string;
  editor: Editor | null;
  marks: RichTextMarks;
  actions: Action[];
  disabled: boolean;
  uploading: number;
  sourceButton: ReactNode;
  onRun: (key: string) => void;
}) {
  const t = useT();

  /** The table menu, drawn only while the caret is in a table (RichTextPopovers.tsx). */
  const tableMenu =
    marks.inTable === true && !disabled && editor !== null ? <TableMenu editor={editor} /> : null;

  return (
    <div
      role="toolbar"
      aria-label={t("md.toolbar")}
      aria-controls={fieldId}
      className="flex flex-wrap items-center gap-0.5"
    >
      {actions.map((a) => (
        <IconButton
          key={a.key}
          size="sm"
          label={a.shortcut ? `${t(a.labelKey)} (${a.shortcut})` : t(a.labelKey)}
          // A code block carries no mark and holds no node: bold, a formula
          // and a picture cannot land in one. The fence toggle stays, since it
          // is the way back out of the block.
          disabled={
            disabled || editor === null || (marks.codeBlock === true && a.key !== "codeBlock")
          }
          {...(marks[a.key] === undefined ? {} : { active: marks[a.key] })}
          // The toolbar of an inline field lives INSIDE it: pressing a button
          // must format the selection, not take the caret out of the row.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onRun(a.key)}
        >
          <a.icon />
        </IconButton>
      ))}
      {tableMenu}
      {sourceButton}
      {uploading > 0 ? (
        <span role="status" className="ml-1 text-xs text-fg-muted">
          {t("md.uploading")}
        </span>
      ) : null}
    </div>
  );
}
