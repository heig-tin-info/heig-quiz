import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, UserPlus, Users } from "lucide-react";
import { useState } from "react";

import {
  type Pool,
  type TeacherCandidate,
  type PoolMember,
  type PoolMemberInvite,
  type PoolMembers,
  type PoolRole,
} from "@quiz/contracts";

import { api, ApiError, apiErrorMessage, isNotFound, refusedWith } from "../api";
import { useConfirm } from "../confirm";
import { useT, type TFunction } from "../i18n";
import { useErrorToast } from "../notify";
import { TeacherPicker, useTeacherPick } from "../TeacherPicker";
import {
  Button,
  Card,
  ErrorText,
  IconButton,
  Initials,
  QueryError,
  SectionHeading,
  Select,
  SettingRow,
  Skeleton,
  Switch,
} from "../ui";
import { poolCandidatesKey, poolKey, poolMembersKey, poolsKey } from "../queryKeys";

/**
 * Who may read and write a pool (F-POOL-05), in the pool's Settings tab: the
 * one switch that publishes it in the catalogue, the accounts that hold a
 * seat on it, the courses whose staff can edit it (read-only) and the row
 * that adds a seat.
 *
 * The visibility the pool WEARS (private, shared, public) is derived from
 * who has access (ADR-013, amendment of 2026-10-10): there is no control for
 * it, and no button that evicts members — a pool becomes private when its
 * people are removed. A public pool is already readable by every teacher, so
 * it offers contributor and owner only; reader seats already there stay,
 * marked as covered.
 *
 * Only an owner is shown it, so every control here is live — a section whose
 * halves are disabled is a section that should not have been drawn. The
 * switch and the roles are settings that save as they are touched;
 * "Invite" is the one button that sends anything, and it stays `secondary`:
 * a settings tab has no primary.
 *
 * The invitee is picked by name among the colleagues (`TeacherPicker`). An
 * address the picker does not list may still be typed and sent as such: the
 * API resolves it over every address of an account (GH-11), which is how an
 * alias reaches a teacher the list shows under another spelling.
 */

/**
 * The invite errors the API names (`teacher_not_found`, and the 409 of a seat
 * that already exists). Anything else keeps the server's own sentence.
 */
function inviteMessage(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    if (refusedWith(error, "teacher_not_found") || isNotFound(error)) return t("share.notFound");
    if (error.status === 409) return t("share.already");
  }
  return apiErrorMessage(error, t("error.save"));
}

function MemberRow({
  poolId,
  member,
  isPublic,
  onBusy,
}: {
  poolId: string;
  member: PoolMember;
  isPublic: boolean;
  onBusy: (error: unknown) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = poolMembersKey(poolId);
  const name = `${member.givenName} ${member.familyName}`.trim() || member.email;

  const setRole = useMutation({
    mutationFn: (role: PoolRole) =>
      api(`/app/api/pools/${poolId}/members/${member.userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: onBusy,
  });
  const remove = useMutation({
    mutationFn: () =>
      api(`/app/api/pools/${poolId}/members/${member.userId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: onBusy,
  });

  return (
    <div className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
      <Initials name={[member.givenName, member.familyName]} className="size-8 text-xs" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-xs text-fg-muted">{member.email}</span>
      </span>
      {member.isOwner ? (
        // The account the pool belongs to: its seat is the pool's own row, so
        // it is stated, not offered as a choice.
        <span className="shrink-0 text-[13px] text-fg-muted">{t("share.role.owner")}</span>
      ) : (
        <>
          <Select
            size="sm"
            width="w-33"
            aria-label={t("share.roleOf", { name })}
            value={member.role}
            disabled={setRole.isPending}
            onChange={(e) => setRole.mutate(e.target.value as PoolRole)}
          >
            {/* A reader row on a public pool stays, but is no longer offered. */}
            {!isPublic || member.role === "reader" ? (
              <option value="reader">
                {isPublic ? t("share.role.readerCovered") : t("share.role.reader")}
              </option>
            ) : null}
            <option value="contributor">{t("share.role.contributor")}</option>
            <option value="owner">{t("share.role.owner")}</option>
          </Select>
          <IconButton
            danger
            label={t("share.remove", { name })}
            disabled={remove.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: t("share.remove", { name }),
                message: t("share.removeConfirm", { name }),
                confirmLabel: t("common.delete"),
                danger: true,
              });
              if (ok) remove.mutate();
            }}
          >
            <Trash2 />
          </IconButton>
        </>
      )}
    </div>
  );
}

