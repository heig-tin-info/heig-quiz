import { describe, expect, it } from "vitest";

import {
  backupStatus,
  connectionsStatus,
  dbLatencyStatus,
  diskStatus,
  HEALTH_THRESHOLDS,
  jobsStatus,
  overdueStatus,
  taskAttention,
  tickerStatus,
  worstStatus,
} from "./health.js";

const H = 3_600_000;
const now = new Date("2026-10-01T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("worstStatus", () => {
  it("fail beats warn beats ok, and unknown only stands alone", () => {
    expect(worstStatus(["ok", "warn", "fail", "unknown"])).toBe("fail");
    expect(worstStatus(["ok", "unknown", "warn"])).toBe("warn");
    expect(worstStatus(["unknown", "ok"])).toBe("ok");
    expect(worstStatus(["unknown"])).toBe("unknown");
    expect(worstStatus([])).toBe("unknown");
  });
});

describe("tickerStatus", () => {
  it("fails past 10 s, or three periods when the period is longer", () => {
    expect(tickerStatus(1_200, 1_000)).toBe("ok");
    expect(tickerStatus(10_000, 1_000)).toBe("ok");
    expect(tickerStatus(10_001, 1_000)).toBe("fail");
    expect(tickerStatus(20_000, 10_000)).toBe("ok");
    expect(tickerStatus(30_001, 10_000)).toBe("fail");
  });
});

describe("overdueStatus", () => {
  it("fails on a single overdue row", () => {
    expect(overdueStatus(0)).toBe("ok");
    expect(overdueStatus(1)).toBe("fail");
  });
});

describe("diskStatus", () => {
  it("warns under 15 % free and fails under 5 %", () => {
    expect(diskStatus(50, 100)).toBe("ok");
    expect(diskStatus(15, 100)).toBe("ok");
    expect(diskStatus(14.9, 100)).toBe("warn");
    expect(diskStatus(5, 100)).toBe("warn");
    expect(diskStatus(4.9, 100)).toBe("fail");
    expect(diskStatus(0, 0)).toBe("unknown");
  });
});

describe("backupStatus", () => {
  it("warns after 26 h, fails after 50 h", () => {
    expect(backupStatus({ ok: true, finishedAt: ago(2 * H) }, now)).toBe("ok");
    expect(backupStatus({ ok: true, finishedAt: ago(26 * H) }, now)).toBe("ok");
    expect(backupStatus({ ok: true, finishedAt: ago(26 * H + 1) }, now)).toBe("warn");
    expect(backupStatus({ ok: true, finishedAt: ago(50 * H + 1) }, now)).toBe("fail");
  });

  it("fails on a failed dump, however recent", () => {
    expect(backupStatus({ ok: false, finishedAt: ago(1_000) }, now)).toBe("fail");
  });
});

describe("taskAttention", () => {
  const task = { enabled: true, lastStatus: "ok" as const, lastOkAt: ago(5 * 60_000), intervalMinutes: 10 };

  it("is quiet for a task that ran within two periods", () => {
    expect(taskAttention(task, now)).toBeNull();
    expect(taskAttention({ ...task, lastOkAt: ago(20 * 60_000) }, now)).toBeNull();
  });

  it("flags a task late by more than two periods", () => {
    expect(taskAttention({ ...task, lastOkAt: ago(20 * 60_000 + 1) }, now)).toBe("overdue");
    expect(
      taskAttention({ ...task, lastStatus: "running", lastOkAt: ago(21 * 60_000) }, now),
    ).toBe("overdue");
  });

  it("flags a failed last run", () => {
    expect(taskAttention({ ...task, lastStatus: "error" }, now)).toBe("error");
  });

  it("ignores a disabled task and a task that never ran", () => {
    expect(taskAttention({ ...task, enabled: false, lastStatus: "error" }, now)).toBeNull();
    expect(taskAttention({ ...task, lastStatus: null, lastOkAt: null }, now)).toBeNull();
  });
});

describe("the database and the queues", () => {
  it("warns on a slow SELECT 1", () => {
    expect(dbLatencyStatus(3)).toBe("ok");
    expect(dbLatencyStatus(HEALTH_THRESHOLDS.dbLatencyWarnMs + 1)).toBe("warn");
  });

  it("warns at 80 % of max_connections and fails at 95 %", () => {
    expect(connectionsStatus(10, 40)).toBe("ok");
    expect(connectionsStatus(32, 40)).toBe("warn");
    expect(connectionsStatus(38, 40)).toBe("fail");
    expect(connectionsStatus(1, 0)).toBe("unknown");
  });

  it("warns on a failed job in the day or a job waiting ten minutes", () => {
    expect(jobsStatus(0, null)).toBe("ok");
    expect(jobsStatus(0, 60_000)).toBe("ok");
    expect(jobsStatus(1, null)).toBe("warn");
    expect(jobsStatus(0, 10 * 60_000 + 1)).toBe("warn");
  });
});
