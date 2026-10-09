/**
 * The writing steps of the import, in the order of the foreign keys, each
 * over the one transaction `runImport` opens (`Ctx.db`). Every step writes
 * through the owning module's writer where one exists — `addAddresses`,
 * `recordIdpClaims`, `importAccountLink`, `createTeacherGrant`, `addStaff`,
 * `claimLines`, `syncRoleOfUser` — and is "insert unless present", so a
 * second run writes nothing.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { audit } from "../audit.js";
import { placeholderSub } from "../auth/adoption.js";
import { addAddresses, recordIdpClaims } from "../auth/claims.js";
import { importAccountLink } from "../auth/githubLink.js";
import {
  avatars,
  enrollments,
  importIdMap,
  importRuns,
  teacherGrants,
  userEmails,
  users,
} from "../db/schema.js";
import { emailIn, normalizeEmail } from "../identity.js";
import { createTeacherGrant } from "../modules/admin/service.js";
import type { CourseRole } from "@quiz/contracts";

import { addStaff, changeStaffSeat, claimLines, type ClaimMatch } from "../modules/org/service.js";
import { syncRoleOfUser } from "../roles.js";

import { targetOf } from "./identity.js";
import { listed, nameOf, note, remember, syncOwned, tallyMapped, target, written, type Ctx, type OwnedRow } from "./ctx.js";
import type { SourceUser } from "./source.js";

export { nameOf, type Ctx, type Finding, type Mapped } from "./ctx.js";

/** The columns of a classroom user the import owns in the Quiz account it created (the re-import rule, `ctx.ts`). */
const userRow = (u: SourceUser): OwnedRow => ({
  sourceTable: "users",
  sourceId: u.id,
  table: users,
  label: nameOf(u),
  values: {
    oidcSub: placeholderSub(u.oidcSub),
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
  },
});

/**
 * New accounts under their placeholder sub; matches recorded in the map. An
 * account this import created is refreshed from classroom on a later run
 * unless Quiz changed it since (`syncOwned`: a first login rewrites the sub,
 * so an adopted account is Quiz's from then on).
 */
