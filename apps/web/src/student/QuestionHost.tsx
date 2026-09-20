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
 *   - `onRun` is adapted from `POST /attempts/:id/run`.
 *
 * The registry types every player as `ComponentType<PlayerProps<…>>`, which
 * is the shape of the contract and not of the host's extras (deviation W2-3
 * added `strings` / `renderMarkdown` / `renderText` as OPTIONAL props on each
 * component). One cast, here, names that fact instead of spreading it.
 */
import { Suspense, type ComponentType, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import type { PlayerProps } from "@quiz/core/client";
import type { RunnerOutcome } from "@quiz/core/server";
import { questionTypeClient } from "@quiz/registry/client";

import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { Alert, Spinner } from "../ui";
import { playerStringsFor } from "./questionStrings";

/** What every shipped player accepts on top of the core contract. */
interface HostPlayerProps extends PlayerProps<unknown, unknown> {
  strings?: unknown;
  renderMarkdown?: (source: string) => ReactNode;
  onRun?: (answer: unknown) => Promise<RunnerOutcome | "unavailable">;
}

/*
 * `inline`, because every place a question type calls this is already a
 * paragraph, a legend or a label: a <div> inside a <p> is invalid markup that
 * the browser silently repairs by closing the paragraph early, which moves the
 * text the student is reading.
 */
const renderMarkdown = (source: string): ReactNode => <MarkdownView source={source} inline />;

export function QuestionHost({
  type,
  student,
  answer,
  onChange,
  readOnly,
  onRun,
}: {
  type: string;
  student: unknown;
  answer: unknown;
  onChange: (next: unknown) => void;
  readOnly: boolean;
  /** Present only for a type that has something to run. */
  onRun?: (answer: unknown) => Promise<RunnerOutcome | "unavailable">;
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
    <Suspense fallback={<Spinner className="py-16" />}>
      <Player
        student={student}
        answer={answer}
        onChange={onChange}
        readOnly={readOnly}
        strings={playerStringsFor(type, t)}
        renderMarkdown={renderMarkdown}
        {...(onRun ? { onRun } : {})}
      />
    </Suspense>
  );
}
