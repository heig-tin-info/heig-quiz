import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Lightbulb, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Me } from "@quiz/contracts";

import { api, useMePatch } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { meKey } from "../queryKeys";
import type { Route } from "../router";
import { Button, cx, modKey, Z } from "../ui";
import { nudgeFor, toursFor, type Audience, type CoachStep } from "./catalog";
import { THRESHOLDS, watchHesitation } from "./hesitation";
import { place } from "./placement";

/**
 * The coach marks (DESIGN.md "Coach marks", `catalog.ts` for what they say).
 *
 * Mounted once beside the frame, never on a full-screen view: an exam, a
 * projection or a join page gets no bubble, by construction. It watches the
 * route; when a screen is reached it waits for the page to settle, then walks
 * the steps of the frame and of the screen the reader has not read yet. While
 * the reader stays on a screen it watches for hesitation and offers that
 * screen's nudge.
 *
 * It never blocks: no backdrop, no focus taken, the page stays usable under
 * it. A dialog opening hides it until the dialog closes.
 */

type Active = { kind: "tour" | "nudge"; steps: CoachStep[]; index: number };

/** The first VISIBLE match: a sidebar row hidden on a phone is no target. */
export function findTarget(selector: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && !el.closest("[aria-hidden=true], [inert]")) return el;
  }
  return null;
}

const modalOpen = () => document.querySelector('[aria-modal="true"]') != null;

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How long a screen gets to draw itself before its tour starts. */
const SETTLE_MS = 900;
/** And how long the layer waits for a first target before giving up. */
const WAIT_MS = 8_000;

/**
 * What this account has read: the server's set, plus what was read in this
 * tab and not yet reported. Reports are batched (one POST per burst of
 * clicks) and merged server-side.
 */
function useSeen(me: Me) {
  const qc = useQueryClient();
  const server = me.coach?.seen;
  const [local, setLocal] = useState<ReadonlySet<string>>(() => new Set());
  const [epoch, setEpoch] = useState(0);
  const pending = useRef(new Set<string>());
  const timer = useRef<number | undefined>(undefined);

  // "Show the tips again" empties the server's set: forget the local one too,
  // and let the screen on display play its tour again.
  const emptied = (server?.length ?? 0) === 0;
  useEffect(() => {
    if (!emptied) return;
    setLocal(new Set());
    setEpoch((e) => e + 1);
  }, [emptied]);

  const seen = useMemo(() => new Set([...(server ?? []), ...local]), [server, local]);

  const flush = useCallback(async () => {
    const ids = [...pending.current];
    pending.current.clear();
    if (ids.length === 0) return;
    try {
      const res = await api<{ seen: string[] }>("/app/api/me/coach", {
        method: "POST",
        body: JSON.stringify({ seen: ids }),
      });
      qc.setQueryData<Me | null>(meKey, (m) => (m ? { ...m, coach: { ...m.coach, seen: res.seen } } : m));
    } catch {
      // A report lost is a bubble shown twice, which is not worth a toast.
    }
  }, [qc]);

  const mark = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      setLocal((prev) => new Set([...prev, ...ids]));
      for (const id of ids) pending.current.add(id);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 400);
    },
    [flush],
  );
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );
  return { seen, mark, epoch };
}

