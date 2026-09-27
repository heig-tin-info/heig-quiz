import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import type { PublicConfig } from "@quiz/contracts";

import { api } from "./api";
import { useT } from "./i18n";
import { configKey } from "./queryKeys";
import { Button, Card, GateFrame } from "./ui";

/**
 * The sign-in of a page reached from outside the app with no session — a
 * poll that asks for an account, an assistant's consent, the Teams bot's
 * link. ONE primary action, and the development door beside it exactly as
 * `Landing` offers it; both carry a `next` back to the very page, which the
 * server validates (`auth/returnTo.ts`).
 *
 * It lives beside `api.ts`, not in `ui/`: it reads the public configuration,
 * and nothing under `ui/` imports the HTTP client.
 */
export function SignInGate({
  next,
  header,
  title,
  body,
  action,
}: {
  /** The same-origin path (and query) to come back to. */
  next: string;
  /** What sits above the title: an icon, an eyebrow. */
  header: ReactNode;
  title: string;
  body: string;
  action: string;
}) {
  const t = useT();
  const config = useQuery<PublicConfig>({
    queryKey: configKey,
    queryFn: () => api<PublicConfig>("/app/api/config"),
    retry: false,
  });
  const back = encodeURIComponent(next);
  return (
    <GateFrame>
      <Card className="px-6 py-8 text-center">
        {header}
        <h1 className="mt-3 text-lg font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{body}</p>
        <Button
          size="lg"
          className="mt-6 w-full"
          onClick={() => window.location.assign(`/app/auth/login?next=${back}`)}
        >
          {action}
        </Button>
        {config.data?.devLogin ? (
          <>
            <Button
              variant="secondary"
              size="lg"
              className="mt-3 w-full"
              onClick={() => window.location.assign(`/app/auth/dev?next=${back}`)}
            >
              {t("landing.devSignin")}
            </Button>
            <p className="mt-2 text-xs text-fg-faint">{t("landing.devHint")}</p>
          </>
        ) : null}
      </Card>
    </GateFrame>
  );
}
