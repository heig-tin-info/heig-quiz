/**
 * The close of a kiosk station's sitting (ADR-089, amendment of 2026-11-15,
 * point 4). Quiz sends it when the station's session ends; the portal never
 * decides the end. Three effects, and nothing else — the container and its
 * volume are untouched:
 *
 *  1. the `exam_session` cookies carrying that `sitting` are revoked. They
 *     are signed and stateless, so the revocation is a row of
 *     `closed_sittings`, which the proxy and `/launch` read: it survives a
 *     restart, and is purged once no cookie nor launch token of the sitting
 *     can still be valid ({@link sittingRetentionMs});
 *  2. every socket upgraded under a cookie of that sitting is dropped,
 *     whoever holds the session now ({@link SittingSockets});
 *  3. the portal session (`/s/<id>`) is rotated only while that sitting
 *     opened it last (`sessions.opened_by_sitting`): a browser that resumed
 *     it since already rotated its cookie away from the station.
 *
 * A `seb` launch's cookie carries no sitting: nothing here ever touches it.
 */
import type { Socket } from "node:net";

import { LAUNCH_TOKEN_TTL_SECONDS } from "@quiz/contracts";
import { eq, lt } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { closedSittings } from "../db/schema.js";

import { rotateSittingOpener } from "./manager.js";
import { JTI_RETENTION_AFTER_EXP_MS } from "./store.js";

/**
 * How long a closed sitting is remembered: past it, every cookie of the
 * sitting has expired (issued before the close, since `/launch` refuses a
 * closed sitting, and valid `examCookieMaxAgeMs` at most) and every launch
 * token naming it too (minted before the close, alive five minutes and
 * refused no later than `JTI_RETENTION_AFTER_EXP_MS` after).
 */
export function sittingRetentionMs(examCookieMaxAgeMs: number): number {
  return Math.max(examCookieMaxAgeMs, LAUNCH_TOKEN_TTL_SECONDS * 1000 + JTI_RETENTION_AFTER_EXP_MS);
}

export function isSittingClosed(db: Db, sitting: string): boolean {
  return db.select({ sitting: closedSittings.sitting }).from(closedSittings).where(eq(closedSittings.sitting, sitting)).get() !== undefined;
}

/**
 * The sockets upgraded under each sitting, in memory: a socket lives no
 * longer than the process, so a restart has none to drop.
 */
export interface SittingSockets {
  /** Tags a socket the proxy upgraded under a cookie of `sitting`; forgotten when it closes. */
  track(sitting: string, socket: Socket): void;
  /** Destroys every socket of `sitting`; returns how many. */
  drop(sitting: string): number;
}

export function createSittingSockets(): SittingSockets {
  const bySitting = new Map<string, Set<Socket>>();
  return {
    track(sitting, socket) {
      if (socket.destroyed) return;
      let set = bySitting.get(sitting);
      if (!set) bySitting.set(sitting, (set = new Set()));
      set.add(socket);
      socket.once("close", () => {
        set.delete(socket);
        if (set.size === 0 && bySitting.get(sitting) === set) bySitting.delete(sitting);
      });
    },
    drop(sitting) {
      const set = bySitting.get(sitting);
      bySitting.delete(sitting);
      if (!set) return 0;
      for (const socket of set) socket.destroy();
      return set.size;
    },
  };
}

export interface SittingCloseResult {
  /** False when the sitting was already closed: a replay, nothing new done but the drop. */
  readonly first: boolean;
  /** Portal sessions whose cookie was rotated (that sitting opened them last). */
  readonly rotated: number;
  /** Sockets dropped. */
  readonly dropped: number;
}

/**
 * Closes `sitting`: idempotent, and the same for a sitting the portal never
 * saw (its row then only refuses a launch token of it still in flight).
 */
export function closeSitting(
  db: Db,
  sockets: SittingSockets,
  sitting: string,
  opts: { examCookieMaxAgeMs: number; now?: Date },
): SittingCloseResult {
  const now = opts.now ?? new Date();
  const result = db.transaction((tx) => {
    tx.delete(closedSittings)
      .where(lt(closedSittings.closedAt, new Date(now.getTime() - sittingRetentionMs(opts.examCookieMaxAgeMs))))
      .run();
    const first = tx.insert(closedSittings).values({ sitting, closedAt: now }).onConflictDoNothing().run().changes === 1;
    return { first, rotated: rotateSittingOpener(tx, sitting) };
  });
  return { ...result, dropped: sockets.drop(sitting) };
}
