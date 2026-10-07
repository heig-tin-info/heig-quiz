/**
 * The browser half of the question-type contract (PLAN-MVP §1.4).
 *
 * React appears here as TYPES ONLY: `import type` is erased by
 * `verbatimModuleSyntax`, so `@quiz/core/server` never pulls React into the API
 * bundle, and this module adds no runtime import either.
 */
import type { ComponentType, LazyExoticComponent, ReactNode } from "react";
import type { QuestionTypeId } from "./contract.js";

export interface EditorProps<TConfig> {
  config: TConfig;
  /** The host merges, validates lazily and autosaves the draft. */
  onChange: (next: TConfig) => void;
  /** Uploads an image and returns `asset:<uuid>` for the markdown. */
  uploadAsset: (file: File) => Promise<string>;
  disabled?: boolean;
  /**
   * The host's WYSIWYG markdown editor (`apps/web/src/markdown/RichText.tsx`),
   * injected exactly as `renderMarkdown` is and for the same reason: a `qt-*`
   * package cannot depend on `apps/web`, and the editor carries Tiptap,
   * ProseMirror and KaTeX — a dependency four leaf packages have no business
   * declaring four times.
   *
   * Absent, an editor falls back to its plain textarea or input. That is not a
   * degraded mode to be removed later: it is what keeps the package's own test
   * suite free of a DOM-heavy editor, and what a host with no Tiptap build
   * gets. The stored value is markdown either way (docs/spec/05 §5.10).
   */
  RichText?: RichTextComponent;
  /**
   * The host's contextual help, injected for the same reason `RichText` is: a
   * `qt-*` package cannot import `apps/web/src/help.tsx`, and the "?" that
   * opens a topic is part of the app's chrome, not of the question type.
   *
   * The editor calls it with a TOPIC NAME (`"mcq-policies"`) and places what
   * comes back beside the label it documents. Absent, the editor simply shows
   * no "?" — the label and the one-line description still say what the field
   * does, so nothing is lost but the long form.
   */
  renderHelp?: (topic: string) => ReactNode;
  /**
   * A host-provided element the editor MAY portal its settings into, lent for
   * the same reason `RichText` and `renderHelp` are: where a setting belongs
   * on the page is the host's layout decision, not the question type's.
   *
   * The question editor of `apps/web` puts it in the right column, under the
   * "Properties" card, so the scoring of a question sits with what the
   * question IS rather than in the middle of what it SAYS. An editor that
   * uses it renders that block through `createPortal` when the element is
   * there, and INLINE when it is not — a host without an aside (another app,
   * a test) must still show every setting. It arrives as `null` on the first
   * render, since the host only holds the element after its own layout is
   * mounted, so it is state on the host side and a re-render here.
   */
  aside?: HTMLElement | null;
  /**
   * The host gives no marks: a live poll written in the launcher (ADR-014,
   * addendum 2026-09-23). The editor then leaves out every setting that only
   * decides a MARK — a scoring policy, a points field, a normalisation of the
   * comparison — and keeps what the room reads and the key the teacher
   * reveals, which is OPTIONAL there (`keylessConfigSchema`): an editor lets
   * the last row of a key go. An editor with nothing of the kind simply
   * ignores it.
   */
  ungraded?: boolean;
  /**
   * The question has a published version. A setting that changes what an
   * answer IS — the notation of a `diagram` (ADR-046 addendum) — is locked
   * then: the answers given to a published version must keep meaning what
   * they meant. An editor with no such setting ignores it.
   */
  published?: boolean;
  /**
   * The host's EXPAND layer, lent to an editor for the reason it is lent to a
   * player (`PlayerProps.Expand`): a canvas of the `diagram` or `circuit`
   * editor (the reference, the starter) opens in it, over the page with a
   * small margin, under a thin bar of the host's — what is being edited
   * (`ExpandProps.title`), the draft's save state where the host knows it,
   * and "Close". Absent, the editor offers no Expand button. Every other
   * type ignores it.
   */
  Expand?: ComponentType<ExpandProps>;
  /**
   * The host's shortcut zone, lent to a canvas editor (`circuit`, `diagram`)
   * for the reason `RichText` is: the app's registry of live keys
   * (`apps/web/src/shortcuts.tsx`) and its Ctrl/⌘ spelling are the app's
   * chrome, which a package cannot import (issue #549, ADR-046 addendum
   * 2026-10-07).
   *
   * An EDITABLE canvas calls it with its few grouped lines while the focus
   * is in it — and not in one of its text fields — and with `null` when the
   * focus leaves. A read-only canvas never calls it. Absent (grading, review,
   * a test), nothing is shown anywhere. Every other type ignores it.
   */
  onCanvasShortcuts?: CanvasShortcutsListener;
  /**
   * The wand of ONE element of the type's list ("Generate answers",
   * ADR-059): the host asks the model for the element at `index`, which must
   * be empty, and hands the result back through `onChange`. It resolves once
   * applied, or rejects (the host has already said why). Absent — no model,
   * or a type the host does not offer it for — the editor shows no wand.
   */
  onGenerateItem?: (index: number) => Promise<void>;
}

