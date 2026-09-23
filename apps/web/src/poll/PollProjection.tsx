import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  EyeOff,
  Maximize2,
  Minimize2,
  Moon,
  RotateCcw,
  Square,
  Sun,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { PollTeacherView, WatchSubject } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { useEventStream } from "../realtime/useEventStream";
import type { Route } from "../router";
import { setThemeChoice, useThemeChoice } from "../theme";
import { Button, cx, IconButton, Menu, PageError, Ring, Segmented, Skeleton } from "../ui";
import { FIT_PROBES, fitScale, layoutWidthFor, nextProbe } from "./fit";
import { PollBars } from "./PollBars";
import { PollQr } from "./PollQr";
import {
  joinHost,
  pollRows,
  PROJECTION_ROW_CAP,
  promptOf,
  questionScale,
  waitingOf,
} from "./pollTally";
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

/** The states in which the poll is over and "Run again" is what is left. */
function isEnded(state: string): boolean {
  return state === "closed" || state === "grading" || state === "released";
}

/** A keystroke typed into a field is not a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

/**
 * Dark unless this browser explicitly asked for light. It toggles the class
 * directly rather than going through `applyTheme`, so leaving the projection
 * gives the rest of the app its own theme back without ever having persisted
 * the beamer's; the toggle button below is what persists a real choice.
 */
function useProjectionTheme(): { dark: boolean; toggle: () => void } {
  const choice = useThemeChoice();
  const dark = choice !== "light";
  useEffect(() => {
    const root = document.documentElement;
    const before = root.classList.contains("dark");
    const scheme = root.style.colorScheme;
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
    return () => {
      root.classList.toggle("dark", before);
      root.style.colorScheme = scheme;
    };
  }, [dark]);
  return { dark, toggle: () => setThemeChoice(dark ? "light" : "dark") };
}

