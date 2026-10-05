import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import type { ProjectDetail, ReviewCheckpoint, ReviewCheckpointCreate } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { fromLocalInput } from "../evaluation/timing";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { projectCheckpointsKey } from "../queryKeys";
import {
  Actions,
  Badge,
  Button,
  Card,
  Field,
  FormDialog,
  FormError,
  isoDateTime,
  QueryError,
  RelativeTime,
  SectionHeading,
  Segmented,
  Skeleton,
  type Tone,
} from "../ui";
import { checkpointStatus, refusalMessage, type CheckpointStatus } from "./projectPage";

const STATUS_TONE: Record<CheckpointStatus, Tone> = { dispatched: "green", void: "zinc", scheduled: "amber" };

/** The body of a new checkpoint, or null while a field is missing (the name's pattern is the server's). */
function checkpointBody(name: string, kind: "date" | "offset", local: string, days: string): ReviewCheckpointCreate | null {
  const trimmed = name.trim();
  if (trimmed === "") return null;
  if (kind === "offset") {
    const n = Number(days);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? { name: trimmed, offsetDays: -n } : null;
  }
  const dueAt = fromLocalInput(local);
  return dueAt ? { name: trimmed, dueAt } : null;
}

/** "Add a checkpoint": a name, and a date or a number of days before the deadline. */
function AddCheckpoint({
  onSubmit,
  submitting,
  error,
  onClose,
}: {
  onSubmit: (body: ReviewCheckpointCreate) => void;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"date" | "offset">("offset");
  const [local, setLocal] = useState("");
  const [days, setDays] = useState("3");
  const body = checkpointBody(name, kind, local, days);
  return (
    <FormDialog
      title={t("project.checkpoints.add")}
      onClose={onClose}
      onSubmit={() => body && onSubmit(body)}
      submitLabel={t("common.create")}
      submitting={submitting}
      canSubmit={body !== null}
      error={<FormError error={error} describe={(e) => refusalMessage(e, t)} />}
    >
      <Field
        label={t("project.checkpoint.name")}
        description={t("project.checkpoint.name.desc")}
        fullWidth
        autoFocus
        className="font-mono"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Segmented
        name="checkpointKind"
        label={t("project.checkpoint.when")}
        value={kind}
        onChange={setKind}
        options={[
          { value: "offset", label: t("project.checkpoint.kind.offset") },
          { value: "date", label: t("project.checkpoint.kind.date") },
        ]}
      />
      {kind === "offset" ? (
        <Field
          label={t("project.checkpoint.kind.offset")}
          type="number"
          min={1}
          max={365}
          width="w-32"
          className="text-right tabular-nums"
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
      ) : (
        <Field
          label={t("project.checkpoint.when")}
          type="datetime-local"
          width="w-56"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
        />
      )}
    </FormDialog>
  );
}

/**
 * The review checkpoints (F-PROJ-11, M3-05b): a name and a date, absolute
 * or J−n before the deadline, each dispatching a `grade-milestone` review to
 * every repository not yet at its deadline. Listed with their status — sent,
 * scheduled, or void when the deadline moved before it (it never fires, and
 * may be deleted) —, added through a dialog, deleted after a confirmation;
 * the server refuses the deletion once any dispatch of it was claimed
 * (`409 checkpoint_dispatched`), which is said as such.
 *
 * Drawn for a project graded `auto` only: no review is dispatched otherwise.
 */
export function ProjectCheckpoints({ project }: { project: ProjectDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const base = `/app/api/projects/${project.id}/checkpoints`;

  const list = useQuery<ReviewCheckpoint[]>({ queryKey: projectCheckpointsKey(project.id), queryFn: () => api(base) });
  const refresh = () => qc.invalidateQueries({ queryKey: projectCheckpointsKey(project.id) });
  const create = useMutation({
    mutationFn: (body: ReviewCheckpointCreate) =>
      api<ReviewCheckpoint>(base, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => {
      await refresh();
      setAdding(false);
      toast(t("project.checkpoint.created"), "success");
    },
  });
  const remove = useMutation({
    mutationFn: (cid: string) => api<void>(`${base}/${cid}`, { method: "DELETE" }),
    onSuccess: async () => {
      await refresh();
      toast(t("project.checkpoint.deleted"), "success");
    },
    onError: (error) => toast(refusalMessage(error, t), "error"),
  });

  const onDelete = async (c: ReviewCheckpoint) => {
    if (
      await confirm({
        title: t("project.checkpoint.deleteConfirm", { name: c.name }),
        confirmLabel: t("common.delete"),
        danger: true,
      })
    ) {
      remove.mutate(c.id);
    }
  };

  return (
    <section aria-labelledby="project-checkpoints" className="space-y-3" data-coach="project.checkpoints">
      <SectionHeading
        icon={Flag}
        title={<span id="project-checkpoints">{t("project.checkpoints")}</span>}
        count={list.data?.length}
        description={t("project.checkpoints.desc")}
        actions={
          <Button variant="secondary" size="sm" disabled={project.archivedAt !== null} onClick={() => setAdding(true)}>
            <Plus /> {t("project.checkpoints.add")}
          </Button>
        }
      />
      {list.isLoading ? (
        <Skeleton className="h-12" />
      ) : list.isError ? (
        <QueryError
          title={t("project.checkpoints.failed")}
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : list.data!.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("project.checkpoints.empty")}</p>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {list.data!.map((c) => {
              const status = checkpointStatus(c, project.deadlineAt);
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                  <span className="font-mono text-[13px] font-semibold">{c.name}</span>
                  <span className="tabular-nums text-[13px] text-fg-muted">
                    {isoDateTime(c.dueAt)}
                    {c.offsetDays !== null ? ` · ${t("project.checkpoint.offsetLabel", { n: -c.offsetDays })}` : ""}
                  </span>
                  <Badge tone={STATUS_TONE[status]}>
                    {t(`project.checkpoint.status.${status}`)}
                    {status === "dispatched" ? (
                      <>
                        {" "}
                        <RelativeTime iso={c.dispatchedAt!} />
                      </>
                    ) : null}
                  </Badge>
                  {status === "void" ? (
                    <span className="text-xs text-fg-faint">{t("project.checkpoint.void.desc")}</span>
                  ) : null}
                  <span className="ml-auto">
                    {status !== "dispatched" ? (
                      <Actions
                        size="sm"
                        items={[
                          {
                            label: t("project.checkpoint.delete", { name: c.name }),
                            icon: Trash2,
                            danger: true,
                            onSelect: () => void onDelete(c),
                          },
                        ]}
                      />
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {adding ? (
        <AddCheckpoint
          onSubmit={(body) => create.mutate(body)}
          submitting={create.isPending}
          error={create.error}
          onClose={() => {
            create.reset();
            setAdding(false);
          }}
        />
      ) : null}
    </section>
  );
}
