/** Section 6 of the mock — see `index.ts` for the layout. */
import {
  PollQuestionType,
  type ActivityStats,
  type ActivitySummary,
  type PollPoolPage,
  type PollPublicView,
  type PollQuestionPick,
} from "@quiz/contracts";
import {
  activityBucket,
  applyIdeaAction,
  brainstormBoard,
  pollOutcome,
  pollTally,
  type IdeaAction,
  type IdeaMark,
  type PollRunCounts,
} from "@quiz/domain";
import { hasKey } from "../poll/pollTally";
import {
  D,
  MockError,
  MockPayload,
  MockValidation,
  flags,
  iso,
  on,
  pick,
  rand,
} from "./runtime";
import { me, setMe } from "./session";
import {
  EVAL_ROOM,
  aliased,
  evaluations,
  findEvaluation,
  makeEvaluation,
  uuid,
} from "./evaluation";
import { courses, rooms } from "./org";
import { projectActivities } from "./project";
import {
  ME_MEMBER,
  MockQuestion,
  coursePools,
  draftIssues,
  emptyConfig,
  frozenConfig,
  makeQuestion,
  poolMembers,
  pools,
  questionDetail,
  questionOr404,
  questions,
  searchQuestions,
  solutionOf,
  studentSolutionOf,
  studentView,
} from "./pool";

// --- 5. The participant's poll page (/p/:CODE) -----------------------------
//
// The shapes that page has to draw, one code each. An anonymous poll belongs
// to no classroom; the others are a classroom's, for its roster only:
//
//   QZ4F7K  running, anonymous, mcq         the QR path — no account at all
//   NM2X9A  running, a classroom's, short   the login gate
//   CL5S9P  running, a classroom's, mcq     signed in but NOT on its roster:
//                                           the refusal (ADR-014, addendum
//                                           2026-09-27)
//   EN6D3D  ended and revealed, mcq         the key, after the fact
//   LG8C2M  running, anonymous, mcq         the projection's worst case: a
//                                           long statement and eight choices
//                                           of two lines, which is what the
//                                           beamer has to shrink to fit
//   AV3R8T  running, anonymous, mcq         an opinion poll: NO key, so the
//                                           reveal shows the distribution
//
// Two switches, read from the PAGE url at request time and not at import, so
// a screenshot flips one without reloading the module — and the running
// polls turn their key on under the three-second refetch, exactly as they do
// when the teacher presses "Reveal":
//
//   ?revealed=1  the key is out on the two running polls
//   ?votes=1     the distribution is on the wall of the running polls (#157)
//   ?as=guest    this browser has NO session. It is a persona like the other
//                three, so it nulls the session the WHOLE app reads: a
//                participant who scanned a QR in a lecture hall is signed
//                into nothing, and `/p/:CODE` is the one route that renders
//                before the session gate.

const pollFlag = (name: string): boolean => {
  const raw = new URLSearchParams(window.location.search).get(name);
  return raw !== null && raw !== "0" && raw !== "false";
};

if (new URLSearchParams(window.location.search).get("as") === "guest")
  setMe(null);

interface MockPoll {
  code: string;
  title: string;
  state: "running" | "ended";
  /** No classroom: anyone with the code answers. Otherwise a classroom's poll. */
  anonymous: boolean;
  /** A classroom's poll whose roster does NOT hold this browser's account. */
  offRoster?: boolean;
  /** The teacher pressed "Reveal" on this one for good. */
  revealed: boolean;
  /** The distribution is on the wall (#157); absent means hidden. */
  votes?: boolean;
  /** A brainstorm's moderation (ADR-071); absent means the audience's default. */
  moderation?: boolean;
  /** A brainstorm's AI assistance (ADR-072); absent means off. */
  ai?: boolean;
  type: PollQuestionType;
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
        {
          id: 0,
          text: "Elle reçoit une copie complète du tableau et peut le modifier sans que l'appelant en voie quoi que ce soit",
        },
        {
          id: 1,
          text: "Elle reçoit un pointeur sur le premier élément et modifie donc le tableau de l'appelant",
        },
        {
          id: 2,
          text: "Elle peut retrouver la taille du tableau avec `sizeof(tab) / sizeof(tab[0])`, comme dans l'appelant",
        },
        {
          id: 3,
          text: "Elle doit recevoir `n` parce que le tableau reçu a perdu sa taille en devenant un pointeur",
        },
        {
          id: 4,
          text: "Elle peut agrandir le tableau avec `realloc(tab, …)` tant que l'appelant ne s'en sert plus après",
        },
        {
          id: 5,
          text: "Elle ne peut écrire dans le tableau que si le paramètre est déclaré `const int tab[]`",
        },
        {
          id: 6,
          text: "Elle reçoit le tableau par valeur, sauf si l'appelant écrit explicitement `&tab` à l'appel",
        },
        {
          id: 7,
          text: "Elle peut renvoyer `tab` à l'appelant, qui obtiendra un pointeur sur une variable locale détruite",
        },
      ],
    },
    // Two of the eight are right, which is what makes the reveal worth a
    // screenshot: one fades, one gains the tick and the word.
    solution: { correct: [1, 3] },
    joined: false,
    answer: null,
  },
  {
    // An opinion poll (ADR-014, addendum 2026-09-23): nothing is right, so
    // the key is empty and only "Show votes" hands the phones the distribution.
    code: "AV3R8T",
    title: "Avis — rythme des laboratoires",
    state: "running",
    anonymous: true,
    revealed: false,
    type: "mcq",
    student: {
      prompt: "Le rythme des laboratoires vous convient-il ?",
      mode: "single",
      choices: [
        { id: 0, text: "Trop lent" },
        { id: 1, text: "Juste bien" },
        { id: 2, text: "Un peu rapide" },
        { id: 3, text: "Beaucoup trop rapide" },
      ],
    },
    solution: { correct: [] },
    joined: true,
    answer: { selected: [2] },
  },
  {
    code: "CL5S9P",
    title: "Révision — pointeurs",
    state: "running",
    anonymous: false,
    offRoster: true,
    revealed: false,
    type: "mcq",
    student: {
      prompt: "Que contient `p` après `int *p = &x;` ?",
      mode: "single",
      choices: [
        { id: 0, text: "L'adresse de `x`" },
        { id: 1, text: "La valeur de `x`" },
      ],
    },
    solution: { correct: [0] },
    joined: false,
    answer: null,
  },
  {
    // A brainstorm (issue #458, ADR-071): ideas as bubbles, moderated
    // because the room is anonymous. Its ideas are shown from the start so
    // the wall has a cloud to draw.
    code: "BR4N5T",
    title: "Brainstorm — le vivant",
    state: "running",
    anonymous: true,
    revealed: false,
    votes: true,
    type: "brainstorm",
    student: { prompt: "Qu'est-ce qui caractérise un être vivant ?", maxIdeas: 5 },
    solution: null,
    joined: true,
    answer: { ideas: ["il respire", "il grandit"] },
  },
];

