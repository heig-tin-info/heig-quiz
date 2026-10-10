/**
 * Live polls (F-LIVE-13 / F-LIVE-14 / F-AUTH-05): ONE question, run in the
 * open with a session code and a QR, answered by anyone who joins — an
 * account, or a guest when the poll is anonymous — with the tally on the
 * teacher's projection as it grows. A classroom's poll is answered by its
 * roster and its staff only (`PollAudience`).
 *
 * A poll IS an evaluation of mode `poll` (docs/spec/05, `evaluations.mode`),
 * with one item, started the moment it is created, and its settings carry
 * the two poll switches under `settings.poll`. Everything below the create
 * call therefore reuses the attempt, answer and event machinery of `live`;
 * only the participant identity (guest or account, never a roster seat)
 * and the aggregate are new.
 */
import { z } from "zod";

import { IDEA_STATUSES, POLL_TYPES } from "@quiz/domain";

import { pageOf } from "./common.js";
import { ConceptRef } from "./concept.js";
import { LLM_ERROR_CODES } from "./llm.js";
import { QuestionSearch, QuestionTypeId } from "./pool.js";

/** The question types a poll may run: `brainstorm` runs nowhere else (ADR-071). */
export const PollQuestionType = z.enum(POLL_TYPES);
export type PollQuestionType = z.infer<typeof PollQuestionType>;

/**
 * Who a poll is for (ADR-014, addendum 2026-09-27) — ONE choice, where the
 * launcher used to ask two questions (a classroom, and "anonymous"):
 *
 *   - `anonymous`: anyone with the code. The poll belongs to NO classroom;
 *     a guest answers through the `quiz_guest` cookie, a signed-in browser
 *     as its account, and nobody is named. The teacher who launched it owns
 *     it and is the only one (with the admins) who reaches it.
 *   - `classroom`: the students of that classroom — its roster — and its
 *     staff, signed in. Nobody else gets in, whatever code they hold.
 *
 * "A classroom, anonymously" does not exist: it was the combination that
 * named nobody and still claimed a class.
 */
export const PollAudience = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anonymous") }),
  z.object({ kind: z.literal("classroom"), classroomId: z.uuid() }),
]);
export type PollAudience = z.infer<typeof PollAudience>;

/**
 * What the views carry under `settings`. `anonymous` is DERIVED from the
 * audience — true exactly when the poll has no classroom — and never stored:
 * `EvaluationSettings.poll` keeps `revealed` only, so the two can never
 * disagree.
 */
export const PollSettings = z.object({
  /** No classroom: anyone with the code may answer, without an account. */
  anonymous: z.boolean(),
  /**
   * "Reveal the answer": the key is shown — on the wall and on every phone.
   * An independent, reversible switch (ADR-014, addendum 2026-09-29): it
   * never closes the vote (only End does) and never implies `votes`. A poll
   * without a key refuses it, and reads as `false` here: a row stored `true`
   * before that addendum reads as `votes` instead (the server normalises it).
   */
  revealed: z.boolean().default(false),
  /**
   * "Show votes": the distribution is shown — on the wall AND on the phones
   * (addendum 2026-09-29; the wall only, before it). Off by default: a room
   * that reads the bars while it votes votes like the longest one.
   */
  votes: z.boolean().default(false),
  /**
   * A brainstorm's moderation (ADR-071): an idea reaches the wall and the
   * phones only once the teacher approved it. Defaults to ON for an
   * anonymous poll — guests and a projector — and OFF for a classroom's.
   * Inert on the other types.
   */
  moderation: z.boolean().default(false),
  /**
   * A brainstorm's AI assistance (ADR-072): a model judges each new idea —
   * approves it or hides it, corrects and rephrases it, attaches it to an
   * idea that says the same — and the teacher can undo any of it. Off by
   * default; the phones say so while it is on.
   */
  ai: z.boolean().default(false),
});
export type PollSettings = z.infer<typeof PollSettings>;

/** `POST /app/api/polls`: creates the evaluation AND starts it. */
export const PollCreate = z.object({
  questionId: z.uuid(),
  /** The launcher remembers the last one. */
  audience: PollAudience,
});
export type PollCreate = z.infer<typeof PollCreate>;

/**
 * `POST /app/api/polls/questions`: a new question in the teacher's personal
 * pool, without the launcher ever learning that pool's id. The route ensures
 * the pool (`is_personal`) and then creates the question through the ordinary
 * pool service, so the answer is the same `QuestionDetail` as
 * `POST /app/api/pools/:id/questions`.
 */
