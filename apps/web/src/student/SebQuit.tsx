/**
 * Leaving Safe Exam Browser (ADR-027). The `.seb` hides SEB's task bar, and
 * its Quit button with it; the file's quit link (`quitURL`, `SEB_QUIT_PATH`)
 * makes SEB quit, without asking, when it is about to navigate there. These
 * are that link as a button, the keyboard shortcut beside it, and the page
 * the same address shows anywhere else.
 */
import { LogOut } from "lucide-react";

import { SEB_QUIT_PATH } from "@quiz/contracts";

import { useT } from "../i18n";
import { Card, EmptyState, LinkButton } from "../ui";

/**
 * Whether this browser is Safe Exam Browser, from its user agent (SEB adds
 * `SEB/<version>` to it): for a page with no session, such as a refused
 * launch, which a copied file opened in another browser reaches too.
 */
export const inSebBrowser = (): boolean =>
  typeof navigator !== "undefined" && /\bSEB\b/.test(navigator.userAgent);

/** The quit link, as a button: a plain navigation, which SEB intercepts. */
export function SebQuitButton({
  variant = "primary",
  size = "md",
  className = "",
}: {
  variant?: "primary" | "secondary";
  size?: "md" | "lg";
  className?: string;
}) {
  const t = useT();
  return (
    <LinkButton href={SEB_QUIT_PATH} variant={variant} size={size} className={className}>
      <LogOut /> {t("seb.quit")}
    </LinkButton>
  );
}

/** SEB's own quit shortcut, one line under the button (SEB's manuals). */
export function SebQuitKeys() {
  const t = useT();
  return <span className="mt-2 block text-fg-faint">{t("seb.quit.keys")}</span>;
}

/**
 * `/seb/quit` outside Safe Exam Browser (inside, SEB quits before the
 * request): someone followed the link elsewhere, and there is nothing to do.
 * The shortcut line covers a SEB build that ignores its quit link.
 */
export function SebQuitPage() {
  const t = useT();
  return (
    <main className="mx-auto w-full max-w-160 px-4 py-16 sm:px-6">
      <Card className="px-6 py-4">
        <EmptyState
          icon={LogOut}
          title={t("seb.quitPage.title")}
          titleAs="h1"
          action={
            <LinkButton href="/" variant="primary">
              {t("player.closed.home")}
            </LinkButton>
          }
        >
          {t("seb.quitPage.body")}
          <SebQuitKeys />
        </EmptyState>
      </Card>
    </main>
  );
}
