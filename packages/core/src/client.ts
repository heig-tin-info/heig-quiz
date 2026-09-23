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
}

export interface StatsProps<TStudent, TAnswer> {
  student: TStudent;
  answers: TAnswer[];
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

  /** `React.lazy`, so `qt-code` (Monaco) never enters the initial bundle (N-PERF-05). */
  readonly Editor: LazyExoticComponent<ComponentType<EditorProps<TConfig>>>;
  readonly Player: LazyExoticComponent<ComponentType<PlayerProps<TStudent, TAnswer>>>;
  readonly Review: LazyExoticComponent<ComponentType<ReviewProps<TStudent, TAnswer, TSolution, TDetails>>>;
  readonly Stats?: LazyExoticComponent<ComponentType<StatsProps<TStudent, TAnswer>>>;

  /** Empty answer for a fresh item (e.g. `{ selected: [] }`). */
  emptyAnswer(student: TStudent): TAnswer;
  /** Drives the "empty / seen / done" progress segments (F-LIVE-09). */
  isAnswered(answer: TAnswer | null): boolean;
  /** One-line rendering for the dashboard inspection panel and the cell tooltip. */
  summarize(answer: TAnswer | null, student: TStudent): string;
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
 * The UI strings a question-type component accepts.
 *
 * Every component ships a complete English dictionary and takes a partial
 * override, so `apps/web` passes the French entries it already holds in
 * `i18n.tsx` (N-I18N-01) without a `qt-*` package ever importing the app. The
 * key set is typed, so a renamed key is a compile error on the host side.
 */
export type StringOverrides<K extends string> = Partial<Readonly<Record<K, string>>>;

/**
 * Merges a component's English defaults with the host's overrides. Total, pure.
 *
 * `T` is the dictionary itself rather than a `Record<K, string>`: the code and
 * circuit dictionaries carry parameterised entries (`lockedRegions: (n) =>
 * string`), and a dictionary is still a dictionary when one of its values
 * takes an argument. `Partial<T>` keeps the keys bound to `keyof T`, so a key
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
