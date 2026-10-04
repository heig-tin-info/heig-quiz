/**
 * The writing steps of the import, in the order of the foreign keys, each
 * over the one transaction `runImport` opens (`Ctx.db`). Every step writes
 * through the owning module's writer where one exists — `addAddresses`,
 * `recordIdpClaims`, `importAccountLink`, `createTeacherGrant`, `addStaff`,
 * `claimLines`, `syncRoleOfUser` — and is "insert unless present", so a
 * second run writes nothing.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { audit } from "../../src/audit.js";
import { addAddresses, recordIdpClaims } from "../../src/auth/claims.js";
import { importAccountLink } from "../../src/auth/githubLink.js";
import type { AppConfig } from "../../src/config.js";
import type { Tx } from "../../src/db/client.js";
import {
  avatars,
  enrollments,
  importIdMap,
  importRuns,
  teacherGrants,
  userEmails,
  users,
} from "../../src/db/schema.js";
import { emailIn, normalizeEmail } from "../../src/identity.js";
import { createTeacherGrant } from "../../src/modules/admin/service.js";
import type { CourseRole } from "@quiz/contracts";

import { addStaff, changeStaffSeat, claimLines, type ClaimMatch } from "../../src/modules/org/service.js";
import { syncRoleOfUser } from "../../src/roles.js";
import { targetOf, type Identity } from "./identity.js";
import type { Destination } from "./mapping.js";
import type { ImportReport, OpenDecisions } from "./run.js";
import type { SourceSnapshot, SourceUser } from "./source.js";

export type Mapped = Extract<Destination, { kind: "mapped" }>;
export type Finding = keyof ImportReport["findings"] & string;

/** What every step reads and appends to. */
export interface Ctx {
  db: Tx;
  config: AppConfig;
  snapshot: SourceSnapshot;
  usersById: Map<string, SourceUser>;
  identities: Map<string, Identity>;
  /** The identities that stand for a Quiz account, by source id. */
  resolved: [string, Identity][];
  /** Mapped source classroom id → its Quiz classroom. */
  mapped: Map<string, Mapped>;
  decisions: OpenDecisions;
  /** The `--actor`, null when unresolved (a dry run then still runs). */
  actorId: string | null;
  /** `import_classroom.id_map`, loaded once: source table → source id → target id. */
  known: Map<string, Map<string, string>>;
  report: ImportReport;
}

export function note(ctx: Ctx, section: Finding, line: string) {
  (ctx.report.findings[section] ??= []).push(line);
}

export function written(ctx: Ctx, table: string, n = 1) {
  if (n > 0) ctx.report.written[table] = (ctx.report.written[table] ?? 0) + n;
}

export function nameOf(user: SourceUser | undefined): string {
  if (!user) return "unknown user";
  if (user.anonymizedAt) return `anonymized user ${user.id}`;
  return `${user.givenName} ${user.familyName} <${user.email}> (${user.id})`;
}

const target = (ctx: Ctx, sourceUserId: string | null) =>
  sourceUserId === null ? undefined : targetOf(ctx.identities.get(sourceUserId));

async function remember(ctx: Ctx, sourceTable: string, sourceId: string, targetId: string, how: string) {
  const done = await ctx.db
    .insert(importIdMap)
    .values({ sourceTable, sourceId, targetId, how })
    .onConflictDoNothing()
    .returning({ sourceId: importIdMap.sourceId });
  written(ctx, "import_classroom.id_map", done.length);
}

/** New accounts under their placeholder sub; matches recorded in the map. */
export async function importUsers(ctx: Ctx) {
  for (const [sourceId, identity] of ctx.identities) {
    const u = ctx.usersById.get(sourceId)!;
    if (identity.kind === "excluded") {
      note(ctx, "source", `${nameOf(u)}: ${identity.reason}, not imported`);
      continue;
    }
    if (identity.kind === "new") {
      await ctx.db.insert(users).values({
        id: identity.targetId,
        oidcSub: identity.sub,
        email: u.email,
        emailVerified: u.emailVerified,
        givenName: u.givenName,
        familyName: u.familyName,
        swissEduId: u.swissEduId,
        pictureUrl: u.pictureUrl,
        lastLoginAt: u.lastLoginAt,
        locale: u.locale,
        dateFormat: u.dateFormat,
        anonymizedAt: u.anonymizedAt,
        createdAt: u.createdAt,
      });
      written(ctx, "users");
      await remember(ctx, "users", sourceId, identity.targetId, "created");
    } else if (identity.kind === "matched") {
      await remember(ctx, "users", sourceId, identity.targetId, identity.how);
    }
    if (u.emailPrefs && Object.keys(u.emailPrefs).length > 0) {
      note(ctx, "not carried", `${nameOf(u)}: e-mail preferences (notification kinds come with M3-09)`);
    }
  }
}

