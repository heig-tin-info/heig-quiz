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

/** The quit link, as a button: a plain navigation, which SEB intercepts. */
export function SebQuitButton({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  const t = useT();
  return (
    <LinkButton href={SEB_QUIT_PATH} variant={variant}>
      <LogOut /> {t("seb.quit")}
    </LinkButton>
  );
}

type QuitPlatform = "windows" | "mac" | null;

interface NavigatorLike {
  readonly userAgent: string;
  readonly platform?: string;
  readonly userAgentData?: { readonly platform?: string };
}

/**
 * The student's desktop, for SEB's own quit shortcut (SEB's manuals: Ctrl+Q
 * on Windows, ⌘Q on macOS). The client hint first, then the legacy
 * `platform`, then the user agent (SEB's carries the system's); null when
 * none says, and both shortcuts are then shown.
 */
export function quitPlatform(nav: NavigatorLike): QuitPlatform {
  for (const hint of [nav.userAgentData?.platform, nav.platform, nav.userAgent]) {
    if (!hint) continue;
    if (/^win|windows/i.test(hint)) return "windows";
    if (/^mac|macintosh|mac os x/i.test(hint)) return "mac";
  }
  return null;
}

const KEYS: Record<Exclude<QuitPlatform, null>, string> = {
  windows: "Ctrl+Q",
  mac: "⌘Q",
};

/** The keyboard way out, one line under the button. */
export function SebQuitKeys() {
  const t = useT();
  const platform = typeof navigator === "undefined" ? null : quitPlatform(navigator as NavigatorLike);
  return (
    <span className="mt-2 block text-fg-faint">
      {platform === null ? t("seb.quit.keys.both") : t("seb.quit.keys", { keys: KEYS[platform] })}
    </span>
  );
}

/**
 * `/seb/quit` outside Safe Exam Browser (inside, SEB quits before the
 * request): someone followed the link elsewhere, and there is nothing to do.
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
        </EmptyState>
      </Card>
    </main>
  );
}
