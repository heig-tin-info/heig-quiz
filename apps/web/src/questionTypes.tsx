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
import { Suspense, type ComponentType, type ReactNode } from "react";

import type { ConfigIssue } from "@quiz/core/client";
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
  type CodeEditorStrings,
  type CodePlayerStrings,
  type CodeReviewStrings,
} from "@quiz/qt-code/client";

import type { Dict, TFunction } from "./i18n";
import { MarkdownView } from "./markdown/MarkdownView";
import { ScrollableCode, Skeleton, type IconType } from "./ui";

export { QUESTION_TYPE_IDS };
export type { QuestionTypeId };

/** The registry entry, or `undefined` for a type this build does not carry. */
export function questionType(id: string) {
  return clientRegistry[id as QuestionTypeId];
}

export function isKnownType(id: string): id is QuestionTypeId {
  return questionType(id) !== undefined;
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

export const editorStrings = {
  mcq: (t: TFunction) => translated(t, mcqEditorStrings, "qt.mcq.e"),
  short: (t: TFunction) => translated(t, shortEditorStrings, "qt.short.e"),
  cloze: (t: TFunction) => translated(t, clozeEditorStrings, "qt.cloze.e"),
  code: (t: TFunction): CodeEditorStrings => ({
    ...translated(t, EDITOR_STRINGS, "qt.code.e"),
    lockedRegions: (n) =>
      t(n === 1 ? "qt.code.e.lockedRegions.one" : "qt.code.e.lockedRegions", { n }),
    tryResult: (passed, total) => t("qt.code.e.tryResult", { passed, total }),
    removeCase: (name) => t("qt.code.e.removeCase", { name }),
    totalPoints: (n) => t(n === 1 ? "qt.code.e.totalPoints.one" : "qt.code.e.totalPoints", { n }),
  }),
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
  }),
};

/** `mcq` answer distribution (WP10 results screens). */
export const statsStrings = {
  mcq: (t: TFunction) => translated(t, mcqStatsStrings, "qt.mcq.s"),
};

// --- Hosts -----------------------------------------------------------------

/** What a lazy chunk shows while it arrives: the shape of what replaces it. */
export function EditorSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
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
  renderMarkdown?: (source: string) => ReactNode;
  uploadAsset?: (file: File) => Promise<string>;
  onTry?: (config: unknown) => Promise<RunnerOutcome | "unavailable">;
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

export function QuestionEditorHost({
  t,
  type,
  config,
  onChange,
  issues,
  disabled,
  uploadAsset,
  onTry,
}: {
  t: TFunction;
  type: string;
  config: unknown;
  onChange: (next: unknown) => void;
  issues?: readonly ConfigIssue[];
  disabled?: boolean;
  uploadAsset: (file: File) => Promise<string>;
  onTry?: (config: unknown) => Promise<RunnerOutcome | "unavailable">;
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
        renderMarkdown={renderBlock}
        uploadAsset={uploadAsset}
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
  renderMarkdown?: (source: string) => ReactNode;
}

export function QuestionPlayerHost({
  t,
  type,
  student,
  answer,
  onChange,
  readOnly,
}: {
  t: TFunction;
  type: string;
  student: unknown;
  answer: unknown;
  onChange: (next: unknown) => void;
  readOnly: boolean;
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
          renderMarkdown={renderInline}
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
