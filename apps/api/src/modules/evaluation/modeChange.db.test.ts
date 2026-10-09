/**
 * Changing the mode of an evaluation or a template (ADR-092), over HTTP
 * against the real migrations: the cutoff (`409 mode_frozen`), the forced
 * consequences only (no preset reapplied, nothing opened), the once-only
 * announcement of a scheduled exam turned exercise, the template's revision
 * and the audit trail.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EvaluationDetail, EvaluationTemplate, TemplateDetail } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { attempts, auditLog, evaluations, notifications } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import * as service from "./service.js";

let server: TestServer;
let restore: () => void;
type Caller = { id: string; headers: Record<string, string> };

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
});
afterAll(async () => {
  await server.close();
  restore();
});

const patch = (who: Caller, url: string, payload: unknown) =>
  server.app.inject({ method: "PATCH", url, headers: who.headers, payload: payload as object });

/** A world whose evaluation (an exam unless said) is a draft, its teacher signed in. */
async function world(mode: "exam" | "exercise" = "exam") {
  const teacher = await server.signIn("teacher");
  const seed = await seedLive(server.app.db, { teacherId: teacher.id, mode });
  return { teacher, seed, url: `/app/api/evaluations/${seed.evaluationId}` };
}

async function changeMode(who: Caller, url: string, mode: string) {
  const res = await patch(who, url, { mode });
  return { res, status: res.statusCode, body: res.json() };
}

/** Moves the evaluation to `scheduled` (opening an hour from the server's now). */
async function schedule(seed: Seeded) {
  const now = server.clock.now();
  await server.app.db
    .update(evaluations)
    .set({ opensAt: new Date(now.getTime() + 3_600_000), closesAt: new Date(now.getTime() + 7_200_000) })
    .where(eq(evaluations.id, seed.evaluationId));
  await service.transition(server.app.db, await reload(server.app.db, seed.evaluationId), "scheduled", now);
}

const scheduledNotices = async (userId: string) =>
  server.app.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), sql`${notifications.payload}->>'kind' = 'activity_scheduled'`));

