/**
 * What production's data goes through on its way to staging (ADR-028,
 * N-SEC-18, M2-06; audit M9, L17): `scripts/staging-pseudonymize.sql`, which
 * `staging-export.sh` pipes into production's scratch copy, then
 * `scripts/staging-scrub.sql`, which `staging-refresh.sh` pipes into the
 * restored copy, run here against the real migrations. A copy holding
 * installations leaves no production installation reachable, no project nor
 * group move the ticker would drive, no delivery to replay and no queued
 * job; a copy holding people and secrets leaves none of their names,
 * addresses, external ids or secrets in any table, except the accounts of
 * the keep list, untouched.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { defaultProjectGradingScale } from "@quiz/contracts";

import type { Db } from "./db/client.js";
import { classrooms, courses, githubOrganizations, projects, sessions, users, webhookDeliveries } from "./db/schema.js";
import { testDatabase } from "./test/db.js";

const SCRUB = readFileSync(new URL("../../../scripts/staging-scrub.sql", import.meta.url), "utf8");
const PSEUDONYMIZE = readFileSync(new URL("../../../scripts/staging-pseudonymize.sql", import.meta.url), "utf8");
const ARCHIVED = new Date("2026-09-01T08:00:00Z");

let db: Db;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await testDatabase());
});

describe("staging-scrub.sql", () => {
  it("forgets every installation, archives and stops every project, closes the deliveries, drops the jobs, empties the sessions; idempotent", async () => {
    const userId = randomUUID();
    await db.insert(users).values({ id: userId, oidcSub: "scrub", email: "t@heig-vd.ch", role: "teacher" });
    await db.insert(sessions).values({ sidHash: "a".repeat(64), userId, expiresAt: new Date(Date.now() + 3_600_000) });
    const courseId = randomUUID();
    await db.insert(courses).values({ id: courseId, name: "Programmation C", code: "PRG1" });
    const classroomId = randomUUID();
    await db.insert(classrooms).values({ id: classroomId, courseId, name: "A", period: "2026-A" });
    const installed = randomUUID();
    const suspended = randomUUID();
    await db.insert(githubOrganizations).values([
      { id: installed, login: "heig-prod", githubOrgId: 1, installationId: 11 },
      { id: suspended, login: "heig-suspended", githubOrgId: 2, installationId: 12, suspendedAt: ARCHIVED },
    ]);
    const project = (slug: string, archivedAt: Date | null) => ({
      id: randomUUID(),
      classroomId,
      orgId: installed,
      name: slug,
      slug,
      state: "published" as const,
      startAt: ARCHIVED,
      deadlineAt: new Date(Date.now() - 60_000),
      sourceRepoId: slug.length,
      sourceFullName: `heig-prod/${slug}`,
      branches: ["main"],
      protectedFiles: [],
      gradingScale: defaultProjectGradingScale(),
      createdBy: userId,
      archivedAt,
    });
    const live = { ...project("live", null), groupSyncDueAt: new Date() };
    const old = project("older", ARCHIVED);
    await db.insert(projects).values([live, old]);
    await db.insert(webhookDeliveries).values({ deliveryId: randomUUID(), event: "push", payload: {}, receivedAt: ARCHIVED });
    // pg-boss's schema, as a production dump carries it.
    await client.exec("CREATE SCHEMA pgboss; CREATE TABLE pgboss.job (id uuid, state text)");

    for (let run = 0; run < 2; run += 1) {
      await client.exec(SCRUB);
      const orgs = await db.select().from(githubOrganizations);
      expect(orgs.map((o) => [o.login, o.installationId, o.suspendedAt])).toEqual(
        expect.arrayContaining([
          ["heig-prod", null, null],
          ["heig-suspended", null, null],
        ]),
      );
      const [liveRow] = await db.select().from(projects).where(eq(projects.id, live.id));
      expect(liveRow).toMatchObject({ groupSyncDueAt: null });
      expect(liveRow!.archivedAt).not.toBeNull();
      expect(liveRow!.groupsStoppedAt).not.toBeNull();
      const [oldRow] = await db.select().from(projects).where(eq(projects.id, old.id));
      expect(oldRow!.archivedAt).toEqual(ARCHIVED);
      expect(await db.select().from(sessions)).toEqual([]);
      const [delivery] = await db.select().from(webhookDeliveries);
      expect(delivery!.processedAt).not.toBeNull();
      const boss = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss'");
      expect(boss.rows).toEqual([]);
    }
  });
});

/**
 * Every row of every table of every non-system schema, as one text: what a
 * person who can read the staging database could read. A bytea shows as
 * its hex, so a marker is looked for in both forms.
 */
