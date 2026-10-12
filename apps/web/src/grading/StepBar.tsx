import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { IconButton, Menu, ProgressSegments } from "../ui";

/** One step of the bar: what the menu names it, what it still asks for, and whether it is done. */
export interface Step {
  id: string;
  label: string;
  description?: string | undefined;
  done: boolean;
}

/**
 * Which step of a grading walk is on screen, and where every one stands —
 * the evaluation's questions (`QuestionBar`, ADR-044) and a project's
 * repositories (`project/grading`, ADR-106 §8). The chevrons walk one step
 * at a time, the same move as ← and →; the counter is a menu of every
 * step with what it still asks for; `lead` sits after the counter (what
 * the step is) and `status` before the last chevron (where it stands).
 * Under them, the steps as the player's stepper (`ProgressSegments`), a
 * done step answered, a click jumping to it.
 *
 * Never red: red on these screens is the thing to press, and a place in a
 * path is not an action (DESIGN.md › Color).
 */
export function StepBar({
  steps,
  index,
  onJump,
  label,
  position,
  prevLabel,
  nextLabel,
  lead,
  status,
  trailing,
}: {
  steps: Step[];
  index: number;
  onJump: (index: number) => void;
  /** The bar's accessible name, and the menu's. */
  label: string;
  /** The counter's words ("2 of 17"). */
  position: string;
  prevLabel: string;
  nextLabel: string;
  lead?: ReactNode;
  status?: ReactNode;
  /** After the last chevron, at the END of the bar: a secondary act's menu (ADR-108's counting), never a button beside the primary. */
  trailing?: ReactNode;
}) {
  return (
    <section aria-label={label} className="rounded-card border border-line bg-surface px-4 pb-2 pt-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <IconButton label={prevLabel} onClick={() => onJump(index - 1)} disabled={index === 0}>
          <ChevronLeft />
        </IconButton>
        <Menu
          label={label}
          align="start"
          trigger={
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-base font-bold tabular-nums tracking-tight transition-colors hover:bg-surface-2"
            >
              {position}
              <ChevronDown className="size-4 text-fg-faint" aria-hidden />
            </button>
          }
          items={steps.map((s, i) => ({
            label: s.label,
            ...(s.description === undefined ? {} : { description: s.description }),
            ...(i === index ? { icon: Check } : {}),
            onSelect: () => onJump(i),
          }))}
        />
        {lead}
        <span className="flex-1" />
        {status}
        <IconButton label={nextLabel} onClick={() => onJump(index + 1)} disabled={index >= steps.length - 1}>
          <ChevronRight />
        </IconButton>
        {trailing}
      </div>
      {steps.length > 1 ? (
        <ProgressSegments
          className="mt-1"
          label={label}
          onSelect={(_id, i) => onJump(i)}
          segments={steps.map((s, i) => ({ id: s.id, mark: s.done ? "answered" : "unanswered", current: i === index }))}
        />
      ) : null}
    </section>
  );
}