describe("changing the mode of a draft (ADR-092)", () => {
  it("reapplies no preset: the settings and the answer key policy stay as stored", async () => {
    const { teacher, seed, url } = await world();
    const before = await reload(server.app.db, seed.evaluationId);
    await changeMode(teacher, url, "exercise");
    const after = await reload(server.app.db, seed.evaluationId);
    expect(after.mode).toBe("exercise");
    expect(service.settingsOf(after)).toMatchObject({
      ...service.settingsOf(before),
      allowDrill: false,
    });
    expect(service.feedbackOf(after)).toEqual(service.feedbackOf(before));
    expect(after.durationS).toBe(before.durationS);
  });

  it("freezes the drill at the old mode's value, then keeps it", async () => {
    const { teacher, seed, url } = await world("exercise");
    const detail = EvaluationDetail.parse((await changeMode(teacher, url, "exam")).body);
    expect(detail.evaluation.allowDrill).toBe(true);
    expect(service.settingsOf(await reload(server.app.db, seed.evaluationId)).allowDrill).toBe(true);
  });

  it("falls back from immediate feedback going to an exam, and never opens the key going to an exercise", async () => {
    const { teacher, seed, url } = await world("exercise");
    await server.app.db
      .update(evaluations)
      .set({ feedbackPolicy: { when: "immediate", showAnswer: true, showKey: false, showExplanation: false } })
      .where(eq(evaluations.id, seed.evaluationId));
    await changeMode(teacher, url, "exam");
    expect(service.feedbackOf(await reload(server.app.db, seed.evaluationId))).toMatchObject({
      when: "on_release",
      showKey: false,
      showExplanation: false,
    });
  });

  it("applies the fallback even when the same patch touches another feedback field", async () => {
    const { teacher, seed, url } = await world("exercise");
    await server.app.db
      .update(evaluations)
      .set({ feedbackPolicy: { when: "immediate", showAnswer: true, showKey: true, showExplanation: false } })
      .where(eq(evaluations.id, seed.evaluationId));
    const res = await patch(teacher, url, { mode: "exam", feedbackPolicy: { showKey: false } });
    expect(res.statusCode).toBe(200);
    expect(service.feedbackOf(await reload(server.app.db, seed.evaluationId))).toMatchObject({
      when: "on_release",
      showKey: false,
    });
    // A `when` the patch chooses itself is judged against the new mode, not replaced.
    const chosen = await patch(teacher, url, { mode: "exercise", feedbackPolicy: { when: "immediate" } });
    expect(chosen.statusCode).toBe(200);
    const bad = await patch(teacher, url, { mode: "exam", feedbackPolicy: { when: "immediate" } });
    expect([bad.statusCode, bad.json().error]).toEqual([422, "feedback_not_allowed"]);
  });

  it("refuses a stored kiosk becoming an exam where the platform has no kiosk", async () => {
    const { teacher, seed, url } = await world("exercise");
    await server.app.db
      .update(evaluations)
      .set({ settings: { ...service.settingsOf(await reload(server.app.db, seed.evaluationId)), kiosk: true } })
      .where(eq(evaluations.id, seed.evaluationId));
    const refused = await changeMode(teacher, url, "exam");
    expect([refused.status, refused.body.error]).toEqual([422, "kiosk_unavailable"]);
    expect((await reload(server.app.db, seed.evaluationId)).mode).toBe("exercise");
  });

  it("decides the cutoff on the locked re-read, not on the row loaded earlier", async () => {
    const { seed } = await world();
    const loaded = await reload(server.app.db, seed.evaluationId);
    // Between the load and the write, a student enters and the evaluation opens.
    await server.app.db
      .insert(attempts)
      .values({ id: randomUUID(), evaluationId: seed.evaluationId, userId: seed.studentIds[0]!, seed: 1 });
    await server.app.db.update(evaluations).set({ state: "lobby" }).where(eq(evaluations.id, seed.evaluationId));
    await expect(
      server.app.db.transaction((tx) =>
        service.patchEvaluation(tx, loaded, { mode: "exercise" }, { attemptCount: 0, now: server.clock.now() }),
      ),
    ).rejects.toMatchObject({ code: "mode_frozen" });
    expect((await reload(server.app.db, seed.evaluationId)).mode).toBe("exam");
  });

  it("refuses an exam while retakes are on (422 retakes_not_allowed), the mode unchanged", async () => {
    const { teacher, seed, url } = await world("exercise");
    const retakes = await patch(teacher, url, { settings: { retakes: { enabled: true, keep: "best", maxAttempts: 2 } } });
    expect(retakes.statusCode).toBe(200);
    const refused = await changeMode(teacher, url, "exam");
    expect([refused.status, refused.body.error]).toEqual([422, "retakes_not_allowed"]);
    expect((await reload(server.app.db, seed.evaluationId)).mode).toBe("exercise");
  });

  it("keeps SEB and kiosk stored when an exam becomes an exercise", async () => {
    const { teacher, seed, url } = await world();
    await patch(teacher, url, { settings: { safeExamBrowser: true } });
    await changeMode(teacher, url, "exercise");
    expect(service.settingsOf(await reload(server.app.db, seed.evaluationId)).safeExamBrowser).toBe(true);
  });

  it("never reaches a poll, nor a mode of `poll`", async () => {
    const { teacher, url } = await world();
    expect((await changeMode(teacher, url, "poll")).status).toBe(400);
    const row = await server.app.db.select().from(evaluations).where(eq(evaluations.id, url.split("/").pop()!));
    await server.app.db.update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, row[0]!.id));
    const refused = await changeMode(teacher, url, "exam");
    expect([refused.status, refused.body.error]).toEqual([409, "mode_frozen"]);
  });

  it("writes the change to the audit log with its mode from and to", async () => {
    const { teacher, seed, url } = await world();
    await changeMode(teacher, url, "exercise");
    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, seed.evaluationId), eq(auditLog.action, "evaluation.update")));
    expect(entry?.payload).toEqual({ fields: ["mode"], mode: { from: "exam", to: "exercise" } });
  });
});

describe("the cutoff", () => {
  it("is 409 mode_frozen once an attempt exists, even in a draft", async () => {
    const { teacher, seed, url } = await world();
    await server.app.db
      .insert(attempts)
      .values({ id: randomUUID(), evaluationId: seed.evaluationId, userId: seed.teacherId, seed: 1 });
    const refused = await changeMode(teacher, url, "exercise");
    expect([refused.status, refused.body.error]).toEqual([409, "mode_frozen"]);
  });

  it("is 409 mode_frozen in the lobby, running and closed", async () => {
    for (const state of ["lobby", "running", "closed"] as const) {
      const { teacher, seed, url } = await world();
      await server.app.db.update(evaluations).set({ state }).where(eq(evaluations.id, seed.evaluationId));
      const refused = await changeMode(teacher, url, "exercise");
      expect([state, refused.status, refused.body.error]).toEqual([state, 409, "mode_frozen"]);
      expect((await reload(server.app.db, seed.evaluationId)).mode).toBe("exam");
    }
  });

  it("treats the mode the evaluation already has as no change", async () => {
    const { teacher, seed, url } = await world();
    await server.app.db.update(evaluations).set({ state: "running" }).where(eq(evaluations.id, seed.evaluationId));
    const res = await patch(teacher, url, { mode: "exam", title: "Renamed" });
    expect(res.statusCode).toBe(200);
  });
});

