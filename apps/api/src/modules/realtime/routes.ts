/**
 * THE Server-Sent Events stream (ADR-005, PLAN-MVP §4.8).
 *
 * ONE handler, mounted at `/app/api/events` — the path the plan names and the
 * one every client opens; it accepts `?watch=evaluation:<id>` /
 * `?watch=attempt:<id>`.
 *
 * Wire grammar, chosen so both clients read the same stream:
 *   - a HINT goes out as an UNNAMED frame (`data: {…}`), which is what
 *     `EventSource.onmessage` receives — the inherited client reacts to it
 *     exactly as before;
 *   - every typed live event goes out as a NAMED frame (`event: clock`,
 *     `event: dashboard.cell`, …), which an old client ignores and a new one
 *     subscribes to by name.
 *
 * Authorisation is loaded, never checked afterwards (invariant 6): the topic
 * set is computed once at connection time, and `dashboard.*` is dropped for a
 * student connection even when it watches the same `evaluation:<id>`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import { eq } from "drizzle-orm";

import { WatchSubject, isStaffOnly, type ServerEvent } from "@quiz/contracts";

import { iso } from "../../clock.js";
import { classrooms, courses, enrollments, evaluations, pools } from "../../db/schema.js";
import { subscribe, type BusMessage } from "../../events.js";
import { SITTING } from "../../auth/session.js";
import { accessWhere, findReachableEvaluation, poolAccess, sits, staffAccess } from "../guards.js";
import * as live from "../live/service.js";
import * as bus from "./bus.js";
import { presence } from "./presence.js";

/** `:ping` cadence (ADR-005) and the two `clock` cadences of §4.8. */
const PING_MS = 25_000;
export const CLOCK_MS = 10_000;
export const FAST_CLOCK_MS = 1_000;
/** A stream whose writes stopped reaching the socket is closed (WP5 brief). */
const IDLE_CLOSE_MS = 60_000;
const IDLE_SWEEP_MS = 5_000;

type Watch =
  | { kind: "evaluation"; evaluationId: string }
  /** The same topic as `evaluation`, watched from inside the room (F-LIVE-02). */
  | { kind: "lobby"; evaluationId: string }
  | { kind: "attempt"; attemptId: string; evaluationId: string };

interface Stream {
  userId: string;
  staff: boolean;
  /**
   * This connection is a BODY IN THE ROOM, and presence counts it (F-LIVE-02,
   * F-LIVE-03). It is not the opposite of `staff`: a teacher who holds a
   * roster seat and walks their own quiz (ADR-018) is both. What decides is
   * the subject — a `lobby:` or one's OWN `attempt:` — plus a claimed seat,
   * which is the same admission `participantOf` gives the attempt routes.
   */
  participant: boolean;
  topics: Set<string>;
  watch: Watch | null;
  res: ServerResponse;
  /** Last write the socket actually accepted; drives the idle close. */
  lastWriteAt: number;
  close: () => void;
}

const open = new Set<Stream>();

function write(stream: Stream, chunk: string, now: number): void {
  const flushed = stream.res.write(chunk);
  // `write` returns false when the chunk is only buffered: a socket that
  // stopped draining stops refreshing `lastWriteAt`, and the sweep closes it.
  if (flushed) stream.lastWriteAt = now;
}

function sendNamed(stream: Stream, event: ServerEvent, now: number): void {
  write(stream, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, now);
}

/** The inherited hint frame: unnamed, so `EventSource.onmessage` gets it. */
function sendHint(stream: Stream, message: Extract<BusMessage, { kind: "hint" }>, now: number): void {
  write(
    stream,
    `data: ${JSON.stringify({ type: "hint", kinds: [message.type], notice: message.notice ?? null })}\n\n`,
    now,
  );
}

/**
 * The topics a connection is subscribed to, by role. Identical to what
 * `modules/events.ts` computed before WP5 folded it in here, plus the two
 * live subjects.
 */
async function topicsOf(app: FastifyInstance, req: FastifyRequest): Promise<Set<string>> {
  const me = req.user!;
  const topics = new Set<string>([`user:${me.id}`]);
  if (me.role === "teacher" || me.role === "admin") {
    topics.add(`teacher:${me.id}`);
    if (me.role === "admin") topics.add("admin");
    const own = await app.db
      .select({ courseId: courses.id, roomId: classrooms.id })
      .from(courses)
      .leftJoin(classrooms, eq(classrooms.courseId, courses.id))
      .where(accessWhere(me, staffAccess(me.id)));
    for (const row of own) {
      topics.add(`course:${row.courseId}`);
      if (row.roomId) topics.add(`classroom:${row.roomId}`);
    }
    const reachablePools = await app.db
      .select({ id: pools.id })
      .from(pools)
      .where(accessWhere(me, poolAccess(me.id)));
    for (const pool of reachablePools) topics.add(`pool:${pool.id}`);
  } else {
    const rooms = await app.db
      .select({ id: enrollments.classroomId })
      .from(enrollments)
      .where(eq(enrollments.userId, me.id));
    for (const room of rooms) topics.add(`classroom:${room.id}`);
  }
  return topics;
}

