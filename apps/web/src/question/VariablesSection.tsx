import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronUp, Dices, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { marked } from "marked";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { MAX_VARIABLES, type DraftInstance, type DraftInstances, type ParametersDraft, type ZodIssueLite } from "@quiz/contracts";
import {
  identifiersIn,
  namesMentioned,
  parseFormat,
  referencedNames,
  writeFormat,
  type FormatKind,
} from "@quiz/domain";

import { api, apiErrorMessage } from "../api";
import { HelpIcon } from "../help";
import { useT, type TFunction } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { questionInstancesKey, solutionKey } from "../queryKeys";
import { Alert, Button, Card, cx, ErrorText, Field, IconButton, Select, Skeleton, T, TableHead, TextInput } from "../ui";
import { issueMessage } from "./issues";
import { PlayedQuestion } from "./PreviewedQuestion";

type Row = ParametersDraft["rows"][number];

/** A format as a teacher reads it: "2 decimals", "3 significant figures"; an unknown one as written. */
export function formatLabel(t: TFunction, format: string): string {
  const parsed = parseFormat(format);
  if (parsed === null) return format;
  const { kind, n } = parsed;
  if (kind === "auto") return t("param.format.auto");
  if (kind === "int") return t("param.format.int");
  if (kind === "decimals") return n === 1 ? t("param.format.decimal") : t("param.format.decimals", { n });
  return n === 1 ? t("param.format.figure") : t("param.format.figures", { n });
}

/** The count a kind starts with when it is picked: what a measure is most often written with. */
const DEFAULT_COUNT: Record<"decimals" | "figures", number> = { decimals: 2, figures: 3 };
const COUNTS = [1, 2, 3, 4, 5, 6] as const;

/**
 * The rows once the texts' `[[name]]` are reconciled with them (ADR-056,
 * addendum of 2026-10-01): a name referenced and not declared gets a row,
 * empty, and joins `auto`; a row of `auto` that is still empty and no longer
 * referenced goes. A row with an expression stays, referenced or not — it
 * gets the "not used" warning instead. The same `rows` when nothing changes.
 */
export function reconcileRows(
  rows: readonly Row[],
  referenced: readonly string[],
  auto: ReadonlySet<string>,
): { rows: readonly Row[]; auto: ReadonlySet<string> } {
  const wanted = new Set(referenced);
  const stale = (row: Row) => auto.has(row.name) && row.expr.trim() === "" && !wanted.has(row.name);
  const kept = rows.filter((row) => !stale(row));
  const declared = new Set(kept.map((row) => row.name));
  const room = Math.max(0, MAX_VARIABLES - kept.length);
  const added = referenced.filter((name) => !declared.has(name)).slice(0, room);
  if (kept.length === rows.length && added.length === 0) return { rows, auto };
  const removed = new Set(rows.filter(stale).map((row) => row.name));
  return {
    rows: [...kept, ...added.map((name) => ({ name, expr: "", format: "" }))],
    auto: new Set([...[...auto].filter((name) => !removed.has(name)), ...added]),
  };
}

/**
 * A markdown text with its code — inline spans, fenced and indented blocks —
 * blanked, read by marked's own lexer: a `[[…]]` in code declares no row.
 */
function outsideCode(text: string): string {
  let out = "";
  let cursor = 0;
  marked.walkTokens(marked.lexer(text), (token) => {
    if (token.type !== "code" && token.type !== "codespan") return;
    const at = text.indexOf(token.raw, cursor);
    if (at === -1) return;
    out += `${text.slice(cursor, at)} `;
    cursor = at + token.raw.length;
  });
  return out + text.slice(cursor);
}

/**
 * How long the texts must rest before their references are reconciled: a
 * `[[h]]` typed then grown to `[[height]]` (an editor that closes brackets
 * by itself) never flashes a row `h` in and out.
 */
const RECONCILE_MS = 400;

/**
 * Keeps the rows in step with the texts' `[[name]]` ({@link reconcileRows}),
 * once the texts rest. The texts as the editor opened them are not acted
 * upon: opening a question never edits it, typing in it does. Which rows it
 * created lives here, in memory: after a reload, every row is the teacher's.
 */
