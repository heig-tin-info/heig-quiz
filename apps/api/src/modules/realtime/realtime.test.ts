/**
 * The realtime module (PLAN-MVP §4.8): the SSE stream, its authorisation, its
 * snapshot and the coalescers.
 *
 * The stream is exercised over the REAL application (`testServer`), because
 * what is being asserted is exactly the part a unit test would stub away: who
 * is allowed to watch what, and which frames a connection is allowed to see.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { applyState } from "../evaluation/service.js";
import { registerForTests } from "@quiz/registry/server";

import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { testServer, type TestServer } from "../../test/http.js";
import * as bus from "./bus.js";
import { Coalescer, type TimerApi } from "./coalesce.js";
import { CLOCK_MS, FAST_CLOCK_MS } from "./routes.js";
import { PresenceMap } from "./presence.js";

// --- The coalescer, on a clock the test owns -----------------------------

/** A timer table driven by hand: a window closes when the test says so. */
function fakeTimers(): TimerApi & { run(): void; pending(): number } {
  const scheduled = new Map<number, () => void>();
  let next = 1;
  return {
    setTimeout(fn) {
      const handle = next++;
      scheduled.set(handle, fn);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle) {
      scheduled.delete(handle as unknown as number);
    },
    run() {
      for (const [handle, fn] of [...scheduled]) {
        scheduled.delete(handle);
        fn();
      }
    },
    pending: () => scheduled.size,
  };
}

describe("coalescer (250 ms per (attempt, item))", () => {
  it("emits ONCE per window, with the last value pushed into it", () => {
    const timers = fakeTimers();
    const seen: string[] = [];
    const coalescer = new Coalescer<string>(250, (v) => seen.push(v), timers);

    coalescer.push("a", "first");
    coalescer.push("a", "second");
    coalescer.push("a", "third");
    // Nothing yet: the window is still open, and there is ONE window.
    expect(seen).toEqual([]);
    expect(timers.pending()).toBe(1);

    timers.run();
    expect(seen).toEqual(["third"]);

    // The next push opens a new window rather than riding the closed one.
    coalescer.push("a", "fourth");
    expect(timers.pending()).toBe(1);
    timers.run();
    expect(seen).toEqual(["third", "fourth"]);
  });

  it("never lets one key hide another", () => {
    const timers = fakeTimers();
    const seen: string[] = [];
    const coalescer = new Coalescer<string>(250, (v) => seen.push(v), timers);
    coalescer.push("attempt-1:item-1", "one");
    coalescer.push("attempt-1:item-2", "two");
    coalescer.push("attempt-1:item-1", "one-again");
    timers.run();
    expect(seen.sort()).toEqual(["one-again", "two"]);
  });

  it("flushes what is pending on demand (shutdown)", () => {
    const timers = fakeTimers();
    const seen: string[] = [];
    const coalescer = new Coalescer<string>(250, (v) => seen.push(v), timers);
    coalescer.push("a", "pending");
    coalescer.flush();
    expect(seen).toEqual(["pending"]);
    expect(coalescer.size).toBe(0);
  });
});

describe("presence map", () => {
  it("counts distinct users, not connections, and reports the transitions", () => {
    const map = new PresenceMap();
    const at = new Date("2026-09-20T08:00:00.000Z");
    expect(map.join("e", "u1", at)?.online).toBe(true);
    // A second tab of the same student is not a second present student.
    expect(map.join("e", "u1", at)).toBeNull();
    expect(map.count("e")).toBe(1);
    expect(map.leave("e", "u1", at)).toBeNull();
    expect(map.leave("e", "u1", at)?.online).toBe(false);
    expect(map.count("e")).toBe(0);
  });

  /** Finding L4: the only structure that grew with every evaluation ever run. */
  it("drops the record with the last connection, and the empty room with it", () => {
    const map = new PresenceMap();
    const at = new Date("2026-09-20T08:00:00.000Z");
    map.join("e", "u1", at);
    map.join("e", "u2", at);
    expect(map.watchedEvaluations()).toEqual(["e"]);
    map.leave("e", "u1", at);
    expect(map.watchedEvaluations()).toEqual(["e"]);
    map.leave("e", "u2", at);
    expect(map.watchedEvaluations()).toEqual([]);
  });

  it("sweeps a silent user offline exactly once", () => {
    const map = new PresenceMap();
    const at = new Date("2026-09-20T08:00:00.000Z");
    map.join("e", "u1", at);
    const later = new Date(at.getTime() + 60_000);
    expect(map.sweep(later, 45_000).map((c) => c.userId)).toEqual(["u1"]);
    expect(map.sweep(later, 45_000)).toEqual([]);
  });
});

