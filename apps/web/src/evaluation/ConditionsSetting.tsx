import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ConditionKind, conditionsOf, type CourseCondition, type EvaluationCondition } from "@quiz/contracts";
import { imposedConditions, MAX_CONDITION_LENGTH, MAX_CONDITIONS } from "@quiz/domain";

import { useCourseConditions } from "../course/parts";
import { useT, type TFunction } from "../i18n";
import { ConditionLine, imposedText } from "../student/ConditionsList";
import {
  Actions,
  Badge,
  Button,
  Card,
  Checkbox,
  cx,
  inputClass,
  inputSize,
  type MenuItem,
  Select,
  SettingRow,
} from "../ui";
import type { ConfigPatch, ConfigView } from "./editTarget";

/**
 * ADR-079 (F-EVAL-33): the conditions a teacher announces — allowed,
 * forbidden, provided, or good to know — and, under them, what the platform
 * will add from the settings, so the teacher sees the whole of what students
 * read without announcing the same thing twice.
 *
 * The course's catalog (F-ORG-16) comes first, as checkboxes: ticking an
 * entry appends its kind and text with its `catalogId`, a SNAPSHOT that later
 * edits of the entry never change; unticking removes the entry carrying that
 * id. A condition whose `catalogId` is not in the active catalog (archived
 * since, or the evaluation was copied to another course) is simply a one-off
 * condition: its id is kept as it is, nothing ticks it. One-off conditions
 * are written under the list. The list travels whole
 * (`EvaluationSettingsPatch.conditions`): every change sends it all, in
 * order. Frozen with the rest of the settings (`configLock`), and never shown
 * for a poll, which the server refuses it on. A template is edited by the
 * same component, with its own course.
 *
 * Its primary stays the step's: "Add" is a secondary, a row's moves and
 * removal sit in its `Actions` menu.
 */
export function ConditionsSetting({
  config,
  courseId,
  closesAt = null,
  patch,
  disabled,
}: {
  config: ConfigView;
  /** The course whose catalog is offered: the evaluation's, or the template's. */
  courseId: string;
  /** The run's common end, for the deadline line; a template has none. */
  closesAt?: string | null;
  patch: ConfigPatch;
  disabled: boolean;
}) {
  const t = useT();
  const list = conditionsOf(config.settings);
  const catalog = useCourseConditions(courseId);
  const offered = (catalog.data ?? []).filter((entry) => entry.archivedAt === null);
  const inCatalog = new Set(offered.map((entry) => entry.id));
  const save = (conditions: EvaluationCondition[]) => patch.mutate({ settings: { conditions } });
  const replace = (i: number, next: EvaluationCondition) => save(list.map((c, j) => (j === i ? next : c)));
  const move = (i: number, delta: -1 | 1) => {
    const next = [...list];
    [next[i], next[i + delta]] = [next[i + delta]!, next[i]!];
    save(next);
  };
  const tick = (entry: CourseCondition, on: boolean) =>
    save(
      on
        ? [...list, { kind: entry.kind, text: entry.text, catalogId: entry.id }]
        : list.filter((c) => c.catalogId !== entry.id),
    );
  const imposed = imposedConditions({ ...config, closesAt, timeBonusPercent: 0 });

  return (
    <Card className="divide-y divide-line px-4">
      <SettingRow title={t("eval.conditions")} desc={t("eval.conditions.desc")} />
      <CatalogPicker
        entries={catalog.data ? offered : undefined}
        failed={catalog.isError}
        picked={new Set(list.flatMap((c) => (c.catalogId ? [c.catalogId] : [])))}
        full={list.length >= MAX_CONDITIONS}
        disabled={disabled}
        onTick={tick}
      />
      {list.length > 0 ? (
        <ol className="divide-y divide-line">
          {list.map((condition, i) => (
            <ConditionRow
              // Keyed on the content: a write from elsewhere replaces what the field shows.
              key={`${i}:${condition.kind}:${condition.text}`}
              index={i}
              condition={condition}
              disabled={disabled}
              onChange={(next) => replace(i, next)}
              badge={
                condition.catalogId && inCatalog.has(condition.catalogId) ? (
                  <Badge tone="zinc">{t("eval.conditions.fromCatalog")}</Badge>
                ) : null
              }
              actions={[
                ...moveActions(t, i, list.length, move),
                {
                  label: t("eval.conditions.remove"),
                  icon: Trash2,
                  danger: true,
                  onSelect: () => save(list.filter((_, j) => j !== i)),
                },
              ]}
            />
          ))}
        </ol>
      ) : null}
      {list.length < MAX_CONDITIONS ? (
        <AddCondition disabled={disabled} onAdd={(condition) => save([...list, condition])} />
      ) : (
        <p className="py-3 text-[13px] text-fg-muted">{t("eval.conditions.max", { n: MAX_CONDITIONS })}</p>
      )}
      <div className="py-3">
        <p className="text-sm font-medium">{t("eval.conditions.imposed")}</p>
        <p className="mt-0.5 text-[13px] text-fg-muted">{t("eval.conditions.imposed.desc")}</p>
        <ul className="-mx-4 mt-1">
          {imposed.map((line) => (
            <ConditionLine key={line.key} kind={line.kind} title={imposedText(line, t).title} compact />
          ))}
        </ul>
      </div>
    </Card>
  );
}

