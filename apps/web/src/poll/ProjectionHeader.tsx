import {
  ArrowLeft,
  BookmarkCheck,
  BookmarkPlus,
  Maximize2,
  Minimize2,
  Moon,
  RotateCcw,
  Square,
  Sun,
} from "lucide-react";

import type { PollTeacherView } from "@quiz/contracts";

import { useT } from "../i18n";
import { Button, IconButton, Switch } from "../ui";
import { PollQr } from "./PollQr";
import { hasKey, joinHost, waitingOf } from "./pollTally";

/**
 * Where the room is: still answering, or done. Showing the votes or the key
 * does not end anything (ADR-014, addendum 2026-09-29): only End does, so
 * there are two phases, not three.
 */
export type ProjectionPhase = "live" | "ended";

/** The states in which the poll is over and "Run again" is what is left. */
function isEnded(state: string): boolean {
  return state === "closed" || state === "grading" || state === "released";
}

export function projectionPhase(view: PollTeacherView): ProjectionPhase {
  return isEnded(view.evaluation.state) ? "ended" : "live";
}

/** The two display switches of a poll, as `POST …/poll/reveal` takes them. */
export interface PollDisplay {
  votes: boolean;
  revealed: boolean;
}

/**
 * The steps a presentation remote walks (Page Down / Page Up), in the order a
 * lecture usually takes them (#157): the choices alone while the room votes,
 * then the distribution, then the key over it. A poll without a key stops at
 * the distribution. The two switches stay independent; this is only the
 * one-button path through them.
 */
export function displaySteps(keyed: boolean): PollDisplay[] {
  const steps: PollDisplay[] = [
    { votes: false, revealed: false },
    { votes: true, revealed: false },
  ];
  return keyed ? [...steps, { votes: true, revealed: true }] : steps;
}

/**
 * The step one press of the remote leads to, or null at either end. From the
 * one state off the path — the key without the votes — forward adds the
 * votes and back hides everything.
 */
export function stepFrom(keyed: boolean, at: PollDisplay, forward: boolean): PollDisplay | null {
  const steps = displaySteps(keyed);
  const found = steps.findIndex((s) => s.votes === at.votes && s.revealed === at.revealed);
  const next = found === -1 ? (forward ? 2 : 0) : found + (forward ? 1 : -1);
  return next < 0 || next >= steps.length ? null : steps[next]!;
}

/** The word after the context: the phase, never the colour alone. */
function PhaseLabel({ phase }: { phase: ProjectionPhase }) {
  const t = useT();
  if (phase === "ended") {
    return (
      <span className="text-[clamp(13px,1.2vw,16px)] font-semibold text-fg-muted">
        {t("poll.ended")}
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

/** A display switch with its words beside it: a state, not an action. */
function DisplaySwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] font-medium text-fg-muted">
      <Switch label={label} checked={checked} onChange={onChange} />
      <span aria-hidden>{label}</span>
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
  display,
  onDisplay,
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
  /** What the wall shows; it stays where it was once the poll has ended. */
  /** What the wall and the phones show; both switches stay usable once ended. */
  display: PollDisplay;
  onDisplay: (change: Partial<PollDisplay>) => void;
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
   * already there on a beamer. An anonymous poll lives in no classroom: the
   * line says who may answer instead.
   */
  const context =
    view.evaluation.classroomName === null
      ? t("poll.audience.context")
      : `${view.evaluation.courseName ?? ""} · ${view.evaluation.classroomName}`;
  // An opinion poll has no answer to reveal, so it has no reveal switch
  // (ADR-014, addendum 2026-09-29).
  const keyed = hasKey(view.question);
  const waiting = waitingOf(view.tally);
  /*
   * "Keep this question" (ADR-014, addenda item 6). A question written in
   * the launcher is saved nowhere until the teacher says so. While the room
   * answers the offer is a bookmark icon — the wall is the room's, not the
   * teacher's; once the poll is over it is a secondary button beside "Run
   * again", then the place it went: "Kept in Polls", which opens it.
   */
  const { saved, pool } = view.question;
  const keptLabel = pool ? t("poll.keptIn", { pool: pool.name }) : null;

  return (
    <header className="flex flex-wrap items-start gap-[clamp(16px,2.4vw,32px)]">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4">
        {/* No menu on this screen (#157): the way out is the arrow before
            where we are, as on every page that has a way back. */}
        <span className="-mr-2 flex items-center">
          <IconButton
            label={view.evaluation.classroomId === null ? t("poll.backToPolls") : t("poll.back")}
            onClick={onBack}
          >
            <ArrowLeft />
          </IconButton>
        </span>
        <span className="text-[clamp(14px,1.4vw,18px)] font-semibold tracking-[-0.01em] text-fg-muted">
          {context}
        </span>
        <span className="size-1 rounded-full bg-fg-faint" aria-hidden />
        <PhaseLabel phase={phase} />
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {/* Two independent switches (ADR-014, addendum 2026-09-29): the
              votes, and the key. Neither closes the vote — End does. */}
          <DisplaySwitch
            label={t("poll.showVotes")}
            checked={display.votes}
            onChange={(votes) => onDisplay({ votes })}
          />
          {keyed ? (
            <DisplaySwitch
              label={t("poll.reveal")}
              checked={display.revealed}
              onChange={(revealed) => onDisplay({ revealed })}
            />
          ) : null}
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
          {!ended && !saved ? (
            <IconButton label={t("poll.keep")} onClick={onKeep} disabled={keepPending}>
              <BookmarkPlus />
            </IconButton>
          ) : null}
          {!ended && keptLabel ? (
            <IconButton label={keptLabel} onClick={onOpenQuestion}>
              <BookmarkCheck />
            </IconButton>
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
          {/* THE action while the room answers: only End closes the vote.
              Named, and confirmed — a slip here ends it for everyone. Beside
              it, who it would leave out. */}
          {ended ? null : (
            <span className="ml-2 inline-flex items-center gap-3">
              {waiting > 0 ? (
                <span className="text-[13px] text-fg-muted">
                  {t(waiting === 1 ? "poll.notYet.one" : "poll.notYet", { n: waiting })}
                </span>
              ) : null}
              <Button size="sm" onClick={onEnd}>
                <Square /> {t("poll.end")}
              </Button>
            </span>
          )}
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
