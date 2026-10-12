import { AlertTriangle, Check, ChevronRight, FlaskConical, Lock, Sparkles, UserRound } from "lucide-react";
import { useId, useState } from "react";

import type { CriteriaTableRow, CriterionGradeWrite, CriterionReason } from "@quiz/contracts";
import { awardedRange } from "@quiz/domain";

import { useT, type Dict } from "../../i18n";
import { Badge, Button, cx, FieldError, fieldErrorProps, T, TableHead, Textarea, TextInput, Tip, useNumberDraft, type Column } from "../../ui";

type Source = NonNullable<CriteriaTableRow["source"]>;

const SOURCE_ICON = { auto: FlaskConical, llm: Sparkles, manual: UserRound } as const;
const SOURCE_KEY: Record<Source, keyof Dict> = {
  auto: "project.grading.source.auto",
  llm: "project.grading.source.llm",
  manual: "project.grading.source.manual",
};
const SOURCE_HELP: Record<Source, keyof Dict> = {
  auto: "project.grading.source.help.auto",
  llm: "project.grading.source.help.llm",
  manual: "project.grading.source.help.manual",
};
const REASON_KEY: Record<CriterionReason, keyof Dict> = {
  no_commit: "project.grading.reason.no_commit",
  archive_too_large: "project.grading.reason.archive_too_large",
  repo_missing: "project.grading.reason.repo_missing",
  github_unavailable: "project.grading.reason.github_unavailable",
  runner_unavailable: "project.grading.reason.runner_unavailable",
  refused: "project.grading.reason.refused",
  timed_out: "project.grading.reason.timed_out",
  llm_budget: "project.grading.reason.llm_budget",
  llm_not_configured: "project.grading.reason.llm_not_configured",
  grader_error: "project.grading.reason.grader_error",
};

/** What a teacher writes for one criterion: its points, and a rationale when they edit it. */
export type GradeWrite = (criterionId: string, body: CriterionGradeWrite) => void;

/**
 * One repository's criteria (ADR-106 §8), five columns: the criterion (its
 * description, its id, its section, a bonus or a penalty, the rationale
 * folded under it), the maximum, the points awarded — an inline number
 * input bounded to the criterion's range, written when the teacher leaves
 * it —, the source as an icon (CI, AI, teacher) and the state, with the
 * reason of a failed or missing pass. A rationale is plain text: rendered
 * as a text node, never as markup (N-SEC-14). Under a 28 rem container the
 * rows turn into cards (`T.stack`): the criterion and its input on the
 * first line, the rest under them.
 */
