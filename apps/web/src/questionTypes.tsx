/**
 * The browser-side question-type hookup (PLAN-MVP §1.4, §8 WP7).
 *
 * `@quiz/registry/client` holds the static registry; this module is what the
 * pool and the editor talk to. It does three things and nothing else:
 *
 * 1. mounts a type's `Editor` / `Player` / `Review` behind `Suspense`, so the
 *    chunk of a type (Monaco included, N-PERF-05) is fetched only by a screen
 *    that shows that type;
 * 2. hands each component the French (or English) strings of `i18n.tsx`
 *    through its `strings` prop — a `qt-*` package may not import the app, so
 *    the host translates (N-I18N-01, deviation W2-3);
 * 3. injects the app's sanitised `MarkdownView` as `renderMarkdown` and the
 *    pool's asset upload as `uploadAsset`.
 *
 * The cast on the three components is deliberate: the registry erases five
 * type parameters (`AnyQuestionTypeClient`), so the props a concrete editor
 * accepts — `issues`, `strings`, `renderMarkdown` — are not visible through
 * it. Every value passed below is still built from that package's own
 * exported defaults, so a renamed key shows up as a missing key in
 * `questionTypes.test.ts`.
 */
import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

import type { ConfigIssue, RichTextComponent } from "@quiz/core/client";
import type { RunnerOutcome } from "@quiz/core/server";
import {
  clientRegistry,
  QUESTION_TYPE_IDS,
  type QuestionTypeId,
} from "@quiz/registry/client";
import {
  mcqEditorStrings,
  mcqPlayerStrings,
  mcqReviewStrings,
  mcqStatsStrings,
} from "@quiz/qt-mcq/client";
import {
  shortEditorStrings,
  shortPlayerStrings,
  shortReviewStrings,
} from "@quiz/qt-short/client";
import {
  clozeEditorStrings,
  clozePlayerStrings,
  clozeReviewStrings,
} from "@quiz/qt-cloze/client";
import {
  EDITOR_STRINGS,
  PLAYER_STRINGS,
  REVIEW_STRINGS,
  type CodeEditorProps,
  type CodeEditorStrings,
  type CodePlayerStrings,
  type CodeReviewStrings,
} from "@quiz/qt-code/client";
import {
  CANVAS_STRINGS,
  EDITOR_STRINGS as CIRCUIT_EDITOR_STRINGS,
  KIND_LABELS,
  PLAYER_STRINGS as CIRCUIT_PLAYER_STRINGS,
  REVIEW_STRINGS as CIRCUIT_REVIEW_STRINGS,
  type CanvasStrings,
  type CircuitEditorProps,
  type CircuitEditorStrings,
  type CircuitPlayerStrings,
  type CircuitReviewStrings,
  type KindLabels,
} from "@quiz/qt-circuit/client";

import { HelpIcon } from "./help";
import type { Dict, TFunction } from "./i18n";
import { MarkdownView } from "./markdown/MarkdownView";
import { ScrollableCode, Skeleton, type IconType } from "./ui";

/**
 * The WYSIWYG editor, injected into a type's `Editor` exactly as
 * `renderMarkdown` is: a `qt-*` package cannot depend on `apps/web`, so the
 * host owns Tiptap and lends it (`EditorProps.RichText` in
 * `packages/core/src/client.ts`).
 *
 * `lazy`, and not a plain import, for the reason the four types are lazy
 * (N-PERF-05): this module is also what the student's player and the review
 * screens go through, and a static import would drag ProseMirror, Tiptap and
 * KaTeX into the chunk a student downloads to answer a question. It resolves
 * inside the `Suspense` the editor host already opens.
 */
const LazyRichText = lazy(async () => ({
  default: (await import("./markdown/RichText")).RichText,
})) as unknown as RichTextComponent;

export { QUESTION_TYPE_IDS };

/** The registry entry, or `undefined` for a type this build does not carry. */
export function questionType(id: string) {
  return clientRegistry[id as QuestionTypeId];
}

/** The type's icon, or a neutral placeholder for an unregistered id. */
export function typeIcon(id: string): IconType {
  return questionType(id)?.Icon ?? (() => null);
}

