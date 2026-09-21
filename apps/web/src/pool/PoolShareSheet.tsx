import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Lock, Trash2, UserPlus, Users } from "lucide-react";
import { useState } from "react";

import type {
  PoolMember,
  PoolMembers,
  PoolRole,
  PoolSummary,
  PoolVisibility,
} from "@quiz/contracts";

import { api, ApiError, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useT, type TFunction } from "../i18n";
import { useToast } from "../notify";
import {
  Button,
  Field,
  IconButton,
  Initials,
  QueryError,
  Segmented,
  Select,
  SettingRow,
  Sheet,
  Skeleton,
} from "../ui";

/**
 * Who may read and write a pool (F-POOL-05), in one sheet: the visibility of
 * the pool, the accounts that hold a seat on it, and the row that adds one.
 *
 * Only an owner opens it, so every control here is live — a sheet whose
 * halves are half disabled is a screen that should not have opened. The one
 * primary action is "Invite": the visibility and the roles are settings that
 * save as they are touched, and the footer only holds the way out.
 */

const VISIBILITY_ICON = { private: Lock, shared: Users, public: Globe } as const;

/**
 * The invite errors the API names (`teacher_not_found`, and the 409 of a seat
 * that already exists). Anything else keeps the server's own sentence.
 */
function inviteMessage(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: string } | null)?.error;
    if (code === "teacher_not_found" || error.status === 404) return t("share.notFound");
    if (error.status === 409) return t("share.already");
  }
  return apiErrorMessage(error, t("error.save"));
}

function MemberRow({
  poolId,
  member,
  onBusy,
}: {
  poolId: string;
  member: PoolMember;
  onBusy: (error: unknown) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ["pool-members", poolId];
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
            <option value="reader">{t("share.role.reader")}</option>
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
                cancelLabel: t("common.cancel"),
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

export function PoolShareSheet({ pool, onClose }: { pool: PoolSummary; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["pool-members", pool.id];
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PoolRole>("reader");

  const members = useQuery<PoolMembers>({
    queryKey: key,
    queryFn: () => api(`/app/api/pools/${pool.id}/members`),
  });

  const setVisibility = useMutation({
    mutationFn: (visibility: PoolVisibility) =>
      api(`/app/api/pools/${pool.id}`, {
        method: "PATCH",
        body: JSON.stringify({ visibility }),
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["pools"] }),
        qc.invalidateQueries({ queryKey: key }),
      ]);
    },
    onError: (error) => toast(apiErrorMessage(error, t("error.save")), "error"),
  });

  const invite = useMutation({
    mutationFn: () =>
      api(`/app/api/pools/${pool.id}/members`, {
        method: "POST",
        body: JSON.stringify({ email: email.trim().toLowerCase(), role }),
      }),
    onSuccess: async () => {
      setEmail("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: key }),
        qc.invalidateQueries({ queryKey: ["pools"] }),
      ]);
    },
  });

  // The visibility the sheet draws: what the members call answered, and the
  // summary the list already had while it loads.
  const visibility = members.data?.visibility ?? pool.visibility;
  const rows = members.data?.members ?? [];

  return (
    <Sheet title={t("share.title")} subtitle={pool.name} onClose={onClose}>
      <div className="space-y-6">
        <section>
          <SettingRow
            className="pt-0"
            title={t("share.visibility")}
            desc={t(`share.visibility.${visibility}.help`)}
          >
            <Segmented
              name="pool-visibility"
              value={visibility}
              disabled={setVisibility.isPending}
              onChange={(v) => setVisibility.mutate(v)}
              options={(["private", "shared", "public"] as const).map((v) => {
                const Icon = VISIBILITY_ICON[v];
                return {
                  value: v,
                  label: (
                    <span className="flex items-center gap-1.5">
                      <Icon className="size-3.5" />
                      {t(`share.visibility.${v}`)}
                    </span>
                  ),
                };
              })}
            />
          </SettingRow>
        </section>

        <section>
          <h3 className="text-sm font-semibold">{t("share.members")}</h3>
          {members.isLoading ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : members.isError ? (
            <div className="mt-3">
              <QueryError
                title={t("share.members")}
                error={members.error}
                onRetry={() => void members.refetch()}
                retrying={members.isFetching}
              />
            </div>
          ) : (
            <div className="mt-1">
              {rows.map((m) => (
                <MemberRow
                  key={m.userId}
                  poolId={pool.id}
                  member={m}
                  onBusy={(error) => toast(apiErrorMessage(error, t("error.save")), "error")}
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
        </section>

        <section className="border-t border-line pt-5">
          <h3 className="text-sm font-semibold">{t("share.invite")}</h3>
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim() !== "") invite.mutate();
            }}
          >
            <Field
              type="email"
              width="min-w-0 flex-1 basis-56"
              label={t("share.email")}
              placeholder="prenom.nom@heig-vd.ch"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Select
              width="w-33"
              label={t("share.roleLabel")}
              value={role}
              onChange={(e) => setRole(e.target.value as PoolRole)}
            >
              <option value="reader">{t("share.role.reader")}</option>
              <option value="contributor">{t("share.role.contributor")}</option>
              <option value="owner">{t("share.role.owner")}</option>
            </Select>
            <Button type="submit" loading={invite.isPending} disabled={email.trim() === ""}>
              <UserPlus /> {t("share.inviteAction")}
            </Button>
          </form>
          {invite.isError ? (
            <p className="mt-2 text-[13px] text-danger">{inviteMessage(invite.error, t)}</p>
          ) : null}
        </section>
      </div>
    </Sheet>
  );
}
