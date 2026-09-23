import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  ClipboardCheck,
  ClipboardList,
  Copy,
  MonitorPlay,
  Plus,
  Presentation,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import type { EvaluationMode, EvaluationSummary } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { gradingLinks } from "../grading";
import { useT } from "../i18n";
import type { Route } from "../router";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Menu,
  Modal,
  pressable,
  QueryError,
  Segmented,
  Skeleton,
  T,
} from "../ui";
import {
  evaluationStateLabel,
  hasDashboard,
  isGraded,
  isLive,
  stateTone,
} from "./common";
import { evaluationsKey } from "../queryKeys";

/**
 * The evaluations of one classroom, under its roster.
 *
 * It is a list and not a grid of cards: what a teacher looks for here is one
 * line — which quiz, in which state, how many students have taken it — and a
 * table reads those four facts in one scan. The single action of the section
 * is "New evaluation"; everything else is per row, in the overflow menu.
 */

function NewEvaluationModal({
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
  const [mode, setMode] = useState<Exclude<EvaluationMode, "poll">>("exam");
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
  return (
    <Modal
      title={t("eval.new")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={title.trim() === ""}
          >
            {t("eval.create")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label={t("eval.titleLabel")}
          placeholder={t("eval.titlePlaceholder")}
          required
          fullWidth
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="space-y-1.5">
          <span className="text-[13px] font-medium">{t("eval.mode")}</span>
          <div>
            <Segmented
              name="eval-mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: "exam", label: t("eval.mode.exam") },
                { value: "exercise", label: t("eval.mode.exercise") },
              ]}
            />
          </div>
          <p className="text-[13px] text-fg-muted">{t(`eval.mode.desc.${mode}`)}</p>
        </div>
        {create.isError ? (
          <Alert tone="danger" title={t("eval.createFailed")}>
            {apiErrorMessage(create.error, t("error.server"))}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}

export function EvaluationList({
  classroomId,
  navigate,
}: {
  classroomId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);

  const list = useQuery<EvaluationSummary[]>({
    queryKey: evaluationsKey(classroomId),
    queryFn: () => api(`/app/api/classrooms/${classroomId}/evaluations`),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: evaluationsKey(classroomId) });
  const duplicate = useMutation({
    mutationFn: (row: EvaluationSummary) =>
      api(`/app/api/evaluations/${row.id}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ title: t("eval.duplicateTitle", { title: row.title }) }),
      }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (row: EvaluationSummary) =>
      api(`/app/api/evaluations/${row.id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmTitle: row.title }),
      }),
    onSuccess: invalidate,
  });

  /**
   * Where a row leads: the dashboard while the class is in it, the grading
   * panel once it is closed — that is the work waiting — the results once
   * they are published, and the configuration screen before any of that.
   */
  const open = (row: EvaluationSummary) => {
    // A poll has no configuration screen and no grid: it IS its projection,
    // whether it is still running or already over (F-LIVE-13).
    if (row.mode === "poll") return navigate({ view: "poll", id: row.id });
    if (isLive(row.state)) return navigate({ view: "live", id: row.id });
    if (!isGraded(row.state)) return navigate({ view: "evaluation", id: row.id });
    const links = gradingLinks(row.id);
    return navigate(row.state === "released" ? links.results : links.grading);
  };

  /**
   * Secondary in the section header and primary only inside the empty state:
   * the classroom page's one primary action is "Add students" — a roster is
   * what unblocks everything else — and a second accent button beside it
   * would make the squint test ambiguous.
   */
  const newButton = (variant: "primary" | "secondary") => (
    <Button variant={variant} onClick={() => setCreating(true)}>
      <Plus /> {t("eval.new")}
    </Button>
  );

  return (
    <section className="space-y-3">
      {/* No heading: the tab above already names it. "New evaluation" is the
          one thing this tab is for, so it stands alone, hard right. */}
      {list.data && list.data.length > 0 ? (
        <div className="flex justify-end">{newButton("primary")}</div>
      ) : null}
      {list.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : list.isError || !list.data ? (
        <QueryError
          title={t("eval.notFound")}
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
          fallback={t("error.server")}
        />
      ) : list.data.length === 0 ? (
        <Card>
          <EmptyState icon={ClipboardList} title={t("eval.empty.title")} action={newButton("primary")}>
            {t("eval.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        /* The three counts leave in turn as the card narrows (`T` › column
           priority): the attempts first, then the points, then the number of
           questions. The title with its state badge, the mode and the row
           menu are what the list is for, and they stay. */
        <Card className={`${T.container} overflow-hidden`}>
          <table className={T.table}>
            <thead className={T.head}>
              <tr>
                <th className={T.th}>{t("eval.titleLabel")}</th>
                <th className={T.th}>{t("eval.mode")}</th>
                <th className={`${T.th} ${T.colHigh} text-right`}>{t("eval.step.questions")}</th>
                <th className={`${T.th} ${T.colMid} text-right`}>{t("eval.col.points")}</th>
                <th className={`${T.th} ${T.colLow} text-right`}>{t("eval.col.attempts")}</th>
                <th className={`${T.th} w-10`}>
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((row) => (
                <tr
                  key={row.id}
                  className={`${T.row} ${T.rowHover} cursor-pointer`}
                  onClick={() => open(row)}
                  {...pressable(() => open(row), "row")}
                >
                  <td className={T.td}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{row.title}</span>
                      <Badge tone={stateTone(row.state)}>{evaluationStateLabel(row.state, t)}</Badge>
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
                        ...(row.mode === "poll"
                          ? [
                              {
                                label: t("poll.openProjection"),
                                icon: Presentation,
                                onSelect: () => navigate({ view: "poll", id: row.id }),
                              },
                            ]
                          : []),
                        // WP10: once a quiz is closed, the two screens the
                        // teacher actually wants are the correction and the
                        // table — first in the menu, above the dashboard the
                        // row no longer opens by itself.
                        ...(isGraded(row.state) && row.mode !== "poll"
                          ? [
                              {
                                label: t("eval.grading"),
                                icon: ClipboardCheck,
                                onSelect: () => navigate(gradingLinks(row.id).grading),
                              },
                              {
                                label: t("eval.results"),
                                icon: BarChart3,
                                onSelect: () => navigate(gradingLinks(row.id).results),
                              },
                            ]
                          : []),
                        ...(hasDashboard(row) && row.mode !== "poll"
                          ? [
                              {
                                label: t("eval.dashboard"),
                                icon: MonitorPlay,
                                onSelect: () => navigate({ view: "live", id: row.id }),
                              },
                            ]
                          : []),
                        ...(row.mode === "poll"
                          ? []
                          : [
                              {
                                label: t("eval.configure"),
                                icon: ClipboardList,
                                onSelect: () => navigate({ view: "evaluation", id: row.id }),
                              },
                            ]),
                        {
                          label: t("eval.duplicate"),
                          icon: Copy,
                          onSelect: () => duplicate.mutate(row),
                        },
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
                                cancelLabel: t("common.cancel"),
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
          </table>
        </Card>
      )}
      {creating ? (
        <NewEvaluationModal
          classroomId={classroomId}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate({ view: "evaluation", id });
          }}
        />
      ) : null}
    </section>
  );
}
