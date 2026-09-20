import { History, PencilLine, RefreshCcw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { GradingHistoryEntry } from "@quiz/contracts";

import { useT } from "../i18n";
import { Badge, Button, cx, isoDateTime, useEscape, Z } from "../ui";
import { round2, sourceLabel, stateLabel, stateTone } from "./labels";

/**
 * The gradings a cell went through, newest first (deviation W6-19): who
 * graded it, for how many points, and — when a pass re-graded it — the note
 * that pass carried (F-GRADE-06).
 *
 * A popover and not a sheet: it is something to glance at while the answer
 * stays on screen, it holds nothing the reader typed, and the sheet is
 * already taken by the adjustment form the button next to it opens.
 */
export function HistoryPopover({ history }: { history: GradingHistoryEntry[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEscape(() => {
    setOpen(false);
    wrapper.current?.querySelector("button")?.focus();
  }, open);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={wrapper} className="relative">
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <History /> {t("grading.history.open", { n: history.length })}
      </Button>
      {open ? (
        <div
          ref={panel}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={cx(
            "absolute right-0 top-full mt-1.5 w-80 rounded-menu border border-line bg-surface p-3 shadow-popover focus:outline-none",
            Z.popover,
          )}
        >
          <p id={titleId} className="text-[13px] font-semibold">
            {t("grading.history.title")}
          </p>
          {history.length === 0 ? (
            <p className="mt-2 text-xs text-fg-muted">{t("grading.history.empty")}</p>
          ) : (
            <ul className="mt-2 max-h-72 space-y-2 overflow-y-auto">
              {history.map((h) => (
                <li key={h.id} className="border-t border-line pt-2 first:border-t-0 first:pt-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold tabular-nums">
                      {t("grading.score", { points: round2(h.points), max: round2(h.maxPoints) })}
                    </span>
                    <Badge tone={stateTone(h.state)}>{stateLabel(t, h.state)}</Badge>
                    {h.source === "manual" ? (
                      <Badge tone="accent" icon={PencilLine}>
                        {t("grading.history.edited")}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-fg-faint">
                    {sourceLabel(t, h.source)} · {isoDateTime(h.gradedAt)}
                  </p>
                  {h.regradeNote ? (
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-fg-muted">
                      <RefreshCcw className="mt-0.5 size-3 shrink-0" />
                      {t("grading.history.regrade", { note: h.regradeNote })}
                    </p>
                  ) : null}
                  {h.comment ? <p className="mt-1 text-xs text-fg-muted">{h.comment}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