describe("a scheduled evaluation", () => {
  it("tells the class once when an exam becomes an exercise, and nothing the other way", async () => {
    const { teacher, seed, url } = await world();
    await schedule(seed);
    const [ann] = seed.studentIds as [string, ...string[]];

    // A scheduled exam says nothing, and turning it exercise says it.
    expect(await scheduledNotices(ann)).toEqual([]);
    const done = await changeMode(teacher, url, "exercise");
    expect(done.status).toBe(200);
    expect(await scheduledNotices(ann)).toHaveLength(1);
    const row = await reload(server.app.db, seed.evaluationId);
    expect(row.state).toBe("scheduled");
    expect(row.opensAt).not.toBeNull();

    // Back and forth: the marker already claimed, nobody is told twice.
    await changeMode(teacher, url, "exam");
    await changeMode(teacher, url, "exercise");
    expect(await scheduledNotices(ann)).toHaveLength(1);
  });

  it("sends nothing for an exercise that becomes an exam", async () => {
    const { teacher, seed, url } = await world("exercise");
    await schedule(seed);
    // The move to scheduled announced it; forget that to see the change alone.
    await server.app.db.delete(notifications);
    await changeMode(teacher, url, "exam");
    expect(await scheduledNotices(seed.studentIds[0]!)).toEqual([]);
  });

  it("refuses an exam that could not end by itself, and leaves the mode", async () => {
    const { teacher, seed, url } = await world("exercise");
    await server.app.db
      .update(evaluations)
      .set({ settings: { ...service.settingsOf(await reload(server.app.db, seed.evaluationId)), timing: "manual" } })
      .where(eq(evaluations.id, seed.evaluationId));
    await schedule(seed);
    await server.app.db.update(evaluations).set({ closesAt: null }).where(eq(evaluations.id, seed.evaluationId));
    const refused = await changeMode(teacher, url, "exam");
    expect(refused.status).toBe(409);
    expect((await reload(server.app.db, seed.evaluationId)).mode).toBe("exercise");
  });
});

describe("a template", () => {
  async function savedTemplate(teacher: Caller, seed: Seeded) {
    const res = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${seed.evaluationId}/template`,
      headers: teacher.headers,
      payload: { title: "Exam template" },
    });
    expect(res.statusCode).toBe(201);
    return EvaluationTemplate.parse(res.json());
  }

  it("changes mode, moves the revision once, audits it, and leaves its instances alone", async () => {
    const { teacher, seed } = await world();
    const template = await savedTemplate(teacher, seed);
    const instance = await server.app.inject({
      method: "POST",
      url: `/app/api/templates/${template.id}/instances`,
      headers: teacher.headers,
      payload: { classroomId: seed.classroomId, title: "From template" },
    });
    expect(instance.statusCode).toBe(201);
    const instanceId = (instance.json() as { evaluation: { id: string } }).evaluation.id;

    const res = await patch(teacher, `/app/api/templates/${template.id}`, { mode: "exercise" });
    expect(res.statusCode).toBe(200);
    const detail = TemplateDetail.parse(res.json());
    expect(detail.template.mode).toBe("exercise");
    expect(detail.template.revision).toBe(template.revision + 1);

    expect((await reload(server.app.db, instanceId)).mode).toBe("exam");
    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, template.id), eq(auditLog.action, "template.update")));
    expect(entry?.payload).toMatchObject({ fields: ["mode"], mode: { from: "exam", to: "exercise" }, revised: true });

    // A pull keeps the instance's own mode (F-EVAL-26).
    const pulled = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${instanceId}/pull-template`,
      headers: teacher.headers,
      payload: { revision: template.revision + 1 },
    });
    expect(pulled.statusCode).toBe(200);
    expect((await reload(server.app.db, instanceId)).mode).toBe("exam");
  });
});