/**
 * One shortcut a focused rich-text field contributes to the app's shortcut
 * strip. Structural, not imported: `apps/web/src/shortcuts.tsx` owns the
 * registry, and a `qt-*` package only describes the two keys its inline field
 * answers to ("Tab: add a choice").
 */
export interface RichTextShortcut {
  /** As shown: "Ctrl+B", "Tab", "Enter". The host spells Ctrl/⌘. */
  keys: string;
  /** Translated and short. */
  label: string;
}

/**
 * One line a focused canvas contributes to the host's shortcut zone
 * (`EditorProps.onCanvasShortcuts`). Structural, like `RichTextShortcut`: the
 * host owns the registry and draws the keys.
 */
export interface CanvasShortcut {
  /**
   * The keys of ONE action, as alternatives, each written as caps joined by
   * "+": `["Mod+Z", "Mod+Y"]`, `["R", "H", "V"]`, `["1–9"]`. `Mod` is the
   * platform's command key, which the host spells Ctrl or ⌘.
   */
  keys: readonly string[];
  /** Translated and short: "Undo / Redo". */
  label: string;
}

/** The canvas's lines while it has the focus, `null` once it has not. */
export type CanvasShortcutsListener = (list: readonly CanvasShortcut[] | null) => void;

/** Where the rich editor puts its toolbar (`RichTextProps.toolbar`). */
export type RichTextToolbar = "always" | "focus" | "never";

/**
 * The props of the host's rich-text editor. Its interface is a MARKDOWN
 * STRING in and a markdown string out: the WYSIWYG surface is a rendering of
 * the stored value, never a second source of truth.
 */
export interface RichTextProps {
  /** Markdown. The editor parses it once and re-parses it when it changes underneath. */
  value: string;
  /** Called only when the serialized markdown actually differs from `value`. */
  onChange: (markdown: string) => void;
  /**
   * One paragraph, no block nodes: a choice of an mcq, a cell of a table.
   * Enter does not split the paragraph, it calls `onEnter`.
   */
  inline?: boolean;
  placeholder?: string;
  /** Accessible name of the editing surface. */
  "aria-label"?: string;
  /** Set on the contenteditable element itself, so a host can focus it by id. */
  id?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  /** `inline` only: Enter, which a list of choices uses to reach the next row. */
  onEnter?: () => void;
  /** Tab inside the surface. Return true when handled; false lets focus leave. */
  onTab?: (shift: boolean) => boolean;
  /**
   * Uploads a pasted, dropped or picked image and returns `asset:<id>`. The
   * image affordances are hidden when it is absent: a button that cannot work
   * is worse than one that is not there.
   */
  uploadImage?: (file: File) => Promise<string>;
  /**
   * Where the toolbar lives. `"always"` (the default) keeps it above the
   * field; `"focus"` shows a compact one INSIDE the field while it has the
   * caret, which is what an inline row of choices wants — a toolbar per row,
   * always visible, is a wall of icons; `"never"` hides it altogether.
   * Ctrl+B / Ctrl+I work in all three.
   */
  toolbar?: RichTextToolbar;
  /**
   * The last button of the toolbar swaps the surface for the markdown source
   * and back. Default true for a block field, false for an inline one (a
   * choice has no room for a second pane). Ignored when there is no toolbar.
   */
  sourceToggle?: boolean;
  /**
   * Extra shortcuts to publish while this field has the focus, on top of the
   * formatting ones it registers itself. A list of choices passes the two keys
   * it answers to, so the app's strip shows them wherever the caret is.
   */
  shortcuts?: readonly RichTextShortcut[];
  /**
   * The `{{…}}` holes of the `cloze` type are objects in this field rather
   * than characters: a chip the teacher clicks to edit, serialized back
   * VERBATIM. Off everywhere else, because `{{` is two ordinary braces in a
   * prompt and a `{{` input rule in an mcq choice would be a trap.
   */
  holes?: boolean;
  /**
   * A block field's minimum height, in lines of its text — a textarea's
   * `rows`. Absent, a block field is sized for a prompt (128 px); an essay
   * asks for more (issue #267). Ignored by an inline field, which grows with
   * what it holds.
   */
  rows?: number;
}

