/**
 * The mapping file (`--mapping <file.json>`, D22): one row per heig-classroom
 * classroom, sending it to an EXISTING Quiz classroom or dropping it. The
 * import creates no course and no classroom — the teachers make their Quiz
 * classrooms and connect them to GitHub first (spec 06 no. 46).
 *
 *     {
 *       "classrooms": [
 *         { "source": { "name": "Prog-A" },
 *           "target": { "course": "PROG", "classroom": "Prog-A" } },
 *         { "source": { "id": "…" }, "drop": true, "note": "test classroom" }
 *       ]
 *     }
 *
 * A source is named by its id, its name, or both (then they must agree); a
 * target by its course CODE and its classroom NAME, resolved to ids that the
 * report prints for the teachers to check. "Complete" means every source
 * classroom, archived ones included, has exactly one row.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../../src/db/client.js";
import { classrooms, courses, githubClassroomLinks, githubOrganizations } from "../../src/db/schema.js";
import type { SourceClassroom, SourceSnapshot } from "./source.js";

const SourceRef = z
  .object({ id: z.uuid().optional(), name: z.string().trim().min(1).optional() })
  .strict()
  .refine((s) => s.id !== undefined || s.name !== undefined, "a source needs an id or a name");

const MappedRow = z
  .object({
    source: SourceRef,
    target: z
      .object({ course: z.string().trim().min(1), classroom: z.string().trim().min(1) })
      .strict(),
    note: z.string().optional(),
  })
  .strict();

const DroppedRow = z
  .object({ source: SourceRef, drop: z.literal(true), note: z.string().optional() })
  .strict();

export const ClassroomMapping = z
  .object({ classrooms: z.array(z.union([MappedRow, DroppedRow])) })
  .strict();
export type ClassroomMapping = z.infer<typeof ClassroomMapping>;

/** Where one source classroom goes, as resolved against both databases. */
export type Destination =
  | { kind: "drop"; note: string | undefined }
  | {
      kind: "mapped";
      courseCode: string;
      courseId: string;
      classroomName: string;
      classroomId: string;
      /** The organization the Quiz classroom is connected to, as the report shows it. */
      connectedTo: string;
    };

export interface ResolvedMapping {
  /** Keyed by source classroom id; a classroom with a refusal has no entry. */
  destinations: Map<string, Destination>;
  /** One line per source classroom, for the report. */
  lines: string[];
  /** Blocking: `--apply` refuses while there is one. */
  refusals: string[];
}

function describeSource(c: SourceClassroom, snapshot: SourceSnapshot): string {
  const org = snapshot.organizations.find((o) => o.id === c.orgId);
  const where = org ? `${org.login}${org.githubOrgId === null ? "" : ` #${org.githubOrgId}`}` : "no organization";
  return `"${c.name}" (${c.id}, ${where}${c.archivedAt ? ", archived" : ""})`;
}

/**
 * Resolves the file against the source snapshot and the Quiz database, and
 * checks the organizations: a mapped Quiz classroom must be connected to the
 * organization its source classroom used (spec 06 no. 46), compared on
 * GitHub's organization id, or on the login when the source never resolved
 * the id. Reads only.
 */
export async function resolveMapping(
  db: Db,
  snapshot: SourceSnapshot,
  mapping: ClassroomMapping,
): Promise<ResolvedMapping> {
  const destinations = new Map<string, Destination>();
  const lines: string[] = [];
  const refusals: string[] = [];
  const rowsOf = new Map<string, number>();

  for (const [index, row] of mapping.classrooms.entries()) {
    const at = `mapping row ${index + 1}`;
    const named = snapshot.classrooms.filter(
      (c) =>
        (row.source.id === undefined || c.id === row.source.id) &&
        (row.source.name === undefined || c.name.trim() === row.source.name),
    );
    if (named.length !== 1) {
      refusals.push(
        `${at}: ${named.length === 0 ? "no" : "more than one"} heig-classroom classroom matches ${JSON.stringify(row.source)}`,
      );
      continue;
    }
    const source = named[0]!;
    rowsOf.set(source.id, (rowsOf.get(source.id) ?? 0) + 1);
    if (rowsOf.get(source.id)! > 1) {
      refusals.push(`${at}: ${describeSource(source, snapshot)} is mapped twice`);
      continue;
    }
    if ("drop" in row) {
      destinations.set(source.id, { kind: "drop", note: row.note });
      lines.push(`${describeSource(source, snapshot)} -> dropped${row.note ? ` (${row.note})` : ""}`);
      continue;
    }

    const { course: code, classroom: name } = row.target;
    const [course] = await db.select({ id: courses.id }).from(courses).where(eq(courses.code, code));
    if (!course) {
      refusals.push(`${at}: no Quiz course has the code "${code}"`);
      continue;
    }
    const rooms = await db
      .select({ id: classrooms.id })
      .from(classrooms)
      .where(and(eq(classrooms.courseId, course.id), eq(classrooms.name, name)));
    if (rooms.length !== 1) {
      refusals.push(
        `${at}: ${rooms.length === 0 ? "no" : "more than one"} classroom "${name}" in the Quiz course ${code}`,
      );
      continue;
    }
    const target = rooms[0]!;
    const [link] = await db
      .select({ githubOrgId: githubOrganizations.githubOrgId, login: githubOrganizations.login })
      .from(githubClassroomLinks)
      .innerJoin(githubOrganizations, eq(githubOrganizations.id, githubClassroomLinks.orgId))
      .where(eq(githubClassroomLinks.classroomId, target.id));
    const sourceOrg = snapshot.organizations.find((o) => o.id === source.orgId);
    const intoWhat = `${code} / "${name}" (course ${course.id}, classroom ${target.id})`;
    if (!link) {
      refusals.push(
        `${describeSource(source, snapshot)} -> ${intoWhat}: the Quiz classroom is not connected to GitHub; its teacher connects it to ${sourceOrg?.login ?? "its organization"} first`,
      );
      continue;
    }
    const same =
      sourceOrg !== undefined &&
      (sourceOrg.githubOrgId !== null && link.githubOrgId !== null
        ? sourceOrg.githubOrgId === link.githubOrgId
        : sourceOrg.login.toLowerCase() === link.login.toLowerCase());
    const connectedTo = `${link.login}${link.githubOrgId === null ? "" : ` #${link.githubOrgId}`}`;
    if (!same) {
      refusals.push(
        `${describeSource(source, snapshot)} -> ${intoWhat}: the Quiz classroom is connected to ${connectedTo}, not to the classroom's organization`,
      );
      continue;
    }
    destinations.set(source.id, {
      kind: "mapped",
      courseCode: code,
      courseId: course.id,
      classroomName: name,
      classroomId: target.id,
      connectedTo,
    });
    lines.push(`${describeSource(source, snapshot)} -> ${intoWhat}, connected to ${connectedTo}`);
  }

  for (const c of snapshot.classrooms) {
    if (!rowsOf.has(c.id)) refusals.push(`mapping incomplete: ${describeSource(c, snapshot)} has no row`);
  }
  return { destinations, lines, refusals };
}
