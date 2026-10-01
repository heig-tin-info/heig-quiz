import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronUp, Dices, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { DraftInstance, DraftInstances, ParametersDraft, ZodIssueLite } from "@quiz/contracts";
import { FORMATS, isFormat } from "@quiz/domain";

import { api, apiErrorMessage } from "../api";
import { HelpIcon } from "../help";
import { useT, type TFunction } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { questionInstancesKey } from "../queryKeys";
import { Alert, Button, Card, cx, ErrorText, Field, IconButton, inputClass, inputSize, Select, Skeleton, T } from "../ui";
import { issueMessage } from "./issues";
import { PlayedQuestion } from "./PreviewedQuestion";

type Row = ParametersDraft["rows"][number];

/** A format as a teacher reads it: "2 decimals", "3 significant figures". */
function formatLabel(t: TFunction, format: string): string {
  if (format === "") return t("param.format.auto");
  if (format === "int") return t("param.format.int");
  if (format.startsWith(".")) {
    const n = Number(format.slice(1));
    return n === 1 ? t("param.format.decimal") : t("param.format.decimals", { n });
  }
  const n = Number(format.slice(0, -1));
  return n === 1 ? t("param.format.figure") : t("param.format.figures", { n });
}

/**
 * At most this many variables get a column of their own in the draws; the
 * rest share one. DESIGN.md › Tables: "At most seven visible columns" — the
 * draw's number, four values, the others and the eye make seven.
 */
const VALUE_COLUMNS = 4;

/** The issues of one place, each said once, in the editor's issue line. */
function Issues({ messages }: { messages: readonly string[] }) {
  return messages.map((message) => (
    <ErrorText key={message} small>
      {message}
    </ErrorText>
  ));
}

/**
 * Whether an issue belongs to the Variables section rather than to the
 * type's form: a row or the condition (`["variables", name]`), or a
 * parameter issue of the whole table (`too_slow`, `choices_not_distinct`).
 */
export function isVariablesIssue(issue: ZodIssueLite): boolean {
  return issue.path[0] === "variables" || (issue.path.length === 0 && issue.message.startsWith("parameters."));
}

/**
 * "Random values" (ADR-056 §8): the variables table of a parameterized
 * question, shared by the editors of `mcq`, `short` and `cloze` — the host
 * mounts it under the type's own form, never inside it.
 *
 * Progressive disclosure (docs/spec/08 §8.1): a question without variables
 * shows one quiet button, so a simple question stays simple; a question
 * that declares some opens on its table. Adding the first row makes the
 * question parameterized, removing the last makes it static again (`null`),
 * both through the draft's autosave like every other edit. No primary
 * action here: "Publish" stays the screen's one.
 *
 * Under the table, the five draws publication checks, computed by the API
 * from the stored draft: the browser evaluates nothing.
 */
