/*
 * The one SSE connection of a page (PLAN-MVP §4.8 and §6.5, docs/spec/05 §5.4).
 *
 * The server publishes two kinds of frame on the same stream (WP5 deviation
 * W5-7): an UNNAMED `hint`, which carries no data and only says "this family
 * changed, ask again", and a NAMED frame per live event (`event: clock`,
 * `event: dashboard.cell`, …) for the paths where a round trip would be too
 * slow or too noisy. A browser reads the first with `onmessage` and the
 * second with `addEventListener(name)`, so one `EventSource` serves both.
 *
 * ONE connection per page, not one per hook: the shell mounts `useLiveUpdates`
 * on every screen, and the live dashboard mounts its own watcher on top. Two
 * EventSources would mean two presence records, two snapshots and two clocks
 * disagreeing by a round trip. The module below is therefore a single shared
 * connection that every subscriber joins; the watched subject asked for by
 * any of them reopens it, and its departure closes it back down to the
 * hint-only stream the rest of the app lives on.
 *
 * Two safety nets, both from docs/spec/05 §5.4:
 *   - the server sends a `clock` every 10 s. Thirty seconds without one means
 *     the socket is dead in a way the browser has not noticed (a proxy that
 *     stopped forwarding, a laptop back from sleep): we close and reopen it
 *     ourselves rather than wait for a TCP timeout;
 *   - every watcher refetches its own query once a minute, whatever the
 *     stream said, so a lost event can never leave a grid wrong for longer
 *     than that.
 */
import { useEffect, useRef, useState } from "react";

import {
  SERVER_EVENT_NAMES,
  ServerEvent,
  type HintEvent,
  type WatchSubject,
} from "@quiz/contracts";

/**
 * Every frame the server sends under a name; the hint travels unnamed.
 *
 * Derived from the `ServerEvent` union in `packages/contracts` rather than
 * restated here (invariant 7): a fourteenth event is subscribed to the day it
 * is declared, instead of compiling everywhere and never being delivered.
 */
export const NAMED_EVENTS = SERVER_EVENT_NAMES;

/** No `clock` for this long and the connection is presumed dead. */
export const SILENCE_MS = 30_000;

/** How often a watcher refetches its query whatever the stream said. */
export const SAFETY_REFETCH_MS = 60_000;

/** Checked often enough that the reconnection is not itself half a minute late. */
const WATCHDOG_MS = 5_000;

const ENDPOINT = "/app/api/events";

interface Subscriber {
  watch: WatchSubject | null;
  handle: (event: ServerEvent) => void;
  opened: () => void;
  connection: (connected: boolean) => void;
}

const subscribers = new Set<Subscriber>();
let source: EventSource | null = null;
let openedWatch: WatchSubject | null = null;
let lastClockAt = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;

/** The subject to watch: the first subscriber that asks for one. */
function desiredWatch(): WatchSubject | null {
  for (const s of subscribers) {
    if (s.watch !== null) return s.watch;
  }
  return null;
}

function announce(connected: boolean): void {
  for (const s of subscribers) s.connection(connected);
}

function deliver(raw: string): void {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  const parsed = ServerEvent.safeParse(data);
  if (!parsed.success) {
    // A frame this build does not understand is dropped, never thrown: an
    // older tab must keep running against a newer server.
    if (import.meta.env.DEV) console.warn("[events] unreadable frame", data);
    return;
  }
  if (parsed.data.type === "clock") lastClockAt = Date.now();
  for (const s of subscribers) s.handle(parsed.data);
}

function close(): void {
  source?.close();
  source = null;
  openedWatch = null;
}

function open(): void {
  const Source = (globalThis as { EventSource?: typeof EventSource }).EventSource;
  if (!Source) return;
  const watch = desiredWatch();
  const url = watch === null ? ENDPOINT : `${ENDPOINT}?watch=${encodeURIComponent(watch)}`;
  const es = new Source(url);
  source = es;
  openedWatch = watch;
  lastClockAt = Date.now();
  es.onopen = () => {
    lastClockAt = Date.now();
    announce(true);
    for (const s of subscribers) s.opened();
  };
  es.onerror = () => {
    // EventSource reconnects on its own; a fresh snapshot arrives on reopen.
    announce(false);
  };
  // The inherited hint frame, unnamed so `onmessage` is the only way in.
  es.onmessage = (e: MessageEvent) => deliver(String(e.data));
  for (const name of NAMED_EVENTS) {
    es.addEventListener(name, (e) => deliver(String((e as MessageEvent).data)));
  }
}

