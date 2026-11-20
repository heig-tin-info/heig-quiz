/**
 * An assistant's proposals on the contestations of an exam (ADR-139 §14,
 * Lot 2): an MCP client with a token of scope `quiz`, at the consent that
 * lets it (`CONTESTATIONS_CONSENT`), reads the class's OPEN contestations —
 * masked, capped — and PROPOSES the owner's answer: a verdict, a reply, new
 * points or an accepted answer (ADR-128). Nothing is applied: the proposal
 * stands on the contestation, one at a time, overwritten by a later one,
 * cleared when the contestation is answered, until the course owner confirms
 * it in the portal — through the resolve path of Lot 1, the grading in force
 * it recorded still in force (`proposal_stale` otherwise, `proposalStale` of
 * `@quiz/domain`).
 *
 * Nothing of a proposal reaches a student: the student payloads read
 * `studentContestationOf`, which names none of these columns (invariant 4).
 */
import { and, asc, count, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type {
  AssistantContestedItem,
  AssistantExamContestation,
  AssistantExamContestations,
  ContestationProposalBody,
  ContestationProposalView,
  ContestationResolveBody,
} from "@quiz/contracts";
import { LABELS, type Block } from "@quiz/docexport";
import { markdownBody } from "@quiz/docexport/markdown";
import {
  clipText,
  CONTESTATION_EXPORT_PAGE,
  itemListLock,
  maskNames,
  contestationPage,
  proposalStale,
  type ProposedAcceptance,
} from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db, Tx } from "../../db/client.js";
import { answers, attempts, contestations, evaluations, gradings, isStaffAttempt, officialAttempt } from "../../db/schema.js";
import { solutionBlocks, statementBlocks } from "../../documents/blocks.js";
import { attemptCount, joinedItems, peopleOf, type EvaluationRecord, type JoinedItem } from "../evaluation/service.js";
import { typeOf } from "../pool/config.js";
import { isParameterized, readingPerAttempt } from "../pool/service.js";
import { acceptanceGate, acceptanceReached, assertRuleHolds, partsOf } from "./acceptance.js";
import { acceptanceHook, itemScopes, ruleLabel } from "./acceptanceRules.js";
import { NO_PROPOSAL, proposalBase, type ContestationRecord } from "./contestations.js";
import { expectedViews } from "./panel.js";
import { criteriaOf } from "./reads.js";
import { GradingError, pairKey, type AttemptRecord, type GradingRecord, type PairKey } from "./records.js";
import { assertPointsInRange } from "./teacherWrites.js";

/** The rule an accepted answer of a proposal names, on its contestation's attempt for `student`. */
export const proposedRule = (accepted: ProposedAcceptance, attemptId: string) => ({
  part: accepted.part,
  answer: accepted.answer,
  attemptId: accepted.scope === "student" ? attemptId : null,
});

// --- The staff's reading ---------------------------------------------------------

/** What a proposal's staff reading needs beside its row: stale or not; an accepted answer's reach and label. */
interface ProposalFacts {
  stale: boolean;
  /** The other students an accepted answer would re-grade; null for any other proposal. */
  affected: number | null;
  /** The accepted answer's label on the item; null when it no longer reads. */
  label: string | null;
}

/** The proposal standing on `row`, as the staff read it; null when none does. */
function proposalViewOf(row: ContestationRecord, facts: ProposalFacts): ContestationProposalView | null {
  const base = proposalBase(row);
  if (base === null) return null;
  return {
    ...base,
    rationale: null,
    accepted: row.proposedAcceptance ? { ...row.proposedAcceptance, label: facts.label } : null,
    stale: facts.stale,
    affected: row.proposedAcceptance ? facts.affected : null,
  };
}

/** The validated gradings in force of the cells of `rows`, by cell. */
export async function validatedOfCells(db: Db | Tx, rows: readonly ContestationRecord[]): Promise<Map<PairKey, GradingRecord>> {
  if (rows.length === 0) return new Map();
  const found = await db
    .select()
    .from(gradings)
    .where(
      and(
        eq(gradings.state, "validated"),
        inArray(gradings.attemptId, [...new Set(rows.map((r) => r.attemptId))]),
        inArray(gradings.itemId, [...new Set(rows.map((r) => r.itemId))]),
      ),
    );
  return new Map(found.map((g) => [pairKey(g.attemptId, g.itemId), g]));
}

