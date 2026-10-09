import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, EyeOff, Lightbulb, Merge, Pencil, Sparkles, Split } from "lucide-react";
import { useMemo, useState } from "react";

import {
  POLL_IDEA_LABEL_MAX,
  type PollIdeaAction,
  type PollIdeaBoard,
  type PollRevealBody,
  type PollTeacherView,
  type WatchSubject,
} from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { pollIdeasKey, pollKey } from "../queryKeys";
import { useEventStream } from "../realtime/useEventStream";
import {
  Actions,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  cx,
  EmptyState,
  Field,
  FormDialog,
  IconButton,
  PageError,
  PageHeader,
  Segmented,
  Skeleton,
  Switch,
} from "../ui";
import { promptOf } from "./pollTally";

/**
 * A brainstorm's moderation board (issue #458, ADR-071), opened in a tab
 * beside the wall — never ON it: the wall must not show an idea the teacher
 * has not let through, and a queue of raw text is exactly that.
 *
 *   - Type: the cluster's label carries the row (15 px semibold), its
 *     spellings are chips at 13 px under it.
 *   - Color: one accent — "Approve all", the act that empties the queue. A
 *     status is a word on a Badge (amber waiting, green shown, zinc hidden).
 *   - Space: tight inside a cluster, a card per cluster, the queue's
 *     controls in the header.
 *   - Finish: hairlines only.
 *
 * Merge works on a SELECTION of clusters (into the first one picked); split
 * and rename are a cluster's own, in its menu. Everything the teacher does
 * is a `POST …/poll/ideas`, whose answer is the new board; the board also
 * follows the room live through the poll's tally frames.
 */
