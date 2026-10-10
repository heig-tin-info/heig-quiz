import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Copy, FileStack, FolderGit2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { EvaluationMode, EvaluationState, type EvaluationSummary } from "@quiz/contracts";
import { templatePullable } from "@quiz/domain";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT, type Dict, type TFunction } from "../i18n";
import type { Route } from "../router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FormDialog,
  FormError,
  Menu,
  pressable,
  QueryError,
  SectionHeading,
  GroupBySwitch,
  Select,
  Skeleton,
  T,
  TableBand,
  TableHead,
  usePersistentChoice,
  useSortableTable,
  type Column,
} from "../ui";
import { evaluationHome, evaluationLinkItems, evaluationStateLabel, stateTone } from "./common";
import { evaluationsKey } from "../queryKeys";
import { ModeChoice, type CreatedMode } from "./ModeChoice";
import {
  InstantiateError,
  SaveAsTemplateDialog,
  useCourseTemplates,
  useDuplicateErrorToast,
  useInstantiate,
} from "./templates";
import { PullTemplateDialog, TemplateBehindBadge } from "./templatePull";
import { useClassroom } from "../course/parts";
import { useEvaluations } from "./api";

/**
 * The evaluations of one classroom, under its roster.
 *
 * It is a list and not a grid of cards: what a teacher looks for here is one
 * line — which quiz, in which state, how many students have taken it — and a
 * table reads those four facts in one scan. The single action of the tab is
 * "New evaluation", which the classroom's page header carries (it owns the
 * dialog below); everything else is per row, in the overflow menu.
 */

export function NewEvaluationModal({
  classroomId,
  onClose,
  onCreated,
}: {
  classroomId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<CreatedMode>("exam");
  /*
   * "Start from a template" (ADR-031) exists only when the course has one:
   * the classroom names its course, the course lists its templates, and a
   * course with none leaves this dialog exactly as it was (08, novice path).
   */
  const classroom = useClassroom(classroomId);
  const templates = useCourseTemplates(classroom.data?.course.id ?? null).data ?? [];
  const [templateId, setTemplateId] = useState("");
  const template = templates.find((x) => x.id === templateId) ?? null;

  const create = useMutation({
    mutationFn: () =>
      api<EvaluationSummary>(`/app/api/classrooms/${classroomId}/evaluations`, {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), mode, preset: mode }),
      }),
    onSuccess: async (row) => {
      await qc.invalidateQueries({ queryKey: evaluationsKey(classroomId) });
      onCreated(row.id);
    },
  });
  const instantiate = useInstantiate(onCreated);
  return (
    <FormDialog
      title={t("eval.new")}
      onClose={onClose}
      onSubmit={() =>
        template ? instantiate.mutate({ template, classroomId, title }) : create.mutate()
      }
      submitLabel={t("eval.create")}
      submitting={create.isPending || instantiate.isPending}
      canSubmit={title.trim() !== ""}
      error={
        template ? (
          <InstantiateError error={instantiate.error} />
        ) : (
          <FormError error={create.error} title={t("eval.createFailed")} />
        )
      }
    >
      {templates.length > 0 ? (
        <Select
          label={t("templates.startFrom")}
          value={templateId}
          onChange={(e) => {
            const next = templates.find((x) => x.id === e.target.value);
            setTemplateId(e.target.value);
            // The template's title is the obvious name; one typed already stays.
            if (next && title.trim() === "") setTitle(next.title);
          }}
        >
          <option value="">{t("templates.blank")}</option>
          {templates.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </Select>
      ) : null}
      <Field
        label={t("eval.titleLabel")}
        placeholder={t("eval.titlePlaceholder")}
        required
        fullWidth
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      {template ? (
        <p className="text-[13px] text-fg-muted">{t("templates.useHelp", { mode: t(`eval.mode.${template.mode}`) })}</p>
      ) : (
        <ModeChoice value={mode} onChange={setMode} />
      )}
    </FormDialog>
  );
}

type EvaluationSort = "title" | "mode" | "questions" | "points" | "attempts";

/** What each column of the list is ordered on; the mode by its own word. */
function evaluationRank(
  row: EvaluationSummary,
  key: EvaluationSort,
  t: TFunction,
): string | number {
  switch (key) {
    case "mode":
      return t(`eval.mode.${row.mode}`);
    case "questions":
      return row.itemCount;
    case "points":
      return row.totalPoints;
    case "attempts":
      return row.attemptCount;
    default:
      return row.title;
  }
}

/**
 * "Group by" on the list (the pool's control, `FilterBar`): none, the state
 * badge, or the mode. Remembered per browser, as the pool's is — a teacher
 * who reads their evaluations by state reads them so every time.
 */
type EvaluationGroupBy = "none" | "status" | "mode";
const GROUP_BY: readonly EvaluationGroupBy[] = ["none", "status", "mode"];
const GROUP_KEY = "quiz-evaluations-group";
const GROUP_LABEL: Record<EvaluationGroupBy, keyof Dict> = {
  none: "common.group.none",
  status: "eval.group.status",
  mode: "eval.mode",
};