/** "Multiple choice" / "Choix multiple", from the type's own `labelKey`. */
export function typeLabel(t: TFunction, id: string): string {
  const client = questionType(id);
  return client ? t(client.labelKey as keyof Dict) : id;
}

export function typeHint(t: TFunction, id: string): string {
  const client = questionType(id);
  return client ? t(client.hintKey as keyof Dict) : "";
}

// --- Strings ---------------------------------------------------------------

/**
 * Translates a package's string dictionary key by key: every key `k` of
 * `defaults` is looked up as `<prefix>.<k>` in `i18n.tsx`. Keys whose default
 * is a function (the `code` type parameterizes a few of its sentences) are
 * skipped here and rebuilt by hand below.
 */
function translated<T extends object>(t: TFunction, defaults: T, prefix: string): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === "function") continue;
    out[key] = t(`${prefix}.${key}` as keyof Dict);
  }
  return out as T;
}

/**
 * The five MCQ scoring policies and their one-line descriptions, shared with
 * the teacher's preferences (`SettingsPage`) and an evaluation's advanced
 * options (`AdvancedDisclosure`). One wording, one place: they live under
 * `mcq.policy.*` in `i18n.tsx`, and the editor's own string keys are mapped
 * onto them here rather than duplicated under `qt.mcq.e`.
 */
const mcqPolicyStrings = (t: TFunction) => ({
  policyInherit: t("mcq.policy.inherit"),
  policyAllOrNothing: t("mcq.policy.all_or_nothing"),
  policyTrueFalse: t("mcq.policy.true_false"),
  policyDiscordance: t("mcq.policy.discordance"),
  policySymmetric: t("mcq.policy.symmetric"),
  policyRipkey: t("mcq.policy.ripkey"),
  policyDescInherit: t("mcq.policy.desc.inherit"),
  policyDescAllOrNothing: t("mcq.policy.desc.all_or_nothing"),
  policyDescTrueFalse: t("mcq.policy.desc.true_false"),
  policyDescDiscordance: t("mcq.policy.desc.discordance"),
  policyDescSymmetric: t("mcq.policy.desc.symmetric"),
  policyDescRipkey: t("mcq.policy.desc.ripkey"),
});

/**
 * The schema messages the MCQ editor raises ITSELF, worded once.
 *
 * `issue.mcq.max_below_correct` is what `question/issues.ts` already shows for
 * the server's copy of that issue; the editor checks the same rule at the
 * keystroke, so it gets the same sentence rather than a second wording of it.
 */
const mcqIssueStrings = (t: TFunction) => ({
  maxBelowCorrect: t("issue.mcq.max_below_correct"),
});

/** The keys of `mcqEditorStrings` the two mappings above answer for. */
export const MCQ_HOST_MAPPED_KEYS = Object.keys({
  ...mcqPolicyStrings(((k) => String(k)) as TFunction),
  ...mcqIssueStrings(((k) => String(k)) as TFunction),
});

export const editorStrings = {
  mcq: (t: TFunction) => ({
    ...translated(t, mcqEditorStrings, "qt.mcq.e"),
    ...mcqPolicyStrings(t),
    ...mcqIssueStrings(t),
  }),
  short: (t: TFunction) => translated(t, shortEditorStrings, "qt.short.e"),
  cloze: (t: TFunction) => translated(t, clozeEditorStrings, "qt.cloze.e"),
  code: (t: TFunction): CodeEditorStrings => ({
    ...translated(t, EDITOR_STRINGS, "qt.code.e"),
    case: (n) => t("qt.code.e.case", { n }),
    lockedRegions: (n) =>
      t(n === 1 ? "qt.code.e.lockedRegions.one" : "qt.code.e.lockedRegions", { n }),
    tryResult: (passed, total) => t("qt.code.e.tryResult", { passed, total }),
    removeCase: (name) => t("qt.code.e.removeCase", { name }),
    totalPoints: (n) => t(n === 1 ? "qt.code.e.totalPoints.one" : "qt.code.e.totalPoints", { n }),
  }),
  circuit: (t: TFunction): CircuitEditorStrings => ({
    ...translated(t, CIRCUIT_EDITOR_STRINGS, "qt.circuit.e"),
    stimulus: (n) => t("qt.circuit.e.stimulus", { n }),
    removeStimulus: (name) => t("qt.circuit.e.removeStimulus", { name }),
    totalPoints: (n) =>
      t(n === 1 ? "qt.circuit.e.totalPoints.one" : "qt.circuit.e.totalPoints", { n }),
    tryDone: (n) => t(n === 1 ? "qt.circuit.e.tryDone.one" : "qt.circuit.e.tryDone", { n }),
  }),
};

