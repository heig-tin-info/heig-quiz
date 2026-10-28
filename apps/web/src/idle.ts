/**
 * Whether the person in front of this page is idle (ADR-107): the page is
 * hidden, or the person made no gesture — pressed a key, clicked, touched,
 * turned the wheel — for `IDLE_AFTER_MS`. `api()` then marks its request with
 * `IDLE_HEADER`, and the server does not count it as the person's activity — a
 * poll, a refetch the event stream asked for, the safety refetch of a tab left
 * open overnight.
 *
 * Only a gesture counts. A page becoming visible again is not one: a device
 * waking at night reports its open tab visible, then reconnects and refetches
 * everything with nobody in front of it. Nor is a `scroll` event, which also
 * fires when a refetch re-renders a list; a person's scroll always comes with
 * a wheel, touch, key or pointer gesture. The page load itself counts, as the
 * navigation the person made.
 *
 * Listeners are passive and installed once, at the first call; nothing here
 * ever blocks or delays a request.
 */
export const IDLE_AFTER_MS = 10 * 60_000;

const GESTURES = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

let lastInteraction = Date.now();
let listening = false;

function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const mark = () => {
    lastInteraction = Date.now();
  };
  for (const type of GESTURES) window.addEventListener(type, mark, { passive: true, capture: true });
}

/** True when a request made now is not the person's doing. */
export function isIdle(now: number = Date.now()): boolean {
  listen();
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
  return now - lastInteraction >= IDLE_AFTER_MS;
}