interface EvaluationGroup {
  key: string;
  /** The band's words, or `null` for the single group of `none`. */
  label: string | null;
  rows: readonly EvaluationSummary[];
}

/**
 * Each grouping as data: its keys in the order the groups are drawn (the
 * enum's — a state in lifecycle order, draft to released), the key of a
 * row, and the band's words.
 */
const GROUPINGS: Record<
  Exclude<EvaluationGroupBy, "none">,
  {
    keys: readonly string[];
    of: (row: EvaluationSummary) => string;
    label: (key: string, t: TFunction) => string;
  }
> = {
  status: {
    keys: EvaluationState.options,
    of: (row) => row.state,
    label: (key, t) => evaluationStateLabel(key as EvaluationState, t),
  },
  mode: {
    keys: EvaluationMode.options,
    of: (row) => row.mode,
    label: (key, t) => t(`eval.mode.${key as EvaluationMode}`),
  },
};

/**
 * The rows cut into groups, each keeping the order it was handed (the
 * server's, or the column the teacher sorted on); only the groups that hold
 * a row are drawn.
 */
function groupEvaluations(
  rows: readonly EvaluationSummary[],
  by: EvaluationGroupBy,
  t: TFunction,
): EvaluationGroup[] {
  if (by === "none") return [{ key: "all", label: null, rows }];
  const { keys, of, label } = GROUPINGS[by];
  return keys
    .map((key) => ({ key, label: label(key, t), rows: rows.filter((row) => of(row) === key) }))
    .filter((group) => group.rows.length > 0);
}

