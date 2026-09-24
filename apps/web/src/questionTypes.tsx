/**
 * The browser-side question-type hookup (PLAN-MVP §1.4, §8 WP7).
 *
 * `@quiz/registry/client` holds the static registry; this module is what the
 * pool and the editor talk to. It does four things and nothing else:
 *
 * 1. mounts a type's `Editor` / `Player` / `Review` behind `Suspense`, so the
 *    chunk of a type (Monaco included, N-PERF-05) is fetched only by a screen
 *    that shows that type;
 * 2. hands each component the French (or English) strings of `i18n/`
 *    through its `strings` prop — a `qt-*` package may not import the app, so
 *    the host translates (N-I18N-01, deviation W2-3);
 * 3. injects the app's sanitised `MarkdownView` as `renderMarkdown` and the
 *    pool's asset upload as `uploadAsset`;
 * 4. picks the editor's "try it yourself" adapter for a type
 *    (`tryAdapterFor`), so the editor screen never branches on a type id.
 *
 * The cast on the three components is deliberate: the registry erases five
 * type parameters (`AnyQuestionTypeClient`), so the props a concrete editor
 * accepts — `issues`, `strings`, `renderMarkdown` — are not visible through
 * it. Every value passed below is still built from that package's own
 * exported defaults, so a renamed key shows up as a missing key in
 * `questionTypes.test.ts`.
 */
import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

import type { TryResult } from "@quiz/contracts";
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
  IMAGE_EDITOR_STRINGS,
  IMAGE_PLAYER_STRINGS,
  IMAGE_REVIEW_STRINGS,
  PLAYER_STRINGS,
  referenceRegions,
  REVIEW_STRINGS,
  type CodeConfig,
  type CodeDetails,
  type CodeEditorProps,
  type CodeImageConfig,
  type CodeImageDetails,
  type CodeImageEditorProps,
} from "@quiz/qt-code/client";
import {
  CANVAS_STRINGS,
  EDITOR_STRINGS as CIRCUIT_EDITOR_STRINGS,
  KIND_LABELS,
  PLAYER_STRINGS as CIRCUIT_PLAYER_STRINGS,
  REVIEW_STRINGS as CIRCUIT_REVIEW_STRINGS,
  type CanvasStrings,
  type CircuitConfig,
  type CircuitDetails,
  type CircuitEditorProps,
  type KindLabels,
} from "@quiz/qt-circuit/client";

