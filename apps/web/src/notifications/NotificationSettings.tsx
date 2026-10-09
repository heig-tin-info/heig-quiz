import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";

import {
  kindChannels,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationKind,
  type NotificationPreferencePut,
  type NotificationSettings,
} from "@quiz/contracts";

import { api } from "../api";
import { useErrorToast, useToast } from "../notify";
import { useT } from "../i18n";
import { notificationSettingsKey } from "../queryKeys";
import {
  Button,
  Card,
  FormError,
  isoDateTime,
  LinkButton,
  QueryError,
  SectionHeading,
  SettingRow,
  Skeleton,
  Switch,
} from "../ui";

/**
 * Where each kind of notification reaches this account (ADR-030): a grid of
 * kinds × channels, then the channels themselves — the e-mail address, which
 * needs nothing, and Microsoft Teams, which needs the HEIG Quiz app uploaded
 * into the user's Teams and linked from its tab (`TeamsTabPage`, then the
 * link page, `TeamsLinkPage`). Notifications arrive in the activity feed.
 *
 * The grid lists the server's `kinds`: the kinds this account can receive
 * (`notificationKindsFor`, #277). The Teams column is there only when the
 * platform has Teams at all, and its switches wait for the link: the
 * preference is kept, and says "on" by default, but a switch that moves
 * nothing would lie.
 */

const SETTINGS_URL = "/app/api/notifications/settings";

type TKey = Parameters<ReturnType<typeof useT>>[0];

