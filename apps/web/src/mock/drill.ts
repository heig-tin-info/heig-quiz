/**
 * 7. The drill (ADR-041, #317): the student's session, cards served and
 * reviewed, the opt-out per classroom, and the teacher's switches — the
 * classroom's drill and an evaluation's "Allow drill" with its cards.
 *
 * The cards are questions of section 2, served through their type's own
 * `toStudent` (`studentView`) and graded by the same `tryAnswer` the preview
 * uses, so the player and the review render what a real card would. The
 * rating and the next due date follow the correctness, as strategy A does
 * without a reference time (ADR-041 §4, §10 item 7).
 *
 * Scene flag `?reviewed=1`: today's drill is already done — the empty day,
 * "nothing to review today" with the next due date. `?empty=1` has no
 * classroom at all, so no drill.
 */
import type {
  DrillClassroom,
  DrillClassroomSettings,
  DrillReviewResult,
  DrillServed,
  DrillSession,
  EvaluationDrill,
} from "@quiz/contracts";

import { evaluationOr404, evaluations, toEvaluation, type MockEvaluation } from "./evaluation";
import { courses, roomOr404, rooms } from "./org";
import { frozenConfig, questions, studentSolutionOf, studentView, tryAnswer, type MockQuestion } from "./pool";
import { D, flags, iso, MockError, now, on } from "./runtime";

/** The classrooms the student persona sits in (`studentRooms` in org.ts). */
const studentRoomIds = () => rooms.slice(0, 2).map((r) => r.id);

// Both of the student's classrooms have the drill on, from the start.
for (const id of studentRoomIds()) {
  const room = rooms.find((r) => r.id === id);
  if (room) room.drillEnabledAt = iso(-20 * D);
}

/** classroom id -> when the student left its drill. */
const optedOut = new Map<string, string>();

// --- The cards -------------------------------------------------------------

interface MockCard {
  id: string;
  classroomId: string;
  question: MockQuestion;
  isNew: boolean;
}

/** The four types of v1 (ADR-041 §3), a published version each, in an interleaved order. */
const DRILL_TYPES = ["mcq", "short", "cloze", "categorize"] as const;
const drillable = questions.filter(
  (q) => (DRILL_TYPES as readonly string[]).includes(q.type) && q.versions.length > 0 && q.deletedAt === null,
);
const pickOf = (type: string, n: number) => drillable.filter((q) => q.type === type).slice(0, n);
const picked = [...pickOf("mcq", 2), ...pickOf("short", 1), ...pickOf("cloze", 1), ...pickOf("categorize", 1)];