/**
 * Addresses (the union), claims (the newer snapshot), avatars (only where
 * Quiz has none: a matched account's picture is its profile). Nothing of an
 * anonymized classroom user.
 */
export async function importProfiles(ctx: Ctx) {
  const copied = new Set<string>();
  for (const [sourceId, identity] of ctx.resolved) {
    const userId = targetOf(identity)!;
    const u = ctx.usersById.get(sourceId)!;
    if (u.anonymizedAt) {
      // Classroom specifies its anonymization (NFR-07) on `users` and
      // `enrollments` only, and never shipped it: nothing clears the
      // address set, the claims or the picture of an anonymized account.
      note(ctx, "source", `${nameOf(u)}: anonymized, its addresses, claims and avatar are not copied`);
      continue;
    }
    const addresses = ctx.snapshot.userEmails.filter((r) => r.userId === sourceId);
    written(ctx, "user_emails", await addAddresses(ctx.db, userId, addresses));
    for (const a of addresses) if (a.verified) copied.add(normalizeEmail(a.email));

    const claims = ctx.snapshot.claims.find((c) => c.userId === sourceId);
    if (claims && (await recordIdpClaims(ctx.db, userId, claims.claims, claims.updatedAt))) {
      written(ctx, "user_idp_claims");
    }
    const avatar = ctx.snapshot.avatars.find((a) => a.userId === sourceId);
    if (avatar) {
      const done = await ctx.db
        .insert(avatars)
        .values({ userId, data: Buffer.from(avatar.data), contentType: avatar.contentType, updatedAt: avatar.updatedAt })
        .onConflictDoNothing()
        .returning({ userId: avatars.userId });
      written(ctx, "avatars", done.length);
    }
  }
  if (copied.size === 0) return;
  const shared = await ctx.db
    .select({ email: userEmails.email, holders: sql<number>`count(distinct ${userEmails.userId})::int` })
    .from(userEmails)
    .where(and(inArray(userEmails.email, [...copied]), eq(userEmails.verified, true)))
    .groupBy(userEmails.email)
    .having(sql`count(distinct ${userEmails.userId}) > 1`);
  for (const s of shared) {
    note(ctx, "addresses", `${s.email} is held by ${s.holders} Quiz accounts: roster claims on it will be flagged`);
  }
}

/** GitHub account links, through the one writer of `github_accounts`. */
export async function importGithubLinks(ctx: Ctx) {
  for (const [sourceId, identity] of ctx.resolved) {
    const u = ctx.usersById.get(sourceId)!;
    if (u.githubUserId === null || !u.githubLogin) continue;
    const outcome = await importAccountLink(
      ctx.db,
      targetOf(identity)!,
      { id: u.githubUserId, login: u.githubLogin },
      u.githubLinkedAt ?? u.createdAt,
    );
    if (outcome === "linked") written(ctx, "github_accounts");
    else if (outcome === "user_linked_elsewhere") {
      note(ctx, "github", `${nameOf(u)}: already linked in Quiz to another GitHub account; Quiz's kept, ${u.githubLogin} (#${u.githubUserId}) not imported`);
    } else if (outcome === "account_taken") {
      note(ctx, "github", `${nameOf(u)}: GitHub ${u.githubLogin} (#${u.githubUserId}) is already another Quiz user's; not imported`);
    }
  }
}

/**
 * Teacher grants on a verified address of a person the import reaches
 * (decision of 2026-10-01: nobody else's); the creator mapped, else the
 * `--actor`.
 */
