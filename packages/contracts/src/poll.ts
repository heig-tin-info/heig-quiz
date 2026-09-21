/**
 * Live polls (F-LIVE-13 / F-LIVE-14 / F-AUTH-05): ONE question, run in the
 * open with a session code and a QR, answered by anyone who joins — an
 * account, or a guest when the poll allows it — with the tally on the
 * teacher's projection as it grows.
 *
 * A poll IS an evaluation of mode `poll` (docs/spec/05, `evaluations.mode`),
 * with one item, started the moment it is created, and its settings carry
 * the two poll switches under `settings.poll`. Everything below the create
 * call therefore reuses the attempt, answer and event machinery of `live`;
 * only the participant identity (guest or account, never a roster seat)
 * and the aggregate are new.
 */
import { z } from "zod";

import { QuestionTypeId } from "./pool.js";

/** The two question types a poll may run for now. */
export const PollQuestionType = z.enum(["mcq", "short"]);
export type PollQuestionType = z.infer<typeof PollQuestionType>;

/** Stored under `EvaluationSettings.poll`. */
export const PollSettings = z.object({
  /** Anyone with the code may answer without an account (a guest cookie). */
  anonymous: z.boolean().default(false),
  /** The teacher pressed "Reveal": the key is shown on every screen. */
  revealed: z.boolean().default(false),
});
export type PollSettings = z.infer<typeof PollSettings>;

/** `POST /app/api/polls`: creates the evaluation AND starts it. */
export const PollCreate = z.object({
  questionId: z.uuid(),
  /** The evaluation needs a home; the launcher remembers the last one. */
  classroomId: z.uuid(),
  anonymous: z.boolean().default(false),
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

/** A pollable question of the teacher's personal pool, most recently used first. */
export const PollQuestionPick = z.object({
  id: z.uuid(),
  type: PollQuestionType,
  internalName: z.string(),
  /** The statement, as the student sees it, for the launcher's list. */
  prompt: z.string(),
  lastUsedAt: z.iso.datetime().nullable(),
  useCount: z.number().int(),
});
export type PollQuestionPick = z.infer<typeof PollQuestionPick>;

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
});
export type PollTally = z.infer<typeof PollTally>;

/** How many distinct short answers a tally carries at most. */
export const POLL_SHORT_CAP = 60;

/** What the teacher's projection reads, once, before the stream moves it. */
export const PollTeacherView = z.object({
  evaluation: z.object({
    id: z.uuid(),
    classroomId: z.uuid(),
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
  }),
  tally: PollTally,
});
export type PollTeacherView = z.infer<typeof PollTeacherView>;

/**
 * What a participant reads at `/p/:code` — with or without a session.
 * `solution` is null until the teacher reveals; `me` says where THIS
 * browser stands.
 */
export const PollPublicView = z.object({
  code: z.string(),
  title: z.string(),
  state: z.enum(["running", "ended"]),
  settings: PollSettings,
  question: z.object({
    type: PollQuestionType,
    student: z.unknown(),
  }),
  solution: z.unknown().nullable(),
  me: z.object({
    /** A session or a guest cookie identifies this browser. */
    identified: z.boolean(),
    /** No session and the poll is not anonymous: the page must send to login. */
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

/** `POST /app/api/evaluations/:id/poll/reveal`. */
export const PollRevealBody = z.object({ revealed: z.boolean() });
export type PollRevealBody = z.infer<typeof PollRevealBody>;

/** `POST /app/api/p/:code/answer`: the whole answer, validated by the type's schema. */
export const PollAnswer = z.object({ payload: z.unknown() });
export type PollAnswer = z.infer<typeof PollAnswer>;

/** A past or running poll of the teacher, for "run again" and the launcher. */
export const PollSummary = z.object({
  id: z.uuid(),
  classroomId: z.uuid(),
  title: z.string(),
  state: z.string(),
  code: z.string().nullable(),
  questionId: z.uuid(),
  questionType: QuestionTypeId,
  answered: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type PollSummary = z.infer<typeof PollSummary>;
