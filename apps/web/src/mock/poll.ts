/** Section 6 of the mock — see `index.ts` for the layout. */
import type {
  PollPublicView,
} from "@quiz/contracts";
import {
  D,
  MockError,
  flags,
  iso,
  on,
  pick,
  rand,
} from "./runtime";
import {
  me,
  setMe,
} from "./session";
import {
  EVAL_ROOM,
  aliased,
  evaluations,
  findEvaluation,
  makeEvaluation,
  uuid,
} from "./evaluation";
import {
  courses,
  rooms,
} from "./org";
import {
  ME_MEMBER,
  MockQuestion,
  emptyConfig,
  frozenConfig,
  makeQuestion,
  poolMembers,
  pools,
  questionDetail,
  questionOr404,
  questions,
  solutionOf,
  studentView,
} from "./pool";

// --- 5. The participant's poll page (/p/:CODE) -----------------------------
//
// Three codes, the three shapes that page has to draw:
//
//   QZ4F7K  running, anonymous, mcq         the QR path — no account at all
//   NM2X9A  running, NOT anonymous, short   the login gate
//   EN6D3D  ended and revealed, mcq         the key, after the fact
//   LG8C2M  running, anonymous, mcq         the projection's worst case: a
//                                           long statement and eight choices
//                                           of two lines, which is what the
//                                           beamer has to shrink to fit
//
// Two switches, read from the PAGE url at request time and not at import, so
// a screenshot flips one without reloading the module — and the running
// polls turn their key on under the three-second refetch, exactly as they do
// when the teacher presses "Reveal":
//
//   ?revealed=1  the key is out on the two running polls
//   ?as=guest    this browser has NO session. It is a persona like the other
//                three, so it nulls the session the WHOLE app reads: a
//                participant who scanned a QR in a lecture hall is signed
//                into nothing, and `/p/:CODE` is the one route that renders
//                before the session gate.

const pollFlag = (name: string): boolean => {
  const raw = new URLSearchParams(window.location.search).get(name);
  return raw !== null && raw !== "0" && raw !== "false";
};

if (new URLSearchParams(window.location.search).get("as") === "guest") setMe(null);

interface MockPoll {
  code: string;
  title: string;
  state: "running" | "ended";
  anonymous: boolean;
  /** The teacher pressed "Reveal" on this one for good. */
  revealed: boolean;
  type: "mcq" | "short";
  student: unknown;
  solution: unknown;
  /** This browser's guest cookie, in memory: a join is what sets it. */
  joined: boolean;
  answer: unknown;
}

export const polls: MockPoll[] = [
  {
    code: "QZ4F7K",
    title: "Échauffement — types et tailles",
    state: "running",
    anonymous: true,
    revealed: false,
    type: "mcq",
    student: {
      prompt: "Que vaut `sizeof(char)` en C, quelle que soit l'architecture ?",
      mode: "single",
      choices: [
        { id: 0, text: "`1`" },
        { id: 1, text: "`2`" },
        { id: 2, text: "`4`" },
        { id: 3, text: "Cela dépend de l'architecture" },
      ],
    },
    solution: { correct: [0] },
    joined: false,
    answer: null,
  },
  {
    code: "NM2X9A",
    title: "Contrôle éclair — complexité",
    state: "running",
    anonymous: false,
    revealed: false,
    type: "short",
    student: {
      prompt:
        "En notation grand-O, quelle est la complexité d'une recherche dichotomique dans un tableau trié de `n` éléments ?",
      kind: "text",
      constraints: { minLength: 0, maxLength: 60, integer: false },
      placeholder: "O(…)",
    },
    solution: { expected: ["O(log n)", "log n"] },
    joined: false,
    answer: null,
  },
  {
    code: "EN6D3D",
    title: "Révision — entiers signés",
    state: "ended",
    anonymous: true,
    revealed: true,
    type: "mcq",
    student: {
      prompt: "Quels types entiers sont **garantis signés** par la norme C ?",
      mode: "multiple",
      choices: [
        { id: 0, text: "`int`" },
        { id: 1, text: "`char`" },
        { id: 2, text: "`short`" },
        { id: 3, text: "`unsigned int`" },
      ],
    },
    solution: { correct: [0, 2] },
    joined: true,
    // One right, one wrong, one missed: the three marks of the reveal in one
    // screen.
    answer: { selected: [0, 1] },
  },
  {
    // The poll that made the projection scroll: a statement of three lines
    // and the twelve-choice ceiling all but reached, each choice long enough
    // to wrap. Nothing here may be truncated, so the wall shrinks instead —
    // see `fitScale` in `apps/web/src/poll/fit.ts`.
    code: "LG8C2M",
    title: "Révision — passage de paramètres",
    state: "running",
    anonymous: true,
    revealed: false,
    type: "mcq",
    student: {
      prompt:
        "Dans une fonction C qui reçoit `int tab[]` et `size_t n`, quelle affirmation décrit **correctement** ce que la fonction peut faire du tableau reçu ?",
      mode: "single",
      choices: [
        { id: 0, text: "Elle reçoit une copie complète du tableau et peut le modifier sans que l'appelant en voie quoi que ce soit" },
        { id: 1, text: "Elle reçoit un pointeur sur le premier élément et modifie donc le tableau de l'appelant" },
        { id: 2, text: "Elle peut retrouver la taille du tableau avec `sizeof(tab) / sizeof(tab[0])`, comme dans l'appelant" },
        { id: 3, text: "Elle doit recevoir `n` parce que le tableau reçu a perdu sa taille en devenant un pointeur" },
        { id: 4, text: "Elle peut agrandir le tableau avec `realloc(tab, …)` tant que l'appelant ne s'en sert plus après" },
        { id: 5, text: "Elle ne peut écrire dans le tableau que si le paramètre est déclaré `const int tab[]`" },
        { id: 6, text: "Elle reçoit le tableau par valeur, sauf si l'appelant écrit explicitement `&tab` à l'appel" },
        { id: 7, text: "Elle peut renvoyer `tab` à l'appelant, qui obtiendra un pointeur sur une variable locale détruite" },
      ],
    },
    // Two of the eight are right, which is what makes the reveal worth a
    // screenshot: one fades, one gains the tick and the word.
    solution: { correct: [1, 3] },
    joined: false,
    answer: null,
  },
];

