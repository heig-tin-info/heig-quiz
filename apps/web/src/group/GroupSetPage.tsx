import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Copy, Plus, Ruler, Shuffle, Trash2, TriangleAlert, UserPlus, Users } from "lucide-react";
import { useState } from "react";

import {
  GroupMaxSize,
  GroupRename,
  type ClassroomDetail,
  type GroupRandomForm,
  type GroupSetDetail,
} from "@quiz/contracts";

import { api, ApiError } from "../api";
import { AppLink } from "../AppLink";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { classroomGroupSetsKey, classroomKey, groupSetKey } from "../queryKeys";
import { useSearchParam, type Navigate } from "../router";
import {
  Alert,
  Button,
  Card,
  EditableTitle,
  EmptyState,
  Field,
  FieldError,
  fieldErrorProps,
  FormDialog,
  Menu,
  PageError,
  PageHeader,
  PageSkeleton,
  ParentLink,
  QueryError,
  Skeleton,
  type MenuItem,
} from "../ui";
import { setWrite, useGroupSet, useGroupSetWrites } from "./api";
import { GroupBoard } from "./GroupBoard";
import { gone, groupRefusalMessage, placeOf, setInUseProjects, studentName, studentOf, withMove } from "./groupRules";
import { SetUses, textLink } from "./parts";
import { RandomFormDialog } from "./RandomFormDialog";

/**
 * One group set of a classroom (ADR-070 §3, M3-16a),
 * `/classrooms/:id/groups/:setId`: the students in no group and the
 * groups, moved by drag and drop, click then click, or each student's
 * "Move to…" menu.
 *
 * ONE primary action while a student is in no group: **Form at random**.
 * Once everyone is placed there is none — what is left is fine-tuning by
 * hand. "New group" is the secondary; the maximum size, the duplicate and
 * the deletion live in the overflow menu; the name is renamed in place.
 *
 * A move with no GitHub consequence — every move before M3-15b — takes
 * effect at once, and the toast that says so offers Undo for its few
 * seconds (ADR-070 §6): the reverse move, latest move only. Writes go one
 * at a time per set, in order (`useGroupSetWrites`). An archived
 * classroom's set is read-only: every control is gone, an alert says why.
 */
