import type { Ref } from "react";

import type { GradingQueueItem } from "@quiz/contracts";

import { useT } from "../i18n";
import { cx } from "../ui";
import { StepAnswers, StepList } from "./GradingStep";
import type { GradingSession } from "./useGradingSession";

/**
 * Master and detail from `lg`: the list column sticks under the step header
 * and scrolls inside itself; the answer is in the page's flow, at least a
 * window tall, its own header sticking under the step header. Moving to
 * another answer brings the answer's top back under that header
 * (`useAnswerAnchor`), so the teacher never scrolls to find it and it is
 * always read from the same spot. Below `lg` the columns stack, the list
 * becomes a select above the answer, and the same alignment happens under
 * the phone's top bar.
 */
export function GradingWorkspace({
  session,
  answersRef,
  validating,
  onValidate,
  onOverride,
  onRegrade,
}: {
  session: GradingSession;
  answersRef: Ref<HTMLElement>;
  validating: boolean;
  onValidate: (gradingId: string) => void;
  onOverride: (entryKey: string) => void;
  onRegrade: (item: GradingQueueItem) => void;
}) {
  const t = useT();
  const { view, queue, entries, itemsById, selected, select } = session;
  // Nothing to list, nothing to draw: an empty column would push the
  // detail's empty state off centre for nothing.
  const listed = queue.isLoading || (!queue.isError && entries.length > 0);

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* Only the list lives here since #108: below `lg` it is the select
          above the answer, and the column is not drawn. */}
      <aside
        aria-label={t("aside.gradingItem")}
        className={cx(
          "hidden w-full shrink-0 flex-col gap-4 lg:sticky lg:top-(--grading-sticky) lg:max-h-[calc(100dvh-var(--grading-sticky)-1rem)] lg:w-75",
          listed && "lg:flex",
        )}
      >
        <StepList
          className="flex min-h-0 flex-1"
          order={view.order}
          queue={queue}
          entries={entries}
          items={itemsById}
          selected={selected}
          onSelect={select}
        />
      </aside>

      <section
        ref={answersRef}
        className="flex w-full min-w-0 flex-1 flex-col gap-3"
        aria-label={t("grading.title")}
      >
        <StepAnswers
          order={view.order}
          queue={queue}
          entries={entries}
          items={itemsById}
          selected={selected}
          current={session.current}
          onSelect={select}
          onMove={session.move}
          explanations={session.explanations}
          validating={validating}
          onValidate={onValidate}
          onOverride={onOverride}
          onRegrade={onRegrade}
          parts={view.parts}
        />
      </section>
    </div>
  );
}
