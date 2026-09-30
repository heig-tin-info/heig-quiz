/**
 * The pairing of a station with a student's phone (ADR-051 §7, RFC 8628
 * adapted): the one module that writes `kiosk_pairings`. The pure rules —
 * the codes, the state machine, the answer to a poll — are
 * `@quiz/domain/kioskPairing`'s; this file stores and reads them.
 *
 * Neither code is ever stored: `device_code_hash` and `user_code_hash` are
 * SHA-256 digests, of the user code's canonical form (`XXXX-XXXX`). A
 * pairing is named by its row id, in the audit as everywhere.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, count, desc, eq, gt, min, sql } from "drizzle-orm";

import type { PairableEvaluation } from "@quiz/contracts";
import {
  PAIRING_EXPIRES_IN_S,
  PAIRING_INTERVAL_S,
  generateUserCode,
  normalizeUserCode,
  pollAnswer,
  type PairingPollOutcome,
} from "@quiz/domain";

import { audit, type AuditAction } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { auditLog, kioskDevices, kioskPairings } from "../../db/schema.js";
import { studentHome } from "../live/service.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The exams `userId` can start on a station now (ADR-051 §7): the student
 * home's "Open now" (a claimed seat — a staff seat counts, ADR-018 — the
 * evaluation in `lobby`, `running` or `paused`, and nothing finished that
 * cannot be retaken), narrowed to those that accept the kiosk. The same rule
 * for the phone's list, the approval and the station's consumption.
 */
export async function pairableEvaluations(
  db: Db,
  userId: string,
  now: Date,
): Promise<PairableEvaluation[]> {
  const home = await studentHome(db, userId, now);
  return home.open
    .filter((c) => c.trustedClients.includes("kiosk"))
    .map((c) => ({ id: c.id, title: c.title, classroomName: c.classroomName, courseCode: c.courseCode }));
}

// --- The station -------------------------------------------------------------

/**
 * A new pairing for `device`, the previous pending one expired first — one
 * code on the screen at a time. Answers the two codes in clear, once: only
 * their digests are kept.
 */
export async function issuePairing(
  db: Db,
  deviceId: string,
  now: Date,
): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number }> {
  const deviceCode = randomBytes(32).toString("base64url");
  const userCode = generateUserCode((n) => randomBytes(n));
  await db.transaction(async (tx) => {
    await tx
      .update(kioskPairings)
      .set({ state: "expired" })
      .where(and(eq(kioskPairings.deviceId, deviceId), eq(kioskPairings.state, "pending")));
    await tx.insert(kioskPairings).values({
      id: randomUUID(),
      deviceId,
      deviceCodeHash: sha256(deviceCode),
      userCodeHash: sha256(userCode),
      state: "pending",
      createdAt: now,
      expiresAt: new Date(now.getTime() + PAIRING_EXPIRES_IN_S * 1000),
    });
  });
  return { deviceCode, userCode, expiresIn: PAIRING_EXPIRES_IN_S, interval: PAIRING_INTERVAL_S };
}

/**
 * The last poll of each pairing and the interval it must keep, in the
 * process's memory. A restart forgets them, and costs one poll that is not
 * told to slow down: harmless, so no column (ADR-051 §7). Pruned once the
 * pairing has expired.
 */
const polls = new Map<string, { lastPollAt: Date; interval: number; expiresAt: Date }>();

function prunePolls(now: Date) {
  for (const [id, p] of polls) if (p.expiresAt.getTime() <= now.getTime()) polls.delete(id);
}

export type TokenOutcome =
  | { kind: "error"; error: Exclude<PairingPollOutcome, "approved"> | "invalid_grant" }
  | { kind: "approved"; pairingId: string; userId: string; evaluationId: string };

/**
 * A station's poll (RFC 8628 §3.4–3.5). A `device_code` that is unknown, or
 * another station's, is `invalid_grant`: a station polls its own pairings
 * only. An approved pairing is consumed by ONE conditional UPDATE, so two
 * polls in flight cannot both get a session; the seat and the exam are then
 * checked again, since minutes may have passed since the phone approved.
 */
export async function pollPairing(
  db: Db,
  deviceId: string,
  deviceCode: string,
  now: Date,
): Promise<TokenOutcome> {
  prunePolls(now);
  const [pairing] = await db
    .select()
    .from(kioskPairings)
    .where(eq(kioskPairings.deviceCodeHash, sha256(deviceCode)));
  if (!pairing || pairing.deviceId !== deviceId) return { kind: "error", error: "invalid_grant" };

  const last = polls.get(pairing.id);
  const answer = pollAnswer({
    state: pairing.state,
    expiresAt: pairing.expiresAt,
    lastPollAt: last?.lastPollAt ?? null,
    interval: last?.interval ?? PAIRING_INTERVAL_S,
    now,
  });
  polls.set(pairing.id, { lastPollAt: now, interval: answer.interval, expiresAt: pairing.expiresAt });
  if (answer.outcome !== "approved") return { kind: "error", error: answer.outcome };

  const [consumed] = await db
    .update(kioskPairings)
    .set({ state: "consumed", consumedAt: now })
    .where(
      and(
        eq(kioskPairings.id, pairing.id),
        eq(kioskPairings.state, "approved"),
        gt(kioskPairings.expiresAt, now),
      ),
    )
    .returning({ userId: kioskPairings.userId, evaluationId: kioskPairings.evaluationId });
  // Lost to a concurrent poll: that one has the session.
  if (!consumed?.userId || !consumed.evaluationId) return { kind: "error", error: "access_denied" };
  polls.delete(pairing.id);
  const still = await pairableEvaluations(db, consumed.userId, now);
  if (!still.some((e) => e.id === consumed.evaluationId)) return { kind: "error", error: "access_denied" };
  return {
    kind: "approved",
    pairingId: pairing.id,
    userId: consumed.userId,
    evaluationId: consumed.evaluationId,
  };
}