export function PollModeration({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const boardKey = pollIdeasKey(id);

  const poll = useQuery<PollTeacherView>({
    queryKey: pollKey(id),
    queryFn: () => api(`/app/api/evaluations/${id}/poll`),
  });
  const board = useQuery<PollIdeaBoard>({
    queryKey: boardKey,
    queryFn: () => api(`/app/api/evaluations/${id}/poll/ideas`),
    // The stream moves it; this is only the net under it.
    refetchInterval: 15_000,
  });

  useEventStream({
    watch: `evaluation:${id}` as WatchSubject,
    onRefresh: () => void qc.invalidateQueries({ queryKey: boardKey }),
    onEvent: (event) => {
      if (event.type === "poll.tally") void qc.invalidateQueries({ queryKey: boardKey });
    },
  });

  const act = useMutation({
    mutationFn: (body: PollIdeaAction) =>
      api<PollIdeaBoard>(`/app/api/evaluations/${id}/poll/ideas`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (data) => qc.setQueryData(boardKey, data),
    onError: toastError("poll.ideas.failed"),
  });
  // The board's own two switches: moderation, and the AI assistance (ADR-072).
  const display = useMutation({
    mutationFn: (body: Pick<PollRevealBody, "moderation" | "ai">) =>
      api<PollTeacherView>(`/app/api/evaluations/${id}/poll/reveal`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      qc.setQueryData(pollKey(id), data);
      void qc.invalidateQueries({ queryKey: boardKey });
    },
    onError: toastError("poll.ideas.failed"),
  });

  const [filter, setFilter] = useState<"all" | "pending">("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<{ key: string; label: string } | null>(null);

  const data = board.data;
  const pendingKeys = useMemo(
    () => (data?.clusters ?? []).flatMap((c) => c.variants.filter((v) => v.status === "pending").map((v) => v.key)),
    [data],
  );
  // What waits comes first: the queue is the reason this tab is open.
  const clusters = useMemo(() => {
    const waits = (c: PollIdeaBoard["clusters"][number]) => c.variants.some((v) => v.status === "pending");
    const all = data?.clusters ?? [];
    return [...all.filter(waits), ...(filter === "all" ? all.filter((c) => !waits(c)) : [])];
  }, [data, filter]);

  if (board.isLoading || poll.isLoading) {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  if (board.isError || poll.isError || !data || !poll.data) {
    return (
      <PageError
        title={t("poll.ideas.notFound")}
        error={board.error ?? poll.error}
        onRetry={() => {
          void board.refetch();
          void poll.refetch();
        }}
        retrying={board.isFetching}
      />
    );
  }

  const view = poll.data;
  const toggle = (key: string) =>
    setSelected((now) => (now.includes(key) ? now.filter((k) => k !== key) : [...now, key]));
  const merge = () => {
    const [into, ...keys] = selected;
    if (into === undefined || keys.length === 0) return;
    act.mutate({ action: "merge", keys, into }, { onSuccess: () => setSelected([]) });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("poll.ideas.eyebrow", { code: view.evaluation.code })}
        title={promptOf(view.question)}
        description={`${t(data.answered === 1 ? "poll.ideas.participants.one" : "poll.ideas.participants", {
          n: data.answered,
        })} · ${t(data.pending === 1 ? "poll.ideas.pending.one" : "poll.ideas.pending", { n: data.pending })}`}
        actions={
          <>
            {/* Offered only when a model can be called — or to turn off one that no longer can. */}
            {data.ai.available || data.ai.on ? (
              <BoardSwitch
                label={t("poll.ai")}
                checked={data.ai.on}
                disabled={display.isPending}
                onChange={(ai) => display.mutate({ ai })}
              />
            ) : null}
            <BoardSwitch
              label={t("poll.moderation")}
              checked={data.moderation}
              disabled={display.isPending}
              onChange={(moderation) => display.mutate({ moderation })}
            />
            <Button
              disabled={pendingKeys.length === 0}
              loading={act.isPending && act.variables?.action === "approve"}
              onClick={() => act.mutate({ action: "approve", keys: pendingKeys })}
            >
              <Check /> {t("poll.ideas.approveAll", { n: pendingKeys.length })}
            </Button>
          </>
        }
      />

      {data.ai.on && data.ai.error !== null ? (
        // Fail closed (ADR-072): nothing the model did not judge reaches the wall by itself.
        <Alert tone="warning" title={t("poll.ai.failed")}>
          {t(data.ai.error === "run_cap" ? "poll.ai.failed.cap" : "poll.ai.failed.body")}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          name="poll-ideas-filter"
          label={t("poll.ideas.filter")}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("poll.ideas.filter.all") },
            { value: "pending", label: t("poll.ideas.filter.pending", { n: data.pending }) },
          ]}
        />
        {selected.length > 0 ? (
          <span className="ml-auto inline-flex items-center gap-2 text-[13px] text-fg-muted">
            {t("poll.ideas.selected", { n: selected.length })}
            <Button size="sm" variant="secondary" disabled={selected.length < 2} onClick={merge}>
              <Merge /> {t("poll.ideas.merge")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              {t("common.cancel")}
            </Button>
          </span>
        ) : null}
      </div>

      {clusters.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title={t(filter === "pending" ? "poll.ideas.emptyPending" : "poll.ideas.empty")}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {clusters.map((cluster) => {
            const picked = selected.includes(cluster.key);
            return (
              <li key={cluster.key}>
                <Card className={cx("flex flex-col gap-2.5 px-4 py-3", picked && "border-accent")}>
                  <div className="flex items-center gap-3">
                    <Checkbox
                      label={<span className="sr-only">{t("poll.ideas.select", { label: cluster.label })}</span>}
                      checked={picked}
                      onChange={() => toggle(cluster.key)}
                    />
                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">
                      {cluster.label}
                    </span>
                    <span className="shrink-0 font-mono text-[13px] tabular-nums text-fg-muted">
                      {t("poll.ideas.shown", {
                        n: cluster.count,
                        total: cluster.total,
                      })}
                    </span>
                    <Actions
                      label={t("poll.ideas.actions")}
                      menu
                      items={[
                        {
                          label: t("poll.ideas.rename"),
                          icon: Pencil,
                          onSelect: () => setRenaming({ key: cluster.key, label: cluster.renamed ? cluster.label : "" }),
                        },
                        ...(cluster.variants.length > 1
                          ? [
                              {
                                label: t("poll.ideas.split"),
                                icon: Split,
                                onSelect: () =>
                                  act.mutate({
                                    action: "detach",
                                    keys: cluster.variants.map((v) => v.key).filter((k) => k !== cluster.key),
                                  }),
                              },
                            ]
                          : []),
                        {
                          label: t("poll.ideas.hideAll"),
                          icon: EyeOff,
                          danger: true,
                          onSelect: () => act.mutate({ action: "hide", keys: cluster.variants.map((v) => v.key) }),
                        },
                      ]}
                    />
                  </div>
                  <ul className="flex flex-wrap gap-1.5 pl-7">
                    {cluster.variants.map((v) => (
                      <li
                        key={v.key}
                        className={cx(
                          "touch-group inline-flex items-center gap-1.5 rounded-full border border-line py-0.5 pr-0.5 pl-2.5 text-[13px]",
                          v.status === "hidden" ? "bg-surface-2 text-fg-faint line-through" : "bg-surface text-fg",
                        )}
                      >
                        <span className="break-all">{v.text}</span>
                        {/* What the room reads in its place: the model's corrected form. */}
                        {v.correction !== null && v.correction !== v.text ? (
                          <span className="break-all text-fg-muted">→ {v.correction}</span>
                        ) : null}
                        {v.ai ? (
                          <span className="text-fg-faint" title={t("poll.ai.decided")}>
                            <Sparkles className="size-3.5" aria-label={t("poll.ai.decided")} />
                          </span>
                        ) : null}
                        {v.count > 1 ? (
                          <span className="font-mono text-[12px] tabular-nums text-fg-muted">×{v.count}</span>
                        ) : null}
                        {v.status === "pending" ? (
                          <Badge tone="amber">{t("poll.ideas.status.pending")}</Badge>
                        ) : null}
                        {v.status === "approved" && data.moderation ? (
                          <Badge tone="green">{t("poll.ideas.status.approved")}</Badge>
                        ) : null}
                        {v.status === "approved" ? null : (
                          <IconButton
                            size="sm"
                            label={t("poll.ideas.approve", { text: v.text })}
                            onClick={() => act.mutate({ action: "approve", keys: [v.key] })}
                          >
                            <Check />
                          </IconButton>
                        )}
                        {v.status === "hidden" ? null : (
                          <IconButton
                            size="sm"
                            danger
                            label={t("poll.ideas.hide", { text: v.text })}
                            onClick={() => act.mutate({ action: "hide", keys: [v.key] })}
                          >
                            <EyeOff />
                          </IconButton>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {renaming ? (
        <FormDialog
          title={t("poll.ideas.rename")}
          onClose={() => setRenaming(null)}
          submitLabel={t("common.save")}
          submitting={act.isPending}
          onSubmit={() =>
            act.mutate(
              { action: "rename", key: renaming.key, label: renaming.label.trim() || null },
              { onSuccess: () => setRenaming(null) },
            )
          }
        >
          <Field
            label={t("poll.ideas.label")}
            description={t("poll.ideas.labelHint")}
            fullWidth
            maxLength={POLL_IDEA_LABEL_MAX}
            autoFocus
            value={renaming.label}
            onChange={(e) => setRenaming({ ...renaming, label: e.target.value })}
          />
        </FormDialog>
      ) : null}
    </div>
  );
}

/** A switch of the board, its words beside it: a state, not an action. */
function BoardSwitch(props: { label: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] font-medium text-fg-muted">
      <Switch {...props} />
      <span aria-hidden>{props.label}</span>
    </span>
  );
}