async function everything(pg: PGlite): Promise<string> {
  const tables = await pg.query<{ schema: string; name: string }>(
    `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
     WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg\\_%'
     ORDER BY 1, 2`,
  );
  const parts: string[] = [];
  for (const { schema, name } of tables.rows) {
    const rows = await pg.query<{ dump: string | null }>(`SELECT json_agg(t ORDER BY t::text)::text AS dump FROM "${schema}"."${name}" t`);
    parts.push(`${schema}.${name}: ${rows.rows[0]?.dump ?? ""}`);
  }
  return parts.join("\n");
}

const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");

/** What a production dump may hold of people and secrets, as markers searched for afterwards. */
const MARKERS = [
  "alice.martin@heig-vd.ch",
  "a.martinez@hes-so.ch",
  "bob.durand@heig-vd.ch",
  "dora.grant@heig-vd.ch",
  "chloe.dubois@heig-vd.ch",
  "Martinez",
  "Durandal",
  "Duboisier",
  "Chloé",
  "sub-alice-REAL",
  "sub-bob-REAL",
  "761234567890@eduid.ch",
  "pictures.example",
  "AVATAR-PHOTO-MARKER",
  "aad-alice-REAL",
  "Alice Teamsname",
  "alice.teams@heig-vd.ch",
  "alicemartin-gh",
  "4242424242",
  "NOTE-MARKER",
  "Gaston Lagaffe",
  "203.0.113.77",
  "LLM-KEY-SECRET-MARKER",
  "MRK4",
  "c".repeat(64),
  "d".repeat(64),
  "GUEST-TOKEN-MARKER",
  "TEAMS-TOKEN-MARKER",
  "aad-bob-REAL",
  "Les Martinez",
  "Team Durandal",
  "Projet Duboisier",
  "WEBHOOK-ERROR-MARKER",
  "TASK-MESSAGE-MARKER",
];