/** Opens, reopens on a changed subject, and closes when nobody is left. */
function reconcile(): void {
  if (subscribers.size === 0) {
    if (source) {
      close();
      announce(false);
    }
    if (watchdog !== null) {
      clearInterval(watchdog);
      watchdog = null;
    }
    return;
  }
  if (source === null) {
    open();
  } else if (desiredWatch() !== openedWatch) {
    close();
    open();
  }
  if (watchdog === null) {
    watchdog = setInterval(() => {
      if (source === null || Date.now() - lastClockAt < SILENCE_MS) return;
      // Silent for half a minute: the browser still believes in this socket,
      // we do not.
      announce(false);
      close();
      open();
    }, WATCHDOG_MS);
    // Node's timer keeps a test process alive otherwise; the browser has no
    // such method and ignores this.
    (watchdog as unknown as { unref?: () => void }).unref?.();
  }
}

/** Test seam: drops the shared connection so one suite cannot leak into the next. */
export function resetEventStream(): void {
  subscribers.clear();
  close();
  if (watchdog !== null) {
    clearInterval(watchdog);
    watchdog = null;
  }
}

export interface EventStreamOptions {
  /** False keeps the page off the stream entirely (signed out, mock persona). */
  enabled?: boolean;
  /** `evaluation:<id>` or `attempt:<id>`; omitted = the user's hint stream. */
  watch?: WatchSubject | null;
  /** Every typed event, already validated. */
  onEvent?: (event: ServerEvent) => void;
  /** The seeding frame of the watched subject, sent once per connection. */
  onSnapshot?: (state: unknown, serverNow: string) => void;
  /** `serverNow` of every `clock`; feed it to `useServerClock().sample`. */
  onClock?: (serverNow: string) => void;
  /** The unnamed refresh hint (ADR-005). */
  onHint?: (hint: HintEvent) => void;
  /** Called on every (re)connection, and every `SAFETY_REFETCH_MS` while watching. */
  onRefresh?: () => void;
  /**
   * The once-a-minute belt-and-braces refetch. On by default for a watcher,
   * off for the hint-only shell stream: invalidating every query of the app
   * every minute is polling, which is exactly what the hint replaced.
   */
  safetyRefetch?: boolean;
}

/**
 * Joins the page's connection. Returns whether it is currently up, which is
 * the only thing a screen shows about it ("synchronised", or a warning).
 */
export function useEventStream(options: EventStreamOptions = {}): { connected: boolean } {
  const { enabled = true, watch = null } = options;
  const [connected, setConnected] = useState(false);
  // The callbacks change on every render of the caller; the subscription must
  // not, or a re-render would reopen the socket.
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!enabled) return;
    const subscriber: Subscriber = {
      watch,
      connection: setConnected,
      opened: () => latest.current.onRefresh?.(),
      handle: (event) => {
        const o = latest.current;
        if (event.type === "clock") o.onClock?.(event.serverNow);
        else if (event.type === "snapshot") o.onSnapshot?.(event.state, event.serverNow);
        else if (event.type === "hint") o.onHint?.(event);
        o.onEvent?.(event);
      },
    };
    subscribers.add(subscriber);
    reconcile();
    const safety =
      (options.safetyRefetch ?? watch !== null)
        ? setInterval(() => latest.current.onRefresh?.(), SAFETY_REFETCH_MS)
        : null;
    return () => {
      if (safety !== null) clearInterval(safety);
      subscribers.delete(subscriber);
      reconcile();
    };
    // `safetyRefetch` is read once, on purpose: a screen does not turn its
    // own safety net on and off between two renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, watch]);

  return { connected };
}
