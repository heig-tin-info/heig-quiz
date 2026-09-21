import { Check } from "lucide-react";

import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { cx } from "../ui";
import type { PollRow } from "./pollTally";

/**
 * The distribution, at beamer size (mockup 10).
 *
 * One row is a line and a bar under it. The line carries the letter, the
 * label, the count and the percentage; the bar carries the same percentage
 * again, because a lecture hall reads the bar from the back row and the
 * number from the third one. Everything is in `clamp()`: this is the one
 * surface of the product whose type scale is the ROOM's, not the page's
 * (see `apps/web/DESIGN.md`, "Projection").
 *
 * Revealed, the key is never colour alone (DESIGN.md, VerdictCell): the
 * correct row gains a tick AND the word, and the others fade rather than turn
 * red — nobody in the room is being marked wrong.
 */
export function PollBars({ rows, revealed }: { rows: PollRow[]; revealed: boolean }) {
  const t = useT();
  const lettered = rows.some((r) => r.letter !== null);
  return (
    <ul
      className="flex list-none flex-col gap-[clamp(8px,1.2vh,18px)] p-0"
      // The bars move as the answers arrive; a reader who cannot see them
      // move gets the whole distribution read out instead.
      aria-live="polite"
    >
      {rows.map((row) => {
        const faded = revealed && !row.correct;
        const right = revealed && row.correct;
        return (
          <li key={row.key} className="py-[clamp(6px,1.1vh,14px)]">
            <div className="flex items-center gap-[clamp(12px,1.4vw,22px)]">
              {row.letter === null ? null : (
                <span
                  className={cx(
                    "inline-flex size-[clamp(36px,3.4vw,54px)] shrink-0 items-center justify-center rounded-full border-[1.5px] text-[clamp(16px,1.7vw,24px)] font-semibold",
                    right
                      ? "border-success bg-success text-on-fill"
                      : faded
                        ? "border-line text-fg-faint"
                        : "border-line-strong text-fg-muted",
                  )}
                >
                  {row.letter}
                </span>
              )}
              <span
                className={cx(
                  // `text-inherit` on the code spans: `.md-body code` carries
                  // its own colour, so without it an mcq whose choices are
                  // code fragments kept every label bright and the reveal
                  // faded nothing.
                  "min-w-0 flex-1 text-[clamp(19px,2.3vw,36px)] font-medium tracking-[-0.02em]",
                  right && "text-success [&_code]:text-inherit",
                  faded && "text-fg-faint [&_code]:text-inherit",
                )}
              >
                {row.markdown ? (
                  <MarkdownView source={row.label} inline />
                ) : (
                  // What a participant typed, shown as typed.
                  <span className="break-words">{row.label}</span>
                )}
              </span>
              {right ? (
                <span className="inline-flex h-[clamp(26px,2.4vw,34px)] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-success-soft px-3 text-[clamp(12px,1.1vw,15px)] font-semibold text-success">
                  <Check className="size-[1.1em]" aria-hidden />
                  {t("poll.correctAnswer")}
                </span>
              ) : null}
              {/* The count leaves first when the screen narrows: the
                  percentage is the figure a room reads. */}
              <span
                className="hidden w-[clamp(64px,6vw,100px)] shrink-0 text-right font-mono text-[clamp(13px,1.2vw,17px)] tabular-nums text-fg-faint sm:block"
              >
                {t(row.count === 1 ? "poll.votes.one" : "poll.votes", { n: row.count })}
              </span>
              <span
                className={cx(
                  "shrink-0 font-mono text-[clamp(20px,2.4vw,38px)] font-bold tracking-[-0.02em] tabular-nums",
                  right && "text-success",
                  faded && "text-fg-faint",
                )}
              >
                {t("poll.percent", { n: row.percent })}
              </span>
            </div>
            <div
              className={cx(
                "mt-[clamp(8px,1.2vh,14px)] h-[clamp(8px,0.9vh,12px)] overflow-hidden rounded-full bg-surface-2",
                lettered && "ml-[calc(clamp(36px,3.4vw,54px)+clamp(12px,1.4vw,22px))]",
              )}
            >
              <span
                className={cx(
                  "block h-full rounded-full border transition-[width,background-color,border-color] duration-200 ease-out-emphasized",
                  right
                    ? "border-success bg-success-soft"
                    : faded
                      ? "border-transparent bg-surface-3"
                      : "border-accent bg-accent-soft",
                )}
                // The one inline style of the screen: the width IS the datum,
                // and it changes twice a second.
                style={{ width: `${Math.min(100, row.percent)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