/**
 * The component kinds and the canvas, translated the same way but keyed by
 * something other than a sentence: a `ComponentKind` (`qt.circuit.kind.R`)
 * and the canvas's own dictionary (`qt.circuit.c.*`). They are built once and
 * handed to all three surfaces, because the same twelve words label a palette
 * chip, a symbol and a diagnostic.
 */
export const circuitKindLabels = (t: TFunction): KindLabels =>
  translated(t, KIND_LABELS, "qt.circuit.kind");

export const circuitCanvasStrings = (t: TFunction): CanvasStrings => {
  const kinds = circuitKindLabels(t);
  return {
    ...translated(t, CANVAS_STRINGS, "qt.circuit.c"),
    componentCount: (used, max) => t("qt.circuit.c.componentCount", { used, max }),
    paletteFull: (max) => t("qt.circuit.c.paletteFull", { max }),
    hintSelection: (n) =>
      t(n === 1 ? "qt.circuit.c.hintSelection.one" : "qt.circuit.c.hintSelection", { n }),
    hintPlace: (kind) => t("qt.circuit.c.hintPlace", { kind }),
    cursor: (x, y) => t("qt.circuit.c.cursor", { x, y }),
    // The canvas asks for a kind's label through a function; the dictionary
    // above is what answers it, so the palette, the inspector and the chips
    // of the editor all say the same word.
    kind: (kind) => kinds[kind],
    port: (port) => port,
  };
};

export const playerStrings = {
  mcq: (t: TFunction) => translated(t, mcqPlayerStrings, "qt.mcq.p"),
  short: (t: TFunction) => translated(t, shortPlayerStrings, "qt.short.p"),
  cloze: (t: TFunction) => translated(t, clozePlayerStrings, "qt.cloze.p"),
  code: (t: TFunction): CodePlayerStrings => ({
    ...translated(t, PLAYER_STRINGS, "qt.code.p"),
    editableRegion: (n) => t("qt.code.p.editableRegion", { n }),
    hiddenCases: (count, points) =>
      t(count === 1 ? "qt.code.p.hiddenCases.one" : "qt.code.p.hiddenCases", { count, points }),
    limits: (timeMs, memoryMb) => t("qt.code.p.limits", { timeMs, memoryMb }),
    command: (args) => t("qt.code.p.command", { args }),
    exitMismatch: (got, want) => t("qt.code.p.exitMismatch", { got, want }),
    exitCode: (code) => t("qt.code.p.exitCode", { code }),
  }),
  circuit: (t: TFunction): CircuitPlayerStrings => ({
    ...translated(t, CIRCUIT_PLAYER_STRINGS, "qt.circuit.p"),
    components: (n, max) => t("qt.circuit.p.components", { n, max }),
    issueFloatingPin: (ref) => t("qt.circuit.p.issueFloatingPin", { ref }),
    issueUnconnectedPort: (ref) => t("qt.circuit.p.issueUnconnectedPort", { ref }),
    issueDanglingWire: (ref) => t("qt.circuit.p.issueDanglingWire", { ref }),
    issueMissingValue: (ref) => t("qt.circuit.p.issueMissingValue", { ref }),
    issueInvalidValue: (ref) => t("qt.circuit.p.issueInvalidValue", { ref }),
    issueValueOutOfRange: (ref) => t("qt.circuit.p.issueValueOutOfRange", { ref }),
    issueDuplicateName: (ref) => t("qt.circuit.p.issueDuplicateName", { ref }),
    issueKindNotAllowed: (ref) => t("qt.circuit.p.issueKindNotAllowed", { ref }),
    hiddenStimuli: (count, points) =>
      t(count === 1 ? "qt.circuit.p.hiddenStimuli.one" : "qt.circuit.p.hiddenStimuli", {
        count,
        points,
      }),
    srcDc: (volts) => t("qt.circuit.p.srcDc", { volts }),
    srcSine: (amplitude, frequency) => t("qt.circuit.p.srcSine", { amplitude, frequency }),
    srcPulse: (low, high, frequency) => t("qt.circuit.p.srcPulse", { low, high, frequency }),
    srcStep: (from, to, atMs) => t("qt.circuit.p.srcStep", { from, to, atMs }),
    loadResistor: (value) => t("qt.circuit.p.loadResistor", { value }),
    loadCapacitor: (value) => t("qt.circuit.p.loadCapacitor", { value }),
    window: (ms) => t("qt.circuit.p.window", { ms }),
    plot: (name) => t("qt.circuit.p.plot", { name }),
  }),
};