// --- The stream ----------------------------------------------------------

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };
let stranger: { id: string; headers: Record<string, string> };
let seed: Awaited<ReturnType<typeof seedLive>>;
const opened: { destroy: () => void }[] = [];

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  stranger = await server.signIn("student");
  seed = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions: 2,
  });
  await applyState(
    server.app.db,
    await reload(server.app.db, seed.evaluationId),
    "lobby",
    server.clock.now(),
  );
});

afterEach(() => {
  for (const stream of opened.splice(0)) stream.destroy();
  bus.resetCoalescers();
});

afterAll(async () => {
  await server.close();
  restore();
});

/** Opens an SSE connection and collects the frames it receives. */
async function openStream(headers: Record<string, string>, watch?: string) {
  const res = await server.app.inject({
    method: "GET",
    url: `/app/api/events${watch === undefined ? "" : `?watch=${encodeURIComponent(watch)}`}`,
    headers,
    payloadAsStream: true,
  });
  let text = "";
  if (res.statusCode === 200) {
    res.stream().on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
  }
  const handle = {
    statusCode: res.statusCode,
    get text() {
      return text;
    },
    destroy: () => res.stream().destroy(),
  };
  opened.push(handle);
  return handle;
}

/** Lets the event loop deliver what the handler wrote. */
const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** Every `event: <name>` of what a stream received so far. */
const names = (text: string): string[] =>
  [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]!);

/** The JSON of the first frame with that name. */
function frame(text: string, name: string): Record<string, unknown> | null {
  const match = new RegExp(`^event: ${name}\\ndata: (.+)$`, "m").exec(text);
  return match ? (JSON.parse(match[1]!) as Record<string, unknown>) : null;
}

describe("topic authorisation", () => {
  it("refuses an evaluation the caller cannot reach, with a 404", async () => {
    const denied = await openStream(stranger.headers, `evaluation:${seed.evaluationId}`);
    expect(denied.statusCode).toBe(404);
  });

  it("refuses a watch on a subject that does not exist", async () => {
    const denied = await openStream(
      teacher.headers,
      "evaluation:11111111-1111-4111-8111-111111111111",
    );
    expect(denied.statusCode).toBe(404);
  });

  /** Finding M4: `attempt:not-a-uuid` used to reach the database and 500. */
  it("refuses a malformed watch subject with a 400", async () => {
    expect((await openStream(teacher.headers, "attempt:not-a-uuid")).statusCode).toBe(400);
    expect((await openStream(teacher.headers, "pool:whatever")).statusCode).toBe(400);
    expect((await openStream(teacher.headers, "nonsense")).statusCode).toBe(400);
  });

  it("refuses an attempt that belongs to someone else", async () => {
    const other = await server.signIn("student");
    const enrolled = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [other.id],
      questions: 1,
    });
    const running = await applyState(
      server.app.db,
      await reload(server.app.db, enrolled.evaluationId),
      "running",
      server.clock.now(),
    );
    const live = await import("../live/service.js");
    const participant = (await live.participantOf(server.app.db, running, other.id))!;
    const attempt = await live.ensureAttempt(
      server.app.db,
      running,
      participant,
      server.clock.now(),
    );

    const denied = await openStream(student.headers, `attempt:${attempt.id}`);
    expect(denied.statusCode).toBe(404);
    // Its owner passes, and so does the teaching staff.
    expect((await openStream(other.headers, `attempt:${attempt.id}`)).statusCode).toBe(200);
    expect((await openStream(teacher.headers, `attempt:${attempt.id}`)).statusCode).toBe(200);
  });

  it("lets an enrolled student watch the evaluation they are in", async () => {
    const stream = await openStream(student.headers, `evaluation:${seed.evaluationId}`);
    expect(stream.statusCode).toBe(200);
  });

  it("opens the inherited stream with no watch at all", async () => {
    const stream = await openStream(teacher.headers);
    expect(stream.statusCode).toBe(200);
    await settle();
    expect(stream.text).toContain(":connected");
  });
});

