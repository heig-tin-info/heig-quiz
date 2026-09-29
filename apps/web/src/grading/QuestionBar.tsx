import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import { useT } from "../i18n";
import { typeLabel } from "../questionTypes";
import { Badge, IconButton, Menu, ProgressSegments } from "../ui";
import type { GradingItem, StepState } from "./useGradingData";

/** What a question still asks for: the answers not validated yet. */
const leftOf = (state: StepState | undefined) =>
  state === undefined ? null : state.total - state.validated;

/**
 * Which question is being graded, and where every question stands
 * (ADR-040). The counter is a menu of every question with what it still
 * asks for; the chevrons walk one question at a time, the same move as ←
 * and →. Under them, the evaluation's questions as the student player's
 * stepper (`ProgressSegments`, reused as it is): a question is "done" once
 * every one of its answers is validated, and a click jumps to it.
 *
 * Never red: red on this screen is the thing to press, and a place in a
 * path is not an action (DESIGN.md › Color).
 */
export function QuestionBar({
  items,
  index,
  states,
  onJump,
}: {
  items: GradingItem[];
  index: number;
  states: ReadonlyMap<string, StepState>;
  onJump: (index: number) => void;
}) {
  const t = useT();
  const item = items[index];
  if (!item) return null;
  const left = leftOf(states.get(item.id));
  const stateWords = (n: number | null) =>
    n === null ? undefined : n > 0 ? t("grading.steps.toValidate", { n }) : t("grading.steps.done");

  return (
    <section
      aria-label={t("grading.questions")}
      className="rounded-card border border-line bg-surface px-4 pb-2 pt-3 sm:px-5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <IconButton
          label={t("grading.prevItem")}
          onClick={() => onJump(index - 1)}
          disabled={index === 0}
        >
          <ChevronLeft />
        </IconButton>
        <Menu
          label={t("grading.questions")}
          align="start"
          trigger={
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-base font-bold tabular-nums tracking-tight transition-colors hover:bg-surface-2"
            >
              {t("grading.item.position", { n: index + 1, total: items.length })}
              <ChevronDown className="size-4 text-fg-faint" aria-hidden />
            </button>
          }
          items={items.map((it, i) => ({
            label: `${i + 1}. ${it.internalName}`,
            description: stateWords(leftOf(states.get(it.id))),
            ...(i === index ? { icon: Check } : {}),
            onSelect: () => onJump(i),
          }))}
        />
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone="zinc">{typeLabel(t, item.type)}</Badge>
          <Badge tone="zinc">{t("grading.points", { n: item.points })}</Badge>
        </span>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-fg-muted">
          {item.internalName}
        </span>
        <span className="flex-1" />
        {left === null ? null : (
          <Badge tone={left > 0 ? "amber" : "green"} icon={left > 0 ? undefined : Check}>
            {stateWords(left)}
          </Badge>
        )}
        <IconButton
          label={t("grading.nextItem")}
          onClick={() => onJump(index + 1)}
          disabled={index >= items.length - 1}
        >
          <ChevronRight />
        </IconButton>
      </div>
      {items.length > 1 ? (
        <ProgressSegments
          className="mt-1"
          label={t("grading.questions")}
          onSelect={(_id, i) => onJump(i)}
          segments={items.map((it, i) => {
            const n = leftOf(states.get(it.id));
            return {
              id: it.id,
              mark: n === 0 ? "answered" : "unanswered",
              current: i === index,
            };
          })}
        />
      ) : null}
    </section>
  );
}
