import {
  BookmarkCheck,
  BookmarkPlus,
  Check,
  Maximize2,
  Minimize2,
  Moon,
  RotateCcw,
  Square,
  Sun,
} from "lucide-react";

import type { PollTeacherView } from "@quiz/contracts";

import { useT } from "../i18n";
import { Button, IconButton, Menu, Segmented } from "../ui";
import { PollQr } from "./PollQr";
import { hasKey, joinHost } from "./pollTally";

/**
 * Where the room is: still answering, looking at the key, or done. `ended`
 * wins over `revealed` — a closed poll whose key was on the wall is over, and
 * "Run again" is what is left.
 */
export type ProjectionPhase = "live" | "revealed" | "ended";

/** The states in which the poll is over and "Run again" is what is left. */
function isEnded(state: string): boolean {
  return state === "closed" || state === "grading" || state === "released";
}

export function projectionPhase(view: PollTeacherView): ProjectionPhase {
  if (isEnded(view.evaluation.state)) return "ended";
  return view.settings.revealed ? "revealed" : "live";
}

/** The word after the context: one of the three phases, never the colour alone. */
function PhaseLabel({ phase, keyed }: { phase: ProjectionPhase; keyed: boolean }) {
  const t = useT();
  if (phase === "ended") {
    return (
      <span className="text-[clamp(13px,1.2vw,16px)] font-semibold text-fg-muted">
        {t("poll.ended")}
      </span>
    );
  }
  if (phase === "revealed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[clamp(13px,1.2vw,16px)] font-semibold text-success">
        <Check className="size-[1.1em]" aria-hidden />
        {t(keyed ? "poll.revealed" : "poll.resultsShown")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-[clamp(13px,1.2vw,16px)] font-semibold text-accent">
      <span className="size-2.5 animate-pulse rounded-full bg-accent" aria-hidden />
      {t("poll.live")}
    </span>
  );
}

/**
 * Band 1 of the projection — where we are, what state the room is in, and the
 * way in. The join tile owns the top-right corner (the toasts own the bottom
 * one); the controls sit in the left column, pushed against it.
 */
export function ProjectionHeader({
  view,
  phase,
  revealed,
  onReveal,
  onAgain,
  againPending,
  dark,
  onToggleTheme,
  fullscreen,
  onToggleFullscreen,
  onEnd,
  onBack,
  onKeep,
  keepPending,
  onOpenQuestion,
}: {
  view: PollTeacherView;
  phase: ProjectionPhase;
  /** The reveal switch, which stays where it was once the poll has ended. */
  revealed: boolean;
  onReveal: (revealed: boolean) => void;
  onAgain: () => void;
  againPending: boolean;
  dark: boolean;
  onToggleTheme: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onEnd: () => void;
  onBack: () => void;
  /** "Keep this question": the unsaved question joins the Polls pool. */
  onKeep: () => void;
  keepPending: boolean;
  /** Opens the kept question in its pool's editor. */
  onOpenQuestion: () => void;
}) {
  const t = useT();
  const ended = phase === "ended";
  /*
   * "PRG1 · PRG1-2026", from the poll view itself: the course and the room
   * travel with `PollTeacherView.evaluation`. This screen used to fetch
   * `GET /classrooms/:id` for those two words — a second request, and a
   * second thing that can be in flight, on a page whose whole job is to be
   * already there on a beamer.
   */
  const context = `${view.evaluation.courseName} · ${view.evaluation.classroomName}`;
  // An opinion poll has no answer to reveal; the switch shows the phones
  // the results instead (ADR-014, addendum 2026-09-23).
  const keyed = hasKey(view.question);
  /*
   * "Keep this question" (ADR-014, addenda item 6). A question written in
   * the launcher is saved nowhere until the teacher says so. While the room
   * answers the offer waits in the menu — the wall is the room's, not the
   * teacher's; once the poll is over it is a secondary button beside "Run
   * again", then the place it went: "Kept in Polls", which opens it.
   */
  const { saved, pool } = view.question;
  const keptLabel = pool ? t("poll.keptIn", { pool: pool.name }) : null;

  return (
    <header className="flex flex-wrap items-start gap-[clamp(16px,2.4vw,32px)]">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4">
        <span className="text-[clamp(14px,1.4vw,18px)] font-semibold tracking-[-0.01em] text-fg-muted">
          {context}
        </span>
        <span className="size-1 rounded-full bg-fg-faint" aria-hidden />
        <PhaseLabel phase={phase} keyed={keyed} />
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented
            name="poll-reveal"
            value={revealed ? "revealed" : "live"}
            onChange={(v) => onReveal(v === "revealed")}
            options={[
              { value: "live", label: t("poll.live") },
              { value: "revealed", label: t(keyed ? "poll.reveal" : "poll.resultsShown") },
            ]}
          />
          {ended && !saved ? (
            <Button size="sm" variant="secondary" onClick={onKeep} loading={keepPending}>
              <BookmarkPlus /> {t("poll.keep")}
            </Button>
          ) : null}
          {ended && keptLabel ? (
            <Button size="sm" variant="ghost" onClick={onOpenQuestion}>
              <BookmarkCheck /> {keptLabel}
            </Button>
          ) : null}
          {ended ? (
            <Button size="sm" onClick={onAgain} loading={againPending}>
              <RotateCcw /> {t("poll.again")}
            </Button>
          ) : null}
          <IconButton
            label={dark ? t("menu.lightTheme") : t("menu.darkTheme")}
            onClick={onToggleTheme}
          >
            {dark ? <Sun /> : <Moon />}
          </IconButton>
          <IconButton
            label={fullscreen ? t("poll.exitFullscreen") : t("poll.fullscreen")}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
          <Menu
            label={t("common.actions")}
            items={[
              ...(ended || saved
                ? []
                : [{ label: t("poll.keep"), icon: BookmarkPlus, onSelect: onKeep }]),
              ...(!ended && keptLabel
                ? [{ label: keptLabel, icon: BookmarkCheck, onSelect: onOpenQuestion }]
                : []),
              ...(ended
                ? []
                : [{ label: t("poll.end"), icon: Square, danger: true, onSelect: onEnd }]),
              { label: t("poll.back"), separator: !ended, onSelect: onBack },
            ]}
          />
        </span>
      </div>

      {/* A finished poll offers no way in: a code still on the wall sends
          the room to a page that refuses them. */}
      {ended ? null : (
        <div
          data-poll-join
          className="flex items-center gap-[clamp(14px,1.6vw,26px)] max-sm:w-full max-sm:justify-between"
        >
          <span className="text-right max-sm:text-left">
            <span className="block text-[clamp(13px,1.2vw,17px)] text-fg-muted">
              {t("poll.joinAt", { host: joinHost(view.joinUrl) })}
            </span>
            <span className="mt-0.5 block font-mono text-[clamp(34px,4.2vw,64px)] font-bold leading-none tracking-[0.02em] tabular-nums">
              {view.evaluation.code}
            </span>
          </span>
          <PollQr
            value={view.joinUrl}
            label={t("poll.qrLabel", { code: view.evaluation.code })}
          />
        </div>
      )}
    </header>
  );
}
