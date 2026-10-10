import { useId } from "react";

import { useT } from "../i18n";
import { Segmented } from "./controls";

/**
 * "Group by" over a list (the pool's questions, a classroom's evaluations):
 * an 11 px caption and a small `Segmented` of the groupings, one size down
 * from the list's own controls — a reader's habit, not the data's state.
 * The caption names the radiogroup. The first option is the list
 * ungrouped, worded by the caller (`common.group.none`).
 */
export function GroupBySwitch<T extends string>({
  name,
  value,
  onChange,
  options,
}: {
  name: string;
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  const t = useT();
  const caption = useId();
  return (
    <div className="flex items-center gap-1.5">
      <span id={caption} className="text-[11px] text-fg-faint">
        {t("common.groupBy")}
      </span>
      <Segmented name={name} labelledBy={caption} value={value} onChange={onChange} options={options} />
    </div>
  );
}
