/**
 * What every step of the import shares: the context, the report helpers, the
 * id map, the parity tally and the re-import rule. Steps live in `steps.ts`
 * (identity and rosters, M1-06), `steps-audit.ts` (the legacy audit) and, as
 * the later parts of M8-01 land, `steps-<entity>.ts`; `registry.ts` is the
 * ONE list that orders them, so a new entity adds a file and one line.
 *
 * The re-import rule (product owner, 2026-10-05, D26: a first import, then a
 * final one at the cutover): a row the import created is OVERWRITTEN from
 * classroom on a later run, unless Quiz has modified it since the previous
 * import, in which case it is KEPT and listed. "Modified" is a hash: right
 * after writing a row, the hash of the columns the import owns is stored in
 * `id_map.imported_hash`; the next run hashes the row again and compares. A
 * hash and not a timestamp because Quiz's tables do not all carry an
 * `updated_at`, and the one rule then holds for every table. A row Quiz
 * deleted is kept deleted and listed; a row the import only MERGED into an
 * existing Quiz row (a matched account, a roster line) is Quiz's and never
 * rewritten.
 */
import { createHash } from "node:crypto";

import { and, eq, getTableColumns, getTableName, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import type { AppConfig } from "../../src/config.js";
import type { Tx } from "../../src/db/client.js";
import { importIdMap } from "../../src/db/schema.js";
import type { Identity } from "./identity.js";
import { targetOf } from "./identity.js";
import type { Destination } from "./mapping.js";
import type { ImportReport, OpenDecisions } from "./report.js";
import type { SourceEnrollment, SourceGroup, SourceSnapshot, SourceUser } from "./source.js";

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
  /** The run's clock (`ImportOptions.now`, else the source's own `now()`): what "the last 30 days" is measured from. */
  now: Date;
  /** Quiz classrooms whose journal row this run created or overwrote: ingested after the commit (`registry.ts`, `afterCommit`). */
  journalsToIngest: Set<string>;
  /** The journal module's ingestion, as the Refresh runs it; null when the run has no GitHub App (`ImportOptions.ingestJournal`). */
  ingestJournal: ((classroomId: string) => Promise<unknown>) | null;
  /** The `--actor`, null when unresolved (a dry run then still runs). */
  actorId: string | null;
  /** `import_classroom.id_map`, loaded once and kept current by `remember`: source table → source id → target id. */
  known: Map<string, Map<string, string>>;
  /** The source user ids of the roster lines of each group, in member order (`repoOwner`). */
  groupUsers: Map<string, { userId: string; enrollmentId: string }[]>;
  /** The source's groups and roster lines by id. */
  groupsById: Map<string, SourceGroup>;
  linesById: Map<string, SourceEnrollment>;
  /** Group and member source ids an earlier run had carried before this one wrote (the group checks leave them alone: Quiz's staff may have edited them since). */
  carriedBefore: { groups: Set<string>; members: Set<string> };
  /** Source ids of the copy groups an earlier run carried and Quiz deleted since (`importGroups`): nothing is carried under them. */
  goneCopyGroups: Set<string>;
  /** Source rows each table meant to carry, filled by the steps (`tally`), read by the parity report. */
  parity: Map<string, ParityEntry>;
  report: ImportReport;
}

export interface ParityEntry {
  /** Rows the source holds in scope (the mapped classrooms' own). */
  source: number;
  /** Rows now in Quiz for them. */
  carried: number;
  /** Source rows left out on purpose, with the reason. */
  leftOut: string[];
}

export function note(ctx: Pick<Ctx, "report">, section: Finding, line: string) {
  (ctx.report.findings[section] ??= []).push(line);
}

/** A line of a list the operator acts on (`ImportReport.lists`); also a finding of `section`. */
export function listed(ctx: Ctx, list: keyof ImportReport["lists"], section: Finding, line: string) {
  ctx.report.lists[list].push(line);
  note(ctx, section, line);
}

export function written(ctx: Ctx, table: string, n = 1) {
  if (n > 0) ctx.report.written[table] = (ctx.report.written[table] ?? 0) + n;
}

export function nameOf(user: SourceUser | undefined): string {
  if (!user) return "unknown user";
  if (user.anonymizedAt) return `anonymized user ${user.id}`;
  return `${user.givenName} ${user.familyName} <${user.email}> (${user.id})`;
}

export const target = (ctx: Ctx, sourceUserId: string | null) =>
  sourceUserId === null ? undefined : targetOf(ctx.identities.get(sourceUserId));

/** The source rows a step meant to carry, and what became of them: the parity report reads it. */
export function tally(ctx: Ctx, table: string, entry: ParityEntry) {
  ctx.parity.set(table, entry);
}

/** `tally` for a table the id map carries: carried = the source ids now mapped. */
export function tallyMapped(ctx: Ctx, table: string, sourceIds: readonly string[], leftOut: ReadonlyMap<string, string> = new Map()) {
  const known = ctx.known.get(table);
  tally(ctx, table, {
    source: sourceIds.length,
    carried: sourceIds.filter((id) => known?.has(id)).length,
    leftOut: [...leftOut].map(([id, why]) => `${id}: ${why}`),
  });
}

