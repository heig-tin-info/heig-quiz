import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import { questionType } from "../questionTypes";
import { cx, Z } from "../ui";
import { answerText, CODE_LINES, isEmptyAnswerText, type AnswerText } from "./answerText";
import { useAttemptInspect } from "./useAttemptInspect";

/**
 * The quick look at one cell of the live grid (#94): the student's complete
 * answer to that question, in a tooltip, without opening their paper.
 *
 * Three decisions:
 *   - it is FETCHED, not carried. The dashboard payload holds a 24-character
 *     summary per cell on purpose (thirty students by twelve questions, walked
 *     forward by SSE); the full answer is read on demand from the endpoint the
 *     inspection modal already uses, through the same query and key
 *     (`useAttemptInspect`), so a tooltip read on the way to a click makes the
 *     modal open filled. `useDashboard` invalidates that entry on every
 *     `dashboard.cell` frame of the attempt, so the tooltip never shows an
 *     answer older than its own cell;
 *   - it waits. 300 ms of hover before anything is asked, because a pointer
 *     crossing the grid on its way elsewhere brushes twenty cells; a keyboard
 *     focus opens it at once, since tabbing onto a cell IS the request;
 *   - it is a tooltip, not a panel: nothing in it is interactive, it never
 *     takes the focus, it hangs in a portal (`position: fixed`, no layout
 *     shift), it is capped in both directions, Escape dismisses it (WCAG
 *     1.4.13) and it describes the cell through `aria-describedby`. Clicking
 *     the cell still opens the modal, which is where everything is read.
 */

/** Hover delay before the tooltip opens (and before anything is fetched). */
export const ANSWER_TIP_DELAY = 300;

/** What the bubble is assumed to need below the cell before it opens upward. */
const ROOM_BELOW = 280;
const MARGIN = 8;

