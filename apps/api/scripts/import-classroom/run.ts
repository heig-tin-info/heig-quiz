/**
 * The import itself (merge task M1-06, docs/merge/02-data-and-migration.md
 * §2.5, reduced to identity and rosters by the product owner, 2026-10-01).
 *
 * Plan first, reading only: the mapping (D22), the identities (§2.4), the
 * open decisions. Then every write in ONE transaction, step by step
 * (`steps.ts`), rolled back at the end of a dry run (the default), committed
 * by `--apply`.
 *
 * Never written: the source; sessions and tokens; the `oidc_sub`, profile
 * or settings of a matched Quiz account; courses, classrooms, GitHub
 * organizations and classroom links; an existing enrollment's
 * `time_bonus_percent` and `note`; `users.role` other than through the
 * ordinary recompute; anything on GitHub. Projects, journals, webhooks, the
 * legacy audit, the parity report and the codespace are M8-01's.
 *
 * Idempotent: a source row in `import_classroom.id_map` is never imported
 * again, every other write is "insert unless present", and a run that
 * changed nothing rolls back and records nothing.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { AppConfig } from "../../src/config.js";
import type { Db } from "../../src/db/client.js";
import { importIdMap, users } from "../../src/db/schema.js";
import { normalizeEmail, ownersOf } from "../../src/identity.js";
import { resolveIdentities, targetOf } from "./identity.js";
import { resolveMapping, type ClassroomMapping } from "./mapping.js";
import type { SourceSnapshot } from "./source.js";
import {
  importEnrollments,
  importGithubLinks,
  importGrants,
  importProfiles,
  importStaff,
  importUsers,
  nameOf,
  recomputeRoles,
  recordRun,
  type Ctx,
  type Mapped,
} from "./steps.js";

/**
 * Decisions still open with the product owner (merge task M1-06): `--apply`
 * refuses until each is given explicitly; a dry run without one shows the
 * suggested answer, labelled as such.
 */
export interface OpenDecisions {
  /**
   * (4) A heig-classroom ASSISTANT becomes staff of the Quiz course, which
   * widens their access to every classroom of it (D04 (a)). `staff`
   * (suggested): a seat, listed in the report; `skip`: no seat, listed.
   */
  assistants: "staff" | "skip";
  /**
   * (3) A student on the heig-classroom roster but not on the mapped Quiz
   * roster. `enroll` (suggested): a line added (claimed when the account is
   * known), listed; `report`: listed only.
   */
  missingStudents: "enroll" | "report";
}

export const SUGGESTED: OpenDecisions = { assistants: "staff", missingStudents: "enroll" };

export interface ImportOptions extends Partial<OpenDecisions> {
  apply: boolean;
  /**
   * The Quiz account running the import, by address: an admin (decision of
   * 2026-10-01). Recorded on the run, and as the creator of a grant whose
   * classroom creator is not imported.
   */
  actorEmail: string;
  /** SHA-256 of the mapping file, recorded with the run. */
  mappingSha256: string;
}

/** The sections of findings, in the order of the steps. */
const FINDINGS = {
  source: "Source",
  addresses: "Addresses",
  github: "GitHub account links",
  grants: "Teacher grants",
  staff: "Course staff",
  enrollments: "Enrollments",
  roles: "Role changes",
  "not carried": "Not carried (later tasks)",
} as const;

/** What the import did or would do. Lines name people: the operator's terminal only. */
export interface ImportReport {
  mode: "dry-run" | "apply";
  outcome: "rolled_back" | "applied" | "nothing_to_do" | "refused";
  /** Blocking: `--apply` writes nothing while there is one. */
  refusals: string[];
  mapping: string[];
  decisions: string[];
  identity: Record<
    "alreadyImported" | "swissEduId" | "address" | "placeholder" | "created" | "ambiguous" | "excluded" | "notReached",
    number
  >;
  /** Rows written, per table (a dry run counts what it rolled back). */
  written: Record<string, number>;
  /** Findings, by section. */
  findings: Partial<Record<keyof typeof FINDINGS, string[]>>;
}

