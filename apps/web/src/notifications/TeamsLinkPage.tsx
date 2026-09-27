import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Link2, MessagesSquare, TriangleAlert } from "lucide-react";

import { TeamsLinkToken, type Me, type NotificationSettings, type TeamsLinkPreview } from "@quiz/contracts";
import { displayName } from "@quiz/domain";

import { api, ApiError } from "../api";
import { useT } from "../i18n";
import { notificationSettingsKey, teamsLinkKey } from "../queryKeys";
import { SignInGate } from "../SignInGate";
import { Alert, Button, Card, FormError, GateFrame, Skeleton } from "../ui";

/**
 * The Teams link page (ADR-030). The HEIG Quiz bot's card in Teams opens it
 * with a one-time token in `?token=`; the page shows which Teams account —
 * and which Microsoft 365 organization — the token stands for, and asks ONE
 * question: link it to this Quiz account? ONE primary action, Link.
 *
 * Signed out, it offers the sign-in and comes back here with the same URL.
 * An expired, spent or missing token is one state, whose way out is in
 * Teams: any message to the bot brings a new card.
 *
 * The token travels to the API in a request BODY, never in a path, and
 * leaves the address bar once spent; the request log masks it (`redact.ts`).
 */
export function TeamsLinkPage({ me, onSettings }: { me: Me | null; onSettings?: () => void }) {
  const t = useT();
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  if (!TeamsLinkToken.safeParse(token).success) return <Invalid />;
  if (!me) {
    return (
      <SignInGate
        next={`/teams/link?token=${token}`}
        header={<MessagesSquare className="mx-auto size-8 text-fg-muted" />}
        title={t("teamsLink.signIn.title")}
        body={t("teamsLink.signIn.body")}
        action={t("teamsLink.signIn.action")}
      />
    );
  }
  return <Confirm token={token} me={me} onSettings={onSettings} />;
}

function Invalid() {
  const t = useT();
  return (
    <GateFrame>
      <Card className="px-6 py-8 text-center">
        <TriangleAlert className="mx-auto size-8 text-warning" />
        <h1 className="mt-3 text-lg font-bold tracking-tight">{t("teamsLink.invalid.title")}</h1>
        <p className="mt-2 text-sm text-fg-muted">{t("teamsLink.invalid.body")}</p>
      </Card>
    </GateFrame>
  );
}

function Confirm({ token, me, onSettings }: { token: string; me: Me; onSettings?: (() => void) | undefined }) {
  const t = useT();
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: teamsLinkKey(token),
    queryFn: () =>
      api<TeamsLinkPreview>("/app/api/notifications/teams/link/preview", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    retry: false,
  });
  const link = useMutation({
    mutationFn: () =>
      api<NotificationSettings>("/app/api/notifications/teams/link", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    onSuccess: (settings) => {
      qc.setQueryData(notificationSettingsKey, settings);
      // Spent: nothing left worth keeping in the address bar or the history.
      window.history.replaceState(null, "", window.location.pathname);
    },
  });

  if (link.isSuccess) {
    return (
      <GateFrame>
        <Card className="px-6 py-8 text-center">
          <CircleCheck className="mx-auto size-8 text-success" />
          <h1 className="mt-3 text-lg font-bold tracking-tight">{t("teamsLink.done.title")}</h1>
          <p className="mt-2 text-sm text-fg-muted">{t("teamsLink.done.body")}</p>
          <Button
            variant="secondary"
            className="mt-6"
            onClick={() => (onSettings ? onSettings() : window.location.assign("/settings"))}
          >
            {t("teamsLink.done.settings")}
          </Button>
        </Card>
      </GateFrame>
    );
  }
  if (preview.isPending) {
    return (
      <GateFrame>
        <Card className="space-y-3 px-6 py-8">
          <Skeleton className="mx-auto h-6 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </Card>
      </GateFrame>
    );
  }
  const gone = (error: unknown) => error instanceof ApiError && error.status === 404;
  if (gone(preview.error) || gone(link.error)) return <Invalid />;
  if (preview.isError) {
    return (
      <GateFrame>
        <Card className="px-6 py-8 text-center">
          <TriangleAlert className="mx-auto size-8 text-warning" />
          <h1 className="mt-3 text-lg font-bold tracking-tight">{t("error.server")}</h1>
        </Card>
      </GateFrame>
    );
  }

  const p = preview.data;
  const name = displayName(me);
  const account = name === me.email ? me.email : `${name} (${me.email})`;
  const until = new Date(p.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const rows: [string, string][] = [
    [t("teamsLink.teams"), p.teamsName],
    [t("teamsLink.tenant"), p.tenantId],
    [t("teamsLink.quiz"), account],
  ];
  return (
    <GateFrame>
      <Card className="px-6 py-8">
        <div className="text-center">
          <span className="inline-flex rounded-full bg-accent-soft p-3">
            <Link2 className="size-6 text-accent" />
          </span>
          <h1 className="mt-3 text-lg font-bold tracking-tight">{t("teamsLink.title")}</h1>
        </div>
        <dl className="mt-5 divide-y divide-line rounded-lg border border-line text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="px-4 py-2.5">
              <dt className="text-xs text-fg-muted">{label}</dt>
              <dd className="mt-0.5 font-semibold break-words">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-center text-sm text-fg-muted">{t("teamsLink.to")}</p>
        <div className="mt-4">
          <Alert tone="warning" icon={TriangleAlert}>
            {t("teamsLink.warning")}
          </Alert>
        </div>
        <FormError error={link.error} />
        <Button size="lg" className="mt-6 w-full" loading={link.isPending} onClick={() => link.mutate()}>
          {t("teamsLink.action")}
        </Button>
        <p className="mt-4 text-center text-xs text-fg-faint">{t("teamsLink.notYou", { time: until })}</p>
      </Card>
    </GateFrame>
  );
}
