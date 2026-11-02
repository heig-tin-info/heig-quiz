/**
 * `/take/:evaluationId` — the one student route the server routes itself.
 *
 * `POST /evaluations/:id/attempt` is idempotent and answers
 * `{ kind: "lobby" | "ready" | "attempt", view }` (deviation W5-14): the
 * client never decides whether an evaluation has started, it asks and renders
 * what came back. A reload of this URL therefore lands exactly where the
 * student was — the lobby before the start, the ready screen on a running
 * evaluation they have not started, their own answers and their own position
 * after (F-LIVE-06).
 *
 * Opening the route never starts an attempt (ADR-076, issue #525): `ready`
 * writes nothing, and the clock begins when the student presses Start on it
 * (`POST …/attempt/start`, whose answer replaces this query's data). Only a
 * `seb` or `kiosk` session, whose pairing already was the act, is answered
 * with the attempt directly.
 *
 * The refusals of §4.4 each have a screen: a network that is not allowed and
 * an evaluation that is not open. There is no access code to type (ADR-053).
 */
import { useQuery } from "@tanstack/react-query";
import { Lock, UserX } from "lucide-react";

import type { AttemptEntry, PracticeEntry, PracticeRefusalReason } from "@quiz/contracts";

import { ApiError, api, refusalCodeOf, useMe } from "../api";
import { feedbackLink } from "../grading";
import { useT, type Dict } from "../i18n";
import type { Navigate } from "../router";
import { leaveStudentView, studentViewOn } from "../studentView";
import { Button, Card, EmptyState, QueryError, Spinner } from "../ui";
import { Lobby } from "./Lobby";
import { Player } from "./Player";
import { Ready } from "./Ready";
import { attemptEntryKey, practiceEntryKey } from "../queryKeys";
import { toKiosk } from "../kiosk/navigation";

export function AttemptPage({
  evaluationId,
  navigate,
}: {
  evaluationId: string;
  navigate: Navigate;
}) {
  const t = useT();
  // Only to decide whether the refusal below may say the word "seat": a
  // student can do nothing about one, and the 404 is deliberately the same
  // answer a stranger to the classroom gets (invariant 6).
  const me = useMe();
  const staff = me.data?.role === "teacher" || me.data?.role === "admin";

  const entry = useQuery<AttemptEntry>({
    queryKey: attemptEntryKey(evaluationId),
    // A refusal the server SPELLS OUT (a blocked network, an evaluation that
    // is not open) has its own screen below and must never be retried. A
    // failure with no answer at all — the socket died, a proxy
    // dropped the request — is worth three goes before the student is shown a
    // dead end: this is the door to an exam, and the alternative is a page
    // that says "the server did not answer" over one lost packet.
    retry: (count, error) => !(error instanceof ApiError) && count < 3,
    retryDelay: (count) => Math.min(500 * 2 ** count, 4_000),
    // A POST behind a query: the route is idempotent by design, and this is
    // the only way the same refetch path serves the lobby and the player.
    queryFn: () =>
      api<AttemptEntry>(`/app/api/evaluations/${evaluationId}/attempt`, { method: "POST" }),
  });

  // ADR-051 §7: a kiosk station has no home but its own screen.
  const kind = me.data?.session?.kind;
  const station = kind === "kiosk";
  // ADR-051, ADR-027: the trusted client the attempt is sat in, if any.
  const confinement = kind === "kiosk" || kind === "seb" ? kind : undefined;
  const home = station ? toKiosk : () => navigate({ view: "home" });
  /*
   * The one way out of the student view from inside an attempt (ADR-018
   * addendum). This route renders OUTSIDE the Shell — an exam is the one
   * screen the rest of the app must go away from — so the frame's switch is
   * not on it, and a teacher walking their own test would otherwise have to
   * leave the attempt first. It is `undefined` for everybody else, and a
   * student's switch is never on.
   */
  const exitStudentView = studentViewOn() ? () => navigate(leaveStudentView()) : undefined;

  if (entry.isLoading) return <Spinner label={t("player.loading")} className="py-24" />;

  // A failed background read must not unmount the player and discard its
  // unacknowledged answers. An explicit access refusal still takes it away.
  const transient = !(entry.error instanceof ApiError) || entry.error.status >= 500;
  if (entry.isError && (!entry.data || !transient)) {
    const code = refusalCodeOf(entry.error);
    /*
     * The refusals that are an ANSWER and not a failure: retrying changes
     * nothing, so each one gets a screen with the one way out. `not_found`
     * joined them because this route is now reachable from the frame's view
     * switch: a teacher who flips it on an evaluation of a classroom they
     * hold no seat in used to land on a retry loop, outside the Shell, with
     * nothing on screen to leave by (ADR-018 addendum).
     */
    if (
      code === "ip_not_allowed" ||
      code === "not_open" ||
      code === "not_implemented" ||
      code === "not_found"
    ) {
      const missing = code === "not_found";
      return (
        <main className="mx-auto w-full max-w-160 px-4 py-16">
          <Card className="px-6 py-4">
            <EmptyState
              icon={missing ? UserX : Lock}
              title={
                missing
                  ? t("player.notAvailable")
                  : code === "ip_not_allowed"
                    ? t("player.ipBlocked")
                    : t("player.notOpen")
              }
              action={
                <Button variant="primary" onClick={home}>
                  {t("player.closed.home")}
                </Button>
              }
            >
              {missing && staff ? t("player.noSeatHint") : null}
            </EmptyState>
          </Card>
        </main>
      );
    }
    return (
      <main className="mx-auto w-full max-w-160 px-4 py-16">
        <QueryError title={t("player.loadFailed")} query={entry} />
      </main>
    );
  }

  const data = entry.data!;
  if (data.kind === "ready") return <Ready view={data.view} onLater={home} />;
  if (data.kind === "lobby") {
    return (
      <Lobby
        view={data.view}
        onStart={() => void entry.refetch()}
        onLeave={home}
      />
    );
  }
  return (
    <Player
      // One player per attempt: `useAttempt` binds its state, its autosave
      // and its stream topic to the attempt it mounted with. A retake answers
      // this route with ANOTHER attempt (F-EVAL-15), and it must get a fresh
      // player, not the closed screen of the previous one (issue #120).
      key={data.view.attempt.id}
      initial={data.view}
      onHome={home}
      onResults={(attemptId, options) => navigate(feedbackLink(attemptId).route, options)}
      confinement={confinement}
      {...(exitStudentView ? { onExitStudentView: exitStudentView } : {})}
    />
  );
}

