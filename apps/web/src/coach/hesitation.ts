/**
 * "Looks stuck": the reader is on the page, busy, and not getting anywhere.
 *
 * Idle is not stuck — a teacher reading a question for a minute is working,
 * and a tab left open over lunch is nobody. What reads as hesitation is
 * ACTIVITY WITHOUT ACTION: the pointer travels, hovers one control after
 * another, the page scrolls down and back up, and nothing is clicked or
 * typed. So three things must hold together:
 *
 *   1. a while without an action (a click on something interactive, a key
 *      typed in a field) — `quietMs`;
 *   2. the reader is here right now: some pointer or scroll activity in the
 *      last `presentMs`;
 *   3. and that activity looks like searching: a long pointer path, several
 *      controls brushed past, or the page scrolled back and forth.
 *
 * Pure: the hook in `CoachLayer` feeds it events and asks it on a timer.
 */

export interface HesitationState {
  /** When the clock started: the screen was reached, or the last action. */
  since: number;
  /** Last pointer move or scroll, whatever it was. */
  lastActivity: number;
  /** Pixels the pointer travelled since `since`. */
  path: number;
  /** Distinct interactive elements hovered since `since`, without a click. */
  hovered: number;
  /** Times the scroll changed direction since `since`. */
  reversals: number;
}

export const THRESHOLDS: {
  quietMs: number;
  presentMs: number;
  path: number;
  hovered: number;
  reversals: number;
} = {
  quietMs: 20_000,
  presentMs: 4_000,
  path: 3_000,
  hovered: 5,
  reversals: 3,
};

export function freshState(now: number): HesitationState {
  return { since: now, lastActivity: 0, path: 0, hovered: 0, reversals: 0 };
}

export function isHesitating(
  s: HesitationState,
  now: number,
  th: typeof THRESHOLDS = THRESHOLDS,
): boolean {
  if (now - s.since < th.quietMs) return false;
  if (now - s.lastActivity > th.presentMs) return false;
  return s.path >= th.path || s.hovered >= th.hovered || s.reversals >= th.reversals;
}

/**
 * The DOM half: listens on the document and says whether the reader looks
 * stuck. `reset()` restarts the clock (a new screen). Returns the teardown.
 */
export function watchHesitation(
  now: () => number = Date.now,
  th: typeof THRESHOLDS = THRESHOLDS,
) {
  let state = freshState(now());
  let last: { x: number; y: number } | null = null;
  let lastScrollY = window.scrollY;
  let lastDir = 0;
  let seen = new WeakSet<Element>();

  const reset = () => {
    state = freshState(now());
    last = null;
    lastDir = 0;
    seen = new WeakSet();
  };
  const interactive = (t: EventTarget | null) =>
    t instanceof Element
      ? t.closest("a, button, input, select, textarea, [role=button], [role=tab], [role=menuitem], [contenteditable=true]")
      : null;

  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    if (last) state.path += Math.hypot(e.clientX - last.x, e.clientY - last.y);
    last = { x: e.clientX, y: e.clientY };
    state.lastActivity = now();
  };
  const onOver = (e: PointerEvent) => {
    const el = interactive(e.target);
    if (el && !seen.has(el)) {
      seen.add(el);
      state.hovered += 1;
    }
  };
  const onScroll = () => {
    const y = window.scrollY;
    const dir = Math.sign(y - lastScrollY);
    if (dir !== 0 && lastDir !== 0 && dir !== lastDir) state.reversals += 1;
    if (dir !== 0) lastDir = dir;
    lastScrollY = y;
    state.lastActivity = now();
  };
  // An action is a click on something that does something, or typing.
  // Clicking the empty page is what a lost reader does; it restarts nothing.
  const onDown = (e: PointerEvent) => {
    if (interactive(e.target)) reset();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) reset();
  };

  document.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerover", onOver, { passive: true });
  document.addEventListener("pointerdown", onDown, { capture: true });
  document.addEventListener("keydown", onKey, { capture: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  return {
    reset,
    hesitating: () => isHesitating(state, now(), th),
    stop: () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerdown", onDown, { capture: true });
      document.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("scroll", onScroll);
    },
  };
}