export function GroupSetPage({ classroomId, id, navigate }: { classroomId: string; id: string; navigate: Navigate }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // The project this page was opened from (W9), `?fromProject=<id>`.
  const [project] = useSearchParam("fromProject", "");
  const [randomOpen, setRandomOpen] = useState(false);
  const [maxOpen, setMaxOpen] = useState(false);
  /** The projects that refused the deletion (`409 set_in_use`), said above the board. */
  const [inUse, setInUse] = useState<{ id: string; name: string }[] | null>(null);

  const set = useGroupSet(id);
  const room = useQuery<ClassroomDetail>({
    queryKey: classroomKey(classroomId),
    queryFn: () => api(`/app/api/classrooms/${classroomId}`),
  });
  const write = useGroupSetWrites(id);
  const failed = (error: unknown) => toast(groupRefusalMessage(error, t), "error");

  /** A student into `groupId` (`null`: no group), drawn at once. */
  const place = (enrollmentId: string, groupId: string | null) =>
    write(setWrite.place(enrollmentId, groupId), (d) => withMove(d, enrollmentId, groupId));

  /** The reverse of a move (ADR-070 §6): offers no Undo of its own; a 404 is a group gone since. */
  const undoMove = (enrollmentId: string, groupId: string | null) =>
    place(enrollmentId, groupId).catch((error: unknown) =>
      toast(gone(error) ? t("groups.undoFailed") : groupRefusalMessage(error, t), "error"),
    );

  /** A move, said in a toast that offers to undo it — the latest move only. */
  const move = (enrollmentId: string, groupId: string | null) => {
    const before = qc.getQueryData<GroupSetDetail>(groupSetKey(id));
    const student = before ? studentOf(before, enrollmentId) : undefined;
    const previous = before ? placeOf(before, enrollmentId) : undefined;
    if (!student || previous === undefined) return;
    place(enrollmentId, groupId).then((answer) => {
      const name = studentName(student);
      const group = answer.groups.find((g) => g.id === groupId)?.name;
      toast(group ? t("groups.moved", { name, group }) : t("groups.movedOut", { name }), "success", {
        key: `group-undo:${id}`,
        action: { label: t("groups.undo"), run: () => void undoMove(enrollmentId, previous) },
      });
    }, failed);
  };

  const addGroup = useMutation({ mutationFn: () => write(setWrite.addGroup()), onError: failed });
  const rename = useMutation({ mutationFn: (name: string) => write(setWrite.patch({ name })), onError: failed });
  const lists = () => qc.invalidateQueries({ queryKey: classroomGroupSetsKey(classroomId) });
  const duplicate = useMutation({
    mutationFn: () => api<GroupSetDetail>(`/app/api/group-sets/${id}/duplicate`, { method: "POST" }),
    onSuccess: async (copy) => {
      qc.setQueryData(groupSetKey(copy.set.id), copy);
      await lists();
      toast(t("groups.duplicated"), "success");
      navigate({ view: "groupSet", classroomId, id: copy.set.id });
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: () => api<void>(`/app/api/group-sets/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      qc.removeQueries({ queryKey: groupSetKey(id) });
      await lists();
      toast(t("groups.deleted"), "success");
      navigate({ view: "classroomGroups", id: classroomId });
    },
    onError: (error) => {
      const projects = setInUseProjects(error);
      if (projects) setInUse(projects);
      else failed(error);
    },
  });

  if (set.isLoading) return <PageSkeleton />;
  if (set.isError || !set.data) {
    if (set.error instanceof ApiError && set.error.status === 404) {
      return (
        <QueryError
          title={t("groups.set.notFound")}
          error={set.error}
          onRetry={() => void set.refetch()}
          retrying={set.isFetching}
          fallback={t("error.server")}
        />
      );
    }
    return (
      <PageError title={t("groups.set")} error={set.error} onRetry={() => void set.refetch()} retrying={set.isFetching} />
    );
  }

  const detail = set.data;
  const readOnly = detail.set.readOnly;
  const unplaced = detail.unplaced.length;
  const placed = detail.groups.reduce((sum, g) => sum + g.members.length, 0);
  const projectName = project ? detail.usedBy.find((u) => u.id === project)?.name : undefined;

  const onDeleteGroup = async (group: GroupSetDetail["groups"][number]) => {
    if (
      await confirm({
        title: t("groups.group.deleteConfirm.title", { name: group.name }),
        message: t("groups.group.deleteConfirm.body"),
        confirmLabel: t("common.delete"),
        danger: true,
      })
    ) {
      write(setWrite.deleteGroup(group.id)).catch(failed);
    }
  };
  const onRenameGroup = async (groupId: string, name: string): Promise<string | null> => {
    const body = GroupRename.safeParse({ name });
    if (!body.success) return t("groups.name.invalid");
    try {
      await write(setWrite.renameGroup(groupId, body.data));
      return null;
    } catch (error) {
      return groupRefusalMessage(error, t);
    }
  };
  const onDeleteSet = async () => {
    setInUse(null);
    if (
      await confirm({
        title: t("groups.deleteConfirm.title", { name: detail.set.name }),
        message: t("groups.deleteConfirm.body"),
        confirmLabel: t("common.delete"),
        danger: true,
      })
    ) {
      remove.mutate();
    }
  };

  const menuItems: MenuItem[] = [
    { label: t("groups.maxSize.menu"), icon: Ruler, onSelect: () => setMaxOpen(true) },
    { label: t("groups.duplicate"), icon: Copy, onSelect: () => duplicate.mutate() },
    { label: t("groups.delete"), icon: Trash2, danger: true, separator: true, onSelect: () => void onDeleteSet() },
  ];
  const counts = [
    t(detail.groups.length === 1 ? "groups.count.groups.one" : "groups.count.groups", { n: detail.groups.length }),
    t(placed === 1 ? "groups.count.placed.one" : "groups.count.placed", { n: placed }),
    t(unplaced === 1 ? "groups.count.unplaced.one" : "groups.count.unplaced", { n: unplaced }),
    ...(detail.set.maxSize !== null ? [t("groups.count.max", { n: detail.set.maxSize })] : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          project ? (
            <ParentLink onClick={() => navigate({ view: "project", id: project })} tip={t("groups.backToProject")}>
              {projectName ?? t("groups.backToProject")}
            </ParentLink>
          ) : room.data ? (
            <ParentLink onClick={() => navigate({ view: "classroomGroups", id: classroomId })}>{room.data.name}</ParentLink>
          ) : (
            <Skeleton className="h-4 w-24" />
          )
        }
        title={
          readOnly ? (
            detail.set.name
          ) : (
            <EditableTitle
              value={detail.set.name}
              pending={rename.isPending ? rename.variables : undefined}
              onSave={(name) => rename.mutate(name)}
              editLabel={t("groups.set.rename", { name: detail.set.name })}
              inputLabel={t("groups.set.name")}
            />
          )
        }
        description={
          <>
            <p className="tabular-nums">{counts.join(" · ")}</p>
            {detail.usedBy.length > 0 ? (
              <p className="mt-0.5">
                {t("groups.usedBy")} <SetUses uses={detail.usedBy} navigate={navigate} />
              </p>
            ) : null}
          </>
        }
        actions={
          readOnly ? null : (
            <>
              <Button variant="secondary" loading={addGroup.isPending} onClick={() => addGroup.mutate()}>
                <Plus /> {t("groups.newGroup")}
              </Button>
              {unplaced > 0 ? (
                <Button onClick={() => setRandomOpen(true)}>
                  <Shuffle /> {t("groups.random")}
                </Button>
              ) : null}
            </>
          )
        }
        menu={readOnly ? undefined : <Menu items={menuItems} />}
      />

      {readOnly ? (
        <Alert tone="neutral" icon={Archive} title={t("groups.refusal.classroomArchived")} />
      ) : null}
      {inUse ? (
        <Alert tone="danger" icon={TriangleAlert} title={t("groups.inUse.title")}>
          <p>{t("groups.inUse.body")}</p>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {inUse.map((p) => (
              <li key={p.id}>
                <AppLink route={{ view: "project", id: p.id }} navigate={navigate} className={`${textLink} font-medium text-fg`}>
                  {p.name}
                </AppLink>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {detail.groups.length === 0 && unplaced === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title={t("groups.noStudent.title")}
            action={
              <Button onClick={() => navigate({ view: "classroom", id: classroomId, tab: "roster" })}>
                <UserPlus /> {t("roster.add")}
              </Button>
            }
          >
            {t("groups.noStudent.body")}
          </EmptyState>
        </Card>
      ) : (
        <GroupBoard
          detail={detail}
          readOnly={readOnly}
          onMove={(enrollmentId, groupId) => move(enrollmentId, groupId)}
          onRename={onRenameGroup}
          onDelete={(group) => void onDeleteGroup(group)}
        />
      )}

      {randomOpen ? (
        <RandomFormDialog
          detail={detail}
          form={(body: GroupRandomForm) => write(setWrite.random(body))}
          onClose={() => setRandomOpen(false)}
        />
      ) : null}
      {maxOpen ? (
        <MaxSizeDialog
          value={detail.set.maxSize}
          save={(maxSize) => write(setWrite.patch({ maxSize }))}
          onClose={() => setMaxOpen(false)}
        />
      ) : null}
    </div>
  );
}

const MAX_ID = "group-set-max-size";

/** The set's maximum group size: a warning on a group above it, never a refusal (ADR-070 §3). Empty: none. */
function MaxSizeDialog({
  value,
  save,
  onClose,
}: {
  value: number | null;
  save: (maxSize: number | null) => Promise<GroupSetDetail>;
  onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const parsed = draft.trim() === "" ? ({ success: true, data: null } as const) : GroupMaxSize.safeParse(Number(draft));
  const submit = useMutation({ mutationFn: (maxSize: number | null) => save(maxSize), onSuccess: onClose });
  const invalid = parsed.success ? undefined : t("groups.maxSize.invalid");
  return (
    <FormDialog
      title={t("groups.maxSize")}
      onClose={onClose}
      onSubmit={() => parsed.success && submit.mutate(parsed.data)}
      submitLabel={t("common.save")}
      submitting={submit.isPending}
      canSubmit={parsed.success}
      dense
      error={submit.isError ? <p className="text-[13px] text-danger">{groupRefusalMessage(submit.error, t)}</p> : null}
    >
      <p className="text-sm text-fg-muted">{t("groups.maxSize.desc")}</p>
      <div className="flex flex-col gap-1">
        <Field
          id={MAX_ID}
          label={t("groups.maxSize")}
          type="number"
          min={1}
          max={50}
          width="w-24"
          className="text-right tabular-nums"
          placeholder={t("groups.maxSize.none")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          {...fieldErrorProps(MAX_ID, invalid)}
        />
        <FieldError id={MAX_ID}>{invalid}</FieldError>
      </div>
    </FormDialog>
  );
}
