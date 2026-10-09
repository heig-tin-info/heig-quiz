/**
 * Mounts the question type's own `Player` for one item: the ONE player host,
 * for a student's attempt and for every teacher surface that shows a
 * question as a student gets it (the Try tab, the grading panel's statement,
 * the previews).
 *
 * Three things happen here and nowhere else:
 *   - the component comes from the CLIENT registry and is `React.lazy`, so
 *     Monaco enters the bundle only on a route that shows a code question
 *     (N-PERF-05);
 *   - the host injects what a `qt-*` package cannot own: the strings of
 *     `i18n/` (built once in `questionTypes.tsx`) and `MarkdownView`, the ONE
 *     renderer of untrusted content a student sees (invariant 4 and
 *     DESIGN.md);
 *   - `onRun` comes from `src/runner/`, which decides between the backend
 *     runner and the browser one and owns the fallback between them
 *     (ADR-015); `POST /attempts/:id/run` is the backend half of it.
 *
 * The registry types every player as `ComponentType<PlayerProps<…>>`, which
 * is the shape of the contract and not of the host's extras (deviation W2-3
 * added `strings` / `renderMarkdown` / `renderText` as OPTIONAL props on each
 * component). One cast, here, names that fact instead of spreading it. A
 * player ignores the extras it does not declare, so they are passed to every
 * type alike.
 */