export function EvaluationList({
  classroomId,
  navigate,
  onNew,
  newProject,
}: {
  classroomId: string;
  navigate: (r: Route) => void;
  /** Opens the page's "New evaluation" dialog, from the empty state. */
  onNew: () => void;
  /**
   * The header menu's "Project" (`newProjectAction`), offered beside "New
   * evaluation" in the empty state; absent where a project has no door.
   */
  newProject?: { description?: string; onSelect: () => void } | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  /** The row whose template pull is being confirmed (F-EVAL-26). */
  const [pulling, setPulling] = useState<string | null>(null);
  /** The row being saved as a template of the course (ADR-031). */
  const [savingTemplate, setSavingTemplate] = useState<EvaluationSummary | null>(null);
  const classroom = useClassroom(classroomId);

  const list = useEvaluations(classroomId);

  /* No initial sort: the server hands the evaluations over in the order this
     classroom works through them — the drafts being written, then what is
     scheduled, then what is over — and that order is the answer to "what is
     next" nobody clicked for. A click on a label replaces it. */
  const { sorted, sort, toggle } = useSortableTable<EvaluationSummary, EvaluationSort>(
    list.data ?? [],
    (row, key) => evaluationRank(row, key, t),
    null,
  );
  const [groupBy, setGroupBy] = usePersistentChoice(GROUP_KEY, GROUP_BY, "none");
  const groups = groupEvaluations(sorted, groupBy, t);
  const columns: Column<EvaluationSort>[] = [
    { key: "title", label: t("eval.titleLabel") },
    { key: "mode", label: t("eval.mode") },
    { key: "questions", label: t("eval.step.questions"), right: true, className: T.colHigh },
    { key: "points", label: t("eval.col.points"), right: true, className: T.colMid },
    { key: "attempts", label: t("eval.col.attempts"), right: true, className: T.colLow },
    { key: "actions", label: t("common.actions"), sortable: false, srOnly: true, className: "w-10" },
  ];

  const invalidate = () => qc.invalidateQueries({ queryKey: evaluationsKey(classroomId) });
  const duplicateFailed = useDuplicateErrorToast();
  const duplicate = useMutation({
    mutationFn: (row: EvaluationSummary) =>
      api(`/app/api/evaluations/${row.id}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ title: t("eval.duplicateTitle", { title: row.title }) }),
      }),
    onSuccess: invalidate,
    onError: duplicateFailed,
  });
  const remove = useMutation({
    mutationFn: (row: EvaluationSummary) =>
      api(`/app/api/evaluations/${row.id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmTitle: row.title }),
      }),
    onSuccess: invalidate,
  });

  /** Where a row leads (`evaluationHome`, shared with the Activities section). */
  const open = (row: EvaluationSummary) => navigate(evaluationHome(row));

  return (
    <section aria-labelledby="classroom-evaluations" className="space-y-3">
      {/* No button: "New evaluation" sits in the page header, where "Add
          students" stands on the roster tab — one primary per tab, always in
          the same place. The heading is the sibling of the projects' one
          (`ProjectGroup`, M3-10): the tab is "Activities", each list names
          itself and carries its own count. An empty list shows its empty
          state instead, and a list that is loading or failed no number. */}
      {list.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : list.isError || !list.data ? (
        <QueryError title={t("eval.notFound")} query={list} />
      ) : list.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={ClipboardList}
            title={t("eval.empty.title")}
            action={
              /* The header's "New ▾" folded open: an empty tab has room to
                 show both doors, the evaluation still the primary. */
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={onNew}>
                  <Plus /> {t("eval.new")}
                </Button>
                {newProject ? (
                  <Button variant="secondary" title={newProject.description} onClick={newProject.onSelect}>
                    <FolderGit2 /> {t("project.new")}
                  </Button>
                ) : null}
              </div>
            }
          >
            {t("eval.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <>
          <SectionHeading
            icon={ClipboardList}
            title={<span id="classroom-evaluations">{t("eval.title")}</span>}
            count={list.data.length}
          />
          {/* The pool's control (`GroupBySwitch`). One row has nothing to group. */}
          {list.data.length < 2 ? null : (
            <GroupBySwitch
              name="evaluations-group"
              value={groupBy}
              onChange={setGroupBy}
              options={GROUP_BY.map((g) => ({ value: g, label: t(GROUP_LABEL[g]) }))}
            />
          )}
          {/* The three counts leave in turn as the card narrows (`T` › column
              priority): the attempts first, then the points, then the number
              of questions. The title with its state badge, the mode and the
              row menu are what the list is for, and they stay. A grouping
              cuts the rows into bands and keeps the sort inside each. */}
          <Card className={`${T.container} overflow-hidden`}>
            <table className={T.table}>
              <TableHead columns={columns} sort={sort} onToggle={toggle} />
              {groups.map((group) => (
                <tbody key={group.key}>
                  {group.label === null ? null : (
                    <TableBand span={columns.length} label={group.label} count={group.rows.length} />
                  )}
                  {group.rows.map((row) => (
                    <tr
                      key={row.id}
                      className={`${T.row} ${T.rowHover} cursor-pointer`}
                      {...pressable(() => open(row), "row")}
                    >
                      <td className={T.td}>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{row.title}</span>
                          <Badge tone={stateTone(row.state)}>{evaluationStateLabel(row.state, t)}</Badge>
                          {/* Its template moved (F-EVAL-26): shown only where the
                              pull would be accepted, as the pull's own door. */}
                          {templatePullable(row) ? (
                            <TemplateBehindBadge
                              from={row.originRevision!}
                              to={row.templateRevision!}
                              title={row.title}
                              onOpen={() => setPulling(row.id)}
                            />
                          ) : null}
                        </span>
                      </td>
                      <td className={`${T.td} text-fg-muted`}>
                        {/* A poll is the one mode that changes where the whole row
                            leads, so it is a badge and the other two stay words:
                            the badge is what a teacher scans a list of thirty
                            evaluations for. Zinc, never the accent — "New
                            evaluation" owns the red on this screen. */}
                        {row.mode === "poll" ? (
                          <Badge tone="zinc">{t("eval.mode.poll")}</Badge>
                        ) : (
                          t(`eval.mode.${row.mode}`)
                        )}
                      </td>
                      <td className={`${T.td} ${T.colHigh} text-right tabular-nums`}>{row.itemCount}</td>
                      <td className={`${T.td} ${T.colMid} text-right tabular-nums`}>{row.totalPoints}</td>
                      <td className={`${T.td} ${T.colLow} text-right tabular-nums`}>
                        {row.attemptCount === 0 ? "—" : row.attemptCount}
                      </td>
                      <td className={`${T.td} text-right`} onClick={(e) => e.stopPropagation()}>
                        <Menu
                          label={t("live.row.actions", { name: row.title })}
                          items={[
                            ...evaluationLinkItems(row, t, navigate),
                            {
                              label: t("eval.duplicate"),
                              icon: Copy,
                              onSelect: () => duplicate.mutate(row),
                            },
                            // A poll has nothing to keep (`422 template_poll`).
                            ...(row.mode === "poll" || !classroom.data
                              ? []
                              : [
                                  {
                                    label: t("templates.save"),
                                    icon: FileStack,
                                    onSelect: () => setSavingTemplate(row),
                                  },
                                ]),
                            {
                              label: t("eval.delete"),
                              icon: Trash2,
                              danger: true,
                              separator: true,
                              onSelect: async () => {
                                if (
                                  await confirm({
                                    title: t("eval.deleteConfirm", { name: row.title }),
                                    confirmLabel: t("common.delete"),
                                    danger: true,
                                  })
                                ) {
                                  remove.mutate(row);
                                }
                              },
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </Card>
        </>
      )}
      {savingTemplate && classroom.data ? (
        <SaveAsTemplateDialog
          evaluationId={savingTemplate.id}
          classroomId={classroomId}
          title={savingTemplate.title}
          course={classroom.data.course}
          onClose={() => setSavingTemplate(null)}
        />
      ) : null}
      {pulling ? (
        <PullTemplateDialog
          evaluationId={pulling}
          classroomId={classroomId}
          onClose={() => setPulling(null)}
        />
      ) : null}
    </section>
  );
}
