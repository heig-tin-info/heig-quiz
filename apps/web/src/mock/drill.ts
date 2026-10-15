/**
 * 7. The drill (ADR-041, #317): the student's session, cards served and
 * reviewed, the opt-out per classroom, and the teacher's switches — the
 * classroom's drill and an evaluation's "Allow drill" with its cards — and
 * the teacher's view of a classroom's drill, and targeted revision by
 * concept (ADR-115, the end of this file).
 *
 * The cards are questions of section 2, served through their type's own
 * `toStudent` (`studentView`) and graded by the same `tryAnswer` the preview
 * uses, so the player and the review render what a real card would. The
 * rating and the next due date follow the correctness, as strategy A does
 * without a reference time (ADR-041 §4, §10 item 7).
 *
 * Scene flag `?reviewed=1`: today's drill is already done — the empty day,
 * "nothing to review today" with the next due date. `?empty=1` has no
 * classroom at all, so no drill. `?unstated=1`: no confidence stated yet
 * (ADR-085 §8) — no calibration for the student, and no question of `r1`
 * stated by enough students for the teacher's 2×2.
 */
import type {
  DrillCalibrationLevel,
  DrillCorrectness,
  DrillClassroom,
  DrillClassroomSettings,
  DrillHours,
  DrillProgress,
  DrillQuestionConfidence,
  DrillRecall,
  DrillReviewResult,
  DrillServed,
  DrillSession,
  DrillStudentActivity,
  DrillClassroomMastery,
  DrillWeek,
  ConceptRef,
  StudentConceptMastery,
  EvaluationDrill,
  DrillClassroomRevision,
  RevisionAnswerResult,
  RevisionRoundStart,
  RevisionServed,
  StudentConceptRef,
  StudentRevisionConcepts,
  StudentRevisionRound,
} from "@quiz/contracts";
import { RevisionAnswerBody, RevisionRoundBody } from "@quiz/contracts";
import {
  allowDrillWritable,
  DRILL_REVISION_ROUND_SIZE,
  DRILL_TYPES,
  drillWeekStarts,
  isWeekdayClassHour,
  localDate,
  offHoursShare,
  revisionNext,
  type RevisionAnswer,
} from "@quiz/domain";

import { conceptRefs, seedConceptIds } from "./concept";
import { evaluationOr404, evaluations, toEvaluation, type MockEvaluation } from "./evaluation";
import { courses, roomOr404, rooms } from "./org";
import { frozenConfig, questions, studentSolutionOf, studentView, tryAnswer, type MockQuestion } from "./pool";
import { D, flags, H, iso, MockError, now, on } from "./runtime";

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

/** The drill's types (`DRILL_TYPES`, ADR-041 §3), a published version each, in an interleaved order. */
const drillable = questions.filter(
  (q) => (DRILL_TYPES as readonly string[]).includes(q.type) && q.versions.length > 0 && q.deletedAt === null,
);
const pickOf = (type: string, n: number) => drillable.filter((q) => q.type === type).slice(0, n);
const picked = [...pickOf("mcq", 2), ...pickOf("short", 1), ...pickOf("cloze", 1), ...pickOf("blocks", 1), ...pickOf("categorize", 1)];

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

/** A card served, through its type's `toStudent`: the daily session's and a round's. */
const servedOf = (card: MockCard): DrillServed => ({
  cardId: card.id,
  type: card.question.type,
  student: studentView(card.question, frozenConfig(card.question)),
});

/** An answer graded as the preview grades it, its correctness, and the key through the student's view. */
const grade = (q: MockQuestion, answer: unknown) => {
  const graded = tryAnswer(q, frozenConfig(q), answer ?? null) as { points: number; maxPoints: number; solution: unknown };
  const correctness: DrillCorrectness =
    graded.points >= graded.maxPoints ? "right" : graded.points > 0 ? "partial" : "wrong";
  return {
    correctness,
    points: graded.points,
    maxPoints: graded.maxPoints,
    solution: studentSolutionOf(q, graded.solution),
  };
};

