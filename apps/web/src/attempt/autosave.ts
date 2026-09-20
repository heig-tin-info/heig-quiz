/**
 * The student's autosave, exactly as PLAN-MVP §4.7 specifies its client half.
 *
 * It is a plain class and not a hook on purpose: the rules below are the part
 * worth testing, and a test that has to mount a component to check a backoff
 * is testing React. `useAttempt.ts` is the thin React wrapper around it.
 *
 * The rules, in the order the plan states them:
 *   - 300 ms debounce per item, so a keystroke is not a request;
 *   - at most ONE in-flight request per item; the next one waits, and it
 *     leaves with the LATEST payload, never with the one it was queued with;
 *   - `revision` is a client-local counter that only ever grows — it is what
 *     makes the server's `WHERE answers.revision < EXCLUDED.revision` a
 *     last-writer-wins rule instead of a race;
 *   - a network failure backs off exponentially, capped at 5 s, and the badge
 *     turns `offline` after 3 s without an acknowledgement; the unacked
 *     payloads stay in memory and are replayed on reconnect (N-RES-02);
 *   - `accepted: false` means the server holds something newer: the client
 *     ADOPTS the payload and the revision it was handed;
 *   - a `410` stops every write for the attempt. Its `paused` reason is the
 *     one recoverable case (decision D17): the payloads are kept and sent
 *     again when the evaluation resumes.
 *
 * Every response carries `serverNow`, and every one of them is fed to the
 * server clock: the countdown a student watches is corrected by the very
 * requests their own typing generates.
 */
import type { AttemptClosed, AutosaveRequest, AutosaveResponse } from "@quiz/contracts";

import { ApiError } from "../api";

export const DEBOUNCE_MS = 300;
export const OFFLINE_AFTER_MS = 3_000;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 5_000;

/** The four states of `SyncBadge` (`ui.tsx`), which is this object's face. */
export type SyncState = "saved" | "saving" | "offline" | "closed";

/** Posts one autosave. Rejecting with a `410` ApiError closes the attempt. */
export type AutosaveTransport = (itemId: string, body: AutosaveRequest) => Promise<AutosaveResponse>;

export interface AutosaveHooks {
  /** The sync badge. Called only when the state actually changes. */
  onState?: (state: SyncState) => void;
  /** `accepted: false`: the server's payload wins and the UI must show it. */
  onAdopt?: (itemId: string, payload: unknown, revision: number) => void;
  /** Every response's `serverNow`, with the round trip that carried it. */
  onServerNow?: (serverNow: string, rttMs: number) => void;
  /** A `410`. `paused` is recoverable, the three others are final. */
  onClosed?: (info: AttemptClosed | null) => void;
}

export interface AutosaveOptions extends AutosaveHooks {
  send: AutosaveTransport;
  debounceMs?: number;
  offlineAfterMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Injectable for the tests; production reads the wall clock. */
  now?: () => number;
}

interface ItemState {
  /** Local monotonic counter; never resets for the life of the attempt. */
  revision: number;
  /** The payload waiting to be acknowledged, if any. */
  pending: unknown;
  hasPending: boolean;
  /** The revision `pending` carries. */
  pendingRevision: number;
  inFlight: boolean;
  debounce: ReturnType<typeof setTimeout> | null;
  retry: ReturnType<typeof setTimeout> | null;
  /** Consecutive failures, for the backoff. */
  failures: number;
}

const newItem = (revision: number): ItemState => ({
  revision,
  pending: null,
  hasPending: false,
  pendingRevision: revision,
  inFlight: false,
  debounce: null,
  retry: null,
  failures: 0,
});

/** `410` is the one status that means "stop", whatever else went wrong. */
function closedBody(error: unknown): { closed: boolean; info: AttemptClosed | null } {
  if (!(error instanceof ApiError) || error.status !== 410) return { closed: false, info: null };
  const body = error.body as AttemptClosed | null;
  return { closed: true, info: body && body.error === "attempt_closed" ? body : null };
}

export class Autosave {
  private readonly items = new Map<string, ItemState>();
  private readonly options: AutosaveOptions;
  private readonly debounceMs: number;
  private readonly offlineAfterMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly now: () => number;
  private state: SyncState = "saved";
  private offline = false;
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  /** True between a `410 paused` and the next `resume()` (decision D17). */
  private paused = false;
  private stopped = false;

  constructor(options: AutosaveOptions) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.offlineAfterMs = options.offlineAfterMs ?? OFFLINE_AFTER_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? BACKOFF_MAX_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** The state the badge shows. */
  get syncState(): SyncState {
    return this.state;
  }

  /** True while at least one payload has not been acknowledged. */
  get dirty(): boolean {
    for (const item of this.items.values()) if (item.hasPending || item.inFlight) return true;
    return false;
  }

  /** Items holding an unacknowledged payload, for the tests and the reporter. */
  get unsaved(): string[] {
    return [...this.items.entries()].filter(([, i]) => i.hasPending).map(([id]) => id);
  }

