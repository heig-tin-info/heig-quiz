import { ShieldAlert } from "lucide-react";

import { LOGIN_REFUSALS, type LoginRefusal } from "@quiz/contracts";

import { useT } from "./i18n";
import { GateCard, LinkButton } from "./ui";

/**
 * Where the OIDC callback sends a sign-in it refused (ADR-111 §6), with
 * `?reason=`: drawn with no session, since none was opened. The text is the
 * reason's, generic — never the institutions the platform admits, never the
 * person's addresses. One action: back to the home page. An unknown reason
 * reads as `not_invited`.
 */
export function LoginRefusedPage() {
  const t = useT();
  const raw = new URLSearchParams(window.location.search).get("reason");
  const reason: LoginRefusal = LOGIN_REFUSALS.find((r) => r === raw) ?? "not_invited";
  return (
    <GateCard
      icon={<ShieldAlert className="mx-auto size-8 text-warning" />}
      title={t("loginRefused.title")}
      body={t(`loginRefused.${reason}`)}
    >
      <LinkButton href="/" variant="primary" size="lg" className="mt-6 w-full">
        {t("loginRefused.home")}
      </LinkButton>
    </GateCard>
  );
}
