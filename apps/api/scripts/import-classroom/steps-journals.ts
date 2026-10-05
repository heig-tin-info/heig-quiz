/**
 * Classroom journals (M8-01d, D03, D14, I65). One `classroom_journals` row per
 * journal attachment of a mapped classroom, in GitHub mode, `sync_status =
 * pending`: the repository stays the source of truth, and the copy is rebuilt
 * by the journal module's own ingestion (a Refresh, or the next push). Pages
 * and assets are NEVER copied (I65: classroom's `html` links assets at its own
 * URLs, its `warnings` and `sync_error` are English sentences): the importer
 * reads neither `journal_pages` nor `journal_assets` and writes neither of
 * Quiz's.
 *
 * What is left out, and listed (the row is Quiz's to make, from the journal
 * tab, with the repository chosen there):
 * - a journal of ANOTHER organization than its classroom's: Quiz reads a
 *   classroom's repository through the installation of the classroom's own
 *   organization (`journal/ingest.ts`), which cannot see that repository, so
 *   the row could only ever say `error`;
 * - a journal with no repository id yet (classroom resolves it lazily): the
 *   ingestion follows the immutable id, and a Quiz row cannot exist without
 *   one (`classroom_journals_mode_ck`);
 * - a classroom whose Quiz journal already points elsewhere (Quiz's, never
 *   rewritten), and one with nobody to record as its author.
 *
 * Imported PENDING even when the organization's App is not (yet) installed
 * or is suspended: the row is inert, tells the staff a journal is waiting, and
 * heals by itself with the first Refresh or push once the App acts; refusing
 * it would only make the next import the one to bring it back. Reported.
 *
 * One journal read by several classrooms is several rows (the key is the
 * classroom). A row the import created follows classroom's repository, branch
 * and folder on a later run, unless Quiz changed it (`syncOwned`: a rename
 * the ingestion followed counts as Quiz's change, and is kept); an
 * overwritten row goes back to `pending` and its `version` is bumped, so an
 * ingestion that started before never commits over it (fix J2).
 */
import { eq, inArray, sql } from "drizzle-orm";

import { classroomJournals, githubClassroomLinks, githubOrganizations } from "../../src/db/schema.js";
import { actsOn } from "../../src/modules/github/service.js";
import { note, remember, syncOwned, tallyMapped, target, written, type Ctx, type OwnedRow } from "./ctx.js";
import type { ImportCheck } from "./registry.js";
import type { SourceJournalAttachment } from "./source.js";

const TABLE = "classroom_journals";

/** The columns the import owns of a journal row, as inserted. */
const journalRow = (a: SourceJournalAttachment): OwnedRow => ({
  sourceTable: TABLE,
  sourceId: a.classroomId,
  table: classroomJournals,
  idColumn: classroomJournals.classroomId,
  label: `${a.fullName}@${a.ref}`,
  values: { mode: "github", githubRepoId: a.githubRepoId, fullName: a.fullName, ref: a.ref, rootPath: a.rootPath },
});

