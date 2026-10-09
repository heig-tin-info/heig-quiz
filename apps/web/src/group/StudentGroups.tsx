/**
 * The student's Groups tab (F-PROJ-22, ADR-070 §8 as amended 2026-10-05;
 * M3-17), `/classrooms/:id/groups` under the classroom page's header: the
 * classroom's group sets that reach the students — an open one, or one a
 * published project names — as the server's student view gives them
 * (`StudentGroupSet`, N-SEC-20). Nothing here is decided by the client:
 * `writable` says whether the reader may act (open, not frozen, their own
 * session on a student seat), `open` whether the set lists every group.
 *
 * An open set: its groups (name, size against the maximum, members) and the
 * students in no group; the reader creates a group (named, or "Group k"),
 * joins one that is not full, leaves theirs, renames theirs — their own
 * group drawn first. A closed set:
 * their own group alone, or the line that the teachers will place them.
 * When an open set's `openUntil` passes, the list is read again (no ticker
 * on the server, invariant 5: the server's clock decides every write).
 *
 * The four decisions:
 *   - Type: the set's name at the section step (16 px bold), its deadline
 *     and maximum at 14 px muted; a group's name 14 px semibold, its
 *     members 13 px.
 *   - Color: ONE accent, "Create a group", while the reader is in no group
 *     of an open set they may write (the first such set only); "Join" is
 *     secondary — choosing among groups is a list, not the screen's action.
 *     The reader's own group wears the `accent-soft` chip "your group".
 *   - Space: 32 between sets, 12 between the cards of a set, 16 inside.
 *   - Finish: cards on the canvas, hairlines, no shadow.
 */
import { Pencil, Plus, Users } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { GroupName, type GroupMemberName, type StudentGroupSet, type StudentGroupSets } from "@quiz/contracts";

import { useT } from "../i18n";
import { useToast } from "../notify";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  FormDialog,
  isoDateTime,
  QueryError,
  SectionHeading,
  Skeleton,
} from "../ui";
import { studentWrite, useStudentGroupSets, useStudentGroupWrite, type StudentWrite } from "./api";
import { groupRefusalMessage, studentName } from "./groupRules";

type Group = StudentGroupSet["groups"][number];

/** The longest a timer may wait (2^31 − 1 ms, about 24.8 days). */
const MAX_DELAY = 2_147_483_647;

/** A full group, to the students: at or above the set's maximum (the staff may have filled it past it). */
export const isFull = (group: Pick<Group, "size">, maxSize: number | null): boolean => maxSize !== null && group.size >= maxSize;

/** The set whose "Create a group" is the page's one primary: the first the reader may write while in no group of it. */
export const primarySetId = (sets: readonly StudentGroupSet[]): string | null =>
  sets.find((s) => s.writable && s.myGroupId === null)?.set.id ?? null;

/** How long until the soonest open set closes, by the answer's server clock; null when none is open. */
export function untilClosing({ serverNow, sets }: StudentGroupSets): number | null {
  const waits = sets
    .filter((s) => s.set.open && s.set.openUntil !== null)
    .map((s) => Date.parse(s.set.openUntil!) - Date.parse(serverNow));
  return waits.length === 0 ? null : Math.max(0, Math.min(...waits));
}

