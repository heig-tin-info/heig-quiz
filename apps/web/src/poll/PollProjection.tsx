import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import type { PollTeacherView, WatchSubject } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { useEventStream } from "../realtime/useEventStream";
import type { Route } from "../router";
import { useProjectionTheme } from "../theme";
import { cx, isTyping, PageError, Skeleton, useFullscreen } from "../ui";
import { PollBars } from "./PollBars";
import { ProjectionFooter } from "./ProjectionFooter";
import { ProjectionHeader, projectionPhase } from "./ProjectionHeader";
import { hasKey, pollRows, PROJECTION_ROW_CAP, promptOf, questionScale } from "./pollTally";
import { useStageFit } from "./useStageFit";
import { pollKey } from "../queryKeys";

/**
 * The projection of a running poll (mockup 10, F-LIVE-13 / F-LIVE-14).
 *
 * It is the one screen of the product that is not a page: no sidebar, no
 * header, no content column. `App.tsx` renders it outside the Shell because
 * what it is FOR is a beamer at the back of a lecture hall, and the four
 * decisions follow from that distance:
 *
 *   - Type: the contrast is a size jump of about 4×. The question is
 *     `clamp(30px, 4.6vw, 68px)` and the context above it stays at reading
 *     size; every figure is mono and tabular so the bars do not jitter as
 *     the counts climb.
 *   - Color: ONE accent use — the "Live" pulse and the bar of an answer
 *     nobody has judged yet. Revealed, the key takes `success` (with a tick
 *     AND the word, never the colour alone) and everything else fades; no
 *     row ever turns red, because nobody in the room is being marked wrong.
 *   - Space: tight inside a choice (the bar sits under its own line),
 *     generous between the three bands of the screen (`clamp(24px, 3.5vh,
 *     48px)`): how to join, the question, and where the room is at.
 *   - Finish: full bleed. The only surfaces are the bar track and the white
 *     QR tile; the only hairline is that tile's.
 *
 * The way in — the host, the session code and the QR — lives in the TOP right
 * corner. It used to sit at the bottom right, under the distribution, which
 * is also where the app's toasts are pinned (`notify.tsx`, `fixed bottom-4
 * right-4`): a student joining mid-lecture threw a notice straight over the
 * code the rest of the room was trying to scan. The two corners are now
 * opposite ones, and neither has to know about the other.
 *
 * The one primary action is "Reveal the answer" while the poll runs, and
 * "Run again" once it has ended. Everything else is quiet, in the same top
 * strip, left of the QR: the teacher's hand is there and the room's eye is
 * not.
 *
 * And the middle band never scrolls. When a question with eight long choices
 * does not fit the wall, two things happen before anything is given up: the
 * bars go into two columns (`PollBars`), and `useStageFit` searches for the
 * widest layout the band can be drawn at, then draws it through one transform
 * (see `fit.ts`). Nothing is ever truncated and no scrollbar ever appears.
 *
 * Dark by default, like the mockup: a beamer throws light, so a white page
 * is the room's lighting. Only an explicit "light" already stored in this
 * browser keeps it light, and the toggle here writes that same choice.
 */

/**
 * The question and its distribution, laid out at whatever width the fit
 * asked for: the title, at most `PROJECTION_ROW_CAP` bars, and one muted line
 * counting the rest.
 */
function ProjectionQuestion({
  view,
  revealed,
}: {
  view: PollTeacherView;
  revealed: boolean;
}) {
  const t = useT();
  const allRows = useMemo(() => pollRows(view.question, view.tally), [view]);
  // No key, nothing to mark: the bars of an opinion poll stay as they are.
  const marked = revealed && hasKey(view.question);
  const rows = allRows.slice(0, PROJECTION_ROW_CAP);
  const overflow = allRows.length - rows.length;
  return (
    <>
      <h1
        className={cx(
          "max-w-[24ch] font-bold leading-[1.08] tracking-[-0.03em]",
          questionScale(promptOf(view.question)),
        )}
      >
        <MarkdownView source={promptOf(view.question)} inline />
      </h1>
      {rows.length === 0 ? (
        <p className="text-[clamp(16px,1.6vw,22px)] text-fg-muted">{t("poll.noAnswersYet")}</p>
      ) : (
        <>
          <PollBars rows={rows} revealed={marked} />
          {overflow > 0 ? (
            <p className="text-[clamp(13px,1.2vw,17px)] text-fg-faint">
              {t(overflow === 1 ? "poll.moreAnswers.one" : "poll.moreAnswers", { n: overflow })}
            </p>
          ) : null}
        </>
      )}
    </>
  );
}