import { api } from "./api";
import { HelpIcon } from "./help";
import type { Dict, TFunction } from "./i18n";
import { MarkdownView } from "./markdown/MarkdownView";
import { BrowserRunnerUnavailable, runnerFor } from "./runner";
import { imageReferenceRunRequest, referenceRunRequest } from "./runner/codeRun";
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
 * `defaults` is looked up as `<prefix>.<k>` in `i18n/`. Keys whose default
 * is a function are skipped: only the circuit canvas has two (`kind`,
 * `port`), and they are lookups rather than sentences. A parameterised
 * sentence is a `{var}` template on both sides, so it goes through like any
 * other key — `.one` variants included, since a package names them
 * `"<key>.one"` too.
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
 * `mcq.policy.*` in `i18n/`, and the editor's own string keys are mapped
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
  code: (t: TFunction) => translated(t, EDITOR_STRINGS, "qt.code.e"),
  circuit: (t: TFunction) => translated(t, CIRCUIT_EDITOR_STRINGS, "qt.circuit.e"),
  /*
   * `codeimage` is `code`'s program half plus a picture (ADR-021): `code`'s
   * sentences, translated once under `qt.code.*`, with the image's own on
   * top — including the sentence it deliberately re-words.
   */
  codeimage: (t: TFunction) => ({
    ...translated(t, EDITOR_STRINGS, "qt.code.e"),
    ...translated(t, IMAGE_EDITOR_STRINGS, "qt.codeimage.e"),
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
  code: (t: TFunction) => translated(t, PLAYER_STRINGS, "qt.code.p"),
  circuit: (t: TFunction) => translated(t, CIRCUIT_PLAYER_STRINGS, "qt.circuit.p"),
  codeimage: (t: TFunction) => ({
    ...translated(t, PLAYER_STRINGS, "qt.code.p"),
    ...translated(t, IMAGE_PLAYER_STRINGS, "qt.codeimage.p"),
  }),
};

export const reviewStrings = {
  mcq: (t: TFunction) => translated(t, mcqReviewStrings, "qt.mcq.r"),
  short: (t: TFunction) => translated(t, shortReviewStrings, "qt.short.r"),
  cloze: (t: TFunction) => translated(t, clozeReviewStrings, "qt.cloze.r"),
  code: (t: TFunction) => translated(t, REVIEW_STRINGS, "qt.code.r"),
  circuit: (t: TFunction) => translated(t, CIRCUIT_REVIEW_STRINGS, "qt.circuit.r"),
  // The review shows the player's image panel, so it reads the player's words too.
  codeimage: (t: TFunction) => ({
    ...playerStrings.codeimage(t),
    ...translated(t, REVIEW_STRINGS, "qt.code.r"),
    ...translated(t, IMAGE_REVIEW_STRINGS, "qt.codeimage.r"),
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
  | Awaited<ReturnType<NonNullable<CircuitEditorProps["onTry"]>>>
  | Awaited<ReturnType<NonNullable<CodeImageEditorProps["onTry"]>>>;

/** What a "try" adapter needs from the editor screen that mounts it. */
export interface TryContext {
  /** The question whose DRAFT `POST /questions/:id/try` grades. */
  id: string;
  /** Saves the local draft now: the try route grades what the server HOLDS. */
  flush: () => void;
}

type TryAdapter = (config: unknown) => Promise<TryOutcome>;

/**
 * "Try the reference solution" (`CodeEditor`): the SERVER first, because it
 * is the grader and the reference is checked against the grade.
 *
 * The reference solution is read as one piece per editable region
 * (`referenceRegions`, `@@next` between them). The editor refuses a
 * mismatch before it ever calls this, which is why `null` below is a bug
 * and not a state: it throws rather than inventing a verdict.
 *
 *  - `POST /questions/:id/try` grades the reference solution as an ANSWER.
 *    It returns a grading, not a run (`TryResult` carries no per-case
 *    runner outcome), so what comes back is the server's own verdict —
 *    `{ graded }`, with each case's pass/fail — and the editor shows it
 *    instead of re-deciding it. On a `runno` question the editor then runs
 *    the same program in the browser (`tryReferenceInBrowser`) and warns
 *    when the two disagree.
 *  - the server has no runner (`RUNNER_MODE=stub`, decision D14) and the
 *    question runs in the browser: the browser answers alone, a raw
 *    `RunnerOutcome` the editor judges itself — the engine the students'
 *    trials will meet, which is better than nothing.
 */
function tryReference({ id, flush }: TryContext): TryAdapter {
  return async (raw) => {
    const config = raw as CodeConfig;
    const regions = referenceRegions(config);
    if (regions === null) throw new Error("reference solution does not fit the template");

    // The route grades what the server HOLDS, so the draft goes first.
    flush();
    const result = await api<TryResult>(`/app/api/questions/${id}/try`, {
      method: "POST",
      body: JSON.stringify({ source: "draft", answer: { regions } }),
    });
    const details = result.status === "graded" ? (result.details as CodeDetails) : null;
    if (details === null || details.runner !== "ok") {
      if (config.runtime !== "runno") return "unavailable";
      return tryReferenceInBrowser(config);
    }
    return {
      graded: {
        // `null` is a language with no compile step, not a failure.
        compileOk: details.compile?.ok ?? true,
        passed: details.cases.filter((c) => c.ok).length,
        total: details.cases.length,
        cases: details.cases.map((c) => c.ok),
      },
    };
  };
}

/**
 * The reference, run by the BROWSER runner (`CodeEditor.onTryInBrowser`):
 * the program assembled here from the draft's template and the reference's
 * regions, with the teacher's compiler flags and the real content of the
 * extra files — the editor holds the whole config, so nothing has to be
 * withheld the way `toStudent` withholds it from a student. `"unavailable"`
 * when this browser cannot run the language or its runtime will not load.
 */
export async function tryReferenceInBrowser(
  config: CodeConfig,
): Promise<RunnerOutcome | "unavailable"> {
  const regions = referenceRegions(config);
  if (regions === null) return "unavailable";
  const browser = await runnerFor("runno", config.language);
  if (browser === null) return "unavailable";
  try {
    return await browser.run(referenceRunRequest(config, regions));
  } catch (error) {
    if (!(error instanceof BrowserRunnerUnavailable)) throw error;
    return "unavailable";
  }
}

/**
 * "Simulate the reference" (`CircuitEditor`).
 *
 * There is no browser half and there never will be: a SPICE netlist is
 * assembled SERVER-SIDE from the stored schematic and the stimulus
 * (invariant 14), so the teacher's own circuit is posted as an ANSWER to
 * `POST /questions/:id/try` and what comes back is this type's own
 * breakdown — the waveforms already decimated and already paired with the
 * stimulus that produced them.
 *
 * `runner_unavailable` is the default deployment (decision D14), not a
 * failure: the editor says so in one line and publication is unaffected.
 */
function trySimulateReference({ id, flush }: TryContext): TryAdapter {
  return async (raw) => {
    const config = raw as CircuitConfig;
    // The route grades what the server HOLDS, so the draft goes first.
    flush();
    const result = await api<TryResult>(`/app/api/questions/${id}/try`, {
      method: "POST",
      body: JSON.stringify({ source: "draft", answer: { schematic: config.reference } }),
    });
    if (result.status !== "graded") return "unavailable";
    return { details: result.details as CircuitDetails };
  };
}

/**
 * "Try the reference solution" (`CodeImageEditor`): the same two runners as
 * `code`'s, and the answer is the PICTURE the reference draws, which the
 * editor offers to "Use as target".
 *
 *  - `runtime: "runno"`: the browser runs the program assembled from the
 *    draft's template and the reference's regions, one run with an empty
 *    stdin, and the editor parses its stdout with the grader's own rule.
 *  - otherwise `POST /questions/:id/try` grades the reference as an answer:
 *    the grading's `details.image` IS the picture, already parsed on the
 *    server — the same field a student's review reads.
 */
function tryDrawReference({ id, flush }: TryContext): TryAdapter {
  return async (raw) => {
    const config = raw as CodeImageConfig;
    const regions = referenceRegions(config);
    if (regions === null) throw new Error("reference solution does not fit the template");

    const browser = await runnerFor(config.runtime, config.language);
    if (browser !== null) {
      try {
        return await browser.run(imageReferenceRunRequest(config, regions));
      } catch (error) {
        if (!(error instanceof BrowserRunnerUnavailable)) throw error;
      }
    }

    flush();
    const result = await api<TryResult>(`/app/api/questions/${id}/try`, {
      method: "POST",
      body: JSON.stringify({ source: "draft", answer: { regions } }),
    });
    if (result.status !== "graded") return "unavailable";
    return { details: result.details as CodeImageDetails };
  };
}

/**
 * The editor's "try it yourself" for a type, or `undefined` for a type that
 * has no such button. One adapter per type that gains one, keyed here so the
 * editor screen never branches on a type id.
 *
 * (The student player's `simulateCircuit` is not one of these: it posts to
 * `POST /attempts/:id/simulate`, answers a raw `RunnerOutcome` and maps the
 * attempt's 429 budget — a different route with a different contract.)
 */
export function tryAdapterFor(type: string, context: TryContext): TryAdapter | undefined {
  if (type === "code") return tryReference(context);
  if (type === "circuit") return trySimulateReference(context);
  if (type === "codeimage") return tryDrawReference(context);
  return undefined;
}

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
  ungraded?: boolean;
  onTry?: (config: unknown) => Promise<TryOutcome>;
  /** `code` only: `CodeEditorProps.onTryInBrowser`. */
  onTryInBrowser?: (config: CodeConfig) => Promise<RunnerOutcome | "unavailable">;
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
  ungraded,
  onTry,
}: {
  t: TFunction;
  type: string;
  config: unknown;
  onChange: (next: unknown) => void;
  issues?: readonly ConfigIssue[];
  disabled?: boolean;
  /**
   * The pool's image upload. Absent — the poll launcher's unsaved question,
   * which has no pool to hold an image — the editors offer no upload.
   */
  uploadAsset?: (file: File) => Promise<string>;
  /**
   * The element of the screen's right column a type's editor may portal its
   * settings into (`EditorProps.aside`). It is the host's layout decision,
   * never the type's, so it travels as a prop and an editor that ignores it
   * simply keeps everything in one column.
   */
  aside?: HTMLElement | null;
  /** No marks to give (the poll launcher): `EditorProps.ungraded`. */
  ungraded?: boolean;
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
        {...(uploadAsset === undefined ? {} : { uploadAsset })}
        {...(aside === undefined ? {} : { aside })}
        {...(ungraded === undefined ? {} : { ungraded })}
        {...(onTry === undefined ? {} : { onTry })}
        {...(onTry !== undefined && client.id === "code"
          ? { onTryInBrowser: tryReferenceInBrowser }
          : {})}
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
  onRun?: (answer: unknown, options?: unknown) => Promise<RunnerOutcome | "unavailable" | "rate_limited">;
  allowManualRun?: boolean;
  testsPrimary?: boolean;
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
  testsPrimary,
  onSimulate,
}: {
  t: TFunction;
  type: string;
  student: unknown;
  answer: unknown;
  onChange: (next: unknown) => void;
  readOnly: boolean;
  /** `code` only: the run the type's player offers, from `src/runner/`. */
  onRun?: (answer: unknown, options?: unknown) => Promise<RunnerOutcome | "unavailable" | "rate_limited">;
  allowManualRun?: boolean;
  /** `code` only: false where the host has its own primary action (the try panel). */
  testsPrimary?: boolean;
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
          {...(testsPrimary === undefined ? {} : { testsPrimary })}
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