export function StudentGroups({ classroomId }: { classroomId: string }) {
  const t = useT();
  const sets = useStudentGroupSets(classroomId);
  const { refetch, dataUpdatedAt } = sets;
  const wait = sets.data ? untilClosing(sets.data) : null;

  // Read again when the soonest set closes: it then shows the reader's group alone.
  useEffect(() => {
    if (wait === null) return;
    const timer = setTimeout(() => void refetch(), Math.min(MAX_DELAY, wait + 1000));
    return () => clearTimeout(timer);
  }, [wait, dataUpdatedAt, refetch]);

  if (sets.isLoading) {
    return (
      <div className="space-y-3" role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-5 w-48" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }
  if (sets.isError) {
    return (
      <QueryError title={t("sgroups.loadError")} query={sets} />
    );
  }
  const list = sets.data?.sets ?? [];
  if (list.length === 0) {
    return (
      <Card>
        <EmptyState icon={Users} title={t("sgroups.empty.title")}>
          {t("sgroups.empty.body")}
        </EmptyState>
      </Card>
    );
  }
  const primary = primarySetId(list);
  return (
    <div className="space-y-8">
      {list.map((set) => (
        <SetSection key={set.set.id} classroomId={classroomId} view={set} primary={set.set.id === primary} />
      ))}
    </div>
  );
}

/** What a set's form is open for: a new group, or the reader's own renamed. */
type Dialog = { kind: "create" } | { kind: "rename"; group: Group } | null;

function SetSection({ classroomId, view, primary }: { classroomId: string; view: StudentGroupSet; primary: boolean }) {
  const t = useT();
  const toast = useToast();
  const write = useStudentGroupWrite(classroomId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const { set, writable, myGroupId, groups } = view;
  const mine = groups.find((g) => g.id === myGroupId) ?? null;
  // Their own group first: on a phone, the one card they act on is not ten cards down.
  const ordered = mine ? [mine, ...groups.filter((g) => g !== mine)] : groups;

  /** Sends one write, its success said in a toast; rejects with the refusal (the caller says it where it belongs). */
  const send = (request: StudentWrite, said: string) =>
    write.mutateAsync({ setId: set.id, request }).then(() => toast(said, "success"));
  /** A button's write: a refusal in a toast. */
  const act = (request: StudentWrite, said: string) =>
    void send(request, said).catch((error: unknown) => toast(groupRefusalMessage(error, t), "error"));
  const join = (group: Group) => act(studentWrite.join(group.id), t("sgroups.joined", { group: group.name }));
  const leave = (group: Group) => act(studentWrite.leave(), t("sgroups.left", { group: group.name }));

  const line = set.open
    ? [
        t("sgroups.openUntil", { when: isoDateTime(set.openUntil!) }),
        ...(set.maxSize !== null ? [t("groups.count.max", { n: set.maxSize })] : []),
      ].join(" · ")
    : t("sgroups.closed");

  return (
    <section className="space-y-3" aria-label={set.name}>
      <SectionHeading
        title={set.name}
        help="student-groups"
        description={line}
        actions={
          writable ? (
            <Button variant={primary ? "primary" : "secondary"} onClick={() => setDialog({ kind: "create" })}>
              <Plus /> {t("sgroups.create")}
            </Button>
          ) : null
        }
      />
      {set.open && !writable ? <p className="text-sm text-fg-muted">{t("sgroups.readOnly")}</p> : null}

      {set.open ? (
        <>
          {ordered.length > 0 ? (
            <ul className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {ordered.map((group) => (
                <GroupCard
                  key={group.id}
                  group={group}
                  maxSize={set.maxSize}
                  mine={group.id === myGroupId}
                  actions={
                    !writable ? null : group.id === myGroupId ? (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "rename", group })}>
                          <Pencil /> {t("sgroups.rename")}
                        </Button>
                        <Button variant="secondary" size="sm" disabled={write.isPending} onClick={() => leave(group)}>
                          {t("sgroups.leave")}
                        </Button>
                      </>
                    ) : isFull(group, set.maxSize) ? null : (
                      <Button variant="secondary" size="sm" disabled={write.isPending} onClick={() => join(group)}>
                        {t("sgroups.join")}
                      </Button>
                    )
                  }
                />
              ))}
            </ul>
          ) : null}
          <Unplaced names={view.unplaced ?? []} />
        </>
      ) : mine ? (
        <ul className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <GroupCard group={mine} maxSize={null} mine actions={null} />
        </ul>
      ) : (
        <Card className="px-5 py-4 text-sm text-fg-muted">{t("sgroups.mine.none")}</Card>
      )}

      {dialog ? (
        <NameDialog
          title={dialog.kind === "create" ? t("sgroups.create") : t("sgroups.rename.title")}
          description={dialog.kind === "create" ? t("sgroups.create.desc") : undefined}
          initial={dialog.kind === "create" ? "" : dialog.group.name}
          optional={dialog.kind === "create"}
          submitLabel={dialog.kind === "create" ? t("sgroups.create") : t("sgroups.rename")}
          submit={(name) =>
            dialog.kind === "create"
              ? send(studentWrite.create(name), t("sgroups.created"))
              : send(studentWrite.rename(dialog.group.id, name), t("sgroups.renamed"))
          }
          onClose={() => setDialog(null)}
        />
      ) : null}
    </section>
  );
}

