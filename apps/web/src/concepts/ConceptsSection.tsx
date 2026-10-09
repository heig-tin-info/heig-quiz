import { useQuery } from "@tanstack/react-query";
import { Ban, Check, ChevronDown, ChevronRight, Hourglass, Link2, Plus, Sparkles, Tags, X } from "lucide-react";
import { useId, useState } from "react";

import type { TagSortingList, TagSortingRow } from "@quiz/contracts";

import { api } from "../api";
import { useI18n, useT, type Locale } from "../i18n";
import { adminConceptSortingKey } from "../queryKeys";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  cx,
  EmptyState,
  ErrorText,
  IconButton,
  QueryError,
  SearchInput,
  SectionHeading,
  Segmented,
  SegmentedBar,
  SelectionBar,
  Skeleton,
  T,
} from "../ui";
import { DropDialog, MapDialog, NewConceptSheet } from "./dialogs";
import { ProposeAction } from "./ProposeAction";
import { choiceText, conceptName, FILTERS, keyOf, storedDecision, useTagSorting, type Decision, type Filter, type Pending } from "./sorting";

type Translate = ReturnType<typeof useT>;

/**
 * The sorting of the existing tags (ADR-081, second addendum): every (pool,
 * tag) pair becomes a concept — an existing one or a new one, created
 * validated — or is dropped with its reason. The admin's "Concepts" tab.
 *
 * Two steps, on purpose: a decision is first set on the selected pairs
 * (pending, in this screen only), then the one primary action, **Accept**,
 * writes the selected pairs that carry one, in one transaction. The model's
 * proposals ("Propose with AI", the header's secondary action) arrive as
 * pending decisions, marked as suggested, that the admin accepts the same
 * way (`decisionOf`).
 *
 * The rows come in `conceptKey` groups, so `pointeurs` in one pool and
 * `pointeur` in another sit together: a group is selected at once from its
 * header, a single pair from its row (a homonym gets one decision per pair).
 */