export type RichTextComponent = ComponentType<RichTextProps>;

export interface PlayerProps<TStudent, TAnswer> {
  student: TStudent;
  answer: TAnswer | null;
  onChange: (next: TAnswer) => void;
  /** Read-only when the attempt is submitted / paused / expired. */
  readOnly: boolean;
  /** Code type only: interactive run through `POST /attempts/:id/run`. */
  run?: (payload: unknown) => Promise<unknown>;
  /**
   * The host's WYSIWYG markdown editor, lent to a player for the reason it is
   * lent to an editor (`EditorProps.RichText`): the `rich` type's formatted
   * answer field (issue #192). A player that has no such field ignores it;
   * absent, a player falls back to a textarea of markdown source. The host
   * lends it WITHOUT an image upload: a student's answer carries no image.
   */
  RichText?: RichTextComponent;
  /**
   * The player holds an edit back from `onChange` because the server would
   * refuse it (issue #267: the `rich` field over its limit). The player
   * calls it with `true` while what is on screen is not what it sent, and
   * with `false` once they match again. The host then stops saying "Saved"
   * for this edit. A player that never holds anything back does not call it,
   * and a host that saves nothing need not pass it. It is called with
   * `false` when the player unmounts, so the host never keeps a stale flag.
   */
  onUnsent?: (unsent: boolean) => void;
  /**
   * The host's EXPAND layer, lent for the reason `RichText` is: a player that
   * needs more room than the question card — the `diagram` and `circuit`
   * canvases (ADR-046 §6 and addendum) — draws in it, and the layer is part
   * of the app's chrome, which a package cannot import. It covers the page
   * with a small margin and keeps a thin bar of the host's own (in an attempt:
   * the server's clock, the save state, the way back); it is a layer of the
   * page, never the browser's full screen.
   *
   * The player renders it with `open`, a `title` and its content as
   * `children`, and the host calls `onClose` (the bar's button, Escape, a
   * move to another question). Absent — the grading panel — the player offers
   * no Expand button at all. Every other type ignores it.
   */
  Expand?: ComponentType<ExpandProps>;
  /** The host's shortcut zone (`EditorProps.onCanvasShortcuts`): the student's side column. */
  onCanvasShortcuts?: CanvasShortcutsListener;
}

/** The props of the host's expand layer (`PlayerProps.Expand`, `EditorProps.Expand`). */
export interface ExpandProps {
  open: boolean;
  onClose: () => void;
  /**
   * What the layer holds, in the caller's words ("Reference diagram"): the
   * editor's layer shows it in its bar, and a host may name the layer by it.
   */
  title: string;
  children: ReactNode;
}

export interface ReviewProps<TStudent, TAnswer, TSolution, TDetails> {
  student: TStudent;
  answer: TAnswer | null;
  /** `null` when the feedback policy hides the key. */
  solution: TSolution | null;
  details: TDetails | null;
  points: number | null;
  maxPoints: number;
  /** "teacher" shows everything; "student" respects the already-applied filtering. */
  audience: "teacher" | "student";
  /**
   * Which of the question's own parts to draw beside the student's answer
   * (#109): the grading page lets a teacher declutter the screen down to the
   * answers alone. Absent, or a part absent from it, means SHOWN — a review
   * that ignores this prop is still correct, only less tidy. It never hides
   * the student's answer nor the verdict on it: those are what is graded.
   */
  sections?: ReviewSections;
}

/**
 * The parts of a review a reader may choose to hide. `false` hides; `true`
 * and `undefined` show.
 *
 * - `prompt`: the statement of the question (for `cloze`, the text with the
 *   blanks in place — the per-blank table still gives every answer).
 * - `solution`: what the teacher expected — the accepted answers, the
 *   missed choices, the reference program or circuit. The verdict on what
 *   the student gave stays.
 */
export interface ReviewSections {
  prompt?: boolean;
  solution?: boolean;
}

/** Whether `part` is drawn under `sections`: shown unless explicitly `false`. */
export function showsSection(
  sections: ReviewSections | undefined,
  part: keyof ReviewSections,
): boolean {
  return sections?.[part] !== false;
}

export interface QuestionTypeClient<
  TConfig = unknown,
  TAnswer = unknown,
  TStudent = unknown,
  TSolution = unknown,
  TDetails = unknown,
