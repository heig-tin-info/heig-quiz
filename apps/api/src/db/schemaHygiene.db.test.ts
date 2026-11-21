/**
 * The catalog of the migrated database, read as a regression guard
 * (docs/audits/2026-11-21-database-remediation.md, Phase 2.4):
 *
 *   - every table of `public` has a primary key;
 *   - every foreign key has a covering index: a plain (non-partial) btree
 *     that leads with one of the key's columns — the key's only column, or
 *     for a composite key, one of its own (`gradings`' composite key is
 *     served by the index on `answer_id`). Without one, deleting a parent
 *     row scans the child table, once per row deleted.
 *
 * A ratchet: a new foreign key without its index fails here, and so does an
 * entry of the allowlist below that no longer names an unindexed key (it was
 * indexed or dropped: take it out). The allowlist holds today's accepted
 * exceptions, grouped by the reason they are accepted.
 */
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "./client.js";
import { testDb } from "../test/db.js";

/** A foreign key, as `table(column, ...) -> parent`, its columns in the key's order. */
type ForeignKeyName = string;

const UNINDEXED_FOREIGN_KEYS: readonly { reason: string; keys: readonly ForeignKeyName[] }[] = [
  {
    reason: "An account is never deleted, only pseudonymized in place (ADR-117): the key's action never runs.",
    keys: [
      "answer_acceptances(created_by) -> users",
      "assets(owner_id) -> users",
      "classroom_journals(created_by) -> users",
      "codespace_launches(user_id) -> users",
      "codespace_relays(user_id) -> users",
      "concept_aliases(created_by) -> users",
      "concept_relations(created_by) -> users",
      "concepts(created_by) -> users",
      "contestations(filed_by) -> users",
      "contestations(proposed_by) -> users",
      "contestations(resolved_by) -> users",
      "course_concepts(added_by) -> users",
      "deadline_reminders(user_id) -> users",
      "evaluations(created_by) -> users",
      "github_classroom_links(linked_by) -> users",
      "github_org_grants(granted_by) -> users",
      "gradebook_columns(updated_by) -> users",
      "gradebook_components(updated_by) -> users",
      "gradebook_marks(set_by) -> users",
      "gradebook_settings(updated_by) -> users",
      "gradings(graded_by) -> users",
      "group_sets(created_by) -> users",
      "journal_page_revisions(author_id) -> users",
      "kiosk_pairings(approved_by) -> users",
      "kiosk_pairings(user_id) -> users",
      "launch_tickets(actor_user_id) -> users",
      "llm_calls(user_id) -> users",
      "llm_settings(updated_by) -> users",
      "oauth_requests(user_id) -> users",
      "paper_sheets(entered_by) -> users",
      "paper_sheets(scan_uploaded_by) -> users",
      "project_contestations(filed_by) -> users",
      "project_contestations(proposed_by) -> users",
      "project_contestations(resolved_by) -> users",
      "project_criterion_grades(created_by) -> users",
      "project_repos(grade_adjusted_by) -> users",
      "project_repos(teacher_graded_by) -> users",
      "projects(created_by) -> users",
      "projects(group_resync_by) -> users",
      "projects(released_by) -> users",
      "question_reports(reporter_id) -> users",
      "question_reports(resolved_by) -> users",
      "question_reviews(ignored_by) -> users",
      "question_versions(published_by) -> users",
      "questions(created_by) -> users",
      "review_pools(enabled_by) -> users",
      "sessions(actor_user_id) -> users",
      "sessions(user_id) -> users",
      "teacher_grants(created_by) -> users",
    ],
  },
  {
    reason: "A lineage inside one table (supersede chain, copy origin, merge target, tree parent): the row named goes with its family.",
    keys: [
      "attempts(superseded_by) -> attempts",
      "categories(parent_id) -> categories",
      "concepts(merged_into) -> concepts",
      "evaluations(origin_template_id) -> evaluations",
      "gradings(supersedes_id) -> gradings",
      "project_criterion_grades(supersedes_id) -> project_criterion_grades",
      "questions(origin_question_id) -> questions",
    ],
  },
  {
    reason: "A grade row a contestation names: grade rows are append-only and go only with the attempt or repository its contestations go with.",
    keys: [
      "contestations(grading_at_filing_id) -> gradings",
      "contestations(grading_at_proposal_id) -> gradings",
      "contestations(grading_at_resolution_id) -> gradings",
      "project_contestations(grade_at_filing_id) -> project_criterion_grades",
      "project_contestations(grade_at_proposal_id) -> project_criterion_grades",
      "project_contestations(grade_at_resolution_id) -> project_criterion_grades",
    ],
  },
  {
    reason: "A partial index serves the reads; an item goes only before any attempt or with its evaluation, a roster line rarely.",
    keys: [
      "contestations(item_id) -> evaluation_items",
      "gradings(item_id) -> evaluation_items",
      "project_repo_access(enrollment_id) -> enrollments",
    ],
  },
  {
    reason: "A confined sitting's activity or station (sessions, launch tickets, kiosk pairings): small tables of short-lived rows.",
    keys: [
      "kiosk_pairings(evaluation_id) -> evaluations",
      "kiosk_pairings(project_id) -> projects",
      "launch_tickets(evaluation_id) -> evaluations",
      "launch_tickets(project_id) -> projects",
      "sessions(device_id) -> kiosk_devices",
      "sessions(evaluation_id) -> evaluations",
      "sessions(kiosk_pairing_id) -> kiosk_pairings",
      "sessions(project_id) -> projects",
    ],
  },
  {
    reason: "Column updated on a hot path; an index would cost HOT updates; the parent is deleted rarely and the table is small.",
    keys: [
      "attempts(last_item_id) -> evaluation_items",
      "project_repos(current_grade_run_id) -> project_grade_runs",
      "project_repos(frozen_grade_run_id) -> project_grade_runs",
      "project_repos(review_grade_run_id) -> project_grade_runs",
    ],
  },
  {
    reason: "Not measured yet: small tables or rare deletions, left to the statistics of Phase 2.1 (pg_stat_statements).",
    keys: [
      "answer_acceptances(attempt_id) -> attempts",
      "codespace_reviews(project_repo_id) -> project_repos",
      "evaluations(course_id) -> courses",
      "grade_dispatches(checkpoint_id) -> project_checkpoints",
      "gradebook_columns(evaluation_id) -> evaluations",
      "gradebook_columns(project_id) -> projects",
      "oauth_grants(client_id) -> oauth_clients",
      "oauth_requests(client_id) -> oauth_clients",
      "project_criterion_grades(locked_by_checkpoint_id) -> project_checkpoints",
      "user_course_prefs(course_id) -> courses",
    ],
  },
];