export function ConceptsSection() {
  const t = useT();
  const { locale } = useI18n();
  const hintId = useId();
  const [dialog, setDialog] = useState<"map" | "new" | "drop" | null>(null);

  const list = useQuery<TagSortingList>({
    queryKey: adminConceptSortingKey,
    queryFn: () => api("/app/api/admin/concept-sorting"),
  });
  const rows = list.data?.rows ?? [];
  const s = useTagSorting(rows);
  const decide = (value: Decision) => {
    s.decide(s.chosen, value);
    setDialog(null);
  };

  return (
    <section className={cx("space-y-4", s.chosen.length > 0 && "pb-24")}>
      <SectionHeading
        icon={Tags}
        title={t("admin.concepts")}
        description={t("admin.concepts.hint")}
        actions={<ProposeAction />}
      />

      {list.isLoading ? (
        <Skeleton className="h-80 w-full" />
      ) : list.isError ? (
        <QueryError title={t("admin.concepts")} query={list} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={Tags} title={t("admin.concepts.empty.title")}>
            {t("admin.concepts.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="flex max-w-md flex-col gap-1.5">
            <p className="text-[13px] tabular-nums text-fg-muted">
              {t("admin.concepts.progress", { done: s.sorted, total: rows.length })}
            </p>
            <SegmentedBar
              total={rows.length}
              parts={[{ tone: "info", value: s.sorted, label: t("admin.concepts.progress.part") }]}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Segmented<Filter>
              name="concept-filter"
              label={t("admin.concepts.filter")}
              size="sm"
              value={s.filter}
              onChange={s.setFilter}
              options={FILTERS.map((f) => ({ value: f, label: t(`admin.concepts.filter.${f}`) }))}
            />
            <SearchInput
              className="w-full sm:w-64"
              aria-label={t("admin.concepts.search")}
              placeholder={t("admin.concepts.search")}
              value={s.search}
              onChange={(e) => s.setSearch(e.target.value)}
            />
          </div>

          {s.groups.length === 0 ? (
            <Card>
              {s.query !== "" ? (
                <EmptyState icon={Tags} title={t("admin.concepts.noMatch")} />
              ) : (
                <EmptyState icon={Check} title={t("admin.concepts.done.title")}>
                  {t("admin.concepts.done.body")}
                </EmptyState>
              )}
            </Card>
          ) : (
            <Card className={cx("overflow-x-auto", T.container)}>
              <table className={T.table}>
                <thead className={T.head}>
                  <tr>
                    <th className={cx(T.th, "w-10")} />
                    <th className={T.th}>{t("admin.concepts.col.tag")}</th>
                    <th className={cx(T.th, T.colHigh)}>{t("admin.concepts.col.pool")}</th>
                    <th className={cx(T.th, T.colHigh, "text-right")}>{t("admin.concepts.col.questions")}</th>
                    <th className={T.th}>{t("admin.concepts.col.decision")}</th>
                  </tr>
                </thead>
                {s.groups.map((g) => {
                  const keys = g.rows.map(keyOf);
                  const ticked = keys.filter((k) => s.selected.has(k)).length;
                  const questions = g.rows.reduce((sum, r) => sum + r.count, 0);
                  return (
                    <tbody key={g.key}>
                      <tr className="border-t border-line bg-surface-2">
                        <td className={cx(T.td, "py-2")}>
                          <Checkbox
                            label={<span className="sr-only">{t("admin.concepts.selectGroup", { group: g.key })}</span>}
                            checked={ticked === keys.length}
                            indeterminate={ticked > 0 && ticked < keys.length}
                            onChange={() => s.select(keys, ticked < keys.length)}
                          />
                        </td>
                        <td colSpan={4} className={cx(T.td, "py-2")}>
                          <span className="font-mono text-xs font-semibold">{g.key}</span>
                          <span className="ml-3 text-xs text-fg-muted">
                            {plural(t, "tags", g.rows.length)} · {plural(t, "questions", questions)}
                          </span>
                        </td>
                      </tr>
                      {g.rows.map((r) => (
                        <PairRows
                          key={keyOf(r)}
                          row={r}
                          locale={locale}
                          checked={s.selected.has(keyOf(r))}
                          onCheck={(on) => s.select([keyOf(r)], on)}
                          pending={s.decisionOf(r)}
                          resolving={s.resolving(r)}
                          onClearPending={() => s.clearPending(r)}
                          error={s.failure?.keys.has(keyOf(r)) ? t(`admin.concepts.error.${s.failure.code}`) : null}
                        />
                      ))}
                    </tbody>
                  );
                })}
              </table>
            </Card>
          )}
        </>
      )}

      {s.chosen.length > 0 && dialog === null ? (
        <SelectionBar
          label={t("admin.concepts.selected", { n: s.chosen.length })}
          onClear={s.clearSelection}
          notices={
            s.conflicts.length > 0 || s.failure ? (
              <>
                {s.conflicts.map((c) => (
                  <Alert
                    key={c.concept.id}
                    tone="warning"
                    title={t("admin.concepts.error.title")}
                    action={
                      <Button size="sm" variant="secondary" onClick={() => s.remap(c)}>
                        <Link2 /> {t("admin.concepts.conflict.map", { concept: conceptName(c.concept, locale) })}
                      </Button>
                    }
                  >
                    {t(c.items.length === 1 ? "admin.concepts.conflict.one" : "admin.concepts.conflict", {
                      concept: conceptName(c.concept, locale),
                      n: c.items.length,
                    })}
                  </Alert>
                ))}
                {s.failure ? (
                  <Alert tone="danger" title={t("admin.concepts.error.title")}>
                    {t(`admin.concepts.error.${s.failure.code}`)}
                  </Alert>
                ) : null}
              </>
            ) : null
          }
          end={
            <>
              {s.ready.length === 0 ? (
                <span id={hintId} className="mr-1 text-xs text-fg-muted">
                  {t("admin.concepts.acceptHint")}
                </span>
              ) : null}
              <Button
                size="sm"
                loading={s.accepting}
                disabled={s.ready.length === 0}
                aria-describedby={s.ready.length === 0 ? hintId : undefined}
                onClick={s.submit}
              >
                {s.accepting ? null : <Check />} {t("admin.concepts.accept", { n: s.ready.length })}
              </Button>
            </>
          }
        >
          <Button size="sm" variant="ghost" onClick={() => setDialog("map")}>
            <Link2 /> {t("admin.concepts.map")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDialog("new")}>
            <Plus /> {t("admin.concepts.new")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDialog("drop")}>
            <Ban /> {t("admin.concepts.drop")}
          </Button>
        </SelectionBar>
      ) : null}

      {dialog === "map" ? (
        <MapDialog
          pairs={s.chosen}
          locale={locale}
          onClose={() => setDialog(null)}
          onPick={(concept) => decide({ choice: { kind: "concept", conceptId: concept.id }, concept })}
        />
      ) : dialog === "new" ? (
        <NewConceptSheet pairs={s.chosen} onClose={() => setDialog(null)} onApply={(choice) => decide({ choice })} />
      ) : dialog === "drop" ? (
        <DropDialog
          count={s.chosen.length}
          onClose={() => setDialog(null)}
          onApply={(reason) => decide({ choice: { kind: "drop", reason } })}
        />
      ) : null}
    </section>
  );
}

/** "1 tag", "3 tags": every key written out, so the dictionary check sees it read. */
function plural(t: Translate, what: "tags" | "questions", n: number) {
  if (what === "tags") return t(n === 1 ? "admin.concepts.groupTags.one" : "admin.concepts.groupTags", { n });
  return t(n === 1 ? "admin.concepts.groupQuestions.one" : "admin.concepts.groupQuestions", { n });
}

/** One pair: its row, and the row of its excerpts while they are open. */
function PairRows({
  row,
  locale,
  checked,
  onCheck,
  pending,
  resolving,
  onClearPending,
  error,
}: {
  row: TagSortingRow;
  locale: Locale;
  checked: boolean;
  onCheck: (on: boolean) => void;
  pending: Pending | null;
  /** The model's proposal names a concept still being looked up. */
  resolving: boolean;
  onClearPending: () => void;
  error: string | null;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const stored = storedDecision(t, locale, row);
  return (
    <>
      <tr className={cx(T.row, T.rowHover)}>
        <td className={cx(T.td, "align-top")}>
          <Checkbox
            label={<span className="sr-only">{t("admin.concepts.select", { tag: row.tag, pool: row.poolName })}</span>}
            checked={checked}
            onChange={(e) => onCheck(e.target.checked)}
          />
        </td>
        <td className={cx(T.td, "min-w-28 max-w-md align-top @2xl:min-w-40")}>
          <div className="font-semibold">{row.tag}</div>
          {/* Under 42 rem the pool and the count leave their columns for this
              line, so the decision keeps the width its badge needs. */}
          <div className="text-xs text-fg-muted @2xl:hidden">
            {row.poolName} · {plural(t, "questions", row.count)}
          </div>
          {row.description ? <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{row.description}</p> : null}
          {row.excerpts.length > 0 ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((e) => !e)}
              className="mt-1 inline-flex items-center gap-1 text-xs text-fg-faint hover:text-fg"
            >
              {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {t("admin.concepts.excerpts", { n: row.excerpts.length })}
            </button>
          ) : null}
        </td>
        <td className={cx(T.td, T.colHigh, "align-top text-fg-muted")}>{row.poolName}</td>
        <td className={cx(T.td, T.colHigh, "align-top text-right tabular-nums")}>{row.count}</td>
        <td className={cx(T.td, "align-top")}>
          <div className="flex flex-wrap items-center gap-1">
            {pending ? (
              <>
                {/* Not told apart by its colour alone: the hourglass (the admin's)
                    or the sparkles (the model's), and the words for a screen reader. */}
                <Badge tone="amber" icon={pending.source === "model" ? Sparkles : Hourglass} className="max-w-36 @2xl:max-w-56">
                  <span className="sr-only">
                    {t(pending.source === "model" ? "admin.concepts.suggestedNamed" : "admin.concepts.pendingNamed", {
                      decision: choiceText(t, locale, pending),
                    })}
                  </span>
                  <span aria-hidden className="truncate">
                    {choiceText(t, locale, pending)}
                  </span>
                </Badge>
                <IconButton label={t("admin.concepts.clearPending", { tag: row.tag })} size="sm" onClick={onClearPending}>
                  <X />
                </IconButton>
              </>
            ) : resolving ? (
              <Skeleton className="h-5.5 w-24" />
            ) : stored ? (
              <Badge tone={stored.drop ? "zinc" : "green"} className="max-w-36 @2xl:max-w-56">
                <span className="truncate">{stored.text}</span>
              </Badge>
            ) : (
              <span className="whitespace-nowrap text-fg-faint">{t("admin.concepts.undecided")}</span>
            )}
          </div>
          {pending?.source === "model" && pending.note ? (
            <p className="mt-1 line-clamp-2 max-w-56 text-xs text-fg-faint">{pending.note}</p>
          ) : null}
          {pending && stored ? (
            <div className="mt-1 text-xs text-fg-faint">{t("admin.concepts.current", { decision: stored.text })}</div>
          ) : null}
          {error ? <ErrorText className="mt-1 text-xs">{error}</ErrorText> : null}
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td />
          <td colSpan={4} className="px-3 pb-3">
            {/* The toggle above names them; each is a recess, no eyebrow of its own. */}
            <ul className="grid gap-2 @2xl:grid-cols-2">
              {row.excerpts.map((e, i) => (
                <li key={i} className="line-clamp-4 whitespace-pre-line rounded-field bg-surface-2 p-3 text-[13px] text-fg-muted">
                  {e}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      ) : null}
    </>
  );
}