export const PollQuestionCreate = z.object({
  type: PollQuestionType,
  internalName: z.string().trim().min(1).max(200),
});
export type PollQuestionCreate = z.infer<typeof PollQuestionCreate>;

/**
 * `POST /app/api/polls/inline`: creates AND starts a poll on a question the
 * teacher writes in the launcher and does not keep (ADR-014, addendum
 * 2026-09-23). `config` is the type's own configuration; the server
 * validates it with that type's `keylessConfigSchema` through the registry —
 * the gate of a publication with the answer key made optional, for an
 * opinion poll has none — and answers `422 config_invalid` with the zod
 * issues otherwise. No pool receives the question.
 */
export const PollInlineCreate = z.object({
  audience: PollAudience,
  type: PollQuestionType,
  config: z.unknown(),
});
export type PollInlineCreate = z.infer<typeof PollInlineCreate>;

/** One part of a poll outcome: a rate in [0, 1] and its whole percentage. */
export const PollOutcomeShare = z.object({
  rate: z.number().min(0).max(1),
  /** Whole percentages of one outcome sum to 100 (largest remainder). */
  percent: z.number().int().min(0).max(100),
});
export type PollOutcomeShare = z.infer<typeof PollOutcomeShare>;

/**
 * How a question fared over its last runs (`pollOutcome` of `@quiz/domain`,
 * issue #161): a donut when it has a key — with abstention only when every
 * averaged run had a roster — "n answers" when it has none, nothing when no
 * run has finished.
 */
export const PollOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("opinion"),
    runs: z.number().int().min(1),
    /** Answers per run, on average, rounded. */
    answers: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal("keyed"),
    runs: z.number().int().min(1),
    correct: PollOutcomeShare,
    incorrect: PollOutcomeShare,
    abstention: PollOutcomeShare.nullable(),
  }),
]);
export type PollOutcome = z.infer<typeof PollOutcome>;

/**
 * `GET /app/api/polls/questions`, the launcher's "Recent polls": the
 * questions of the polls the caller launched, one row per question, most
 * recent run first — the questions written in the launcher and never kept
 * included (ADR-014, addendum 2026-09-27) — then the published questions of
 * their personal pool that never ran.
 */
export const PollQuestionPick = z.object({
  id: z.uuid(),
  type: PollQuestionType,
  internalName: z.string(),
  /** The statement, as the student sees it, for the launcher's list. */
  prompt: z.string(),
  lastUsedAt: z.iso.datetime().nullable(),
  useCount: z.number().int(),
  /** The question sits in a pool; false for one written in the launcher and not kept. */
  saved: z.boolean(),
  /** Over the caller's last runs of the question (`POLL_OUTCOME_WINDOW` of `@quiz/domain`). */
  outcome: PollOutcome,
});
export type PollQuestionPick = z.infer<typeof PollQuestionPick>;

/**
 * `GET /app/api/polls/pool-questions`, the launcher's "From pools" (issue
 * #162): the search of the pool screen — same parameters, same grammar once
 * the web app has parsed the box — run across EVERY pool the caller reaches,
 * over the published, live `mcq`/`short` questions only. A `type` outside
 * those two matches nothing. `classroomId` narrows the scope to the pools
 * linked to that classroom's course; the classroom is loaded through the
 * staff predicate, and an unreachable one is a 404.
 */
export const PollPoolSearch = QuestionSearch.omit({
  categoryId: true,
  includeDeleted: true,
  // Favourites are a pool's (F-POOL-10); the launcher searches across pools.
  starred: true,
  // The course filter is a pool's (#599 step 7b), where the pool is linked.
  course: true,
}).extend({
  classroomId: z.uuid().optional(),
});
export type PollPoolSearch = z.infer<typeof PollPoolSearch>;

/** One question of "From pools": what the row shows, and what it starts. */
const PollPoolQuestion = z.object({
  id: z.uuid(),
  type: PollQuestionType,
  internalName: z.string(),
  /** The statement, as the student sees it (`toStudent`). */
  prompt: z.string(),
  pool: z.object({ id: z.uuid(), name: z.string() }),
  concepts: z.array(ConceptRef),
  difficulty: z.number().int().min(1).max(5),
  /** The published version a poll would freeze. */
  latestNumber: z.number().int().min(1),
});
type PollPoolQuestion = z.infer<typeof PollPoolQuestion>;

/**
 * One page of "From pools". `total` counts every match, and `concepts` is
 * every concept of the scope — the filters left out — for the filter sheet
 * and the `#` completion, the way a pool's concepts feed its own bar.
 */