export function CoachLayer({
  me,
  view,
  teacherUi,
}: {
  me: Me;
  view: Route["view"];
  teacherUi: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const save = useMePatch();
  const enabled = me.coach?.enabled !== false;
  const audience: Audience = teacherUi ? "teacher" : "student";
  const { seen, mark, epoch } = useSeen(me);
  const [active, setActive] = useState<Active | null>(null);
  const [leaving, setLeaving] = useState(false);
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const activeRef = useRef(active);
  activeRef.current = active;

  // A screen reached: its tour, once the page has drawn something to point at.
  useEffect(() => {
    setActive(null);
    setLeaving(false);
    if (!enabled) return;
    const unread = toursFor(view, audience)
      .flatMap((tour) => tour.steps)
      .filter((s) => !seenRef.current.has(s.id));
    if (unread.length === 0) return;
    let timer: number | undefined;
    const started = Date.now();
    const attempt = () => {
      // A target in the page but hidden (the sidebar, on a phone) leaves the
      // walk, unread, for the day it shows; one not drawn YET stays in it,
      // because the list it lives in may still be loading.
      const steps = unread.filter(
        (s) => !document.querySelector(s.target) || findTarget(s.target),
      );
      const first = steps.findIndex((s) => findTarget(s.target));
      if (first >= 0 && !modalOpen() && document.visibilityState === "visible") {
        setActive({ kind: "tour", steps, index: first });
      } else if (Date.now() - started < WAIT_MS) {
        timer = window.setTimeout(attempt, 500);
      }
    };
    timer = window.setTimeout(attempt, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [view, audience, enabled, epoch]);

  // Staying on it: the nudge, when the reader looks for something.
  useEffect(() => {
    if (!enabled) return;
    const nudge = nudgeFor(view, audience);
    if (!nudge) return;
    // `?coachFast` in development: five seconds instead of twenty, to try it.
    const fast = import.meta.env.DEV && new URLSearchParams(location.search).has("coachFast");
    const watch = watchHesitation(Date.now, fast ? { ...THRESHOLDS, quietMs: 5_000 } : THRESHOLDS);
    const tick = window.setInterval(() => {
      if (activeRef.current || seenRef.current.has(nudge.id) || modalOpen()) return;
      if (watch.hesitating() && findTarget(nudge.target)) {
        setActive({ kind: "nudge", steps: [nudge], index: 0 });
      }
    }, 1000);
    return () => {
      window.clearInterval(tick);
      watch.stop();
    };
  }, [view, audience, enabled]);

  const step = active ? active.steps[active.index] : undefined;

  /** Out with the leaving animation, then gone. */
  const dismiss = useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => {
      setActive(null);
      setLeaving(false);
    }, 200);
  }, []);

  const next = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    mark([a.steps[a.index]!.id]);
    let i = a.index + 1;
    while (i < a.steps.length && !findTarget(a.steps[i]!.target)) i += 1;
    if (i < a.steps.length) setActive({ ...a, index: i });
    else dismiss();
  }, [mark, dismiss]);

  /** "Skip": everything left in this walk is read, present or not. */
  const skip = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    mark(a.steps.slice(a.index).map((s) => s.id));
    dismiss();
  }, [mark, dismiss]);

  const turnOff = useCallback(() => {
    skip();
    save.mutate({ coachEnabled: false });
    toast(t("coach.turnedOff"), "success");
  }, [skip, save, toast, t]);

  // Escape skips; a click on the very thing the bubble points at counts as
  // "got it" and moves on.
  useEffect(() => {
    if (!step) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !modalOpen()) skip();
    };
    const onClick = (e: MouseEvent) => {
      const target = findTarget(step.target);
      if (target && e.target instanceof Node && target.contains(e.target)) next();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick, { capture: true });
    };
  }, [step, skip, next]);

  if (!active || !step) return null;
  const last = active.index === active.steps.length - 1;
  return createPortal(
    <Bubble
      // A new walk pops a new bubble; a new step of the same walk glides.
      key={`${active.kind}-${active.steps[0]!.id}`}
      step={step}
      kind={active.kind}
      index={active.index}
      count={active.steps.length}
      last={last}
      leaving={leaving}
      onNext={(e) => {
        if (last) burst(e.currentTarget);
        next();
      }}
      onSkip={skip}
      onTurnOff={turnOff}
    />,
    document.body,
  );
}