  /**
   * Adopts the revision `GET /attempts/:id` reported, so the local counter
   * starts ABOVE what the database holds. Without this a reload would send
   * revision 1 for an answer the server already stored at 4, and every write
   * of the resumed attempt would be refused as stale.
   */
  seed(itemId: string, revision: number): void {
    const item = this.items.get(itemId);
    if (item) item.revision = Math.max(item.revision, revision);
    else this.items.set(itemId, newItem(revision));
  }

  revisionOf(itemId: string): number {
    return this.items.get(itemId)?.revision ?? 0;
  }

  /** One change of one item's answer: bumps the revision and debounces. */
  change(itemId: string, payload: unknown): void {
    if (this.stopped) return;
    const item = this.items.get(itemId) ?? newItem(0);
    this.items.set(itemId, item);
    item.revision += 1;
    item.pending = payload;
    item.pendingRevision = item.revision;
    item.hasPending = true;
    if (item.debounce !== null) clearTimeout(item.debounce);
    item.debounce = setTimeout(() => {
      item.debounce = null;
      this.flush(itemId);
    }, this.debounceMs);
    this.publish();
  }

  /**
   * Sends everything pending at once: the reconnection path (N-RES-02) and
   * the resume after a pause (D17). Resets the backoff — the reason to retry
   * now is new information, not another tick of the same failure.
   */
  resume(): void {
    if (this.stopped) return;
    this.paused = false;
    for (const [itemId, item] of this.items) {
      item.failures = 0;
      if (item.retry !== null) {
        clearTimeout(item.retry);
        item.retry = null;
      }
      if (item.hasPending) this.flush(itemId);
    }
    this.publish();
  }

  /** Stops every write for good: a final `410`, or the player unmounting. */
  stop(final = true): void {
    for (const item of this.items.values()) {
      if (item.debounce !== null) clearTimeout(item.debounce);
      if (item.retry !== null) clearTimeout(item.retry);
      item.debounce = null;
      item.retry = null;
    }
    if (this.offlineTimer !== null) clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
    this.stopped = true;
    if (final) {
      this.state = "closed";
      this.options.onState?.("closed");
    }
  }

  // --- internals ----------------------------------------------------------

  private flush(itemId: string): void {
    const item = this.items.get(itemId);
    if (!item || this.stopped || this.paused) return;
    if (!item.hasPending || item.inFlight) return;
    const body: AutosaveRequest = {
      payload: item.pending,
      revision: item.pendingRevision,
      clientTs: new Date(this.now()).toISOString(),
    };
    const sentRevision = item.pendingRevision;
    const startedAt = this.now();
    item.inFlight = true;
    this.armOfflineTimer();
    this.publish();
    this.options.send(itemId, body).then(
      (response) => this.acknowledged(itemId, sentRevision, response, startedAt),
      (error: unknown) => this.failed(itemId, error),
    );
  }

  private acknowledged(
    itemId: string,
    sentRevision: number,
    response: AutosaveResponse,
    startedAt: number,
  ): void {
    const item = this.items.get(itemId);
    if (!item || this.stopped) return;
    item.inFlight = false;
    item.failures = 0;
    this.options.onServerNow?.(response.serverNow, Math.max(0, this.now() - startedAt));
    // The server holds something newer: its payload wins, revision included
    // (last-writer-wins BY REVISION, not by arrival order).
    if (!response.accepted && response.payload !== undefined) {
      item.revision = Math.max(item.revision, response.revision);
      this.options.onAdopt?.(itemId, response.payload, response.revision);
    }
    // Anything typed while this request was in flight is still pending, and
    // leaves next with the LATEST payload rather than the queued one.
    if (item.pendingRevision <= sentRevision) item.hasPending = false;
    this.clearOfflineIfSettled();
    this.publish();
    if (item.hasPending) this.flush(itemId);
  }

  private failed(itemId: string, error: unknown): void {
    const item = this.items.get(itemId);
    if (!item || this.stopped) return;
    item.inFlight = false;
    const { closed, info } = closedBody(error);
    if (closed) {
      // D17: a pause keeps everything and sends it again on `running`; the
      // three other reasons end the attempt.
      if (info?.reason === "paused") {
        this.paused = true;
        this.offline = true;
        this.publish();
      } else {
        this.stop();
      }
      this.options.onClosed?.(info);
      return;
    }
    item.failures += 1;
    const delay = Math.min(
      this.backoffMaxMs,
      this.backoffBaseMs * 2 ** (item.failures - 1),
    );
    if (item.retry !== null) clearTimeout(item.retry);
    item.retry = setTimeout(() => {
      item.retry = null;
      this.flush(itemId);
    }, delay);
    this.publish();
  }

  /** "offline" is 3 s without an acknowledgement, not "a request failed". */
  private armOfflineTimer(): void {
    if (this.offlineTimer !== null || this.offline) return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (this.dirty) {
        this.offline = true;
        this.publish();
      }
    }, this.offlineAfterMs);
  }

  private clearOfflineIfSettled(): void {
    if (this.dirty) return;
    this.offline = false;
    if (this.offlineTimer !== null) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
  }

  private publish(): void {
    const next: SyncState = this.stopped
      ? "closed"
      : this.offline
        ? "offline"
        : this.dirty
          ? "saving"
          : "saved";
    if (next === this.state) return;
    this.state = next;
    this.options.onState?.(next);
  }
}