export function VariablesSection({
  questionId,
  type,
  variables,
  onChange,
  issues,
  disabled,
  savedStamp,
  dirty,
}: {
  questionId: string;
  type: string;
  variables: ParametersDraft | null;
  onChange: (next: ParametersDraft | null) => void;
  /** The draft's issues that {@link isVariablesIssue} keeps. */
  issues: readonly ZodIssueLite[];
  disabled: boolean;
  /** The stored draft's stamp: the draws are drawn again from each save. */
  savedStamp: string | null;
  /** Something is typed and not yet stored: the draws shown are the last save's. */
  dirty: boolean;
}) {
  const t = useT();
  const rows = variables?.rows ?? [];
  const [opened, setOpened] = useState(false);
  const expanded = opened || rows.length > 0;

  if (!expanded) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button variant="secondary" size="sm" aria-expanded={false} onClick={() => setOpened(true)}>
          <Dices /> {t("param.title")} <ChevronDown />
        </Button>
        <span className="text-[13px] text-fg-muted">{t("param.closedHint")}</span>
      </div>
    );
  }

  const setRows = (next: Row[]) =>
    onChange(next.length === 0 ? null : { ...(variables ?? {}), rows: next });
  const patchRow = (index: number, patch: Partial<Row>) =>
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const setCondition = (condition: string) => {
    if (variables === null) return;
    const { condition: _old, ...rest } = variables;
    onChange(condition === "" ? rest : { ...rest, condition });
  };
  const rowIssues = (name: string) => issues.filter((i) => i.path[0] === "variables" && String(i.path[1]) === name);
  const tableIssues = issues.filter((i) => i.path[0] !== "variables" || i.path.length === 1);
  const say = (list: readonly ZodIssueLite[]) => [...new Set(list.map((i) => issueMessage(t, i)))];

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Dices className="size-4 shrink-0 text-fg-faint" aria-hidden />
        <h2 className="text-base font-bold tracking-tight">{t("param.title")}</h2>
        <HelpIcon topic="variables" />
        {rows.length === 0 ? (
          <Button variant="ghost" size="sm" className="ml-auto" aria-expanded onClick={() => setOpened(false)}>
            <ChevronUp /> {t("param.hide")}
          </Button>
        ) : null}
      </div>
      <p className="text-[13px] text-fg-muted">{t("param.help")}</p>

      {rows.length > 0 ? (
        <div className="space-y-2">
          <div className="hidden grid-cols-[7rem_minmax(0,1fr)_12rem_2rem] gap-2 text-xs font-medium text-fg-muted sm:grid">
            <span>{t("param.name")}</span>
            <span>{t("param.expr")}</span>
            <span>{t("param.format")}</span>
          </div>
          <ol className="space-y-4 sm:space-y-2">
            {rows.map((row, index) => {
              const said = say(rowIssues(row.name));
              return (
                <li key={index} className="space-y-1">
                  <div className="grid grid-cols-[minmax(0,1fr)_2rem] gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_12rem_2rem]">
                    <input
                      type="text"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={t("param.nameOf", { n: index + 1 })}
                      aria-invalid={said.length > 0 || undefined}
                      placeholder="h"
                      className={cx(inputClass, inputSize.md, "w-full font-mono text-[13px]")}
                      value={row.name}
                      disabled={disabled}
                      onChange={(e) => patchRow(index, { name: e.target.value.trim() })}
                    />
                    <span className="flex justify-end sm:order-last">
                      <IconButton
                        label={t("param.remove", { name: row.name || String(index + 1) })}
                        danger
                        disabled={disabled}
                        onClick={() => setRows(rows.filter((_, i) => i !== index))}
                      >
                        <Trash2 />
                      </IconButton>
                    </span>
                    <input
                      type="text"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={t("param.exprOf", { n: index + 1 })}
                      aria-invalid={said.length > 0 || undefined}
                      placeholder="randint(10, 100)"
                      className={cx(inputClass, inputSize.md, "col-span-2 w-full font-mono text-[13px] sm:col-span-1")}
                      value={row.expr}
                      disabled={disabled}
                      onChange={(e) => patchRow(index, { expr: e.target.value })}
                    />
                    <span className="col-span-2 sm:col-span-1">
                      <Select
                        aria-label={t("param.formatOf", { n: index + 1 })}
                        value={row.format}
                        disabled={disabled}
                        onChange={(e) => patchRow(index, { format: e.target.value })}
                      >
                        {(isFormat(row.format) ? FORMATS : [row.format, ...FORMATS]).map((format) => (
                          <option key={format} value={format}>
                            {isFormat(format) ? formatLabel(t, format) : format}
                          </option>
                        ))}
                      </Select>
                    </span>
                  </div>
                  <Issues messages={said} />
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => setRows([...rows, { name: "", expr: "", format: "" }])}
      >
        <Plus /> {t("param.add")}
      </Button>

      {rows.length > 0 ? (
        <div className="space-y-1">
          <Field
            label={t("param.condition")}
            hint={t("param.condition.hint")}
            fullWidth
            spellCheck={false}
            autoComplete="off"
            placeholder="t > 1"
            className="font-mono text-[13px]"
            value={variables?.condition ?? ""}
            disabled={disabled}
            onChange={(e) => setCondition(e.target.value)}
          />
          <Issues messages={say(rowIssues("condition"))} />
        </div>
      ) : null}

      <Issues messages={say(tableIssues)} />

      {rows.length > 0 ? (
        <Draws questionId={questionId} type={type} savedStamp={savedStamp} stale={dirty} />
      ) : null}
    </Card>
  );
}

/**
 * The five draws of the stored draft (`POST /questions/:id/draft/instances`):
 * a compact table of their values, and one draw at a time played as a
 * student reads it, with its key on "Show answers". Drawn again from each
 * save; while a newer edit is unsaved, the last draws stay, dimmed.
 */
function Draws({
  questionId,
  type,
  savedStamp,
  stale,
}: {
  questionId: string;
  type: string;
  savedStamp: string | null;
  stale: boolean;
}) {
  const t = useT();
  const [shown, setShown] = useState<number | null>(null);
  const query = useQuery({
    queryKey: questionInstancesKey(questionId, savedStamp ?? ""),
    queryFn: () => api<DraftInstances>(`/app/api/questions/${questionId}/draft/instances`, { method: "POST" }),
    enabled: savedStamp !== null,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });

  const instances = query.data?.instances ?? [];
  const blocked = (query.data?.issues.length ?? 0) > 0 || instances.length === 0;
  const current = instances.find((i) => i.seed === shown) ?? null;

  let body: ReactNode;
  if (query.isLoading || (savedStamp === null && !query.data)) {
    body = <Skeleton className="h-24 w-full" />;
  } else if (query.isError || !query.data) {
    body = (
      <Alert tone="warning" icon={AlertTriangle} title={t("param.draws.failed")}>
        {apiErrorMessage(query.error, t("error.server"))}
        <Button variant="secondary" size="sm" className="mt-2" onClick={() => void query.refetch()}>
          {t("common.retry")}
        </Button>
      </Alert>
    );
  } else if (blocked) {
    body = <p className="text-[13px] text-fg-muted">{t("param.draws.blocked")}</p>;
  } else {
    const names = instances[0]!.values.map((v) => v.name);
    const own = names.slice(0, VALUE_COLUMNS);
    const rest = names.length > VALUE_COLUMNS;
    body = (
      <div className={cx("space-y-3 transition-opacity", (stale || query.isFetching) && "opacity-60")}>
        <div className={cx(T.container, "overflow-x-auto")}>
          <table className={T.table}>
            <thead className={T.head}>
              <tr>
                <th className={T.th}>{t("param.draws.draw")}</th>
                {own.map((name) => (
                  <th key={name} className={cx(T.th, "text-right font-mono")}>
                    {name}
                  </th>
                ))}
                {rest ? <th className={T.th}>{t("param.draws.others")}</th> : null}
                <th className={T.th}>
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {instances.map((instance, index) => (
                <DrawRow
                  key={instance.seed}
                  instance={instance}
                  n={index + 1}
                  own={own}
                  rest={rest}
                  active={shown === instance.seed}
                  onToggle={() => setShown(shown === instance.seed ? null : instance.seed)}
                />
              ))}
            </tbody>
          </table>
        </div>
        {current ? (
          <div className="space-y-3">
            <PlayedQuestion
              key={`${savedStamp}-${current.seed}`}
              view={{ type, student: current.student, points: current.itemPoints }}
              label={t("param.draws.drawN", { n: instances.indexOf(current) + 1 })}
              showsAnswers
              solution={{
                queryKey: [...questionInstancesKey(questionId, savedStamp ?? ""), current.seed, "solution"],
                queryFn: () => Promise.resolve({ solution: current.solution }),
              }}
            />
            {current.explanation.trim() !== "" ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-fg-muted">{t("question.explanation")}</p>
                <MarkdownView source={current.explanation} size="sm" />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-line pt-4">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-fg">{t("param.draws.title")}</h3>
        <p className="text-xs text-fg-muted">{t("param.draws.desc")}</p>
      </div>
      {body}
    </div>
  );
}

function DrawRow({
  instance,
  n,
  own,
  rest,
  active,
  onToggle,
}: {
  instance: DraftInstance;
  n: number;
  own: string[];
  rest: boolean;
  active: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const value = (name: string) => instance.values.find((v) => v.name === name)?.value ?? "—";
  return (
    <tr className={cx(T.row, T.rowHover, "cursor-pointer", active && "bg-accent-soft")} onClick={onToggle}>
      <td className={cx(T.td, "font-bold tabular-nums")}>{n}</td>
      {own.map((name) => (
        <td key={name} className={cx(T.td, "text-right font-mono tabular-nums")}>
          {value(name)}
        </td>
      ))}
      {rest ? (
        <td className={cx(T.td, "font-mono text-fg-muted")}>
          {instance.values
            .slice(VALUE_COLUMNS)
            .map((v) => `${v.name} = ${v.value}`)
            .join(", ")}
        </td>
      ) : null}
      <td className={cx(T.td, "w-0 text-right")} onClick={(e) => e.stopPropagation()}>
        <IconButton
          size="sm"
          active={active}
          aria-pressed={active}
          label={active ? t("param.draws.hide", { n }) : t("param.draws.show", { n })}
          onClick={onToggle}
        >
          {active ? <EyeOff /> : <Eye />}
        </IconButton>
      </td>
    </tr>
  );
}
