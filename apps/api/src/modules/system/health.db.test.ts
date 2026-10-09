/**
 * The health checks (N-OPS-03, ADR-055) against the real migrations: the
 * outcome checks that catch a dead ticker whatever the process layout, and
 * the registry's behaviour where there is nothing to measure.
 *
 * The overdue checks must agree with the ticker about what is due: an
 * attempt counts only once ITS deadline (accommodation included) plus the
 * grace plus a minute has passed without the ticker closing it.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SystemCheck, type SystemCheckKey } from "@quiz/contracts";
import { GRACE_MS, HEALTH_THRESHOLDS } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import type { AppConfig } from "../../config.js";
import { InProcessQueue } from "../../jobs.js";
import { loadConfig } from "../../config.js";
import { testApp } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { startTicker } from "../../ticker.js";
import { lastTickOf } from "../../tickerPass.js";
import { applyState } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { HEALTH_CHECKS, runChecks } from "./health.js";

const MARGIN = HEALTH_THRESHOLDS.overdueMarginMs;
let restore: () => void;
let app: Awaited<ReturnType<typeof testApp>>;
let config: AppConfig;
let dir: string;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  dir = await mkdtemp(join(tmpdir(), "quiz-health-"));
  config = loadConfig({ NODE_ENV: "test", ASSETS_DIR: join(dir, "assets") });
});
afterAll(async () => {
  restore();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  // A fresh database per test: the overdue counts are global.
  app = await testApp();
  app.clock.set(new Date("2026-09-20T08:00:00.000Z"));
});

async function check(key: SystemCheckKey, cfg: AppConfig = config): Promise<SystemCheck> {
  const [result] = await runChecks(app, cfg, HEALTH_CHECKS.filter((c) => c.key === key));
  return SystemCheck.parse(result);
}

/** A running evaluation, every student's attempt begun now. */
async function sitting(options: Parameters<typeof seedLive>[1]) {
  const seed = await seedLive(app.db, options);
  const row = await applyState(app.db, await reload(app.db, seed.evaluationId), "running", app.clock.now());
  const begun = [];
  for (const userId of seed.studentIds) {
    const participant = (await live.participantOf(app.db, row, userId))!;
    const created = await live.ensureAttempt(app.db, row, participant, app.clock.now());
    begun.push(await live.beginAttempt(app.db, row, created, participant, app.clock.now()));
  }
  return { evaluation: row, attempts: begun };
}

describe("attempts.overdue", () => {
  it("flags an attempt left open a minute past its own deadline, not one with extra time", async () => {
    // The first student has a 50 % accommodation: 45 minutes, not 30.
    const { attempts } = await sitting({ students: 2, durationS: 1800, timeBonusPercent: 50 });
    const [extra, plain] = attempts.map((a) => a.deadlineAt!.getTime());
    expect(extra! - plain!).toBe(15 * 60_000);

    // Inside the margin: a slow tick, not a dead one.
    app.clock.set(new Date(plain! + GRACE_MS + MARGIN - 1));
    expect(await check("attempts.overdue")).toMatchObject({ status: "ok", value: { n: 0 } });

    app.clock.advance(1);
    expect(await check("attempts.overdue")).toMatchObject({
      status: "fail",
      value: { kind: "count", n: 1 },
      cause: "attempts.overdue",
    });

    // The ticker catches up: a closed attempt is never flagged.
    await live.expireDueAttempts(app.db, app.clock.now());
    expect(await check("attempts.overdue")).toMatchObject({ status: "ok", value: { n: 0 } });
  });

  it("leaves a paused evaluation alone: its countdown is frozen", async () => {
    const { evaluation, attempts } = await sitting({ students: 1, durationS: 600 });
    await live.pauseEvaluation(app.db, evaluation, app.clock.now());
    app.clock.set(new Date(attempts[0]!.deadlineAt!.getTime() + GRACE_MS + 10 * MARGIN));
    expect(await check("attempts.overdue")).toMatchObject({ status: "ok" });
  });
});

describe("evaluations.overdue", () => {
  it("flags a deadline-timed evaluation still running past its close, until the ticker closes it", async () => {
    const opensAt = app.clock.now();
    const closesAt = new Date(opensAt.getTime() + 3_600_000);
    const { evaluation } = await sitting({
      students: 1,
      settings: { timing: "deadline" },
      durationS: null,
      opensAt,
      closesAt,
    });

    app.clock.set(new Date(closesAt.getTime() + GRACE_MS + MARGIN + 1));
    expect(await check("evaluations.overdue")).toMatchObject({ status: "fail", value: { n: 1 } });
    expect(await check("attempts.overdue")).toMatchObject({ status: "fail", value: { n: 1 } });

    await live.expireDueAttempts(app.db, app.clock.now());
    await live.autoCloseDue(app.db, app.clock.now());
    expect((await reload(app.db, evaluation.id)).state).toBe("closed");
    expect(await check("evaluations.overdue")).toMatchObject({ status: "ok", value: { n: 0 } });
  });

  it("waits for the last extended attempt, as the ticker does", async () => {
    const opensAt = app.clock.now();
    const closesAt = new Date(opensAt.getTime() + 3_600_000);
    const { evaluation, attempts } = await sitting({
      students: 1,
      settings: { timing: "deadline" },
      durationS: null,
      opensAt,
      closesAt,
    });
    // +10 minutes for the one student: the evaluation is not late at closes_at.
    await live.extendTime(app.db, evaluation, { minutes: 10, attemptId: attempts[0]!.id }, app.clock.now());
    app.clock.set(new Date(closesAt.getTime() + GRACE_MS + MARGIN + 1));
    expect(await check("evaluations.overdue")).toMatchObject({ status: "ok" });
    expect(await check("attempts.overdue")).toMatchObject({ status: "ok" });
  });
});