/** The moderation switch: a brainstorm only, on by default for an anonymous one. */
function moderationOn(poll: MockPoll): boolean {
  return poll.type === "brainstorm" && (poll.moderation ?? poll.anonymous);
}

/**
 * A classroom's poll lets in its roster and its staff, signed in; anybody
 * else signed in is refused before reading anything, like the API does.
 */
function refuseOffRoster(poll: MockPoll): void {
  if (!poll.anonymous && poll.offRoster === true && me !== null) {
    throw new MockPayload(403, {
      error: "not_on_roster",
      message: "This poll is for the students of its classroom",
    });
  }
}

const pollOr404 = (code: string): MockPoll => {
  const poll = polls.find((p) => p.code === code.toUpperCase());
  if (!poll) throw new MockError(404, "No poll with this code");
  return poll;
};

/** The distribution switch (wall and phones), `?votes=1` turning it on for a running poll. */
function votesOn(poll: MockPoll): boolean {
  return poll.votes === true || (poll.state === "running" && pollFlag("votes"));
}

/**
 * The key switch, `?revealed=1` turning it on for a running poll that HAS a
 * key: the server never reveals an opinion poll (ADR-014, addendum 2026-09-29).
 */
function revealedOn(poll: MockPoll): boolean {
  return (
    (poll.revealed || (poll.state === "running" && pollFlag("revealed"))) &&
    hasKey(poll)
  );
}

function pollPublicView(poll: MockPoll): PollPublicView {
  const revealed = revealedOn(poll);
  const loginRequired = !poll.anonymous && me === null;
  return {
    code: poll.code,
    state: poll.state,
    settings: { anonymous: poll.anonymous, revealed, votes: votesOn(poll), moderation: moderationOn(poll), ai: poll.ai === true },
    question: { type: poll.type, student: poll.student },
    // Never before the teacher says so: the key is the one thing on this
    // payload a participant must not be able to read early (invariant 4).
    solution: revealed ? poll.solution : null,
    tally: votesOn(poll) ? publicTally(poll) : null,
    me: {
      identified: !loginRequired,
      loginRequired,
      joined: !loginRequired && poll.joined,
      answer: poll.answer,
    },
  };
}

/** The distribution a phone reads once revealed: its teacher poll's, when it has one. */
function publicTally(poll: MockPoll): PollPublicView["tally"] {
  const tp = teacherPolls.find((t) => t.code === poll.code);
  return tp
    ? { ...tallyOf(tp, poll), pending: 0 }
    : { joined: 0, answered: 0, choices: [], answers: [], ideas: [], pending: 0 };
}

on("GET", "/app/api/p/:code", (m) => {
  const poll = pollOr404(m.groups!.code!);
  refuseOffRoster(poll);
  return pollPublicView(poll);
});

on("POST", "/app/api/p/:code/join", (m) => {
  const poll = pollOr404(m.groups!.code!);
  refuseOffRoster(poll);
  if (!poll.anonymous && me === null)
    throw new MockError(401, "login_required");
  poll.joined = true;
  return pollPublicView(poll);
});

