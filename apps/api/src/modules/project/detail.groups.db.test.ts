/**
 * The project page of a group project (F-PROJ-13, ADR-070 §4; merge task
 * M3-16b), on the group repositories' world (`groupTesting.ts`): each row
 * carries the copy group its student is in, a student in no group of the
 * copy has a row of their own, R1's group kept with no member is a row of
 * its repository; `counts.groups` and `groupSyncPending` (R2).
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GroupConsequences, ProjectDetail } from "@quiz/contracts";

import { projectRepos } from "../../db/schema.js";
import { claimGroupSyncWork, runGroupSyncJob } from "./groupSync.js";
import { accept, config, freshOrgId, groupOf, groupProject, moveTo, newStudent, NOW, server, setOk, staff, useGroupWorld } from "./groupTesting.js";
import { projectTick } from "./jobs.js";

useGroupWorld();

const detail = async (projectId: string) => {
  const res = await staff("GET", `/app/api/projects/${projectId}`);
  expect(res.statusCode, res.body).toBe(200);
  return ProjectDetail.parse(res.json());
};

describe("the project page of a group project (M3-16b)", () => {
  it("names each row's copy group; a student in no group, and R1's group with no member, have rows of their own", async () => {
    const [ana, ben, cid, dan] = [await newStudent(), await newStudent(), await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!, cid!, dan!], [[0, 1], [2], [3]]);
    const line = (s: { id: string }) => room.lines.get(s.id)!;
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    expect((await accept(project.id, cid!)).statusCode).toBe(200);
    const [a, b] = [`${room.login}/lab-1-group-1`, `${room.login}/lab-1-group-2`];
    // Dan out of Group 3, which has no repository: applied at once.
    let current = await setOk(await moveTo(set, line(dan!), null));

    const before = await detail(project.id);
    const names = new Map([ana, ben, cid, dan].map((s) => [line(s!), s!]));
    const byLine = (d: ProjectDetail) =>
      Object.fromEntries(d.rows.filter((r) => r.student.enrollmentId).map((r) => [names.get(r.student.enrollmentId!)!.login, [r.group?.name ?? null, r.repo?.fullName ?? null]]));
    expect(byLine(before)).toEqual({
      [ana!.login]: ["Group 1", a],
      [ben!.login]: ["Group 1", a],
      [cid!.login]: ["Group 2", b],
      [dan!.login]: [null, null],
    });
    expect(before.rows.every((r) => r.group === null || r.group.stopped === false)).toBe(true);
    expect([before.counts.groups, before.groupSyncPending, before.groupsDrifted]).toEqual([3, false, false]);

    // After the deadline the copy stops; the set moves Ben to Group 2 and deletes Group 1.
    server.clock.set("2026-10-13T00:00:00.000Z");
    await projectTick(server.app, config);
    current = await setOk(await moveTo(current, line(ben!), groupOf(current, "Group 2").id));
    await setOk(await staff("DELETE", `/app/api/group-sets/${set.set.id}/groups/${groupOf(current, "Group 1").id}`));
    const stopped = await detail(project.id);
    expect(stopped.groupsDrifted).toBe(true);
    expect(stopped.rows.find((r) => r.student.enrollmentId === line(ana!))!.group).toMatchObject({ name: "Group 1", stopped: true });

    // The resync confirmed: owed until the job has applied it (R2).
    const asked = await staff("POST", `/app/api/projects/${project.id}/groups/resync`, {});
    const { digest } = GroupConsequences.parse(asked.json());
    expect((await staff("POST", `/app/api/projects/${project.id}/groups/resync`, { confirm: digest })).statusCode).toBe(204);
    expect((await detail(project.id)).groupSyncPending).toBe(true);
    for (const job of await claimGroupSyncWork(server.app.db, server.app.clock.now(), project.id)) {
      await runGroupSyncJob(server.app, config, job);
    }

    const after = await detail(project.id);
    expect(after.groupSyncPending).toBe(false);
    // R1: Group 1 kept, its repository with no member — a row of its own, by its creator's account, with its group.
    const orphan = after.rows.find((r) => r.repo?.fullName === a)!;
    expect([orphan.student.enrollmentId, orphan.group?.name, orphan.group?.stopped]).toEqual([null, "Group 1", true]);
    expect(byLine(after)).toEqual({
      [ana!.login]: [null, null],
      [ben!.login]: ["Group 2", b],
      [cid!.login]: ["Group 2", b],
      [dan!.login]: [null, null],
    });
    expect(after.counts.groups).toBe(3);
  });

  it("gives a lot-1 individual repository's row no group, and keeps a departing member in their group's row (seat())", async () => {
    const [ana, ben, cid] = [await newStudent(), await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!, cid!], [[0, 1], [2]]);
    const line = (s: { id: string }) => room.lines.get(s.id)!;
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const a = `${room.login}/lab-1-group-1`;
    // heig-classroom's lot 1: a live individual repository of Cid's inside the group project — theirs.
    const own = `${room.login}/lab-1-${cid!.login}`;
    await server.app.db.insert(projectRepos).values({
      id: randomUUID(),
      projectId: project.id,
      userId: cid!.id,
      fullName: own,
      githubRepoId: freshOrgId(),
      provisionStatus: "ok",
      invitationStatus: "accepted",
      acceptedAt: new Date(NOW),
    });
    // Ben moved out of Group 1, confirmed, the job not run: still in Group 1, departing.
    const asked = await moveTo(set, line(ben!), groupOf(set, "Group 2").id);
    const { digest } = GroupConsequences.parse(asked.json());
    await setOk(await staff("PUT", `/app/api/group-sets/${set.set.id}/members/${line(ben!)}`, { groupId: groupOf(set, "Group 2").id, confirm: digest }));

    const rows = (await detail(project.id)).rows;
    const rowOf = (s: { id: string }) => rows.find((r) => r.student.enrollmentId === line(s))!;
    expect([rowOf(cid!).group, rowOf(cid!).repo?.fullName]).toEqual([null, own]);
    expect([rowOf(ben!).group?.name, rowOf(ben!).repo?.fullName, rowOf(ben!).repo?.accessToRevoke]).toEqual(["Group 1", a, true]);
  });
});
