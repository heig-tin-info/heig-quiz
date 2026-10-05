/**
 * The import itself (merge tasks M1-06 and M8-01, docs/merge/02-data-and-
 * migration.md §2.5): the FRAME that the entities plug into.
 *
 * Plan first, reading only: the mapping (D22), the identities (§2.4), the
 * decisions, the source's pre-flight (`preflight.ts`). Then every write in
 * ONE transaction, step by step (`registry.ts`), the parity report built
 * inside it, and the transaction rolled back at the end of a dry run (the
 * default) or when an `--apply` finds a red line; committed otherwise.
 * GitHub-bound checks (`ImportCheck.githubBound`) run after the commit, and
 * are reported "not run" in a dry run.
 *
 * Two imports are expected (D26): a first one while heig-classroom lives,
 * then the final one at the cutover (`--final`, which also enforces the
 * source-state pre-flight). A row already imported is overwritten from
 * classroom unless Quiz modified it since, in which case it is kept and
 * listed (`ctx.ts`, `syncOwned`).
 *
 * Never written: the source; sessions and tokens; the `oidc_sub`, profile
 * or settings of a matched Quiz account; courses, classrooms, GitHub
 * organizations and classroom links (D20, D22: teachers install the App and
 * connect by hand; a red line if one moves); an existing enrollment's
 * `time_bonus_percent` and `note`; `users.role` other than through the
 * ordinary recompute; anything on GitHub before the post-commit checks.
 *
 * Idempotent: a source row in `import_classroom.id_map` is not imported
 * again (a row the import created is refreshed only by the re-import rule),
 * every other write is "insert unless present", and a run that changed
 * nothing rolls back and records nothing.
 */
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import type { AppConfig } from "../../src/config.js";
import type { Db } from "../../src/db/client.js";
import { classrooms, courses, githubClassroomLinks, githubOrganizations, importIdMap, users } from "../../src/db/schema.js";
import { normalizeEmail, ownersOf } from "../../src/identity.js";
import type { Ctx, Mapped } from "./ctx.js";
import { nameOf } from "./ctx.js";
import { resolveIdentities, targetOf } from "./identity.js";
import { resolveMapping, type ClassroomMapping } from "./mapping.js";
import { DEFAULT_WINDOW_HOURS, RUNBOOK, sourcePreflight } from "./preflight.js";
import { REGISTRY, type Registry } from "./registry.js";
import { DEFAULTS, newReport, type ImportReport, type OpenDecisions } from "./report.js";
import type { SourceSnapshot } from "./source.js";
import { recordRun } from "./steps.js";

export { DEFAULTS, formatReport, type ImportReport, type OpenDecisions } from "./report.js";

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
  /** The cutover import: the source-state pre-flight then refuses (`preflight.ts`). */
  final?: boolean;
  /** The pre-flight's clock; the source's own `now()` by default. */
  now?: Date;
  /** Look-ahead for a deadline falling during the cutover; 24 h by default. */
  windowHours?: number;
  /** The steps and checks; `REGISTRY` by default (tests inject their own). */
  registry?: Registry;
}