on("POST", "/app/api/drill/cards/:id/serve", (m): DrillServed => servedOf(cardOr404(m.groups!.id!)));

on("POST", "/app/api/drill/cards/:id/shown", (m) => {
  cardOr404(m.groups!.id!);
  return undefined;
});

/** Days to the next review, per rating: what FSRS gives a young card, roughly. */
const INTERVAL_DAYS: Record<number, number> = { 1: 1, 2: 2, 3: 4, 4: 9 };

on("POST", "/app/api/drill/cards/:id/answer", (m, body): DrillReviewResult => {
  const card = cardOr404(m.groups!.id!);
  const graded = grade(card.question, body.answer);
  const { correctness } = graded;
  // No reference time on a card this young: a right answer is Good, and a
  // short answer typed right is the one Easy, so the screen shows both.
  const rating = correctness === "wrong" ? 1 : correctness === "partial" ? 2 : card.question.type === "short" ? 4 : 3;
  reviewedToday.add(card.id);
  return {
    ...graded,
    rating,
    activeMs: 24_000,
    referenceMs: card.isNew ? null : 30_000,
    dueAt: new Date(now + INTERVAL_DAYS[rating]! * D).toISOString(),
  };
});

/**
 * The student's calibration (ADR-085 §8): roughly calibrated, a little
 * overconfident at Certain, and "No idea" stated too rarely for a rate.
 */
const CALIBRATION: DrillCalibrationLevel[] = [
  { confidence: 0, answers: 3, right: 1 },
  { confidence: 1, answers: 9, right: 4 },
  { confidence: 2, answers: 17, right: 11 },
  { confidence: 3, answers: 21, right: 13 },
  { confidence: 4, answers: 12, right: 9 },
];

on("GET", "/app/api/drill/calibration", (): DrillCalibrationLevel[] =>
  flags.unstated ? CALIBRATION.map((l) => ({ ...l, answers: 0, right: 0 })) : CALIBRATION,
);

/**
 * The student's own level on the course's concepts (ADR-098): a band each
 * way, a concept with four cards ("No data yet") and one with none. Only the
 * classrooms whose drill is on.
 */