export async function importGrants(ctx: Ctx) {
  const resolved = new Set(ctx.resolved.map(([sourceId]) => sourceId));
  const reached = new Set(
    ctx.snapshot.userEmails
      .filter((r) => r.verified && resolved.has(r.userId))
      .map((r) => normalizeEmail(r.email)),
  );
  const done = ctx.known.get("teacher_grants") ?? new Map<string, string>();
  for (const grant of ctx.snapshot.grants) {
    const email = normalizeEmail(grant.email);
    if (!reached.has(email)) {
      note(ctx, "grants", `${email}: not reached by a mapped classroom, not imported`);
      continue;
    }
    if (done.has(grant.id)) continue;
    if (grant.codespaceEnabled) note(ctx, "not carried", `${email}: the online workspace grant (M6)`);
    const createdBy = target(ctx, grant.createdBy) ?? ctx.actorId;
    if (!createdBy) {
      note(ctx, "grants", `${email}: no creator to record, not imported`);
      continue;
    }
    const created = await createTeacherGrant(ctx.db, { id: grant.id, email, createdBy, createdAt: grant.createdAt });
    if (created) {
      written(ctx, "teacher_grants");
      await remember(ctx, "teacher_grants", grant.id, created.id, "created");
    } else {
      // The address holds a Quiz grant already.
      const [existing] = await ctx.db
        .select({ id: teacherGrants.id })
        .from(teacherGrants)
        .where(eq(teacherGrants.email, email));
      if (existing) await remember(ctx, "teacher_grants", grant.id, existing.id, "merged");
    }
  }
}

/**
 * Course staff: the owner and the claimed seats of each mapped classroom,
 * with their roles (ADR-068, D04 (c)): the classroom's owner and a `teacher`
 * seat become owners of the course, an `assistant` seat an assistant. A seat
 * is never demoted: an account that owns one classroom of the course owns
 * the course, whatever another classroom made it, and a seat that existed in
 * Quiz before the import keeps its role unless the import makes it an owner.
 */
export async function importStaff(ctx: Ctx) {
  const seat = async (courseId: string, userId: string, role: CourseRole) => {
    if (await addStaff(ctx.db, courseId, userId, role)) written(ctx, "course_staff");
    else if (role === "owner") {
      const promoted = await changeStaffSeat(ctx.db, courseId, userId, "owner");
      if (promoted.refused === null && promoted.from !== "owner") written(ctx, "course_staff");
    }
  };
  for (const c of ctx.snapshot.classrooms) {
    const dest = ctx.mapped.get(c.id);
    if (!dest) continue;
    const owner = target(ctx, c.teacherId);
    if (owner) await seat(dest.courseId, owner, "owner");
    else note(ctx, "staff", `"${c.name}": its owner ${nameOf(ctx.usersById.get(c.teacherId))} is unresolved, no seat`);
    for (const s of ctx.snapshot.staff.filter((s) => s.classroomId === c.id)) {
      const who = target(ctx, s.userId);
      const whom = nameOf(ctx.usersById.get(s.userId ?? ""));
      if (!s.userId) note(ctx, "staff", `"${c.name}": pending seat ${s.email} (no account), not imported — invite by hand`);
      else if (!who) note(ctx, "staff", `"${c.name}": seat of ${whom} unresolved`);
      else if (s.role === "assistant" && ctx.decisions.assistants === "skip") {
        note(ctx, "staff", `"${c.name}": assistant ${whom} left out (--assistants=skip)`);
      } else {
        await seat(dest.courseId, who, s.role === "teacher" ? "owner" : "assistant");
        if (s.role === "assistant") {
          note(ctx, "staff", `"${c.name}": assistant ${whom} becomes an assistant of ${dest.courseCode}, every classroom of it (D04 (a), (c))`);
        }
      }
    }
  }
}

/** Stands for the actor in a dry run whose `--actor` did not resolve: excludes nobody. */
const NOBODY = "00000000-0000-0000-0000-000000000000";

/**
 * Enrollments, merged into each mapped Quiz roster on the address: the
 * missing lines inserted in one statement (open item 3), then the source's
 * claims carried by the roster's own claim pass (`claimLines`).
 */