const pollOr404 = (code: string): MockPoll => {
  const poll = polls.find((p) => p.code === code.toUpperCase());
  if (!poll) throw new MockError(404, "No poll with this code");
  return poll;
};

function pollPublicView(poll: MockPoll): PollPublicView {
  const revealed = poll.revealed || (poll.state === "running" && pollFlag("revealed"));
  const loginRequired = !poll.anonymous && me === null;
  return {
    code: poll.code,
    title: poll.title,
    state: poll.state,
    settings: { anonymous: poll.anonymous, revealed },
    question: { type: poll.type, student: poll.student },
    // Never before the teacher says so: the key is the one thing on this
    // payload a participant must not be able to read early (invariant 4).
    solution: revealed ? poll.solution : null,
    me: {
      identified: !loginRequired,
      loginRequired,
      joined: !loginRequired && poll.joined,
      answer: poll.answer,
    },
  };
}

on("GET", "/app/api/p/:code", (m) => pollPublicView(pollOr404(m.groups!.code!)));

on("POST", "/app/api/p/:code/join", (m) => {
  const poll = pollOr404(m.groups!.code!);
  if (!poll.anonymous && me === null) throw new MockError(401, "login_required");
  poll.joined = true;
  return pollPublicView(poll);
});

on("POST", "/app/api/p/:code/answer", (m, body) => {
  const poll = pollOr404(m.groups!.code!);
  if (poll.state === "ended") throw new MockError(410, "This poll has ended.");
  if (!poll.anonymous && me === null) throw new MockError(401, "login_required");
  poll.joined = true;
  poll.answer = body.payload ?? null;
  return pollPublicView(poll);
});

// --- The teacher's half of a poll (F-LIVE-13 / F-LIVE-14) ------------------
//
// A poll IS an evaluation of mode `poll` with ONE item
// (`packages/contracts/src/poll.ts`), so the projection reads it through
// `/app/api/evaluations/:id/poll` and the participants through `/p/:CODE`.
// The two halves share the `polls` table above: revealing from the beamer is
// what a phone in the room sees a second later, and "Run again" mints a new
// code that the same participant page answers. Only what the TEACHER can see
// lives here — the aggregate, the classroom, the session code.
//
// Three fixed uuids, and the alias table of section 3, so both a screenshot
// script and a curious developer can type the URL:
//   /evaluations/poll/poll        the running mcq (mockup 10)
//   /evaluations/poll-short/poll  a running short answer
//   /evaluations/poll-ended/poll  one that is over
//   /evaluations/poll-long/poll   a long statement and eight choices: the
//                                 one the wall has to shrink to fit
//
// The tally GROWS while you look at it: `POLL_TICK` moves it and the fake SSE
// stream pushes the WHOLE aggregate as a `poll.tally` frame, exactly as the
// server coalesces it. `?revealed=1` starts a running poll with the key
// already shown (the same flag the participant page reads).

