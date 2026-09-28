import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, ExternalLink, Link2, MessagesSquare, ShieldAlert, TriangleAlert } from "lucide-react";

import { TeamsTabState, TeamsTabTarget } from "@quiz/contracts";

import { api, ApiError } from "../api";
import { useT } from "../i18n";
import { teamsHostKey, teamsTabKey } from "../queryKeys";
import { routeToPath, type Route } from "../router";
import { Button, Card, GateFrame, Skeleton } from "../ui";
import { connectTeams, type TeamsHost } from "./teamsHost";

/**
 * The HEIG Quiz tab inside Microsoft Teams (ADR-030), `/teams`, the
 * manifest's `contentUrl`. It renders with NO Quiz session: Teams frames it,
 * and the platform's cookies (SameSite=Lax) do not follow into the frame.
 * Who the user is comes from Teams itself — the SSO token, sent to
 * `POST /app/api/notifications/teams/tab` — and anything that needs the
 * Quiz session opens in the system browser.
 *
 * ONE primary action per state: link (not linked yet), or open the page a
 * notification leads to (linked, opened from the activity feed). The target
 * of a notification is the tab's `subEntityId`, parsed by `TeamsTabTarget`
 * and turned into a path by the router — never a URL taken as is.
 */
export function TeamsTabPage({ connect = connectTeams }: { connect?: () => Promise<TeamsHost | null> }) {
  const host = useQuery({ queryKey: teamsHostKey, queryFn: connect, retry: false, staleTime: Infinity });
  if (host.isPending) return <Loading />;
  if (!host.data) return <Outside />;
  return <InTeams host={host.data} />;
}

/** The page a notification leads to, or null when the tab was opened from the app bar. */
export function tabTargetRoute(subPageId: string | undefined): Route | null {
  if (!subPageId) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(subPageId);
  } catch {
    return null;
  }
  const target = TeamsTabTarget.safeParse(raw);
  if (!target.success) return null;
  return target.data.kind === "feedback"
    ? { view: "feedback", attemptId: target.data.attemptId }
    : { view: "pool", id: target.data.poolId };
}

/** Why the tab could not ask the server: Teams gave no token, or the server refused. */
class SsoFailure extends Error {}

function InTeams({ host }: { host: TeamsHost }) {
  const t = useT();
  const state = useQuery({
    queryKey: teamsTabKey,
    retry: false,
    queryFn: async () => {
      let token: string;
      try {
        token = await host.getAuthToken();
      } catch (err) {
        // Teams' own error code ("resourceRequiresConsent", …): what support needs.
        throw new SsoFailure(err instanceof Error ? err.message : String(err));
      }
      const answer = await api<unknown>("/app/api/notifications/teams/tab", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      return TeamsTabState.parse(answer);
    },
  });
  const retry = (
    <Button variant="secondary" className="mt-6" loading={state.isFetching} onClick={() => void state.refetch()}>
      {t("teamsTab.retry")}
    </Button>
  );

  if (state.isPending) return <Loading />;
  if (state.isError) {
    const err = state.error;
    if (err instanceof ApiError && err.status === 403) {
      return (
        <Frame icon={<ShieldAlert className="mx-auto size-8 text-warning" />} title={t("teamsTab.refused.title")}>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t("teamsTab.refused.body")}</p>
        </Frame>
      );
    }
    const code = err instanceof SsoFailure ? err.message : err instanceof ApiError ? `HTTP ${err.status}` : err.message;
    const sso = err instanceof SsoFailure || (err instanceof ApiError && err.status === 401);
    return (
      <Frame
        icon={<TriangleAlert className="mx-auto size-8 text-warning" />}
        title={sso ? t("teamsTab.sso.title") : t("error.server")}
      >
        {sso ? <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t("teamsTab.sso.body")}</p> : null}
        <p className="mt-2 font-mono text-xs break-all text-fg-muted">{code.slice(0, 200)}</p>
        {retry}
      </Frame>
    );
  }

  const open = (path: string) => void host.openLink(`${window.location.origin}${path}`);
  const data = state.data;
  if (data.state === "unlinked") {
    return (
      <Frame icon={<Badge icon={Link2} />} title={t("teamsTab.unlinked.title")}>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t("teamsTab.unlinked.body")}</p>
        <Button size="lg" className="mt-6 w-full" onClick={() => void host.openLink(data.linkUrl)}>
          {t("teamsTab.unlinked.action")}
        </Button>
        <p className="mt-3 text-xs text-fg-faint">{t("teamsTab.unlinked.expiry")}</p>
        <Button variant="ghost" size="sm" className="mt-4" loading={state.isFetching} onClick={() => void state.refetch()}>
          {t("teamsTab.unlinked.recheck")}
        </Button>
      </Frame>
    );
  }

  const target = tabTargetRoute(host.subPageId);
  if (target) {
    return (
      <Frame icon={<Badge icon={ExternalLink} />} title={t("teamsTab.target.title")}>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t("teamsTab.target.body")}</p>
        <Button size="lg" className="mt-6 w-full" onClick={() => open(routeToPath(target))}>
          {t("teamsTab.target.action")}
        </Button>
        <p className="mt-4 text-xs text-fg-faint">{t("teamsTab.target.account", { name: data.accountName })}</p>
      </Frame>
    );
  }
  return (
    <Frame
      icon={<CircleCheck className="mx-auto size-8 text-success" />}
      title={t("teamsTab.linked.title", { name: data.accountName })}
    >
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t("teamsTab.linked.body")}</p>
      <Button variant="secondary" className="mt-6" onClick={() => open(routeToPath({ view: "settings" }))}>
        {t("teamsTab.linked.open")}
      </Button>
    </Frame>
  );
}

/** The accent disc of the link and open states, as the link page draws it. */
function Badge({ icon: Icon }: { icon: typeof Link2 }) {
  return (
    <span className="inline-flex rounded-full bg-accent-soft p-3">
      <Icon className="size-6 text-accent" />
    </span>
  );
}

function Frame({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <GateFrame>
      <Card className="px-6 py-8 text-center">
        {icon}
        <h1 className="mt-3 text-lg font-bold tracking-tight">{title}</h1>
        {children}
      </Card>
    </GateFrame>
  );
}

function Outside() {
  const t = useT();
  return (
    <Frame icon={<MessagesSquare className="mx-auto size-8 text-fg-muted" />} title={t("teamsTab.outside.title")}>
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t("teamsTab.outside.body")}</p>
    </Frame>
  );
}

function Loading() {
  return (
    <GateFrame>
      <Card className="space-y-3 px-6 py-8" aria-busy="true">
        <Skeleton className="mx-auto h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </Card>
    </GateFrame>
  );
}