const cards: MockCard[] = picked.map((question, i) => ({
  id: `dddddddd-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  // The last card from the second classroom: leaving that one's drill shows.
  classroomId: studentRoomIds()[i === picked.length - 1 ? 1 : 0] ?? "r1",
  question,
  isNew: i % 2 === 1,
}));

/** Reviewed today: out of the session until tomorrow. `?reviewed=1` did them all. */
const reviewedToday = new Set<string>(flags.reviewed ? cards.map((c) => c.id) : []);

const roomOn = (id: string) => (rooms.find((r) => r.id === id)?.drillEnabledAt ?? null) !== null;
const active = () => cards.filter((c) => roomOn(c.classroomId) && !optedOut.has(c.classroomId));
const inSession = () => active().filter((c) => !reviewedToday.has(c.id));
const cardOr404 = (id: string) => {
  const card = inSession().find((c) => c.id === id);
  if (!card) throw new MockError(404, "Card not found");
  return card;
};

/** Local midnight tomorrow: where a card reviewed today, or held by the cap, comes back. */
const tomorrow = () => {
  const d = new Date(now + D);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

// --- Student ---------------------------------------------------------------

on("GET", "/app/api/drill/session", (): DrillSession => {
  const session = inSession();
  const courseOf = (card: MockCard) => {
    const room = rooms.find((r) => r.id === card.classroomId);
    return courses.find((c) => c.id === room?.courseId);
  };
  return {
    cards: session.map((card) => ({
      id: card.id,
      type: card.question.type,
      courseCode: courseOf(card)?.code ?? "",
      courseName: courseOf(card)?.name ?? "",
      isNew: card.isNew,
    })),
    budgetMs: 10 * 60_000,
    nextDueAt: session.length === 0 && active().length > 0 ? tomorrow() : null,
  };
});

const drillClassroom = (id: string): DrillClassroom => {
  const room = roomOr404(id);
  const course = courses.find((c) => c.id === room.courseId);
  return {
    classroomId: room.id,
    classroomName: room.name,
    courseCode: course?.code ?? "",
    courseName: course?.name ?? "",
    optedOutAt: optedOut.get(room.id) ?? null,
  };
};

on("GET", "/app/api/drill/classrooms", (): DrillClassroom[] =>
  studentRoomIds().filter(roomOn).map(drillClassroom),
);

on("PUT", "/app/api/drill/classrooms/:id/opt-out", (m, body): DrillClassroom => {
  const id = m.groups!.id!;
  if (!studentRoomIds().includes(id) || !roomOn(id)) throw new MockError(404, "Classroom not found");
  if (body.optedOut === true) optedOut.set(id, new Date().toISOString());
  else optedOut.delete(id);
  return drillClassroom(id);
});

on("POST", "/app/api/drill/cards/:id/serve", (m): DrillServed => {
  const card = cardOr404(m.groups!.id!);
  return {
    cardId: card.id,
    type: card.question.type,
    student: studentView(card.question, frozenConfig(card.question)),
  };
});

on("POST", "/app/api/drill/cards/:id/shown", (m) => {
  cardOr404(m.groups!.id!);
  return undefined;
});

/** Days to the next review, per rating: what FSRS gives a young card, roughly. */
const INTERVAL_DAYS: Record<number, number> = { 1: 1, 2: 2, 3: 4, 4: 9 };

on("POST", "/app/api/drill/cards/:id/answer", (m, body): DrillReviewResult => {
  const card = cardOr404(m.groups!.id!);
  const q = card.question;
  const graded = tryAnswer(q, frozenConfig(q), body.answer ?? null) as {
    points: number;
    maxPoints: number;
    solution: unknown;
  };
  const correctness =
    graded.points >= graded.maxPoints ? "right" : graded.points > 0 ? "partial" : "wrong";
  // No reference time on a card this young: a right answer is Good, and a
  // short answer typed right is the one Easy, so the screen shows both.
  const rating = correctness === "wrong" ? 1 : correctness === "partial" ? 2 : q.type === "short" ? 4 : 3;
  reviewedToday.add(card.id);
  return {
    correctness,
    rating,
    points: graded.points,
    maxPoints: graded.maxPoints,
    activeMs: 24_000,
    referenceMs: card.isNew ? null : 30_000,
    dueAt: new Date(now + INTERVAL_DAYS[rating]! * D).toISOString(),
    solution: studentSolutionOf(q, graded.solution),
  };
});

// --- Teacher ---------------------------------------------------------------

/** evaluation id -> the cards it gave rise to. */
const evaluationCards = new Map<string, number>();

/**
 * What an evaluation gives the drill: one card per question and per student
 * who met it. The weekly series of `r3` carry no item nor attempt in the
 * mock; they count as five questions met by twelve students.
 */
const cardsOf = (e: MockEvaluation) =>
  (e.items.length || 5) * (e.rows.filter((r) => r.attemptId).length || 12);

/** Whether an evaluation's questions are cards yet: an exam at its release, an exercise at the hand-in. */
const feedsDrill = (e: MockEvaluation) =>
  toEvaluation(e).allowDrill && (e.state === "released" || (e.mode === "exercise" && e.rows.some((r) => r.state === "submitted")));

// The released exam of the classroom allows the drill, and has fed it; so has
// every exercise already handed in.
for (const e of evaluations) {
  if (e.mode === "exam" && e.state === "released") e.settings["allowDrill"] = true;
  if (roomOn(e.classroomId) && feedsDrill(e)) evaluationCards.set(e.id, cardsOf(e));
}

on("PUT", "/app/api/classrooms/:id/drill", (m, body): DrillClassroomSettings => {
  const room = roomOr404(m.groups!.id!);
  const enabled = body.enabled === true;
  let cardsCreated = 0;
  if (enabled) {
    room.drillEnabledAt ??= new Date().toISOString();
    // The backfill (ADR-041 §13, item 1): the past evaluations, nothing twice.
    for (const e of evaluations) {
      if (e.classroomId !== room.id || !feedsDrill(e) || evaluationCards.has(e.id)) continue;
      const n = cardsOf(e);
      evaluationCards.set(e.id, n);
      cardsCreated += n;
    }
  } else {
    room.drillEnabledAt = null;
  }
  return { enabled, enabledAt: room.drillEnabledAt ?? null, cardsCreated };
});

const evaluationDrill = (e: MockEvaluation): EvaluationDrill => ({
  allowDrill: toEvaluation(e).allowDrill,
  cards: evaluationCards.get(e.id) ?? 0,
});

on("GET", "/app/api/evaluations/:id/drill", (m) => evaluationDrill(evaluationOr404(m.groups!.id!)));

on("PUT", "/app/api/evaluations/:id/drill", (m, body): EvaluationDrill => {
  const e = evaluationOr404(m.groups!.id!);
  if (e.mode === "poll" || e.state === "released") {
    throw new MockError(409, "The drill setting no longer changes once the results are released");
  }
  e.settings["allowDrill"] = body.allowDrill === true;
  return evaluationDrill(e);
});

on("DELETE", "/app/api/evaluations/:id/drill/cards", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  const removed = evaluationCards.get(e.id) ?? 0;
  evaluationCards.delete(e.id);
  return { removed };
});