function useAutoRows({
  content,
  variables,
  onChange,
  disabled,
}: {
  content: unknown;
  variables: ParametersDraft | null;
  onChange: (next: ParametersDraft | null) => void;
  disabled: boolean;
}) {
  const auto = useRef<ReadonlySet<string>>(new Set());
  const seen = useRef(false);
  const latest = useRef({ variables, onChange });
  latest.current = { variables, onChange };
  useEffect(() => {
    if (!seen.current) {
      seen.current = true;
      return;
    }
    if (disabled) return;
    const timer = setTimeout(() => {
      const current = latest.current.variables;
      const before = current?.rows ?? [];
      const next = reconcileRows(before, referencedNames(content, outsideCode), auto.current);
      auto.current = next.auto;
      if (next.rows !== before) {
        latest.current.onChange(next.rows.length === 0 ? null : { ...current, rows: [...next.rows] });
      }
    }, RECONCILE_MS);
    return () => clearTimeout(timer);
  }, [content, disabled]);
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
  config,
  explanation,
  variables,
  onChange,
  issues,
  disabled,
  savedStamp,
  dirty,
}: {
  questionId: string;
  type: string;
  /** The draft's configuration and explanation: their `[[name]]` declare rows. */
  config: unknown;
  explanation: string;
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

  const content = useMemo(() => [config, explanation], [config, explanation]);
  useAutoRows({ content, variables, onChange, disabled });

  const mentioned = useMemo(() => {
    const names = namesMentioned(content);
    for (const name of identifiersIn(variables?.condition ?? "")) names.add(name);
    return names;
  }, [content, variables?.condition]);
  const used = (row: Row) =>
    mentioned.has(row.name) || rows.some((other) => other !== row && identifiersIn(other.expr).has(row.name));

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
          <div className="hidden grid-cols-[7rem_minmax(0,1fr)_15rem_2rem] gap-2 text-xs font-medium text-fg-muted sm:grid">
            <span>{t("param.name")}</span>
            <span>{t("param.expr")}</span>
            <span>{t("param.format")}</span>
          </div>
          <ol className="space-y-4 sm:space-y-2">
            {rows.map((row, index) => {
              const said = say(rowIssues(row.name));
              const unused = row.name !== "" && !used(row);
              return (
                <li key={index} className="space-y-1">
                  <div className="grid grid-cols-[minmax(0,1fr)_2rem] gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_15rem_2rem]">
                    <TextInput
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={t("param.nameOf", { n: index + 1 })}
                      aria-invalid={said.length > 0 || undefined}
                      className="w-full font-mono text-[13px]"
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
                    <TextInput
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={t("param.exprOf", { n: index + 1 })}
                      aria-invalid={said.length > 0 || undefined}
                      className="col-span-2 w-full font-mono text-[13px] sm:col-span-1"
                      value={row.expr}
                      disabled={disabled}
                      onChange={(e) => patchRow(index, { expr: e.target.value })}
                    />
                    <span className="col-span-2 sm:col-span-1">
                      <FormatPicker
                        index={index}
                        format={row.format}
                        disabled={disabled}
                        onChange={(format) => patchRow(index, { format })}
                      />
                    </span>
                  </div>
                  <Issues messages={said} />
                  {unused ? (
                    <p className="flex items-start gap-1.5 text-xs text-warning">
                      <AlertTriangle className="mt-[0.2em] size-[1.1em] shrink-0" aria-hidden />
                      <span className="min-w-0">{t("param.unused", { name: row.name })}</span>
                    </p>
                  ) : null}
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
 * A format as a kind and, for decimals and significant figures, their count
 * (1–6). The stored strings are those of `FORMATS`; one this editor does
 * not write (an import's typo) stays shown, as itself, until it is changed.
 */
function FormatPicker({
  index,
  format,
  disabled,
  onChange,
}: {
  index: number;
  format: string;
  disabled: boolean;
  onChange: (format: string) => void;
}) {
  const t = useT();
  const parsed = parseFormat(format);
  const counted = parsed?.kind === "decimals" || parsed?.kind === "figures" ? parsed : null;
  const kinds: [FormatKind, string][] = [
    ["auto", t("param.format.auto")],
    ["int", t("param.format.int")],
    ["decimals", t("param.format.kind.decimals")],
    ["figures", t("param.format.kind.figures")],
  ];
  return (
    <span className="flex gap-2">
      <Select
        aria-label={t("param.formatOf", { n: index + 1 })}
        width="min-w-0 flex-1"
        value={parsed?.kind ?? format}
        disabled={disabled}
        onChange={(e) => {
          const kind = e.target.value as FormatKind;
          const n = counted?.n ?? (kind === "decimals" || kind === "figures" ? DEFAULT_COUNT[kind] : 0);
          onChange(writeFormat(kind, n));
        }}
      >
        {parsed === null ? <option value={format}>{format}</option> : null}
        {kinds.map(([kind, label]) => (
          <option key={kind} value={kind}>
            {label}
          </option>
        ))}
      </Select>
      {counted ? (
        <Select
          aria-label={t("param.format.countOf", { n: index + 1 })}
          width="w-16 shrink-0"
          value={String(counted.n)}
          disabled={disabled}
          onChange={(e) => onChange(writeFormat(counted.kind, Number(e.target.value)))}
        >
          {COUNTS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      ) : null}
    </span>
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
            <TableHead
              columns={[
                { key: "draw", label: t("param.draws.draw") },
                // A variable's name is the teacher's: prefixed, so it never meets a fixed key.
                ...own.map((name) => ({ key: `var:${name}`, label: name, right: true, className: "font-mono" })),
                ...(rest ? [{ key: "others", label: t("param.draws.others") }] : []),
                { key: "actions", label: t("common.actions"), srOnly: true },
              ]}
            />
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
                queryKey: solutionKey([...questionInstancesKey(questionId, savedStamp ?? ""), current.seed]),
                // The draw's explanation is always shown under it, key or not.
                queryFn: () => Promise.resolve({ solution: current.solution, explanation: null }),
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
