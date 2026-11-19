/**
 * Who authored a group repository's commits (ADR-136), on a server built
 * with Quiz's App against the fake GitHub (`./testing.ts`): the staff's
 * page gives each member the commits attributed to their linked account and
 * the repository the unattributed rest, by the week of the receipt, under
 * the student's count's own rule (by the deadline, no bot); no student
 * response carries a figure of it, nor a teammate's account. The intake's
 * resolution of the authors is `webhooks.db.test.ts`'s.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ProjectDetail, StudentProject } from "@quiz/contracts";

import { pushReceipts } from "../../db/schema.js";
import { accept, call, groupProject, newStudent, repoRows, server, staff, useGroupWorld, type Student } from "./groupTesting.js";

useGroupWorld();

/** A STAFF member's GitHub account: never a member's. */
const STAFF_ACCOUNT = 4_000_001;

describe("the commits each member of a group authored (ADR-136)", () => {
  it("gives the staff each member's count and weeks, the rest unattributed, and no student any of it", async () => {
    const [ana, ben, cid, dan] = [await newStudent(), await newStudent(), await newStudent(), await newStudent({ linked: false })];
    const { project, room } = await groupProject([ana!, ben!, cid!, dan!], [[0, 1, 2, 3]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const [row] = await repoRows(project.id);
    const receipt = (receivedAt: string, commits: number | null, authors: { id: number; n: number }[] | null, isBot = false) => ({
      id: randomUUID(),
      githubRepoId: row!.githubRepoId!,
      branch: "main",
      headSha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
      receivedAt: new Date(receivedAt),
      isBot,
      commits,
      authors,
    });
    await server.app.db.insert(pushReceipts).values([
      // Before the authors were recorded (week 40): unattributed, as a project already running shows them.
      receipt("2026-10-04T10:00:00Z", 2, null),
      // Week 41: Ana 2, Ben 3, a staff member 1 — counted, never a member's.
      receipt("2026-10-06T10:00:00Z", 6, [
        { id: ana!.githubUserId, n: 2 },
        { id: ben!.githubUserId, n: 3 },
        { id: STAFF_ACCOUNT, n: 1 },
      ]),
      // A bot's push and a push after the deadline (2026-10-12T22:00Z): counted by nobody.
      receipt("2026-10-07T10:00:00Z", 4, [{ id: ben!.githubUserId, n: 4 }], true),
      receipt("2026-10-13T10:00:00Z", 5, [{ id: ana!.githubUserId, n: 5 }]),
    ]);

    const detail = ProjectDetail.parse((await staff("GET", `/app/api/projects/${project.id}`)).json());
    const rowOf = (who: Student) => detail.rows.find((r) => r.student.enrollmentId === room.lines.get(who.id))!;
    const repo = rowOf(ana!).repo!;
    expect(repo.commits).toBe(8);
    expect(repo.unattributed).toEqual({ n: 3, weeks: [{ week: "2026-W40", n: 2 }, { week: "2026-W41", n: 1 }] });
    expect(rowOf(ana!).authored).toEqual({ n: 2, weeks: [{ week: "2026-W41", n: 2 }] });
    expect(rowOf(ben!).authored).toEqual({ n: 3, weeks: [{ week: "2026-W41", n: 3 }] });
    expect(rowOf(cid!).authored).toEqual({ n: 0, weeks: [] });
    expect(rowOf(dan!).authored).toEqual({ n: 0, weeks: [] });

    // Every student response of each member: the group's total, never a member's figure nor a teammate's account.
    const members = [ana!, ben!, cid!, dan!];
    for (const who of members) {
      const view = await call("GET", `/app/api/student/projects/${project.id}`, who.headers);
      expect(view.statusCode, view.body).toBe(200);
      // The search is not vacuous: the group's count is there.
      expect(StudentProject.parse(view.json()).repo!.commits).toBe(8);
      const bodies = [view.body];
      for (const url of ["/app/api/student/home", `/app/api/student/classrooms/${room.id}`, `/app/api/student/classrooms/${room.id}/gradebook`, "/app/api/student/results"]) {
        const res = await call("GET", url, who.headers);
        expect(res.statusCode, `${url} ${res.body}`).toBe(200);
        bodies.push(res.body);
      }
      for (const body of bodies) {
        expect(body).not.toMatch(/authored|unattributed|"weeks"|2026-W4/);
        expect(body).not.toContain(String(STAFF_ACCOUNT));
        for (const other of members.filter((m) => m !== who)) {
          expect(body).not.toContain(other.login);
          expect(body).not.toContain(String(other.githubUserId));
        }
      }
    }
  });
});