/** `?watch=` is authorised against the subject itself, and 404s otherwise. */
async function resolveWatch(
  app: FastifyInstance,
  req: FastifyRequest,
  subject: WatchSubject,
): Promise<{
  watch: Watch;
  evaluation: typeof evaluations.$inferSelect;
  staff: boolean;
  participant: boolean;
} | null> {
  const separator = subject.indexOf(":");
  const [kind, id] = [subject.slice(0, separator), subject.slice(separator + 1)];
  if (kind === "evaluation") {
    const scope = await findReachableEvaluation(app.db, req.user!, id);
    if (!scope) return null;
    return {
      watch: { kind: "evaluation", evaluationId: id },
      evaluation: scope.evaluation,
      staff: scope.staff,
      participant: false,
    };
  }
  if (kind === "lobby") {
    // The SAME authorisation as `evaluation:` — nothing here is a second
    // door. What the subject adds is the side of the room: this connection
    // draws the waiting room, so it receives no `dashboard.*` whoever opened
    // it, and it counts as present when its user holds a seat.
    const scope = await findReachableEvaluation(app.db, req.user!, id);
    if (!scope) return null;
    const seat = await live.participantOf(app.db, scope.evaluation, req.user!.id);
    return {
      watch: { kind: "lobby", evaluationId: id },
      evaluation: scope.evaluation,
      staff: false,
      participant: seat !== null,
    };
  }
  if (kind === "attempt") {
    const attempt = await live.attemptById(app.db, id);
    if (!attempt) return null;
    const scope = await findReachableEvaluation(app.db, req.user!, attempt.evaluationId);
    if (!scope) return null;
    // A student watches their OWN attempt; a staff member watches any of
    // the evaluation's, which is what the dashboard's cell inspector needs.
    if (!scope.staff && attempt.userId !== req.user!.id) return null;
    return {
      watch: { kind: "attempt", attemptId: id, evaluationId: attempt.evaluationId },
      evaluation: scope.evaluation,
      staff: scope.staff,
      // Watching one's OWN attempt is sitting the quiz, teacher or not; a
      // staff inspector watching somebody else's row is not in the room.
      participant: attempt.userId === req.user!.id,
    };
  }
  return null;
}

/** The `snapshot` frame: the whole state of the watched subject, once. */
async function snapshotOf(
  app: FastifyInstance,
  stream: Stream,
  watch: Watch,
  now: Date,
): Promise<ServerEvent | null> {
  const evaluation = await app.db
    .select()
    .from(evaluations)
    .where(eq(evaluations.id, watch.evaluationId))
    .limit(1);
  const row = evaluation[0];
  if (!row) return null;
  const subject =
    watch.kind === "attempt"
      ? `attempt:${watch.attemptId}`
      : `${watch.kind}:${watch.evaluationId}`;

  if (watch.kind === "attempt") {
    const attempt = await live.attemptById(app.db, watch.attemptId);
    if (!attempt) return null;
    // The same gate as `GET /attempts/:id`: before the start the snapshot is
    // the lobby, question content and all (`attemptOrLobbyView`). A staff
    // inspector holds the teacher routes for the rest.
    const state = stream.staff
      ? await live.attemptView(app.db, row, attempt, now)
      : (await live.attemptOrLobbyView(app.db, row, attempt, now)).view;
    return { type: "snapshot", serverNow: iso(now), subject, state };
  }
  // A `lobby:` connection is in the room whoever opened it, so it gets the
  // lobby snapshot; `stream.staff` is already false for one (`resolveWatch`).
  if (stream.staff) {
    return {
      type: "snapshot",
      serverNow: iso(now),
      subject,
      state: await live.dashboardView(app.db, row, {
        now,
        includeAnswers: false,
        includeResults: false,
      }),
    };
  }
  const participant = (await live.participantOf(app.db, row, stream.userId)) ?? {
    userId: stream.userId,
    guestId: null,
    timeBonusPercent: 0,
  };
  return {
    type: "snapshot",
    serverNow: iso(now),
    subject,
    state: await live.lobbyView(app.db, row, participant, now),
  };
}

