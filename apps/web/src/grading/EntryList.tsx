import { GraduationCap } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import type { GradingEntry, GradingQueueItem } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { useT, type TFunction } from "../i18n";
import { cx, Select, VerdictCell } from "../ui";
import { entryVerdict } from "./labels";

/** Stable identity of a cell: one grading per (attempt, item). */
export const entryKey = (e: Pick<GradingEntry, "attemptId" | "itemId">) =>
  `${e.attemptId}:${e.itemId}`;

/** What a row names: a pseudonym by question, a question by student. */
export type RowLabel = (entry: GradingEntry, item: GradingQueueItem | undefined) => string;

/**
 * Where a cell stands, in the one word a row has room for. `adjusted` is a
 * validated grading the teacher wrote themselves — an override, or a
 * proposal whose points they changed — because "validated" alone would hide
 * that the machine's number is no longer the one that counts.
 */
export function entryStateLabel(t: TFunction, entry: GradingEntry): string {
  const grading = entry.grading;
  if (!grading) return t("grading.entry.state.ungraded");
  if (grading.state === "proposed") return t("grading.entry.state.proposed");
  return t(
    grading.source === "manual" ? "grading.entry.state.adjusted" : "grading.entry.state.validated",
  );
}

export function entryScore(t: TFunction, entry: GradingEntry): string {
  const grading = entry.grading;
  return grading
    ? t("grading.score", {
        points: formatPoints(grading.points),
        max: formatPoints(grading.maxPoints),
      })
    : "—";
}

interface ListProps {
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
  rowLabel: RowLabel;
  className?: string;
}

/**
 * The answers of the current step as a compact column: one line per answer,
 * proposals first, the open one marked `aria-current`. A click (or Enter — it
 * is a real button) shows that answer in the detail beside the list.
 *
 * The list used to expand the open answer IN PLACE under its row, on the
 * grounds that it kept one reading order on a phone and on a 27-inch screen.
 * In use it made the answer being graded slide one row further down at every
 * step, and the teacher chased it down the page thirty times per question
 * (#102). So the answer now lives in ONE fixed place — the detail — and this
 * list only says where the teacher is and lets them jump: it never grows,
 * and moving through it moves nothing else. On a phone there is no room for
 * a column beside the answer, so the same list collapses into `EntryPicker`,
 * a select above it; the reading order there is still "which answer, then
 * the answer".
 *
 * The list keeps the open row in view by scrolling ITSELF, measured by hand:
 * `scrollIntoView` scrolls every scrollable ancestor, the page included, and
 * the page must not move under the teacher's eyes.
 */
export function EntryList({ entries, items, selectedKey, onSelect, rowLabel, className }: ListProps) {
  const t = useT();
  const list = useRef<HTMLUListElement>(null);
  const open = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const box = list.current;
    const row = open.current;
    if (!box || !row) return;
    const outer = box.getBoundingClientRect();
    const inner = row.getBoundingClientRect();
    if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top;
    else if (inner.bottom > outer.bottom) box.scrollTop += inner.bottom - outer.bottom;
  }, [selectedKey, entries]);

  return (
    <ul
      ref={list}
      aria-label={t("grading.list.label")}
      className={cx("space-y-0.5 overflow-y-auto p-1.5", className)}
    >
      {entries.map((entry) => {
        const key = entryKey(entry);
        const current = key === selectedKey;
        const name = rowLabel(entry, items.get(entry.itemId));
        const state = entryStateLabel(t, entry);
        const score = entryScore(t, entry);
        return (
          <li key={key}>
            <button
              ref={current ? open : undefined}
              type="button"
              onClick={() => onSelect(key)}
              aria-current={current ? "true" : undefined}
              aria-label={t("grading.entry.row", { label: name, state, score })}
              className={cx(
                "flex w-full items-center gap-2.5 rounded-field px-2 py-1.5 text-left transition-colors",
                current ? "bg-accent-soft" : "hover:bg-surface-2",
              )}
            >
              <span className="w-9 shrink-0">
                <VerdictCell state={entryVerdict(entry)} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cx(
                    "flex items-center gap-1.5 text-[13px] font-semibold",
                    current ? "text-accent" : "text-fg",
                  )}
                >
                  <span className="truncate">{name}</span>
                  {/* The teacher's own test walk (ADR-018): corrected like any
                      other answer, and marked so it is not read as a student's. */}
                  {entry.staff ? (
                    <GraduationCap className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
                  ) : null}
                </span>
                <span className="block truncate text-xs text-fg-faint">{state}</span>
              </span>
              <span className="shrink-0 text-xs font-semibold tabular-nums text-fg-muted">
                {score}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * `EntryList` on a phone: the same answers in the same order, as a native
 * select above the detail. A column of rows beside a 390 px answer leaves
 * room for neither; a select costs one line and opens the platform's own
 * picker, which is the best list a phone has.
 */
export function EntryPicker({ entries, items, selectedKey, onSelect, rowLabel, className }: ListProps) {
  const t = useT();
  return (
    <div className={className}>
      <Select
        aria-label={t("grading.list.pick")}
        value={selectedKey ?? ""}
        onChange={(e) => onSelect(e.target.value)}
      >
        {entries.map((entry) => {
          const key = entryKey(entry);
          return (
            <option key={key} value={key}>
              {t("grading.entry.row", {
                label: rowLabel(entry, items.get(entry.itemId)),
                state: entryStateLabel(t, entry),
                score: entryScore(t, entry),
              })}
            </option>
          );
        })}
      </Select>
    </div>
  );
}
