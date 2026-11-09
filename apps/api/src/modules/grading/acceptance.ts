/**
 * Accepting an answer at grading time (ADR-128): on one item, an answer the
 * key counts wrong counts right — at one part of the question, for everyone
 * who gave it or for one attempt. A durable rule of the item, which every
 * automatic grading of an official attempt applies (`gradeCell`); the act
 * re-grades the answers it reaches at once, a manual override left alone.
 *
 * What a part and an answer's identity ARE is the question type's
 * (`QuestionTypeServer.acceptance`): nothing here knows a cloze.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { AcceptablePart, ItemAcceptance } from "@quiz/contracts";
import {
  acceptanceReach,
  acceptanceScopes,
  itemListLock,
  type AcceptanceRule,
  type AcceptanceCell,
} from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { answerAcceptances, answers, attempts, officialAttempt } from "../../db/schema.js";
import { attemptCount, type DbOrTx, type EvaluationRecord, type JoinedItem } from "../evaluation/service.js";
import { typeOf } from "../pool/config.js";
import { configPerAttempt, isParameterized } from "../pool/service.js";
import { acceptancesOf } from "./acceptanceRules.js";
import { gradeCell, readConfig } from "./evaluationPass.js";
import { endOf, passGuard } from "./passCommon.js";
import { standingGradings } from "./reads.js";
import { GradingError, pairKey, type AttemptRecord } from "./records.js";
import { writeGradings, type WriteGradingInput } from "./writer.js";

/** The type's acceptance hook, when an item of this type can accept an answer on this evaluation. */
function hookOf(type: string, evaluation: Pick<EvaluationRecord, "mode">): AcceptanceHook | undefined {
  // A poll has no grade to correct (ADR-014): never an acceptance there.
  if (evaluation.mode === "poll") return undefined;
  try {
    return typeOf(type).acceptance;
  } catch {
    // A type this build does not carry takes none.
    return undefined;
  }
}

/** Whether an item of `type` can accept an answer at grading time on this evaluation (ADR-128). */
export const takesAcceptance = (type: string, evaluation: Pick<EvaluationRecord, "mode">): boolean =>
  hookOf(type, evaluation) !== undefined;

/**
 * The parts of a stored answer an acceptance can name, with what a teacher
 * reads of each — the grading queue's `parts` (ADR-128). Empty when the
 * type takes no acceptance, or the answer no longer parses.
 */
export function partsOf(
  type: string,
  evaluation: Pick<EvaluationRecord, "mode">,
  config: unknown,
  payload: unknown,
): AcceptablePart[] {
  const hook = hookOf(type, evaluation);
  if (!hook || payload === null || config === undefined) return [];
  const parsed = typeOf(type).answerSchema.safeParse(payload);
  if (!parsed.success) return [];
  try {
    return hook.given(config, parsed.data).map((p) => ({ ...p, label: hook.label(config, p.part, p.answer) ?? p.answer }));
  } catch {
    // A config this build reads differently: no affordance, never a 500.
    return [];
  }
}

/**
 * The `acceptance` of a grading queue's item (ADR-128): the scopes it
 * offers and the acceptances in force, each with its label — read on the
 * config of the attempt a single-student rule names, else on `configOf`'s
 * for no attempt in particular. Undefined when the item takes none.
 */
export function queueAcceptance(
  item: JoinedItem,
  evaluation: Pick<EvaluationRecord, "mode">,
  rules: readonly AcceptanceRule[],
  configOf: (attemptId: string | null) => unknown,
): { scopes: ("everyone" | "student")[]; accepted: ItemAcceptance[] } | undefined {
  const hook = hookOf(item.question.type, evaluation);
  if (!hook) return undefined;
  const labelOf = (rule: AcceptanceRule) => {
    try {
      return hook.label(configOf(rule.attemptId), rule.part, rule.answer) ?? rule.answer;
    } catch {
      return rule.answer;
    }
  };
  return {
    scopes: [...acceptanceScopes(isParameterized(item.version))],
    accepted: rules.map((rule) => ({ ...rule, label: labelOf(rule) })),
  };
}

