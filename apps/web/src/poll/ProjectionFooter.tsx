import { EyeOff } from "lucide-react";

import type { PollTeacherView } from "@quiz/contracts";

import { useT } from "../i18n";
import { Ring } from "../ui";
import { waitingOf } from "./pollTally";

/**
 * Band 3 of the projection — where the room is at. The way in left this
 * corner for the top one, out of the toasts' way.
 */
export function ProjectionFooter({
  tally,
  anonymous,
}: {
  tally: PollTeacherView["tally"];
  anonymous: boolean;
}) {
  const t = useT();
  const waiting = waitingOf(tally);
  return (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div className="flex items-center gap-3.5">
        <Ring
          value={tally.answered}
          max={tally.joined}
          size={64}
          thickness={5}
          label={t("poll.ringLabel", { answered: tally.answered, joined: tally.joined })}
        >
          <span className="font-mono text-[13px] font-bold tabular-nums">
            {tally.joined === 0
              ? "—"
              : `${Math.min(100, Math.round((tally.answered / tally.joined) * 100))}%`}
          </span>
        </Ring>
        <span>
          <span className="block font-mono text-[clamp(20px,2vw,30px)] font-bold leading-tight tracking-[-0.02em] tabular-nums">
            {t("poll.joined", { n: tally.joined })}
          </span>
          <span className="mt-0.5 block text-[clamp(13px,1.2vw,17px)] text-fg-muted">
            {tally.answered === 0
              ? t("poll.noAnswersYet")
              : t(tally.answered === 1 ? "poll.received.one" : "poll.received", {
                  answered: tally.answered,
                  waiting,
                })}
          </span>
          {anonymous ? (
            <span className="mt-1 flex items-center gap-1.5 text-[clamp(12px,1.1vw,15px)] text-fg-faint">
              <EyeOff className="size-[1.1em]" aria-hidden />
              {t("poll.noNames")}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