export const PollPoolPage = pageOf(PollPoolQuestion).extend({
  total: z.number().int().nonnegative(),
  concepts: z.array(ConceptRef),
});
export type PollPoolPage = z.infer<typeof PollPoolPage>;

/** The aggregate of one poll: what the projection draws (spec `poll.tally`). */
export const PollTally = z.object({
  /** Attempts opened (accounts and guests together). */
  joined: z.number().int(),
  /** Attempts holding an answer. */
  answered: z.number().int(),
  /** `mcq`: one entry per canonical choice index, in choice order. */
  choices: z.array(z.object({ index: z.number().int(), count: z.number().int() })),
  /**
   * `short`: distinct answers (trimmed, case- and whitespace-folded), most
   * frequent first, the first spelling seen kept for display. Capped by the
   * server (`PollTally.SHORT_CAP`).
   */
  answers: z.array(z.object({ text: z.string(), count: z.number().int() })),
  /**
   * `brainstorm`: one bubble per cluster of ideas, most proposed first —
   * only the ideas the room may see (`brainstormCloud` of `@quiz/domain`):
   * under moderation, approved ones; never a hidden one, not even as a label.
   */
  ideas: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int() })),
  /** `brainstorm`, the teacher's exits only: ideas waiting for moderation. 0 elsewhere. */
  pending: z.number().int(),
});
export type PollTally = z.infer<typeof PollTally>;

/** How many distinct short answers a tally carries at most. */
export const POLL_SHORT_CAP = 60;

/** What the teacher's projection reads, once, before the stream moves it. */
export const PollTeacherView = z.object({
  evaluation: z.object({
    id: z.uuid(),
    /** Null for an anonymous poll, which belongs to no classroom. */
    classroomId: z.uuid().nullable(),
    /**
     * For the projection's context line; spares the screen a second request.
     * Null with the classroom.
     */
    classroomName: z.string().nullable(),
    courseName: z.string().nullable(),
    title: z.string(),
    state: z.string(),
    /** The session code shown on the beamer; the QR encodes `joinUrl`. */
    code: z.string(),
    createdAt: z.iso.datetime(),
  }),
  joinUrl: z.string(),
  settings: PollSettings,
  question: z.object({
    id: z.uuid(),
    type: PollQuestionType,
    /** Through `toStudent`, exactly what a participant sees. */
    student: z.unknown(),
    /** The key (`toSolution`): the projection shows it only once revealed. */
    solution: z.unknown(),
    /**
     * The question sits in a pool. False for one written in the launcher
     * and not kept (ADR-014, addenda 2026-09-23): "Keep this question"
     * (`POST /app/api/evaluations/:id/poll/keep`) is what makes it true.
     */
    saved: z.boolean(),
    /** The pool that holds it, when the caller can open that pool; null otherwise. */
    pool: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  }),
  tally: PollTally,
});
export type PollTeacherView = z.infer<typeof PollTeacherView>;

/** Where a poll stands for its participants: still taking answers, or over. */
export const PollState = z.enum(["running", "ended"]);
export type PollState = z.infer<typeof PollState>;

/**
 * What a participant reads at `/p/:code` — with or without a session.
 * `solution` is null while the key is not revealed; `me` says where THIS
 * browser stands. Neither switch closes the vote: while `state` is
 * `running`, the phone keeps its answer control (ADR-014, addendum
 * 2026-09-29). It carries no title: a poll's title is its question's
 * internal name, which never reaches a student (invariant 4, #305).
 */
export const PollPublicView = z.object({
  code: z.string(),
  state: PollState,
  settings: PollSettings,
  question: z.object({
    type: PollQuestionType,
    student: z.unknown(),
  }),
  solution: z.unknown().nullable(),
  /**
   * The distribution, exactly while the teacher shows it (`settings.votes`);
   * null otherwise. It is all a phone has to show
   * when the question has no key (an opinion poll, ADR-014 addendum
   * 2026-09-23).
   */
  tally: PollTally.nullable(),
  me: z.object({
    /** A session or a guest cookie identifies this browser. */
    identified: z.boolean(),
    /** No session and the poll is a classroom's: the page must send to login. */
    loginRequired: z.boolean(),
    joined: z.boolean(),
    /** The answer this browser last sent, to redraw it after a reload. */
    answer: z.unknown().nullable(),
  }),
});
export type PollPublicView = z.infer<typeof PollPublicView>;

/**
 * `/app/api/p/:code` — the session code as it travels in a URL. Upper-cased
 * server-side, so a phone that types it in lower case still joins.
 */
export const PollCodeParam = z.object({
  code: z.string().trim().min(4).max(12).regex(/^[A-Za-z0-9]+$/),
});
export type PollCodeParam = z.infer<typeof PollCodeParam>;

