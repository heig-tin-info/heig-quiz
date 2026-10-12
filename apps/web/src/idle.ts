/**
 * Whether the person in front of this page is idle (ADR-107): the page is
 * hidden, or nothing was pressed, clicked, touched or scrolled for
 * `IDLE_AFTER_MS`. `api()` then marks its request with `IDLE_HEADER`, and the
 * server does not count it as the person's activity — a poll, a refetch the
 * event stream asked for, the safety refetch of a tab left open overnight.
 *
 * Listeners are passive and installed once, at the first call; nothing here
 * ever blocks or delays a request.
 */
export const IDLE_AFTER_MS = 10 * 60_000;

const INTERACTIONS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

let lastInteraction = Date.now();
let listening = false;

function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const mark = () => {
    lastInteraction = Date.now();
  };
  for (const type of INTERACTIONS) window.addEventListener(type, mark, { passive: true, capture: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") mark();
  });
}

/** True when a request made now is not the person's doing. */
export function isIdle(now: number = Date.now()): boolean {
  listen();
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
  return now - lastInteraction >= IDLE_AFTER_MS;
}
