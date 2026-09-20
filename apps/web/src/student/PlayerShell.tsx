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
 * It holds no state: the shell is what the player looks like, and the player
 * is what it does.
 */
import type { ReactNode } from "react";

import { useT } from "../i18n";
import {
  Countdown,
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
  sync,
  segments,
  onSelectSegment,
  progressLabel,
  headerAction,
  banner,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Epoch ms on the server's clock; `null` in a `manual` evaluation. */
  deadlineAt: number | null;
  now: number;
  sync: SyncState;
  segments: Segment[];
  /** Absent when navigation is locked: the strip becomes an indicator. */
  onSelectSegment?: (id: string, index: number) => void;
  progressLabel: string;
  /** "Hand in", the only action of the bar. */
  headerAction?: ReactNode;
  /** The offline alert, in the flow under the bar. */
  banner?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto w-full max-w-190 px-4 pt-2.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold leading-tight">{title}</p>
              {subtitle ? (
                <p className="truncate text-[12px] leading-tight text-fg-faint">{subtitle}</p>
              ) : null}
            </div>
            {deadlineAt === null ? null : <Countdown deadlineAt={deadlineAt} now={now} />}
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

      <footer className="sticky bottom-0 z-20 border-t border-line bg-surface">
        <div className="mx-auto flex w-full max-w-190 flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
          {footer}
        </div>
        <p className="sr-only">{t("player.shortcuts")}</p>
      </footer>
    </div>
  );
}