/**
 * The staff's reading of the proposals standing on `rows` (contestations of
 * `evaluation`), by contestation: stale or not, and for an accepted answer
 * its label and how many other students it would re-grade (F-GRADE-11).
 */
export async function proposalViews(
  db: Db,
  evaluation: EvaluationRecord,
  rows: readonly ContestationRecord[],
  items: readonly JoinedItem[],
  /** The validated gradings in force of their cells ({@link validatedOfCells}), which the caller read. */
  inForce: ReadonlyMap<PairKey, GradingRecord>,
): Promise<Map<string, ContestationProposalView>> {
  const proposed = rows.filter((r) => r.proposedAt !== null);
  if (proposed.length === 0) return new Map();
  const byId = new Map(items.map((i) => [i.item.id, i]));
  const attemptRows = await attemptsOf(db, proposed.filter((r) => r.proposedAcceptance !== null).map((r) => r.attemptId));
  // ADR-128's reach, read once per item and answer, whatever the number of proposals naming it.
  const reaches = new Map<string, Promise<Set<string>>>();
  const reachOf = (item: JoinedItem, accepted: ProposedAcceptance) => {
    const key = JSON.stringify([item.item.id, accepted.part, accepted.answer]);
    if (!reaches.has(key)) reaches.set(key, acceptanceReached(db, evaluation, item, accepted));
    return reaches.get(key)!;
  };
  const out = new Map<string, ContestationProposalView>();
  for (const row of proposed) {
    const stale = proposalStale(row.gradingAtProposalId, inForce.get(pairKey(row.attemptId, row.itemId))?.id ?? null);
    let label: string | null = null;
    let affected: number | null = null;
    const item = byId.get(row.itemId);
    const attempt = attemptRows.get(row.attemptId);
    if (row.proposedAcceptance && item && attempt) {
      const rule = proposedRule(row.proposedAcceptance, row.attemptId);
      const hook = acceptanceHook(item.question.type, evaluation.mode);
      label = hook ? ruleLabel(hook, () => readingPerAttempt(item)(attempt).config, rule) : null;
      const reached = row.proposedAcceptance.scope === "student" ? new Set<string>() : await reachOf(item, row.proposedAcceptance);
      affected = [...reached].filter((id) => id !== row.attemptId).length;
    }
    const view = proposalViewOf(row, { stale, affected, label });
    if (view) out.set(row.id, view);
  }
  return out;
}

async function attemptsOf(db: Db, ids: readonly string[]): Promise<Map<string, AttemptRecord>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(attempts).where(inArray(attempts.id, [...new Set(ids)]));
  return new Map(rows.map((a) => [a.id, a]));
}

// --- The write ---------------------------------------------------------------------

/**
 * An assistant's proposal on an OPEN contestation (`409 not_open`
 * otherwise), validated against its cell as the owner's answer would be:
 * new points within the item's range (`assertPointsInRange`), never on an
 * essay graded by criteria (`422 proposal_points_unsupported`: v1 proposes
 * no split per criterion); an accepted answer under ADR-128's own gate and
 * rule (`acceptanceGate`, `assertRuleHolds`). It overwrites the one
 * standing, and records the validated grading in force — the one its
 * confirmation compares. Nothing else moves.
 */
export async function propose(
  db: Db,
  input: {
    contestation: ContestationRecord;
    attempt: AttemptRecord;
    evaluation: EvaluationRecord;
    item: JoinedItem;
    body: ContestationProposalBody;
    userId: string;
    now: Date;
  },
): Promise<ContestationRecord> {
  const { contestation, attempt, evaluation, item, body } = input;
  if (contestation.state !== "open") throw new GradingError("not_open");
  const inForce = (await validatedOfCells(db, [contestation])).get(pairKey(contestation.attemptId, contestation.itemId)) ?? null;
  if (body.points !== undefined) {
    if (criteriaOf(item).length > 0) throw new GradingError("proposal_points_unsupported");
    assertPointsInRange(evaluation, item, { maxPoints: inForce?.maxPoints ?? item.item.points }, body.points);
  }
  if (body.accepted) {
    const hook = await acceptanceGate(db, evaluation, item);
    assertRuleHolds(hook, item, proposedRule(body.accepted, attempt.id), attempt);
  }
  const [row] = await db
    .update(contestations)
    .set({
      proposedVerdict: body.verdict,
      proposedReply: body.reply,
      proposedPoints: body.points ?? null,
      proposedAcceptance: body.accepted ?? null,
      proposedBy: input.userId,
      proposedAt: input.now,
      gradingAtProposalId: inForce?.id ?? null,
    })
    .where(and(eq(contestations.id, contestation.id), eq(contestations.state, "open")))
    .returning();
  if (!row) throw new GradingError("not_open");
  return row;
}