describe("the registry where there is nothing to measure", () => {
  it("reports no ticker in this process as unknown, never as a failure", async () => {
    expect(await check("ticker")).toMatchObject({ status: "unknown", cause: "ticker.not_in_process" });
  });

  it("reads the ticker's last pass once it runs", async () => {
    const stub = { ...app, addHook: () => {} } as unknown as typeof app;
    const stop = startTicker(stub, config, []);
    expect(lastTickOf(stub)).toBeTypeOf("number");
    const [ticker] = await runChecks(stub, config, HEALTH_CHECKS.filter((c) => c.key === "ticker"));
    expect(ticker).toMatchObject({ status: "ok", value: { kind: "duration" } });
    stop();
  });

  it("says the job statistics are unknown on the in-process queue (PGlite)", async () => {
    (app as { boss: unknown }).boss = new InProcessQueue(true, app.log);
    expect(await check("jobs")).toMatchObject({ status: "unknown", cause: "jobs.in_process" });
    (app as { boss: unknown }).boss = null;
    expect(await check("jobs")).toMatchObject({ status: "warn", cause: "jobs.down" });
  });

  it("says the backup and its off-site copy are not configured without a report file", async () => {
    expect(await check("backup")).toMatchObject({ status: "unknown", cause: "backup.not_configured" });
    expect(await check("offsite")).toMatchObject({ status: "unknown", cause: "offsite.not_configured" });
  });

  it("reads the backup report: fresh, stale, failed, missing", async () => {
    const file = join(dir, "backup-status.json");
    const cfg = { ...config, BACKUP_STATUS_FILE: file };
    const report = (hoursAgo: number, ok = true) =>
      writeFile(
        file,
        JSON.stringify({
          finished_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
          ok,
          exit_code: ok ? 0 : 1,
          file: "quiz-2026-09-20.dump",
          size_bytes: 1234,
        }),
      );
    expect(await check("backup", cfg)).toMatchObject({ status: "warn", cause: "backup.missing" });
    await report(2);
    expect(await check("backup", cfg)).toMatchObject({
      status: "ok",
      cause: null,
      details: [
        {
          subject: { kind: "name", name: "quiz-2026-09-20.dump" },
          values: [{ meaning: null, value: { kind: "bytes", n: 1234 } }],
        },
      ],
    });
    await report(30);
    expect(await check("backup", cfg)).toMatchObject({ status: "warn", cause: "backup.stale" });
    await report(1, false);
    expect(await check("backup", cfg)).toMatchObject({ status: "fail", cause: "backup.failed" });
    // A half-written report is no report: /healthz raises its attention.
    await writeFile(file, '{"finished_at":');
    expect(await check("backup", cfg)).toMatchObject({ status: "warn", cause: "backup.missing" });
  });

  it("reads the off-site report beside the dump's: fresh, stale, failed, missing", async () => {
    const status = join(dir, "status");
    await mkdir(status, { recursive: true });
    const cfg = { ...config, BACKUP_STATUS_FILE: join(status, "last.json") };
    const report = (hoursAgo: number, ok = true, exitCode = ok ? 0 : 2) =>
      writeFile(
        join(status, "offsite.json"),
        JSON.stringify({
          finished_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
          ok,
          exit_code: exitCode,
          file: "portal-2026-09-20T05:34",
        }),
      );
    expect(await check("offsite", cfg)).toMatchObject({ status: "warn", cause: "offsite.missing" });
    // borg's warning (rc 1, a file vanished mid-read) is a copy all the same.
    await report(2, true, 1);
    expect(await check("offsite", cfg)).toMatchObject({
      status: "ok",
      cause: null,
      details: [{ subject: { kind: "name", name: "portal-2026-09-20T05:34" }, values: [] }],
    });
    await report(30);
    expect(await check("offsite", cfg)).toMatchObject({ status: "warn", cause: "offsite.stale" });
    await report(60);
    expect(await check("offsite", cfg)).toMatchObject({ status: "fail", cause: "offsite.stale" });
    await report(1, false);
    expect(await check("offsite", cfg)).toMatchObject({ status: "fail", cause: "offsite.failed" });
    // The dump's own report is another file: still missing.
    expect(await check("backup", cfg)).toMatchObject({ status: "warn", cause: "backup.missing" });
  });

  it("measures the disk under a store that does not exist yet", async () => {
    const disk = await check("disk");
    expect(["ok", "warn", "fail"]).toContain(disk.status);
    expect(disk.value).toMatchObject({ kind: "share", bytes: true });
  });

  it("runs the whole registry on PGlite within the contract", async () => {
    const all = await runChecks(app, config);
    expect(all.map((c) => c.key)).toEqual(HEALTH_CHECKS.map((c) => c.key));
    for (const c of all) SystemCheck.parse(c);
    const byKey = new Map(all.map((c) => [c.key, c]));
    expect(byKey.get("database")).toMatchObject({ status: "ok", value: { kind: "duration" } });
    expect(byKey.get("database.size")?.value).toMatchObject({ kind: "bytes" });
    expect(byKey.get("runner")).toMatchObject({ status: "ok", cause: "runner.disabled" });
  });
});
