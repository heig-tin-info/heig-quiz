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
  ACCEPTANCE_SCOPES,
  CONTEST_REFUSALS,
  CONTESTATION_DAYS_MAX,
  CONTESTATION_STATES,
  CONTESTATION_TEXT_MAX,
  CONTESTATION_VERDICTS,
  PROPOSAL_REFUSALS,
  proposalRefusal,
  WINDOW_EXTEND_REFUSALS,
  type AnswerShape,
} from "@quiz/domain";

export { CONTESTATION_TEXT_MAX };

export const ContestationState = z.enum(CONTESTATION_STATES);
export type ContestationState = z.infer<typeof ContestationState>;

export const ContestationVerdict = z.enum(CONTESTATION_VERDICTS);
export type ContestationVerdict = z.infer<typeof ContestationVerdict>;

/**
 * A contestation window, in days after the release that opens it: 0 to
 * {@link CONTESTATION_DAYS_MAX}, 0 for none — an exam's feedback policy's
 * `contestationDays` and a project's (ADR-139 §1, §13).
 */
export const ContestationDays = z.number().int().min(0).max(CONTESTATION_DAYS_MAX);
export type ContestationDays = z.infer<typeof ContestationDays>;

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

// --- Proposals (ADR-139 §14) -------------------------------------------------

/** Why a proposal's body is refused (`proposalRefusal` of `@quiz/domain`): the 400's issue message. */
export const ProposalRefusal = z.enum(PROPOSAL_REFUSALS);
export type ProposalRefusal = z.infer<typeof ProposalRefusal>;

/** A part of a question, as its type names it (`b2`, a cloze blank): ADR-128's. */
export const AcceptancePart = z.string().min(1).max(64);
/** The type's identity of an answer at a part: a cloze blank's normalised text, a dropdown's canonical option. */
export const AcceptanceAnswer = z.string().min(1).max(1000);

/**
 * The ADR-128 gesture an assistant proposes on an exam's contestation: the
 * answer `answer` at `part` counts right, for `everyone` who gave it or for
 * this contestation's `student` only.
 */
export const ProposedAcceptance = z.strictObject({
  part: AcceptancePart,
  answer: AcceptanceAnswer,
  scope: z.enum(ACCEPTANCE_SCOPES),
});
export type ProposedAcceptance = z.infer<typeof ProposedAcceptance>;

/**
 * The fields every answer to a contestation shares, the owner's and an
 * assistant's proposal of it, an exam's and a project's: the verdict and the
 * reply (empty for none).
 */
export const AnswerFields = { verdict: ContestationVerdict, reply: ContestationReply.default("") };

/**
 * The one refinement of every answer's and proposal's body (`proposalRefusal`
 * of `@quiz/domain`): a refusal gives nothing, points need a reply. The
 * issue's message is the refusal's code (`unexplained` on `reply`).
 */
export function refineAnswer(ctx: z.RefinementCtx, answer: AnswerShape): void {
  const refusal = proposalRefusal(answer);
  if (refusal !== null) ctx.addIssue({ code: "custom", message: refusal, path: refusal === "unexplained" ? ["reply"] : [] });
}

/**
 * What the staff read of the one proposal standing on a contestation
 * (ADR-139 §14), made by an assistant over MCP and applied only when the
 * course owner confirms it. `reply` empty: none. `points`: new points (an
 * exam's question, a project's criterion); `rationale`: a criterion's,
 * with its points; `accepted`: an accepted answer (an exam's question
 * only), with its `label` as the item reads it (null when it no longer
 * reads). `stale`: the grading in force moved since the proposal — a
 * confirmation is refused (`409 proposal_stale`). `affected`: how many
 * OTHER students' answers an accepted answer would re-grade (F-GRADE-11),
 * null for any other proposal.
 */
export const ContestationProposalView = z.object({
  verdict: ContestationVerdict,
  reply: z.string(),
  points: z.number().nullable(),
  rationale: z.string().nullable(),
  accepted: ProposedAcceptance.extend({ label: z.string().nullable() }).nullable(),
  proposedAt: z.iso.datetime(),
  stale: z.boolean(),
  affected: z.number().int().nonnegative().nullable(),
});
export type ContestationProposalView = z.infer<typeof ContestationProposalView>;

/**
 * The owner's confirmation of a proposal (`POST …/proposal/confirm`): the
 * `proposedAt` of the proposal the screen showed. A proposal replaced since
 * is not confirmed (`409 proposal_stale`): the owner applies only what they
 * read.
 */
export const ContestationConfirmBody = z.strictObject({ proposedAt: z.iso.datetime() });
export type ContestationConfirmBody = z.infer<typeof ContestationConfirmBody>;

/** The answer of a proposal's write (`PUT …/proposal`): the contestation, its exam's evaluation (absent for a project's), and its proposal as the staff now read it. */
export const ContestationProposed = z.object({ id: z.uuid(), evaluationId: z.uuid().optional(), proposal: ContestationProposalView });
export type ContestationProposed = z.infer<typeof ContestationProposed>;

/** The page of a read for an assistant: the offset of the first contestation (`GET …/contestations/open?offset=`). */
export const OpenContestationsQuery = z.strictObject({ offset: z.coerce.number().int().min(0).max(100_000).default(0) });
export type OpenContestationsQuery = z.infer<typeof OpenContestationsQuery>;

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
  /** The assistant's proposal standing on it (ADR-139 §14), or null; never in a student payload. */
  proposal: ContestationProposalView.nullable(),
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
