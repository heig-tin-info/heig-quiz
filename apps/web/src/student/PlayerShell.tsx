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
 *     unreadable, and the strip stays over its own question. On a wide
 *     screen the strip leaves the bar for a side column (`aside`) left of
 *     the question: the room a laptop has is beside the statement, not
 *     above it, and every pixel of bar is a pixel of answer field lost.
 *     The bar then spans both columns, so the title lines up with the list.
 *   - Finish: hairlines top and bottom, `surface` bars on the warm canvas, no
 *     shadow — both bars are in the page flow, not above it.
 *
 * It holds no state of the attempt: the shell is what the player looks like,
 * and the player is what it does. The one thing it does own is `Ctrl+K` —
 * DESIGN.md promises the palette "from anywhere", and the player is rendered
 * outside the Shell that used to be the only place it existed (W15). The list
 * is the player's, and it is four entries long: there is nowhere else to go
 * during an exam.
 *
 * An EXERCISE is different (issue #125): it can be left at any time, every
 * answer is saved and the student home offers Continue. There, and only
 * there, the bar opens with a quiet Home button (`onHome`). An exam never
 * gets one: leaving does not stop its clock, and a way out would read as a
 * pause.
 */
import { Home, Moon, Sun } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { CommandPalette } from "../CommandPalette";
import type { Command } from "../commands";
import { useT } from "../i18n";
import { setThemeChoice, useResolvedTheme } from "../theme";
import {
  ClockCountdown,
  cx,
  IconButton,
  Kbd,
  ProgressSegments,
  SyncBadge,
  type Segment,
  type SyncState,
} from "../ui";

/**
 * With the side column, the bar and the body share one width: the 760 px
 * question column (`max-w-190`), unchanged, plus the column and its gap —
 * the two terms of `RAIL_GRID`.
 */
const WIDE = "max-w-[61.5rem]";
const RAIL_GRID = "grid grid-cols-[12rem_minmax(0,1fr)] gap-8";

export function PlayerShell({
  title,
  subtitle,
  deadlineAt,
  clock = Date.now,
  paused = false,
  sync,
  segments = [],
  onSelectSegment,
  progressLabel,
  headerAction,
  onHome,
  homeBusy = false,
  commands,
  banner,
  footer,
  aside,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Epoch ms on the server's clock; `null` in a `manual` evaluation. */
  deadlineAt: number | null;
  /**
   * The time the countdown counts against, re-read once a second by the
   * countdown itself: the server's for an attempt. Stable, never a ticking
   * value — the shell and the question under it do not re-render per tick.
   */
  clock?: () => number;
  /** The teacher paused the evaluation: the countdown freezes with it (W16). */
  paused?: boolean;
  /**
   * Absent when there is nothing to save — the one-question preview writes
   * nothing, and a badge saying "Saved" there would be a lie.
   */
  sync?: SyncState;
  /** Empty when there is only one thing to read: no strip at all. */
  segments?: Segment[];
  /** Absent when navigation is locked: the strip becomes an indicator. */
  onSelectSegment?: (id: string, index: number) => void;
  progressLabel?: string;
  /** "Hand in", the only action of the bar. */
  headerAction?: ReactNode;
  /**
   * The way back to the student home, first in the bar. Given for an
   * exercise only; absent in an exam and in the teacher's preview.
   */
  onHome?: () => void;
  /** Leaving is under way: the button reads as disabled (the player ignores a second press). */
  homeBusy?: boolean;
  /** What `Ctrl+K` offers here. Empty means no palette at all. */
  commands?: Command[];
  /** The offline alert, in the flow under the bar. */
  banner?: ReactNode;
  /** Absent on a desktop: the actions then sit under the question itself. */
  footer?: ReactNode;
  /**
   * The side column, left of the question, on a wide screen only. It holds
   * the question list, so the strip (`segments`) is not drawn; the shell
   * adds the move keys under it, visible.
   */
  aside?: ReactNode;
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
  // The bar's own height, for the side column that sticks under it: it grows
  // with a subtitle or a larger text size, and the column must not slide
  // under it.
  const docked = aside !== undefined;
  const bar = useRef<HTMLElement>(null);
  const [barHeight, setBarHeight] = useState(0);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!docked || !el) return;
    const measure = () => setBarHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [docked]);
  const strip = docked ? [] : segments;
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
    <div
      className="flex min-h-[calc(100dvh-var(--banner-h))] flex-col bg-canvas"
      style={{ "--bar-h": `${barHeight}px` } as CSSProperties}
    >
      <header ref={bar} className="sticky top-(--banner-h) z-20 border-b border-line bg-surface">
        <div
          className={cx(
            "mx-auto w-full px-4 pt-2.5 sm:px-6",
            aside ? WIDE : "max-w-190",
            // The strip carries the bar's bottom margin; without one the bar
            // would sit on its own hairline.
            strip.length === 0 && "pb-2.5",
          )}
        >
          <div className="flex items-center gap-3">
            {onHome ? (
              // `-ml-1.5`: the round button's own padding, so the house
              // lines up with the question column below it.
              <IconButton
                label={t("player.command.home")}
                onClick={onHome}
                // `aria-disabled`, not `disabled`: the keyboard focus stays on
                // Home while the answers are sent, and is still there after
                // "Stay". The player's own guard ignores a second press.
                aria-disabled={homeBusy || undefined}
                aria-busy={homeBusy || undefined}
                className="-ml-1.5 -mr-1 aria-disabled:opacity-40"
              >
                <Home />
              </IconButton>
            ) : null}
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
              <ClockCountdown deadlineAt={deadlineAt} clock={clock} paused={paused} />
            )}
            {sync === undefined ? null : <SyncBadge state={sync} />}
            {headerAction}
          </div>
          {strip.length === 0 ? null : (
            // The margin sits on a wrapper: the strip sets its own vertical
            // margin when it scrolls, and `cx` does not merge classes.
            <div className="mt-1">
              <ProgressSegments
                segments={strip}
                {...(onSelectSegment ? { onSelect: onSelectSegment } : {})}
                label={progressLabel ?? ""}
              />
            </div>
          )}
        </div>
      </header>

      <div
        className={cx(
          "mx-auto w-full flex-1 py-6",
          aside ? cx(RAIL_GRID, WIDE, "px-6") : "max-w-190 px-4 sm:px-6",
        )}
      >
        {aside ? (
          // Sticks the body's top padding under the bar, and fits in the
          // viewport under it: a long list scrolls inside, never the page.
          <aside className="sticky top-[calc(var(--banner-h)+var(--bar-h)+1.5rem)] flex max-h-[calc(100dvh-var(--banner-h)-var(--bar-h)-3rem)] flex-col gap-4 self-start">
            {aside}
            <p className="text-[12px] leading-relaxed text-fg-faint">
              <Kbd>Alt</Kbd> + <Kbd>←</Kbd> <Kbd>→</Kbd> {t("player.shortcuts")}
            </p>
          </aside>
        ) : null}
        <main className="min-w-0">
          {banner ? <div className="mb-5">{banner}</div> : null}
          {children}
        </main>
      </div>

      {footer ? (
        <footer className="sticky bottom-0 z-20 border-t border-line bg-surface">
          <div className="mx-auto flex w-full max-w-190 flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
            {footer}
          </div>
          <p className="sr-only">{t("player.shortcuts")}</p>
        </footer>
      ) : aside ? null : (
        <p className="sr-only">{t("player.shortcuts")}</p>
      )}
      {palette && commands ? (
        <CommandPalette open onClose={() => setPalette(false)} t={t} commands={commands} />
      ) : null}
    </div>
  );
}
