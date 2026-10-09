import type { ReactNode } from "react";

import { usePublicConfig } from "./api";
import { useT } from "./i18n";
import { Button, GateCard } from "./ui";

/**
 * The sign-in of a page reached from outside the app with no session — a
 * poll that asks for an account, an assistant's consent, the Teams
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
  const config = usePublicConfig();
  const back = encodeURIComponent(next);
  return (
    <GateCard icon={header} title={title} body={body}>
      <Button size="lg" className="mt-6 w-full" onClick={() => window.location.assign(`/app/auth/login?next=${back}`)}>
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
    </GateCard>
  );
}