on("GET", "/app/api/student/classrooms/:id/drill/mastery", (m): StudentConceptMastery => {
  const id = m.groups!.id!;
  if (!studentRoomIds().includes(id) || !roomOn(id)) return { declared: false, concepts: [] };
  const [pointer, allocation, array, loop, types, recursion] = conceptRefs(MASTERY_IDS);
  const row = (c: ConceptRef, level: StudentConceptMastery["concepts"][number]["level"], cards: number) => ({
    concept: { id: c.id, label: c.label, qualifier: c.qualifier },
    level,
    cards,
  });
  return {
    declared: true,
    concepts: [
      row(allocation!, "getting", 14),
      row(array!, "solid", 22),
      row(loop!, "solid", 9),
      row(pointer!, "work", 11),
      row(recursion!, null, 0),
      row(types!, null, 4),
    ],
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
  if (!allowDrillWritable(e.mode, e.state)) {
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

// --- Teacher's view (slice 4) ----------------------------------------------
//
// `r1` has fourteen weeks of practice behind it, whatever today's date: each
// claimed student at a level of engagement, most improving, two opted out
// along the way, the unclaimed seats never practised. `r2` has the drill on
// and nothing yet; every other classroom has it off.

const hasHistory = (roomId: string) => roomId === "r1";
/** Opted out: roster index -> days ago. */
const OPTED_OUT: Record<number, number> = { 3: 12, 9: 25 };

/** A stable pseudo-random number in [0, 1) for a (student, week) pair. */
const noise = (a: number, b: number) => {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** One student's weeks, with the days they practised in each (for sessions and "last activity"). */
function studentWeeks(roomId: string, index: number, claimed: boolean) {
  const today = localDate(new Date(now));
  const starts = drillWeekStarts(localDate(new Date(now - 13 * 7 * D)), today);
  const outDays = hasHistory(roomId) ? OPTED_OUT[index] : undefined;
  const level = [1, 0.7, 0.35, 0.9, 0.15, 0.6][index % 6]!;
  return starts.map((weekStart, w) => {
    const start = Date.parse(`${weekStart}T08:00:00Z`);
    const active = hasHistory(roomId) && claimed && start < now - (outDays ?? 0) * D;
    const days = active ? Math.round(level * 5 * (0.5 + noise(index, w))) : 0;
    const reviews = days * (6 + Math.round(4 * noise(w, index)));
    const repeated = w === 0 ? 0 : Math.round(reviews * 0.7);
    const trend = index % 4 === 2 ? 0.86 - 0.025 * w : 0.6 + 0.025 * w;
    const rate = Math.min(0.95, trend + 0.06 * (noise(index + w, 3) - 0.5));
    const week: DrillWeek = { weekStart, reviews, recall: { repeated, recalled: Math.round(repeated * rate) } };
    return { week, days, lastAt: days ? Math.min(now - H, start + (days - 1) * D + 10 * H) : null };
  });
}

const seatsOf = (roomId: string) =>
  roomOr404(roomId)
    .roster.filter((s) => !s.staff)
    .map((seat, index) => ({ seat, index, weeks: studentWeeks(roomId, index, seat.userId !== null) }));

const sumRecall = (ws: DrillWeek[]): DrillRecall => ({
  repeated: ws.reduce((a, w) => a + w.recall.repeated, 0),
  recalled: ws.reduce((a, w) => a + w.recall.recalled, 0),
});
const reviews = (ws: DrillWeek[]) => ws.reduce((a, w) => a + w.reviews, 0);

on("GET", "/app/api/classrooms/:id/drill/activity", (m): DrillStudentActivity[] =>
  seatsOf(m.groups!.id!).map(({ seat, index, weeks }) => {
    const ws = weeks.map((x) => x.week);
    const outDays = hasHistory(m.groups!.id!) ? OPTED_OUT[index] : undefined;
    const lastAt = weeks.filter((x) => x.lastAt !== null).at(-1)?.lastAt;
    return {
      enrollmentId: seat.id,
      nom: seat.nom,
      prenom: seat.prenom,
      questionsSeen: Math.min(60, Math.round(reviews(ws) * 0.5)),
      sessions: weeks.reduce((a, x) => a + x.days, 0),
      lastReviewAt: lastAt ? new Date(lastAt).toISOString() : null,
      reviews: { last30: reviews(ws.slice(-4)), all: reviews(ws) },
      recall: { last30: sumRecall(ws.slice(-4)), previous30: sumRecall(ws.slice(-8, -4)), all: sumRecall(ws) },
      optedOutAt: outDays === undefined ? null : iso(-outDays * D),
    };
  }),
);

on("GET", "/app/api/classrooms/:id/drill/progress", (m, _body, url): DrillProgress => {
  const found = seatsOf(m.groups!.id!).find((s) => s.seat.id === url.searchParams.get("student"));
  if (!found) throw new MockError(404, "Student not found");
  return { weeks: found.weeks.map((x) => x.week) };
});

/**
 * One student's reviews in a slot of the week over the last 30 days: each
 * has an hour they favour — in class, at lunch, in the evening, late at
 * night — and some practise at the weekend too.
 */
function slotReviews(index: number, weekday: number, hour: number): number {
  const level = [1, 0.7, 0.35, 0.9, 0.15, 0.6][index % 6]!;
  const peak = [10, 20, 13, 21, 15, 23][index % 6]!;
  const weekend = weekday >= 5 ? (index % 3 === 1 ? 1.2 : 0.3) : 1;
  const x = Math.exp(-((hour - peak) ** 2) / 5) * weekend * level * 5 * noise(index * 7 + weekday, hour);
  return x > 0.6 ? Math.round(x + 0.4) : 0;
}

/** The grid of the last 30 days: distinct students per slot, or one student's reviews (`?student=`). */
on("GET", "/app/api/classrooms/:id/drill/hours", (m, _body, url): DrillHours => {
  const seats = seatsOf(m.groups!.id!);
  const student = url.searchParams.get("student");
  const counted = student === null ? seats : seats.filter((s) => s.seat.id === student);
  if (student !== null && counted.length === 0) throw new MockError(404, "Student not found");
  const active = counted.filter((s) => reviews(s.weeks.slice(-4).map((x) => x.week)) > 0);
  const days = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => {
      const each = active.map((s) => slotReviews(s.index, d, h));
      return student === null ? each.filter((n) => n > 0).length : each.reduce((a, n) => a + n, 0);
    }),
  );
  return {
    since: localDate(new Date(now - 30 * D)),
    offHoursShare: offHoursShare(days, isWeekdayClassHour),
    days,
  };
});

/** The concepts of the C course, and the questions without one; weakest first. */
const MASTERY_IDS = seedConceptIds(["Pointeur", "Allocation dynamique", "Tableau", "Boucle", "Types", "Récursivité"]);
/**
 * The course lists five concepts, one of them (recursion) exercised by
 * nothing yet; a sixth thing practised, a question without a concept, falls
 * outside the list. Labelled when asked, in the reader's language.
 */
const mastery = (): DrillClassroomMastery => {
  const [pointer, allocation, array, loop, types, recursion] = conceptRefs(MASTERY_IDS);
  return {
    declared: true,
    concepts: [
      { concept: pointer!, cards: 40, students: 18, retrievability: 0.58 },
      { concept: allocation!, cards: 57, students: 17, retrievability: 0.66 },
      { concept: array!, cards: 74, students: 16, retrievability: 0.74 },
      { concept: loop!, cards: 91, students: 15, retrievability: 0.83 },
      { concept: types!, cards: 108, students: 14, retrievability: 0.88 },
      { concept: recursion!, cards: 0, students: 0, retrievability: null },
    ],
    outside: {
      cards: 25,
      students: 13,
      retrievability: 0.79,
      concepts: [{ concept: null, cards: 25, students: 13, retrievability: 0.79 }],
    },
  };
};

on("GET", "/app/api/classrooms/:id/drill/mastery", (m): DrillClassroomMastery =>
  hasHistory(roomOr404(m.groups!.id!).id) ? mastery() : { declared: false, concepts: [], outside: null },
);

/**
 * The 2×2 per question of `r1` (ADR-085 §8): only what passed the server's
 * ten-student threshold — a question that misleads, one that is simply
 * hard, and one the class knows.
 */
const CONFIDENCE_SPLITS: Omit<DrillQuestionConfidence, "questionId" | "name">[] = [
  { students: 17, split: { rightSure: 9, rightUnsure: 4, wrongSure: 14, wrongUnsure: 3 } },
  { students: 14, split: { rightSure: 6, rightUnsure: 7, wrongSure: 3, wrongUnsure: 9 } },
  { students: 12, split: { rightSure: 19, rightUnsure: 3, wrongSure: 0, wrongUnsure: 0 } },
];

on("GET", "/app/api/classrooms/:id/drill/confidence", (m): DrillQuestionConfidence[] =>
  hasHistory(roomOr404(m.groups!.id!).id) && !flags.unstated
    ? CONFIDENCE_SPLITS.map((row, i) => ({ ...row, questionId: picked[i]!.id, name: picked[i]!.internalName }))
    : [],
);

// --- Targeted revision (ADR-115) -------------------------------------------
//
// The student revises one concept of the course in rounds of their own
// cards. The mock's cards carry no concept: a round on any concept holds the
// classroom's cards, in the session's order. The rules of the round — a
// wrong first pass back three cards later, the counters — are `@quiz/domain`'s.
// `?reviseempty=1`: no card covers the concept; `?reviseoff=1`: revision is
// closed everywhere.

interface MockRound {
  id: string;
  classroomId: string;
  conceptId: string | null;
  cardIds: string[];
  startedAt: string;
  endedAt: string | null;
  answers: RevisionAnswer[];
}

/** The concepts on offer: the course's validated ones, by label — the mastery's list. */
const offered = (): StudentConceptRef[] =>
  conceptRefs(MASTERY_IDS)
    .map(({ id, label, qualifier }) => ({ id, label, qualifier }))
    .sort((a, b) => a.label.localeCompare(b.label));

const revisionOpen = (id: string) =>
  studentRoomIds().includes(id) && roomOn(id) && !optedOut.has(id) && !flags.reviseoff;

let roundSeq = 0;
const roundId = () => `eeeeeeee-0000-4000-9000-${String((roundSeq += 1)).padStart(12, "0")}`;

/** A round already behind the student in their first classroom. */
const pastRound = (conceptAt: number, daysAgo: number, results: RevisionAnswer["correctness"][]): MockRound => {
  const cardIds = cards.slice(0, results.length).map((c) => c.id);
  return {
    id: roundId(),
    classroomId: studentRoomIds()[0] ?? "r1",
    conceptId: MASTERY_IDS[conceptAt] ?? null,
    cardIds,
    startedAt: iso(-daysAgo * D),
    endedAt: iso(-daysAgo * D + 9 * 60_000),
    answers: cardIds.map((cardId, i) => ({ cardId, pass: 1 as const, correctness: results[i]! })),
  };
};
const revisionRounds: MockRound[] = [
  pastRound(0, 1, ["right", "wrong", "right", "right", "partial"]),
  pastRound(2, 6, ["right", "right", "wrong"]),
];

const openRoundOr404 = (id: string) => {
  const round = revisionRounds.find((r) => r.id === id && r.endedAt === null);
  if (!round) throw new MockError(404, "Round not found");
  return round;
};

/** The card's next pass in the round: 2 once its first is answered. */
const nextPass = (round: MockRound, cardId: string): 1 | 2 =>
  round.answers.some((a) => a.cardId === cardId && a.pass === 1) ? 2 : 1;

const mockCard = (id: string) => cards.find((c) => c.id === id)!;

on("GET", "/app/api/student/classrooms/:id/revision/concepts", (m): StudentRevisionConcepts =>
  revisionOpen(m.groups!.id!) ? { available: true, concepts: offered() } : { available: false, concepts: [] },
);

on("GET", "/app/api/student/classrooms/:id/revision/rounds", (m): StudentRevisionRound[] =>
  revisionRounds
    .filter((r) => r.classroomId === m.groups!.id! && r.answers.length > 0)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((r) => ({
      id: r.id,
      concept: offered().find((c) => c.id === r.conceptId) ?? null,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      // The two counters: the cards answered at their first pass, and those right.
      cardsServed: r.answers.filter((a) => a.pass === 1).length,
      cardsCorrect: r.answers.filter((a) => a.pass === 1 && a.correctness === "right").length,
    })),
);

on("POST", "/app/api/student/classrooms/:id/revision/rounds", (m, body): RevisionRoundStart => {
  // Strict, as the API's.
  const parsed = RevisionRoundBody.safeParse(body);
  if (!parsed.success) throw new MockError(400, parsed.error.message);
  const id = m.groups!.id!;
  const concept = offered().find((c) => c.id === parsed.data.conceptId);
  if (!revisionOpen(id) || !concept) throw new MockError(404, "Concept not found");
  const own = active()
    .filter((c) => c.classroomId === id)
    .slice(0, DRILL_REVISION_ROUND_SIZE);
  if (flags.reviseempty || own.length === 0) return { round: null };
  const round: MockRound = {
    id: roundId(),
    classroomId: id,
    conceptId: concept.id,
    cardIds: own.map((c) => c.id),
    startedAt: new Date().toISOString(),
    endedAt: null,
    answers: [],
  };
  revisionRounds.push(round);
  const course = courses.find((c) => c.id === roomOr404(id).courseId);
  return {
    round: {
      id: round.id,
      concept,
      startedAt: round.startedAt,
      cards: own.map((c) => ({
        id: c.id,
        type: c.question.type,
        courseCode: course?.code ?? "",
        courseName: course?.name ?? "",
        isNew: c.isNew,
      })),
    },
  };
});

on("POST", "/app/api/student/revision/rounds/:id/serve/:cardId", (m): RevisionServed => {
  const round = openRoundOr404(m.groups!.id!);
  const card = mockCard(m.groups!.cardId!);
  // ADR-115 §7: a card served in a round today leaves today's session.
  reviewedToday.add(card.id);
  return { ...servedOf(card), pass: nextPass(round, card.id) };
});

on("POST", "/app/api/student/revision/rounds/:id/cards/:cardId/answer", (m, body): RevisionAnswerResult => {
  // Strict, as the API's: a confidence or a device class is a 400.
  const parsed = RevisionAnswerBody.safeParse(body);
  if (!parsed.success) throw new MockError(400, parsed.error.message);
  const round = openRoundOr404(m.groups!.id!);
  const cardId = m.groups!.cardId!;
  const pass = nextPass(round, cardId);
  const graded = grade(mockCard(cardId).question, parsed.data.answer);
  round.answers.push({ cardId, pass, correctness: graded.correctness });
  if (revisionNext({ order: round.cardIds, answers: round.answers }) === null) round.endedAt = new Date().toISOString();
  return { ...graded, requeued: pass === 1 && graded.correctness === "wrong" };
});

/**
 * Who revised what in `r1`, for the staff: five students before the test,
 * the pointer most of all. Roster index -> [concept indexes of
 * `MASTERY_IDS`, rounds, days since the last, cards served, right].
 */
const REVISED: Record<number, [number[], number, number, number, number]> = {
  0: [[0, 1], 4, 1, 32, 25],
  1: [[0], 2, 2, 14, 9],
  2: [[0, 3], 3, 1, 21, 12],
  4: [[2], 1, 5, 6, 5],
  5: [[0, 1, 2], 5, 0, 41, 30],
};
/** The same rounds per concept: [concept index, students, rounds, days since the last]. */
const REVISED_CONCEPTS: [number, number, number, number][] = [
  [0, 4, 9, 0],
  [1, 2, 4, 0],
  [2, 2, 3, 0],
  [3, 1, 1, 1],
];

on("GET", "/app/api/classrooms/:id/drill/revision", (m): DrillClassroomRevision => {
  const roomId = roomOr404(m.groups!.id!).id;
  if (!hasHistory(roomId)) return { students: [], concepts: [] };
  const refs = conceptRefs(MASTERY_IDS);
  const students = seatsOf(roomId).flatMap(({ seat, index }) => {
    const r = REVISED[index];
    if (!r || seat.userId === null) return [];
    const [at, rounds, daysAgo, cardsServed, cardsCorrect] = r;
    return [{
      enrollmentId: seat.id,
      rounds,
      lastAt: iso(-daysAgo * D - 3 * H),
      cardsServed,
      cardsCorrect,
      concepts: at.map((i) => refs[i]!),
    }];
  });
  const concepts = REVISED_CONCEPTS.map(([at, students, rounds, daysAgo]) => ({
    concept: refs[at]!,
    students,
    rounds,
    lastAt: iso(-daysAgo * D - 3 * H),
  }));
  return { students, concepts };
});

on("POST", "/app/api/student/revision/rounds/:id/end", (m) => {
  const round = revisionRounds.find((r) => r.id === m.groups!.id!);
  if (!round) throw new MockError(404, "Round not found");
  round.endedAt ??= new Date().toISOString();
  return undefined;
});