/** Why a practice attempt may not start, in the student's words (ADR-122). */
const PRACTICE_REFUSED: Record<PracticeRefusalReason, keyof Dict> = {
  hidden: "practice.refused.hidden",
  not_over: "practice.refused.not_over",
  archived: "practice.refused.archived",
  unfinished: "practice.refused.unfinished",
};

/**
 * `/take/:evaluationId/practice` — a practice attempt on an exercise that is
 * over (ADR-122). `POST /evaluations/:id/practice` writes nothing: it answers
 * the unfinished practice attempt, resumed, or the ready screen of a new one,
 * whose Start creates it. The player is the attempt's own, keyed on the
 * attempt: a new practice attempt gets a fresh one. A refusal the server
 * spells out (`practice_refused`, a network that is not allowed, no seat) has
 * its screen, with the one way home.
 */
export function PracticePage({ evaluationId, navigate }: { evaluationId: string; navigate: Navigate }) {
  const t = useT();
  const entry = useQuery<PracticeEntry>({
    queryKey: practiceEntryKey(evaluationId),
    retry: (count, error) => !(error instanceof ApiError) && count < 3,
    queryFn: () => api<PracticeEntry>(`/app/api/evaluations/${evaluationId}/practice`, { method: "POST" }),
  });
  const home = () => navigate({ view: "home" });

  if (entry.isLoading) return <Spinner label={t("player.loading")} className="py-24" />;

  const transient = !(entry.error instanceof ApiError) || entry.error.status >= 500;
  if (entry.isError && (!entry.data || !transient)) {
    const code = refusalCodeOf(entry.error);
    if (code === "practice_refused" || code === "ip_not_allowed" || code === "not_found") {
      const reason = (entry.error as ApiError).body as { reason?: PracticeRefusalReason } | null;
      const title =
        code === "practice_refused" && reason?.reason
          ? t(PRACTICE_REFUSED[reason.reason])
          : code === "ip_not_allowed"
            ? t("player.ipBlocked")
            : t("player.notAvailable");
      return (
        <main className="mx-auto w-full max-w-160 px-4 py-16">
          <Card className="px-6 py-4">
            <EmptyState
              icon={code === "not_found" ? UserX : Lock}
              title={title}
              action={
                <Button variant="primary" onClick={home}>
                  {t("player.closed.home")}
                </Button>
              }
            />
          </Card>
        </main>
      );
    }
    return (
      <main className="mx-auto w-full max-w-160 px-4 py-16">
        <QueryError title={t("player.loadFailed")} query={entry} />
      </main>
    );
  }

  const data = entry.data!;
  if (data.kind === "ready") return <Ready view={data.view} onLater={home} practice />;
  return (
    <Player
      key={data.view.attempt.id}
      initial={data.view}
      onHome={home}
      onResults={(attemptId, options) => navigate(feedbackLink(attemptId).route, options)}
    />
  );
}