/** One group: its name, its size, its members' names, and the reader's actions on it. */
function GroupCard({
  group,
  maxSize,
  mine,
  actions,
}: {
  group: Group;
  maxSize: number | null;
  mine: boolean;
  actions: ReactNode;
}) {
  const t = useT();
  const full = isFull(group, maxSize);
  return (
    <li className={cx("flex min-w-0 flex-col rounded-card border bg-surface", mine ? "border-line-strong" : "border-line")} aria-label={group.name}>
      <div className="flex min-h-11 items-center gap-2 border-b border-line px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{group.name}</span>
        {mine ? <Badge tone="accent">{t("sgroups.yours")}</Badge> : full ? <Badge tone="zinc">{t("sgroups.full")}</Badge> : null}
        <span
          className="text-[13px] tabular-nums text-fg-faint"
          aria-label={maxSize === null ? t("sgroups.size.free", { n: group.size }) : t("sgroups.size", { n: group.size, max: maxSize })}
        >
          {maxSize === null ? group.size : `${group.size}/${maxSize}`}
        </span>
      </div>
      {group.members.length > 0 ? (
        <ul className="space-y-1 px-4 py-3 text-[13px]">
          {group.members.map((m, i) => (
            <li key={i} className="truncate">
              {studentName(m)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-[13px] text-fg-faint">{t("groups.group.empty")}</p>
      )}
      {actions ? <div className="mt-auto flex flex-wrap justify-end gap-2 border-t border-line px-4 py-2.5">{actions}</div> : null}
    </li>
  );
}

/** The students of the set in no group yet: names only (S4). */
function Unplaced({ names }: { names: GroupMemberName[] }) {
  const t = useT();
  return (
    <Card className="px-4 py-3">
      <p className="flex items-baseline gap-2 text-sm font-semibold">
        {t("sgroups.unplaced")}
        <span className="text-[13px] font-normal tabular-nums text-fg-faint">{names.length}</span>
      </p>
      {names.length > 0 ? (
        <p className="mt-1 text-[13px] text-fg-muted">{names.map(studentName).join(" · ")}</p>
      ) : (
        <p className="mt-1 text-[13px] text-fg-faint">{t("groups.unplaced.empty")}</p>
      )}
    </Card>
  );
}

const NAME_ID = "student-group-name";

/** A group's name: a new group's (optional: the server names it "Group k"), or the reader's own renamed. */
function NameDialog({
  title,
  description,
  initial,
  optional,
  submitLabel,
  submit,
  onClose,
}: {
  title: string;
  description: string | undefined;
  initial: string;
  optional: boolean;
  submitLabel: string;
  submit: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The route's own schema (invariant 7): a name needs a letter or a digit.
  const valid = (optional && name.trim() === "") || GroupName.safeParse(name).success;
  const onSubmit = () => {
    if (!valid) return;
    setPending(true);
    setError(null);
    submit(name.trim()).then(onClose, (e: unknown) => {
      setPending(false);
      setError(groupRefusalMessage(e, t));
    });
  };
  return (
    <FormDialog
      title={title}
      onClose={onClose}
      onSubmit={onSubmit}
      submitLabel={submitLabel}
      submitting={pending}
      canSubmit={valid}
      dense
      error={error ? <p className="text-[13px] text-danger">{error}</p> : null}
    >
      {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
      <Field
        id={NAME_ID}
        label={t("groups.group.name")}
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
    </FormDialog>
  );
}
