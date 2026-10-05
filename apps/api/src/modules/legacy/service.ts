/**
 * The legacy URL resolver (merge task M8-02, docs/merge/06 §6.6): turns what
 * the pure rule (`legacyRule`, `@quiz/domain`) names into a Quiz path, or
 * into nothing.
 *
 * Old ids reach Quiz through `import_classroom.id_map`, the table the import
 * (M8-01) keeps: a classroom id is mapped (the import carries a classroom
 * into an EXISTING Quiz one, never under its old id), an assignment id and
 * a user id as the import wrote them. An id the map does not hold resolves
 * to nothing.
 *
 * The target is then LOADED under the caller's own access (invariant 6),
 * through the guards' finders, never checked afterwards: the staff through
 * `staffAccess`, a student through their claimed seat. A target the caller
 * does not reach is `null`, exactly as a missing one. Nothing here says
 * why.
 */
import { and, eq } from "drizzle-orm";

import type { LegacyRule } from "@quiz/domain";

import type { SessionAuth } from "../../auth/session.js";
import type { Db } from "../../db/client.js";
import { avatars, importIdMap } from "../../db/schema.js";
import {
  findAccessibleProject,
  findReadableClassroom,
  findStudentProject,
  seesUser,
  type Caller,
} from "../guards.js";

/** The rules that need an entity: everything the pure rule cannot answer alone. */
export type LookupRule = Extract<LegacyRule, { kind: "classroom" | "project" | "groups" | "journal" | "start" | "avatar" }>;

/** The Quiz id an old row became, through the id map; null when the import did not carry it. */
async function mapped(db: Db, table: "classrooms" | "assignments" | "users", sourceId: string): Promise<string | null> {
  const [row] = await db
    .select({ targetId: importIdMap.targetId })
    .from(importIdMap)
    .where(and(eq(importIdMap.sourceTable, table), eq(importIdMap.sourceId, sourceId)))
    .limit(1);
  return row?.targetId ?? null;
}

/** A journal page path as the web router writes it: one encoded segment each. */
const encodePath = (segments: readonly string[]) => segments.map(encodeURIComponent).join("/");

/**
 * The Quiz path a rule leads this caller to, or null (a 404 the route sends
 * whether the entity is missing, unmapped or off the caller's reach).
 * `auth` is the request's own session, for the classroom's student branch.
 */
export async function resolve(
  db: Db,
  caller: Caller,
  auth: Pick<SessionAuth, "kind" | "actorUserId"> | null,
  rule: LookupRule,
): Promise<string | null> {
  switch (rule.kind) {
    case "classroom":
    case "journal": {
      const id = await mapped(db, "classrooms", rule.classroomId);
      if (!id) return null;
      if (!(await findReadableClassroom(db, caller, auth, id, { studentView: false }))) return null;
      return rule.kind === "classroom"
        ? `/classrooms/${id}`
        : `/classrooms/${id}/journal${rule.path.length > 0 ? `/${encodePath(rule.path)}` : ""}`;
    }
    case "project":
    case "groups":
    case "start": {
      const id = await mapped(db, "assignments", rule.assignmentId);
      if (!id) return null;
      const staff = await findAccessibleProject(db, caller, id);
      // The students' side: a claimed student seat on a published project.
      if (!staff && !(await findStudentProject(db, caller.id, id))) return null;
      // The staff's groups page: the project's set when it names one, else
      // the classroom's sets. A student, who has no such page, gets the
      // project, where their group is.
      if (rule.kind === "groups" && staff) {
        const base = `/classrooms/${staff.project.classroomId}/groups`;
        return staff.project.groupSetId ? `${base}/${staff.project.groupSetId}` : base;
      }
      return `/projects/${id}`;
    }
    case "avatar": {
      const id = await mapped(db, "users", rule.userId);
      if (!id) return null;
      const [row] = await db
        .select({ userId: avatars.userId })
        .from(avatars)
        .where(and(eq(avatars.userId, id), seesUser(caller, id)))
        .limit(1);
      return row ? `/app/api/users/${id}/avatar` : null;
    }
  }
}
