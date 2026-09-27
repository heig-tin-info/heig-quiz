import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, Check, KeyRound, TriangleAlert, X } from "lucide-react";

import type { Me, OAuthDecisionResult, OAuthRequestView } from "@quiz/contracts";

import { api, ApiError } from "../api";
import { useT } from "../i18n";
import { oauthRequestKey } from "../queryKeys";
import { SignInGate } from "../SignInGate";
import { Alert, Button, Card, FormError, GateFrame, Skeleton } from "../ui";

/**
 * The OAuth consent page (ADR-023): claude.ai, ChatGPT or another MCP client
 * asks to act for the teacher. ONE question, ONE primary action — Allow — and
 * everything a careful reader needs to say no: who asks, where the answer
 * goes, what it will be able to do.
 *
 * `/app/oauth/authorize` sends here with the pending request's id, or with
 * `invalid?reason=` when it refused the request before it could be trusted.
 */
export function OAuthConsent({ id, me }: { id: string; me: Me | null }) {
  const t = useT();
  if (id === "invalid") {
    const reason = new URLSearchParams(window.location.search).get("reason") ?? "invalid_request";
    const known = ["invalid_client", "invalid_redirect_uri", "invalid_client_metadata"].includes(reason);
    return (
      <GateFrame>
        <Card className="px-6 py-8 text-center">
          <TriangleAlert className="mx-auto size-8 text-warning" />
          <h1 className="mt-3 text-lg font-bold tracking-tight">{t("oauth.invalid.title")}</h1>
          <p className="mt-2 text-sm text-fg-muted">
            {known ? t(`oauth.invalid.${reason}` as Parameters<typeof t>[0]) : t("oauth.invalid.invalid_request")}
          </p>
        </Card>
      </GateFrame>
    );
  }
  if (!me) return <SignInFirst id={id} />;
  if (me.role === "student") {
    return (
      <GateFrame>
        <Card className="px-6 py-8 text-center">
          <h1 className="text-lg font-bold tracking-tight">{t("oauth.teachersOnly.title")}</h1>
          <p className="mt-2 text-sm text-fg-muted">{t("oauth.teachersOnly.body")}</p>
        </Card>
      </GateFrame>
    );
  }
  return <Consent id={id} me={me} />;
}


/** No session yet: the sign-in, with a `next` back to this very request. */
function SignInFirst({ id }: { id: string }) {
  const t = useT();
  return (
    <SignInGate
      next={`/oauth/authorize/${id}`}
      header={<Bot className="mx-auto size-8 text-fg-muted" />}
      title={t("oauth.signIn.title")}
      body={t("oauth.signIn.body")}
      action={t("oauth.signIn.action")}
    />
  );
}

function Consent({ id, me }: { id: string; me: Me }) {
  const t = useT();
  const request = useQuery({
    queryKey: oauthRequestKey(id),
    queryFn: () => api<OAuthRequestView>(`/app/api/oauth/requests/${id}`),
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api<OAuthDecisionResult>(`/app/api/oauth/requests/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ approve }),
      }),
    // The client's own page takes over from here: a full navigation, not a route.
    onSuccess: (result) => window.location.assign(result.redirectTo),
  });

  if (request.isPending) {
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
  if (request.isError) {
    const gone = request.error instanceof ApiError && request.error.status === 404;
    return (
      <GateFrame>
        <Card className="px-6 py-8 text-center">
          <TriangleAlert className="mx-auto size-8 text-warning" />
          <h1 className="mt-3 text-lg font-bold tracking-tight">
            {gone ? t("oauth.expired.title") : t("error.server")}
          </h1>
          {gone ? <p className="mt-2 text-sm text-fg-muted">{t("oauth.expired.body")}</p> : null}
        </Card>
      </GateFrame>
    );
  }

  const r = request.data;
  const busy = decide.isPending || decide.isSuccess;
  return (
    <GateFrame>
      <Card className="px-6 py-8">
        <div className="text-center">
          <span className="inline-flex rounded-full bg-accent-soft p-3">
            <KeyRound className="size-6 text-accent" />
          </span>
          <h1 className="mt-3 text-lg font-bold tracking-tight">
            {t("oauth.consent.title", { client: r.clientName })}
          </h1>
          <p className="mt-1 text-sm text-fg-muted">{t("oauth.consent.as", { email: me.email })}</p>
        </div>

        <div className="mt-6 space-y-2 text-sm">
          <p className="font-semibold">{t("oauth.consent.can")}</p>
          <ul className="space-y-1.5">
            {(["read", "write", "draft"] as const).map((k) => (
              <li key={k} className="flex gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-success" />
                <span>{t(`oauth.consent.can.${k}`)}</span>
              </li>
            ))}
          </ul>
          <p className="pt-2 font-semibold">{t("oauth.consent.cannot")}</p>
          <ul className="space-y-1.5">
            {(["delete", "run", "grades"] as const).map((k) => (
              <li key={k} className="flex gap-2 text-fg-muted">
                <X className="mt-0.5 size-4 shrink-0" />
                <span>{t(`oauth.consent.cannot.${k}`)}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-6 text-sm text-fg-muted">
          {t("oauth.consent.redirect")} <span className="font-mono font-medium text-fg">{r.redirectHost}</span>
        </p>
        {r.loopback ? (
          <div className="mt-4">
            <Alert tone="warning" icon={TriangleAlert}>
              {t("oauth.consent.loopback")}
            </Alert>
          </div>
        ) : null}
        <FormError error={decide.error} />

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" disabled={busy} onClick={() => decide.mutate(false)}>
            {t("oauth.consent.deny")}
          </Button>
          <Button loading={busy && decide.variables === true} disabled={busy} onClick={() => decide.mutate(true)}>
            {t("oauth.consent.allow")}
          </Button>
        </div>
        <p className="mt-4 text-xs text-fg-faint">{t("oauth.consent.revokeHint")}</p>
      </Card>
    </GateFrame>
  );
}