/** Drops the proposal standing on an open or answered contestation; false when none stood. */
export async function discardProposal(db: Db, contestationId: string): Promise<boolean> {
  const cleared = await db
    .update(contestations)
    .set(NO_PROPOSAL)
    .where(and(eq(contestations.id, contestationId), isNotNull(contestations.proposedAt)))
    .returning({ id: contestations.id });
  return cleared.length > 0;
}

/**
 * Whether the proposal the owner read (`read`, its `proposedAt`) may be
 * confirmed now: open (`409 not_open`), a proposal standing (`404
 * no_proposal`), that very proposal — not one an assistant wrote since —
 * and the validated grading in force the one it recorded (`409
 * proposal_stale`). Checked before anything is written, ADR-128's act
 * included; the confirmation's own write checks it again under its lock or
 * its conditional UPDATE.
 */
export async function assertConfirmable(db: Db, contestation: ContestationRecord, read: string): Promise<void> {
  if (contestation.state !== "open") throw new GradingError("not_open");
  if (contestation.proposedAt === null) throw new GradingError("no_proposal");
  if (contestation.proposedAt.toISOString() !== new Date(read).toISOString()) throw new GradingError("proposal_stale");
  const inForce = (await validatedOfCells(db, [contestation])).get(pairKey(contestation.attemptId, contestation.itemId));
  if (proposalStale(contestation.gradingAtProposalId, inForce?.id ?? null)) throw new GradingError("proposal_stale");
}

/** The owner's answer a proposal of new points, or of a bare verdict, stands for. */
export function confirmationBody(row: ContestationRecord): ContestationResolveBody {
  return {
    verdict: row.proposedVerdict!,
    reply: row.proposedReply ?? "",
    ...(row.proposedPoints === null ? {} : { points: row.proposedPoints }),
  };
}

// --- What an assistant reads ----------------------------------------------------------

/** The text of some blocks, through the Markdown export (ADR-121); null when none. */
const textOf = (blocks: readonly Block[]): string | null => {
  const text = markdownBody({ lang: "en", blocks: [...blocks] }).trim();
  return text === "" ? null : text;
};

/** A reading that never throws: a config this build reads differently gives nothing rather than a 500. */
function safely<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** The question as the staff read it, as text (`statementDoc`, `solutionDoc`), each capped. */
function contestedItemOf(item: JoinedItem): AssistantContestedItem {
  const type = typeOf(item.question.type);
  const l = LABELS.en;
  const views = safely(() => expectedViews(item));
  const statement = type.statementDoc && views ? safely(() => textOf(statementBlocks(type, views.student, l))) : null;
  const key = views ? safely(() => textOf(solutionBlocks(type, views.solution, views.student, l))) : null;
  return {
    id: item.item.id,
    position: item.item.position,
    type: item.question.type,
    points: item.item.points,
    statement: statement === null ? null : clipText(statement),
    key: key === null ? null : clipText(key),
  };
}

/** One answer as text: the type's export text (`answerDoc`), else its JSON; null when none was given. */
function answerTextOf(item: JoinedItem, config: unknown, payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  const type = typeOf(item.question.type);
  const parsed = type.answerSchema.safeParse(payload);
  if (type.answerDoc && parsed.success) {
    const text = safely(() => textOf(type.answerDoc!(config, parsed.data, null, LABELS.en)));
    if (text !== null) return text;
  }
  return JSON.stringify(payload);
}

/**
 * A proposal as an assistant reads it back, masked: its reply (a member of
 * the staff may have written it from the portal, with a name) and an
 * accepted answer's identity and label (the student's words).
 */
const maskedProposal = (proposal: ContestationProposalView | null, mask: (text: string) => string): ContestationProposalView | null =>
  proposal && {
    ...proposal,
    reply: mask(proposal.reply),
    accepted: proposal.accepted && {
      ...proposal.accepted,
      answer: mask(proposal.accepted.answer),
      label: proposal.accepted.label === null ? null : mask(proposal.accepted.label),
    },
  };