/** Ends the transaction without committing. */
class Rollback extends Error {
  constructor(readonly outcome: "rolled_back" | "nothing_to_do" | "red_lines") {
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

/**
 * Tables the import must never write (D20, D22). A fingerprint, not a count:
 * the row count and a hash of every row's text, so an UPDATE trips the red
 * line as well as an INSERT or DELETE.
 */
const PROTECTED = { courses, classrooms, github_organizations: githubOrganizations, github_classroom_links: githubClassroomLinks } as const;

async function protectedFingerprints(db: Db | Ctx["db"]) {
  const prints: Record<string, { n: number; hash: string }> = {};
  for (const [name, table] of Object.entries(PROTECTED)) {
    const res = (await db.execute(
      sql`SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS hash FROM ${table} AS t`,
    )) as unknown as { rows: { n: number; hash: string }[] };
    prints[name] = res.rows[0]!;
  }
  return prints;
}

/** Every red line, derived from the findings in ONE place. */
function deriveRedLines(report: ImportReport) {
  report.parity.redLines = report.parity.findings.filter((f) => f.severity === "red").map((f) => `${f.check}: ${f.detail}`);
}

/** The parity report, from what the steps tallied and what must not have moved. */
async function buildParity(ctx: Ctx, before: Awaited<ReturnType<typeof protectedFingerprints>>, registry: Registry) {
  const { parity } = ctx.report;
  for (const [table, entry] of [...ctx.parity].sort(([a], [b]) => a.localeCompare(b))) {
    const row = {
      table,
      source: entry.source,
      carried: entry.carried,
      leftOut: entry.leftOut.length,
      missing: entry.source - entry.carried - entry.leftOut.length,
    };
    parity.tables.push(row);
    if (row.missing !== 0) {
      record(ctx.report, {
        check: table,
        severity: "red",
        detail: `${row.missing} source row(s) neither carried nor left out on purpose (source ${row.source}, carried ${row.carried}, left out ${row.leftOut})`,
      });
    }
    for (const line of entry.leftOut) parity.findings.push({ check: `${table} left out`, severity: "info", detail: line });
  }
  const after = await protectedFingerprints(ctx.db);
  for (const [table, was] of Object.entries(before)) {
    const now = after[table]!;
    if (now.n !== was.n || now.hash !== was.hash) {
      record(ctx.report, {
        check: table,
        severity: "red",
        detail: `${was.n} row(s) before the import, ${now.n} after${now.n === was.n ? " (content changed)" : ""}; the import never writes this table (D20, D22)`,
      });
    }
  }
  for (const check of registry.checks.filter((c) => !c.githubBound)) {
    for (const f of await check.run(ctx)) record(ctx.report, { check: check.name, ...f });
  }
  deriveRedLines(ctx.report);
}

function record(report: ImportReport, finding: ImportReport["parity"]["findings"][number]) {
  report.parity.findings.push(finding);
}

export async function runImport(
  db: Db,
  config: AppConfig,
  snapshot: SourceSnapshot,
  mapping: ClassroomMapping,
  options: ImportOptions,
): Promise<ImportReport> {
  const registry = options.registry ?? REGISTRY;
  const final = options.final === true;
  const report = newReport(options.apply ? "apply" : "dry-run", final);
  report.runbook = [...RUNBOOK];
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

  report.preflight = sourcePreflight({
    snapshot,
    mappedClassroomIds: new Set(mapped.keys()),
    now: options.now ?? snapshot.activity.now,
    windowHours: options.windowHours ?? DEFAULT_WINDOW_HOURS,
    final,
  });
  for (const p of report.preflight.filter((p) => p.status === "refused")) {
    report.refusals.push(...p.problems.map((x) => `pre-flight ${p.id}: ${x}`));
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
    assistants: options.assistants ?? DEFAULTS.assistants,
    missingStudents: options.missingStudents ?? DEFAULTS.missingStudents,
  };
  report.decisions.push(
    `--assistants=${decisions.assistants}${options.assistants === undefined ? " (default, product owner 2026-10-05)" : ""}`,
    `--missing-students=${decisions.missingStudents}${options.missingStudents === undefined ? " (default, product owner 2026-10-05)" : ""}`,
  );
  if (options.apply && report.refusals.length > 0) return report;

  // --- Writes (one transaction) --------------------------------------------
  const startedAt = new Date();
  let committed: Ctx | undefined;
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
        now: options.now ?? snapshot.activity.now,
        actorId,
        known,
        parity: new Map(),
        report,
      };
      const before = await protectedFingerprints(tx);
      for (const step of registry.steps) await step.run(ctx);
      await buildParity(ctx, before, registry);
      if (!options.apply) throw new Rollback("rolled_back");
      if (report.parity.redLines.length > 0) throw new Rollback("red_lines");
      committed = ctx;
      const overwritten = Object.values(report.reimport.overwritten).reduce((a, b) => a + b, 0);
      if (overwritten === 0 && Object.values(report.written).every((n) => n === 0)) throw new Rollback("nothing_to_do");
      await recordRun(ctx, { id: randomUUID(), startedAt, mappingSha256: options.mappingSha256 });
    });
    report.outcome = "applied";
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
    report.outcome = err.outcome;
  }

  // --- GitHub-bound checks: after the commit, never in a dry run -----------
  const bound = registry.checks.filter((c) => c.githubBound);
  if (committed && (report.outcome === "applied" || report.outcome === "nothing_to_do")) {
    const ctx = committed;
    await db.transaction(async (tx) => {
      for (const check of bound) for (const f of await check.run({ ...ctx, db: tx })) record(report, { check: check.name, ...f });
    });
    deriveRedLines(report);
  } else {
    report.parity.notRun.push(...bound.map((c) => `${c.name}: not run (${options.apply ? "nothing was committed" : "dry run"})`));
  }
  return report;
}
