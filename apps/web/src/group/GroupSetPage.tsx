import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Copy, DoorClosed, DoorOpen, Plus, Ruler, Shuffle, Trash2, TriangleAlert, UserPlus, Users } from "lucide-react";
import { useState } from "react";

import {
  GroupMaxSize,
  type ClassroomDetail,
  type GroupRandomForm,
  type GroupSetDetail,
} from "@quiz/contracts";

import { api, ApiError } from "../api";
import { AppLink } from "../AppLink";
import { useConfirm } from "../confirm";
import { fromLocalInput, toLocalInput } from "../evaluation/timing";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { classroomGroupSetsKey, classroomKey, groupSetKey } from "../queryKeys";
import { useSearchParam, type Navigate } from "../router";
import { Trail, useClassroomCrumbs } from "../Trail";
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
  isoDateTime,
  Menu,
  PageError,
  PageHeader,
  PageSkeleton,
  QueryError,
  Skeleton,
  textLink,
  type MenuItem,
} from "../ui";
import { setWrite, useGroupSet, useGroupSetWrites } from "./api";
import { ConsequencesDialog, type Asked } from "./ConsequencesDialog";
import { GroupBoard } from "./GroupBoard";
import {
  gone,
  groupRefusalMessage,
  needsConfirmation,
  placeOf,
  projectsRefusal,
  studentName,
  studentOf,
  withMove,
  type ProjectsRefusal,
} from "./groupRules";
import { SetUses } from "./parts";
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
 * A move with no GitHub consequence takes effect at once, and the toast
 * that says so offers Undo for its few seconds (ADR-070 §6): the reverse
 * move, latest move only. A move that reaches a group repository answers
 * `409 needs_confirmation` (M3-16b): the move stays drawn, the queue holds
 * every later write, and a dialog names the consequences the server listed
 * — Confirm sends the move again with their digest (a stale digest names
 * them again, "changed meanwhile"), Cancel puts the set back. A confirmed
 * move's toast offers no Undo: undoing it is another move to confirm. An
 * Undo meeting the 409 opens the same dialog. Deleting a group a following
 * project holds with a repository stays refused (`409 has_repo`), its
 * projects named above the board: its members are moved out one by one.
 * Writes go one at a time per set, in order (`useGroupSetWrites`). An archived
 * classroom's set is read-only: every control is gone, an alert says why.
 *
 * Opening the set to its students (F-PROJ-22, M3-17) is in the overflow
 * menu — a date and the maximum size, which then binds them, in one dialog
 * that says what an open set risks; while it is open, a neutral alert under
 * the header says until when, with "Close to students" beside it.
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
  const [opening, setOpening] = useState(false);
  /**
   * A refusal over projects — the deletion of a set they name (`set_in_use`),
   * a write reaching a group that has a repository (`has_repo`) — said
   * above the board with the projects as links.
   */
  const [blocked, setBlocked] = useState<ProjectsRefusal | null>(null);

  const set = useGroupSet(id);
  const crumbs = useClassroomCrumbs(classroomId);
  const room = useQuery<ClassroomDetail>({
    queryKey: classroomKey(classroomId),
    queryFn: () => api(`/app/api/classrooms/${classroomId}`),
  });
  const { write, confirm: confirmWrite, cancel: cancelWrite } = useGroupSetWrites(id);
  /** A move waiting for the confirmation of its GitHub consequences (ADR-070 §6), the queue held meanwhile. */
  const [asked, setAsked] = useState<({ move: Move } & Asked) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const failed = (error: unknown) => {
    const refusal = projectsRefusal(error);
    if (refusal) setBlocked(refusal);
    else toast(groupRefusalMessage(error, t), "error");
  };

  /** A student into `groupId` (`null`: no group), drawn at once. */
  const place = (enrollmentId: string, groupId: string | null) =>
    write(setWrite.place(enrollmentId, groupId), (d) => withMove(d, enrollmentId, groupId));

  /** A move's toast: with Undo (the reverse move, the latest only) when it took effect at once, without once confirmed. */
  const moved = (m: Move, answer: GroupSetDetail, undo: boolean) => {
    const group = answer.groups.find((g) => g.id === m.groupId)?.name;
    toast(t(MOVED[group ? "into" : "out"][undo ? "now" : "confirmed"], { name: m.name, group: group ?? "" }), "success", {
      key: `group-undo:${id}`,
      ...(undo ? { action: { label: t("groups.undo"), run: () => void undoMove(m) } } : {}),
    });
  };

  /** A refused move: its consequences asked for (the move stays drawn), else the refusal said. */
  const refused = (m: Move, changedSince: boolean) => (error: unknown) => {
    const consequences = needsConfirmation(error);
    if (consequences) setAsked({ move: m, ...consequences, changedSince });
    else failed(error);
  };

  /** The reverse of a move (ADR-070 §6): offers no Undo of its own; a 404 is a group gone since. */
  const undoMove = (m: Move) => {
    const back = { ...m, groupId: m.previous, previous: m.groupId };
    return place(back.enrollmentId, back.groupId).then(
      () => undefined,
      (error: unknown) => (gone(error) ? toast(t("groups.undoFailed"), "error") : refused(back, false)(error)),
    );
  };

  /** A move, said in a toast that offers to undo it — or, reaching GitHub, confirmed first. */
  const move = (enrollmentId: string, groupId: string | null) => {
    const before = qc.getQueryData<GroupSetDetail>(groupSetKey(id));
    const student = before ? studentOf(before, enrollmentId) : undefined;
    const previous = before ? placeOf(before, enrollmentId) : undefined;
    if (!student || previous === undefined) return;
    const m: Move = { enrollmentId, groupId, previous, name: studentName(student) };
    place(enrollmentId, groupId).then((answer) => moved(m, answer, true), refused(m, false));
  };

  /** The move sent again with the digest of what the dialog named; a stale digest names them again. */
  const onConfirm = () => {
    if (!asked) return;
    const m = asked.move;
    setConfirming(true);
    confirmWrite(setWrite.place(m.enrollmentId, m.groupId, asked.digest))
      .then(
        (answer) => {
          setAsked(null);
          moved(m, answer, false);
        },
        (error: unknown) => {
          setAsked(null);
          refused(m, true)(error);
        },
      )
      .finally(() => setConfirming(false));
  };
  const onCancelConfirm = () => {
    cancelWrite();
    setAsked(null);
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
    onError: failed,
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
    const request = setWrite.renameGroup(groupId, name);
    if (!request) return t("groups.name.invalid");
    try {
      await write(request);
      return null;
    } catch (error) {
      return groupRefusalMessage(error, t);
    }
  };
  const onDeleteSet = async () => {
    setBlocked(null);
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

  const closeToStudents = () =>
    write(setWrite.patch({ openUntil: null })).then(() => toast(t("groups.open.closed"), "success"), failed);

  const menuItems: MenuItem[] = [
    { label: t(detail.set.open ? "groups.open.change" : "groups.open.menu"), icon: DoorOpen, onSelect: () => setOpening(true) },
    ...(detail.set.open ? [{ label: t("groups.open.close"), icon: DoorClosed, onSelect: () => void closeToStudents() }] : []),
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
          <Trail
            navigate={navigate}
            items={[
              ...crumbs,
              // Opened from a project: the project is the ancestor it came for (W9),
              // once its name is known; otherwise the classroom's Groups.
              ...(project
                ? projectName
                  ? [{ label: projectName, route: { view: "project", id: project } as const }]
                  : []
                : [{ label: t("groups.tab"), route: { view: "classroomGroups", id: classroomId } as const }]),
              { label: detail.set.name },
            ]}
          />
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
        help="groups"
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
      ) : detail.set.open && detail.set.openUntil !== null ? (
        <Alert
          tone="neutral"
          icon={DoorOpen}
          title={t("groups.open.banner", { when: isoDateTime(detail.set.openUntil) })}
          action={
            <Button variant="secondary" size="sm" onClick={() => void closeToStudents()}>
              {t("groups.open.close")}
            </Button>
          }
        >
          {detail.set.maxSize !== null ? <p>{t("groups.open.bannerBody", { max: detail.set.maxSize })}</p> : null}
        </Alert>
      ) : null}
      {blocked ? (
        <Alert
          tone="danger"
          icon={TriangleAlert}
          title={t(blocked.code === "set_in_use" ? "groups.inUse.title" : "groups.refusal.hasRepo")}
        >
          <p>{t(blocked.code === "set_in_use" ? "groups.inUse.body" : "groups.hasRepo.body")}</p>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {blocked.projects.map((p) => (
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

      {asked ? (
        <ConsequencesDialog
          kind="move"
          asked={asked}
          confirming={confirming}
          onConfirm={onConfirm}
          onCancel={onCancelConfirm}
        />
      ) : null}
      {randomOpen ? (
        <RandomFormDialog
          detail={detail}
          form={(body: GroupRandomForm) => write(setWrite.random(body))}
          onClose={() => setRandomOpen(false)}
        />
      ) : null}
      {opening ? (
        <OpenDialog
          openUntil={detail.set.open ? detail.set.openUntil : null}
          maxSize={detail.set.maxSize}
          save={(body) => write(setWrite.patch(body))}
          onClose={() => setOpening(false)}
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

/** A move's toast, by where the student went and whether it took effect at once (with Undo) or was confirmed. */
const MOVED = {
  into: { now: "groups.moved", confirmed: "groups.movedConfirmed" },
  out: { now: "groups.movedOut", confirmed: "groups.movedOutConfirmed" },
} as const;

/** A student's move on the board: where to, from where (for Undo), and their name for the toast. */
interface Move {
  enrollmentId: string;
  groupId: string | null;
  previous: string | null;
  name: string;
}

/**
 * The maximum group size, as typed: the draft and its parse. Empty is no
 * maximum, unless `required` (an open set's, F-PROJ-22).
 */
function useMaxSize(initial: number | null, required: boolean) {
  const t = useT();
  const [draft, setDraft] = useState(initial === null ? "" : String(initial));
  const parsed = draft.trim() === "" ? ({ success: !required, data: null } as const) : GroupMaxSize.safeParse(Number(draft));
  const invalid = parsed.success ? undefined : t(required ? "groups.open.maxInvalid" : "groups.maxSize.invalid");
  return { draft, setDraft, parsed, invalid };
}

/** The maximum size's field, with its refusal under it: the same in the maximum's dialog and the opening's. */
function MaxSizeField({
  id,
  state,
  placeholder,
}: {
  id: string;
  state: ReturnType<typeof useMaxSize>;
  placeholder?: string | undefined;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1">
      <Field
        id={id}
        label={t("groups.maxSize")}
        type="number"
        min={1}
        max={50}
        width="w-24"
        className="text-right tabular-nums"
        placeholder={placeholder}
        value={state.draft}
        onChange={(e) => state.setDraft(e.target.value)}
        {...fieldErrorProps(id, state.invalid)}
      />
      <FieldError id={id}>{state.invalid}</FieldError>
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
  const max = useMaxSize(value, false);
  const { parsed } = max;
  const submit = useMutation({ mutationFn: (maxSize: number | null) => save(maxSize), onSuccess: onClose });
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
      <MaxSizeField id={MAX_ID} state={max} placeholder={t("groups.maxSize.none")} />
    </FormDialog>
  );
}

const OPEN_UNTIL_ID = "group-set-open-until";
const OPEN_MAX_ID = "group-set-open-max";

/** A week from now at 23:59, in the browser's zone: where the opening's date starts. */
function inAWeek(): string {
  const at = new Date();
  at.setDate(at.getDate() + 7);
  at.setHours(23, 59, 0, 0);
  return at.toISOString();
}

/**
 * Opening the set to its students (F-PROJ-22), or moving its closing: the
 * date (the browser's zone, `datetime-local`; the server's clock decides)
 * and the maximum size, required while it is open and binding for the
 * students. Says what an open set risks: a published project on it can be
 * accepted once everyone is placed, and its first repository freezes the
 * groups for the students.
 */
function OpenDialog({
  openUntil,
  maxSize,
  save,
  onClose,
}: {
  openUntil: string | null;
  maxSize: number | null;
  save: (body: { openUntil: string; maxSize: number }) => Promise<GroupSetDetail>;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [until, setUntil] = useState(toLocalInput(openUntil ?? inAWeek()));
  const max = useMaxSize(maxSize, true);
  const at = fromLocalInput(until);
  const dateOk = at !== null && Date.parse(at) > Date.now();
  const size = max.parsed;
  const submit = useMutation({
    mutationFn: (body: { openUntil: string; maxSize: number }) => save(body),
    onSuccess: (detail) => {
      toast(t("groups.open.opened", { when: isoDateTime(detail.set.openUntil ?? at!) }), "success");
      onClose();
    },
  });
  return (
    <FormDialog
      title={t("groups.open.title")}
      onClose={onClose}
      onSubmit={() => dateOk && size.success && size.data !== null && submit.mutate({ openUntil: at!, maxSize: size.data })}
      submitLabel={t("groups.open.submit")}
      submitting={submit.isPending}
      canSubmit={dateOk && size.success}
      error={submit.isError ? <p className="text-[13px] text-danger">{groupRefusalMessage(submit.error, t)}</p> : null}
    >
      <p className="text-sm text-fg-muted">{t("groups.open.desc")}</p>
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex flex-col gap-1">
          <Field
            id={OPEN_UNTIL_ID}
            label={t("groups.open.until")}
            type="datetime-local"
            width="w-56"
            min={toLocalInput(new Date().toISOString())}
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            {...fieldErrorProps(OPEN_UNTIL_ID, dateOk ? undefined : t("groups.open.dateInvalid"))}
          />
          <FieldError id={OPEN_UNTIL_ID}>{dateOk ? undefined : t("groups.open.dateInvalid")}</FieldError>
        </div>
        <MaxSizeField id={OPEN_MAX_ID} state={max} />
      </div>
      <Alert tone="warning" icon={TriangleAlert}>
        <p>{t("groups.open.risk")}</p>
      </Alert>
    </FormDialog>
  );
}