// --- The phone ---------------------------------------------------------------

/**
 * Wrong codes a user may send within the window before the pairing refuses
 * them (ADR-051 §7), counted from the audit's own `kiosk.pair_refused`
 * rows under an advisory lock: no counter to keep in step.
 */
export const PAIR_MAX_FAILURES = 10;
export const PAIR_WINDOW_MS = 10 * 60_000;

const PAIR_REFUSED = "kiosk.pair_refused" satisfies AuditAction;

export class PairRateLimited extends Error {
  constructor(readonly retryAfterS: number) {
    super("rate_limited");
  }
}

/** A pending pairing of an active station the code names, or null. */
async function pendingPairing(db: Db | Tx, userCode: string, now: Date) {
  const [row] = await db
    .select({ pairing: kioskPairings, device: kioskDevices })
    .from(kioskPairings)
    .innerJoin(kioskDevices, eq(kioskPairings.deviceId, kioskDevices.id))
    .where(
      and(
        eq(kioskPairings.userCodeHash, sha256(userCode)),
        eq(kioskPairings.state, "pending"),
        gt(kioskPairings.expiresAt, now),
        eq(kioskDevices.status, "active"),
      ),
    )
    .orderBy(desc(kioskPairings.createdAt))
    .limit(1);
  return row && row.device.label !== null ? { pairing: row.pairing, device: row.device } : null;
}

/**
 * The pending pairing `code` names, looked up under the user's pairing lock
 * after the failure count: parallel guesses would otherwise all read the same
 * count and slip past the limit together. Throws {@link PairRateLimited} over
 * the limit.
 *
 * With `count`, a code that names no pending pairing is a failure, audited in
 * the same transaction (reason `code`); the code itself is never written.
 * Only the approving POST counts: it carries the CSRF header. A GET rides any
 * cross-site navigation with the portal cookie, so a counted GET would let
 * another site lock a student out of pairing; the preview reads the count
 * and writes nothing (its own guesses are bounded by the route's limiter).
 */
async function pendingByCode(
  db: Db,
  userId: string,
  code: string,
  now: Date,
  { count: counted }: { count: boolean },
) {
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`kiosk-pair:${userId}`}, 0))`,
    );
    const since = new Date(now.getTime() - PAIR_WINDOW_MS);
    const [row] = await tx
      .select({ n: count(), first: min(auditLog.createdAt) })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, PAIR_REFUSED),
          eq(auditLog.actorUserId, userId),
          sql`${auditLog.payload}->>'reason' = 'code'`,
          gt(auditLog.createdAt, since),
        ),
      );
    if (row?.first && row.n >= PAIR_MAX_FAILURES) {
      const retryAfterMs = row.first.getTime() + PAIR_WINDOW_MS - now.getTime();
      return { limited: Math.max(1, Math.ceil(retryAfterMs / 1000)) } as const;
    }
    const canonical = normalizeUserCode(code);
    const found = canonical === null ? null : await pendingPairing(tx, canonical, now);
    if (!found && counted) {
      await audit(tx, {
        actorUserId: userId,
        actorType: "user",
        action: PAIR_REFUSED,
        subjectType: "kiosk_pairing",
        subjectId: "unknown",
        payload: { reason: "code" },
        at: now,
      });
    }
    return { found } as const;
  });
  if ("limited" in outcome) throw new PairRateLimited(outcome.limited);
  return outcome.found;
}

/**
 * `GET /pair/:code`: the station the code names and the exams the user can
 * start on it; null when the code names no pending pairing (not counted:
 * see {@link pendingByCode}).
 */
export async function previewPairing(
  db: Db,
  userId: string,
  code: string,
  now: Date,
): Promise<{ label: string; evaluations: PairableEvaluation[] } | null> {
  const found = await pendingByCode(db, userId, code, now, { count: false });
  if (!found) return null;
  return { label: found.device.label!, evaluations: await pairableEvaluations(db, userId, now) };
}

export type ApproveOutcome =
  | { kind: "not_found" }
  | { kind: "evaluation" }
  | { kind: "approved"; pairingId: string; deviceId: string; label: string };

/**
 * `POST /pair`: the student approves the pairing for one of their pairable
 * exams. The code is checked first (the limit, then the pairing); one
 * conditional UPDATE from `pending` then approves it, so a code approved
 * twice (two phones, one code) is approved once. An exam the student cannot
 * start there is refused (reason `evaluation`), and does not count as a
 * wrong code.
 */
export async function approvePairing(
  db: Db,
  input: { userId: string; code: string; evaluationId: string },
  now: Date,
): Promise<ApproveOutcome> {
  const found = await pendingByCode(db, input.userId, input.code, now, { count: true });
  if (!found) return { kind: "not_found" };
  const pairable = await pairableEvaluations(db, input.userId, now);
  if (!pairable.some((e) => e.id === input.evaluationId)) return { kind: "evaluation" };
  const [approved] = await db
    .update(kioskPairings)
    .set({
      state: "approved",
      userId: input.userId,
      evaluationId: input.evaluationId,
      approvedBy: input.userId,
      approvedAt: now,
    })
    .where(
      and(
        eq(kioskPairings.id, found.pairing.id),
        eq(kioskPairings.state, "pending"),
        gt(kioskPairings.expiresAt, now),
      ),
    )
    .returning({ id: kioskPairings.id });
  if (!approved) return { kind: "not_found" };
  return { kind: "approved", pairingId: approved.id, deviceId: found.device.id, label: found.device.label! };
}
