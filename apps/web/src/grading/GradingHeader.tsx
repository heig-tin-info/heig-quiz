import { ChevronLeft, ChevronRight, Play } from "lucide-react";

import type { GradingProgress, GradingQueue } from "@quiz/contracts";

import { useT } from "../i18n";
import { Button, cx, IconButton } from "../ui";
import type { GradingOrder } from "./labels";
import { StepPicker } from "./StepPicker";
import type { Step } from "./useGradingTraversal";

/**
 * Where the correction stands: a path of N steps (one per question, or one
 * per student), the current one in ink, and a neutral bar for the answers
 * already validated. The step counter is the step PICKER (#107): the
 * chevrons walk one step, the counter opens every step to jump to one; the
 * strip of bars under them stays a picture of the path, not a control.
 *
 * Never red. Red on this screen means "the thing to press", and an
 * advancement bar is not an action — mockup `04-correction.html` makes the
 * same point in its own comment.
 */
export function GradingHeader({
  order,
  steps,
  index,
  onPrev,
  onNext,
  onJump,
  prevLabel,
  nextLabel,
  title,
  counts,
  progress,
  onRun,
  running,
  runPrimary,
}: {
  order: GradingOrder;
  steps: Step[];
  index: number;
  onPrev: () => void;
  onNext: () => void;
  onJump: (index: number) => void;
  prevLabel: string;
  nextLabel: string;
  /** "Question 5 of 8". */
  title: string;
  counts: GradingQueue["counts"];
  progress: GradingProgress | undefined;
  onRun: () => void;
  running: boolean;
  /** True while running the pass IS the one thing to do on this screen. */
  runPrimary: boolean;
}) {
  const t = useT();
  const done = counts.total === 0 ? 0 : Math.round((counts.validated / counts.total) * 100);
  const passIncomplete = progress !== undefined && progress.total > 0 && progress.done < progress.total;

  return (
    <section
      aria-label={t("grading.progress.title")}
      className="relative rounded-card border border-line bg-surface px-4 py-3.5 sm:px-5"
    >
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
        <IconButton label={prevLabel} onClick={onPrev} disabled={steps.length < 2}>
          <ChevronLeft />
        </IconButton>
        <StepPicker order={order} steps={steps} index={index} title={title} onJump={onJump} />
        <span className="text-[13px] text-fg-muted">
          {t(counts.proposed === 1 ? "grading.remaining.one" : "grading.remaining", {
            n: counts.proposed,
          })}
        </span>
        <span className="flex-1" />
        <div
          role="img"
          aria-label={t("grading.validatedOf", {
            validated: counts.validated,
            total: counts.total,
          })}
          className="h-1.5 w-44 overflow-hidden rounded-full bg-surface-3"
        >
          <div className="h-full rounded-full bg-fg" style={{ width: `${done}%` }} />
        </div>
        <span className="text-xs tabular-nums text-fg-muted">
          {counts.validated} / {counts.total}
        </span>
        <IconButton label={nextLabel} onClick={onNext} disabled={steps.length < 2}>
          <ChevronRight />
        </IconButton>
      </div>

      {steps.length > 1 ? (
        <div className="mt-3 flex gap-1" aria-hidden>
          {steps.map((step, i) => (
            <span
              key={step.key}
              className={cx(
                "h-1.5 flex-1 rounded-full",
                i < index ? "bg-fg-muted" : i === index ? "bg-fg" : "bg-surface-3",
              )}
            />
          ))}
        </div>
      ) : null}

      {progress ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3 text-[13px] text-fg-muted">
          <span>
            {t("grading.progress.title")} ·{" "}
            <span className="tabular-nums">
              {t("grading.progress.value", { done: progress.done, total: progress.total })}
            </span>
          </span>
          {progress.pending.runner > 0 ? (
            <span className="text-fg-faint">
              {t("grading.progress.runner", { n: progress.pending.runner })}
            </span>
          ) : null}
          {progress.failed > 0 ? (
            <span className="text-danger">{t("grading.progress.failed", { n: progress.failed })}</span>
          ) : null}
          <span className="flex-1" />
          {passIncomplete ? (
            <Button
              size="sm"
              variant={runPrimary ? "primary" : "secondary"}
              onClick={onRun}
              loading={running}
            >
              <Play /> {t("grading.run")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
