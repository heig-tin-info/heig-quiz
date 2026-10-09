import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderTree, Link2, Unlink } from "lucide-react";
import type { ReactNode } from "react";

import type { CourseSummary } from "@quiz/contracts";
import { poolRoleAllows } from "@quiz/domain";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import type { Route } from "../router";
import { Actions, Button, Card, Menu, QueryError, Skeleton } from "../ui";
import { courseKey } from "../queryKeys";
import { useCourseDetail, useIsCourseOwner } from "./parts";
import { usePools } from "../pool/api";

type LinkedPool = { id: string; name: string; questionCount: number };

/**
 * The pools a course draws from (F-POOL-05), on its card on the Courses
 * home. The card is a summary, so it lists the pools and offers neither link
 * nor unlink: the links are tended on the course page's Linked pools tab
 * (`LinkedPools`, `LinkPoolMenu`).
 */
export function CoursePools({ course, navigate }: { course: CourseSummary; navigate: (r: Route) => void }) {
  const t = useT();
  return (
    // An eyebrow under the classrooms: the card is a summary among others.
    <div className="mt-4">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">{t("pools.link")}</span>
      <PoolList course={course} navigate={navigate} />
    </div>
  );
}

/**
 * The links of one course. `PUT /courses/:id/pools` replaces the WHOLE set in
 * one call, so both the link and the unlink send the list the course should
 * end up with — there is no add/remove route, and inventing one on the client
 * would be a second way to do one thing.
 */
function usePoolLinks(course: CourseSummary) {
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const linked = useCourseDetail(course.id).data?.pools ?? [];
  const setLinks = useMutation({
    mutationFn: (poolIds: string[]) =>
      api(`/app/api/courses/${course.id}/pools`, {
        method: "PUT",
        body: JSON.stringify({ poolIds }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: courseKey(course.id) });
    },
    // The menu is closed by the time the call answers, so the failure has
    // nowhere to render but a toast (DESIGN.md › Menu).
    onError: toastError("pools.linkSaveFailed"),
  });
  return {
    linked,
    link: (poolId: string) => setLinks.mutate([...linked.map((l) => l.id), poolId]),
    unlink: (poolId: string) => setLinks.mutate(linked.filter((l) => l.id !== poolId).map((l) => l.id)),
  };
}

/**
 * "Link a pool", the Linked pools tab's one primary action. One click, no
 * dialog: linking a pool is picking a name out of a short list, and a modal
 * with a select and two buttons was three interactions for one decision.
 */
export function LinkPoolMenu({ course }: { course: CourseSummary }) {
  const t = useT();
  const { linked, link } = usePoolLinks(course);
  const pools = usePools();
  // Linking makes the whole staff contributors of the pool, so the server
  // refuses a pool the caller only reads (ADR-013): it is not offered.
  const available = (pools.data ?? []).filter(
    (p) => poolRoleAllows(p.role, "contributor") && !linked.some((l) => l.id === p.id),
  );
  return (
    <Menu
      label={t("pools.linkAction")}
      trigger={
        <Button>
          <Link2 /> {t("pools.linkAction")}
        </Button>
      }
      items={
        available.length > 0
          ? available.map((pool) => ({
              label: pool.name,
              icon: FolderTree,
              onSelect: () => link(pool.id),
            }))
          : [{ label: t("pools.linkEmpty"), disabled: true }]
      }
    />
  );
}

/** The Linked pools tab of the course page: the pools, each with its unlink for an owner. */
export function LinkedPools({ course, navigate }: { course: CourseSummary; navigate: (r: Route) => void }) {
  const t = useT();
  const confirm = useConfirm();
  const { unlink } = usePoolLinks(course);
  const isOwner = useIsCourseOwner(course.id);

  const confirmUnlink = async (pool: LinkedPool) => {
    const ok = await confirm({
      title: t("pools.unlink"),
      message: t("pools.unlinkConfirm", { name: pool.name, course: course.name }),
      confirmLabel: t("pools.unlink"),
    });
    if (ok) unlink(pool.id);
  };

  return (
    <Card className="p-3">
      <PoolList
        course={course}
        navigate={navigate}
        // Linking and unlinking are an owner's (ADR-068): an assistant reads the list.
        rowAction={!isOwner ? undefined : (pool) => (
          <Actions
            label={t("common.actions")}
            size="sm"
            items={[
              { label: t("pools.unlink"), icon: Unlink, danger: true, onSelect: () => void confirmUnlink(pool) },
            ]}
          />
        )}
      />
    </Card>
  );
}

/** The linked pools, each opening its pool; the row's actions, when given, beside it. */
function PoolList({
  course,
  navigate,
  rowAction,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
  rowAction?: (pool: LinkedPool) => ReactNode;
}) {
  const t = useT();
  const detail = useCourseDetail(course.id);
  const linked = detail.data?.pools ?? [];

  return detail.isLoading ? (
    <Skeleton className="mt-2 h-6 w-48" />
  ) : detail.isError ? (
    <div className="mt-2">
      <QueryError title={t("pools.link")} query={detail} />
    </div>
  ) : linked.length === 0 ? (
    <p className="mt-1 text-[13px] text-fg-muted">{t("pools.linkNone")}</p>
  ) : (
    <ul className="mt-1 space-y-0.5">
      {linked.map((pool) => (
        <li key={pool.id} className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate({ view: "pool", id: pool.id })}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-field px-2 py-1 text-left text-[13px] transition-colors hover:bg-surface-2"
          >
            <FolderTree className="size-3.5 shrink-0 text-fg-faint" />
            <span className="min-w-0 flex-1 truncate font-medium">{pool.name}</span>
            <span className="shrink-0 text-xs tabular-nums text-fg-muted">
              {t(pool.questionCount === 1 ? "pools.questions.one" : "pools.questions", {
                n: pool.questionCount,
              })}
            </span>
          </button>
          {rowAction?.(pool)}
        </li>
      ))}
    </ul>
  );
}
