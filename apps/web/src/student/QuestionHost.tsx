/**
 * Mounts the question type's own `Player` for one item.
 *
 * Three things happen here and nowhere else:
 *   - the component comes from the CLIENT registry and is `React.lazy`, so
 *     Monaco enters the bundle only on a route that shows a code question
 *     (N-PERF-05);
 *   - the host injects what a `qt-*` package cannot own: the French strings
 *     (`questionStrings.ts`) and `MarkdownView`, the ONE renderer of
 *     untrusted content a student sees (invariant 4 and DESIGN.md);
 *   - `onRun` comes from `src/runner/`, which decides between the backend
 *     runner and the browser one and owns the fallback between them
 *     (ADR-015); `POST /attempts/:id/run` is the backend half of it.
 *
 * The registry types every player as `ComponentType<PlayerProps<…>>`, which
 * is the shape of the contract and not of the host's extras (deviation W2-3
 * added `strings` / `renderMarkdown` / `renderText` as OPTIONAL props on each
 * component). One cast, here, names that fact instead of spreading it.
 */
import { Suspense, type ComponentType, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import type { PlayerProps } from "@quiz/core/client";
import type { ClozeTextRenderer } from "@quiz/qt-cloze/client";
import type { RunnerOutcome } from "@quiz/core/server";
import { questionTypeClient } from "@quiz/registry/client";

import { useT } from "../i18n";
import { ClozeMarkdownText } from "../markdown/ClozeMarkdownText";
import { MarkdownView } from "../markdown/MarkdownView";
import { Alert, ScrollableCode, Spinner } from "../ui";
import { circuitCanvasStringsFor, playerStringsFor } from "./questionStrings";

/** What every shipped player accepts on top of the core contract. */
interface HostPlayerProps extends PlayerProps<unknown, unknown> {
  strings?: unknown;
  /** `circuit` only: the canvas ships a dictionary of its own. */
  canvasStrings?: unknown;
  renderMarkdown?: (source: string) => ReactNode;
  /** `cloze` only: its text with the blanks in place, through the app's pipeline. */
  renderText?: ClozeTextRenderer;
  onRun?: (answer: unknown, options?: unknown) => Promise<RunnerOutcome | "unavailable" | "rate_limited">;
  allowManualRun?: boolean;
  onSimulate?: (answer: unknown) => Promise<RunnerOutcome | "unavailable" | "rate_limited">;
}

/*
 * `inline`, because every place a question type calls this is already a
 * paragraph, a legend or a label: a <div> inside a <p> is invalid markup that
 * the browser silently repairs by closing the paragraph early, which moves the
 * text the student is reading.
 */
const renderMarkdown = (source: string): ReactNode => <MarkdownView source={source} inline />;

/**
 * "Has something been written here?" is the question TYPE's call, not ours.
 * It asks only whether SOMETHING was written — never whether it is right —
 * so it reads the answer and nothing of the key. A type the client registry
 * does not know falls back to "anything at all".
 */
export function isAnswered(type: string, answer: unknown): boolean {
  try {
    return questionTypeClient(type).isAnswered(answer ?? null);
  } catch {
    return answer !== null && answer !== undefined;
  }
}

/**
 * The type's own empty answer, for "Clear" (issue #89, multiple choice only).
 * `null` for a type the registry does not know: nothing is offered then.
 */
export function emptyAnswerOf(type: string, student: unknown): unknown {
  try {
    return questionTypeClient(type).emptyAnswer(student);
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
  onSimulate,
}: {
  type: string;
  student: unknown;
  answer: unknown;
  onChange: (next: unknown) => void;
  readOnly: boolean;
  /** Present only for a type that has something to run. */
  onRun?: (answer: unknown, options?: unknown) => Promise<RunnerOutcome | "unavailable" | "rate_limited">;
  /** `code` only: whether the free stdin box has a runner that will take it. */
  allowManualRun?: boolean;
  /**
   * `circuit` only: the simulation of `POST /attempts/:id/simulate`. It sits
   * beside `onRun` rather than inside it because the two answer different
   * questions — a program's output against a case, a circuit's waveform
   * against a stimulus — and neither has a browser half to fall back on here.
   */
  onSimulate?: (answer: unknown) => Promise<RunnerOutcome | "unavailable" | "rate_limited">;
}) {
  const t = useT();
  let Player: ComponentType<HostPlayerProps>;
  try {
    Player = questionTypeClient(type).Player as unknown as ComponentType<HostPlayerProps>;
  } catch {
    return (
      <Alert tone="danger" icon={AlertTriangle} title={t("player.loadFailed")}>
        {type}
      </Alert>
    );
  }
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
          strings={playerStringsFor(type, t)}
          {...(type === "circuit" ? { canvasStrings: circuitCanvasStringsFor(t) } : {})}
          renderMarkdown={renderMarkdown}
          {...(type === "cloze" ? { renderText: ClozeMarkdownText } : {})}
          {...(onRun ? { onRun } : {})}
          {...(allowManualRun === undefined ? {} : { allowManualRun })}
          {...(onSimulate ? { onSimulate } : {})}
        />
      </Suspense>
    </ScrollableCode>
  );
}