export function PoolSharing({ pool }: { pool: Pool }) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const key = poolMembersKey(pool.id);
  const who = useTeacherPick();
  const [role, setRole] = useState<PoolRole>("reader");
  const canInvite = who.choice !== null;

  const members = useQuery<PoolMembers>({
    queryKey: key,
    queryFn: () => api(`/app/api/pools/${pool.id}/members`),
  });

  const setPublic = useMutation({
    mutationFn: (isPublic: boolean) =>
      api(`/app/api/pools/${pool.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isPublic }),
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: poolsKey }),
        qc.invalidateQueries({ queryKey: poolKey(pool.id) }),
        qc.invalidateQueries({ queryKey: key }),
      ]);
    },
    onError: toastError("error.save"),
  });

  const invite = useMutation({
    mutationFn: () => {
      const body: PoolMemberInvite = { ...who.choice!, role: pickedRole };
      return api(`/app/api/pools/${pool.id}/members`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: async () => {
      who.reset();
      await Promise.all([
        qc.invalidateQueries({ queryKey: key }),
        qc.invalidateQueries({ queryKey: poolsKey }),
        qc.invalidateQueries({ queryKey: poolKey(pool.id) }),
        // The newcomer leaves the list of who may still be invited.
        qc.invalidateQueries({ queryKey: poolCandidatesKey(pool.id) }),
      ]);
    },
  });

  // What the sheet draws: what the members call answered, and the summary
  // the list already had while it loads.
  const visibility = members.data?.visibility ?? pool.visibility;
  const isPublic = members.data?.isPublic ?? pool.isPublic;
  const rows = members.data?.members ?? [];
  const courses = members.data?.courses ?? [];
  // A public pool is already readable: a new seat is a contributor or an owner.
  const pickedRole: PoolRole = isPublic && role === "reader" ? "contributor" : role;

  return (
    <section className="space-y-3">
      <SectionHeading icon={Users} title={t("share.title")} />
      <Card className="divide-y divide-line px-5">
        <SettingRow
          title={t("share.publish")}
          desc={
            pool.isPersonal
              ? t("share.publish.personal")
              : `${t("share.publish.help")} ${t(`share.visibility.${visibility}.help`)}`
          }
        >
          <Switch
            checked={isPublic}
            disabled={pool.isPersonal || setPublic.isPending}
            onChange={(v) => setPublic.mutate(v)}
            label={t("share.publish")}
          />
        </SettingRow>

        <div className="py-3">
          <h3 className="text-sm font-medium">{t("share.members")}</h3>
          {members.isLoading ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : members.isError ? (
            <div className="mt-3">
              <QueryError title={t("share.members")} query={members} />
            </div>
          ) : (
            <div className="mt-1">
              {rows.map((m) => (
                <MemberRow
                  key={m.userId}
                  poolId={pool.id}
                  member={m}
                  isPublic={isPublic}
                  onBusy={toastError("error.save")}
                />
              ))}
              {rows.filter((m) => !m.isOwner).length === 0 ? (
                <p className="border-t border-line pt-3 text-sm text-fg-muted">
                  {t("share.membersEmpty")}
                </p>
              ) : null}
            </div>
          )}
          {/* The succession rule, where the consequence of the roles is:
              a pool never becomes an orphan, and the order of this very
              list is what decides who inherits it. */}
          <p className="mt-3 text-xs text-fg-faint">{t("share.succession")}</p>
        </div>

        {courses.length > 0 ? (
          <div className="py-3">
            <h3 className="text-sm font-medium">{t("share.courses")}</h3>
            <p className="mt-0.5 text-xs text-fg-muted">{t("share.courses.help")}</p>
            <ul className="mt-2">
              {courses.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-3 border-t border-line py-2.5 text-sm first:border-t-0"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{c.name}</span>{" "}
                    <span className="text-xs text-fg-muted">{c.code}</span>
                  </span>
                  <span className="shrink-0 text-[13px] text-fg-muted">{t("share.courses.canEdit")}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="py-4">
          <h3 className="text-sm font-medium">{t("share.invite")}</h3>
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (canInvite) invite.mutate();
            }}
          >
            <TeacherPicker
              candidatesKey={poolCandidatesKey(pool.id)}
              candidatesUrl={`/app/api/pools/${pool.id}/candidates`}
              label={t("share.teacher")}
              everyoneSeated={t("share.everyoneSeated")}
              disabled={invite.isPending}
              {...who.picker}
            />
            <Select
              width="w-33"
              label={t("share.roleLabel")}
              value={pickedRole}
              onChange={(e) => setRole(e.target.value as PoolRole)}
            >
              {isPublic ? null : <option value="reader">{t("share.role.reader")}</option>}
              <option value="contributor">{t("share.role.contributor")}</option>
              <option value="owner">{t("share.role.owner")}</option>
            </Select>
            <Button
              type="submit"
              variant="secondary"
              loading={invite.isPending}
              disabled={!canInvite}
            >
              <UserPlus /> {t("share.inviteAction")}
            </Button>
          </form>
          {invite.isError ? (
            <ErrorText className="mt-2">{inviteMessage(invite.error, t)}</ErrorText>
          ) : null}
        </div>
      </Card>
    </section>
  );
}
