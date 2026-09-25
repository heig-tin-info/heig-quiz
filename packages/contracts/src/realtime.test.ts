/**
 * The SSE grammar is the last filter before an event reaches a student's
 * `EventSource` (invariants 4 and 6), and it is also the list the browser
 * subscribes to. Both used to be hand-written arrays with no compile-time
 * link to `ServerEvent`; the tests below close that gap from the other side.
 */
import { describe, expect, it } from "vitest";

import {
  RunAccepted,
  SERVER_EVENT_NAMES,
  STAFF_ONLY_EVENTS,
  ServerEvent,
  isStaffOnly,
  type ServerEventName,
} from "./realtime.js";

/**
 * The audience of every frame, exhaustively. The `Record<ServerEventName, …>`
 * annotation is half the check: a new member of `ServerEvent` with no entry
 * here does not compile. The tests are the other half, so the same omission
 * is also red rather than only unbuildable.
 *
 * What this does NOT catch: an event that IS staff-only but is written `false`
 * here and left out of `STAFF_ONLY_EVENTS` — both lists agree, so the suite is
 * green and the frame reaches every student. Closing that needs the audience
 * on the schema itself (`staffEvent(z.object({…}))`, P-09's second option).
 */
const STAFF_ONLY: Record<ServerEventName, boolean> = {
  snapshot: false,
  clock: false,
  "evaluation.state": false,
  "attempt.deadline": false,
  "attempt.closed": false,
  "dashboard.cell": true,
  "dashboard.presence": true,
  "dashboard.attempt": true,
  "lobby.count": false,
  "runner.result": false,
  "grading.progress": false,
  hint: false,
  "poll.tally": true,
};

/** The discriminant of each member of the union, read off the schema. */
const declared = ServerEvent.options.map((option) => option.shape.type.value);

describe("ServerEvent", () => {
  it("declares exactly the events this file knows the audience of", () => {
    expect([...declared].sort()).toEqual(Object.keys(STAFF_ONLY).sort());
  });

  it("names every member once", () => {
    expect(new Set(declared).size).toBe(declared.length);
  });
});

describe("isStaffOnly", () => {
  it("answers the table for every member of the union", () => {
    for (const name of declared) {
      // Only the discriminant is read; a full frame per member would test the
      // schemas, not the filter.
      expect(isStaffOnly({ type: name } as ServerEvent)).toBe(STAFF_ONLY[name]);
    }
  });

  it("drops the four staff frames and keeps the nine others", () => {
    const staff = declared.filter((name) => isStaffOnly({ type: name } as ServerEvent));
    expect(staff).toEqual(["dashboard.cell", "dashboard.presence", "dashboard.attempt", "poll.tally"]);
  });

  it("agrees with STAFF_ONLY_EVENTS", () => {
    expect([...STAFF_ONLY_EVENTS].sort()).toEqual(
      declared.filter((name) => STAFF_ONLY[name]).sort(),
    );
  });

  it("reads a whole frame, not only a bare discriminant", () => {
    const cell = {
      type: "dashboard.cell",
      evaluationId: "8b4a1a2c-3d4e-4f5a-9b6c-7d8e9f0a1b2c",
      attemptId: "8b4a1a2c-3d4e-4f5a-9b6c-7d8e9f0a1b2d",
      itemId: "8b4a1a2c-3d4e-4f5a-9b6c-7d8e9f0a1b2e",
      status: "done",
      revision: 3,
      points: null,
      summary: null,
      flagged: true,
      verdict: null,
    } as const;
    expect(isStaffOnly(ServerEvent.parse(cell))).toBe(true);
  });
});

describe("SERVER_EVENT_NAMES", () => {
  it("covers every member of the union but the unnamed hint", () => {
    expect([...SERVER_EVENT_NAMES].sort()).toEqual(declared.filter((n) => n !== "hint").sort());
  });

  it("excludes the hint, which travels without a name", () => {
    expect(SERVER_EVENT_NAMES as readonly string[]).not.toContain("hint");
  });
});

describe("RunAccepted", () => {
  it("repeats the runner.result frame minus its discriminant", () => {
    const body = {
      requestId: "8b4a1a2c-3d4e-4f5a-9b6c-7d8e9f0a1b2c",
      result: { status: "unavailable" },
    };
    expect(RunAccepted.parse(body)).toEqual(body);
  });

  it("refuses a result the SSE frame could not carry", () => {
    expect(
      RunAccepted.safeParse({
        requestId: "8b4a1a2c-3d4e-4f5a-9b6c-7d8e9f0a1b2c",
        result: { status: "nonsense" },
      }).success,
    ).toBe(false);
  });
});
