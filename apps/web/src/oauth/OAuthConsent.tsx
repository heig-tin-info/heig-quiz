import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, Check, KeyRound, TriangleAlert, X } from "lucide-react";

import type { Me, OAuthDecisionResult, OAuthRequestView } from "@quiz/contracts";

import { api, isNotFound } from "../api";
import { useT } from "../i18n";
import { oauthRequestKey } from "../queryKeys";
import { SignInGate } from "../SignInGate";
import { Alert, Button, Card, FormError, GateCard, GateFrame, GateIcon, GateSkeleton } from "../ui";

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
      <GateCard
        icon={<TriangleAlert className="mx-auto size-8 text-warning" />}
        title={t("oauth.invalid.title")}
        body={known ? t(`oauth.invalid.${reason}` as Parameters<typeof t>[0]) : t("oauth.invalid.invalid_request")}
      />
    );
  }
  if (!me) return <SignInFirst id={id} />;
  if (me.role === "student") {
    return <GateCard title={t("oauth.teachersOnly.title")} body={t("oauth.teachersOnly.body")} />;
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

  if (request.isPending) return <GateSkeleton />;
  if (request.isError) {
    const gone = isNotFound(request.error);
    return (
      <GateCard
        icon={<TriangleAlert className="mx-auto size-8 text-warning" />}
        title={gone ? t("oauth.expired.title") : t("error.server")}
        body={gone ? t("oauth.expired.body") : null}
      />
    );
  }

  const r = request.data;
  const busy = decide.isPending || decide.isSuccess;
  return (
    <GateFrame>
      <Card className="px-6 py-8">
        <div className="text-center">
          <GateIcon icon={KeyRound} />
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
