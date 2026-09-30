/**
 * The GitHub section of a classroom's Settings (F-GH-02 to F-GH-04,
 * `docs/merge/05-web.md` §5.3, D24).
 *
 * Not connected: one row and "Connect to GitHub", the one accent of the
 * Settings tab (F-ORG-13), which opens the connect sheet — the organizations
 * the App is installed on, the course's own suggested first, and the way to
 * install it on another one. GitHub's setup return raises a `classrooms`
 * hint (M2-02), which refetches both the picker and the link: the sheet
 * turns green without a reload.
 *
 * Connected: the organization, its checks (`checks.ts`), and Disconnect —
 * refused `409 journal_attached` while the classroom has a journal (D28),
 * worded with the way out. Nothing is accented then.
 *
 * Without Quiz's App on the platform the route is absent (404): the section
 * is not drawn at all. Nor while the first answer is awaited — a heading
 * that appears and then vanishes on every classroom of such a platform
 * would be worse than a section that appears late (the header's badge
 * reads the same query, so it is usually in the cache already).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import type { ClassroomDetail, GithubClassroom, GithubConnectBody, GithubOrg } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { classroomGithubKey } from "../queryKeys";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  FormError,
  GithubIcon,
  isoDateParts,
  LEVEL_ICON,
  LinkButton,
  OrgAvatar,
  Progress,
  QueryError,
  RadioRow,
  SectionHeading,
  SettingRow,
  Sheet,
  Skeleton,
} from "../ui";
import { githubAbsent, useClassroomGithub, useGithubOrgs } from "./api";
import { githubChecks, type CheckLine } from "./checks";

export function ClassroomGithub({
  room,
  connecting,
  onConnecting,
}: {
  room: ClassroomDetail;
  /** The connect sheet is open (`?connect=1`: the palette's entry opens it too). */
  connecting: boolean;
  onConnecting: (open: boolean) => void;
}) {
  const t = useT();
  const github = useClassroomGithub(room.id);

  if (github.isLoading || githubAbsent(github.error)) return null;
  let body;
  if (github.isError || !github.data) {
    body = (
      <QueryError
        title={t("github.loadFailed")}
        error={github.error}
        onRetry={() => void github.refetch()}
        retrying={github.isFetching}
        fallback={t("error.server")}
      />
    );
  } else if (github.data.link === null) {
    body = (
      <Card className="px-5">
        <SettingRow title={t("github.notConnected")} desc={t("github.notConnectedDesc")}>
          <Button onClick={() => onConnecting(true)}>
            <GithubIcon /> {t("github.connect")}
          </Button>
        </SettingRow>
      </Card>
    );
  } else {
    body = <Connected room={room} github={github.data} />;
  }

  return (
    <section className="space-y-3">
      <SectionHeading icon={GithubIcon} title={t("github.section")} />
      {body}
      {connecting && github.data && github.data.link === null ? (
        <ConnectSheet room={room} github={github.data} onClose={() => onConnecting(false)} />
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ connected

function Connected({ room, github }: { room: ClassroomDetail; github: GithubClassroom }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const link = github.link!;
  const disconnect = useMutation({
    mutationFn: () => api(`/app/api/classrooms/${room.id}/github`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: classroomGithubKey(room.id) });
      toast(t("github.disconnected"), "success");
    },
  });
  const onDisconnect = async () => {
    if (
      await confirm({
        title: t("github.disconnectConfirm", { name: room.name, login: link.org.login }),
        message: t("github.disconnectBody"),
        confirmLabel: t("github.disconnect"),
        cancelLabel: t("common.cancel"),
        danger: true,
      })
    ) {
      disconnect.mutate();
    }
  };

  return (
    <div className="space-y-3">
      <Card className="divide-y divide-line">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
          <OrgAvatar login={link.org.login} src={link.org.avatarUrl ?? undefined} size="md" />
          <div className="min-w-0 flex-1 basis-40">
            <p className="truncate text-sm font-semibold">{link.org.login}</p>
            <p className="text-[13px] text-fg-muted">
              {t("github.connectedSince", { date: isoDateParts(link.linkedAt).date })}
            </p>
          </div>
          {/* Secondary: once connected, nothing on the tab is accented (F-ORG-13). */}
          <Button variant="secondary" loading={disconnect.isPending} onClick={() => void onDisconnect()}>
            {t("github.disconnect")}
          </Button>
        </div>
        <ul aria-label={t("github.checks")} className="px-5 py-2">
          {githubChecks(link).map((line) => (
            <CheckRow key={line.id} line={line} installUrl={github.installUrl} />
          ))}
        </ul>
      </Card>
      {/* A 409 `journal_attached` reads its way out: remove the journal first (D28). */}
      <FormError error={disconnect.error} title={t("github.disconnectFailed")} />
    </div>
  );
}

function CheckRow({ line, installUrl }: { line: CheckLine; installUrl: string }) {
  const t = useT();
  const { icon: Icon, className } = LEVEL_ICON[line.level];
  return (
    <li className="flex items-start gap-3 py-2 text-sm" data-level={line.level}>
      <span role="img" aria-label={t(`github.level.${line.level}`)} className={cx("mt-0.5 shrink-0", className)}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 text-fg">{t(line.text, line.vars)}</span>
      {line.fixOnGithub ? (
        <a
          href={installUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-accent hover:underline"
        >
          {t("github.check.fix")} <ExternalLink className="size-3.5" />
        </a>
      ) : null}
    </li>
  );
}

// ------------------------------------------------------------------ the connect sheet

/** An organization the classroom can be connected to: the App is on it, and it exists. */
const selectable = (org: GithubOrg) => org.installed && org.status === "active";

function ConnectSheet({
  room,
  github,
  onClose,
}: {
  room: ClassroomDetail;
  github: GithubClassroom;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const orgs = useGithubOrgs();
  const [picked, setPicked] = useState<string | null>(github.suggestedOrgId);
  // What the list held when "Install" was clicked, and when it was read. The
  // `classrooms` hint of the setup return refetches it (M2-02); the first
  // installed organization that was not there is the new installation,
  // picked for the teacher. Once the list has been read again the wait is
  // over, new organization or not: a reinstall on one already listed must
  // not spin forever.
  const [before, setBefore] = useState<{ ids: ReadonlySet<string>; at: number } | null>(null);
  const list = orgs.data ?? [];
  const refetched = before !== null && orgs.dataUpdatedAt > before.at;
  const fresh = refetched ? list.find((o) => selectable(o) && !before.ids.has(o.id)) : undefined;
  const effectivePick = picked ?? fresh?.id ?? null;

  const connect = useMutation({
    mutationFn: (orgId: string) =>
      api<GithubClassroom>(`/app/api/classrooms/${room.id}/github`, {
        method: "PUT",
        body: JSON.stringify({ orgId } satisfies GithubConnectBody),
      }),
    onSuccess: (next) => {
      qc.setQueryData(classroomGithubKey(room.id), next);
      toast(t("github.connected", { login: next.link?.org.login ?? "" }), "success");
      onClose();
    },
  });

  // The course's organization first (F-GH-02); the order of the API otherwise.
  const ordered = [...list].sort(
    (a, b) => Number(b.id === github.suggestedOrgId) - Number(a.id === github.suggestedOrgId),
  );
  const canConnect = effectivePick !== null && list.some((o) => o.id === effectivePick && selectable(o));

  return (
    <Sheet
      title={t("github.connectTitle")}
      subtitle={room.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!canConnect}
            loading={connect.isPending}
            onClick={() => effectivePick && connect.mutate(effectivePick)}
          >
            {t("github.connectSubmit")}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">{t("github.pickOrg")}</legend>
          <p className="text-[13px] text-fg-muted">{t("github.pickOrgHint")}</p>
          {orgs.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : orgs.isError ? (
            <QueryError
              title={t("github.orgsFailed")}
              error={orgs.error}
              onRetry={() => void orgs.refetch()}
              retrying={orgs.isFetching}
              fallback={t("error.server")}
            />
          ) : ordered.length === 0 ? (
            <Card>
              <EmptyState icon={GithubIcon} title={t("github.orgsEmpty")} className="py-8" />
            </Card>
          ) : (
            <Card className="divide-y divide-line overflow-hidden">
              {ordered.map((org) => (
                <OrgOption
                  key={org.id}
                  org={org}
                  suggested={org.id === github.suggestedOrgId}
                  checked={effectivePick === org.id}
                  onPick={setPicked}
                />
              ))}
            </Card>
          )}
          <FormError error={connect.error} title={t("github.connectFailed")} />
        </fieldset>

        <div className="space-y-2 border-t border-line pt-5">
          <p className="text-sm font-semibold">{t("github.installTitle")}</p>
          <p className="text-[13px] text-fg-muted">{t("github.installHint")}</p>
          <LinkButton
            href={github.installUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              setBefore({ ids: new Set(list.filter(selectable).map((o) => o.id)), at: orgs.dataUpdatedAt });
              // The new organization is the one to pick, once it appears.
              setPicked(null);
            }}
          >
            <GithubIcon /> {t("github.install")} <ExternalLink />
          </LinkButton>
          {/* The live status: the `classrooms` hint of the setup return
              refetches the list, and the new organization is picked. */}
          <div aria-live="polite">
            {fresh ? (
              <p className="flex items-center gap-2 text-[13px] text-success">
                <LEVEL_ICON.ok.icon className="size-4" /> {t("github.installedOn", { login: fresh.login })}
              </p>
            ) : before && !refetched ? (
              <Progress label={t("github.waiting")} className="pt-1" />
            ) : null}
          </div>
        </div>
      </div>
    </Sheet>
  );
}

function OrgOption({
  org,
  suggested,
  checked,
  onPick,
}: {
  org: GithubOrg;
  suggested: boolean;
  checked: boolean;
  onPick: (id: string) => void;
}) {
  const t = useT();
  return (
    // `leading-6`: the first line is the avatar's 24 px, so the radio centres on it.
    <RadioRow
      name="github-org"
      value={org.id}
      checked={checked}
      disabled={!selectable(org)}
      onPick={onPick}
      className="px-3 py-2.5 text-sm leading-6"
    >
      <span className="flex items-center gap-3">
        <OrgAvatar login={org.login} src={org.avatarUrl ?? undefined} />
        <span className="min-w-0 flex-1 truncate font-medium">{org.login}</span>
        {suggested ? <Badge tone="zinc">{t("github.suggested")}</Badge> : null}
        {org.status === "deleted" ? (
          <Badge tone="red">{t("github.org.deleted")}</Badge>
        ) : !org.installed ? (
          <Badge tone="amber">{t("github.org.notInstalled")}</Badge>
        ) : null}
      </span>
    </RadioRow>
  );
}
