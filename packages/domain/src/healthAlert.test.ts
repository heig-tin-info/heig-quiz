import { describe, expect, it } from "vitest";

import type { CheckStatus } from "./health.js";
import { HEALTH_ALERT, nextCheckState, type CheckNotice, type CheckState } from "./healthAlert.js";

const MIN = 60_000;
const start = new Date("2026-10-01T12:00:00Z");

/** Feeds statuses five minutes apart, as the task would; returns the notices and the last state. */
function run(statuses: CheckStatus[], from: CheckState | null = null, at = start) {
  let state = from;
  const notices: (CheckNotice | null)[] = [];
  statuses.forEach((status, i) => {
    const next = nextCheckState(state, status, new Date(at.getTime() + i * 5 * MIN));
    state = next.state;
    notices.push(next.notice);
  });
  return { notices, state: state! };
}

describe("nextCheckState — the anti-flap rule of the health alerts (ADR-055 §5)", () => {
  it("says nothing on a single failed run", () => {
    expect(run(["ok", "fail"]).notices).toEqual([null, null]);
    expect(run(["fail", "ok"]).notices).toEqual([null, null]);
  });

  it("alerts on the second failed run in a row", () => {
    expect(HEALTH_ALERT.failRuns).toBe(2);
    const { notices, state } = run(["ok", "fail", "fail"]);
    expect(notices).toEqual([null, null, "failing"]);
    expect(state).toMatchObject({ status: "fail", consecutive: 2, notified: "fail" });
    // The streak started at the first failed run.
    expect(state.since).toEqual(new Date(start.getTime() + 5 * MIN));
  });

  it("never repeats the alert while the check stays failing", () => {
    expect(run(["fail", "fail", "fail", "fail", "fail"]).notices).toEqual([null, "failing", null, null, null]);
  });

  it("sends one recovery when the check is ok again after an alert", () => {
    const { notices, state } = run(["fail", "fail", "fail", "ok", "ok"]);
    expect(notices).toEqual([null, "failing", null, "recovered", null]);
    expect(state).toMatchObject({ status: "ok", consecutive: 2, notified: "ok" });
  });

  it("recovers silently from a failure nobody was told about", () => {
    expect(run(["fail", "ok", "fail", "ok"]).notices).toEqual([null, null, null, null]);
  });

  it("says nothing between warn and ok, either way", () => {
    expect(run(["ok", "warn", "warn", "warn", "ok", "warn"]).notices).toEqual([null, null, null, null, null, null]);
  });

  it("neither alerts nor recovers on unknown", () => {
    expect(run(["unknown", "unknown", "unknown"]).notices).toEqual([null, null, null]);
    // An alert outstanding stays outstanding through unknown and warn: the
    // recovery waits for an ok, and a failure again is not a second alert.
    expect(run(["fail", "fail", "unknown", "warn", "fail", "fail", "ok"]).notices).toEqual([
      null,
      "failing",
      null,
      null,
      null,
      null,
      "recovered",
    ]);
  });

  it("alerts again after a recovery, once the check fails twice more", () => {
    expect(run(["fail", "fail", "ok", "fail", "fail"]).notices).toEqual([null, "failing", "recovered", null, "failing"]);
  });

  it("reminds once a day while the check keeps failing", () => {
    const { state } = run(["fail", "fail"]);
    const later = (ms: number) => new Date(state.notifiedAt!.getTime() + ms);
    expect(nextCheckState(state, "fail", later(HEALTH_ALERT.reminderMs - 1)).notice).toBeNull();
    const reminded = nextCheckState(state, "fail", later(HEALTH_ALERT.reminderMs));
    expect(reminded.notice).toBe("still_failing");
    expect(reminded.state.notifiedAt).toEqual(later(HEALTH_ALERT.reminderMs));
    // The next reminder counts from this one.
    expect(nextCheckState(reminded.state, "fail", later(HEALTH_ALERT.reminderMs + 5 * MIN)).notice).toBeNull();
  });

  it("keeps the first failed run as `since` through unknown runs while an alert is out", () => {
    const failedAt = new Date(start.getTime());
    expect(run(["fail", "fail", "unknown", "unknown", "fail"]).state.since).toEqual(failedAt);
    // Without an alert out, an unknown run ends the streak as any change does.
    expect(run(["fail", "unknown", "fail"]).state.since).toEqual(new Date(start.getTime() + 10 * MIN));
    // A warning is a measure, not a blank: it ends the failure's streak.
    expect(run(["fail", "fail", "warn", "fail"]).state.since).toEqual(new Date(start.getTime() + 15 * MIN));
  });
});
