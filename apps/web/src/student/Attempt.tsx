/**
 * `/take/:evaluationId` — the one student route the server routes itself.
 *
 * `POST /evaluations/:id/attempt` is idempotent (`INSERT … ON CONFLICT DO
 * NOTHING`) and answers `{ kind: "lobby" | "attempt", view }` (deviation
 * W5-14): the client never decides whether an evaluation has started, it asks
 * and renders what came back. A reload of this URL therefore lands exactly
 * where the student was — the lobby before the start, their own answers and
 * their own position after (F-LIVE-06).
 *
 * The three refusals of §4.4 each have a screen: an access code to type, a
 * network that is not allowed, and an evaluation that is not open.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { KeyRound, Lock, UserX } from "lucide-react";

import type { AttemptOrLobby } from "@quiz/contracts";

import { ApiError, api, useMe } from "../api";
import { feedbackLink } from "../grading";
import { useT } from "../i18n";
import type { Route } from "../router";
import { leaveStudentView, studentViewOn } from "../studentView";
import { Button, Card, EmptyState, Field, QueryError, Spinner } from "../ui";
import { Lobby } from "./Lobby";
import { Player } from "./Player";

const errorCode = (error: unknown): string | null =>
  error instanceof ApiError ? ((error.body as { error?: string })?.error ?? null) : null;

export function AttemptPage({
  evaluationId,
  navigate,
}: {
  evaluationId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  // Only to decide whether the refusal below may say the word "seat": a
  // student can do nothing about one, and the 404 is deliberately the same
  // answer a stranger to the classroom gets (invariant 6).
  const me = useMe();
  const staff = me.data?.role === "teacher" || me.data?.role === "admin";
  const [accessCode, setAccessCode] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  const entry = useQuery<AttemptOrLobby>({
    queryKey: ["attempt", "enter", evaluationId, sent],
    // A refusal the server SPELLS OUT (a wrong access code, a blocked network,
    // an evaluation that is not open) has its own screen below and must never
    // be retried. A failure with no answer at all — the socket died, a proxy
    // dropped the request — is worth three goes before the student is shown a
    // dead end: this is the door to an exam, and the alternative is a page
    // that says "the server did not answer" over one lost packet.
    retry: (count, error) => !(error instanceof ApiError) && count < 3,
    retryDelay: (count) => Math.min(500 * 2 ** count, 4_000),
    // A POST behind a query: the route is idempotent by design, and this is
    // the only way the same refetch path serves the lobby and the player.
    queryFn: () =>
      api<AttemptOrLobby>(`/app/api/evaluations/${evaluationId}/attempt`, {
        method: "POST",
        body: JSON.stringify(sent === null ? {} : { accessCode: sent }),
      }),
  });

  const home = () => navigate({ view: "home" });
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

  if (entry.isError) {
    const code = errorCode(entry.error);
    if (code === "access_code_invalid") {
      return (
        <main className="mx-auto w-full max-w-115 px-4 py-16">
          <Card className="px-6 py-6">
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                setSent(accessCode.trim());
              }}
            >
              <div className="flex items-center gap-2">
                <KeyRound className="size-5 text-fg-faint" aria-hidden />
                <h1 className="text-lg font-bold tracking-tight">{t("player.accessCode")}</h1>
              </div>
              <Field
                label={t("player.accessCode")}
                fullWidth
                value={accessCode}
                autoFocus
                autoComplete="off"
                onChange={(e) => setAccessCode(e.target.value)}
              />
              <p className="-mt-2 text-[13px] text-fg-faint">{t("player.accessCodeHint")}</p>
              {sent === null ? null : (
                <p className="text-[13px] text-danger">{t("player.accessCodeInvalid")}</p>
              )}
              <Button type="submit" variant="primary" disabled={accessCode.trim().length === 0}>
                {t("player.enter")}
              </Button>
            </form>
          </Card>
        </main>
      );
    }
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
        <QueryError
          title={t("player.loadFailed")}
          error={entry.error}
          onRetry={() => void entry.refetch()}
          retrying={entry.isFetching}
          fallback={t("error.server")}
        />
      </main>
    );
  }

  const data = entry.data!;
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
      initial={data.view}
      onHome={home}
      onResults={(attemptId) => navigate(feedbackLink(attemptId).route)}
      {...(exitStudentView ? { onExitStudentView: exitStudentView } : {})}
    />
  );
}