export async function importJournals(ctx: Ctx) {
  const leftOut = new Map<string, string>();
  const inScope = ctx.snapshot.journalAttachments.filter((a) => ctx.mapped.has(a.classroomId));
  const orgLogin = (orgId: string) => ctx.snapshot.organizations.find((o) => o.id === orgId)?.login ?? orgId;
  for (const a of inScope) {
    const dest = ctx.mapped.get(a.classroomId)!;
    const room = ctx.snapshot.classrooms.find((c) => c.id === a.classroomId)!;
    const where = `"${dest.classroomName}" (${dest.courseCode}): journal ${a.fullName}@${a.ref}`;
    const skip = (why: string, finding: string) => {
      leftOut.set(a.classroomId, why);
      note(ctx, "journals", `${where}: ${finding}`);
    };
    if (a.orgId !== room.orgId) {
      skip(
        "journal of another organization",
        `belongs to ${orgLogin(a.orgId)}, not to the classroom's ${orgLogin(room.orgId)}; not imported, the teacher chooses a repository of ${orgLogin(room.orgId)} in the journal tab`,
      );
      continue;
    }
    if (a.githubRepoId === null) {
      skip("repository not resolved in classroom", "classroom never resolved its repository id; not imported, the teacher chooses the repository in the journal tab");
      continue;
    }
    const row = journalRow(a);
    if (ctx.known.get(TABLE)?.has(a.classroomId)) {
      if ((await syncOwned(ctx, row)) === "overwritten") {
        await ctx.db
          .update(classroomJournals)
          .set({ syncStatus: "pending", syncError: null, version: sql`${classroomJournals.version} + 1` })
          .where(eq(classroomJournals.classroomId, dest.classroomId));
        ctx.journalsToIngest.add(dest.classroomId);
        note(ctx, "journals", `${where}: repository, branch or folder changed in classroom, overwritten; copy pending again`);
      }
      continue;
    }
    const createdBy = target(ctx, a.attachedBy) ?? ctx.actorId;
    if (!createdBy) {
      skip("no author to record", "no author to record (attached by an unresolved account and no --actor); not imported");
      continue;
    }
    const [existing] = await ctx.db.select().from(classroomJournals).where(eq(classroomJournals.classroomId, dest.classroomId));
    if (existing) {
      if (existing.mode === "github" && existing.githubRepoId === a.githubRepoId && existing.ref === a.ref) {
        await remember(ctx, TABLE, a.classroomId, dest.classroomId, "merged");
      } else {
        skip(
          "the Quiz classroom has a journal of its own",
          `the Quiz classroom already has a journal (${existing.mode === "github" ? `${existing.fullName}@${existing.ref}` : "in Quiz"}); Quiz's kept`,
        );
      }
      continue;
    }
    await ctx.db.insert(classroomJournals).values({
      classroomId: dest.classroomId,
      mode: "github",
      githubRepoId: a.githubRepoId,
      fullName: a.fullName,
      ref: a.ref,
      rootPath: a.rootPath,
      syncStatus: "pending",
      createdBy,
      createdAt: a.attachedAt,
    });
    written(ctx, TABLE);
    ctx.journalsToIngest.add(dest.classroomId);
    await remember(ctx, TABLE, a.classroomId, dest.classroomId, "created", row);
    const [link] = await ctx.db
      .select({ installationId: githubOrganizations.installationId, suspendedAt: githubOrganizations.suspendedAt, status: githubOrganizations.status })
      .from(githubClassroomLinks)
      .innerJoin(githubOrganizations, eq(githubOrganizations.id, githubClassroomLinks.orgId))
      .where(eq(githubClassroomLinks.classroomId, dest.classroomId));
    if (!link || !actsOn(link)) {
      note(ctx, "journals", `${where}: imported pending, but Quiz's App does not act on ${dest.connectedTo} (not installed, suspended or not active); the copy waits for it`);
    }
  }
  tallyMapped(ctx, TABLE, inScope.map((a) => a.classroomId), leftOut);
}

/**
 * After the commit, outside any transaction: the journal module's own ingestion
 * (`ingestJournal`, what a Refresh enqueues; never a second path) for every row
 * this run created or overwrote, one after the other, in a stable order. The
 * outcome is on the row (`ok`, `error` and its code), which `journalsReingested`
 * reads next; a throw (the database) is reported and does not stop the others.
 */
export async function ingestImportedJournals(ctx: Omit<Ctx, "db">) {
  if (!ctx.ingestJournal) return;
  for (const classroomId of [...ctx.journalsToIngest].sort()) {
    try {
      await ctx.ingestJournal(classroomId);
    } catch (err) {
      note(ctx, "journals", `classroom ${classroomId}: ingestion failed, ${String((err as Error)?.message ?? err)}`);
    }
  }
}

/**
 * After the commit: every journal row the import carries is read back. `ok` is
 * what the card asks for; `pending` (a run with no GitHub App, so no
 * ingestion) is a `warn` (a Refresh of the journal, or a push, does it), and
 * an `error` is red with its code.
 */
export const journalsReingested: ImportCheck = {
  name: "journals re-ingested",
  githubBound: true,
  async run(ctx) {
    const ids = [...(ctx.known.get(TABLE)?.values() ?? [])];
    if (ids.length === 0) return [];
    const rows = await ctx.db
      .select({
        classroomId: classroomJournals.classroomId,
        status: classroomJournals.syncStatus,
        error: classroomJournals.syncError,
        label: classroomJournals.fullName,
        ref: classroomJournals.ref,
      })
      .from(classroomJournals)
      .where(inArray(classroomJournals.classroomId, ids));
    const findings: Awaited<ReturnType<ImportCheck["run"]>> = [];
    for (const r of rows.filter((r) => r.status !== "ok")) {
      const at = `${r.label}@${r.ref} (classroom ${r.classroomId})`;
      findings.push(
        r.status === "error"
          ? { severity: "red", detail: `${at}: ingestion failed, ${r.error ?? "no code"}` }
          : { severity: "warn", detail: `${at}: not re-ingested yet; Refresh it from the journal tab, or wait for a push` },
      );
    }
    findings.push({ severity: "info", detail: `${rows.filter((r) => r.status === "ok").length} of ${ids.length} imported journal(s) at sync_status ok` });
    return findings;
  },
};