/**
 * The course's catalog as checkboxes, the box of an entry ticked while the
 * list holds its `catalogId`. Nothing while it loads; one line when it
 * failed or is empty, saying where the catalog is kept. A box that would
 * make a 21st condition is disabled, never refused after the click.
 */
function CatalogPicker({
  entries,
  failed,
  picked,
  full,
  disabled,
  onTick,
}: {
  entries: CourseCondition[] | undefined;
  failed: boolean;
  picked: ReadonlySet<string>;
  full: boolean;
  disabled: boolean;
  onTick: (entry: CourseCondition, on: boolean) => void;
}) {
  const t = useT();
  if (!entries && !failed) return null;
  return (
    <div className="py-3">
      <p className="text-sm font-medium">{t("eval.conditions.catalog")}</p>
      {failed ? (
        <p className="mt-0.5 text-[13px] text-fg-muted">{t("eval.conditions.catalog.failed")}</p>
      ) : entries!.length === 0 ? (
        <p className="mt-0.5 text-[13px] text-fg-muted">{t("eval.conditions.catalog.empty")}</p>
      ) : (
        <>
          <p className="mt-0.5 text-[13px] text-fg-muted">{t("eval.conditions.catalog.desc")}</p>
          <ul className="mt-2 space-y-2">
            {entries!.map((entry) => {
              const on = picked.has(entry.id);
              return (
                <li key={entry.id}>
                  <Checkbox
                    checked={on}
                    disabled={disabled || (full && !on)}
                    onChange={(e) => onTick(entry, e.target.checked)}
                    className="!items-start"
                    label={
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        <span className="text-xs font-medium text-fg-faint">{t(`conditions.kind.${entry.kind}`)}</span>{" "}
                        {entry.text}
                      </span>
                    }
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/** The kind of a condition, as a select: the word a student reads. */
export function KindSelect({
  value,
  disabled,
  onChange,
}: {
  value: ConditionKind;
  disabled: boolean;
  onChange: (kind: ConditionKind) => void;
}) {
  const t = useT();
  return (
    <Select
      value={value}
      size="sm"
      width="w-36 shrink-0"
      disabled={disabled}
      aria-label={t("eval.conditions.kind")}
      onChange={(e) => onChange(e.target.value as ConditionKind)}
    >
      {ConditionKind.options.map((kind) => (
        <option key={kind} value={kind}>
          {t(`conditions.kind.${kind}`)}
        </option>
      ))}
    </Select>
  );
}

/**
 * A row's "Move up" and "Move down", each only where it can go: the menu
 * items of a list of `count` rows at row `i`.
 */
export function moveActions(
  t: TFunction,
  i: number,
  count: number,
  move: (i: number, delta: -1 | 1) => void,
): MenuItem[] {
  return [
    ...(i > 0 ? [{ label: t("eval.conditions.moveUp"), icon: ArrowUp, onSelect: () => move(i, -1) }] : []),
    ...(i < count - 1 ? [{ label: t("eval.conditions.moveDown"), icon: ArrowDown, onSelect: () => move(i, 1) }] : []),
  ];
}

/**
 * The text of a condition: written when the field is left, put back when
 * left blank. The course's Conditions tab draws its entries with it too.
 */
export function ConditionRow({
  index,
  condition,
  disabled,
  onChange,
  actions,
  badge = null,
}: {
  index: number;
  condition: EvaluationCondition;
  disabled: boolean;
  onChange: (next: EvaluationCondition) => void;
  actions: Parameters<typeof Actions>[0]["items"];
  /** Beside the text: where the condition came from ("From the catalog"). */
  badge?: ReactNode;
}) {
  const t = useT();
  const [text, setText] = useState(condition.text);
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === "") setText(condition.text);
    else if (trimmed !== condition.text) onChange({ ...condition, text: trimmed });
  };
  return (
    <li className="flex flex-wrap items-center gap-2 py-2.5">
      <KindSelect value={condition.kind} disabled={disabled} onChange={(kind) => onChange({ ...condition, kind })} />
      <input
        aria-label={`${t("eval.conditions.text")} ${index + 1}`}
        maxLength={MAX_CONDITION_LENGTH}
        disabled={disabled}
        className={cx(inputClass, inputSize.sm, "min-w-0 flex-1 basis-56")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {badge}
      {disabled ? null : (
        <Actions items={actions} menu size="sm" label={t("eval.conditions.actions", { text: condition.text })} />
      )}
    </li>
  );
}

/** A new condition: its kind, its text, and "Add" once there is a text. */
function AddCondition({ disabled, onAdd }: { disabled: boolean; onAdd: (condition: EvaluationCondition) => void }) {
  const t = useT();
  const [kind, setKind] = useState<ConditionKind>("allowed");
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const add = () => {
    if (trimmed === "") return;
    onAdd({ kind, text: trimmed });
    setText("");
  };
  return (
    <form
      className="flex flex-wrap items-center gap-2 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <KindSelect value={kind} disabled={disabled} onChange={setKind} />
      <input
        aria-label={t("eval.conditions.text")}
        placeholder={t("eval.conditions.placeholder")}
        maxLength={MAX_CONDITION_LENGTH}
        disabled={disabled}
        className={cx(inputClass, inputSize.sm, "min-w-0 flex-1 basis-56")}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button type="submit" variant="secondary" size="sm" disabled={disabled || trimmed === ""}>
        <Plus /> {t("eval.conditions.add")}
      </Button>
    </form>
  );
}
