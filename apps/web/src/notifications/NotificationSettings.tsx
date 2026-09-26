import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { useEffect } from "react";

import {
  NOTIFICATION_CHANNELS,
  notificationKindsFor,
  type Me,
  type NotificationChannel,
  type NotificationKind,
  type NotificationPreferencePut,
  type NotificationSettings,
  type TeamsConnectStart,
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
  QueryError,
  SectionHeading,
  SettingRow,
  Skeleton,
  Switch,
} from "../ui";

/**
 * Where each kind of notification reaches this account (ADR-030): a grid of
 * kinds × channels, then the channels themselves — the e-mail address, which
 * needs nothing, and Microsoft Teams, which needs one "Connect" at Microsoft.
 *
 * The grid lists the kinds the account's role receives (a student is only
 * ever told of a released result). The Teams column is there only when the
 * platform has Teams at all, and its switches wait for the link: the
 * preference is kept, and says "on" by default, but a switch that moves
 * nothing would lie.
 */

const SETTINGS_URL = "/app/api/notifications/settings";

type TKey = Parameters<ReturnType<typeof useT>>[0];

/** `?teams=linked|error`, the landing of the Microsoft round trip: said once, then dropped. */
function useTeamsOutcome() {
  const t = useT();
  const toast = useToast();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("teams");
    if (outcome !== "linked" && outcome !== "error") return;
    if (outcome === "linked") toast(t("settings.teams.linkedToast"), "success");
    else toast(t("settings.teams.errorToast"), "error");
    params.delete("teams");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [t, toast]);
}

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

function TeamsRow({ settings }: { settings: NotificationSettings }) {
  const t = useT();
  const toast = useToast();
  const toastError = useErrorToast();
  const qc = useQueryClient();
  const connect = useMutation({
    mutationFn: () =>
      api<TeamsConnectStart>("/app/api/notifications/teams/connect", { method: "POST" }),
    // The rest of the flow is Microsoft's page, then the callback, then back
    // here with `?teams=linked`.
    onSuccess: ({ url }) => window.location.assign(url),
    onError: toastError("settings.teams.errorToast"),
  });
  const disconnect = useMutation({
    mutationFn: () =>
      api<NotificationSettings>("/app/api/notifications/teams", { method: "DELETE" }),
    onSuccess: (next) => {
      qc.setQueryData(notificationSettingsKey, next);
      toast(t("settings.teams.unlinkedToast"), "success");
    },
    onError: toastError("error.save"),
  });
  const { available, linkedAt } = settings.teams;
  const desc = !available
    ? t("settings.teams.unavailable")
    : linkedAt
      ? t("settings.teams.linked", { date: isoDateTime(linkedAt) })
      : t("settings.teams.off");
  return (
    <SettingRow title={t("settings.teams.title")} desc={desc}>
      {!available ? null : linkedAt ? (
        <Button variant="secondary" size="sm" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
          {t("settings.teams.disconnect")}
        </Button>
      ) : (
        <Button variant="secondary" size="sm" loading={connect.isPending} onClick={() => connect.mutate()}>
          {t("settings.teams.connect")}
        </Button>
      )}
    </SettingRow>
  );
}

export function NotificationSettingsSection({ me }: { me: Me }) {
  const t = useT();
  const qc = useQueryClient();
  useTeamsOutcome();
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
        <QueryError
          title={t("settings.notifications")}
          error={settings.error}
          onRetry={() => void settings.refetch()}
          retrying={settings.isFetching}
        />
      ) : (
        <>
          <Card>
            <ChannelGrid
              settings={settings.data}
              kinds={notificationKindsFor(me.role)}
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