> {
  readonly id: QuestionTypeId;
  /** i18n keys, not literals: "qt.mcq.label", "qt.mcq.hint". */
  readonly labelKey: string;
  readonly hintKey: string;
  readonly Icon: ComponentType<{ className?: string }>;
  /**
   * The player wants more than the reading column — a need, not a layout
   * (ADR-066). On a wide screen the host gives such a question the room it
   * has, and the player arranges itself by its OWN width (a container query,
   * never the viewport's), so a narrow host gets the narrow layout. Absent,
   * the question keeps the host's reading column.
   */
  readonly wide?: boolean;

  /** `React.lazy`, so `qt-code` (Monaco) never enters the initial bundle (N-PERF-05). */
  readonly Editor: LazyExoticComponent<ComponentType<EditorProps<TConfig>>>;
  readonly Player: LazyExoticComponent<ComponentType<PlayerProps<TStudent, TAnswer>>>;
  readonly Review: LazyExoticComponent<ComponentType<ReviewProps<TStudent, TAnswer, TSolution, TDetails>>>;

  /** Empty answer for a fresh item (e.g. `{ selected: [] }`). */
  emptyAnswer(student: TStudent): TAnswer;
  /**
   * Drives the "empty / seen / done" progress segments (F-LIVE-09): the same
   * predicate as the server's `isAnswered`. The host answers "no" for a
   * missing answer itself, so `answer` is never `null` here.
   */
  isAnswered(answer: TAnswer): boolean;
  /**
   * One line for the cell tooltip of the dashboard, for an answer the host
   * cannot read as text by itself (a schematic). Omitting it leaves the host
   * the server's `summarizeAnswer` of the cell.
   */
  summarize?(answer: TAnswer | null, student: TStudent): string;
  /**
   * The columns this type gives the grading table (ADR-044): one table per
   * question, a row per answer, and the answer spread over columns a teacher
   * can scan and sort — a choice per column, a blank per column. REQUIRED:
   * the host has no column of its own to fall back on, so a type without
   * columns does not compile.
   */
  readonly grading: QuestionTypeGrading<TStudent, TAnswer, TSolution, TDetails>;
}

/**
 * What one answer of the grading table carries into a cell. `details` is the
 * standing grading's breakdown (`null` before the pass settled the cell), so
 * a cell may say which part was right; `answer` is `null` for a student who
 * gave none.
 */
export interface GradingCellInput<TAnswer, TDetails> {
  answer: TAnswer | null;
  details: TDetails | null;
}

/**
 * One column of the grading table.
 *
 * A column is keyed by the CANONICAL identity of what it shows (the choice's
 * canonical index, the blank's index), never by a position a shuffle decided:
 * the grading queue sends every view with `shuffle: false`, so row after row
 * the same column is the same choice. The key of the question reaches a
 * column once, through `columns()`.
 *
 * The cells are functions returning nodes rather than components: the type's
 * client module already imports React, and this module only names the type.
 */
export interface GradingColumn<TAnswer = unknown, TDetails = unknown> {
  /** Stable within the question: the sort of the table is keyed on it. */
  readonly key: string;
  /** Plain text and short ("A · Une adresse…"); the whole of it goes in `title`. */
  readonly label: string;
  readonly title?: string;
  /** A column of marks rather than words (a tick box per choice). */
  readonly align?: "center";
  /** The student's answer in this column. */
  cell(input: GradingCellInput<TAnswer, TDetails>): ReactNode;
  /** The expected answer in this column: the pinned first row of the table. */
  expected(): ReactNode;
  /**
   * What the column sorts by, as a NORMALISED string (`gradingSortKey`): two
   * answers a teacher would call the same give the same key. It is also the
   * key that will group identical answers, so it depends on the answer
   * alone — never on the student, the grading or the order of the rows.
   */
  sortKey(answer: TAnswer | null): string;
}

export interface QuestionTypeGrading<TStudent, TAnswer, TSolution, TDetails> {
  /**
   * The columns of one question, from the question as its students saw it
   * and its key (`null` when the host has none). `strings` are the type's
   * grading words translated by the host (N-I18N-01), merged with the type's
   * English defaults like every other dictionary of a type.
   */
  columns(
    student: TStudent,
    solution: TSolution | null,
    strings?: Readonly<Record<string, string>>,
  ): GradingColumn<TAnswer, TDetails>[];
}

/**
 * The normal form of an answer's text for sorting and grouping: Unicode NFC,
 * case folded, inner whitespace collapsed, ends trimmed. "Malloc " and
 * "malloc" are one answer to a teacher scanning a column.
 */