describe("snapshot on connect", () => {
  it("gives a teacher the dashboard grid", async () => {
    const stream = await openStream(teacher.headers, `evaluation:${seed.evaluationId}`);
    await settle();
    const snapshot = frame(stream.text, "snapshot");
    expect(snapshot).not.toBeNull();
    expect(snapshot!["subject"]).toBe(`evaluation:${seed.evaluationId}`);
    const state = snapshot!["state"] as Record<string, unknown>;
    expect(state["rows"]).toBeDefined();
    expect((state["items"] as unknown[]).length).toBe(2);
    expect((state["evaluation"] as Record<string, unknown>)["state"]).toBe("lobby");
  });

  /** Finding C1: the `attempt:` snapshot obeys the same gate as the route. */
  it("gives a student in the lobby no question content on their own attempt", async () => {
    const live = await import("../live/service.js");
    const row = await reload(server.app.db, seed.evaluationId);
    const participant = (await live.participantOf(server.app.db, row, student.id))!;
    const attempt = await live.ensureAttempt(server.app.db, row, participant, server.clock.now());

    const stream = await openStream(student.headers, `attempt:${attempt.id}`);
    expect(stream.statusCode).toBe(200);
    await settle();
    const snapshot = frame(stream.text, "snapshot");
    expect(snapshot).not.toBeNull();
    expect(snapshot!["subject"]).toBe(`attempt:${attempt.id}`);
    const state = snapshot!["state"] as Record<string, unknown>;
    // The lobby view, exactly as `POST /evaluations/:id/attempt` answers it.
    expect(state["items"]).toBeUndefined();
    expect(state["enrolled"]).toBe(1);
    expect(stream.text).not.toContain("Statement of q0");
  });

  it("gives a student the lobby view, never the grid", async () => {
    const stream = await openStream(student.headers, `evaluation:${seed.evaluationId}`);
    await settle();
    const snapshot = frame(stream.text, "snapshot");
    expect(snapshot).not.toBeNull();
    const state = snapshot!["state"] as Record<string, unknown>;
    expect(state["enrolled"]).toBe(1);
    expect(state["rows"]).toBeUndefined();
  });
});