export async function importEnrollments(ctx: Ctx) {
  const done = ctx.known.get("enrollments") ?? new Map<string, string>();
  for (const [sourceRoomId, dest] of ctx.mapped) {
    const lines = ctx.snapshot.enrollments.filter((e) => e.classroomId === sourceRoomId && !done.has(e.id));
    if (lines.length === 0) continue;
    const label = (e: (typeof lines)[number]) =>
      `"${dest.classroomName}" (${dest.courseCode}): ${e.prenom} ${e.nom} <${normalizeEmail(e.email)}>`;
    const roster = () =>
      ctx.db
        .select({ id: enrollments.id, email: enrollments.email, userId: enrollments.userId })
        .from(enrollments)
        .where(and(eq(enrollments.classroomId, dest.classroomId), emailIn(enrollments.email, lines.map((e) => e.email))));
    let byEmail = new Map((await roster()).map((r) => [normalizeEmail(r.email), r]));
    const missing = lines.filter((e) => !byEmail.has(normalizeEmail(e.email)));
    const added = new Set<string>();
    if (missing.length > 0 && ctx.decisions.missingStudents === "report") {
      for (const e of missing) note(ctx, "enrollments", `${label(e)}: not on the Quiz roster, not added (--missing-students=report)`);
    } else if (missing.length > 0) {
      const inserted = await ctx.db
        .insert(enrollments)
        .values(missing.map((e) => ({ id: e.id, classroomId: dest.classroomId, nom: e.nom, prenom: e.prenom, email: normalizeEmail(e.email), staff: e.staff })))
        .onConflictDoNothing()
        .returning({ email: enrollments.email });
      written(ctx, "enrollments", inserted.length);
      for (const r of inserted) added.add(r.email);
      byEmail = new Map((await roster()).map((r) => [normalizeEmail(r.email), r]));
    }

    const held = new Set(
      (
        await ctx.db
          .select({ userId: enrollments.userId })
          .from(enrollments)
          .where(and(eq(enrollments.classroomId, dest.classroomId), isNotNull(enrollments.userId)))
      ).map((r) => r.userId!),
    );
    const matches: ClaimMatch[] = [];
    for (const e of lines) {
      const email = normalizeEmail(e.email);
      const line = byEmail.get(email);
      if (!line) continue;
      if (added.has(email)) note(ctx, "enrollments", `${label(e)}: added to the Quiz roster`);
      const who = target(ctx, e.userId);
      if (e.userId && !who) note(ctx, "enrollments", `${label(e)}: claimed by an unresolved account, left as it is`);
      if (who && line.userId === null) {
        const ambiguous = held.has(who);
        if (ambiguous) note(ctx, "enrollments", `${label(e)}: flagged, the account already holds another line of the classroom`);
        matches.push({ entryId: line.id, userId: who, classroomId: dest.classroomId, classroomName: dest.classroomName, courseId: dest.courseId, ambiguous });
        held.add(who);
      } else if (who && line.userId !== who) {
        note(ctx, "enrollments", `${label(e)}: claimed in Quiz by another account, Quiz's kept`);
      }
      await remember(ctx, "enrollments", e.id, line.id, added.has(email) ? "created" : "merged");
    }
    written(ctx, "enrollments (claimed)", await claimLines(ctx.db, matches, ctx.actorId ?? NOBODY));
  }
}

/** Roles, through the one rule (roles.ts), without pool succession. */
export async function recomputeRoles(ctx: Ctx) {
  const accounts = [...new Set(ctx.resolved.map(([, i]) => targetOf(i)!))].sort();
  for (const userId of accounts) {
    const [before] = await ctx.db.select({ role: users.role }).from(users).where(eq(users.id, userId));
    await syncRoleOfUser(ctx.db, ctx.config, userId, { succession: false });
    const [after] = await ctx.db.select({ role: users.role, email: users.email }).from(users).where(eq(users.id, userId));
    if (before && after && before.role !== after.role) {
      written(ctx, "users.role");
      note(ctx, "roles", `${after.email} (${userId}): ${before.role} -> ${after.role}`);
    }
  }
}

/** The run and its audit row: only an `--apply` that wrote something. */
export async function recordRun(ctx: Ctx, run: { id: string; startedAt: Date; mappingSha256: string }) {
  const counts = { identity: ctx.report.identity, written: ctx.report.written };
  await ctx.db.insert(importRuns).values({
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: new Date(),
    actorUserId: ctx.actorId!,
    mappingSha256: run.mappingSha256,
    options: { ...ctx.decisions },
    report: counts,
  });
  await audit(ctx.db, {
    actorUserId: ctx.actorId,
    actorType: "user",
    action: "migration.classroom_import",
    subjectType: "import_run",
    subjectId: run.id,
    payload: counts,
  });
}
