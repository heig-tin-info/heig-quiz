import { Check } from "lucide-react";

import type { ItemCounting } from "@quiz/contracts";
import { ITEM_COUNTINGS } from "@quiz/domain";

import { CountingLabel } from "../CountingLabel";
import type { Dict } from "../i18n";
import { useT } from "../i18n";
import { typeLabel } from "../questionTypes";
import { Badge, Menu } from "../ui";
import { StepBar } from "./StepBar";
import type { GradingItem, StepState } from "./useGradingData";

/** The menu's words for each counting (ADR-108). */
const COUNTING_LABEL: Record<ItemCounting, keyof Dict> = {
  normal: "grading.counting.normal",
  bonus: "grading.counting.bonus",
  neutralized: "grading.counting.neutralized",
};

/**
 * The question bar's part of the counting act (ADR-108): the menu's
 * states, the current one ticked, a choice that would leave nothing in the
 * total greyed out; `onChange` asks and writes (`useItemCounting`).
 */
export interface CountingMenu {
  refused: (counting: ItemCounting) => boolean;
  onChange: (counting: ItemCounting) => void;
}

/** What a question still asks for: the answers not validated yet. */
const leftOf = (state: StepState | undefined) =>
  state === undefined ? null : state.total - state.validated;

/**
 * Which question is being graded, and where every question stands
 * (ADR-044), on the shared `StepBar`: a question is "done" once every one
 * of its answers is validated; its type, its points (and how it counts,
 * when not normally) and its internal name after the counter, what it
 * still asks for before the last chevron.
 *
 * Once the evaluation has run, the ⋯ menu changes how the question counts
 * — normally, as a bonus, or not at all (ADR-108): a secondary act, so a
 * menu at the end of the bar (`trailing`) and never a button beside the
 * primary one.
 */
export function QuestionBar({
  items,
  index,
  states,
  onJump,
  counting,
}: {
  items: GradingItem[];
  index: number;
  states: ReadonlyMap<string, StepState>;
  onJump: (index: number) => void;
  /** Absent before the list is frozen, and for a reader who may not grade. */
  counting?: CountingMenu | undefined;
}) {
  const t = useT();
  const item = items[index];
  if (!item) return null;
  const left = leftOf(states.get(item.id));
  const stateWords = (n: number | null) =>
    n === null ? undefined : n > 0 ? t("grading.steps.toValidate", { n }) : t("grading.steps.done");

  return (
    <StepBar
      label={t("grading.questions")}
      position={t("grading.item.position", { n: index + 1, total: items.length })}
      prevLabel={t("grading.prevItem")}
      nextLabel={t("grading.nextItem")}
      index={index}
      onJump={onJump}
      steps={items.map((it, i) => {
        const n = leftOf(states.get(it.id));
        return { id: it.id, label: `${i + 1}. ${it.internalName}`, description: stateWords(n), done: n === 0 };
      })}
      lead={
        <>
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone="zinc">{typeLabel(t, item.type)}</Badge>
            <Badge tone="zinc">{t("grading.points", { n: item.points })}</Badge>
            <CountingLabel counting={item.counting} />
          </span>
          <span className="min-w-0 truncate text-[13px] text-fg-muted">{item.internalName}</span>
        </>
      }
      status={
        left === null ? null : (
          <Badge tone={left > 0 ? "amber" : "green"} icon={left > 0 ? undefined : Check}>
            {stateWords(left)}
          </Badge>
        )
      }
      trailing={
        counting ? (
          <Menu
            label={t("grading.counting.menu")}
            items={ITEM_COUNTINGS.map((option) => {
              const current = option === item.counting;
              const refused = !current && counting.refused(option);
              return {
                label: t(COUNTING_LABEL[option]),
                ...(current ? { icon: Check } : {}),
                ...(refused ? { disabled: true, description: t("grading.counting.noGradedPoints") } : {}),
                onSelect: () => counting.onChange(option),
              };
            })}
          />
        ) : null
      }
    />
  );
}