/** Ends the transaction without committing. */
class Rollback extends Error {
  constructor(readonly outcome: "rolled_back" | "nothing_to_do") {
    super(outcome);
  }
}

/** Everyone a mapped classroom reaches: owners, staff seats, roster lines. */
function reachedUsers(snapshot: SourceSnapshot, mapped: Map<string, Mapped>): string[] {
  const ids = new Set<string>();
  for (const c of snapshot.classrooms) if (mapped.has(c.id)) ids.add(c.teacherId);
  for (const s of snapshot.staff) if (mapped.has(s.classroomId) && s.userId) ids.add(s.userId);
  for (const e of snapshot.enrollments) if (mapped.has(e.classroomId) && e.userId) ids.add(e.userId);
  return [...ids].sort();
}

/** The admin running the import, or why not. */
async function resolveActor(db: Db, email: string): Promise<string | string[]> {
  const owners = await ownersOf(db, email);
  if (owners.length !== 1) {
    return [`--actor ${email}: ${owners.length} Quiz accounts hold this verified address, one expected`];
  }
  const [actor] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, owners[0]!));
  if (actor?.role !== "admin") return [`--actor ${email}: not an admin`];
  return actor.id;
}

/** `import_classroom.id_map`, by source table then source id. */
async function loadIdMap(db: Db): Promise<Map<string, Map<string, string>>> {
  const known = new Map<string, Map<string, string>>();
  for (const row of await db.select().from(importIdMap)) {
    if (!known.has(row.sourceTable)) known.set(row.sourceTable, new Map());
    known.get(row.sourceTable)!.set(row.sourceId, row.targetId);
  }
  return known;
}

export async function runImport(
  db: Db,
  config: AppConfig,
  snapshot: SourceSnapshot,
  mapping: ClassroomMapping,
  options: ImportOptions,
): Promise<ImportReport> {
  const report: ImportReport = {
    mode: options.apply ? "apply" : "dry-run",
    outcome: "refused",
    refusals: [],
    mapping: [],
    decisions: [],
    identity: { alreadyImported: 0, swissEduId: 0, address: 0, placeholder: 0, created: 0, ambiguous: 0, excluded: 0, notReached: 0 },
    written: {},
    findings: {},
  };
  const usersById = new Map(snapshot.users.map((u) => [u.id, u]));

  // --- Plan (reads only) ---------------------------------------------------
  const resolved = await resolveMapping(db, snapshot, mapping);
  report.mapping = resolved.lines;
  report.refusals.push(...resolved.refusals);
  const mapped = new Map(
    [...resolved.destinations].filter((entry): entry is [string, Mapped] => entry[1].kind === "mapped"),
  );

  for (const e of snapshot.enrollments) {
    if ((e.status === "claimed") !== (e.userId !== null)) {
      report.refusals.push(`source inconsistent: enrollment ${e.id} is ${e.status} with user ${e.userId ?? "none"}`);
    }
    if (e.email !== normalizeEmail(e.email)) {
      (report.findings.source ??= []).push(`enrollment ${e.id}: address not normalized, compared lowercased`);
    }
  }

  const known = await loadIdMap(db);
  const reached = reachedUsers(snapshot, mapped);
  report.identity.notReached = snapshot.users.length - reached.length;
  const identities = await resolveIdentities(db, snapshot, reached, known.get("users") ?? new Map());
  for (const [sourceId, identity] of identities) {
    if (identity.kind === "mapped") report.identity.alreadyImported += 1;
    else if (identity.kind === "new") report.identity.created += 1;
    else if (identity.kind === "excluded") report.identity.excluded += 1;
    else if (identity.kind === "matched") {
      report.identity[identity.how === "swiss_edu_id" ? "swissEduId" : identity.how] += 1;
    } else {
      report.identity.ambiguous += 1;
      report.refusals.push(
        `ambiguous identity: ${nameOf(usersById.get(sourceId))}: ${identity.reason} (Quiz ${identity.candidates.join(", ")}); not merged`,
      );
    }
  }

  const actor = await resolveActor(db, options.actorEmail);
  const actorId = typeof actor === "string" ? actor : null;
  if (typeof actor !== "string") report.refusals.push(...actor);

  const decisions: OpenDecisions = {
    assistants: options.assistants ?? SUGGESTED.assistants,
    missingStudents: options.missingStudents ?? SUGGESTED.missingStudents,
  };
  for (const key of ["assistants", "missingStudents"] as const) {
    const given = options[key] !== undefined;
    const flag = key === "assistants" ? "--assistants" : "--missing-students";
    report.decisions.push(`${flag}=${decisions[key]}${given ? "" : " (suggested, NOT decided)"}`);
    if (options.apply && !given) {
      report.refusals.push(`${flag} is an open decision of the product owner: give it explicitly to --apply`);
    }
  }
  if (options.apply && report.refusals.length > 0) return report;

  // --- Writes (one transaction) --------------------------------------------
  const startedAt = new Date();
  try {
    await db.transaction(async (tx) => {
      const ctx: Ctx = {
        db: tx,
        config,
        snapshot,
        usersById,
        identities,
        resolved: [...identities].filter(([, i]) => targetOf(i) !== undefined),
        mapped,
        decisions,
        actorId,
        known,
        report,
      };
      await importUsers(ctx);
      await importProfiles(ctx);
      await importGithubLinks(ctx);
      await importGrants(ctx);
      await importStaff(ctx);
      await importEnrollments(ctx);
      await recomputeRoles(ctx);
      if (!options.apply) throw new Rollback("rolled_back");
      if (Object.values(report.written).every((n) => n === 0)) throw new Rollback("nothing_to_do");
      await recordRun(ctx, { id: randomUUID(), startedAt, mappingSha256: options.mappingSha256 });
    });
    report.outcome = "applied";
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
    report.outcome = err.outcome;
  }
  return report;
}