export function CriteriaTable({
  rows,
  label,
  writable,
  onGrade,
}: {
  rows: CriteriaTableRow[];
  label: string;
  /** Frozen for good: the points can be written (the server refuses them before). */
  writable: boolean;
  onGrade: GradeWrite;
}) {
  const t = useT();
  const columns: Column<string>[] = [
    { key: "criterion", label: t("project.grading.col.criterion"), stack: "main" },
    { key: "max", label: t("project.grading.col.max"), right: true, className: "@md:w-px whitespace-nowrap", stack: "sub" },
    { key: "awarded", label: t("project.grading.col.awarded"), right: true, className: "@md:w-px whitespace-nowrap", stack: "end" },
    { key: "source", label: t("project.grading.col.source"), className: "@md:w-px whitespace-nowrap", stack: "sub" },
    { key: "state", label: t("project.grading.col.state"), className: "@md:w-px whitespace-nowrap", stack: "sub" },
  ];
  return (
    <div className={`${T.container} overflow-x-auto`}>
      <table className={cx(T.table, T.stack.table)} aria-label={label}>
        <TableHead columns={columns} />
        <tbody role="rowgroup">
          {rows.map((row) => (
            <CriterionRow key={row.criterionId} row={row} writable={writable} onGrade={onGrade} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CriterionRow({ row, writable, onGrade }: { row: CriteriaTableRow; writable: boolean; onGrade: GradeWrite }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const foldId = useId();
  return (
    <tr role="row" className={cx(T.row, T.stack.row, "align-top")}>
      <td role="cell" className={cx(T.td, T.stack.main, "@max-md:whitespace-normal")}>
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold text-fg">{row.description}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-faint">
            <span className="font-mono">{row.criterionId}</span>
            {row.bonus !== undefined ? <Badge tone="green">{t("project.grading.bonus", { n: row.bonus })}</Badge> : null}
            {row.max < 0 ? <Badge tone="amber">{t("project.grading.penalty")}</Badge> : null}
            {row.rationale !== undefined || (writable && row.points !== null) ? (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={foldId}
                onClick={() => setOpen((o) => !o)}
                className="inline-flex items-center gap-0.5 rounded-sm font-medium text-fg-muted transition-colors hover:text-fg"
              >
                <ChevronRight aria-hidden className={cx("size-3.5 transition-transform", open && "rotate-90")} />
                {t("project.grading.rationale")}
              </button>
            ) : null}
          </span>
          {open ? (
            <Rationale id={foldId} row={row} writable={writable && row.points !== null} onGrade={onGrade} />
          ) : null}
        </span>
      </td>
      <td role="cell" className={cx(T.td, T.stack.sub, "text-right tabular-nums text-fg-muted")}>
        {/* On a card the number stands alone: it says what it counts. */}
        <span className="hidden @max-md:inline">{t("project.grading.col.max")} </span>
        {row.bonus !== undefined ? `+${row.bonus}` : row.max}
      </td>
      <td role="cell" className={cx(T.td, T.stack.end, "text-right")}>
        <AwardedInput key={`${row.criterionId}:${row.points}`} row={row} writable={writable} onGrade={onGrade} />
      </td>
      <td role="cell" className={cx(T.td, T.stack.sub)}>
        <SourceTag source={row.source} />
      </td>
      <td role="cell" className={cx(T.td, T.stack.sub)}>
        <span className="flex flex-wrap items-center gap-1">
          <StateBadge row={row} />
          {row.reason !== undefined ? (
            <Badge tone="zinc" icon={AlertTriangle}>
              {t(REASON_KEY[row.reason])}
            </Badge>
          ) : null}
        </span>
      </td>
    </tr>
  );
}

/**
 * The points awarded, written when the teacher leaves the field (Enter
 * leaves it): a value outside the criterion's range is said on the field
 * and never sent; an empty field sends nothing — a criterion is never
 * cleared to "no points" by a teacher, 0 is a value.
 */
function AwardedInput({ row, writable, onGrade }: { row: CriteriaTableRow; writable: boolean; onGrade: GradeWrite }) {
  const t = useT();
  const errorId = useId();
  const [min, max] = awardedRange({ maxPoints: row.max, ...(row.bonus === undefined ? {} : { bonusPoints: row.bonus }) });
  const [invalid, setInvalid] = useState(false);
  const draft = useNumberDraft(row.points, (n) => {
    if (n === null) return;
    const outside = n < min || n > max;
    setInvalid(outside);
    if (!outside) onGrade(row.criterionId, { points: n });
  });
  if (!writable) return <span className="tabular-nums">{row.points ?? "—"}</span>;
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <TextInput
        {...draft}
        size="sm"
        type="number"
        inputMode="decimal"
        step={0.5}
        min={min}
        max={max}
        placeholder="—"
        aria-label={t("project.grading.awarded.label", { criterion: row.description, min, max })}
        className={cx("w-20 text-right tabular-nums", invalid && "border-danger")}
        {...fieldErrorProps(errorId, invalid)}
      />
      <FieldError id={errorId} className="whitespace-nowrap text-xs">
        {invalid ? t("project.grading.range", { min, max }) : null}
      </FieldError>
    </span>
  );
}

function SourceTag({ source }: { source: CriteriaTableRow["source"] }) {
  const t = useT();
  if (!source) return <span className="text-fg-faint">—</span>;
  const Icon = SOURCE_ICON[source];
  return (
    <Tip label={t(SOURCE_HELP[source])}>
      <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <Icon aria-hidden className="size-3.5" />
        {t(SOURCE_KEY[source])}
      </span>
    </Tip>
  );
}

/** The row's state, a milestone's lock (ADR-106 §5) inside the badge, after its word. */
function StateBadge({ row }: { row: CriteriaTableRow }) {
  const t = useT();
  const lock = row.locked ? (
    <Tip label={t("project.grading.locked")}>
      <Lock aria-label={t("project.grading.locked")} role="img" className="size-3" />
    </Tip>
  ) : null;
  if (row.state === "validated") {
    return (
      <Badge tone="green" icon={Check}>
        {t("project.grading.state.validated")}
        {lock}
      </Badge>
    );
  }
  if (row.state === "proposed") {
    return (
      <Badge tone="amber">
        {t("project.grading.state.proposed")}
        {lock}
      </Badge>
    );
  }
  return <Badge tone="zinc">{t("project.grading.state.empty")}</Badge>;
}

/**
 * The rationale, folded under its criterion: the text as it is (a text
 * node, line breaks kept), and, for a criterion with points, an edit that
 * writes it with the same points (a teacher's row).
 */
function Rationale({
  id,
  row,
  writable,
  onGrade,
}: {
  id: string;
  row: CriteriaTableRow;
  writable: boolean;
  onGrade: GradeWrite;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(row.rationale ?? "");
  if (editing) {
    return (
      <span id={id} className="mt-1 flex max-w-[70ch] flex-col items-start gap-2">
        <Textarea
          aria-label={t("project.grading.rationale")}
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          className="min-h-20 text-[13px]"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            onGrade(row.criterionId, { points: row.points!, rationale: text });
            setEditing(false);
          }}
        >
          {t("project.grading.rationale.save")}
        </Button>
      </span>
    );
  }
  return (
    <span id={id} className="mt-1 flex max-w-[70ch] flex-col items-start gap-1">
      <span className="whitespace-pre-wrap text-[13px] text-fg-muted">
        {row.rationale ?? t("project.grading.rationale.none")}
      </span>
      {writable ? (
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          {t("project.grading.rationale.edit")}
        </Button>
      ) : null}
    </span>
  );
}
