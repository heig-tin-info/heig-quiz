import { BarChart3, CheckCheck, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useT } from "../i18n";
import type { Route } from "../router";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  PageError,
  PageHeader,
  QueryError,
  Skeleton,
} from "../ui";
import { AnswerPanel } from "./AnswerPanel";
import { gradingColumns, sortColumns } from "./columns";
import { whoOf } from "./labels";
import { GradingTable } from "./GradingTable";
import { GradingToolbar, PrimaryButton } from "./GradingToolbar";
import { QuestionBar } from "./QuestionBar";
import { RegradeSheet } from "./RegradeSheet";
import {
  ANY,
  byName,
  canBatch,
  entryKey,
  EXPECTED,
  filterRows,
  moveSelection,
  needsPass,
  nextSort,
  panelTarget,
  primaryAction,
  rowAction,
  shuffled,
  sortRows,
  type Sort,
} from "./rows";
import { useGradingActions, type BatchScope } from "./useGradingActions";
import { useGradingData } from "./useGradingData";
import { useGradingKeys } from "./useGradingKeys";
import { useGradingView } from "./view";

/**
 * The grading screen (F-GRADE-03 to 06, ADR-044): ONE QUESTION AT A TIME,
 * as a table of every student's answer to it — grading the same question
 * across thirty students is the only way to grade it consistently.
 *
 * On top, which question and where each stands (`QuestionBar`); under it
 * the filters, the names switch and the screen's one accent action
 * (`GradingToolbar`); then the table (`GradingTable`), the key pinned as its
 * first row, and the answer panel (`AnswerPanel`) a row opens.
 *
 * Anonymised by default at every visit, never remembered: the server sends
 * no name at all, and the rows stand in an order drawn once per visit, so
 * neither a label nor a position gives a student away. The names are a
 * request (`?anonymous=0`), never a client-side unmasking.
 */
