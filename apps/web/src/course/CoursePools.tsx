import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderTree, Link2, Unlink } from "lucide-react";
import type { ReactNode } from "react";

import type { CourseSummary, PoolSummary } from "@quiz/contracts";
import { poolRoleAllows } from "@quiz/domain";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import type { Route } from "../router";
import { Actions, Button, Menu, QueryError, Skeleton } from "../ui";
import { courseKey, poolsKey } from "../queryKeys";
import { CoursePart, useCourseDetail } from "./parts";

type LinkedPool = { id: string; name: string; questionCount: number };

/**
 * The pools a course draws from (F-POOL-05). The links are tended on the
 * course page only: the card on the Courses home is a summary, so it lists
 * the pools and offers neither link nor unlink.
 */
export function CoursePools({
  course,
  navigate,
  page = false,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
  /** Drawn as a section of the course page rather than a part of its card. */
  page?: boolean;
}) {
  return page ? (
    <EditablePools course={course} navigate={navigate} />
  ) : (
    <PoolList course={course} navigate={navigate} page={false} />
  );
}

/**
 * The page's pools, with their links. `PUT /courses/:id/pools` replaces the
 * WHOLE set in one call, so both the link and the unlink send the list the
 * course should end up with — there is no add/remove route, and inventing one
 * on the client would be a second way to do one thing.
 */
function EditablePools({ course, navigate }: { course: CourseSummary; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toastError = useErrorToast();

  const linked = useCourseDetail(course.id).data?.pools ?? [];
  const pools = useQuery<PoolSummary[]>({
    queryKey: poolsKey,
    queryFn: () => api("/app/api/pools"),
  });
  // Linking makes the whole staff contributors of the pool, so the server
  // refuses a pool the caller only reads (ADR-013): it is not offered.
  const available = (pools.data ?? []).filter(
    (p) => poolRoleAllows(p.role, "contributor") && !linked.some((l) => l.id === p.id),
  );

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

  const unlink = async (pool: LinkedPool) => {
    const ok = await confirm({
      title: t("pools.unlink"),
      message: t("pools.unlinkConfirm", { name: pool.name, course: course.name }),
      confirmLabel: t("pools.unlink"),
      cancelLabel: t("common.cancel"),
    });
    if (ok) setLinks.mutate(linked.filter((l) => l.id !== pool.id).map((l) => l.id));
  };

  return (
    <PoolList
      course={course}
      navigate={navigate}
      page
      action={
        // One click, no dialog: linking a pool is picking a name out of a
        // short list, and a modal with a select and two buttons was three
        // interactions for one decision.
        <Menu
          label={t("pools.linkAction")}
          trigger={
            <Button size="sm" variant="ghost">
              <Link2 /> {t("pools.linkAction")}
            </Button>
          }
          items={
            available.length > 0
              ? available.map((pool) => ({
                  label: pool.name,
                  icon: FolderTree,
                  onSelect: () => setLinks.mutate([...linked.map((l) => l.id), pool.id]),
                }))
              : [{ label: t("pools.linkEmpty"), disabled: true }]
          }
        />
      }
      rowAction={(pool) => (
        <Actions
          label={t("common.actions")}
          size="sm"
          items={[{ label: t("pools.unlink"), icon: Unlink, danger: true, onSelect: () => void unlink(pool) }]}
        />
      )}
    />
  );
}

/** The linked pools, each opening its pool; the actions, when given, beside them. */
function PoolList({
  course,
  navigate,
  page,
  action,
  rowAction,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
  page: boolean;
  action?: ReactNode;
  rowAction?: (pool: LinkedPool) => ReactNode;
}) {
  const t = useT();
  const detail = useCourseDetail(course.id);
  const linked = detail.data?.pools ?? [];

  return (
    <CoursePart page={page} icon={FolderTree} title={t("pools.link")} action={action}>
      {detail.isLoading ? (
        <Skeleton className="mt-2 h-6 w-48" />
      ) : detail.isError ? (
        <div className="mt-2">
          <QueryError
            title={t("pools.link")}
            error={detail.error}
            onRetry={() => void detail.refetch()}
            retrying={detail.isFetching}
          />
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
      )}
    </CoursePart>
  );
}