export const reviewStrings = {
  mcq: (t: TFunction) => translated(t, mcqReviewStrings, "qt.mcq.r"),
  short: (t: TFunction) => translated(t, shortReviewStrings, "qt.short.r"),
  cloze: (t: TFunction) => translated(t, clozeReviewStrings, "qt.cloze.r"),
  code: (t: TFunction): CodeReviewStrings => ({
    ...translated(t, REVIEW_STRINGS, "qt.code.r"),
    score: (points, max) => t("qt.code.r.score", { points, max }),
    hiddenSummary: (passed, count) => t("qt.code.r.hiddenSummary", { passed, count }),
    exitMismatch: (got, want) => t("qt.code.r.exitMismatch", { got, want }),
  }),
  circuit: (t: TFunction): CircuitReviewStrings => ({
    ...translated(t, CIRCUIT_REVIEW_STRINGS, "qt.circuit.r"),
    score: (points, max) => t("qt.circuit.r.score", { points, max }),
    netSummary: (components, nets) => t("qt.circuit.r.netSummary", { components, nets }),
    hiddenStimulus: (n) => t("qt.circuit.r.hiddenStimulus", { n }),
    errorPercent: (percent) => t("qt.circuit.r.errorPercent", { percent }),
    issueFloatingPin: (ref) => t("qt.circuit.r.issueFloatingPin", { ref }),
    issueUnconnectedPort: (ref) => t("qt.circuit.r.issueUnconnectedPort", { ref }),
    issueDanglingWire: (ref) => t("qt.circuit.r.issueDanglingWire", { ref }),
    issueMissingValue: (ref) => t("qt.circuit.r.issueMissingValue", { ref }),
    issueInvalidValue: (ref) => t("qt.circuit.r.issueInvalidValue", { ref }),
    issueValueOutOfRange: (ref) => t("qt.circuit.r.issueValueOutOfRange", { ref }),
    issueDuplicateName: (ref) => t("qt.circuit.r.issueDuplicateName", { ref }),
    issueKindNotAllowed: (ref) => t("qt.circuit.r.issueKindNotAllowed", { ref }),
  }),
};

/** `mcq` answer distribution (WP10 results screens). */
export const statsStrings = {
  mcq: (t: TFunction) => translated(t, mcqStatsStrings, "qt.mcq.s"),
};

// --- Hosts -----------------------------------------------------------------

/** What a lazy chunk shows while it arrives: the shape of what replaces it. */
function EditorSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

/**
 * What the host may answer a type's "try it yourself" button with.
 *
 * Read off each editor's own prop rather than restated here: the browser
 * runner returns a raw `RunnerOutcome`, `POST /questions/:id/try` returns a
 * grading, the `circuit` editor wants that grading's own breakdown — and
 * which shapes exist is the question type's business, never the host's. The
 * union widens by one member per type that gains a try button.
 */
export type TryOutcome =
  | Awaited<ReturnType<NonNullable<CodeEditorProps["onTry"]>>>
  | Awaited<ReturnType<NonNullable<CircuitEditorProps["onTry"]>>>;

function Unknown({ children }: { children: ReactNode }) {
  return <p className="text-sm text-fg-muted">{children}</p>;
}