export function gradingSortKey(text: string | null | undefined): string {
  return (text ?? "").normalize("NFC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
}

export { QUESTION_TYPE_IDS } from "./contract.js";
export type { QuestionTypeId } from "./contract.js";
export { defineClientRegistry, makeLookup } from "./registry.js";
export type { AnyQuestionTypeClient } from "./registry.js";
export { UnknownQuestionType } from "./errors.js";
export * from "./rng.js";

// ---------------------------------------------------------------------------
// Host-provided rendering and UI strings (PLAN-MVP §8 WP2)
// ---------------------------------------------------------------------------

/**
 * How a question-type component turns authored markdown into nodes.
 *
 * A `qt-*` package cannot depend on `apps/web`, so it never owns a markdown
 * renderer: it renders plain text by itself and lets the host inject its own
 * sanitised `MarkdownView` through a prop. One signature for every type, so a
 * host wires it once.
 */
export type MarkdownRenderer = (source: string) => ReactNode;

/**
 * One validation problem of a stored draft (decision D16: an invalid draft is
 * stored and answered with `issues[]`, `configSchema.parse` only runs at
 * publication). `message` is an i18n key or a zod message; the host decides how
 * to present it, the editor only places it next to the field.
 */
export interface ConfigIssue {
  /** Path into the config, as zod reports it: `["choices", 2, "text"]`. */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * The issues whose path starts with `path` — what an editor places under the
 * field that path names. Pure, and here rather than in `@quiz/ui`: it is the
 * contract's reading of a {@link ConfigIssue}, not a matter of design.
 */
export function issuesAt(
  issues: readonly ConfigIssue[],
  ...path: (string | number)[]
): ConfigIssue[] {
  // The wire carries every segment as a string (`ZodIssueLite`), an editor
  // asks with the index it holds: `"2"` and `2` name the same row.
  return issues.filter((issue) => path.every((part, i) => String(issue.path[i]) === String(part)));
}

/** The issues that belong to the config as a whole (an empty zod path). */
export function rootIssues(issues: readonly ConfigIssue[]): ConfigIssue[] {
  return issues.filter((issue) => issue.path.length === 0);
}

/**
 * The UI strings a question-type component accepts.
 *
 * Every component ships a complete English dictionary and takes a partial
 * override, so `apps/web` passes the French entries it already holds in
 * `i18n/fr.ts` (N-I18N-01) without a `qt-*` package ever importing the app. The
 * key set is typed, so a renamed key is a compile error on the host side.
 */
export type StringOverrides<K extends string> = Partial<Readonly<Record<K, string>>>;

/**
 * Merges a component's English defaults with the host's overrides. Total, pure.
 *
 * `T` is the dictionary itself rather than a `Record<K, string>`: the circuit
 * canvas carries two lookups (`kind: (kind) => string`), and a dictionary is
 * still a dictionary when one of its values takes an argument. A parameterised
 * SENTENCE is not a function, though: it is a template for `fmt` below.
 * `Partial<T>` keeps the keys bound to `keyof T`, so a key
 * the defaults do not declare is still a compile error — and it keeps each
 * value's own type, which a `Record<keyof T, string>` would flatten.
 *
 * An override whose value is `undefined` is SKIPPED, it does not blank the
 * default. That is not defensive: `apps/web/tsconfig.json` does not turn on
 * `exactOptionalPropertyTypes`, and the host builds these dictionaries by
 * reflection over the defaults (`translated()` in `questionTypes.tsx`), so an
 * explicit `undefined` is reachable and a spread would render an empty label.
 * This is the ONLY string merge in the repository; the rule lives here once.
 */
export function resolveStrings<T extends object>(defaults: T, overrides?: Partial<T>): T {
  if (overrides === undefined) return defaults;
  const out = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Fills a string template: `fmt("{n} cases", { n: 3 })` is `"3 cases"`.
 *
 * The same `{var}` syntax as the host's `t()` (`apps/web/src/i18n/index.tsx`), so a
 * package's English default and the host's translation of the same key are
 * one shape, and the host hands them over key by key. An unknown placeholder
 * is left as written rather than rendered as `undefined` — and only `vars`'
 * OWN keys count, so `{constructor}` cannot read up the prototype chain.
 */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    Object.hasOwn(vars, k) ? String(vars[k]) : `{${k}}`,
  );
}

/**
 * `fmt` for a count: fills the `<key>.one` sibling when `n` is 1 and `key`
 * itself otherwise — the selection `apps/web` makes with
 * `t(n === 1 ? "<key>.one" : "<key>", vars)`. `vars` defaults to `{ n }`; a
 * sentence that names its count otherwise passes its own. A key without a
 * `.one` sibling is a compile error.
 */
export function plural<K extends string>(
  strings: NoInfer<Record<K | `${K}.one`, string>>,
  key: K,
  n: number,
  vars: Record<string, string | number> = { n },
): string {
  return fmt(n === 1 ? strings[`${key}.one`] : strings[key], vars);
}