/** The in-page and the browser full screen, together (the projector wants both). */
function useFullscreen(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const toggle = useCallback(() => {
    setOn((was) => {
      const ignore = () => {};
      try {
        if (!was) document.documentElement.requestFullscreen?.().catch(ignore);
        else if (document.fullscreenElement) document.exitFullscreen?.().catch(ignore);
      } catch {
        /* the in-page mode is enough */
      }
      return !was;
    });
  }, []);
  // Escape, F11 and the browser's own chrome all leave full screen without
  // telling us; the event is the only truth about it.
  useEffect(() => {
    const sync = () => setOn(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  return [on, toggle];
}

/**
 * The middle band, scaled so the whole of it is on the wall.
 *
 * A projection may not scroll: a bar below the fold is a bar nobody in the
 * room will ever see, and a scrollbar on a beamer is a bug the teacher
 * discovers in front of forty people. `questionScale()` steps the title down
 * by the length of the prompt, but the bars are what usually overflow — eight
 * choices of two lines each clear a 1280 × 720 projector on their own. So the
 * band is measured and, when it is too tall, drawn through one
 * `transform: scale()`; `fitScale()` holds the arithmetic and says why a
 * transform rather than a font size.
 *
 * `ready` is whether the band exists yet: the screen renders a skeleton and an
 * error state before it, and the observer has nothing to watch until then.
 */
function useStageFit(ready: boolean) {
  const area = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  /** `width` is the LAYOUT width in pixels, `null` meaning the area's own. */
  const [fit, setFit] = useState<{ scale: number; width: number | null; height: number | null }>({
    scale: 1,
    width: null,
    height: null,
  });

  const measure = useCallback(() => {
    const box = area.current;
    const block = content.current;
    if (box === null || block === null) return;
    const commit = (next: { scale: number; width: number | null; height: number | null }) => {
      // The probes above leave the block wherever the last measurement put it;
      // this is what puts it back where the render says it belongs, so the DOM
      // is right even when the state below turns out to be unchanged.
      block.style.width = next.width === null ? "" : `${next.width}px`;
      block.style.transform = next.scale < 1 ? `scale(${next.scale})` : "";
      setFit((prev) =>
        prev.scale === next.scale && prev.width === next.width && prev.height === next.height
          ? prev
          : next,
      );
    };

    // A phone is not a beamer. Below `sm` the stage is an ordinary page whose
    // middle band GROWS with its content, so a scale taken from it would chase
    // its own result down to nothing; there the page simply scrolls.
    const beamer =
      typeof window.matchMedia === "function" && window.matchMedia("(min-width: 640px)").matches;
    const availW = box.clientWidth;
    const availH = box.clientHeight;
    if (!beamer || availW <= 0 || availH <= 0) {
      commit({ scale: 1, width: null, height: null });
      return;
    }

    /*
     * The search. Every candidate is MEASURED rather than predicted, because
     * the height of a block is not a smooth function of its width: it steps
     * down each time a label stops wrapping. `offsetWidth`/`offsetHeight` are
     * layout sizes that a transform does not touch, which is what keeps the
     * measurement independent of the scale it produces.
     */
    block.style.transform = "none";
    // No inline width: the block falls back to `w-full`, which is the area's
    // own width — the layout the screen was designed at, and the only honest
    // starting point. (Without that class it would fall back to `max-content`,
    // and the search would start from a line length nobody has ever seen.)
    block.style.width = "";
    const natural = fitScale(block.offsetWidth, block.offsetHeight, availW, availH);
    if (natural >= 1) {
      commit({ scale: 1, width: null, height: null });
      return;
    }

    /*
     * `lo` is the largest scale whose layout has been MEASURED and does fit;
     * `hi` the smallest one known not to. The first candidate is the un-widened
     * fit, which cannot fail — the same block drawn on the same wall, only
     * laid out wider, is never taller — so the search always has an answer and
     * the worst case is exactly what a plain scale would have given.
     */
    let lo = natural;
    let hi = 1;
    let slack = 0;
    let best: { scale: number; width: number; height: number } | null = null;
    for (let probe = 0; probe < FIT_PROBES; probe += 1) {
      const candidate = probe === 0 ? natural : nextProbe(lo, hi, slack);
      if (probe > 0 && (candidate <= lo || candidate >= hi)) break;
      const width = layoutWidthFor(availW, candidate);
      block.style.width = `${width}px`;
      const drawn = block.offsetHeight * candidate;
      if (drawn <= availH) {
        lo = candidate;
        slack = availH / Math.max(1, drawn);
        best = { scale: candidate, width, height: Math.round(drawn) };
      } else {
        hi = candidate;
        slack = 0;
      }
    }
    commit(best ?? { scale: natural, width: layoutWidthFor(availW, natural), height: null });
  }, []);

  // After every commit: a new question, a reveal, one more tally frame — each
  // changes the height of the block, and each arrives through a render.
  useLayoutEffect(measure);

  useEffect(() => {
    const box = area.current;
    const block = content.current;
    if (typeof ResizeObserver !== "function" || box === null || block === null) return undefined;
    // Two boxes, one observer: the area moves when the projector does (full
    // screen, a resized window, a rotated display), the block when a web font
    // finally lands or a long label rewraps. The observer converges: `measure`
    // is a function of the area and of the text, so the layout it writes back
    // is the one it just measured, and the next notification changes nothing.
    const observer = new ResizeObserver(() => measure());
    observer.observe(box);
    observer.observe(block);
    return () => observer.disconnect();
  }, [measure, ready]);

  useEffect(() => {
    const onChange = () => measure();
    window.addEventListener("resize", onChange);
    // Leaving full screen through the browser's own chrome resizes nothing
    // the observer above can see until the next frame; this is that frame.
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
      document.removeEventListener("fullscreenchange", onChange);
    };
  }, [measure]);

  return { area, content, scale: fit.scale, width: fit.width, height: fit.height };
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
  const ended = view !== null && isEnded(view.evaluation.state);
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

  const allRows = useMemo(
    () => (view === null ? [] : pollRows(view.question, view.tally)),
    [view],
  );
  const rows = allRows.slice(0, PROJECTION_ROW_CAP);
  const overflow = allRows.length - rows.length;
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

  const { tally } = view;
  const waiting = waitingOf(tally);
  /*
   * "PRG1 · PRG1-2026", from the poll view itself: the course and the room
   * travel with `PollTeacherView.evaluation`. This screen used to fetch
   * `GET /classrooms/:id` for those two words — a second request, and a
   * second thing that can be in flight, on a page whose whole job is to be
   * already there on a beamer.
   */
  const context = `${view.evaluation.courseName} · ${view.evaluation.classroomName}`;

  return (
    <main className={stage}>
      {/* Band 1 — where we are, what state the room is in, and the way in.
          The join tile owns the top-right corner (the toasts own the bottom
          one); the controls sit in the left column, pushed against it. */}
      <header className="flex flex-wrap items-start gap-[clamp(16px,2.4vw,32px)]">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4">
          <span className="text-[clamp(14px,1.4vw,18px)] font-semibold tracking-[-0.01em] text-fg-muted">
            {context}
          </span>
          <span className="size-1 rounded-full bg-fg-faint" aria-hidden />
          {ended ? (
            <span className="text-[clamp(13px,1.2vw,16px)] font-semibold text-fg-muted">
              {t("poll.ended")}
            </span>
          ) : revealed ? (
            <span className="inline-flex items-center gap-1.5 text-[clamp(13px,1.2vw,16px)] font-semibold text-success">
              <Check className="size-[1.1em]" aria-hidden />
              {t("poll.revealed")}
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 text-[clamp(13px,1.2vw,16px)] font-semibold text-accent">
              <span className="size-2.5 animate-pulse rounded-full bg-accent" aria-hidden />
              {t("poll.live")}
            </span>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <Segmented
              name="poll-reveal"
              value={revealed ? "revealed" : "live"}
              onChange={(v) => setRevealed(v === "revealed")}
              options={[
                { value: "live", label: t("poll.live") },
                { value: "revealed", label: t("poll.reveal") },
              ]}
            />
            {ended ? (
              <Button size="sm" onClick={() => act.mutate({ path: "again" })} loading={act.isPending}>
                <RotateCcw /> {t("poll.again")}
              </Button>
            ) : null}
            <IconButton
              label={dark ? t("menu.lightTheme") : t("menu.darkTheme")}
              onClick={toggleTheme}
            >
              {dark ? <Sun /> : <Moon />}
            </IconButton>
            <IconButton
              label={fullscreen ? t("poll.exitFullscreen") : t("poll.fullscreen")}
              onClick={toggleFullscreen}
            >
              {fullscreen ? <Minimize2 /> : <Maximize2 />}
            </IconButton>
            <Menu
              label={t("common.actions")}
              items={[
                ...(ended
                  ? []
                  : [{ label: t("poll.end"), icon: Square, danger: true, onSelect: endPoll }]),
                {
                  label: t("poll.back"),
                  separator: !ended,
                  onSelect: () =>
                    navigate({ view: "classroom", id: view.evaluation.classroomId }),
                },
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
                <PollBars rows={rows} revealed={revealed} />
                {overflow > 0 ? (
                  <p className="text-[clamp(13px,1.2vw,17px)] text-fg-faint">
                    {t(overflow === 1 ? "poll.moreAnswers.one" : "poll.moreAnswers", { n: overflow })}
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Band 3 — where the room is at. The way in left this corner for the
          top one, out of the toasts' way. */}
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
            {view.settings.anonymous ? (
              <span className="mt-1 flex items-center gap-1.5 text-[clamp(12px,1.1vw,15px)] text-fg-faint">
                <EyeOff className="size-[1.1em]" aria-hidden />
                {t("poll.noNames")}
              </span>
            ) : null}
          </span>
        </div>
      </div>
    </main>
  );
}