/** What {@link changeAcceptance} did (`AnswerAcceptanceResult`). */
export interface AcceptanceChange {
  /** The act changed the rules: false when they already said so. */
  changed: boolean;
  regraded: number;
  unchanged: number;
  modifiedAfterRelease: boolean;
}

/**
 * The act (ADR-128): accepts `rule` on `item` (`accept`), or stops
 * accepting it, then re-grades the answers it reaches — every official
 * attempt that gave `rule.answer` at `rule.part`, within its scope, whose
 * grading in force is not a manual override (those are `unchanged`) —
 * through the evaluation pass's own cell grader and the single writer, so
 * a released evaluation is flagged and only the students whose shown grade
 * moved are told (ADR-108 §6, `writeGradings`). An answer not graded yet
 * gets the rule from the pass that grades it.
 *
 * Refused on a poll and for a type without acceptances (`409
 * acceptance_unavailable`), before the item list is frozen (`409
 * acceptance_not_frozen`), in the everyone scope on a parameterized
 * question (`422 acceptance_scope`), and for an answer the part cannot
 * hold (`422 acceptance_invalid`). Null when the attempt is not an
 * official attempt of the evaluation (the route's 404).
 */
export async function changeAcceptance(
  app: FastifyInstance,
  evaluation: EvaluationRecord,
  item: JoinedItem,
  rule: AcceptanceRule,
  accept: boolean,
  actorId: string,
  now: Date,
): Promise<AcceptanceChange | null> {
  const db = app.db;
  const hook = hookOf(item.question.type, evaluation);
  if (!hook) throw new GradingError("acceptance_unavailable");
  if (itemListLock(evaluation.state, await attemptCount(db, evaluation.id)) === null) {
    throw new GradingError("acceptance_not_frozen");
  }
  if (!acceptanceScopes(isParameterized(item.version)).includes(rule.attemptId === null ? "everyone" : "student")) {
    throw new GradingError("acceptance_scope");
  }
  const attemptRows = await db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.evaluationId, evaluation.id),
        officialAttempt,
        rule.attemptId === null ? undefined : eq(attempts.id, rule.attemptId),
      ),
    );
  if (rule.attemptId !== null && attemptRows.length === 0) return null;

  // A static question's config is every attempt's; a single student's rule
  // is read on that student's instance.
  if (labelOn(hook, item, attemptRows[0] ?? NO_ATTEMPT, rule) === null) throw new GradingError("acceptance_invalid");

  const changed = accept ? await insertRule(db, item.item.id, rule, actorId, now) : await deleteRule(db, item.item.id, rule);
  if (!changed) return { changed, regraded: 0, unchanged: 0, modifiedAfterRelease: false };

  const { writes, unchanged } = await regradeReached(app, evaluation, item, rule, attemptRows);
  const written = await writeGradings(db, writes, passGuard(new Map(attemptRows.map((a) => [a.id, endOf(a.closedAt)]))));
  return {
    changed,
    regraded: written.length,
    unchanged,
    modifiedAfterRelease: evaluation.releasedAt !== null && written.some((w) => w.state === "validated"),
  };
}

/** No attempt at all: what a static item's config, which reads none, is asked with. */
const NO_ATTEMPT = { seed: 0, instances: {} };

/** `rule`'s label on the item's config for `attempt`; null when it holds no such answer, or cannot be read. */
function labelOn(
  hook: AcceptanceHook,
  item: JoinedItem,
  attempt: Parameters<ReturnType<typeof configPerAttempt>>[0],
  rule: AcceptanceRule,
): string | null {
  try {
    return safeLabel(hook, configPerAttempt(item)(attempt), rule);
  } catch {
    return null;
  }
}

async function insertRule(db: Db, itemId: string, rule: AcceptanceRule, actorId: string, now: Date): Promise<boolean> {
  const inserted = await db
    .insert(answerAcceptances)
    .values({ id: randomUUID(), itemId, ...rule, createdBy: actorId, createdAt: now })
    .onConflictDoNothing()
    .returning({ id: answerAcceptances.id });
  return inserted.length > 0;
}

async function deleteRule(db: Db, itemId: string, rule: AcceptanceRule): Promise<boolean> {
  const deleted = await db
    .delete(answerAcceptances)
    .where(and(eq(answerAcceptances.itemId, itemId), ...ruleMatch(rule)))
    .returning({ id: answerAcceptances.id });
  return deleted.length > 0;
}

