import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Eye, EyeOff, ListChecks, Maximize2, Minimize2, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ByQuestion, EvaluationDetail } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { evaluationKey, resultsByQuestionKey } from "../queryKeys";
import type { Route } from "../router";
import { useProjectionTheme } from "../theme";
import {
  Button,
  cx,
  EmptyState,
  IconButton,
  isTyping,
  Kbd,
  PageError,
  Skeleton,
  useFullscreen,
} from "../ui";
import { isNotOver } from "./ByQuestionView";
import { CorrectionQuestion } from "./CorrectionQuestion";

/**
 * The correction of a graded evaluation, projected in class (F-RES-03,
 * ADR-033): the Results "Questions" tab on a beamer, fed by the same
 * endpoint and the same cache.
 *
 * One viewport-high section per question, snapped; ↑/↓ (PageUp/PageDown, the
 * presenter's clicker, j/k, space) walk them, a stepper of question numbers
 * jumps. Like the poll projection it is chrome-less and dark by default
 * (`useProjectionTheme`).
 *
 *   - Type: the projection's `clamp()` scale — the room reads it.
 *   - Color: one accent use, the primary "Reveal the answers". Green, red and
 *     amber are the verdicts, never a decoration.
 *   - Space: a screen per question; tight inside a choice, generous between
 *     the head, the statement and the answers.
 *   - Finish: hairlines between rows, thin bars, no card.
 *
 * The ONE primary action is revealing the answers (R): the screen opens with
 * the key and the verdicts hidden, so the room can think before it is told.
 * The explanation (E) is a second, quieter switch, offered only on a question
 * that has one.
 */