/**
 * Every prop any of the four editors accepts. The registry types its entry as
 * `ComponentType<EditorProps<unknown>>`, which knows nothing of `issues`,
 * `strings` or `renderMarkdown`; this is the shape the cast restores.
 */
interface EditorHostProps {
  config: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  issues?: readonly ConfigIssue[];
  strings?: unknown;
  /** `circuit` only: the canvas ships a dictionary of its own (`qt.circuit.c.*`). */
  canvasStrings?: unknown;
  /** `circuit` only: the component names, keyed by kind (`qt.circuit.kind.*`). */
  kindLabels?: unknown;
  renderMarkdown?: (source: string) => ReactNode;
  renderHelp?: (topic: string) => ReactNode;
  RichText?: RichTextComponent;
  uploadAsset?: (file: File) => Promise<string>;
  aside?: HTMLElement | null;
  onTry?: (config: unknown) => Promise<TryOutcome>;
}

/**
 * The app's sanitised renderer, injected into every type's components.
 *
 * Two shapes, because the hosts differ: an editor places the preview in a
 * block of its own, while a player and a review render the statement INSIDE a
 * `<p>` (`qt-mcq/Review.tsx`, and the same pattern in the others). A `<div>`
 * there is invalid HTML and React says so, so those two get the span variant;
 * the sanitising, the KaTeX pass and the `asset:` resolution are identical.
 */
const renderBlock = (source: string) => <MarkdownView source={source} />;
const renderInline = (source: string) => <MarkdownView as="span" size="sm" source={source} />;

/**
 * The app's contextual help, lent to an editor the same way: a `qt-*` package
 * cannot import `help.tsx`, but the "?" next to a label belongs to the app's
 * chrome and opens the app's drawer (`EditorProps.renderHelp`).
 */
const renderHelp = (topic: string) => <HelpIcon topic={topic} />;

export function QuestionEditorHost({
  t,
  type,
  config,
  onChange,
  issues,
  disabled,
  uploadAsset,
  aside,
  onTry,
}: {
  t: TFunction;
  type: string;
  config: unknown;
  onChange: (next: unknown) => void;
  issues?: readonly ConfigIssue[];
  disabled?: boolean;
  uploadAsset: (file: File) => Promise<string>;
  /**
   * The element of the screen's right column a type's editor may portal its
   * settings into (`EditorProps.aside`). It is the host's layout decision,
   * never the type's, so it travels as a prop and an editor that ignores it
   * simply keeps everything in one column.
   */
  aside?: HTMLElement | null;
  /**
   * `code` and `circuit`: runs (or simulates) the teacher's own answer. The
   * screen decides where it runs — `src/runner/` picks the browser or the
   * backend from `CodeConfig.runtime` for a code question, and a circuit is
   * always the server's, since only it may assemble a netlist (invariant 14).
   */
  onTry?: (config: unknown) => Promise<TryOutcome>;
}) {
  const client = questionType(type);
  if (!client) return <Unknown>{t("qt.unknown")}</Unknown>;
  const Editor = client.Editor as unknown as ComponentType<EditorHostProps>;
  const strings = editorStrings[client.id](t);
  return (
    <Suspense fallback={<EditorSkeleton label={t("qt.loading")} />}>
      <Editor
        config={config}
        onChange={onChange}
        {...(disabled === undefined ? {} : { disabled })}
        {...(issues === undefined ? {} : { issues })}
        strings={strings}
        {...(client.id === "circuit"
          ? { canvasStrings: circuitCanvasStrings(t), kindLabels: circuitKindLabels(t) }
          : {})}
        renderMarkdown={renderBlock}
        renderHelp={renderHelp}
        RichText={LazyRichText}
        uploadAsset={uploadAsset}
        {...(aside === undefined ? {} : { aside })}
        {...(onTry === undefined ? {} : { onTry })}
      />
    </Suspense>
  );
}