const POLL_RUNNING = "00000000-0000-4000-9000-000000000001";
const POLL_SHORT = "00000000-0000-4000-9000-000000000002";
const POLL_ENDED = "00000000-0000-4000-9000-000000000003";
const POLL_LONG = "00000000-0000-4000-9000-000000000004";

/** How often the fake room answers, in ms. */
const POLL_TICK = 1200;

export interface MockTeacherPoll {
  /** The evaluation's id: what the projection is addressed by. */
  id: string;
  /** The session code, and therefore the row of `polls` this one is about. */
  code: string;
  classroomId: string;
  createdAt: string;
  /** Attempts opened, accounts and guests together. */
  joined: number;
  /**
   * Attempts holding an answer. Stored rather than derived: a `multiple` mcq
   * counts more VOTES than voters, and a projection told there were 44
   * answers from 26 people draws a ring at 169 %.
   */
  answered: number;
  /** `mcq`: one entry per CANONICAL choice index, including the unpicked. */
  counts: number[];
  /** `short`: the spellings seen, first one kept, most frequent first. */
  texts: { text: string; count: number }[];
}

export const teacherPolls: MockTeacherPoll[] = [];

/** The participant-side row a teacher poll is about. */
export const pollOfTeacher = (tp: MockTeacherPoll): MockPoll | null =>
  polls.find((p) => p.code === tp.code) ?? null;

/**
 * The evaluation row a poll needs so it shows up in its classroom's list
 * (with the "Poll" badge that routes the row to the projection). Its single
 * item points at no pool question on purpose: a poll's question may have been
 * written for it and nothing on the teacher's screens reads that item.
 */
function seedPollEvaluation(tp: MockTeacherPoll, alias: string): void {
  const poll = pollOfTeacher(tp);
  if (poll === null) return;
  const e = makeEvaluation(tp.classroomId, poll.title, poll.state === "ended" ? "closed" : "running", 0, {
    id: tp.id,
    mode: "poll",
    createdAt: tp.createdAt,
    startedAt: tp.createdAt,
    durationS: null,
  });
  e.rows = [];
  e.items = [
    {
      id: uuid(),
      position: 1,
      points: 1,
      milestone: false,
      questionId: uuid(),
      questionVersionId: uuid(),
      type: poll.type,
      internalName: poll.code.toLowerCase(),
      versionNumber: 1,
      latestVersionNumber: 1,
      deprecated: false,
    },
  ];
  evaluations.push(e);
  aliased.set(alias, tp.id);
}

if (!flags.empty && polls.length >= 4) {
  teacherPolls.push(
    {
      id: POLL_RUNNING,
      code: polls[0]!.code,
      classroomId: EVAL_ROOM,
      createdAt: iso(-4 * 60_000),
      joined: 61,
      answered: 52,
      // The distribution of mockup 10: the key leads without winning.
      counts: [27, 14, 8, 3],
      texts: [],
    },
    {
      id: POLL_SHORT,
      code: polls[1]!.code,
      classroomId: EVAL_ROOM,
      createdAt: iso(-2 * 60_000),
      joined: 48,
      answered: 40,
      counts: [],
      texts: [
        { text: "O(log n)", count: 23 },
        { text: "O(n)", count: 9 },
        { text: "O(1)", count: 5 },
        { text: "O(n log n)", count: 3 },
      ],
    },
    {
      id: POLL_ENDED,
      code: polls[2]!.code,
      classroomId: EVAL_ROOM,
      createdAt: iso(-40 * 60_000),
      joined: 26,
      // A `multiple` question: 44 votes from 24 voters.
      answered: 24,
      counts: [19, 7, 14, 4],
      texts: [],
    },
    {
      // Eight bars under a three-line question: the projection's worst case,
      // and the one a screenshot at 1280 x 720 has to come back from without
      // a scrollbar.
      id: POLL_LONG,
      code: polls[3]!.code,
      classroomId: EVAL_ROOM,
      createdAt: iso(-1 * 60_000),
      joined: 57,
      answered: 49,
      counts: [6, 18, 4, 11, 2, 3, 2, 3],
      texts: [],
    },
  );
  seedPollEvaluation(teacherPolls[0]!, "poll");
  seedPollEvaluation(teacherPolls[1]!, "poll-short");
  seedPollEvaluation(teacherPolls[2]!, "poll-ended");
  seedPollEvaluation(teacherPolls[3]!, "poll-long");
}

