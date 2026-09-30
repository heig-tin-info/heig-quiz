import { memo, useCallback } from "react";
import { Check, Lock, Minus } from "lucide-react";

import type { AnswerMark } from "@quiz/domain";
import type {
  CodeAnswer,
  CodeImageAnswer,
  CodeImageStudent,
  CodeRunOptions,
  CodeRunStage,
  CodeStudent,
} from "@quiz/qt-code/client";

import type { RunFn, RunResult } from "../attempt/run";
import { useT, type TFunction } from "../i18n";
import { runCode, runCodeImage } from "../runner/codeRun";
import { Badge } from "../ui";
import { ExpandLayer } from "./ExpandLayer";
import { isAnswered, QuestionHost } from "./QuestionHost";

/**
 * The question itself, wired to the attempt: the type's own player, with
 * what it needs to answer, run and simulate.
 *
 * Memoised, with every callback built here from stable parts, because what
 * it mounts is the heaviest thing on the exam screen — Monaco, the circuit
 * canvas, rich text. It re-renders when ITS answer or its lock changes, and
 * not when the sync badge, the flag or the countdown above it move.
 */
export const PlayerQuestion = memo(function PlayerQuestion({
  itemId,
  type,
  student,
  answer,
  readOnly,
  setAnswer,
  run,
  simulate,
  onUnsent,
}: {
  itemId: string;
  type: string;
  student: unknown;
  answer: unknown;
  readOnly: boolean;
  setAnswer: (itemId: string, payload: unknown, answered?: boolean) => void;
  run: RunFn;
  simulate: (itemId: string, answer: unknown) => Promise<RunResult>;
  /** The player holds an edit it does not send: the badge must not say "Saved". */
  onUnsent: (unsent: boolean) => void;
}) {
  const onChange = useCallback(
    (payload: unknown) => setAnswer(itemId, payload, isAnswered(type, payload)),
    [itemId, type, setAnswer],
  );
  // `POST /attempts/:id/run` takes a free stdin and a command line, and so
  // does the browser runner: the box is offered whichever one ends up
  // serving it.
  const runCodeAnswer = useCallback(
    (answer: unknown, options?: unknown) =>
      runCode({
        student: student as CodeStudent,
        answer: answer as CodeAnswer,
        // The backend path is the API call it always was. It sends the
        // regions and, if there is one, the free input or the compile-only
        // flag: the program itself is rebuilt server-side (invariant 14).
        backend: (manual, backendOptions) =>
          run(itemId, (answer as { regions?: string[] }).regions ?? [], manual, backendOptions),
        options: options as CodeRunOptions | undefined,
      }),
    [itemId, student, run],
  );
  const simulateAnswer = useCallback(
    (answer: unknown) => simulate(itemId, answer),
    [itemId, simulate],
  );
  // Where it runs is `code`'s rule (ADR-015): the browser for
  // `runtime: "runno"`, else the server, which rebuilds the program from the
  // stored template (invariant 14) behind the generic simulate route.
  const runImageAnswer = useCallback(
    (answer: unknown, options?: unknown) =>
      runCodeImage({
        student: student as CodeImageStudent,
        answer: answer as CodeImageAnswer,
        backend: () => simulate(itemId, answer),
        options: options as { onStage?: (stage: CodeRunStage) => void } | undefined,
      }),
    [itemId, student, simulate],
  );
  return (
    <QuestionHost
      type={type}
      student={student}
      answer={answer}
      onChange={onChange}
      readOnly={readOnly}
      onUnsent={onUnsent}
      // The room a canvas needs (ADR-046 §6); every type but `diagram` ignores it.
      Expand={ExpandLayer}
      {...(type === "code" ? { allowManualRun: true, onRun: runCodeAnswer } : {})}
      {...(type === "circuit" ? { onSimulate: simulateAnswer } : {})}
      {...(type === "codeimage" ? { onRun: runImageAnswer } : {})}
    />
  );
});

/**
 * "Question 2", its state in a word AND a symbol — the same symbols as the
 * list above — and what it is worth.
 */
export function QuestionHeading({
  index,
  points,
  validated,
  mark,
}: {
  /** Zero-based position in the paper. */
  index: number;
  /** Absent on a wide screen: the side column says it, beside the list. */
  points?: number;
  validated: boolean;
  mark: AnswerMark;
}) {
  const t = useT();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      {/* Not a heading: "Question 2 of 4" names a position, not a section,
          and as an `h1` it renamed the document on every move (W5). It is
          announced instead — politely, because the student is reading, not
          waiting. */}
      <p
        aria-live="polite"
        className="text-[13px] font-semibold uppercase tracking-wide text-fg-muted"
      >
        {/* "Question 2", not "2 of 4": the strip above already counts, and
            one question per page needs no second counter. */}
        {t("player.question", { n: index + 1 })}
      </p>
      {/* Nothing for "not answered yet": that is what a question is until
          it is not. */}
      {validated ? (
        <Badge tone="zinc" icon={Lock}>
          {t("player.validated")}
        </Badge>
      ) : mark === "answered" ? (
        <Badge tone="zinc" icon={Check}>
          {t("player.answered")}
        </Badge>
      ) : mark === "skipped" ? (
        <Badge tone="zinc" icon={Minus}>
          {t("player.skipped")}
        </Badge>
      ) : null}
      {points === undefined ? null : (
        <span className="ml-auto text-[13px] text-fg-muted">{pointsLabel(t, points)}</span>
      )}
    </div>
  );
}

/** "1 point", "3 points": what a question is worth. */
export function pointsLabel(t: TFunction, points: number): string {
  return points === 1 ? t("player.point") : t("player.points", { n: points });
}