function Bubble({
  step,
  kind,
  index,
  count,
  last,
  leaving,
  onNext,
  onSkip,
  onTurnOff,
}: {
  step: CoachStep;
  kind: Active["kind"];
  index: number;
  count: number;
  last: boolean;
  leaving: boolean;
  onNext: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onSkip: () => void;
  onTurnOff: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const tail = useRef<HTMLSpanElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const placedOnce = useRef(false);

  // Follows the target every frame: it scrolls, the sidebar folds, a list
  // loads above it. Written straight to the style, never through React, so
  // following costs no render.
  useLayoutEffect(() => {
    const first = findTarget(step.target);
    if (first) {
      const r = first.getBoundingClientRect();
      if (r.top < 64 || r.bottom > window.innerHeight - 64) {
        first.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      }
    }
    let raf = 0;
    let lastKey = "";
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const a = anchor.current;
      const b = bubble.current;
      const ringEl = ring.current;
      const tailEl = tail.current;
      if (!a || !b || !ringEl || !tailEl) return;
      const el = findTarget(step.target);
      const hide = !el || modalOpen();
      a.style.visibility = hide ? "hidden" : "visible";
      ringEl.style.opacity = hide ? "0" : "1";
      if (!el || hide) return;
      const r = el.getBoundingClientRect();
      const p = place(
        r,
        { width: b.offsetWidth, height: b.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        step.placement,
      );
      const key = `${p.side}:${[p.x, p.y, p.tail, r.left, r.top, r.width, r.height].map(Math.round).join()}`;
      if (key === lastKey) return;
      lastKey = key;

      a.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`;
      const vertical = p.side === "top" || p.side === "bottom";
      Object.assign(tailEl.style, {
        left: vertical ? `${p.tail - 7}px` : p.side === "right" ? "-6px" : "",
        right: p.side === "left" ? "-6px" : "",
        top: vertical ? (p.side === "bottom" ? "-6px" : "") : `${p.tail - 7}px`,
        bottom: p.side === "top" ? "-6px" : "",
      });
      b.style.setProperty(
        "--coach-origin",
        {
          bottom: `${p.tail}px 0`,
          top: `${p.tail}px 100%`,
          right: `0 ${p.tail}px`,
          left: `100% ${p.tail}px`,
        }[p.side],
      );

      const pad = 6;
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 8;
      // Kept inside the viewport: a sidebar row touches its left edge.
      const left = Math.max(2, r.left - pad);
      const right = Math.min(window.innerWidth - 2, r.right + pad);
      Object.assign(ringEl.style, {
        transform: `translate3d(${Math.round(left)}px, ${Math.round(r.top - pad)}px, 0)`,
        width: `${Math.round(right - left)}px`,
        height: `${Math.round(r.height + pad * 2)}px`,
        borderRadius: `${Math.min(radius + pad, (r.height + pad * 2) / 2)}px`,
      });

      // The very first placement lands; only the later ones glide.
      if (!placedOnce.current) {
        placedOnce.current = true;
        requestAnimationFrame(() => {
          a.removeAttribute("data-instant");
          ringEl.removeAttribute("data-instant");
        });
      }
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [step]);

  const Icon = kind === "nudge" ? Lightbulb : Sparkles;
  const vars = { mod: modKey() };
  return (
    <>
      <div
        ref={ring}
        data-instant=""
        aria-hidden
        className={cx(
          "coach-ring coach-anchor pointer-events-none fixed left-0 top-0",
          Z.coach,
          leaving && "opacity-0",
        )}
      />
      <div
        ref={anchor}
        data-instant=""
        className={cx("coach-anchor fixed left-0 top-0", Z.coach)}
        style={{ visibility: "hidden" }}
      >
        <div className="coach-float relative">
          {/* Before the bubble and not inside it: the bubble is a stacking
              context (its animation), so a tail inside it would paint over
              its background whatever its z-index. Here it paints first and
              the bubble covers its inner half. */}
          <span ref={tail} aria-hidden className={cx("coach-tail", leaving && "opacity-0")} />
          <div
            ref={bubble}
            role="dialog"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            data-leaving={leaving ? "" : undefined}
            className="coach-bubble relative w-80 max-w-[calc(100vw-24px)] rounded-[20px] p-4"
          >
            <div key={step.id} className="coach-content" aria-live="polite">
              <div className="flex items-start gap-3">
                <span
                  key={`icon-${step.id}`}
                  className="coach-icon inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1 pt-0.5">
                  <p id={titleId} className="text-[15px] font-bold leading-snug tracking-tight text-fg">
                    {t(step.title, vars)}
                  </p>
                  <p id={bodyId} className="mt-1 text-[13px] leading-relaxed text-fg-muted">
                    {t(step.body, vars)}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={t("coach.close")}
                  onClick={onSkip}
                  className="-mr-1 -mt-1 rounded-full p-1 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="mt-4 flex items-center gap-2">
                {count > 1 ? (
                  <span
                    className="flex items-center gap-1"
                    aria-label={t("coach.progress", { n: index + 1, total: count })}
                    role="img"
                  >
                    {Array.from({ length: count }, (_, i) => (
                      <span
                        key={i}
                        className={cx(
                          "h-1.5 rounded-full transition-all duration-300",
                          i === index ? "w-4 bg-accent" : i < index ? "w-1.5 bg-accent/40" : "w-1.5 bg-line-strong",
                        )}
                      />
                    ))}
                  </span>
                ) : null}
                <span className="flex-1" />
                {/* A walk offers "skip" until its last bubble; a lone bubble
                    (a nudge, a one-step tour) offers the way out of them all. */}
                {!last ? (
                  <Button variant="ghost" size="sm" onClick={onSkip}>
                    {t("coach.skip")}
                  </Button>
                ) : count === 1 ? (
                  <Button variant="ghost" size="sm" onClick={onTurnOff}>
                    {t("coach.turnOff")}
                  </Button>
                ) : null}
                <Button size="sm" onClick={onNext}>
                  {last ? t("coach.done") : t("coach.next")}
                  {last ? null : <ArrowRight />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** The end of a walk: a handful of sparks thrown from the button. */
function burst(from: HTMLElement) {
  if (reducedMotion()) return;
  const r = from.getBoundingClientRect();
  const colors = ["var(--accent)", "var(--info)", "var(--success)", "var(--warning)"];
  for (let i = 0; i < 16; i += 1) {
    const spark = document.createElement("span");
    const angle = (Math.PI * 2 * i) / 16 + Math.random() * 0.4;
    const dist = 50 + Math.random() * 70;
    spark.className = `coach-spark ${Z.coach}`;
    Object.assign(spark.style, {
      left: `${r.left + r.width / 2 - 4}px`,
      top: `${r.top + r.height / 2 - 4}px`,
      background: colors[i % colors.length]!,
      borderRadius: i % 3 === 0 ? "50%" : "2px",
    });
    spark.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    spark.style.setProperty("--dy", `${Math.sin(angle) * dist - 20}px`);
    spark.style.setProperty("--rot", `${Math.round(Math.random() * 540 - 270)}deg`);
    document.body.appendChild(spark);
    window.setTimeout(() => spark.remove(), 1000);
  }
}