const answeredOf = (tp: MockTeacherPoll): number => tp.answered;

export const tallyOf = (tp: MockTeacherPoll, _poll: MockPoll) => ({
  joined: tp.joined,
  answered: tp.answered,
  choices: tp.counts.map((count, index) => ({ index, count })),
  answers: tp.texts.map((a) => ({ ...a })),
});

/**
 * Where the poll is being held, in the two words the beamer prints.
 *
 * `PollTeacherView.evaluation` carries them, so the projection no longer
 * fetches the classroom just to write its context line; the mock has to hand
 * them over for the same reason the API does.
 */
function pollWhere(classroomId: string): { classroomName: string; courseName: string } {
  const room = rooms.find((r) => r.id === classroomId);
  const course = room ? courses.find((c) => c.id === room.courseId) : undefined;
  return { classroomName: room?.name ?? "—", courseName: course?.name ?? "—" };
}

/** The teacher's whole view: the same question the room has, plus the key. */
function pollTeacherView(tp: MockTeacherPoll) {
  const poll = pollOfTeacher(tp)!;
  // `?revealed=1` reveals every RUNNING poll, on both halves at once.
  const revealed = poll.revealed || (poll.state === "running" && pollFlag("revealed"));
  return {
    evaluation: {
      id: tp.id,
      classroomId: tp.classroomId,
      ...pollWhere(tp.classroomId),
      title: poll.title,
      state: poll.state === "ended" ? "closed" : "running",
      code: poll.code,
      createdAt: tp.createdAt,
    },
    joinUrl: `${window.location.origin}/p/${poll.code}`,
    settings: { anonymous: poll.anonymous, revealed },
    question: { id: uuid(), type: poll.type, student: poll.student, solution: poll.solution },
    tally: tallyOf(tp, poll),
  };
}

const pollSummary = (tp: MockTeacherPoll) => {
  const poll = pollOfTeacher(tp)!;
  return {
    id: tp.id,
    classroomId: tp.classroomId,
    title: poll.title,
    state: poll.state === "ended" ? "closed" : "running",
    code: poll.code,
    questionId: tp.id,
    questionType: poll.type,
    answered: answeredOf(tp),
    createdAt: tp.createdAt,
  };
};

const teacherPollOr404 = (key: string): MockTeacherPoll => {
  const evaluation = findEvaluation(key);
  const found = teacherPolls.find((p) => p.id === (evaluation?.id ?? key));
  if (!found) throw new MockError(404, "Poll not found");
  return found;
};

/**
 * A room answering. One tick is one participant: mostly the key, sometimes
 * not, and a latecomer joining now and then — which is what keeps the ring
 * short of 100 % while the bars climb.
 */
function advancePoll(tp: MockTeacherPoll): void {
  const poll = pollOfTeacher(tp);
  if (poll === null || poll.state !== "running") return;
  if (tp.answered >= tp.joined) {
    tp.joined += 1;
    return;
  }
  tp.answered += 1;
  if (poll.type === "mcq") {
    const key = (poll.solution as { correct: number[] }).correct;
    const pickKey = rand() < 0.55 && key.length > 0;
    const index = pickKey
      ? key[Math.floor(rand() * key.length)]!
      : Math.floor(rand() * Math.max(1, tp.counts.length));
    tp.counts[index] = (tp.counts[index] ?? 0) + 1;
  } else {
    const weights = tp.texts.map((_, i) => (i === 0 ? 4 : 1));
    const total = weights.reduce((s, w) => s + w, 0);
    let ticket = rand() * total;
    let index = 0;
    for (let i = 0; i < weights.length; i += 1) {
      ticket -= weights[i]!;
      if (ticket <= 0) {
        index = i;
        break;
      }
    }
    const entry = tp.texts[index];
    if (entry) entry.count += 1;
    tp.texts.sort((a, b) => b.count - a.count);
  }
  if (rand() < 0.25) tp.joined += 1;
}

setInterval(() => {
  for (const tp of teacherPolls) advancePoll(tp);
}, POLL_TICK);

// --- The teacher's poll endpoints ---

/**
 * The questions a poll may run: the published `mcq` and `short` ones, most
 * recently USED first and then most recently edited — which is why a
 * question a teacher just wrote and has never polled is at the top of the
 * launcher when they come back from the editor.
 */
