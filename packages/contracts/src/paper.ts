/**
 * The paper attempt (ADR-125 §9–§16, F-PAPER-01..05): a copy sat on paper,
 * typed in by a staff member in ONE submission, and its optional scan.
 *
 *   - `GET  /app/api/evaluations/:id/paper/items?user=<uuid>` — what the
 *     entry page renders: the evaluation as the student read it on paper
 *     (the student views, in the hand-out's order) and the key of each
 *     item beside it. Staff only, refused like the submission;
 *   - `POST /app/api/evaluations/:id/paper` — the whole copy, handed in;
 *   - `GET  /app/api/evaluations/:id/attempts/:attemptId/paper` — the sheet;
 *   - `PUT` / `GET …/paper/scan` — the scan, multipart in, attachment out.
 */
import { z } from "zod";

import { PAPER_SCAN_MIMES } from "@quiz/domain";

import { AnswerCoordinates } from "./common.js";
import { PAPER_ENTRY_REFUSALS } from "./exports.js";
import { AttemptOrigin, AttemptState, AttemptView } from "./live.js";

/** `?user=` of the entry page's read: the student whose copy is typed in. */
export const PaperItemsQuery = z.object({ user: z.uuid() });
export type PaperItemsQuery = z.infer<typeof PaperItemsQuery>;

/** `POST /evaluations/:id/paper`: one student's whole copy. */
export const PaperAttemptBody = z.object({
  /** The student, a claimed seat of the evaluation's classroom (`422 paper_no_seat`). */
  userId: z.uuid(),
  /** The day the paper was sat, as written on it. Recorded apart: the hand-in time is the server's. */
  examDate: z.iso.date(),
  /**
   * Item id → the answer as the player holds it, in the coordinates of the
   * paper's view; an item left out was left blank. Each one goes through the
   * student save's path on the server; one refused refuses the copy (422).
   */
  answers: z
    .record(z.uuid(), z.unknown())
    .refine((answers) => Object.keys(answers).length <= 200, "too many answers"),
  /** ADR-097: the choices of each answer are displayed positions. */
  coordinates: AnswerCoordinates.optional(),
});
export type PaperAttemptBody = z.infer<typeof PaperAttemptBody>;

/** The reply of `POST /evaluations/:id/paper`. */
export const PaperAttemptCreated = z.object({
  attemptId: z.uuid(),
  /** The attempt the copy replaced (ADR-125 §12), or null. */
  supersededAttemptId: z.uuid().nullable(),
});
export type PaperAttemptCreated = z.infer<typeof PaperAttemptCreated>;

/**
 * The refusals of the submission and of the entry page's read, by code: the
 * evaluation's (`PAPER_ENTRY_REFUSALS`, `409`), then `422 paper_no_seat`
 * (not a claimed student seat of the classroom), `409 paper_conflict`
 * (another copy of the same student was handed in at the same instant) and
 * `422 answer_invalid` (a malformed answer, the student save's refusal).
 */
export const PAPER_REFUSALS = [...PAPER_ENTRY_REFUSALS, "paper_no_seat", "paper_conflict", "answer_invalid"] as const;
export type PaperRefusal = (typeof PAPER_REFUSALS)[number];

/** `GET /evaluations/:id/paper/items?user=`: the entry page's paper. Staff only. */
export const PaperItems = z.object({
  student: z.object({ userId: z.uuid(), displayName: z.string() }),
  /**
   * The paper as the student read it: the student views of the hand-out's
   * order, built by the one student exit. `attempt.preview` is true and its
   * id a placeholder: no attempt exists before the submission.
   */
  view: AttemptView,
  /** Item id → the whole key, in the coordinates of `view`: what the teacher checks the copy against. */
  solutions: z.record(z.uuid(), z.unknown()),
  /** The student's attempt that the copy will replace (ADR-125 §12), or null. */
  replaces: z
    .object({ attemptId: z.uuid(), state: AttemptState, origin: AttemptOrigin })
    .nullable(),
  /** The exam date to offer: the evaluation's opening day, else its first start's. */
  examDate: z.iso.date(),
});
export type PaperItems = z.infer<typeof PaperItems>;

/** A scan's type, read from its bytes. */
export const PaperScanMime = z.enum(PAPER_SCAN_MIMES);
export type PaperScanMime = z.infer<typeof PaperScanMime>;

/** `GET …/attempts/:attemptId/paper`, and the reply of the scan upload. */
export const PaperSheet = z.object({
  attemptId: z.uuid(),
  examDate: z.iso.date(),
  scan: z
    .object({
      mime: PaperScanMime,
      bytes: z.number().int().nonnegative(),
      uploadedAt: z.iso.datetime(),
    })
    .nullable(),
});
export type PaperSheet = z.infer<typeof PaperSheet>;