export async function realtimePlugin(app: FastifyInstance) {
  // One sweep for the whole process: a stream whose writes stopped reaching
  // the socket is dropped, so a dead browser cannot hold a slot for ever.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const stream of [...open]) {
      if (now - stream.lastWriteAt > IDLE_CLOSE_MS) stream.close();
    }
  }, IDLE_SWEEP_MS);
  sweep.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweep);
    for (const stream of [...open]) stream.close();
  });

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const me = req.user!;
    const query = (req.query ?? {}) as { watch?: unknown };
    const raw = typeof query.watch === "string" ? query.watch : null;

    let watch: Watch | null = null;
    let staff = me.role === "teacher" || me.role === "admin";
    let participant = false;
    // A `seb` session streams its evaluation and nothing else (ADR-027).
    if (raw === null && req.auth?.evaluationId) return reply.code(404).send({ error: "not_found" });
    if (raw !== null) {
      // The grammar is a contract (`WatchSubject`), not a `split(":")`:
      // `attempt:not-a-uuid` used to reach the database and answer a 500.
      const subject = WatchSubject.safeParse(raw);
      if (!subject.success) return reply.code(400).send({ error: "validation" });
      const resolved = await resolveWatch(app, req, subject.data);
      // An unreachable subject is a 404, exactly like a missing one — and so
      // is one this session may not sit (ADR-027); staff watching somebody
      // else's room is not sitting it.
      if (!resolved || !sits(req, resolved.evaluation, resolved.staff && !resolved.participant)) {
        return reply.code(404).send({ error: "not_found" });
      }
      watch = resolved.watch;
      staff = resolved.staff;
      participant = resolved.participant;
    }

    const topics = await topicsOf(app, req);
    if (watch?.kind === "evaluation" || watch?.kind === "lobby") {
      topics.add(`evaluation:${watch.evaluationId}`);
    }
    if (watch?.kind === "attempt") {
      topics.add(`attempt:${watch.attemptId}`);
      // Pause, resume and close arrive on the evaluation topic: an attempt
      // stream that did not hold it would miss the end of its own exam.
      topics.add(`evaluation:${watch.evaluationId}`);
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // Caddy/nginx: do not buffer this stream (docs/03, flush_interval -1).
      "x-accel-buffering": "no",
    });
    res.write(":connected\n\n");

    let closed = false;
    const stream: Stream = {
      userId: me.id,
      staff,
      participant,
      topics,
      watch,
      res,
      lastWriteAt: Date.now(),
      close: () => {
        if (closed) return;
        closed = true;
        open.delete(stream);
        clearInterval(ping);
        clearInterval(clock);
        unsubscribe();
        if (watch !== null && participant) {
          const change = presence.leave(watch.evaluationId, me.id, app.clock.now());
          if (change) {
            bus.dashboardPresence(change);
            void announceLobby(app, watch.evaluationId);
          }
        }
        res.end();
      },
    };
    open.add(stream);

    const unsubscribe = subscribe((message) => {
      if (closed) return;
      if (!message.topics.some((t) => stream.topics.has(t))) return;
      const at = Date.now();
      if (message.kind === "hint") return sendHint(stream, message, at);
      // The second half of the routing table: a student never receives
      // `dashboard.*`, whatever topic carried it.
      if (message.audience === "staff" && !stream.staff) return;
      if (!stream.staff && isStaffOnly(message.event)) return;
      sendNamed(stream, message.event, at);
    });

    const ping = setInterval(() => write(stream, ":ping\n\n", Date.now()), PING_MS);
    ping.unref();

    // The clock: 10 s normally, 1 s on an attempt stream while the
    // evaluation is running (docs/07 §7.3). The fast stream still only emits
    // once every 10 s when the evaluation is not running, so a lobby left
    // open overnight costs one frame per ten seconds.
    const fast = watch?.kind === "attempt";
    let sinceClock = 0;
    const clock = setInterval(
      () => {
        void (async () => {
          if (closed) return;
          const now = app.clock.now();
          sinceClock += fast ? FAST_CLOCK_MS : CLOCK_MS;
          let due = !fast || sinceClock >= CLOCK_MS;
          if (fast && !due) {
            const [row] = await app.db
              .select({ state: evaluations.state })
              .from(evaluations)
              .where(eq(evaluations.id, watch!.evaluationId))
              .limit(1);
            due = row?.state === "running";
          }
          if (!due) return;
          sinceClock = 0;
          sendNamed(stream, { type: "clock", serverNow: iso(now) }, Date.now());
          if (watch !== null && stream.participant) presence.touch(watch.evaluationId, me.id, now);
        })();
      },
      fast ? FAST_CLOCK_MS : CLOCK_MS,
    );
    clock.unref();

    req.raw.on("close", () => stream.close());

    // Presence, then the snapshot: the count the student reads already
    // includes them.
    if (watch !== null && participant) {
      const now = app.clock.now();
      const change = presence.join(watch.evaluationId, me.id, now);
      if (change) bus.dashboardPresence(change);
      await announceLobby(app, watch.evaluationId);
    }
    if (watch !== null) {
      const snapshot = await snapshotOf(app, stream, watch, app.clock.now());
      if (snapshot) sendNamed(stream, snapshot, Date.now());
    }
    return reply;
  };

  const guarded = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) => app.requireSession(req, reply),
    config: SITTING,
  };
  app.get("/app/api/events", guarded, handler);
}

/** F-LIVE-02: the ring everybody in the lobby watches. Coalesced 1 s. */
async function announceLobby(app: FastifyInstance, evaluationId: string): Promise<void> {
  const [row] = await app.db
    .select()
    .from(evaluations)
    .where(eq(evaluations.id, evaluationId))
    .limit(1);
  if (!row) return;
  bus.lobbyCount({
    evaluationId,
    present: presence.count(evaluationId),
    enrolled: await live.enrolledCount(app.db, row),
  });
}