on("GET", "/app/api/polls/questions", () => {
  const pollable = questions.filter(
    (q) => q.deletedAt === null && q.versions.length > 0 && (q.type === "mcq" || q.type === "short"),
  );
  return pollable
    .map((q, i) => {
      const config = frozenConfig(q);
      // A deterministic history: two have been polled, the rest never.
      const used = i === 0 ? 4 : i === 1 ? 1 : 0;
      return {
        id: q.id,
        type: q.type as "mcq" | "short",
        internalName: q.internalName,
        prompt: String(config.prompt ?? ""),
        lastUsedAt: used === 0 ? null : iso(i === 0 ? -3 * D : -12 * D),
        useCount: used,
        updatedAt: q.updatedAt,
      };
    })
    .sort((a, b) =>
      (b.lastUsedAt ?? b.updatedAt).localeCompare(a.lastUsedAt ?? a.updatedAt),
    )
    .map(({ updatedAt: _updatedAt, ...pick }) => pick);
});

/**
 * A new question in the teacher's PERSONAL pool, without the launcher ever
 * learning that pool's id (`PollQuestionCreate`). The pool is made on first
 * use, exactly as the route would ensure it server-side.
 */
on("POST", "/app/api/polls/questions", (_m, body) => {
  let personal = pools.find((p) => p.isPersonal && p.ownerId === "u-me");
  if (!personal) {
    personal = {
      id: "p0",
      name: "Mes questions",
      icon: "user",
      visibility: "private",
      ownerId: "u-me",
      isPersonal: true,
      createdAt: iso(0),
      updatedAt: iso(0),
    };
    pools.push(personal);
    poolMembers[personal.id] = [{ ...ME_MEMBER, role: "owner", addedAt: iso(0) }];
  }
  const type = String(body.type) as MockQuestion["type"];
  const created = makeQuestion({
    poolId: personal.id,
    type,
    internalName: String(body.internalName),
    categoryId: null,
    difficulty: 3,
    shuffleable: true,
    randomizable: false,
    tags: [],
    config: emptyConfig(type),
  });
  created.updatedAt = iso(0);
  questions.push(created);
  return questionDetail(created);
});

on("GET", "/app/api/polls", () => teacherPolls.map(pollSummary));

/** Creates the evaluation AND starts it: there is no draft state for a poll. */
on("POST", "/app/api/polls", (_m, body) => {
  const q = questionOr404(String(body.questionId));
  const config = frozenConfig(q);
  const code = `QZ${Math.floor(rand() * 9000 + 1000)}`;
  const choiceCount = ((config.choices ?? []) as unknown[]).length;
  polls.push({
    code,
    title: q.internalName,
    state: "running",
    anonymous: body.anonymous === true,
    revealed: false,
    type: q.type === "short" ? "short" : "mcq",
    student: studentView(q, config),
    solution: solutionOf(q),
    joined: false,
    answer: null,
  });
  const tp: MockTeacherPoll = {
    id: uuid(),
    code,
    classroomId: String(body.classroomId ?? EVAL_ROOM),
    createdAt: iso(0),
    joined: 0,
    answered: 0,
    counts: q.type === "short" ? [] : new Array<number>(choiceCount).fill(0),
    texts: [],
  };
  teacherPolls.push(tp);
  seedPollEvaluation(tp, code);
  return pollTeacherView(tp);
});

on("GET", "/app/api/evaluations/:id/poll", (m) => pollTeacherView(teacherPollOr404(m.groups!.id!)));

on("POST", "/app/api/evaluations/:id/poll/reveal", (m, body) => {
  const tp = teacherPollOr404(m.groups!.id!);
  pollOfTeacher(tp)!.revealed = body.revealed === true;
  return pollTeacherView(tp);
});

on("POST", "/app/api/evaluations/:id/poll/end", (m) => {
  const tp = teacherPollOr404(m.groups!.id!);
  pollOfTeacher(tp)!.state = "ended";
  const e = findEvaluation(tp.id);
  if (e) e.state = "closed";
  return pollTeacherView(tp);
});

/** The same question, a new code, an empty tally: a second show of hands. */
on("POST", "/app/api/evaluations/:id/poll/again", (m) => {
  const tp = teacherPollOr404(m.groups!.id!);
  const previous = pollOfTeacher(tp)!;
  const code = `QZ${Math.floor(rand() * 9000 + 1000)}`;
  polls.push({ ...previous, code, state: "running", revealed: false, joined: false, answer: null });
  const next: MockTeacherPoll = {
    id: uuid(),
    code,
    classroomId: tp.classroomId,
    createdAt: iso(0),
    joined: 0,
    answered: 0,
    counts: previous.type === "mcq" ? tp.counts.map(() => 0) : [],
    texts: [],
  };
  teacherPolls.push(next);
  seedPollEvaluation(next, code);
  return pollTeacherView(next);
});

