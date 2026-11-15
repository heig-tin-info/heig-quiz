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

import { and, count, desc, eq, gt, inArray, isNull, min, sql } from "drizzle-orm";

import type { PairableEvaluation, PairableProject } from "@quiz/contracts";
import {
  DEVICE_LEVELS,
  PAIRING_EXPIRES_IN_S,
  PAIRING_INTERVAL_S,
  generateUserCode,
  kioskProjectPairable,
  normalizeUserCode,
  pollAnswer,
  type PairingPollOutcome,
} from "@quiz/domain";

import { audit, type AuditAction } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { auditLog, classrooms, courses, enrollments, kioskDevices, kioskPairings, projectRepos, projects } from "../../db/schema.js";
import { liveProject } from "../guards.js";
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
    .map(({ id, title, classroomName, courseCode, conditions }) => ({
      id,
      title,
      classroomName,
      courseCode,
      // Holds by construction (ADR-079 §7): kiosk ⇒ a trusted client ⇒ an open
      // card carries its conditions. A regression throws on the contract, never
      // drops the exam silently.
      conditions: conditions!,
    }));
}

/** The levels that accept a kiosk station, as the column stores them. */
const STATION_LEVELS = DEVICE_LEVELS.filter((l) => (l.clients as readonly string[]).includes("kiosk")).map((l) => l.id);

/**
 * The supervised projects `userId` can start on a station now (ADR-089 §5):
 * a claimed seat in the project's classroom — a staff seat testing it
 * counts, as for its `.seb` (ADR-077) —, the project open (published or
 * locked, not archived) in a classroom not archived, and the rule of
 * `kioskProjectPairable`: a level that accepts a kiosk station, before the
 * student's effective deadline. The same rule for the phone's list, the
 * approval and the station's consumption.
 */
export async function pairableProjects(db: Db, userId: string, now: Date): Promise<PairableProject[]> {
  const rows = await db
    .selectDistinct({
      id: projects.id,
      title: projects.name,
      classroomName: classrooms.name,
      courseCode: courses.code,
      mode: projects.workMode,
      devices: projects.devices,
      deadlineAt: projects.deadlineAt,
      repoDeadlineAt: projectRepos.deadlineAt,
      repoId: projectRepos.id,
    })
    .from(projects)
    .innerJoin(enrollments, and(eq(enrollments.classroomId, projects.classroomId), eq(enrollments.userId, userId)))
    .innerJoin(classrooms, and(eq(classrooms.id, projects.classroomId), isNull(classrooms.archivedAt)))
    .innerJoin(courses, eq(courses.id, classrooms.courseId))
    .leftJoin(
      projectRepos,
      and(eq(projectRepos.projectId, projects.id), eq(projectRepos.userId, userId), isNull(projectRepos.groupId)),
    )
    .where(and(liveProject(), eq(projects.workMode, "online_seb"), inArray(projects.devices, STATION_LEVELS)))
    .orderBy(projects.deadlineAt, projects.name);
  return rows
    .filter((r) =>
      kioskProjectPairable(
        { mode: r.mode, devices: r.devices, deadlineAt: r.deadlineAt },
        r.repoId === null ? null : { deadlineAt: r.repoDeadlineAt },
        now,
      ),
    )
    .map(({ id, title, classroomName, courseCode }) => ({ id, title, classroomName, courseCode }));
}

/** What a pairing seats the student for: one exam, or one supervised project (ADR-089 §5). */
export type PairActivity = { evaluationId: string } | { projectId: string };

/** Whether `userId` can start `activity` on a station now: the list's own rule, for the approval and the consumption. */
async function pairable(db: Db, userId: string, activity: PairActivity, now: Date): Promise<boolean> {
  if ("projectId" in activity) return (await pairableProjects(db, userId, now)).some((p) => p.id === activity.projectId);
  return (await pairableEvaluations(db, userId, now)).some((e) => e.id === activity.evaluationId);
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
  | { kind: "approved"; pairingId: string; userId: string; activity: PairActivity };

/**
 * A station's poll (RFC 8628 §3.4–3.5). A `device_code` that is unknown, or
 * another station's, is `invalid_grant`: a station polls its own pairings
 * only. An approved pairing is consumed by ONE conditional UPDATE, so two
 * polls in flight cannot both get a session; the seat and the exam — or the
 * project (ADR-089 §5) — are then checked again, since minutes may have
 * passed since the phone approved.
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
    .returning({ userId: kioskPairings.userId, evaluationId: kioskPairings.evaluationId, projectId: kioskPairings.projectId });
  // Lost to a concurrent poll: that one has the session.
  const activity: PairActivity | null = consumed?.evaluationId
    ? { evaluationId: consumed.evaluationId }
    : consumed?.projectId
      ? { projectId: consumed.projectId }
      : null;
  if (!consumed?.userId || activity === null) return { kind: "error", error: "access_denied" };
  polls.delete(pairing.id);
  if (!(await pairable(db, consumed.userId, activity, now))) return { kind: "error", error: "access_denied" };
  return { kind: "approved", pairingId: pairing.id, userId: consumed.userId, activity };
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
 * `GET /pair/:code`: the station the code names and the exams and the
 * projects (ADR-089 §5) the user can start on it; null when the code names
 * no pending pairing (not counted: see {@link pendingByCode}).
 */
export async function previewPairing(
  db: Db,
  userId: string,
  code: string,
  now: Date,
): Promise<{ label: string; evaluations: PairableEvaluation[]; projects: PairableProject[] } | null> {
  const found = await pendingByCode(db, userId, code, now, { count: false });
  if (!found) return null;
  const [evaluations, projects] = await Promise.all([pairableEvaluations(db, userId, now), pairableProjects(db, userId, now)]);
  return { label: found.device.label!, evaluations, projects };
}

export type ApproveOutcome =
  | { kind: "not_found" }
  | { kind: "evaluation" }
  | { kind: "project" }
  | { kind: "approved"; pairingId: string; deviceId: string; label: string };

/**
 * `POST /pair`: the student approves the pairing for one of their pairable
 * exams or projects (ADR-089 §5) — or, `approvedBy` a supervisor,
 * `kiosk-assign` does it for a student of an exam without a phone (ADR-051
 * §7): the same pairing, and the wrong codes counted against whoever typed
 * them. The code is checked first (the limit, then the pairing); one
 * conditional UPDATE from `pending` then approves it, so a code approved
 * twice (two phones, one code) is approved once. An activity the student
 * cannot start there — one the phone's list would not show — is refused
 * (reason `evaluation` or `project`), and does not count as a wrong code.
 */
export async function approvePairing(
  db: Db,
  input: { userId: string; code: string; approvedBy?: string } & PairActivity,
  now: Date,
): Promise<ApproveOutcome> {
  const approvedBy = input.approvedBy ?? input.userId;
  const found = await pendingByCode(db, approvedBy, input.code, now, { count: true });
  if (!found) return { kind: "not_found" };
  const activity: PairActivity = "projectId" in input ? { projectId: input.projectId } : { evaluationId: input.evaluationId };
  if (!(await pairable(db, input.userId, activity, now))) return { kind: "projectId" in activity ? "project" : "evaluation" };
  const [approved] = await db
    .update(kioskPairings)
    .set({
      state: "approved",
      userId: input.userId,
      ...activity,
      approvedBy,
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