on("POST", "/app/api/p/:code/answer", (m, body) => {
  const poll = pollOr404(m.groups!.code!);
  if (poll.state === "ended") throw new MockError(410, "This poll has ended.");
  refuseOffRoster(poll);
  if (!poll.anonymous && me === null)
    throw new MockError(401, "login_required");
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
//   /evaluations/poll/poll        the running mcq
//   /evaluations/poll-short/poll  a running short answer
//   /evaluations/poll-ended/poll  one that is over
//   /evaluations/poll-long/poll   a long statement and eight choices: the
//                                 one the wall has to shrink to fit
//   /evaluations/poll-opinion/poll  an opinion poll, with no key at all
//
// The tally GROWS while you look at it: `POLL_TICK` moves it and the fake SSE
// stream pushes the WHOLE aggregate as a `poll.tally` frame, exactly as the
// server coalesces it. `?revealed=1` starts a running poll with the key
// already shown (the same flag the participant page reads).

const POLL_RUNNING = "00000000-0000-4000-9000-000000000001";
const POLL_SHORT = "00000000-0000-4000-9000-000000000002";
const POLL_ENDED = "00000000-0000-4000-9000-000000000003";
const POLL_LONG = "00000000-0000-4000-9000-000000000004";
const POLL_OPINION = "00000000-0000-4000-9000-000000000005";
const POLL_BRAINSTORM = "00000000-0000-4000-9000-000000000006";

/** How often the fake room answers, in ms. */
const POLL_TICK = 1200;

export interface MockTeacherPoll {
  /** The evaluation's id: what the projection is addressed by. */
  id: string;
  /** The session code, and therefore the row of `polls` this one is about. */
  code: string;
  /** Null for an anonymous poll, which belongs to no classroom. */
  classroomId: string | null;
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
  /** `brainstorm`: one payload per participant, and the teacher's marks. */
  ideas?: { payloads: { ideas: string[] }[]; marks: IdeaMark[] };
  /**
   * The pool question the poll runs; null for one written in the launcher
   * and not kept yet — "Keep this question" is what sets it.
   */
  questionId?: string | null;
  /** The unsaved question of an inline poll, attached as-is on "Keep". */
  unsaved?: MockQuestion;
}

export const teacherPolls: MockTeacherPoll[] = [];

/** The participant-side row a teacher poll is about. */
export const pollOfTeacher = (tp: MockTeacherPoll): MockPoll | null =>
  polls.find((p) => p.code === tp.code) ?? null;

/** `/evaluations/poll/poll` and friends: an alias per seeded poll, classroom or not. */
const pollAliases = new Map<string, string>();

/** The teacher poll a URL names: its id, its alias, or its evaluation's alias. */
export const findTeacherPoll = (key: string): MockTeacherPoll | null => {
  const id = pollAliases.get(key) ?? findEvaluation(key)?.id ?? key;
  return teacherPolls.find((p) => p.id === id) ?? null;
};

/**
 * The evaluation row a classroom's poll needs so it shows up in its
 * classroom's list (with the "Poll" badge that routes the row to the
 * projection). An anonymous poll belongs to no classroom and gets none: it is
 * in no list, like on the server. Its single item points at no pool question
 * on purpose: a poll's question may have been written for it and nothing on
 * the teacher's screens reads that item.
 */
function seedPollEvaluation(tp: MockTeacherPoll, alias: string): void {
  const poll = pollOfTeacher(tp);
  if (poll === null) return;
  pollAliases.set(alias, tp.id);
  if (tp.classroomId === null) return;
  const e = makeEvaluation(
    tp.classroomId,
    poll.title,
    poll.state === "ended" ? "closed" : "running",
    0,
    {
      id: tp.id,
      mode: "poll",
      createdAt: tp.createdAt,
      startedAt: tp.createdAt,
      durationS: null,
    },
  );
  e.rows = [];
  e.items = [
    {
      id: uuid(),
      position: 0,
      points: 1,
      milestone: false,
      bonus: false,
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

/** Where a seeded poll lives: nowhere when anonymous, the demo classroom otherwise. */
function homeOf(poll: MockPoll): string | null {
  return poll.anonymous ? null : EVAL_ROOM;
}

if (!flags.empty && polls.length >= 5) {
  teacherPolls.push(
    {
      id: POLL_RUNNING,
      code: polls[0]!.code,
      classroomId: homeOf(polls[0]!),
      createdAt: iso(-4 * 60_000),
      joined: 61,
      answered: 52,
      // A typical distribution: the key leads without winning.
      counts: [27, 14, 8, 3],
      texts: [],
      // Kept in the Polls pool after an earlier lecture.
      questionId:
        questions.find((q) => q.poolId === "p0" && q.type === "mcq")?.id ??
        null,
    },
    {
      id: POLL_SHORT,
      code: polls[1]!.code,
      classroomId: homeOf(polls[1]!),
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
      classroomId: homeOf(polls[2]!),
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
      classroomId: homeOf(polls[3]!),
      createdAt: iso(-1 * 60_000),
      joined: 57,
      answered: 49,
      counts: [6, 18, 4, 11, 2, 3, 2, 3],
      texts: [],
    },
    {
      id: POLL_OPINION,
      code: polls[4]!.code,
      classroomId: homeOf(polls[4]!),
      createdAt: iso(-3 * 60_000),
      joined: 44,
      answered: 39,
      counts: [3, 21, 11, 4],
      texts: [],
    },
  );
  seedPollEvaluation(teacherPolls[0]!, "poll");
  seedPollEvaluation(teacherPolls[1]!, "poll-short");
  seedPollEvaluation(teacherPolls[2]!, "poll-ended");
  seedPollEvaluation(teacherPolls[3]!, "poll-long");
  seedPollEvaluation(teacherPolls[4]!, "poll-opinion");
  const brainstorm = polls.find((p) => p.code === "BR4N5T");
  if (brainstorm) {
    const payloads = [
      ["il respire", "il grandit", "il se reproduit"],
      ["respiration", "croissance"],
      ["Il respire !", "il mange"],
      ["reproduction", "il a des cellules"],
      ["il se nourrit", "il respire"],
      ["il grandit", "il meurt"],
      ["cellules", "ADN"],
      ["il bouge"],
      ["mange", "respire"],
      ["c'est nul ce cours"],
      ["il se reproduit", "il évolue"],
      ["il réagit à son environnement"],
    ].map((ideas) => ({ ideas }));
    const approved = (key: string, mergedInto: string | null = null, label: string | null = null): IdeaMark => ({
      key,
      status: "approved",
      mergedInto,
      label,
      correction: null,
      source: "teacher",
    });
    teacherPolls.push({
      id: POLL_BRAINSTORM,
      code: brainstorm.code,
      classroomId: null,
      createdAt: iso(-90_000),
      joined: 15,
      answered: payloads.length,
      counts: [],
      texts: [],
      ideas: {
        payloads,
        marks: [
          approved("il respire", null, "Respiration"),
          approved("respiration", "il respire"),
          approved("respire", "il respire"),
          approved("il grandit", null, "Croissance"),
          approved("croissance", "il grandit"),
          approved("il se reproduit", null, "Reproduction"),
          approved("reproduction", "il se reproduit"),
          approved("il mange", null, "Nutrition"),
          approved("il se nourrit", "il mange"),
          approved("mange", "il mange"),
          approved("il a des cellules", null, "Cellules"),
          approved("cellules", "il a des cellules"),
          approved("il meurt"),
          approved("adn"),
          approved("il bouge"),
          { key: "c est nul ce cours", status: "hidden", mergedInto: null, label: null, correction: null, source: "teacher" },
        ],
      },
    });
    seedPollEvaluation(teacherPolls[teacherPolls.length - 1]!, "poll-brainstorm");
  }
}

const answeredOf = (tp: MockTeacherPoll): number => tp.answered;

export const tallyOf = (tp: MockTeacherPoll, poll: MockPoll) => {
  if (poll.type === "brainstorm") {
    // The real rule of `@quiz/domain`, so the mock wall is the API's.
    return pollTally({
      type: "brainstorm",
      choiceCount: 0,
      joined: tp.joined,
      payloads: tp.ideas?.payloads ?? [],
      marks: tp.ideas?.marks ?? [],
      moderation: moderationOn(poll),
    });
  }
  return {
    joined: tp.joined,
    answered: tp.answered,
    choices: tp.counts.map((count, index) => ({ index, count })),
    answers: tp.texts.map((a) => ({ ...a })),
    ideas: [],
    pending: 0,
  };
};

/** The teacher's board of a brainstorm (`GET …/poll/ideas`). */
function boardOf(tp: MockTeacherPoll) {
  const poll = pollOfTeacher(tp)!;
  if (poll.type !== "brainstorm") throw new MockPayload(422, { error: "poll_type", message: "Not a brainstorm" });
  const moderation = moderationOn(poll);
  return {
    moderation,
    // The mock has no model: the assistance is never offered, as without a key.
    ai: { available: false, on: poll.ai === true, error: null },
    ...brainstormBoard({ payloads: tp.ideas?.payloads ?? [], marks: tp.ideas?.marks ?? [], moderation }),
  };
}

on("GET", "/app/api/evaluations/:id/poll/ideas", (m) => boardOf(teacherPollOr404(m.groups!.id!)));

on("POST", "/app/api/evaluations/:id/poll/ideas", (m, body) => {
  const tp = teacherPollOr404(m.groups!.id!);
  boardOf(tp);
  const state = (tp.ideas ??= { payloads: [], marks: [] });
  const changed = applyIdeaAction(state.marks, body as unknown as IdeaAction);
  const byKey = new Map(state.marks.map((mk) => [mk.key, mk]));
  for (const mk of changed) byKey.set(mk.key, mk);
  state.marks = [...byKey.values()];
  return boardOf(tp);
});

/**
 * Where the poll is being held, in the two words the beamer prints.
 *
 * `PollTeacherView.evaluation` carries them, so the projection no longer
 * fetches the classroom just to write its context line; the mock has to hand
 * them over for the same reason the API does.
 */
function pollWhere(classroomId: string | null): {
  classroomName: string | null;
  courseName: string | null;
} {
  if (classroomId === null) return { classroomName: null, courseName: null };
  const room = rooms.find((r) => r.id === classroomId);
  const course = room ? courses.find((c) => c.id === room.courseId) : undefined;
  return { classroomName: room?.name ?? "—", courseName: course?.name ?? "—" };
}

/** The teacher's whole view: the same question the room has, plus the key. */
function pollTeacherView(tp: MockTeacherPoll) {
  const poll = pollOfTeacher(tp)!;
  // `?revealed=1` reveals every RUNNING keyed poll, on both halves at once.
  const revealed = revealedOn(poll);
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
    settings: { anonymous: poll.anonymous, revealed, votes: votesOn(poll), moderation: moderationOn(poll), ai: poll.ai === true },
    question: {
      id: tp.questionId ?? tp.id,
      type: poll.type,
      student: poll.student,
      solution: poll.solution,
      ...savedIn(tp),
    },
    tally: tallyOf(tp, poll),
  };
}

/** `saved` and `pool` of the teacher view: where "Keep this question" put it. */
function savedIn(tp: MockTeacherPoll): {
  saved: boolean;
  pool: { id: string; name: string } | null;
} {
  const q = tp.questionId
    ? questions.find((x) => x.id === tp.questionId)
    : undefined;
  const pool = q ? pools.find((p) => p.id === q.poolId) : undefined;
  return {
    saved: q !== undefined,
    pool: pool ? { id: pool.id, name: pool.name } : null,
  };
}

/** The teacher's personal pool, made on first use like `ensurePersonalPool`. */
function ensurePersonalPool() {
  let personal = pools.find((p) => p.isPersonal && p.ownerId === "u-me");
  if (!personal) {
    personal = {
      id: "p0",
      name: "Polls",
      icon: "message-circle-question",
      color: null,
      visibility: "private",
      ownerId: "u-me",
      isPersonal: true,
      createdAt: iso(0),
      updatedAt: iso(0),
    };
    pools.push(personal);
    poolMembers[personal.id] = [
      { ...ME_MEMBER, role: "owner", addedAt: iso(0) },
    ];
  }
  return personal;
}

/** A name free in the pool: the statement, then "… (2)", "… (3)". */
function keptName(poolId: string, name: string): string {
  const taken = (candidate: string) =>
    questions.some(
      (q) =>
        q.poolId === poolId &&
        q.deletedAt === null &&
        q.internalName.toLowerCase() === candidate.toLowerCase(),
    );
  for (let n = 1; n < 50; n += 1) {
    const candidate = n === 1 ? name : `${name} (${n})`;
    if (!taken(candidate)) return candidate;
  }
  return `${name} ${uuid().slice(0, 8)}`;
}

/**
 * The content of a seeded poll, which was never a mock question: rebuilt from
 * what the wall holds, the statement and the key.
 */
function configOfPoll(poll: MockPoll): Record<string, unknown> {
  const student = poll.student as Record<string, unknown>;
  if (poll.type === "mcq") {
    const correct = (poll.solution as { correct: number[] }).correct;
    return {
      configVersion: 2,
      prompt: student.prompt,
      mode: student.mode,
      choices: ((student.choices ?? []) as { text: string }[]).map((c, i) => ({
        text: c.text,
        correct: correct.includes(i),
      })),
    };
  }
  const expected = (poll.solution as { expected: string[] }).expected;
  return {
    configVersion: 2,
    prompt: student.prompt,
    matchers: expected.map((value) => ({ kind: "exact", value, points: 1 })),
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
  const found = findTeacherPoll(key);
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
  if (poll.type === "brainstorm") {
    const pool = ["il respire", "photosynthèse", "il grandit", "il a un métabolisme", "il se reproduit", "homéostasie"];
    tp.ideas?.payloads.push({ ideas: [pool[Math.floor(rand() * pool.length)]!] });
  } else if (poll.type === "mcq") {
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
 * Finished runs from before this page load, so "Recent polls" has a history
 * to draw its donuts from (issue #161). One row per past run, newest first
 * per question; `roster: null` is an anonymous run.
 */
interface MockPastRun {
  question: MockQuestion;
  daysAgo: number;
  answered: number;
  correct: number;
  roster: number | null;
}

/** Two questions written in the launcher and never kept: in no pool, and still listed. */
const unsavedPast: MockQuestion[] = [
  makeQuestion({
    poolId: "",
    type: "mcq",
    internalName: "Quelle boucle s'exécute toujours au moins une fois ?",
    categoryId: null,
    difficulty: 2,
    shuffleable: true,
    randomizable: false,
    tags: [],
    config: {
      prompt: "Quelle boucle s'exécute toujours au moins une fois ?",
      mode: "single",
      choices: [
        { text: "`for`", correct: false },
        { text: "`while`", correct: false },
        { text: "`do … while`", correct: true },
      ],
    },
    published: [{ number: 1, changeNote: "", daysAgo: 6 }],
  }),
  makeQuestion({
    poolId: "",
    type: "short",
    internalName: "Un mot pour résumer la séance ?",
    categoryId: null,
    difficulty: 1,
    shuffleable: true,
    randomizable: false,
    tags: [],
    config: { prompt: "Un mot pour résumer la séance ?", matchers: [] },
    published: [{ number: 1, changeNote: "", daysAgo: 1 }],
  }),
];

const pastRuns: MockPastRun[] = (() => {
  if (flags.empty) return [];
  const kept = questions.filter((q) => q.poolId === "p0");
  const [sizeofQ, bitsQ, paceQ] = kept;
  const [loopQ, wordQ] = unsavedPast;
  const roster =
    rooms.find((r) => r.id === EVAL_ROOM)?.roster.filter((s) => !s.staff)
      .length ?? 24;
  const runs: MockPastRun[] = [];
  // A classroom poll asked who answers: correct / incorrect / no answer.
  if (sizeofQ) {
    runs.push(
      { question: sizeofQ, daysAgo: 3, answered: 19, correct: 14, roster },
      { question: sizeofQ, daysAgo: 10, answered: 21, correct: 12, roster },
      { question: sizeofQ, daysAgo: 17, answered: 16, correct: 7, roster },
    );
  }
  // Anonymous: correct / incorrect only, nobody knows who stayed silent.
  if (loopQ) {
    runs.push(
      { question: loopQ, daysAgo: 1, answered: 47, correct: 29, roster: null },
      { question: loopQ, daysAgo: 6, answered: 38, correct: 17, roster: null },
    );
  }
  if (bitsQ)
    runs.push({
      question: bitsQ,
      daysAgo: 9,
      answered: 22,
      correct: 20,
      roster,
    });
  // Opinion polls: no key, "n answers".
  if (paceQ) {
    runs.push(
      { question: paceQ, daysAgo: 2, answered: 41, correct: 0, roster: null },
      { question: paceQ, daysAgo: 16, answered: 35, correct: 0, roster: null },
    );
  }
  if (wordQ)
    runs.push({
      question: wordQ,
      daysAgo: 0.1,
      answered: 12,
      correct: 0,
      roster: null,
    });
  return runs;
})();

const hasSolution = (q: MockQuestion): boolean => {
  const key = solutionOf(q) as { correct?: unknown[]; expected?: unknown[] };
  return (key.correct ?? key.expected ?? []).length > 0;
};

/**
 * "Recent polls" (issue #161): the questions of the polls the teacher
 * launched — the past history above plus whatever this session started —
 * one row per question, the most recent run first, each with the outcome
 * the API computes the same way (`pollOutcome` of `@quiz/domain`). Then the
 * never-run questions of the personal pool.
 */
on("GET", "/app/api/polls/questions", (): PollQuestionPick[] => {
  type Run = {
    question: MockQuestion;
    at: string;
    running: boolean;
    counts: PollRunCounts | null;
  };
  const runs: Run[] = pastRuns.map((r) => ({
    question: r.question,
    at: iso(-r.daysAgo * D),
    running: false,
    counts: {
      keyed: hasSolution(r.question),
      answered: r.answered,
      correct: r.correct,
      roster: r.roster,
    },
  }));
  for (const tp of teacherPolls) {
    const question =
      tp.unsaved ?? questions.find((q) => q.id === tp.questionId);
    const poll = pollOfTeacher(tp);
    if (!question || !poll) continue;
    const key = (solutionOf(question) as { correct?: number[] }).correct ?? [];
    const running = poll.state !== "ended";
    runs.push({
      question,
      at: tp.createdAt,
      running,
      counts: running
        ? null
        : {
            keyed: hasSolution(question),
            answered: tp.answered,
            correct: key.reduce((sum, i) => sum + (tp.counts[i] ?? 0), 0),
            roster: poll.anonymous
              ? null
              : (rooms
                  .find((r) => r.id === tp.classroomId)
                  ?.roster.filter((s) => !s.staff).length ?? 0),
          },
    });
  }
  runs.sort((a, b) => b.at.localeCompare(a.at));

  const rows = new Map<string, { question: MockQuestion; runs: Run[] }>();
  for (const run of runs) {
    const entry = rows.get(run.question.id) ?? {
      question: run.question,
      runs: [],
    };
    entry.runs.push(run);
    rows.set(run.question.id, entry);
  }
  const personal = pools.find((p) => p.isPersonal && p.ownerId === "u-me");
  for (const q of questions) {
    if (personal !== undefined && q.poolId === personal.id && !rows.has(q.id)) {
      rows.set(q.id, { question: q, runs: [] });
    }
  }
  return [...rows.values()]
    .filter(
      ({ question: q }) =>
        q.deletedAt === null &&
        q.versions.length > 0 &&
        PollQuestionType.safeParse(q.type).success,
    )
    .map(({ question: q, runs: its }) => ({
      id: q.id,
      type: q.type as PollQuestionType,
      internalName: q.internalName,
      prompt: String(frozenConfig(q).prompt ?? ""),
      lastUsedAt: its[0]?.at ?? null,
      useCount: its.length,
      saved: q.poolId !== "",
      outcome: pollOutcome(its.flatMap((r) => (r.counts ? [r.counts] : []))),
    }))
    .sort((a, b) => {
      if ((a.lastUsedAt === null) !== (b.lastUsedAt === null))
        return a.lastUsedAt === null ? 1 : -1;
      return (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "");
    });
});

/**
 * A new question in the teacher's PERSONAL pool, without the launcher ever
 * learning that pool's id (`PollQuestionCreate`). The pool is made on first
 * use, exactly as the route would ensure it server-side.
 */
on("POST", "/app/api/polls/questions", (_m, body) => {
  const personal = ensurePersonalPool();
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

/**
 * "From pools" (issue #162): the pool screen's search over every pool of
 * the mock — or, with `classroomId`, over the pools linked to its course —
 * restricted to the published, live `mcq` / `short` questions.
 */
on("GET", "/app/api/polls/pool-questions", (_m, _body, url): PollPoolPage => {
  const params = url.searchParams;
  const classroomId = params.get("classroomId");
  let poolIds = pools.map((p) => p.id);
  if (classroomId !== null) {
    const room = rooms.find((r) => r.id === classroomId);
    if (!room) throw new MockError(404, "Classroom not found");
    poolIds = coursePools[room.courseId] ?? [];
  }
  const scope = questions.filter(
    (q) =>
      poolIds.includes(q.poolId) &&
      q.deletedAt === null &&
      q.versions.length > 0 &&
      PollQuestionType.safeParse(q.type).success,
  );
  const matching = searchQuestions(scope, params);
  const limit = Number(params.get("limit") ?? 25);
  const cursor = params.get("cursor");
  const start = cursor ? matching.findIndex((x) => x.id === cursor) + 1 : 0;
  const page = matching.slice(start, start + limit);
  return {
    items: page.map((q) => ({
      id: q.id,
      type: q.type as PollQuestionType,
      internalName: q.internalName,
      prompt: String(frozenConfig(q).prompt ?? ""),
      pool: {
        id: q.poolId,
        name: pools.find((p) => p.id === q.poolId)?.name ?? "",
      },
      tags: q.tags,
      difficulty: q.difficulty,
      latestNumber: q.versions.at(-1)!.number,
    })),
    nextCursor: start + limit < matching.length ? page.at(-1)!.id : null,
    total: matching.length,
    tags: [...new Set(scope.flatMap((q) => q.tags))].sort(),
  };
});

on("GET", "/app/api/polls", () => teacherPolls.map(pollSummary));

/** Creates the evaluation AND starts it: there is no draft state for a poll. */
on("POST", "/app/api/polls", (_m, body) => {
  // A question never kept is in no pool: it is found through the polls that
  // ran it, as the API finds it (ADR-014, addendum 2026-09-27).
  const id = String(body.questionId);
  const unsaved =
    unsavedPast.find((q) => q.id === id) ??
    teacherPolls.find((tp) => tp.unsaved?.id === id)?.unsaved;
  return unsaved
    ? startPoll(unsaved, body, { unsaved: true })
    : startPoll(questionOr404(id), body);
});

/**
 * A poll on a question written in the launcher (`PollInlineCreate`): checked
 * the way a publication is, then run — and pushed into NO pool, exactly as
 * the API keeps it out of every one.
 */
on("POST", "/app/api/polls/inline", (_m, body) => {
  const type = String(body.type);
  if (type !== "mcq" && type !== "short") {
    throw new MockError(422, `a poll cannot run a "${type}" question`);
  }
  const config = (body.config ?? {}) as Record<string, unknown>;
  const q = makeQuestion({
    poolId: "",
    type,
    internalName: String(config.prompt ?? type).slice(0, 80),
    categoryId: null,
    difficulty: 2,
    shuffleable: true,
    randomizable: false,
    tags: [],
    config,
    published: [{ number: 1, changeNote: "", daysAgo: 0 }],
  });
  const issues = draftIssues(q, { keyOptional: true });
  if (issues.length > 0)
    throw new MockValidation("The question is incomplete", issues);
  return startPoll(q, body, { unsaved: true });
});

function startPoll(
  q: MockQuestion,
  body: Record<string, unknown>,
  options: { unsaved?: boolean } = {},
) {
  const config = frozenConfig(q);
  const code = `QZ${Math.floor(rand() * 9000 + 1000)}`;
  const choiceCount = ((config.choices ?? []) as unknown[]).length;
  // `PollAudience`: anyone with the code (no classroom), or one classroom.
  const audience = (body.audience ?? {}) as {
    kind?: string;
    classroomId?: string;
  };
  const classroomId =
    audience.kind === "classroom" ? String(audience.classroomId) : null;
  if (classroomId !== null && !rooms.some((r) => r.id === classroomId)) {
    throw new MockError(404, "Not found");
  }
  polls.push({
    code,
    title: q.internalName,
    state: "running",
    anonymous: classroomId === null,
    revealed: false,
    type: q.type === "short" || q.type === "brainstorm" ? q.type : "mcq",
    student: studentView(q, config),
    // The room's key, as the API serves it to the phones and the beamer (ADR-037).
    solution: studentSolutionOf(q, solutionOf(q)),
    joined: false,
    answer: null,
  });
  const tp: MockTeacherPoll = {
    id: uuid(),
    code,
    classroomId,
    createdAt: iso(0),
    joined: 0,
    answered: 0,
    counts: q.type === "mcq" ? new Array<number>(choiceCount).fill(0) : [],
    texts: [],
    ...(q.type === "brainstorm" ? { ideas: { payloads: [], marks: [] } } : {}),
    ...(options.unsaved
      ? { questionId: null, unsaved: q }
      : { questionId: q.id }),
  };
  teacherPolls.push(tp);
  seedPollEvaluation(tp, code);
  return pollTeacherView(tp);
}

on("GET", "/app/api/evaluations/:id/poll", (m) =>
  pollTeacherView(teacherPollOr404(m.groups!.id!)),
);

on("POST", "/app/api/evaluations/:id/poll/reveal", (m, body) => {
  const tp = teacherPollOr404(m.groups!.id!);
  const poll = pollOfTeacher(tp)!;
  // The two switches are independent; one omitted stays where it was
  // (ADR-014, addendum 2026-09-29).
  if (typeof body.revealed === "boolean") poll.revealed = body.revealed;
  if (typeof body.votes === "boolean") poll.votes = body.votes;
  if (typeof body.moderation === "boolean") poll.moderation = body.moderation;
  if (body.ai === true) throw new MockPayload(422, { error: "llm_unavailable", message: "no language model is configured" });
  if (body.ai === false) poll.ai = false;
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
  polls.push({
    ...previous,
    code,
    state: "running",
    revealed: false,
    votes: false,
    joined: false,
    answer: null,
  });
  const next: MockTeacherPoll = {
    id: uuid(),
    code,
    classroomId: tp.classroomId,
    createdAt: iso(0),
    joined: 0,
    answered: 0,
    counts: previous.type === "mcq" ? tp.counts.map(() => 0) : [],
    texts: [],
    ...(previous.type === "brainstorm" ? { ideas: { payloads: [], marks: [] } } : {}),
    questionId: tp.questionId ?? null,
    ...(tp.unsaved ? { unsaved: tp.unsaved } : {}),
  };
  teacherPolls.push(next);
  seedPollEvaluation(next, code);
  return pollTeacherView(next);
});

/**
 * "Keep this question" (ADR-014, addenda item 6): the poll's unsaved question
 * joins the personal pool, created on first use. Idempotent — a poll whose
 * question already sits in a pool answers its view unchanged.
 */
on("POST", "/app/api/evaluations/:id/poll/keep", (m) => {
  const tp = teacherPollOr404(m.groups!.id!);
  if (tp.questionId) return pollTeacherView(tp);
  const poll = pollOfTeacher(tp)!;
  const personal = ensurePersonalPool();
  const q =
    tp.unsaved ??
    makeQuestion({
      poolId: personal.id,
      type: poll.type,
      internalName: poll.title,
      categoryId: null,
      difficulty: 2,
      shuffleable: true,
      randomizable: false,
      tags: [],
      config: configOfPoll(poll),
      published: [{ number: 1, changeNote: "", daysAgo: 0 }],
    });
  q.poolId = personal.id;
  q.internalName = keptName(personal.id, q.internalName);
  q.updatedAt = iso(0);
  questions.push(q);
  // Every show of hands on the same question is now a show of hands on a
  // kept one.
  for (const other of teacherPolls) {
    if (
      other === tp ||
      (tp.unsaved !== undefined && other.unsaved === tp.unsaved)
    ) {
      other.questionId = q.id;
      delete other.unsaved;
    }
  }
  return pollTeacherView(tp);
});

// --- The Activities section (#190) ----------------------------------------
//
// Registered here, one file down from the evaluations it lists, because it
// also lists the teacher's ANONYMOUS polls, which only this file knows. The
// same scope as the server: every evaluation of a classroom that is not
// archived (the mock teacher sits on every course's staff), their own
// classroom-less polls, and the projects (`project.ts`, `?projects=1`).
// `updatedAt` is "a minute ago" for a session in the room, so the deploy
// guard's 12-hour rule keeps it live, as on the server.

const LIVE_STATES = new Set(["lobby", "running", "paused"]);

on("GET", "/app/api/activities", (): ActivitySummary[] => teacherActivities());

/** The server's rule: the class members of the classrooms holding an open activity, each once. */
on("GET", "/app/api/activities/stats", (): ActivityStats => {
  const open = new Set(
    teacherActivities()
      .filter((a) => activityBucket(a.state) === "open" && a.classroom !== null)
      .map((a) => a.classroom!.id),
  );
  const emails = rooms
    .filter((r) => open.has(r.id))
    .flatMap((r) => r.roster.filter((s) => !s.staff).map((s) => s.email));
  return { studentsInProgress: new Set(emails).size };
});

function teacherActivities(): ActivitySummary[] {
  const inClassrooms = evaluations.flatMap((e): ActivitySummary[] => {
    const room = rooms.find((r) => r.id === e.classroomId);
    if (!room || room.archivedAt !== null) return [];
    const course = courses.find((c) => c.id === room.courseId);
    return [
      {
        kind: "evaluation",
        id: e.id,
        title: e.title,
        mode: e.mode,
        state: e.state,
        classroom: {
          id: room.id,
          name: room.name,
          courseCode: course?.code ?? "",
        },
        takeHome: e.mode === "exercise" && e.settings.lobby === "skip",
        opensAt: e.opensAt,
        closesAt: e.closesAt,
        startedAt: e.startedAt,
        closedAt: e.closedAt,
        closedBy: e.closedAt === null ? null : e.closesAt !== null && e.closedAt >= e.closesAt ? "server" : "teacher",
        updatedAt: LIVE_STATES.has(e.state)
          ? iso(-60_000)
          : (e.closedAt ?? e.createdAt),
      },
    ];
  });
  const anonymous = teacherPolls.flatMap((tp): ActivitySummary[] => {
    const poll = pollOfTeacher(tp);
    if (tp.classroomId !== null || poll === null) return [];
    return [
      {
        kind: "evaluation",
        id: tp.id,
        title: poll.title,
        mode: "poll",
        state: poll.state === "ended" ? "closed" : "running",
        classroom: null,
        takeHome: false,
        opensAt: null,
        closesAt: null,
        startedAt: tp.createdAt,
        closedAt: poll.state === "ended" ? tp.createdAt : null,
        closedBy: poll.state === "ended" ? "teacher" : null,
        updatedAt: poll.state === "ended" ? tp.createdAt : iso(-60_000),
      },
    ];
  });
  return [...inClassrooms, ...anonymous, ...projectActivities()].sort((a, b) =>
    b.id.localeCompare(a.id),
  );
}
