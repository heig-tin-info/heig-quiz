/**
 * Contestations (ADR-139, F-GRADE-08): a student contests the grading of
 * one question of a released exam, once, with a reason; the course owner
 * answers once — `accepted` or `refused` — with a reply. Plain text both,
 * at most {@link CONTESTATION_TEXT_MAX} characters, never Markdown.
 *
 * Two readings of one row: the STUDENT's own (`StudentContestation`), which
 * travels only in that student's feedback payload (invariant 4), and the
 * STAFF's (`StaffContestation`), on the grading panel, which adds the id
 * the answer addresses and names nobody. The answer's body,
 * `ContestationResolveBody`, lives in `grading.ts` beside the manual
 * override whose shape it reuses.
 */
import { z } from "zod";

import {
  CONTEST_REFUSALS,
  CONTESTATION_STATES,
  CONTESTATION_TEXT_MAX,
  CONTESTATION_VERDICTS,
  WINDOW_EXTEND_REFUSALS,
} from "@quiz/domain";

export { CONTESTATION_TEXT_MAX };

export const ContestationState = z.enum(CONTESTATION_STATES);
export type ContestationState = z.infer<typeof ContestationState>;

export const ContestationVerdict = z.enum(CONTESTATION_VERDICTS);
export type ContestationVerdict = z.infer<typeof ContestationVerdict>;

/** A reason: mandatory, trimmed, plain text. */
export const ContestationReason = z.string().trim().min(1).max(CONTESTATION_TEXT_MAX);

/** A reply: trimmed, plain text; empty is none (a bare acceptance). */
export const ContestationReply = z.string().trim().max(CONTESTATION_TEXT_MAX);

/**
 * Why a question may not be contested, the `reason` of `409
 * not_contestable` (`unitRefusal` of `@quiz/domain`): its results are not
 * shown, its attempt does not count, the question counts nowhere, its
 * grading is pending, or its points are full already.
 */
export const ContestRefusal = z.enum(CONTEST_REFUSALS);
export type ContestRefusal = z.infer<typeof ContestRefusal>;

/** The body of `409 not_contestable`. */
export const NotContestable = z.object({
  error: z.literal("not_contestable"),
  message: z.string(),
  reason: ContestRefusal,
});
export type NotContestable = z.infer<typeof NotContestable>;

/** `POST /attempts/:id/items/:itemId/contestation`: the student's one request. */
export const ContestationFileBody = z.object({ reason: ContestationReason });
export type ContestationFileBody = z.infer<typeof ContestationFileBody>;

/**
 * One contestation as its own student reads it, on their feedback page.
 * `reply` is null while it is open, and after an acceptance that said
 * nothing more.
 */
export const StudentContestation = z.object({
  state: ContestationState,
  reason: z.string(),
  filedAt: z.iso.datetime(),
  reply: z.string().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type StudentContestation = z.infer<typeof StudentContestation>;

/**
 * One contestation as the staff read it on the grading panel: never a
 * name, whatever Anonymise says — the entry it sits on names the student
 * when the names are asked for. `counted`: the attempt is the one that
 * counts for its student (ADR-025); a contestation on one that no longer
 * does stays listed, flagged. The "open" figures count the official
 * attempts of the class: a teacher's test walk (ADR-018) and an attempt a
 * paper copy replaced (ADR-125 §12) are in none.
 */
export const StaffContestation = StudentContestation.extend({
  id: z.uuid(),
  counted: z.boolean(),
});
export type StaffContestation = z.infer<typeof StaffContestation>;

/**
 * `PUT /evaluations/:id/contestation-window`, the owner's two acts on a
 * released exam: close it now, or move its closing instant to a later one
 * (at most 90 days ahead; extending may reopen a closed window).
 */
export const ContestationWindowBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("close") }),
  z.object({ action: z.literal("extend"), closesAt: z.iso.datetime() }),
]);
export type ContestationWindowBody = z.infer<typeof ContestationWindowBody>;

/** Why an extension's instant is refused (`windowExtendRefusal` of `@quiz/domain`). */
export const WindowExtendRefusal = z.enum(WINDOW_EXTEND_REFUSALS);
export type WindowExtendRefusal = z.infer<typeof WindowExtendRefusal>;

/** The body of `422 window_instant`: the instant is not ahead of now, or too far. */
export const WindowInstantRefused = z.object({
  error: z.literal("window_instant"),
  message: z.string(),
  reason: WindowExtendRefusal,
});
export type WindowInstantRefused = z.infer<typeof WindowInstantRefused>;

/** The window as it stands after the act. */
export const ContestationWindow = z.object({ closesAt: z.iso.datetime().nullable() });
export type ContestationWindow = z.infer<typeof ContestationWindow>;