export function GradingPanel({
  evaluationId,
  navigate,
}: {
  evaluationId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const [view, setView] = useGradingView();
  const [index, setIndex] = useState(0);
  const [anonymise, setAnonymise] = useState(true);
  /** The visit's shuffle: drawn once, so no row moves until the page is left. */
  const [seed] = useState(() => Math.floor(Math.random() * 0x100000000));
  const [sort, setSort] = useState<Sort | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** The panel is keyed on an entry (or on the key), never on a row index. */
  const [panel, setPanel] = useState<{ key: string; adjust: boolean } | null>(null);
  const [regrading, setRegrading] = useState(false);
  /** Where the selection last stood in the table, for a row that just left it. */
  const lastIndex = useRef(-1);

  const data = useGradingData(evaluationId, index, !anonymise);
  const { items, item, entries } = data;
  const actions = useGradingActions({
    evaluationId,
    navigate,
    onRegrade: item ? () => setRegrading(true) : undefined,
  });

  const first = entries[0];
  const columns = useMemo(
    () => (item && first ? gradingColumns(t, item.type, first.student, first.solution) : []),
    [t, item, first],
  );
  const base = useMemo(
    () => (anonymise ? shuffled(entries, seed) : byName(entries)),
    [entries, anonymise, seed],
  );
  const visible = useMemo(
    () =>
      filterRows(base, {
        state: view.stateFilter,
        source: view.source,
        confidence: view.confidence,
      }),
    [base, view],
  );
  const sortable = useMemo(
    () => sortColumns(t, columns, !anonymise, (e) => whoOf(t, e)),
    [t, columns, anonymise],
  );
  const rows = useMemo(() => {
    const byKey = new Map(sortable.map((c) => [c.key, c]));
    return sortRows(visible, sort, (e, key) => byKey.get(key)?.sortValue(e) ?? "");
  }, [visible, sort, sortable]);

  useEffect(() => {
    const at = rows.findIndex((e) => entryKey(e) === selected);
    if (at >= 0) lastIndex.current = at;
    else if (selected === EXPECTED || selected === null) lastIndex.current = -1;
  }, [rows, selected]);

  const goTo = useCallback(
    (i: number) => {
      if (i < 0 || i >= items.length) return;
      setIndex(i);
      setSort(null);
      setSelected(null);
      setPanel(null);
    },
    [items.length],
  );
  // A placeholder to grade by hand (an essay) opens on the grading form:
  // reading it and giving it points is the only thing to do with it.
  const toGrade = (key: string) => {
    const entry = entries.find((e) => entryKey(e) === key);
    return entry !== undefined && rowAction(entry) === "grade";
  };
  const open = (key: string, adjust = false) => {
    setSelected(key);
    setPanel({ key, adjust: key !== EXPECTED && (adjust || toGrade(key)) });
  };
  const move = (delta: number) => {
    const next = moveSelection(rows, selected, lastIndex.current, delta);
    setSelected(next);
    if (panel) setPanel({ key: next, adjust: toGrade(next) });
  };
  const selectedEntry = entries.find((e) => entryKey(e) === selected) ?? null;
  // V takes what the batch would take, one row at a time: never a placeholder.
  const validateOne = (entry: (typeof entries)[number]) => {
    if (entry.grading && canBatch(entry)) actions.validate.mutate(entry.grading.id);
  };

  useGradingKeys({
    panelOpen: panel !== null,
    onQuestion: (delta) => goTo(index + delta),
    onRow: move,
    onOpen: () => {
      if (selected) open(selected);
    },
    onValidate: () => {
      if (selectedEntry) validateOne(selectedEntry);
    },
    onAdjust: () => {
      if (selectedEntry) open(entryKey(selectedEntry), true);
    },
  });

  if (data.evaluation.isLoading) return <GradingSkeleton />;
  if (data.evaluation.isError) {
    return (
      <PageError
        title={t("grading.loadFailed")}
        error={data.evaluation.error}
        onRetry={() => void data.evaluation.refetch()}
        retrying={data.evaluation.isFetching}
        fallback={t("error.server")}
      />
    );
  }

  const header = (
    <PageHeader
      eyebrow={data.evaluation.data?.evaluation.title ?? ""}
      title={t("grading.title")}
      help="grading"
      description={t("grading.subtitle")}
      actions={
        <Button variant="secondary" onClick={actions.openResults}>
          <BarChart3 /> {t("grading.openResults")}
        </Button>
      }
    />
  );
  if (!item || data.evaluation.data?.attemptCount === 0) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <EmptyState icon={CheckCheck} title={t("grading.empty.noAttempt.title")}>
            {t("grading.empty.noAttempt.body")}
          </EmptyState>
        </Card>
      </div>
    );
  }

  const scope: BatchScope = {
    itemId: item.id,
    ...(view.source === ANY ? {} : { source: view.source }),
    ...(view.source === "llm" && view.confidence !== ANY ? { confidence: view.confidence } : {}),
  };
  const target = panelTarget(panel, entries);
  const onEdit = () => navigate({ view: "question", id: item.questionId, from: evaluationId });
  // What the automatic pass still owes THIS question: the banner and its
  // run are the question's, never the whole evaluation's (the palette's).
  const waiting = entries.filter(needsPass).length;
  const state = data.states.get(item.id);

  return (
    <div className="space-y-5">
      {header}
      <QuestionBar items={items} index={index} states={data.states} onJump={goTo} />
      <GradingToolbar
        view={view}
        onView={setView}
        toValidate={state ? state.total - state.validated : null}
        anonymise={anonymise}
        onAnonymise={(on) => {
          setAnonymise(on);
          if (on && sort?.key === "name") setSort(null);
        }}
        primary={
          <PrimaryButton
            action={primaryAction(entries, rows, index === items.length - 1)}
            busy={actions.batch.isPending}
            onValidate={(n) => void actions.validateBatch(scope, n)}
            onNext={() => goTo(index + 1)}
            onResults={actions.openResults}
          />
        }
      />
      {waiting > 0 ? (
        <Alert
          icon={Play}
          title={t(waiting === 1 ? "grading.pass.waiting.one" : "grading.pass.waiting", {
            n: waiting,
          })}
          action={
            <Button
              size="sm"
              variant="secondary"
              loading={actions.run.isPending}
              onClick={() => actions.run.mutate([item.id])}
            >
              <Play /> {t("grading.run")}
            </Button>
          }
        />
      ) : null}
      <Card className="overflow-hidden">
        {data.queue.isError ? (
          <div className="p-4">
            <QueryError
              title={t("grading.loadFailed")}
              error={data.queue.error}
              onRetry={() => void data.queue.refetch()}
              retrying={data.queue.isFetching}
              fallback={t("error.server")}
            />
          </div>
        ) : data.queue.isLoading ? (
          <TableSkeleton />
        ) : (
          <GradingTable
            label={t("grading.table.label", { n: index + 1 })}
            columns={columns}
            sortable={sortable}
            rows={rows}
            maxPoints={item.points}
            named={!anonymise}
            sort={sort}
            onSort={(key) => setSort((s) => nextSort(s, key))}
            selected={selected}
            onOpen={open}
            onValidate={validateOne}
            validating={actions.validate.isPending}
            onRegrade={() => setRegrading(true)}
            onEdit={onEdit}
            empty={
              view.stateFilter === "todo" && view.source === ANY
                ? t("grading.empty.body")
                : t("grading.empty.filtered")
            }
          />
        )}
      </Card>

      {target ? (
        <AnswerPanel
          evaluationId={evaluationId}
          target={target}
          item={item}
          number={index + 1}
          named={!anonymise}
          columns={columns}
          student={first?.student ?? null}
          explanation={data.explanation}
          onClose={() => setPanel(null)}
          onMove={move}
          onAdjust={(on) => setPanel((p) => (p ? { ...p, adjust: on } : p))}
          onValidate={validateOne}
          validating={actions.validate.isPending}
          // A sheet never opens another sheet: the panel steps aside.
          onRegrade={() => {
            setPanel(null);
            setRegrading(true);
          }}
          onEdit={onEdit}
        />
      ) : null}
      {regrading ? (
        <RegradeSheet evaluationId={evaluationId} item={item} onClose={() => setRegrading(false)} />
      ) : null}
    </div>
  );
}

/** The shape of what is coming: the header, the question bar and a few rows. */
function GradingSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-24 w-full" />
      <TableSkeleton />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}
