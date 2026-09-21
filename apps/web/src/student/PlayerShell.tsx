/**
 * The frame of the zen player (mockup `07-etudiant-zen.html`).
 *
 * The four decisions:
 *   - Type: the question is the only thing at reading size; the bar is 13 px
 *     and the countdown 15 px tabular. Nothing on the chrome competes with
 *     the statement.
 *   - Color: ONE accent, the primary action in the footer. The countdown
 *     earns `warning` then `danger` from the clock, never from the theme, and
 *     the progress strip is `fg` and greys — a red bar per question would
 *     turn the page into an alarm.
 *   - Space: the bar is tight (8–12), the question column is generous (24
 *     between the header and the body, 32 to the footer). The column is
 *     capped at 760 px: a statement that runs the full width of a laptop is
 *     unreadable, and the strip stays over its own question.
 *   - Finish: hairlines top and bottom, `surface` bars on the warm canvas, no
 *     shadow — both bars are in the page flow, not above it.
 *
 * It holds no state of the attempt: the shell is what the player looks like,
 * and the player is what it does. The one thing it does own is `Ctrl+K` —
 * DESIGN.md promises the palette "from anywhere", and the player is rendered
 * outside the Shell that used to be the only place it existed (W15). The list
 * is the player's, and it is four entries long: there is nowhere else to go
 * during an exam.
 */
import { Moon, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { CommandPalette } from "../CommandPalette";
import type { Command } from "../commands";
import { useT } from "../i18n";
import { setThemeChoice, useResolvedTheme } from "../theme";
import {
  Countdown,
  IconButton,
  ProgressSegments,
  SyncBadge,
  type Segment,
  type SyncState,
} from "../ui";

export function PlayerShell({
  title,
  subtitle,
  deadlineAt,
  now,
  paused = false,
  sync,
  segments,
  onSelectSegment,
  progressLabel,
  headerAction,
  commands,
  banner,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Epoch ms on the server's clock; `null` in a `manual` evaluation. */
  deadlineAt: number | null;
  now: number;
  /** The teacher paused the evaluation: the countdown freezes with it (W16). */
  paused?: boolean;
  sync: SyncState;
  segments: Segment[];
  /** Absent when navigation is locked: the strip becomes an indicator. */
  onSelectSegment?: (id: string, index: number) => void;
  progressLabel: string;
  /** "Hand in", the only action of the bar. */
  headerAction?: ReactNode;
  /** What `Ctrl+K` offers here. Empty means no palette at all. */
  commands?: Command[];
  /** The offline alert, in the flow under the bar. */
  banner?: ReactNode;
  /** Absent on a desktop: the actions then sit under the question itself. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  // The player is rendered outside the Shell, so the account menu that
  // carries the light/dark toggle everywhere else is not on screen. A student
  // sitting an exam at night has nowhere to go for it, hence this one: the
  // same store and the same two icons as the menu, so the two surfaces can
  // never disagree about what is on screen. It is QUIET — the single accent
  // of this screen is "Hand in".
  const theme = useResolvedTheme();
  const [palette, setPalette] = useState(false);
  const hasPalette = (commands?.length ?? 0) > 0;
  useEffect(() => {
    if (!hasPalette) return;
    const onKey = (e: KeyboardEvent) => {
      // Same contract as the Shell's: bare Ctrl/⌘+K, from inside a field too,
      // and prevented because Firefox otherwise opens its own search bar.
      if (e.altKey || e.shiftKey) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setPalette((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPalette]);
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto w-full max-w-190 px-4 pt-2.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              {/* The page's heading is what the page IS — the evaluation the
                  student is sitting. It is quiet on purpose (13 px, the bar's
                  own size): the zen player gives the reading size to the
                  question, not to the chrome. The per-question counter used to
                  hold this `h1`, which made the document heading change on
                  every navigation and named the wrong thing (W5). */}
              <h1 className="truncate text-[13px] font-semibold leading-tight">{title}</h1>
              {subtitle ? (
                <p className="truncate text-[12px] leading-tight text-fg-muted">{subtitle}</p>
              ) : null}
            </div>
            {/* Left of the clock, and there whether or not there IS a clock:
                a `manual` evaluation has no deadline, and the toggle then
                simply sits where the countdown would have been. */}
            <IconButton
              label={theme === "dark" ? t("player.themeLight") : t("player.themeDark")}
              // An explicit choice, like the account menu's: a two-label
              // toggle cannot express "system", which lives in Settings.
              onClick={() => setThemeChoice(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun /> : <Moon />}
            </IconButton>
            {deadlineAt === null ? null : (
              <Countdown deadlineAt={deadlineAt} now={now} paused={paused} />
            )}
            <SyncBadge state={sync} />
            {headerAction}
          </div>
          <ProgressSegments
            segments={segments}
            {...(onSelectSegment ? { onSelect: onSelectSegment } : {})}
            label={progressLabel}
            className="mt-1"
          />
        </div>
      </header>

      <main className="mx-auto w-full max-w-190 flex-1 px-4 py-6 sm:px-6">
        {banner ? <div className="mb-5">{banner}</div> : null}
        {children}
      </main>

      {footer ? (
        <footer className="sticky bottom-0 z-20 border-t border-line bg-surface">
          <div className="mx-auto flex w-full max-w-190 flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
            {footer}
          </div>
          <p className="sr-only">{t("player.shortcuts")}</p>
        </footer>
      ) : (
        <p className="sr-only">{t("player.shortcuts")}</p>
      )}
      {palette && commands ? (
        <CommandPalette open onClose={() => setPalette(false)} t={t} commands={commands} />
      ) : null}
    </div>
  );
}
