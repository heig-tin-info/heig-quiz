import { BarChart3, CheckCheck, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useT } from "../i18n";
import { useSearchParam, type Route } from "../router";
import { Trail, useEvaluationCrumbs } from "../Trail";
import {
  Alert,
  ASIDE_MIN_WIDTH,
  Button,
  Card,
  cx,
  EmptyState,
  pageBox,
  PageError,
  PageHeader,
  PANE_GAP,
  QueryError,
  Skeleton,
  useMinWidth,
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
 * first row, and the answer panel (`AnswerPanel`) a row opens. From
 * `ASIDE_MIN_WIDTH` that panel docks beside the table, which narrows and
 * stays readable, clickable and walkable (↑ / ↓, ← / →); the page widens by
 * the pane's width (`pageBox`), as the pool's does for its question. Under
 * it, the panel is a sheet over the table. A change of question leaves the
 * pane open, on the new question's key.
 *
 * Anonymised by default at every visit, never remembered: the server sends
 * no name at all, and the rows stand in an order drawn once per visit, so
 * neither a label nor a position gives a student away. The names are a
 * request (`?anonymous=0`), never a client-side unmasking.
 *
 * The question on screen lives in `?item=`, so a reload, and the question
 * editor's way back (ADR-044, addendum), land on the same question.
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
  const [itemParam, setItemParam] = useSearchParam("item", "");
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
  /** The answer pane's width when the window docks it; null, a sheet. */
  const pane = useMinWidth(ASIDE_MIN_WIDTH) ? ANSWER_PANE_WIDTH : null;

  const data = useGradingData(evaluationId, itemParam || null, !anonymise);
  const { items, item, index, entries, parameters } = data;
  const crumbs = useEvaluationCrumbs(
    data.evaluation.data?.evaluation.classroomId,
    evaluationId,
    data.evaluation.data?.evaluation.title,
  );
  const actions = useGradingActions({
    evaluationId,
    navigate,
    onRegrade: item ? () => setRegrading(true) : undefined,
  });

  const first = entries[0];
  // A parameterized question's columns come from the question AS WRITTEN,
  // never from one student's instance: the expected row would otherwise
  // pin that student's numbers as everybody's key (ADR-056 §9).
  const shown = parameters?.template ?? first;
  const columns = useMemo(
    () => (item && shown ? gradingColumns(t, item.type, shown.student, shown.solution) : []),
    [t, item, shown],
  );
  const base = useMemo(
    () => (anonymise ? shuffled(entries, seed) : byName(entries)),
    [entries, anonymise, seed],
  );
  // A parameterized question's answers each have their own key: its rows
  // stand by verdict until the teacher sorts otherwise (ADR-056 §9).
  const shownSort = sort ?? (parameters ? BY_VERDICT : null);
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
    () => sortColumns(t, columns, !anonymise, (e) => whoOf(t, e), parameters !== null),
    [t, columns, anonymise, parameters],
  );
  const rows = useMemo(() => {
    const byKey = new Map(sortable.map((c) => [c.key, c]));
    return sortRows(visible, shownSort, (e, key) => byKey.get(key)?.sortValue(e) ?? "");
  }, [visible, shownSort, sortable]);

  useEffect(() => {
    const at = rows.findIndex((e) => entryKey(e) === selected);
    if (at >= 0) lastIndex.current = at;
    else if (selected === EXPECTED || selected === null) lastIndex.current = -1;
  }, [rows, selected]);

  // An open panel survives the change of question, on the new one's key:
  // only its ✕ (or Escape) closes it. Never on the same student's next
  // answer, which would grade a student rather than a question.
  const panelOpen = panel !== null;
  const goTo = useCallback(
    (i: number) => {
      if (i < 0 || i >= items.length) return;
      setItemParam(items[i]!.id);
      setSort(null);
      setSelected(panelOpen ? EXPECTED : null);
      setPanel(panelOpen ? { key: EXPECTED, adjust: false } : null);
    },
    [items, setItemParam, panelOpen],
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
  // Closed from inside the pane (its ✕), the focus would fall to the page:
  // it goes back to the row the pane showed. A sheet gives it back itself.
  const close = () => {
    setPanel(null);
    if (!pane) return;
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      document
        .querySelector<HTMLElement>(`tr[data-row="${CSS.escape(selected ?? "")}"]`)
        ?.focus({ preventScroll: true });
    });
  };
  const selectedEntry = entries.find((e) => entryKey(e) === selected) ?? null;
  // V takes what the batch would take, one row at a time: never a placeholder.
  const validateOne = (entry: (typeof entries)[number]) => {
    if (entry.grading && canBatch(entry)) actions.validate.mutate(entry.grading.id);
  };

  useGradingKeys({
    panel: panel === null ? "none" : pane ? "pane" : "sheet",
    onClose: close,
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
      <Page>
        <PageError title={t("grading.loadFailed")} query={data.evaluation} />
      </Page>
    );
  }

  const header = (
    <PageHeader
      eyebrow={
        <Trail navigate={navigate} items={[...crumbs, { label: t("grading.title") }]} />
      }
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
      <Page className="space-y-6">
        {header}
        <Card>
          <EmptyState icon={CheckCheck} title={t("grading.empty.noAttempt.title")}>
            {t("grading.empty.noAttempt.body")}
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const scope: BatchScope = {
    itemId: item.id,
    ...(view.source === ANY ? {} : { source: view.source }),
    ...(view.source === "llm" && view.confidence !== ANY ? { confidence: view.confidence } : {}),
  };
  const target = panelTarget(panel, entries);
  // Offered only to whoever may write the question's pool; the editor then
  // leads back HERE, on this question (ADR-044, addendum).
  const onEdit = item.canEdit
    ? () =>
        navigate({ view: "question", id: item.questionId, fromGrading: evaluationId, item: item.id })
    : undefined;
  // What the automatic pass still owes THIS question: the banner and its
  // run are the question's, never the whole evaluation's (the palette's).
  const waiting = entries.filter(needsPass).length;
  const state = data.states.get(item.id);
  const answer = target ? (
    <AnswerPanel
      evaluationId={evaluationId}
      target={target}
      item={item}
      number={index + 1}
      named={!anonymise}
      pane={pane}
      columns={columns}
      student={shown?.student ?? null}
      parameters={parameters}
      explanation={data.explanation}
      onClose={close}
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
  ) : null;

  return (
    <Page pane={answer ? pane : null}>
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
      <div className="flex items-start" style={{ gap: PANE_GAP }}>
        <Card className="min-w-0 flex-1 overflow-hidden">
          {data.queue.isError ? (
            <div className="p-4">
              <QueryError title={t("grading.loadFailed")} query={data.queue} />
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
              parameters={parameters}
              named={!anonymise}
              sort={shownSort}
              onSort={(key) => setSort(nextSort(shownSort, key))}
              selected={selected}
              onOpen={open}
              onValidate={validateOne}
              validating={actions.validate.isPending}
              onRegrade={() => setRegrading(true)}
              newVersion={item.stale}
              onEdit={onEdit}
              empty={
                view.stateFilter === "todo" && view.source === ANY
                  ? t("grading.empty.body")
                  : t("grading.empty.filtered")
              }
            />
          )}
        </Card>
        {pane ? answer : null}
      </div>
      {pane ? null : answer}
      {regrading ? (
        <RegradeSheet
          evaluationId={evaluationId}
          item={item}
          released={data.evaluation.data?.evaluation.releasedAt != null}
          onClose={() => setRegrading(false)}
        />
      ) : null}
    </Page>
  );
}

/** The base order of a parameterized question's rows (ADR-056 §9). */
const BY_VERDICT: Sort = { key: "verdict", dir: 1 };

/** The docked answer pane's width, which the page widens by (`pageBox`). */
const ANSWER_PANE_WIDTH = "36rem";

/** The screen's box, a `WIDE` route's: the reading width, widened by a docked pane. */
function Page({
  pane = null,
  className = "space-y-5",
  children,
}: {
  pane?: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("w-full", className)} style={pageBox(pane)}>
      {children}
    </div>
  );
}

/** The shape of what is coming: the header, the question bar and a few rows. */
function GradingSkeleton() {
  return (
    <Page>
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-24 w-full" />
      <TableSkeleton />
    </Page>
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