let db: Db;
beforeAll(async () => {
  db = await testDb();
});

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

describe("the schema's hygiene", () => {
  it("gives every table of public a primary key", async () => {
    const missing = await rows<{ table: string }>(sql`
      SELECT c.relname AS "table"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')
      ORDER BY 1`);
    expect(missing.map((r) => r.table)).toEqual([]);
  });

  it("indexes every foreign key, but the accepted exceptions", async () => {
    const keys = await rows<{ table: string; columns: string[]; parent: string }>(sql`
      SELECT c.conrelid::regclass::text AS "table", c.confrelid::regclass::text AS "parent",
        array(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
              ORDER BY k.ord) AS "columns"
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'`);
    // Expression positions are 0 in `indkey` and name no column.
    const indexes = await rows<{ table: string; columns: (string | null)[] }>(sql`
      SELECT i.indrelid::regclass::text AS "table",
        array(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
              LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
              WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS "columns"
      FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_am am ON am.oid = ic.relam
        JOIN pg_namespace n ON n.oid = ic.relnamespace
      WHERE n.nspname = 'public' AND am.amname = 'btree' AND i.indpred IS NULL`);

    const covered = (table: string, columns: readonly string[]) =>
      indexes.some((index) => index.table === table && index.columns[0] != null && columns.includes(index.columns[0]));
    const unindexed = keys
      .filter((key) => !covered(key.table, key.columns))
      .map((key) => `${key.table}(${key.columns.join(", ")}) -> ${key.parent}`)
      .sort();
    const accepted = UNINDEXED_FOREIGN_KEYS.flatMap((group) => group.keys).sort();

    // Both ways: a new unindexed key fails, and so does a stale exception.
    expect(unindexed).toEqual(accepted);
  });

  it("lists each accepted exception once", () => {
    const accepted = UNINDEXED_FOREIGN_KEYS.flatMap((group) => group.keys);
    expect(new Set(accepted).size).toBe(accepted.length);
  });
});