export function AnswerTip({
  evaluationId,
  attemptId,
  itemId,
  fallback,
  revision,
  enabled,
  children,
}: {
  evaluationId: string;
  attemptId: string | null;
  itemId: string;
  /** The cell's own summary, shown when the answer has no richer rendering. */
  fallback: string;
  /** The cell's revision: a paper older than this is not shown. */
  revision: number;
  /**
   * Whether the tooltip exists at all (answers shown, an answer in the cell).
   * The wrapper is rendered EITHER WAY, so that the cell's button keeps its
   * identity — and the keyboard focus — the moment a first answer arrives or
   * the answers are toggled.
   */
  enabled: boolean;
  /** The cell, handed the tooltip's id while it is shown. */
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A pointer is pressing the cell: the focus that press gives is not a request. */
  const pressing = useRef(false);
  const id = useId();

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const hide = useCallback(() => {
    clearTimer();
    setPos(null);
  }, []);
  const show = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom >= ROOM_BELOW || rect.top < ROOM_BELOW;
    setPos(
      below
        ? { left: rect.left, top: rect.bottom + 6 }
        : { left: rect.left, bottom: window.innerHeight - rect.top + 6 },
    );
  };

  useEffect(() => () => clearTimer(), []);
  // Switched off while open (the answers hidden before projecting): gone at once.
  useEffect(() => {
    if (!enabled) hide();
  }, [enabled, hide]);

  // Escape dismisses without moving the focus; the page scrolling or the grid
  // scrolling sideways leaves fixed coordinates pointing at nothing.
  const open = pos !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  // Kept inside the viewport once its width is known.
  useLayoutEffect(() => {
    const el = bubble.current;
    if (!el || !pos) return;
    const clamp = () => {
      const width = el.offsetWidth;
      const max = window.innerWidth - MARGIN - width;
      el.style.left = `${Math.max(MARGIN, Math.min(pos.left, max))}px`;
    };
    clamp();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    return () => observer.disconnect();
  }, [pos]);

  return (
    <span
      ref={anchor}
      className="block"
      onMouseEnter={() => {
        if (!enabled) return;
        clearTimer();
        timer.current = setTimeout(show, ANSWER_TIP_DELAY);
      }}
      onMouseLeave={() => {
        pressing.current = false;
        hide();
      }}
      onMouseDown={() => {
        pressing.current = true;
        hide();
      }}
      onFocus={() => {
        if (!enabled || pressing.current) return;
        clearTimer();
        show();
      }}
      onBlur={hide}
      onClick={() => {
        pressing.current = false;
        hide();
      }}
    >
      {children(open ? id : undefined)}
      {pos && enabled && attemptId !== null
        ? createPortal(
            <div
              ref={bubble}
              id={id}
              role="tooltip"
              className={cx(
                "tip-bubble pointer-events-none fixed max-h-96 w-max max-w-[min(32rem,calc(100vw-16px))] overflow-hidden rounded-menu border border-line bg-surface px-3 py-2 text-[13px] text-fg shadow-popover",
                pos.top !== undefined ? "origin-top-left" : "origin-bottom-left",
                Z.tooltip,
              )}
              style={{ left: pos.left, top: pos.top, bottom: pos.bottom }}
            >
              <AnswerTipBody
                evaluationId={evaluationId}
                attemptId={attemptId}
                itemId={itemId}
                fallback={fallback}
                revision={revision}
              />
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

/** The content, mounted only while the tooltip is shown: that is what fetches. */
function AnswerTipBody({
  evaluationId,
  attemptId,
  itemId,
  fallback,
  revision,
}: {
  evaluationId: string;
  attemptId: string;
  itemId: string;
  fallback: string;
  revision: number;
}) {
  const t = useT();
  const inspect = useAttemptInspect(evaluationId, attemptId);
  const entry = inspect.data?.items.find((i) => i.item.id === itemId);
  /*
   * The cached paper is older than the cell: the student wrote since it was
   * read (the dashboard only MARKS it stale). Showing it would put the old
   * answer beside the new summary, so it is re-read, and the tooltip says
   * so meanwhile.
   */
  const behind = entry !== undefined && entry.revision < revision;
  // Once per revision: a server that answers with the same paper again is
  // not asked in a loop — its answer is then shown as it is.
  const triedFor = useRef<number | null>(null);
  const { refetch, isFetching } = inspect;
  useEffect(() => {
    if (!behind || isFetching || triedFor.current === revision) return;
    triedFor.current = revision;
    void refetch();
  }, [behind, isFetching, refetch, revision]);
  const waiting = behind && (isFetching || triedFor.current !== revision);
  if (inspect.data === undefined || (waiting && !inspect.isError)) {
    return (
      <p className="text-fg-muted">
        {inspect.isError ? t("live.tip.failed") : t("live.tip.loading")}
      </p>
    );
  }
  if (!entry || entry.answer === null) return <p className="text-fg-muted">{t("live.tip.empty")}</p>;
  const text = answerText(entry.item.type, entry.studentConfig, entry.answer);
  if (text === null) {
    // A shape the tooltip does not read (a schematic): the type's own one-line
    // rendering, else the cell's summary. Still more than nothing.
    return <p className="whitespace-pre-wrap break-words">{typeSummary(entry) ?? fallback}</p>;
  }
  if (isEmptyAnswerText(text)) {
    return (
      <p className="text-fg-muted">
        {text.kind === "choices" ? t("live.tip.noChoice") : t("live.tip.empty")}
      </p>
    );
  }
  return <AnswerTextView text={text} />;
}

function typeSummary(entry: { item: { type: string }; studentConfig: unknown; answer: unknown }) {
  try {
    const summary = questionType(entry.item.type)?.summarize(entry.answer, entry.studentConfig);
    return summary && summary !== "—" ? summary : null;
  } catch {
    return null;
  }
}

function AnswerTextView({ text }: { text: AnswerText }) {
  const t = useT();
  switch (text.kind) {
    case "choices":
      return (
        <ul className="space-y-1">
          {text.items.map((item) => (
            <li key={item.letter} className="flex gap-2">
              <span className="w-4 shrink-0 font-mono text-xs font-semibold leading-5 text-fg-muted">
                {item.letter}
              </span>
              <span className="line-clamp-3 break-words">{item.text}</span>
            </li>
          ))}
        </ul>
      );
    case "blanks":
      return (
        <ol className="space-y-1">
          {text.items.map((value, index) => (
            <li key={index} className="flex gap-2">
              <span className="shrink-0 text-xs leading-5 text-fg-faint tabular-nums">
                {t("live.tip.blank", { n: index + 1 })}
              </span>
              {value === null ? (
                <span className="text-fg-faint">{t("live.tip.emptyBlank")}</span>
              ) : (
                <span className="line-clamp-2 break-words font-medium">{value}</span>
              )}
            </li>
          ))}
        </ol>
      );
    case "text":
      return (
        <>
          <p className="line-clamp-[12] whitespace-pre-wrap break-words">{text.text}</p>
          {text.truncated ? <p className="mt-1 text-xs text-fg-faint">{t("live.tip.clipped")}</p> : null}
        </>
      );
    case "code":
      return (
        <>
          <pre className="overflow-hidden whitespace-pre font-mono text-xs leading-snug">
            {text.lines.join("\n")}
          </pre>
          {text.truncated ? (
            <p className="mt-1 text-xs text-fg-faint">{t("live.tip.more", { n: CODE_LINES })}</p>
          ) : null}
        </>
      );
  }
}
