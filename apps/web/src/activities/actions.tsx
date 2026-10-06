import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  ClipboardCheck,
  ClipboardList,
  GitBranch,
  MonitorPlay,
  Presentation,
  Square,
  Users,
} from "lucide-react";

import type { ActivitySummary, EvaluationActivitySummary, PollTeacherView, ProjectActivitySummary } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { hasDashboard, isGraded } from "../evaluation/common";
import { gradingLinks } from "../grading";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { repoHref } from "../project/projectPage";
import { activitiesKey, pollKey } from "../queryKeys";
import type { Route } from "../router";
import { Menu, type MenuItem } from "../ui";
import { typeOf } from "./model";

/**
 * Ending a poll from the Activities section (#190): the projection's own
 * confirmation, word for word, and the same route. Only a poll ends from a
 * list: closing an exam expires every attempt and starts the grading, and
 * that stays on its dashboard, behind its own confirmation.
 */
export function useEndPoll(): { end: (row: ActivitySummary) => void; pending: string | null } {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const failed = useErrorToast();
  const mutation = useMutation({
    mutationFn: (id: string) =>
      api<PollTeacherView>(`/app/api/evaluations/${id}/poll/end`, { method: "POST", body: "{}" }),
    onSuccess: (data, id) => {
      qc.setQueryData(pollKey(id), data);
      void qc.invalidateQueries({ queryKey: activitiesKey });
    },
    onError: failed("activities.endFailed"),
  });
  return {
    end: (row) =>
      void (async () => {
        const ok = await confirm({
          title: t("poll.endConfirm"),
          confirmLabel: t("poll.end"),
          cancelLabel: t("common.cancel"),
          danger: true,
        });
        if (ok) mutation.mutate(row.id);
      })(),
    pending: mutation.isPending ? (mutation.variables ?? null) : null,
  };
}

/** A running poll: the one activity a list may end. */
export const endable = (row: ActivitySummary) => typeOf(row) === "poll" && row.state === "running";

/**
 * The overflow menu of one row, on every view: where else the activity
 * leads (the click on the row goes to its kind's `home`), and End for a
 * running poll. Always a menu, never icon buttons: its length follows the
 * state, and a row that flickers between shapes under the pointer is worse
 * than one more click (`Actions` › `menu`). A project's leads to its
 * repositories on GitHub (M3-14a); its one place is its page (M3-12).
 */
export function ActivityMenu({
  row,
  navigate,
  onEnd,
}: {
  row: ActivitySummary;
  navigate: (r: Route) => void;
  /** Only a poll ends from a list. */
  onEnd?: (row: ActivitySummary) => void;
}) {
  const t = useT();
  const items: MenuItem[] = row.kind === "project" ? projectItems(row, t) : evaluationItems(row, t, navigate, onEnd);
  return (
    // A click in the menu must not also open the row under it.
    <span onClick={(e) => e.stopPropagation()} className="inline-flex">
      <Menu label={t("live.row.actions", { name: row.title })} items={items} />
    </span>
  );
}

const projectItems = (row: ProjectActivitySummary, t: ReturnType<typeof useT>): MenuItem[] => [
  { label: t("project.source"), icon: GitBranch, href: repoHref(row.source.fullName) },
  ...(row.distribution ? [{ label: t("project.distribution"), icon: Users, href: repoHref(row.distribution.fullName) }] : []),
];

function evaluationItems(
  row: EvaluationActivitySummary,
  t: ReturnType<typeof useT>,
  navigate: (r: Route) => void,
  onEnd: ((row: ActivitySummary) => void) | undefined,
): MenuItem[] {
  return row.mode === "poll"
      ? [
          {
            label: t("poll.openProjection"),
            icon: Presentation,
            onSelect: () => navigate({ view: "poll", id: row.id }),
          },
          ...(endable(row)
            ? [{ label: t("poll.end"), icon: Square, danger: true, separator: true, onSelect: () => onEnd?.(row) }]
            : []),
        ]
      : [
          ...(isGraded(row.state)
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
          ...(hasDashboard(row)
            ? [
                {
                  label: t("eval.dashboard"),
                  icon: MonitorPlay,
                  onSelect: () => navigate({ view: "live", id: row.id }),
                },
              ]
            : []),
          {
            label: t("eval.configure"),
            icon: ClipboardList,
            onSelect: () => navigate({ view: "evaluation", id: row.id }),
          },
        ];
}
