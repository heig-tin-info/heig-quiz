import { GraduationCap } from "lucide-react";
import type { ReactNode } from "react";

import type { GradingEntry, GradingQueueItem } from "@quiz/contracts";

import { useT } from "../i18n";
import { Badge, cx, pressable, VerdictCell } from "../ui";
import { confidenceLabel, confidenceTone, entryVerdict, round2, sourceLabel, sourceTone } from "./labels";

/** Stable identity of a cell: one grading per (attempt, item). */
export const entryKey = (e: Pick<GradingEntry, "attemptId" | "itemId">) =>
  `${e.attemptId}:${e.itemId}`;

/**
 * The answers of the current traversal, proposals first, the open one
 * expanded in place.
 *
 * A list and not a table: a row carries a verdict cell, a pseudonym, two
 * badges and a score, and the thing under it is a whole answer. Expanding in
 * place — rather than a right-hand panel — keeps the reading order the same
 * on a phone and on a 27-inch screen, and it is what the mockup walks
 * through with the keyboard.
 */
export function EntryList({
  entries,
  items,
  selectedKey,
  onSelect,
  rowLabel,
  renderDetail,
}: {
  entries: GradingEntry[];
  /** The item each entry belongs to, by id (a by-student traversal mixes them). */
  items: Map<string, GradingQueueItem>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /**
   * What names a row. Traversing BY QUESTION the rows are students, so the
   * pseudonym names them; traversing BY STUDENT they are the six questions of
   * one attempt, and thirty rows all reading "Merry Vicuna" name nothing.
   */
  rowLabel: (entry: GradingEntry, item: GradingQueueItem | undefined) => string;
  renderDetail: (entry: GradingEntry, item: GradingQueueItem) => ReactNode;
}) {
  const t = useT();
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
      {entries.map((entry) => {
        const key = entryKey(entry);
        const item = items.get(entry.itemId);
        const grading = entry.grading;
        const open = key === selectedKey;
        const name = rowLabel(entry, item);
        return (
          <li key={key} className={cx(open && "bg-surface-2/40")}>
            <div
              {...pressable(() => onSelect(key))}
              aria-expanded={open}
              aria-label={t("grading.entry.open", { label: name })}
              className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2/70 sm:px-5"
            >
              <span className="w-10 shrink-0">
                <VerdictCell state={entryVerdict(entry)} />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</span>
              {/* The teacher's own test walk (ADR-018). It is corrected like
                  any other answer — they asked for it — and the badge is what
                  stops it being read as a student's. */}
              {entry.staff ? (
                <Badge tone="zinc" icon={GraduationCap}>
                  {t("roster.status.staff")}
                </Badge>
              ) : null}
              {/* The badges hide on a phone through their WRAPPER: `hidden`
                  on a `Badge` loses to the `inline-flex` of its own base
                  class, which the stylesheet emits later. */}
              <span className="hidden shrink-0 items-center gap-2 sm:flex">
                {grading?.confidence ? (
                  <Badge tone={confidenceTone(grading.confidence)}>
                    {confidenceLabel(t, grading.confidence)}
                  </Badge>
                ) : null}
                {grading ? (
                  <Badge tone={sourceTone(grading.source)}>{sourceLabel(t, grading.source)}</Badge>
                ) : null}
              </span>
              <span className="w-16 shrink-0 text-right text-[13px] font-semibold tabular-nums">
                {grading
                  ? t("grading.score", {
                      points: round2(grading.points),
                      max: round2(grading.maxPoints),
                    })
                  : "—"}
              </span>
            </div>
            {open && item ? renderDetail(entry, item) : null}
          </li>
        );
      })}
    </ul>
  );
}
