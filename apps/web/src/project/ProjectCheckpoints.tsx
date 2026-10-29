import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import {
  CheckpointName,
  type ProjectDetail,
  type ReviewCheckpoint,
  type ReviewCheckpointCreate,
  type ZodIssueLite,
} from "@quiz/contracts";
import { checkpointTag } from "@quiz/domain";

import { api, ApiError, refusedWith } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { projectCheckpointsKey } from "../queryKeys";
import { fromLocalInput, Field, FieldError, fieldErrorProps, FormDialog, FormError, Segmented } from "../ui";
import { refusalMessage } from "./projectPage";

/** The body of a new checkpoint named `name` (a parsed `CheckpointName`), or null while its date is missing. */
function checkpointBody(name: string, kind: "date" | "offset", local: string, days: string): ReviewCheckpointCreate | null {
  if (kind === "offset") {
    const n = Number(days);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? { name, offsetDays: -n } : null;
  }
  const dueAt = fromLocalInput(local);
  return dueAt ? { name, dueAt } : null;
}

/**
 * Whether a refusal is the schema's 400 on the name. The dialog checks the
 * tag with the same `CheckpointName`, so only a client older than the
 * server's rule earns it; it is then said under the field.
 */
function refusesName(error: unknown): boolean {
  if (!(error instanceof ApiError) || !refusedWith(error, "validation")) return false;
  const details = (error.body as { details?: ZodIssueLite[] } | null)?.details ?? [];
  return details.some((issue) => issue.path[0] === "name");
}

/**
 * "Add a checkpoint": a name, and a date or a number of days before the
 * deadline. The name is typed freely and saved as its tag (`checkpointTag`),
 * said under the field once it differs from what was typed (#968).
 */
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
  const nameId = useId();
  const tag = checkpointTag(name);
  const parsed = CheckpointName.safeParse(tag);
  const body = parsed.success ? checkpointBody(parsed.data, kind, local, days) : null;
  const serverRefusedName = refusesName(error);
  const nameError =
    name.trim() !== "" && !parsed.success
      ? t("project.checkpoint.name.invalid")
      : serverRefusedName
        ? t("project.refusal.checkpointName")
        : null;
  return (
    <FormDialog
      title={t("project.checkpoints.new")}
      onClose={onClose}
      onSubmit={() => body && onSubmit(body)}
      submitLabel={t("common.create")}
      submitting={submitting}
      canSubmit={body !== null}
      error={<FormError error={serverRefusedName ? null : error} describe={(e) => refusalMessage(e, t)} />}
    >
      <div className="flex flex-col gap-1">
        <Field
          id={nameId}
          label={t("project.checkpoint.name")}
          description={
            tag !== "" && tag !== name ? (
              <>
                {t("project.checkpoint.name.tag")} <span className="font-mono text-fg">{tag}</span>
              </>
            ) : (
              t("project.checkpoint.name.desc")
            )
          }
          fullWidth
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          {...fieldErrorProps(nameId, nameError)}
        />
        <FieldError id={nameId}>{nameError}</FieldError>
      </div>
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
 * The review checkpoints of a project (F-PROJ-11, M3-05b): a name and a
 * date, absolute or J−n before the deadline, each dispatching a
 * `grade-milestone` review to every repository not yet at its deadline. The
 * list, the creation and the deletion, for the lifecycle rail
 * (`ProjectRail.tsx`) that draws them: the rail asks for the confirmation
 * before a deletion, and the server refuses it once any dispatch of the
 * checkpoint was claimed (`409 checkpoint_dispatched`), which is said as such.
 *
 * Asked for a project graded `auto` only: no review is dispatched otherwise.
 */
export function useCheckpoints(project: ProjectDetail) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const base = `/app/api/projects/${project.id}/checkpoints`;

  const list = useQuery<ReviewCheckpoint[]>({
    queryKey: projectCheckpointsKey(project.id),
    queryFn: () => api(base),
    enabled: project.gradingMode === "auto",
  });
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

  const dialog = adding ? (
    <AddCheckpoint
      onSubmit={(body) => create.mutate(body)}
      submitting={create.isPending}
      error={create.error}
      onClose={() => {
        create.reset();
        setAdding(false);
      }}
    />
  ) : null;
  return { list, onDelete, openAdd: () => setAdding(true), dialog };
}