interface PlayerHostProps {
  student: unknown;
  answer: unknown;
  onChange: (next: unknown) => void;
  readOnly: boolean;
  strings?: unknown;
  canvasStrings?: unknown;
  renderMarkdown?: (source: string) => ReactNode;
  onRun?: (answer: unknown, options?: unknown) => Promise<RunnerOutcome | "unavailable">;
  allowManualRun?: boolean;
  onSimulate?: (answer: unknown) => Promise<RunnerOutcome | "unavailable" | "rate_limited">;
}

export function QuestionPlayerHost({
  t,
  type,
  student,
  answer,
  onChange,
  readOnly,
  onRun,
  allowManualRun,
  onSimulate,
}: {
  t: TFunction;
  type: string;
  student: unknown;
  answer: unknown;
  onChange: (next: unknown) => void;
  readOnly: boolean;
  /** `code` only: the run the type's player offers, from `src/runner/`. */
  onRun?: (answer: unknown, options?: unknown) => Promise<RunnerOutcome | "unavailable">;
  allowManualRun?: boolean;
  /**
   * `circuit` only: the simulation its player offers. It has no browser half
   * — a netlist is assembled server-side (invariant 14) — so it is one call,
   * and its two words are the graceful paths (D14, N-SEC-07).
   */
  onSimulate?: (answer: unknown) => Promise<RunnerOutcome | "unavailable" | "rate_limited">;
}) {
  const client = questionType(type);
  if (!client) return <Unknown>{t("qt.unknown")}</Unknown>;
  const Player = client.Player as unknown as ComponentType<PlayerHostProps>;
  return (
    // `qt-code` prints the provided, locked part of the program in `<pre>`
    // blocks that scroll sideways on a phone; a student with no mouse could
    // not read past the fold (W10).
    <ScrollableCode label={t("markdown.codeBlock")}>
      <Suspense fallback={<EditorSkeleton label={t("qt.loading")} />}>
        <Player
          student={student}
          answer={answer}
          onChange={onChange}
          readOnly={readOnly}
          strings={playerStrings[client.id](t)}
          {...(client.id === "circuit" ? { canvasStrings: circuitCanvasStrings(t) } : {})}
          renderMarkdown={renderInline}
          {...(onRun === undefined ? {} : { onRun })}
          {...(allowManualRun === undefined ? {} : { allowManualRun })}
          {...(onSimulate === undefined ? {} : { onSimulate })}
        />
      </Suspense>
    </ScrollableCode>
  );
}

interface ReviewHostProps {
  student: unknown;
  answer: unknown;
  solution: unknown;
  details: unknown;
  points: number | null;
  maxPoints: number;
  audience: "teacher" | "student";
  strings?: unknown;
  canvasStrings?: unknown;
  renderMarkdown?: (source: string) => ReactNode;
}

export function QuestionReviewHost({
  t,
  type,
  student,
  answer,
  solution,
  details,
  points,
  maxPoints,
  audience = "teacher",
}: {
  t: TFunction;
  type: string;
  student: unknown;
  answer: unknown;
  solution: unknown;
  details: unknown;
  points: number | null;
  maxPoints: number;
  audience?: "teacher" | "student";
}) {
  const client = questionType(type);
  if (!client) return <Unknown>{t("qt.unknown")}</Unknown>;
  const Review = client.Review as unknown as ComponentType<ReviewHostProps>;
  return (
    // `qt-code`'s review prints the compiler output and the reference solution
    // in `<pre>` blocks that scroll sideways on a phone. The package is not
    // ours to edit from here, so the host makes them focusable (W10).
    <ScrollableCode label={t("markdown.codeBlock")}>
      <Suspense fallback={<EditorSkeleton label={t("qt.loading")} />}>
        <Review
          student={student}
          answer={answer}
          solution={solution}
          details={details}
          points={points}
          maxPoints={maxPoints}
          audience={audience}
          strings={reviewStrings[client.id](t)}
          {...(client.id === "circuit" ? { canvasStrings: circuitCanvasStrings(t) } : {})}
          renderMarkdown={renderInline}
        />
      </Suspense>
    </ScrollableCode>
  );
}

/** The empty answer of a type, for the try panel. */
export function emptyAnswerOf(type: string, student: unknown): unknown {
  const client = questionType(type);
  return client ? client.emptyAnswer(student) : null;
}