describe("staging-pseudonymize.sql, then staging-scrub.sql", () => {
  it("leaves no name, address, external id nor secret of production, keeps the keep list's accounts, and is idempotent", async () => {
    const { client: pg } = await testDatabase();
    const [alice, bob, po] = [randomUUID(), randomUUID(), randomUUID()];
    const [course, classroom, classroom2, evaluation, org, project, repo] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [aliceRow, aliceRow2, chloeRow, poRow, device, groupSet] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const exec = (sql: string, params: unknown[] = []) => pg.query(sql, params);

    // People. Alice is a student with a second address, an avatar, IdP
    // claims, a Teams link and a GitHub account; Bob a teacher by grant;
    // Chloé an unclaimed roster row; Paula, the product owner, is kept.
    await exec(
      `INSERT INTO users (id, oidc_sub, email, email_verified, given_name, family_name, swiss_edu_id, picture_url, role, created_at) VALUES
       ($1, 'sub-alice-REAL', 'alice.martin@heig-vd.ch', true, 'Alice', 'Martinez', '761234567890@eduid.ch', 'https://pictures.example/alice.jpg', 'student', now() - interval '3 days'),
       ($2, 'sub-bob-REAL', 'bob.durand@heig-vd.ch', true, 'Bob', 'Durandal', NULL, NULL, 'teacher', now() - interval '2 days'),
       ($3, 'sub-po-REAL', 'Paula.Owner@heig-vd.ch', true, 'Paula', 'Proprietaria', '769999999999@eduid.ch', NULL, 'admin', now() - interval '1 day')`,
      [alice, bob, po],
    );
    await exec(
      `INSERT INTO user_emails (user_id, email, source, verified) VALUES
       ($1, 'alice.martin@heig-vd.ch', 'login', true), ($1, 'a.martinez@hes-so.ch', 'mail', true),
       ($2, 'bob.durand@heig-vd.ch', 'login', true), ($3, 'paula.owner@heig-vd.ch', 'login', true)`,
      [alice, bob, po],
    );
    await exec(
      `INSERT INTO teacher_grants (id, email, created_by, created_at) VALUES
       ($1, 'bob.durand@heig-vd.ch', $3, now() - interval '1 hour'), ($2, 'dora.grant@heig-vd.ch', $3, now()),
       ($4, 'p.owner@hes-so.ch', $3, now() - interval '2 hours')`,
      [randomUUID(), randomUUID(), po, randomUUID()],
    );
    // A secondary address of the kept account: its grant stays with it.
    await exec(`INSERT INTO user_emails (user_id, email, source, verified) VALUES ($1, 'p.owner@hes-so.ch', 'mail', true)`, [po]);
    await exec(`INSERT INTO avatars (user_id, data, content_type) VALUES ($1, convert_to('AVATAR-PHOTO-MARKER', 'UTF8'), 'image/png')`, [alice]);
    await exec(
      `INSERT INTO user_idp_claims (user_id, claims, affiliations) VALUES
       ($1, '{"given_name":"Alice","email":"alice.martin@heig-vd.ch","swissEduPersonUniqueID":"761234567890@eduid.ch"}', ARRAY['student@heig-vd.ch'])`,
      [alice],
    );
    await exec(
      `INSERT INTO teams_links (user_id, tenant_id, aad_object_id, teams_name, teams_username) VALUES
       ($1, 'tenant-REAL', 'aad-alice-REAL', 'Alice Teamsname', 'alice.teams@heig-vd.ch')`,
      [alice],
    );
    await exec(`INSERT INTO github_accounts (user_id, github_user_id, login) VALUES ($1, 4242424242, 'alicemartin-gh'), ($2, 5151515151, 'paula-gh')`, [
      alice,
      po,
    ]);

    // A class, its roster, a project repository named after its student,
    // a poll with a guest.
    await exec(`INSERT INTO courses (id, name, code) VALUES ($1, 'Programmation C', 'PRG1')`, [course]);
    await exec(`INSERT INTO classrooms (id, course_id, name, period) VALUES ($1, $2, 'A', '2026-A')`, [classroom, course]);
    await exec(
      `INSERT INTO enrollments (id, classroom_id, nom, prenom, email, user_id, note) VALUES
       ($1, $4, 'Martinez', 'Alice', 'alice.martin@heig-vd.ch', $5, 'NOTE-MARKER dyslexia'),
       ($2, $4, 'Duboisier', 'Chloé', 'chloe.dubois@heig-vd.ch', NULL, NULL),
       ($3, $4, 'Proprietaria', 'Paula', 'paula.owner@heig-vd.ch', $6, 'kept note')`,
      [aliceRow, chloeRow, poRow, classroom, alice, po],
    );
    // Another class, where Alice is on the roster under her second address
    // and has not claimed it yet.
    await exec(`INSERT INTO classrooms (id, course_id, name, period) VALUES ($1, $2, 'B', '2026-B')`, [classroom2, course]);
    await exec(`INSERT INTO enrollments (id, classroom_id, nom, prenom, email) VALUES ($1, $2, 'Martinez', 'Alice', 'a.martinez@hes-so.ch')`, [
      aliceRow2,
      classroom2,
    ]);
    // Groups named after their members.
    await exec(`INSERT INTO group_sets (id, classroom_id, name, created_by, created_at) VALUES ($1, $2, 'Les Martinez et cie', $3, now())`, [
      groupSet,
      classroom,
      bob,
    ]);
    await exec(
      `INSERT INTO student_groups (id, set_id, name, position, created_at) VALUES ($1, $3, 'Team Durandal', 0, now()), ($2, $3, 'Group 1', 1, now())`,
      [randomUUID(), randomUUID(), groupSet],
    );
    await exec(`INSERT INTO github_organizations (id, login, github_org_id, installation_id) VALUES ($1, 'heig-prod', 1, 11)`, [org]);
    await exec(
      `INSERT INTO projects (id, classroom_id, org_id, name, slug, state, start_at, deadline_at, source_repo_id, source_full_name, branches, protected_files, grading_scale, created_by)
       VALUES ($1, $2, $5, 'lab1', 'lab1', 'published', now(), now(), 1, 'heig-prod/lab1', ARRAY['main'], ARRAY[]::text[], $3, $4)`,
      [project, classroom, JSON.stringify(defaultProjectGradingScale()), bob, org],
    );
    await exec(
      `INSERT INTO project_repos (id, project_id, user_id, github_repo_id, full_name, accepted_at) VALUES ($1, $2, $3, 77, 'heig-prod/lab1-alicemartin-gh', now())`,
      [repo, project, alice],
    );
    await exec(
      `INSERT INTO project_repo_access (id, repo_id, enrollment_id, github_user_id, github_login, invited_at) VALUES ($1, $2, $3, 4242424242, 'alicemartin-gh', now())`,
      [randomUUID(), repo, aliceRow],
    );
    await exec(
      `INSERT INTO evaluations (id, classroom_id, title, mode, settings, grading_scale, feedback_policy, created_by) VALUES ($1, $2, 'Sondage', 'poll', '{}', '{}', '{}', $3)`,
      [evaluation, classroom, bob],
    );
    await exec(`INSERT INTO guest_participants (id, evaluation_id, pseudonym, token_hash) VALUES ($1, $2, 'Gaston Lagaffe', 'GUEST-TOKEN-MARKER')`, [
      randomUUID(),
      evaluation,
    ]);

    // Free text beside the content.
    await exec(
      `INSERT INTO audit_log (actor_user_id, actor_type, action, subject_type, subject_id, payload) VALUES
       ($1, 'user', 'admin.teacher_granted', 'teacher_grant', 'dora.grant@heig-vd.ch', '{"email":"dora.grant@heig-vd.ch","ip":"203.0.113.77"}')`,
      [po],
    );
    await exec(
      `INSERT INTO legacy_classroom_audit_log (source_id, actor_type, action, subject_type, subject_id, payload, created_at) VALUES
       (1, 'user', 'roster.imported', 'classroom', 'x', '{"nom":"Duboisier","email":"chloe.dubois@heig-vd.ch"}', now())`,
    );
    await exec(`INSERT INTO notifications (id, user_id, payload) VALUES ($1, $2, '{"kind":"pool_shared","poolName":"P","byName":"Bob Durandal"}')`, [
      randomUUID(),
      alice,
    ]);
    await exec(
      `INSERT INTO webhook_deliveries (delivery_id, event, payload, received_at, error) VALUES
       ($1, 'push', '{"sender":{"login":"alicemartin-gh","email":"alice.martin@heig-vd.ch"}}', now(), 'WEBHOOK-ERROR-MARKER alicemartin-gh')`,
      [randomUUID()],
    );
    await exec(`INSERT INTO scheduled_tasks (key, interval_minutes, last_message) VALUES ('marker', 60, 'TASK-MESSAGE-MARKER bob.durand@heig-vd.ch')`);
    await exec(`INSERT INTO project_groups (id, project_id, name, slug, position) VALUES ($1, $2, 'Projet Duboisier', 'projet-duboisier', 0)`, [
      randomUUID(),
      project,
    ]);

    // Secrets kept in rows (audit L17).
    // The migrations seed the one settings row.
    await exec(`UPDATE llm_settings SET key_ciphertext = convert_to('LLM-KEY-SECRET-MARKER', 'UTF8'), key_last4 = 'MRK4', daily_cap_usd = 5`);
    await exec(`INSERT INTO kiosk_devices (id, google_device_id, label, status, credential_hash) VALUES ($1, 'dev-1', 'Poste 1', 'active', $2)`, [
      device,
      "c".repeat(64),
    ]);
    await exec(
      `INSERT INTO kiosk_pairings (id, device_id, device_code_hash, user_code_hash, state, expires_at) VALUES ($1, $2, $3, $4, 'pending', now() + interval '5 minutes')`,
      [randomUUID(), device, "d".repeat(64), "e".repeat(64)],
    );
    await exec(
      `INSERT INTO teams_link_tokens (token_hash, tenant_id, aad_object_id, teams_name, teams_username, created_at, expires_at) VALUES
       ('TEAMS-TOKEN-MARKER', 'tenant-REAL', 'aad-bob-REAL', 'Bob Teamsname', 'bob.teams@heig-vd.ch', now(), now() + interval '1 hour')`,
    );

    const before = await everything(pg);
    for (const marker of MARKERS) expect(before.includes(marker) || before.includes(hex(marker)), marker).toBe(true);

    let first: string | undefined;
    for (let run = 0; run < 2; run += 1) {
      // As staging-refresh.sh sets it; case and spaces do not matter.
      await pg.query("SELECT set_config('quiz.staging_keep_emails', ' PAULA.owner@heig-vd.ch ,', false)");
      await pg.exec(PSEUDONYMIZE);
      await pg.exec(SCRUB);
      const after = await everything(pg);
      for (const marker of MARKERS) {
        expect(after.includes(marker), marker).toBe(false);
        expect(after.includes(hex(marker)), `${marker} (bytea)`).toBe(false);
      }

      // The kept account, its address, its GitHub account and its roster row, as they were.
      expect((await exec("SELECT oidc_sub, email, given_name, family_name, swiss_edu_id FROM users WHERE id = $1", [po])).rows).toEqual([
        { oidc_sub: "sub-po-REAL", email: "Paula.Owner@heig-vd.ch", given_name: "Paula", family_name: "Proprietaria", swiss_edu_id: "769999999999@eduid.ch" },
      ]);
      expect((await exec("SELECT login FROM github_accounts WHERE user_id = $1", [po])).rows).toEqual([{ login: "paula-gh" }]);
      expect((await exec("SELECT email, note FROM enrollments WHERE id = $1", [poRow])).rows).toEqual([
        { email: "paula.owner@heig-vd.ch", note: "kept note" },
      ]);

      // The others: deterministic fakes, consistent across tables. The
      // teacher's grant names the teacher's only address, the student's
      // roster row the student's.
      expect((await exec("SELECT id, oidc_sub, email, given_name, family_name FROM users WHERE id = ANY($1) ORDER BY role", [[alice, bob]])).rows).toEqual([
        { id: alice, oidc_sub: `staging:${alice}`, email: "student-1@example.invalid", given_name: "Student", family_name: "1" },
        { id: bob, oidc_sub: `staging:${bob}`, email: "teacher-1@example.invalid", given_name: "Teacher", family_name: "1" },
      ]);
      expect((await exec("SELECT email FROM user_emails WHERE user_id = $1", [bob])).rows).toEqual([{ email: "teacher-1@example.invalid" }]);
      // The kept account's grant, under its second address, stays.
      expect((await exec("SELECT email FROM teacher_grants ORDER BY email")).rows).toEqual([
        { email: "grant-3@example.invalid" },
        { email: "p.owner@hes-so.ch" },
        { email: "teacher-1@example.invalid" },
      ]);
      // Alice's unclaimed row of the other class, under her second address, is hers.
      const roster = (await exec("SELECT id, email, nom, prenom, note FROM enrollments WHERE id = ANY($1)", [[aliceRow, aliceRow2, chloeRow]])).rows;
      expect(roster).toHaveLength(3);
      expect(roster).toEqual(
        expect.arrayContaining([
          { id: chloeRow, email: expect.stringMatching(/^enrollment-\d@example\.invalid$/), nom: expect.stringMatching(/^\d$/), prenom: "Enrollment", note: null },
          { id: aliceRow, email: "student-1@example.invalid", nom: "1", prenom: "Student", note: null },
          { id: aliceRow2, email: "student-1@example.invalid", nom: "1", prenom: "Student", note: null },
        ]),
      );
      // Groups by number, a swap with an existing "Group 1" included.
      expect((await exec("SELECT name FROM student_groups ORDER BY position")).rows).toEqual([{ name: "Group 1" }, { name: "Group 2" }]);
      expect((await exec("SELECT name, slug FROM project_groups")).rows).toEqual([{ name: "Group 1", slug: "group-1" }]);
      expect((await exec("SELECT name FROM group_sets")).rows).toEqual([{ name: "Groups 1" }]);
      expect((await exec("SELECT github_user_id::text AS id, login FROM github_accounts WHERE user_id = $1", [alice])).rows).toEqual([
        { id: "-1", login: "github-user-1" },
      ]);
      expect((await exec("SELECT github_user_id::text AS id, github_login FROM project_repo_access")).rows).toEqual([
        { id: "-1", github_login: "github-user-1" },
      ]);
      expect((await exec("SELECT full_name FROM project_repos")).rows).toEqual([{ full_name: `heig-prod/repo-${repo.slice(0, 8)}` }]);
      // The affiliations stay: the role rule reads them.
      expect((await exec("SELECT claims, affiliations FROM user_idp_claims")).rows).toEqual([{ claims: {}, affiliations: ["student@heig-vd.ch"] }]);
      // The station stays, without its credential; the guest stays, with a
      // hash nobody holds; the LLM settings stay, without their key.
      expect((await exec("SELECT label, credential_hash FROM kiosk_devices")).rows).toEqual([{ label: "Poste 1", credential_hash: null }]);
      expect((await exec("SELECT pseudonym, token_hash FROM guest_participants")).rows).toEqual([
        { pseudonym: "Guest 1", token_hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ]);
      expect((await exec("SELECT key_ciphertext, key_last4, daily_cap_usd::text AS cap FROM llm_settings")).rows).toEqual([
        { key_ciphertext: null, key_last4: null, cap: "5.00" },
      ]);
      expect((await exec("SELECT count(*)::int AS n FROM kiosk_pairings")).rows).toEqual([{ n: 0 }]);
      // The audit log's trigger, lifted for the copy's rewrite, is back on.
      await expect(exec("UPDATE audit_log SET action = action")).rejects.toThrow(/append-only/);
      expect((await exec("SELECT count(*)::int AS n FROM teams_link_tokens")).rows).toEqual([{ n: 0 }]);

      // A second run changes nothing but the guest's unmatchable hash.
      const stable = after.replace(/"token_hash":"[0-9a-f]{64}"/g, "");
      if (first !== undefined) expect(stable).toBe(first);
      first = stable;
    }
  });
});