/** The `WHERE` of one rule of an item. */
const ruleMatch = (rule: AcceptanceRule) => [
  eq(answerAcceptances.part, rule.part),
  eq(answerAcceptances.answer, rule.answer),
  rule.attemptId === null ? isNull(answerAcceptances.attemptId) : eq(answerAcceptances.attemptId, rule.attemptId),
];

/**
 * The new gradings of the answers `rule` reaches, graded with the rules in
 * force now, and how many answers it reaches that a manual override keeps.
 */
async function regradeReached(
  app: FastifyInstance,
  evaluation: EvaluationRecord,
  item: JoinedItem,
  rule: AcceptanceRule,
  attemptRows: readonly AttemptRecord[],
): Promise<{ writes: WriteGradingInput[]; unchanged: number }> {
  const db = app.db;
  const ids = attemptRows.map((a) => a.id);
  const [answerRows, standing, acceptances] = await Promise.all([
    ids.length === 0
      ? []
      : db
          .select()
          .from(answers)
          .where(and(eq(answers.itemId, item.item.id), inArray(answers.attemptId, ids))),
    standingGradings(db, evaluation.id, { itemId: item.item.id, attemptIds: ids }),
    acceptancesOf(db, [item.item.id]),
  ]);
  const answerOf = new Map(answerRows.map((a) => [a.attemptId, a]));
  const { configOf } = readConfig(app, item);
  const cells: AcceptanceCell[] = attemptRows.flatMap((attempt) => {
    const answer = answerOf.get(attempt.id);
    if (!answer) return [];
    const given = partsOf(item.question.type, evaluation, configOf(attempt)?.config, answer.payload);
    const grading = standing.get(pairKey(attempt.id, item.item.id));
    return [{ attemptId: attempt.id, given, manual: grading?.source === "manual" }];
  });
  const { reached, unchanged } = acceptanceReach(cells, rule);
  const writes: WriteGradingInput[] = [];
  for (const attempt of attemptRows) {
    // Not graded yet: the pass that grades it applies the rule.
    if (!reached.includes(attempt.id) || !standing.has(pairKey(attempt.id, item.item.id))) continue;
    const graded = await gradeCell(app, {
      evaluation,
      job: { evaluationId: evaluation.id },
      item,
      config: configOf(attempt),
      attempt,
      answer: answerOf.get(attempt.id) ?? null,
      llm: false,
      acceptances,
    });
    if ("write" in graded) writes.push(graded.write);
  }
  return { writes, unchanged: unchanged.length };
}

/**
 * A regrade onto another version (F-GRADE-06, ADR-128): the acceptances
 * whose part — or, for a dropdown, whose option — the new version no
 * longer holds are dropped, and the note says which. `before` and `after`
 * are the question as the old and the new version write it: an identity is
 * kept when the new version holds it under the same label (a dropdown's
 * canonical index may name another option there). Returns the labels
 * dropped.
 */
export async function dropVanishedAcceptances(
  tx: DbOrTx,
  item: { itemId: string; type: string },
  before: unknown,
  after: unknown,
): Promise<string[]> {
  const hook = typeOf(item.type).acceptance;
  if (!hook) return [];
  const rules = (await acceptancesOf(tx, [item.itemId])).get(item.itemId) ?? [];
  const dropped: string[] = [];
  for (const rule of rules) {
    // The same identity must still name the same thing: a dropdown's
    // canonical index may now be another option's.
    const was = safeLabel(hook, before, rule);
    const now = safeLabel(hook, after, rule);
    if (now !== null && (was === null || was === now)) continue;
    await tx.delete(answerAcceptances).where(and(eq(answerAcceptances.itemId, item.itemId), ...ruleMatch(rule)));
    dropped.push(was ?? rule.answer);
  }
  return dropped;
}

type AcceptanceHook = NonNullable<ReturnType<typeof typeOf>["acceptance"]>;

function safeLabel(
  hook: AcceptanceHook,
  config: unknown,
  rule: AcceptanceRule,
): string | null {
  try {
    return hook.label(config, rule.part, rule.answer);
  } catch {
    return null;
  }
}