/** The report, for a person to read. */
export function formatReport(report: ImportReport): string {
  const out: string[] = [];
  const section = (title: string, lines: readonly string[]) => {
    out.push("", `## ${title}`);
    out.push(...(lines.length > 0 ? lines.map((l) => `- ${l}`) : ["- (none)"]));
  };
  const outcome = {
    rolled_back: "dry run: every write below was rolled back",
    applied: "applied",
    nothing_to_do: "nothing to do: the database already holds this import, nothing written",
    refused: "REFUSED: nothing written",
  }[report.outcome];
  out.push(`# heig-classroom import (M1-06), ${report.mode}: ${outcome}`);
  section("Refusals (blocking --apply)", report.refusals);
  section("Mapping", report.mapping);
  section("Open decisions", report.decisions);
  const i = report.identity;
  section("Identity", [
    `already imported: ${i.alreadyImported}`,
    `matched by swiss_edu_id: ${i.swissEduId}`,
    `matched by verified address: ${i.address}`,
    `matched to an earlier placeholder account: ${i.placeholder}`,
    `new accounts (classroom:<sub>, adopted at first login): ${i.created}`,
    `ambiguous, not merged: ${i.ambiguous}`,
    `left out (heig-classroom development accounts): ${i.excluded}`,
    `not reached by a mapped classroom, not imported: ${i.notReached}`,
  ]);
  section(
    "Rows written",
    Object.entries(report.written)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, n]) => `${table}: ${n}`),
  );
  for (const [key, title] of Object.entries(FINDINGS) as [keyof typeof FINDINGS, string][]) {
    const lines = report.findings[key];
    if (lines) section(title, lines);
  }
  section("Not checked here (M8-01)", [
    "heig-classroom stopped, its queues empty, no unprocessed webhook delivery",
    "no assignment deadline + grace inside the window",
    "projects, journals, webhooks, legacy audit, parity report, codespace",
  ]);
  return out.join("\n");
}