/**
 * `POST /app/api/evaluations/:id/poll/reveal`: the two display switches,
 * independent (ADR-014, addendum 2026-09-29). A switch omitted stays where it
 * was. `revealed: true` on a poll whose question has no key is refused
 * (`422 poll_keyless`): there is nothing to reveal. A body that names
 * neither switch is refused: it would write and audit nothing.
 */
export const PollRevealBody = z
  .object({
    revealed: z.boolean().optional(),
    votes: z.boolean().optional(),
    /** A brainstorm's moderation (ADR-071); refused on another type (`422 poll_type`). */
    moderation: z.boolean().optional(),
    /**
     * A brainstorm's AI assistance (ADR-072); refused on another type
     * (`422 poll_type`), and turned on only when a model can be called
     * (`422 llm_unavailable`).
     */
    ai: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: "name at least one of `revealed`, `votes`, `moderation` and `ai`",
  });
export type PollRevealBody = z.infer<typeof PollRevealBody>;

/** `POST /app/api/p/:code/answer`: the whole answer, validated by the type's schema. */
export const PollAnswer = z.object({ payload: z.unknown() });
export type PollAnswer = z.infer<typeof PollAnswer>;

/** A past or running poll of the teacher, for "run again" and the launcher. */
export const PollSummary = z.object({
  id: z.uuid(),
  /** Null for an anonymous poll (ADR-014, addendum 2026-09-27). */
  classroomId: z.uuid().nullable(),
  title: z.string(),
  state: z.string(),
  code: z.string().nullable(),
  questionId: z.uuid(),
  questionType: QuestionTypeId,
  answered: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type PollSummary = z.infer<typeof PollSummary>;

/** The longest label a teacher may give a cluster of ideas. */
export const POLL_IDEA_LABEL_MAX = 60;

const IdeaKey = z.string().min(1).max(200);

/**
 * `POST /app/api/evaluations/:id/poll/ideas` (ADR-071): the teacher's word on
 * a brainstorm's ideas, by idea key (`ideaKey` of `@quiz/domain`). `approve`,
 * `hide` and `reset` (back to unmoderated) set a status; `merge` puts the
 * clusters of `keys` under the cluster of `into`; `detach` takes ideas out of
 * their cluster; `rename` names the cluster of `key` (`null` drops the name).
 */
export const PollIdeaAction = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["approve", "hide", "reset"]), keys: z.array(IdeaKey).min(1).max(500) }),
  z.object({ action: z.literal("merge"), keys: z.array(IdeaKey).min(1).max(500), into: IdeaKey }),
  z.object({ action: z.literal("detach"), keys: z.array(IdeaKey).min(1).max(500) }),
  z.object({
    action: z.literal("rename"),
    key: IdeaKey,
    label: z.string().trim().max(POLL_IDEA_LABEL_MAX).nullable(),
  }),
]);
export type PollIdeaAction = z.infer<typeof PollIdeaAction>;

/**
 * Why the AI assistance stopped judging (ADR-072): a gateway failure, or
 * `run_cap`, the most calls one poll may make.
 */
export const PollAiError = z.enum([...LLM_ERROR_CODES, "run_cap"]);
export type PollAiError = z.infer<typeof PollAiError>;

/**
 * `GET /app/api/evaluations/:id/poll/ideas`: the teacher's board of a
 * brainstorm — every idea, hidden and unmoderated ones included, grouped by
 * the teacher's merges. Staff only: it never reaches a phone or the wall.
 */
export const PollIdeaBoard = z.object({
  moderation: z.boolean(),
  /** The AI assistance (ADR-072): whether a model can be called, whether it is on, its last failure. */
  ai: z.object({
    available: z.boolean(),
    on: z.boolean(),
    error: PollAiError.nullable(),
  }),
  answered: z.number().int(),
  pending: z.number().int(),
  clusters: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      renamed: z.boolean(),
      /** Participants with a visible idea in the cluster: the bubble's size. */
      count: z.number().int(),
      /** Participants with any idea in the cluster. */
      total: z.number().int(),
      variants: z.array(
        z.object({
          key: z.string(),
          /** As the participant typed it. */
          text: z.string(),
          /** The model's corrected form, which the room reads instead; null without one. */
          correction: z.string().nullable(),
          /** The decision on it is the model's (ADR-072). */
          ai: z.boolean(),
          count: z.number().int(),
          status: z.enum(IDEA_STATUSES),
        }),
      ),
    }),
  ),
});
export type PollIdeaBoard = z.infer<typeof PollIdeaBoard>;