/**
 * `GET /evaluations/:id/contestations/open` (ADR-139 §14): the class's OPEN
 * contestations — on an official attempt, not a staff seat's walk, as the
 * open figures count them — oldest first, one page from `offset`
 * (`contestationPage`). Each with an opaque id, never a name, an address nor an
 * attempt: the reason, the answer and the grading's comment masked with the
 * roster's and the sitters' names and addresses (`maskNames`, ADR-063 §4),
 * then capped (`clipText`); the questions they contest as the staff read
 * them; what ADR-128 could accept on the item; the proposal standing.
 */
export async function assistantContestations(db: Db, evaluation: EvaluationRecord, offset: number): Promise<AssistantExamContestations> {
  const open = and(eq(attempts.evaluationId, evaluation.id), eq(contestations.state, "open"), officialAttempt, sql`not ${isStaffAttempt}`);
  const [[counted], rows, items, people, attemptsSat] = await Promise.all([
    db
      .select({ n: count() })
      .from(contestations)
      .innerJoin(attempts, eq(attempts.id, contestations.attemptId))
      .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
      .where(open),
    db
      .select({ contestation: contestations, attempt: attempts })
      .from(contestations)
      .innerJoin(attempts, eq(attempts.id, contestations.attemptId))
      .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
      .where(open)
      .orderBy(asc(contestations.filedAt), asc(contestations.id))
      .offset(offset)
      .limit(CONTESTATION_EXPORT_PAGE),
    joinedItems(db, evaluation.id),
    peopleOf(db, evaluation),
    attemptCount(db, evaluation.id),
  ]);
  const total = counted?.n ?? 0;
  const mask = (text: string) => clipText(maskNames(text, people));
  const byId = new Map(items.map((i) => [i.item.id, i]));
  const frozen = itemListLock(evaluation.state, attemptsSat) !== null;
  const [answerRows, inForce] = await Promise.all([
    rows.length === 0
      ? []
      : db
          .select()
          .from(answers)
          .where(inArray(answers.attemptId, rows.map((r) => r.attempt.id))),
    validatedOfCells(db, rows.map((r) => r.contestation)),
  ]);
  const proposals = await proposalViews(db, evaluation, rows.map((r) => r.contestation), items, inForce);
  const answerOf = new Map(answerRows.map((a) => [pairKey(a.attemptId, a.itemId), a]));

  const entries: (AssistantExamContestation | null)[] = rows.map(({ contestation, attempt }) => {
    const item = byId.get(contestation.itemId);
    if (!item) return null;
    const key = pairKey(attempt.id, item.item.id);
    const config = safely(() => readingPerAttempt(item)(attempt).config);
    const payload = answerOf.get(key)?.payload ?? null;
    const answer = answerTextOf(item, config, payload);
    const grading = inForce.get(key);
    const hook = frozen ? acceptanceHook(item.question.type, evaluation.mode) : undefined;
    return {
      id: contestation.id,
      itemId: item.item.id,
      filedAt: iso(contestation.filedAt),
      reason: mask(contestation.reason),
      answer: answer === null ? null : mask(answer),
      grading: grading
        ? {
            points: grading.points,
            maxPoints: grading.maxPoints,
            source: grading.source,
            comment: grading.comment === null ? null : mask(grading.comment),
          }
        : null,
      acceptance: hook
        ? {
            scopes: [...itemScopes(hook, isParameterized(item.version), () => config)],
            // The identities are the student's words too: masked, a name typed in a blank cannot be accepted from here.
            parts: partsOf(hook, item.question.type, config ?? undefined, payload).map((p) => ({ ...p, answer: mask(p.answer), label: mask(p.label) })),
          }
        : null,
      proposal: maskedProposal(proposals.get(contestation.id) ?? null, mask),
    };
  });
  const { take, next } = contestationPage(entries.map((e) => (e === null ? null : JSON.stringify(e).length)), offset, total);
  const page = entries.slice(0, take).filter((e) => e !== null);
  const shown = new Set(page.map((e) => e.itemId));
  return {
    evaluationId: evaluation.id,
    title: evaluation.title,
    total,
    offset,
    next,
    items: items.filter((i) => shown.has(i.item.id)).map(contestedItemOf),
    contestations: page,
  };
}