export async function importUsers(ctx: Ctx) {
  const leftOut = new Map<string, string>();
  for (const [sourceId, identity] of ctx.identities) {
    const u = ctx.usersById.get(sourceId)!;
    if (identity.kind === "excluded") {
      note(ctx, "source", `${nameOf(u)}: ${identity.reason}, not imported`);
      leftOut.set(sourceId, identity.reason);
      continue;
    }
    if (identity.kind === "ambiguous") {
      leftOut.set(sourceId, "ambiguous identity");
      continue;
    }
    if (identity.kind === "new") {
      const row = userRow(u);
      await ctx.db.insert(users).values({ id: identity.targetId, ...row.values } as typeof users.$inferInsert);
      written(ctx, "users");
      await remember(ctx, "users", sourceId, identity.targetId, "created", row);
    } else if (identity.kind === "matched") {
      await remember(ctx, "users", sourceId, identity.targetId, identity.how);
    } else {
      await syncOwned(ctx, userRow(u));
    }
    if (u.emailPrefs && Object.keys(u.emailPrefs).length > 0) {
      note(ctx, "not carried", `${nameOf(u)}: e-mail preferences (notification kinds come with M3-09)`);
    }
  }
  tallyMapped(ctx, "users", [...ctx.identities.keys()], leftOut);
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
  const leftOut = new Map<string, string>();
  for (const grant of ctx.snapshot.grants) {
    const email = normalizeEmail(grant.email);
    if (!reached.has(email)) {
      note(ctx, "grants", `${email}: not reached by a mapped classroom, not imported`);
      leftOut.set(grant.id, "not reached by a mapped classroom");
      continue;
    }
    if (ctx.known.get("teacher_grants")?.has(grant.id)) continue;
    if (grant.codespaceEnabled) note(ctx, "not carried", `${email}: the online workspace grant (M6)`);
    const createdBy = target(ctx, grant.createdBy) ?? ctx.actorId;
    if (!createdBy) {
      note(ctx, "grants", `${email}: no creator to record, not imported`);
      leftOut.set(grant.id, "no creator to record");
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
  tallyMapped(ctx, "teacher_grants", ctx.snapshot.grants.map((g) => g.id), leftOut);
}

/**
 * The classroom map (merge task M8-02): each mapped classroom's old id and
 * the Quiz classroom it became, in the id map, which the legacy URL resolver
 * reads (`/legacy/classroom/classrooms/:id`). The import carries a classroom
 * into an EXISTING Quiz one, so this is the only trace of the old id.
 * `merged`, never `created`: the import owns no classroom row.
 */
export async function importClassroomMap(ctx: Ctx) {
  const rows = ctx.known.get("classrooms") ?? new Map<string, string>();
  for (const [sourceId, dest] of ctx.mapped) {
    const held = rows.get(sourceId);
    // A remap follows (`follow`): the mapping file sends the classroom elsewhere, no baseline to protect.
    await remember(ctx, "classrooms", sourceId, dest.classroomId, "merged", undefined, true);
    if (held !== undefined && held !== dest.classroomId) {
      note(ctx, "reimport", `"${dest.classroomName}": the mapping now sends classroom ${sourceId} to ${dest.courseCode}/${dest.classroomName}, the legacy links follow`);
    }
  }
  // A classroom the mapping file now drops or no longer names leads nowhere: its row goes.
  const stale = [...rows.keys()].filter((id) => !ctx.mapped.has(id));
  if (stale.length > 0) {
    await ctx.db.delete(importIdMap).where(and(eq(importIdMap.sourceTable, "classrooms"), inArray(importIdMap.sourceId, stale)));
    for (const id of stale) rows.delete(id);
    written(ctx, "import_classroom.id_map", stale.length);
    note(ctx, "reimport", `${stale.length} classroom(s) no longer mapped: the legacy links to ${stale.join(", ")} now lead nowhere`);
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
        listed(ctx, "skippedAssistants", "staff", `"${c.name}": assistant ${whom} left out (--assistants=skip)`);
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
  const done = new Set(ctx.known.get("enrollments")?.keys());
  const leftOut = new Map<string, string>();
  const lineRow = (e: (typeof ctx.snapshot.enrollments)[number]): OwnedRow => ({
    sourceTable: "enrollments",
    sourceId: e.id,
    table: enrollments,
    label: `${e.prenom} ${e.nom} <${normalizeEmail(e.email)}>`,
    values: { nom: e.nom, prenom: e.prenom, email: normalizeEmail(e.email), staff: e.staff },
  });
  for (const [sourceRoomId, dest] of ctx.mapped) {
    const inRoom = ctx.snapshot.enrollments.filter((e) => e.classroomId === sourceRoomId);
    // A line this import created is refreshed from classroom unless Quiz changed it.
    for (const e of inRoom.filter((e) => done.has(e.id))) await syncOwned(ctx, lineRow(e));
    const lines = inRoom.filter((e) => !done.has(e.id));
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
      for (const e of missing) {
        listed(ctx, "missingStudents", "enrollments", `${label(e)}: not on the Quiz roster, not added (--missing-students=report)`);
        leftOut.set(e.id, "not on the Quiz roster (--missing-students=report)");
      }
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
      await remember(ctx, "enrollments", e.id, line.id, added.has(email) ? "created" : "merged", added.has(email) ? lineRow(e) : undefined);
    }
    written(ctx, "enrollments (claimed)", await claimLines(ctx.db, matches, ctx.actorId ?? NOBODY));
  }
  const inScope = ctx.snapshot.enrollments.filter((e) => ctx.mapped.has(e.classroomId));
  tallyMapped(ctx, "enrollments", inScope.map((e) => e.id), leftOut);
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
  const { overwritten, kept } = ctx.report.reimport;
  const counts = {
    identity: ctx.report.identity,
    written: ctx.report.written,
    reimport: { overwritten, kept: kept.length },
  };
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