export function CorrectionProjection({
  evaluationId,
  navigate,
}: {
  evaluationId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const { dark, toggle: toggleTheme } = useProjectionTheme();
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const [revealed, setRevealed] = useState(false);
  const [explained, setExplained] = useState(false);
  const [current, setCurrent] = useState(0);

  const questions = useQuery<ByQuestion[]>({
    queryKey: resultsByQuestionKey(evaluationId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/results/by-question`),
  });
  // The title, and nothing else: the screen works without it.
  const evaluation = useQuery<EvaluationDetail>({
    queryKey: evaluationKey(evaluationId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}`),
    retry: false,
  });

  const list = questions.data ?? [];
  const scroller = useRef<HTMLElement>(null);
  const sections = useRef<(HTMLElement | null)[]>([]);

  const go = useCallback(
    (index: number) => {
      const target = Math.max(0, Math.min(list.length - 1, index));
      setCurrent(target);
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      sections.current[target]?.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" });
    },
    [list.length],
  );

  // Scrolled by hand (a wheel, a touchpad), the stepper follows the section
  // that holds the middle of the screen.
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setCurrent(sections.current.indexOf(entry.target as HTMLElement));
        }
      },
      { root, rootMargin: "-45% 0px -45% 0px" },
    );
    for (const section of sections.current) if (section) observer.observe(section);
    return () => observer.disconnect();
  }, [list.length]);

  const hasExplanation = list[current]?.explanation != null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (["arrowdown", "pagedown", "j", " "].includes(k)) {
        e.preventDefault();
        go(current + 1);
      } else if (["arrowup", "pageup", "k"].includes(k)) {
        e.preventDefault();
        go(current - 1);
      } else if (k === "r") {
        e.preventDefault();
        setRevealed((on) => !on);
      } else if (k === "e") {
        e.preventDefault();
        setExplained((on) => !on);
      } else if (k === "f") {
        e.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, go, toggleFullscreen]);

  const back = () => navigate({ view: "results", evaluationId });
  const title = evaluation.data?.evaluation.title;

  if (questions.isLoading) {
    return (
      <main className="flex h-dvh flex-col gap-8 bg-canvas p-[clamp(16px,4vw,64px)] text-fg" aria-busy>
        <Skeleton className="h-6 w-72" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-16 w-4/5" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </main>
    );
  }
  if (questions.isError) {
    // Before the close the server refuses (ADR-033): say so in the reader's
    // language rather than in the server's.
    const early = isNotOver(questions.error);
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas p-4 text-fg">
        <div className="w-full max-w-130">
          <PageError
            title={t("correction.loadFailed")}
            error={early ? null : questions.error}
            onRetry={() => void questions.refetch()}
            retrying={questions.isFetching}
            fallback={t(early ? "results.byQuestion.notOver" : "error.server")}
          />
        </div>
      </main>
    );
  }

  return (
    <main
      ref={scroller}
      className="h-dvh snap-y snap-proximity scroll-pt-16 overflow-y-auto bg-canvas text-fg"
    >
      <header className="sticky top-0 z-10 flex h-16 items-center gap-4 border-b border-line bg-canvas/90 px-6 backdrop-blur-sm max-sm:px-4">
        <span className="-ml-2 flex min-w-0 items-center gap-2">
          <IconButton label={t("correction.back")} onClick={back}>
            <ArrowLeft />
          </IconButton>
          <span className="truncate text-sm font-bold">
            {t("correction.title")}
            {title ? ` · ${title}` : null}
          </span>
        </span>
        <nav aria-label={t("correction.steps")} className="mx-auto flex gap-1.5 max-lg:hidden">
          {list.map((q, index) => (
            <button
              key={q.item.id}
              type="button"
              onClick={() => go(index)}
              aria-current={index === current ? "step" : undefined}
              aria-label={t("correction.question", { n: index + 1 })}
              className={cx(
                "grid size-8 place-items-center rounded-full text-xs font-semibold tabular-nums",
                index === current ? "bg-surface-3 text-fg" : "text-fg-faint hover:text-fg",
              )}
            >
              {index + 1}
            </button>
          ))}
        </nav>
        <span className="ml-auto flex items-center gap-2 lg:ml-0">
          {hasExplanation ? (
            <Button
              size="sm"
              variant="secondary"
              aria-pressed={explained}
              onClick={() => setExplained((on) => !on)}
            >
              {t("correction.explanation")}
            </Button>
          ) : null}
          <IconButton label={dark ? t("menu.lightTheme") : t("menu.darkTheme")} onClick={toggleTheme}>
            {dark ? <Sun /> : <Moon />}
          </IconButton>
          <IconButton
            label={fullscreen ? t("poll.exitFullscreen") : t("poll.fullscreen")}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
          <Button size="sm" onClick={() => setRevealed((on) => !on)}>
            {revealed ? <EyeOff /> : <Eye />} {t(revealed ? "correction.hide" : "correction.reveal")}
          </Button>
        </span>
      </header>

      {list.length === 0 ? (
        <div className="mx-auto max-w-130 p-8">
          <EmptyState icon={ListChecks} title={t("results.byQuestion.empty.title")}>
            {t("results.byQuestion.empty.body")}
          </EmptyState>
        </div>
      ) : (
        <div className="mx-auto max-w-[1280px] px-8 max-sm:px-4">
          {list.map((q, index) => (
            <section
              key={q.item.id}
              ref={(el) => {
                sections.current[index] = el;
              }}
              aria-label={t("correction.question", { n: index + 1 })}
              className="flex min-h-[calc(100dvh-4rem)] snap-start flex-col gap-7 border-b border-line pb-8 pt-10"
            >
              <CorrectionQuestion q={q} number={index + 1} revealed={revealed} explained={explained} />
              <footer className="mt-auto flex items-center justify-between gap-4 text-[13px] text-fg-faint max-sm:hidden">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Kbd>↓</Kbd> <Kbd>↑</Kbd> {t("correction.keys.move")} · <Kbd>R</Kbd>{" "}
                  {t("correction.keys.reveal")} · <Kbd>E</Kbd> {t("correction.keys.explanation")} ·{" "}
                  <Kbd>F</Kbd> {t("correction.keys.fullscreen")}
                </span>
                <span className="tabular-nums">
                  {index + 1} / {list.length}
                </span>
              </footer>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
