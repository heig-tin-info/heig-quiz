/**
 * In-browser mock of the portal API, for design work without a backend
 * (`VITE_MOCK=1 pnpm dev`, or `pnpm dev:mock`). Never part of a production
 * build: main.tsx only imports this module behind the env flag, and Vite
 * drops the dead branch.
 *
 * The persona comes from `?as=teacher|student|admin` (remembered in this
 * browser). Every endpoint the web app calls is served from the in-memory
 * state below; mutations edit that state so the flows feel real, and a page
 * reload starts over.
 *
 * Scene flags, remembered the same way (`?empty=1`, `?empty=0` to clear):
 *
 *  - `empty` — nothing anywhere: no courses, no classrooms, no roster, no
 *    teachers, no pool and no evaluation, so every empty state is reachable;
 *  - `fail`  — every GET under /app/api answers 500 (except /app/api/me and
 *    /app/api/config, so the shell still renders), for the error states;
 *  - `slow`  — 2.5 s of latency on every call, for the loading states;
 *  - `many`  — 8 courses, 30 classrooms, a 120-student roster on the first
 *    one and 70 questions in the first pool: long lists, the sidebar, the
 *    cursor pagination of the pool table and the 120 × 10 live grid;
 *  - `mytest` — the teacher already holds a STAFF seat in the classroom and
 *    has taken every started evaluation with it (ADR-018): "View as student"
 *    then goes straight through, "Reset my test attempt" is in the overflow,
 *    and the badged staff row shows up in the live grid, the grading panel
 *    and the results. Without it the teacher holds no seat, which is the
 *    path that asks for a confirmation first;
 *  - `scene` — the student player's state, and only that one screen's:
 *    `?scene=lobby|running|paused|closed|extend|single|marks|forward` (`running` by default).
 *
 * ONE dataset, in one file per module of `apps/api/src/modules`, each
 * registering its own routes when it is imported:
 *
 *   runtime.ts     the persona, the scene flags, the frozen clock, the
 *                  deterministic RNG, the error types and the route table;
 *   session.ts     1a. who this browser is, and the public config;
 *   org.ts         1b. courses, classrooms, roster and administration;
 *   pool.ts        2.  pools, categories and questions of the four types,
 *                  with their versions, the preview and the `try` grading —
 *                  real French content about C programming and electronics;
 *   evaluation.ts  3.  evaluations in every state, over the questions of
 *                  pool.ts, and the dashboard they feed;
 *   live.ts        3b. the teacher's controls on a live evaluation;
 *   student.ts     4.  the student's home, lobby and player;
 *   grading.ts     5.  grading, results and the student's feedback;
 *   preview.ts     5b. the teacher's stateless preview of an evaluation;
 *   poll.ts        6.  the participant's poll page and the teacher's half.
 *
 * That list is also the dependency order, and the graph is acyclic: a file
 * reads the ones above it and never the ones below. Two handlers are
 * therefore registered one file down from the section they belong to, and
 * each says so where it is.
 *
 * Sections 3, 4 and 5 share the questions of section 2: an item of an
 * evaluation is frozen on a published version of a real question, so the
 * dashboard, the inspect panel and the teacher's preview render what the
 * pool actually holds rather than a second, parallel truth.
 *
 * Ids follow the same rule as the server. They are hand-written wherever a
 * human types them into a URL (`p1`, `q2`, `r1`, and an evaluation is also
 * addressable by its STATE — `/evaluations/running/live`), and real UUIDs
 * wherever a frame of the SSE stream carries them: those are validated in the
 * browser against `ServerEvent` and `DashboardView` (invariant 7), which a
 * made-up id silently fails.
 */
import type {
  ServerEvent,
} from "@quiz/contracts";

/*
 * The sections, in dependency order — which is also the order their routes
 * enter the table, first match wins.
 */