export function PollProjection({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { dark, toggle: toggleTheme } = useProjectionTheme();
  const [fullscreen, toggleFullscreen] = useFullscreen();

  const key = pollKey(id);
  const poll = useQuery<PollTeacherView>({
    queryKey: key,
    queryFn: () => api(`/app/api/evaluations/${id}/poll`),
    // The stream carries every tally; this is only the net under it.
    refetchInterval: 30_000,
  });

  const watch = `evaluation:${id}` as WatchSubject;
  // The frames carry the evaluation's real id, which is what the route holds
  // too — except on a mock URL addressed by an alias, where the loaded view
  // is the one that knows it.
  const subject = poll.data?.evaluation.id ?? id;
  useEventStream({
    watch,
    onRefresh: () => void qc.invalidateQueries({ queryKey: key }),
    onEvent: (event) => {
      if (event.type === "poll.tally" && event.evaluationId === subject) {
        // The frame carries the WHOLE tally, so it replaces rather than
        // patches: a projection that missed one is right again on the next.
        qc.setQueryData<PollTeacherView>(key, (prev) =>
          prev ? { ...prev, tally: event.tally } : prev,
        );
      } else if (event.type === "evaluation.state" && event.evaluationId === subject) {
        qc.setQueryData<PollTeacherView>(key, (prev) =>
          prev ? { ...prev, evaluation: { ...prev.evaluation, state: event.state } } : prev,
        );
      }
    },
  });

  const view = poll.data ?? null;

  const act = useMutation({
    mutationFn: (v: { path: "reveal" | "end" | "again"; body?: unknown }) =>
      api<PollTeacherView>(`/app/api/evaluations/${id}/poll/${v.path}`, {
        method: "POST",
        body: JSON.stringify(v.body ?? {}),
      }),
    onSuccess: (data, v) => {
      if (v.path === "again") {
        // A new evaluation, same question: seed its cache so the beamer does
        // not blink through a loading state on the way there.
        qc.setQueryData(pollKey(data.evaluation.id), data);
        navigate({ view: "poll", id: data.evaluation.id });
        return;
      }
      qc.setQueryData(key, data);
    },
  });

  const revealed = view?.settings.revealed ?? false;
  const setRevealed = useCallback(
    (next: boolean) => act.mutate({ path: "reveal", body: { revealed: next } }),
    // `act` is rebuilt on every render; `mutate` itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const endPoll = useCallback(() => {
    void (async () => {
      if (
        await confirm({
          title: t("poll.endConfirm"),
          confirmLabel: t("poll.end"),
          cancelLabel: t("common.cancel"),
          danger: true,
        })
      ) {
        act.mutate({ path: "end" });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "r" && view !== null) {
        e.preventDefault();
        setRevealed(!revealed);
      } else if (k === "f") {
        e.preventDefault();
        toggleFullscreen();
      }
      // Escape is the browser's while it owns the full screen, and
      // `fullscreenchange` above is what tells us it left.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, view, setRevealed, toggleFullscreen]);

  const fit = useStageFit(view !== null);

  /*
   * A beamer is exactly one screen, so from `sm` up the stage IS the
   * viewport and never scrolls: the session code and the QR must stay on the
   * wall whatever the question costs. Only the middle band gives way, and it
   * gives way by SHRINKING (`useStageFit`) rather than by scrolling, so the
   * last bar of a long mcq is on the wall instead of under a scrollbar. A
   * phone is not a beamer and keeps a normal page.
   */
  const stage =
    "flex min-h-dvh flex-col gap-[clamp(24px,3.5vh,48px)] bg-canvas px-[clamp(16px,4vw,64px)] py-[clamp(20px,3vh,40px)] text-fg sm:h-dvh sm:min-h-0 sm:overflow-hidden";

  if (poll.isLoading) {
    return (
      <main className={stage} aria-busy>
        <Skeleton className="h-6 w-72" />
        <div className="flex flex-1 flex-col justify-center gap-8">
          <Skeleton className="h-16 w-4/5" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
        <Skeleton className="h-16 w-full" />
      </main>
    );
  }
  if (poll.isError || view === null) {
    return (
      <main className={cx(stage, "items-center justify-center")}>
        <div className="w-full max-w-130">
          <PageError
            title={t("poll.notFound")}
            error={poll.error}
            onRetry={() => void poll.refetch()}
            retrying={poll.isFetching}
            fallback={t("error.server")}
          />
        </div>
      </main>
    );
  }

  return (
    <main className={stage}>
      <ProjectionHeader
        view={view}
        phase={projectionPhase(view)}
        revealed={revealed}
        onReveal={setRevealed}
        onAgain={() => act.mutate({ path: "again" })}
        againPending={act.isPending}
        dark={dark}
        onToggleTheme={toggleTheme}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onEnd={endPoll}
        onBack={() => navigate({ view: "classroom", id: view.evaluation.classroomId })}
      />

      {/* Band 2 — the question and its distribution: the whole point. The
          outer box is the room the band has (and hides whatever leaves it);
          the middle box carries the height the transform actually DRAWS, so
          a shrunk block is still centred on what one sees rather than on the
          size it was laid out at; the inner one is what gets scaled. */}
      <div
        ref={fit.area}
        data-poll-band
        className="flex min-w-0 flex-1 flex-col justify-center sm:min-h-0 sm:overflow-hidden"
      >
        {/* `justify-center` on a box whose child is WIDER than it overflows it
            by the same amount on both sides, which is what puts the block's
            centre on the area's centre — and therefore what makes
            `transform-origin: top center` land it exactly on the wall. */}
        <div
          // `items-start`: a flex row stretches its items to its own height,
          // and a block stretched to the height this box was just given would
          // measure that height back on the next pass — the fit chasing its
          // own answer. The block keeps the height its content asks for.
          className="flex w-full items-start justify-center"
          style={fit.height === null ? undefined : { height: fit.height }}
        >
          <div
            ref={fit.content}
            data-poll-content
            // `shrink-0`: a widened block is wider than the box on purpose,
            // and a flex item that may shrink would be squeezed straight back
            // to the box's width, undoing the reflow the fit just bought.
            className="flex w-full shrink-0 flex-col gap-[clamp(20px,3.5vh,44px)]"
            style={{
              ...(fit.width === null ? null : { width: fit.width }),
              ...(fit.scale < 1
                ? { transform: `scale(${fit.scale})`, transformOrigin: "top center" }
                : null),
            }}
          >
            <ProjectionQuestion view={view} revealed={revealed} />
          </div>
        </div>
      </div>

      <ProjectionFooter tally={view.tally} anonymous={view.settings.anonymous} />
    </main>
  );
}