function ChannelGrid({
  settings,
  kinds,
  onToggle,
  pending,
}: {
  settings: NotificationSettings;
  kinds: NotificationKind[];
  onToggle: (pref: NotificationPreferencePut) => void;
  pending: boolean;
}) {
  const t = useT();
  const channels = NOTIFICATION_CHANNELS.filter((c) => c !== "teams" || settings.teams.available);
  const teamsLinked = settings.teams.linkedAt !== null;
  const columns = { gridTemplateColumns: `minmax(0, 1fr) repeat(${channels.length}, 3.5rem)` };
  const label = (c: NotificationChannel) => t(`settings.channel.${c}` as TKey);
  return (
    <div role="table" aria-label={t("settings.notifications")} className="px-5 py-2">
      <div role="row" className="grid items-end gap-x-2 border-b border-line pb-2" style={columns}>
        {/* A real grid cell holding the hidden label: `sr-only` on the cell
            itself would take it out of the flow and shift every heading left. */}
        <span role="columnheader">
          <span className="sr-only">{t("settings.notifications")}</span>
        </span>
        {channels.map((c) => (
          <span
            key={c}
            role="columnheader"
            className="text-center text-xs font-medium text-fg-muted"
            title={c === "teams" && !teamsLinked ? t("settings.teams.needsLink") : undefined}
          >
            {label(c)}
          </span>
        ))}
      </div>
      {kinds.map((kind) => (
        <div
          key={kind}
          role="row"
          className="grid items-center gap-x-2 border-b border-line py-3 last:border-b-0"
          style={columns}
        >
          <div role="rowheader" className="min-w-0">
            <p className="text-sm font-medium text-fg">{t(`settings.kind.${kind}` as TKey)}</p>
            <p className="mt-0.5 text-[13px] text-fg-muted">{t(`settings.kind.${kind}.desc` as TKey)}</p>
          </div>
          {channels.map((channel) => {
            // A channel the kind never uses (`KIND_CHANNELS`): no toggle, a dash.
            if (!kindChannels(kind).includes(channel)) {
              return (
                <div key={channel} role="cell" className="flex justify-center text-fg-faint">
                  <span aria-hidden="true">—</span>
                  <span className="sr-only">{t("settings.channel.none")}</span>
                </div>
              );
            }
            const waiting = channel === "teams" && !teamsLinked;
            const on = settings.matrix[kind][channel] && !waiting;
            return (
              <div key={channel} role="cell" className="flex justify-center">
                <Switch
                  checked={on}
                  disabled={pending || waiting}
                  onChange={(enabled) => onToggle({ kind, channel, enabled })}
                  label={t("settings.channel.cell", {
                    kind: t(`settings.kind.${kind}` as TKey),
                    channel: label(channel),
                  })}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Where the platform serves the Teams app package (ADR-030). */
const TEAMS_APP_URL = "/app/api/notifications/teams/app.zip";

function TeamsRow({ settings }: { settings: NotificationSettings }) {
  const t = useT();
  const toast = useToast();
  const toastError = useErrorToast();
  const qc = useQueryClient();
  const disconnect = useMutation({
    mutationFn: () =>
      api<NotificationSettings>("/app/api/notifications/teams", { method: "DELETE" }),
    onSuccess: (next) => {
      qc.setQueryData(notificationSettingsKey, next);
      toast(t("settings.teams.unlinkedToast"), "success");
    },
    onError: toastError("error.save"),
  });
  const { available, linkedAt, teamsName, teamsUsername } = settings.teams;
  if (!available) {
    return <SettingRow title={t("settings.teams.title")} desc={t("settings.teams.unavailable")} />;
  }
  if (linkedAt) {
    return (
      <SettingRow
        title={t("settings.teams.title")}
        desc={t("settings.teams.linked", {
          name: teamsUsername && teamsUsername !== teamsName ? `${teamsName ?? ""} (${teamsUsername})` : (teamsName ?? ""),
          date: isoDateTime(linkedAt),
        })}
      >
        <Button variant="secondary" size="sm" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
          {t("settings.teams.disconnect")}
        </Button>
      </SettingRow>
    );
  }
  // Not linked: the package to upload, and the three steps that follow in
  // Teams. The link itself is confirmed on the page the app's tab opens.
  return (
    <div className="pb-3">
      <SettingRow title={t("settings.teams.title")} desc={t("settings.teams.off")}>
        <LinkButton size="sm" href={TEAMS_APP_URL} download="heig-quiz-teams.zip">
          {t("settings.teams.download")}
        </LinkButton>
      </SettingRow>
      <p className="text-xs font-medium text-fg-muted">{t("settings.teams.steps")}</p>
      <ol className="mt-1 list-decimal space-y-1 pl-5 text-[13px] text-fg-muted">
        <li>{t("settings.teams.step1")}</li>
        <li>{t("settings.teams.step2")}</li>
        <li>{t("settings.teams.step3")}</li>
      </ol>
    </div>
  );
}

export function NotificationSettingsSection() {
  const t = useT();
  const qc = useQueryClient();
  const settings = useQuery<NotificationSettings>({
    queryKey: notificationSettingsKey,
    queryFn: () => api(SETTINGS_URL),
  });
  const toggle = useMutation({
    mutationFn: (pref: NotificationPreferencePut) =>
      api<NotificationSettings>("/app/api/notifications/preferences", {
        method: "PUT",
        body: JSON.stringify(pref),
      }),
    // The switch moves at once; the answer (the whole settings) then stands.
    onMutate: (pref) => {
      const before = qc.getQueryData<NotificationSettings>(notificationSettingsKey);
      if (before) {
        qc.setQueryData<NotificationSettings>(notificationSettingsKey, {
          ...before,
          matrix: {
            ...before.matrix,
            [pref.kind]: { ...before.matrix[pref.kind], [pref.channel]: pref.enabled },
          },
        });
      }
      return { before };
    },
    onError: (_err, _pref, context) => {
      if (context?.before) qc.setQueryData(notificationSettingsKey, context.before);
    },
    onSuccess: (next) => qc.setQueryData(notificationSettingsKey, next),
  });

  return (
    <section className="space-y-3">
      <SectionHeading icon={BellRing} title={t("settings.notifications")} description={t("settings.notificationsHint")} />
      {settings.isLoading ? (
        <Card className="space-y-3 p-5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/5" />
        </Card>
      ) : settings.isError || !settings.data ? (
        <QueryError title={t("settings.notifications")} query={settings} />
      ) : (
        <>
          <Card>
            <ChannelGrid
              settings={settings.data}
              kinds={settings.data.kinds}
              onToggle={(pref) => toggle.mutate(pref)}
              pending={toggle.isPending}
            />
          </Card>
          <FormError error={toggle.error} fallback={t("error.save")} />
          <Card className="divide-y divide-line px-5">
            <SettingRow
              title={t("settings.email.title")}
              desc={t("settings.email.desc", { email: settings.data.email })}
            />
            <TeamsRow settings={settings.data} />
          </Card>
        </>
      )}
    </section>
  );
}