import {
  FLAG_NAMES,
  MockError,
  MockPayload,
  MockValidation,
  flags,
  rand,
  role,
  routes,
  scene,
} from "./runtime";
import "./session";
import "./org";
import "./pool";
import {
  dashboardView,
  evaluations,
  findEvaluation,
  itemQuestion,
  mockVerdict,
  summaryOf,
  type MockEvaluation,
} from "./evaluation";
import "./live";
import {
  BASE_DEADLINE,
  STUDENT_ATTEMPT,
  STUDENT_EVAL,
  setStudentDeadline,
  studentAttemptView,
  studentDeadline,
  studentLobbyView,
} from "./student";
import "./grading";
import "./preview";
import {
  polls,
  pollOfTeacher,
  tallyOf,
  teacherPolls,
  type MockTeacherPoll,
} from "./poll";


/** Latency of every mocked call: enough to see a skeleton under `?slow=1`. */
const LATENCY = () => (flags.slow ? 2500 : 120 + Math.random() * 180);

// --- The fetch interception ----------------------------------------------

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw, window.location.origin);
  if (!url.pathname.startsWith("/app/")) return realFetch(input, init);
  await new Promise((r) => setTimeout(r, LATENCY()));
  const method = (init?.method ?? "GET").toUpperCase();
  // `?fail=1`: every read fails, except the session and the public config —
  // the shell must still render so the failing page is the one under test.
  if (
    flags.fail &&
    method === "GET" &&
    url.pathname !== "/app/api/me" &&
    url.pathname !== "/app/api/config"
  ) {
    return new Response(JSON.stringify({ message: "Simulated failure" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  let body: Record<string, unknown> = {};
  if (typeof init?.body === "string" && init.body.startsWith("{")) {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    try {
      const result = r.h(m, body, url);
      if (result === undefined) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      if (e instanceof MockError) {
        const payload =
          e instanceof MockPayload
            ? e.body
            : e instanceof MockValidation
              ? { error: "config_invalid", message: e.message, details: e.details }
              : { message: e.message };
        return new Response(JSON.stringify(payload), {
          status: e.status,
          headers: { "content-type": "application/json" },
        });
      }
      throw e;
    }
  }
  console.warn(`[mock] no route for ${method} ${url.pathname}`);
  return new Response(JSON.stringify({ message: "Not mocked" }), { status: 404 });
};

// --- The fake SSE stream ---------------------------------------------------
//
// ONE `EventSource` for the three kinds of connection the app opens (§4.8),
// because the browser has one too: `realtime/useEventStream` shares a single
// socket between the shell and whichever screen is watching something.
//
//   - no `watch`    the shell's hint stream. The mock never sends a hint —
//                   every mutation here mutates the store synchronously, so
//                   there is nothing to re-fetch — but it does send the
//                   `clock`, because thirty seconds without one is how the
//                   client decides a socket is dead and reopens it;
//   - `evaluation:` the teacher's dashboard (section 3): a `snapshot` seeding
//                   the grid, then a trickle of `dashboard.cell` and
//                   `dashboard.presence`, or a `lobby.count` climbing while
//                   nobody has started. The student's own evaluation
//                   (section 4) answers the same subject with the lobby it
//                   is watching instead;
//   - `attempt:`    the student's player (section 4): the attempt snapshot,
//                   a beat a second, and whatever `?scene=` asks for — the
//                   teacher granting time, the pause, the closure.
//
// The dashboard trickle is deliberately faster than the server's coalescing
// (a cell a second instead of one per 250 ms per pair): the point is to SEE
// the grid move while looking at it, not to reproduce a load profile.
//
// Every frame goes out through `emit`, which is typed `ServerEvent`: the
// client validates each one against the same schema and drops what it cannot
// read, so a frame this file got wrong would fail silently. The type is the
// only thing that catches it.

/** How often the fake stream emits, in ms. */
const STREAM = { clock: 5_000, beat: 1_000, cell: 1_100, presence: 4_000, lobby: 3_000, tally: 1_200 };

class MockEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  private readonly listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  private readonly intervals: ReturnType<typeof setInterval>[] = [];
  private readonly timeouts: ReturnType<typeof setTimeout>[] = [];
  private closed = false;

  constructor(url: string) {
    this.url = url;
    this.after(60, () => this.start());
  }

  addEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }

  removeEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((f) => f !== fn));
  }

  close(): void {
    this.closed = true;
    for (const timer of this.intervals) clearInterval(timer);
    for (const timer of this.timeouts) clearTimeout(timer);
    this.intervals.length = 0;
    this.timeouts.length = 0;
    this.listeners.clear();
  }

  /** The named frames of §4.8; the unnamed hint would go through `onmessage`. */
  private emit(event: ServerEvent): void {
    if (this.closed) return;
    const frame = new MessageEvent(event.type, { data: JSON.stringify(event) });
    for (const fn of this.listeners.get(event.type) ?? []) fn(frame);
  }

  private every(ms: number, fn: () => void): void {
    this.intervals.push(setInterval(fn, ms));
  }

  private after(ms: number, fn: () => void): void {
    this.timeouts.push(setTimeout(fn, ms));
  }

  private start(): void {
    if (this.closed) return;
    this.onopen?.();
    const watch = new URL(this.url, window.location.origin).searchParams.get("watch");
    const beat = watch !== null && watch.startsWith("attempt:") ? STREAM.beat : STREAM.clock;
    const tick = () => this.emit({ type: "clock", serverNow: new Date().toISOString() });
    tick();
    this.every(beat, tick);
    if (watch === null) return;
    const id = watch.slice(watch.indexOf(":") + 1);
    if (watch.startsWith("attempt:") || id === STUDENT_EVAL) {
      this.student(watch);
      return;
    }
    const evaluation = findEvaluation(id);
    // A poll watches the same `evaluation:<id>` subject as a quiz, and gets
    // the aggregate instead of the grid: one question, no roster, no cells.
    const poll = teacherPolls.find((p) => p.id === (evaluation?.id ?? id)) ?? null;
    if (poll !== null) {
      this.poll(poll);
      return;
    }
    if (evaluation !== null) this.dashboard(watch, evaluation);
  }

  /**
   * The projection (F-LIVE-13): the WHOLE tally on every frame, never a
   * delta, so a beamer that missed one is right again on the next. The
   * counts themselves are moved by `advancePoll`, on its own timer, so a
   * reload does not rewind what the teacher just watched happen.
   */
  private poll(tp: MockTeacherPoll): void {
    const send = () => {
      const row = pollOfTeacher(tp);
      if (row === null) return;
      this.emit({
        type: "poll.tally",
        evaluationId: tp.id,
        tally: tallyOf(tp, row),
        serverNow: new Date().toISOString(),
      });
    };
    send();
    this.every(STREAM.tally, send);
  }

  /** Section 4: the player and the lobby the student is looking at. */
  private student(watch: string): void {
    const attempt = watch.startsWith("attempt:");
    this.emit({
      type: "snapshot",
      serverNow: new Date().toISOString(),
      subject: watch,
      state: attempt ? studentAttemptView() : studentLobbyView(),
    });
    if (!attempt) {
      this.emit({ type: "lobby.count", evaluationId: STUDENT_EVAL, present: 18, enrolled: 24 });
    }
    if (scene === "extend") {
      this.after(4000, () => {
        // Assignment, not `+=`: React mounts effects twice in development, so
        // two streams open and an increment would grant ten minutes instead
        // of five.
        setStudentDeadline(BASE_DEADLINE + 5 * 60_000);
        this.emit({
          type: "attempt.deadline",
          attemptId: STUDENT_ATTEMPT,
          deadlineAt: new Date(studentDeadline).toISOString(),
          bonusS: 300,
          reason: "teacher_extend",
          serverNow: new Date().toISOString(),
        });
      });
    }
    if (scene === "paused") {
      this.emit({
        type: "evaluation.state",
        evaluationId: STUDENT_EVAL,
        state: "paused",
        pausedAt: new Date().toISOString(),
        closesAt: null,
        serverNow: new Date().toISOString(),
      });
    }
    if (scene === "closed") {
      this.emit({
        type: "attempt.closed",
        attemptId: STUDENT_ATTEMPT,
        evaluationId: STUDENT_EVAL,
        closedBy: "server",
        serverNow: new Date().toISOString(),
      });
    }
  }

  /** Section 3: one class of students working, seen from the teacher's grid. */
  private dashboard(watch: string, evaluation: MockEvaluation): void {
    this.emit({
      type: "snapshot",
      serverNow: new Date().toISOString(),
      subject: watch,
      // Always without the answers, exactly like the server: the stream does
      // not know which toggles the teacher has on (`modules/realtime`).
      state: dashboardView(evaluation, false),
    });

    if (evaluation.state === "lobby" || evaluation.state === "scheduled") {
      this.every(STREAM.lobby, () => {
        const enrolled = evaluation.rows.length;
        evaluation.present = Math.min(enrolled, evaluation.present + (rand() < 0.6 ? 1 : 0));
        this.emit({
          type: "lobby.count",
          evaluationId: evaluation.id,
          present: evaluation.present,
          enrolled,
        });
      });
      return;
    }
    if (evaluation.state !== "running") return;

    // One student advances by one question at a time, in the store as well as
    // on the wire: a reload must not undo what the teacher watched happen.
    this.every(STREAM.cell, () => {
      const candidates = evaluation.rows.filter(
        (r) => r.attemptId !== null && r.state === "in_progress",
      );
      const row = candidates[Math.floor(rand() * candidates.length)];
      if (!row) return;
      const index = row.cells.findIndex((c) => c.status === "empty" || c.status === "seen");
      const cell = row.cells[index];
      const item = evaluation.items[index];
      if (!cell || !item) return;
      const question = itemQuestion(item);
      cell.status = cell.status === "empty" ? "seen" : "in_progress";
      cell.revision += 1;
      cell.verdict = cell.status === "in_progress" ? mockVerdict(index * 7 + cell.revision * 3) : null;
      cell.provisional = cell.verdict !== null;
      cell.summary =
        cell.status === "in_progress" && question !== null
          ? summaryOf(question, index + cell.revision)
          : null;
      this.emit({
        type: "dashboard.cell",
        evaluationId: evaluation.id,
        attemptId: row.attemptId!,
        itemId: cell.itemId,
        status: cell.status,
        revision: cell.revision,
        points: null,
        summary: cell.summary,
        flagged: cell.flagged,
        verdict: cell.verdict,
      });
    });

    this.every(STREAM.presence, () => {
      const row = evaluation.rows[Math.floor(rand() * evaluation.rows.length)];
      if (!row) return;
      row.online = !row.online;
      row.lastSeenAt = new Date().toISOString();
      this.emit({
        type: "dashboard.presence",
        evaluationId: evaluation.id,
        userId: row.userId,
        online: row.online,
        lastSeenAt: row.lastSeenAt,
      });
    });
  }
}
(window as unknown as { EventSource: unknown }).EventSource = MockEventSource;

const active = FLAG_NAMES.filter((f) => flags[f]);
console.info(
  `[mock] persona: ${role} — switch with ?as=teacher|student|admin` +
    `\n[mock] scene flags: ${active.length ? active.join(", ") : "none"} — ?empty=1 ?fail=1 ?slow=1 ?many=1 (append =0 to clear)` +
    `\n[mock] student scene: ${scene} — ?scene=lobby|running|paused|closed|extend|single|marks|forward` +
    `\n[mock] polls: /evaluations/poll/poll · /evaluations/poll-short/poll · /evaluations/poll-ended/poll — ?revealed=1`,
);