describe("what a student is allowed to receive (§4.8)", () => {
  it("drops dashboard.* for a student and keeps it for the staff", async () => {
    const teacherStream = await openStream(teacher.headers, `evaluation:${seed.evaluationId}`);
    const studentStream = await openStream(student.headers, `evaluation:${seed.evaluationId}`);
    await settle();

    bus.dashboardCell({
      evaluationId: seed.evaluationId,
      attemptId: "22222222-2222-4222-8222-222222222222",
      itemId: seed.itemIds[0]!,
      status: "in_progress",
      revision: 3,
      points: null,
      summary: "typed something",
    });
    bus.flushCoalescers();
    await settle();

    expect(names(teacherStream.text)).toContain("dashboard.cell");
    expect(studentStream.text).not.toContain("dashboard.cell");
    // …and the answer summary certainly never reaches the other student.
    expect(studentStream.text).not.toContain("typed something");
  });

  /**
   * Finding M3: `attempt.closed` rode the evaluation topic for everybody, so
   * every student in the room saw which classmate submitted, and when.
   */
  it("keeps attempt.closed for the attempt's owner and for the staff", async () => {
    const live = await import("../live/service.js");
    const row = await reload(server.app.db, seed.evaluationId);
    const participant = (await live.participantOf(server.app.db, row, student.id))!;
    const attempt = await live.ensureAttempt(server.app.db, row, participant, server.clock.now());

    const teacherStream = await openStream(teacher.headers, `evaluation:${seed.evaluationId}`);
    const peerStream = await openStream(student.headers, `evaluation:${seed.evaluationId}`);
    const ownStream = await openStream(student.headers, `attempt:${attempt.id}`);
    await settle();

    bus.attemptClosed({
      attemptId: attempt.id,
      evaluationId: seed.evaluationId,
      closedBy: "student",
      now: server.clock.now(),
    });
    await settle();

    expect(names(ownStream.text)).toContain("attempt.closed");
    expect(names(teacherStream.text)).toContain("attempt.closed");
    // The same student, watching only the evaluation, learns nothing.
    expect(peerStream.text).not.toContain("attempt.closed");
  });

  /**
   * The frame that tells the grid a roster row now has an attempt. It carries
   * one student's identity, their deadline and their state to every watcher
   * of the evaluation topic — which is why it is staff-only.
   */
  it("keeps dashboard.attempt for the staff and drops it for a student", async () => {
    const teacherStream = await openStream(teacher.headers, `evaluation:${seed.evaluationId}`);
    const studentStream = await openStream(student.headers, `evaluation:${seed.evaluationId}`);
    await settle();

    bus.dashboardAttempt({
      evaluationId: seed.evaluationId,
      userId: student.id,
      attemptId: "33333333-3333-4333-8333-333333333333",
      state: "in_progress",
      startedAt: server.clock.now(),
      deadlineAt: new Date(server.clock.now().getTime() + 60_000),
    });
    await settle();

    expect(names(teacherStream.text)).toContain("dashboard.attempt");
    const event = frame(teacherStream.text, "dashboard.attempt")!;
    expect(event["userId"]).toBe(student.id);
    expect(event["state"]).toBe("in_progress");
    expect(studentStream.text).not.toContain("dashboard.attempt");
  });

  it("delivers lobby.count and evaluation.state to both", async () => {
    const teacherStream = await openStream(teacher.headers, `evaluation:${seed.evaluationId}`);
    const studentStream = await openStream(student.headers, `evaluation:${seed.evaluationId}`);
    await settle();

    bus.lobbyCount({ evaluationId: seed.evaluationId, present: 1, enrolled: 1 });
    bus.evaluationState({
      evaluationId: seed.evaluationId,
      state: "running",
      pausedAt: null,
      closesAt: null,
      now: server.clock.now(),
    });
    bus.flushCoalescers();
    await settle();

    for (const stream of [teacherStream, studentStream]) {
      expect(names(stream.text)).toContain("lobby.count");
      expect(names(stream.text)).toContain("evaluation.state");
    }
  });

  it("carries the inherited hint as an UNNAMED frame, for the shipped client", async () => {
    const stream = await openStream(teacher.headers);
    await settle();
    bus.hint("evaluations", [`teacher:${teacher.id}`]);
    await settle();
    // No `event:` line, so `EventSource.onmessage` receives it (apps/web).
    expect(stream.text).toContain('data: {"type":"hint"');
    expect(names(stream.text)).not.toContain("hint");
  });
});

describe("clock", () => {
  it("beats on the cadence of §4.8 without anybody waiting for it", async () => {
    // ONLY the interval functions are faked: the injected request, the
    // database and the promise queue keep running for real, so the test
    // drives the cadence without sleeping and without deadlocking.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const stream = await openStream(teacher.headers, `evaluation:${seed.evaluationId}`);
      await settle();
      expect(names(stream.text)).not.toContain("clock");
      await vi.advanceTimersByTimeAsync(CLOCK_MS);
      await settle();
      expect(names(stream.text)).toContain("clock");
      expect(frame(stream.text, "clock")!["serverNow"]).toBe(server.clock.now().toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("beats every second on an attempt stream of a RUNNING evaluation", async () => {
    const other = await server.signIn("student");
    const own = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [other.id],
      questions: 1,
    });
    const running = await applyState(
      server.app.db,
      await reload(server.app.db, own.evaluationId),
      "running",
      server.clock.now(),
    );
    const live = await import("../live/service.js");
    const participant = (await live.participantOf(server.app.db, running, other.id))!;
    const attempt = await live.ensureAttempt(server.app.db, running, participant, server.clock.now());

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const stream = await openStream(other.headers, `attempt:${attempt.id}`);
      await settle();
      await vi.advanceTimersByTimeAsync(FAST_CLOCK_MS);
      await settle();
      expect(names(stream.text)).toContain("clock");
    } finally {
      vi.useRealTimers();
    }
  });
});