import { Suspense, type ComponentType, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import type { PlayerProps } from "@quiz/core/client";
import type { RunOutcome } from "@quiz/core/server";
import type { ClozeTextRenderer } from "@quiz/qt-cloze/client";

import { useT } from "../i18n";
import { ClozeMarkdownText } from "../markdown/ClozeMarkdownText";
import { MarkdownView } from "../markdown/MarkdownView";
import { Alert, ScrollableCode, Spinner } from "../ui";
import { canvasStringsProp, LazyRichText, playerStrings, questionType } from "../questionTypes";

/** What every shipped player accepts on top of the core contract. */
type PlayerHostProps = PlayerProps<unknown, unknown> & {
  strings?: unknown;
  /** `circuit` and `diagram`: the canvas ships a dictionary of its own. */
  canvasStrings?: unknown;
  /** `cloze`: its text with the blanks in place (`ClozeMarkdownText`). */
  renderText?: ClozeTextRenderer;
  onRun?: ((answer: unknown, options?: unknown) => Promise<RunOutcome>) | undefined;
  allowManualRun?: boolean | undefined;
  testsPrimary?: boolean | undefined;
  onSimulate?: ((answer: unknown) => Promise<RunOutcome>) | undefined;
};

/*
 * `inline`, because every place a question type calls this is already a
 * paragraph, a legend or a label: a <div> inside a <p> is invalid markup that
 * the browser silently repairs by closing the paragraph early, which moves the
 * text the student is reading.
 */
const inlineRenderer = (size: "sm" | "md") => (source: string): ReactNode => (
  <MarkdownView source={source} inline size={size} />
);
const RENDER_MARKDOWN = { sm: inlineRenderer("sm"), md: inlineRenderer("md") };

/**
 * "Has something been written here?" is the question TYPE's call, not ours.
 * It asks only whether SOMETHING was written — never whether it is right —
 * so it reads the answer and nothing of the key. A type the client registry
 * does not know falls back to "anything at all", and so does an answer the
 * type cannot read: it comes from storage, and a stored payload of another
 * shape must not take the whole attempt down.
 */
export function isAnswered(type: string, answer: unknown): boolean {
  if (answer === null || answer === undefined) return false;
  const client = questionType(type);
  if (!client) return true;
  try {
    return client.isAnswered(answer);
  } catch {
    return true;
  }
}

/**
 * The type asks for more than the reading column (`QuestionTypeClient.wide`):
 * the shell then gives its question the room right of the side column. A type
 * this build does not carry keeps the reading column.
 */
export function isWide(type: string): boolean {
  return questionType(type)?.wide === true;
}

/**
 * The type's own empty answer, for "Clear" (issue #89, multiple choice only).
 * `null` for a type the registry does not know: nothing is offered then.
 * Also `null` when the type cannot build one from `student`: the grading
 * panel hands a `null` student while no answer is shown, and a `cloze` or a
 * `diagram` reads its empty answer off the student view.
 */
export function emptyAnswerOf(type: string, student: unknown): unknown {
  const client = questionType(type);
  if (!client) return null;
  try {
    return client.emptyAnswer(student);
  } catch {
    return null;
  }
}

export function QuestionHost({
  type,
  student,
  answer,
  onChange,
  readOnly,
  onRun,
  allowManualRun,
  testsPrimary,
  onSimulate,
  onUnsent,
  Expand,
  onCanvasShortcuts,
  answerKey,
  size = "md",
}: {
  type: string;
  student: unknown;
  answer: unknown;
  onChange: (next: unknown) => void;
  readOnly: boolean;
  /** Present only for a type that has something to run. */
  onRun?: ((answer: unknown, options?: unknown) => Promise<RunOutcome>) | undefined;
  /** `code` only: whether the free stdin box has a runner that will take it. */
  allowManualRun?: boolean | undefined;
  /** `code` only: false where the host has its own primary action (the Try tab's "Run the tests"). */
  testsPrimary?: boolean | undefined;
  /**
   * `circuit` only: the simulation of `POST /attempts/:id/simulate`. It sits
   * beside `onRun` rather than inside it because the two answer different
   * questions — a program's output against a case, a circuit's waveform
   * against a stimulus — and neither has a browser half to fall back on here.
   */
  onSimulate?: ((answer: unknown) => Promise<RunOutcome>) | undefined;
  /** Where something is saved as one types: see `PlayerProps.onUnsent`. */
  onUnsent?: (unsent: boolean) => void;
  /** The attempt's expand layer (`PlayerProps.Expand`); a player that needs no room ignores it. */
  Expand?: PlayerProps<unknown, unknown>["Expand"];
  /** Where a focused canvas lends its keys (`PlayerProps.onCanvasShortcuts`): the side column. */
  onCanvasShortcuts?: PlayerProps<unknown, unknown>["onCanvasShortcuts"];
  /** A teacher's preview only, "Show answers" on: see `PlayerProps.answerKey`. */
  answerKey?: unknown;
  /**
   * The text's size: the student's (`md`), or the dense one (`sm`) where the
   * statement sits among 13 px reviews — the grading panel's key row.
   */
  size?: "sm" | "md";
}) {
  const t = useT();
  const client = questionType(type);
  if (!client) {
    return (
      <Alert tone="danger" icon={AlertTriangle} title={t("qt.unknown")}>
        {type}
      </Alert>
    );
  }
  const Player = client.Player as unknown as ComponentType<PlayerHostProps>;
  return (
    // `qt-code` shows the provided, locked part of the program in `<pre>`
    // blocks that scroll sideways at 390 px. A scroll container holding
    // nothing focusable is unreachable from a keyboard, and this is a student
    // under exam conditions (W10).
    <ScrollableCode label={t("markdown.codeBlock")}>
      <Suspense fallback={<Spinner className="py-16" />}>
        <Player
          student={student}
          answer={answer}
          onChange={onChange}
          readOnly={readOnly}
          strings={playerStrings[client.id](t)}
          {...canvasStringsProp(client.id, t)}
          renderMarkdown={RENDER_MARKDOWN[size]}
          renderText={ClozeMarkdownText}
          RichText={LazyRichText}
          onRun={onRun}
          allowManualRun={allowManualRun}
          testsPrimary={testsPrimary}
          onSimulate={onSimulate}
          {...(onUnsent ? { onUnsent } : {})}
          {...(Expand ? { Expand } : {})}
          {...(answerKey === undefined ? {} : { answerKey })}
          {...(onCanvasShortcuts ? { onCanvasShortcuts } : {})}
        />
      </Suspense>
    </ScrollableCode>
  );
}