/** A Quiz table whose rows the import may own: a uuid `id` primary key, or the `idColumn` the row names. */
export type OwnedTable = PgTable;

/** The columns the import owns of one row: Drizzle property names → values, as inserted. */
export interface OwnedRow {
  sourceTable: string;
  sourceId: string;
  table: OwnedTable;
  /** The primary key, when it is not `table.id` (a journal's row is keyed on its classroom). Its value is the id map's target id. */
  idColumn?: AnyPgColumn;
  /** For the report. */
  label: string;
  values: Record<string, unknown>;
}

const hashOf = (values: Record<string, unknown>) =>
  createHash("sha256")
    .update(JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k] === undefined ? null : values[k]])))
    .digest("hex");

/** The row as Quiz holds it now, restricted to the owned columns. */
async function currentValues(ctx: Ctx, row: OwnedRow, targetId: string): Promise<Record<string, unknown> | undefined> {
  const columns = getTableColumns(row.table);
  const [found] = await ctx.db
    .select(Object.fromEntries(Object.keys(row.values).map((k) => [k, columns[k]!])))
    .from(row.table)
    .where(eq(keyOf(row), targetId));
  return found as Record<string, unknown> | undefined;
}

const keyOf = (row: OwnedRow): AnyPgColumn => row.idColumn ?? (row.table as PgTable & { id: AnyPgColumn }).id;

const mapRow = (row: OwnedRow): SQL =>
  and(eq(importIdMap.sourceTable, row.sourceTable), eq(importIdMap.sourceId, row.sourceId))!;

/** Records the id map entry; `owned` also records the re-import baseline. */
export async function remember(
  ctx: Ctx,
  sourceTable: string,
  sourceId: string,
  targetId: string,
  how: string,
  owned?: OwnedRow,
) {
  const done = await ctx.db
    .insert(importIdMap)
    .values({ sourceTable, sourceId, targetId, how })
    .onConflictDoNothing()
    .returning({ sourceId: importIdMap.sourceId });
  written(ctx, "import_classroom.id_map", done.length);
  if (done.length > 0) {
    if (!ctx.known.has(sourceTable)) ctx.known.set(sourceTable, new Map());
    ctx.known.get(sourceTable)!.set(sourceId, targetId);
  }
  if (owned && done.length > 0) {
    const now = await currentValues(ctx, owned, targetId);
    await ctx.db
      .update(importIdMap)
      .set({ targetTable: getTableName(owned.table), importedHash: hashOf(now ?? {}), sourceHash: hashOf(owned.values) })
      .where(mapRow(owned));
  }
}

function keep(ctx: Ctx, row: OwnedRow, targetId: string, reason: string): "kept" {
  ctx.report.reimport.kept.push({ table: row.sourceTable, sourceId: row.sourceId, targetId, label: row.label, reason });
  note(ctx, "reimport", `${row.sourceTable} ${row.label}: kept, ${reason}`);
  return "kept";
}

export type SyncOutcome = "unchanged" | "overwritten" | "kept";

/**
 * The re-import of a row already in the id map (see the header). Only a row
 * the import created is owned; any other `how` is "unchanged".
 *
 * - classroom's side unchanged since the last run: nothing, whoever touched
 *   the Quiz row (there is no conflict to report);
 * - classroom's side changed and the Quiz row still hashes to what the import
 *   left: overwritten, baseline refreshed;
 * - classroom's side changed and Quiz changed or deleted the row: kept, listed
 *   (every run lists it again until the people settle it);
 * - no baseline (a row an earlier version of the script wrote): adopted when
 *   the Quiz row equals classroom's, otherwise kept, as Quiz's.
 */
export async function syncOwned(ctx: Ctx, row: OwnedRow): Promise<SyncOutcome> {
  const [entry] = await ctx.db.select().from(importIdMap).where(mapRow(row));
  if (!entry || entry.how !== "created") return "unchanged";
  const targetId = entry.targetId;
  const sourceHash = hashOf(row.values);
  const current = await currentValues(ctx, row, targetId);
  const setBaseline = async (hash: string) => {
    await ctx.db
      .update(importIdMap)
      .set({ targetTable: getTableName(row.table), importedHash: hash, sourceHash })
      .where(mapRow(row));
    written(ctx, "import_classroom.id_map");
  };

  if (entry.importedHash === null) {
    if (current && hashOf(current) === sourceHash) {
      await setBaseline(sourceHash);
      return "unchanged";
    }
    return keep(ctx, row, targetId, "no baseline from an earlier import and the row differs from classroom's");
  }
  if (entry.sourceHash === sourceHash) return "unchanged";
  if (!current) return keep(ctx, row, targetId, "deleted in Quiz since the previous import; classroom's row changed too");
  if (hashOf(current) !== entry.importedHash) {
    return keep(ctx, row, targetId, "modified in Quiz since the previous import; classroom's row changed too");
  }
  await ctx.db.update(row.table).set(row.values).where(eq(keyOf(row), targetId));
  await setBaseline(hashOf((await currentValues(ctx, row, targetId)) ?? {}));
  ctx.report.reimport.overwritten[row.sourceTable] = (ctx.report.reimport.overwritten[row.sourceTable] ?? 0) + 1;
  return "overwritten";
}
