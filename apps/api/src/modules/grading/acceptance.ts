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
import { isDeepStrictEqual } from "node:util";

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { AcceptablePart, ItemAcceptance } from "@quiz/contracts";
import {
  acceptanceReach,
  acceptanceScopes,
  itemListLock,
  round2,
  type AcceptanceCell,
  type AcceptanceRule,
} from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { answerAcceptances, answers, attempts, officialAttempt } from "../../db/schema.js";
import {
  attemptCount,
  joinedItem,
  type DbOrTx,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { typeOf } from "../pool/config.js";
import { configPerAttempt, isParameterized, writtenConfig } from "../pool/service.js";
import {
  acceptanceGuard,
  acceptanceHook,
  acceptancesOf,
  lockItems,
  ruleLabel,
  type AcceptanceHook,
  type RuleBound,
} from "./acceptanceRules.js";
import { boundCell, readConfig } from "./evaluationPass.js";
import { endOf, passGuard } from "./passCommon.js";
import { standingGradings } from "./reads.js";
import { GradingError, pairKey, type AttemptRecord, type GradingRecord, type PairKey } from "./records.js";
import { writeGradings, type WriteGradingInput } from "./writer.js";

/**
 * The parts of a stored answer an acceptance can name, with what a teacher
 * reads of each — the grading queue's `parts` (ADR-128). Empty when the
 * answer no longer parses or the type cannot read it.
 */
export function partsOf(hook: AcceptanceHook, type: string, config: unknown, payload: unknown): AcceptablePart[] {
  if (payload === null || config === undefined) return [];
  const parsed = typeOf(type).answerSchema.safeParse(payload);
  if (!parsed.success) return [];
  let given;
  try {
    given = hook.given(config, parsed.data);
  } catch {
    // A config this build reads differently: no affordance, never a 500.
    return [];
  }
  return given.map((p) => ({ ...p, label: ruleLabel(hook, () => config, p) ?? p.answer }));
}

/**
 * The `acceptance` of a grading queue's item that takes one (ADR-128): the
 * scopes it offers and the acceptances in force, each with its label — read
 * on the config of the attempt a single-student rule names, else on
 * `configOf`'s for no attempt in particular.
 */
export function queueAcceptance(
  hook: AcceptanceHook,
  item: JoinedItem,
  rules: readonly AcceptanceRule[],
  configOf: (attemptId: string | null) => unknown,
): { scopes: ("everyone" | "student")[]; accepted: ItemAcceptance[] } {
  return {
    scopes: [...acceptanceScopes(isParameterized(item.version))],
    accepted: rules.map((rule) => ({ ...rule, label: ruleLabel(hook, () => configOf(rule.attemptId), rule) ?? rule.answer })),
  };
}

/** What {@link changeAcceptance} did (`AnswerAcceptanceResult`). */
export interface AcceptanceChange {
  /** The act changed the rules: false when they already said so (it audits nothing then). */
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
 * Serialized per item (`lockItems`): the rule is written under the item's
 * lock, and the re-grade is written by `acceptanceGuard`, which takes it
 * again, reads the rules then in force and drops a cell overridden by hand
 * meanwhile. The re-grade runs whether the rules changed or not, so a PUT
 * or DELETE repeated after a failure heals what the first left undone.
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
  const hook = acceptanceHook(item.question.type, evaluation.mode);
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

  const { held, changed } = await db.transaction(async (tx) => {
    await lockItems(tx, [item.item.id]);
    // The version in force under the lock: a regrade may have retargeted it.
    const held = (await joinedItem(tx, evaluation.id, item.item.id)) ?? item;
    // A static question's config is every attempt's; a single student's
    // rule is read on that student's instance.
    const sample = attemptRows[0] ?? NO_ATTEMPT;
    if (ruleLabel(hook, () => configPerAttempt(held)(sample), rule) === null) throw new GradingError("acceptance_invalid");
    const changed = accept
      ? await insertRule(tx, item.item.id, rule, actorId, now)
      : await deleteRule(tx, item.item.id, rule);
    return { held, changed };
  });

  const { writes, bound, unchanged } = await regradeReached(app, evaluation, held, hook, rule, attemptRows);
  const written = await writeGradings(
    db,
    writes,
    acceptanceGuard(passGuard(new Map(attemptRows.map((a) => [a.id, endOf(a.closedAt)]))), bound, { leaveManual: true }),
  );
  return {
    changed,
    regraded: written.length,
    unchanged,
    modifiedAfterRelease: evaluation.releasedAt !== null && written.some((w) => w.state === "validated"),
  };
}

/** No attempt at all: what a static item's config, which reads none, is asked with. */
const NO_ATTEMPT = { seed: 0, instances: {} };

async function insertRule(db: DbOrTx, itemId: string, rule: AcceptanceRule, actorId: string, now: Date): Promise<boolean> {
  const inserted = await db
    .insert(answerAcceptances)
    .values({ id: randomUUID(), itemId, ...rule, createdBy: actorId, createdAt: now })
    .onConflictDoNothing()
    .returning({ id: answerAcceptances.id });
  return inserted.length > 0;
}

async function deleteRule(db: DbOrTx, itemId: string, rule: AcceptanceRule): Promise<boolean> {
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
 * The new gradings of the graded answers `rule` reaches, with the rules in
 * force now, each bound to them for the write guard, and how many answers it
 * reaches that a manual override keeps.
 */
async function regradeReached(
  app: FastifyInstance,
  evaluation: EvaluationRecord,
  item: JoinedItem,
  hook: AcceptanceHook,
  rule: AcceptanceRule,
  attemptRows: readonly AttemptRecord[],
): Promise<{ writes: WriteGradingInput[]; bound: Map<PairKey, RuleBound>; unchanged: number }> {
  const db: Db = app.db;
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
  const rules = acceptances.get(item.item.id) ?? [];
  const answerOf = new Map(answerRows.map((a) => [a.attemptId, a]));
  const { configOf } = readConfig(app, item);
  const cells: AcceptanceCell[] = attemptRows.flatMap((attempt) => {
    const answer = answerOf.get(attempt.id);
    if (!answer) return [];
    const given = partsOf(hook, item.question.type, configOf(attempt)?.config, answer.payload);
    const grading = standing.get(pairKey(attempt.id, item.item.id));
    return [{ attemptId: attempt.id, given, manual: grading?.source === "manual" }];
  });
  const { reached, unchanged } = acceptanceReach(cells, rule);
  const writes: WriteGradingInput[] = [];
  const bound = new Map<PairKey, RuleBound>();
  for (const attempt of attemptRows) {
    const key = pairKey(attempt.id, item.item.id);
    // Not graded yet: the pass that grades it applies the rule.
    if (!reached.includes(attempt.id) || !standing.has(key)) continue;
    const { graded, bound: cell } = await boundCell(app, {
      evaluation,
      job: { evaluationId: evaluation.id },
      item,
      config: configOf(attempt),
      attempt,
      answer: answerOf.get(attempt.id) ?? null,
      llm: false,
      rules,
    });
    if (!("write" in graded)) continue;
    // Already graded so (a repeated act): nothing to write, nobody to tell.
    if (sameGrading(standing.get(key)!, graded.write)) continue;
    writes.push(graded.write);
    bound.set(key, cell);
  }
  return { writes, bound, unchanged: unchanged.length };
}

/** Whether a new automatic grading would only repeat the one in force. */
function sameGrading(standing: GradingRecord, write: WriteGradingInput): boolean {
  return (
    standing.source === write.source &&
    standing.state === write.state &&
    standing.points === round2(write.points) &&
    // jsonb keeps no key order: compared as values, as stored.
    isDeepStrictEqual(standing.details ?? null, JSON.parse(JSON.stringify(write.details ?? null)))
  );
}

/**
 * A regrade onto another version (F-GRADE-06, ADR-128), under the item's
 * lock: the acceptances of `held` whose part — or, for a dropdown, whose
 * option — `version` no longer holds are dropped, and the note says which.
 * An identity is kept when the new version holds it under the same label (a
 * dropdown's canonical index may name another option there). Nothing is
 * dropped when this build cannot read the new version. Returns the labels
 * dropped.
 */
export async function dropVanishedAcceptances(
  tx: DbOrTx,
  held: JoinedItem,
  version: JoinedItem["version"],
): Promise<string[]> {
  const type = held.question.type;
  const hook = acceptanceHook(type);
  if (!hook) return [];
  const before = () => writtenConfig(type, held.version).config;
  const after = () => writtenConfig(type, version).config;
  if (!reads(after)) return [];
  const rules = (await acceptancesOf(tx, [held.item.id])).get(held.item.id) ?? [];
  const dropped: string[] = [];
  for (const rule of rules) {
    const was = ruleLabel(hook, before, rule);
    const now = ruleLabel(hook, after, rule);
    if (now !== null && (was === null || was === now)) continue;
    await tx.delete(answerAcceptances).where(and(eq(answerAcceptances.itemId, held.item.id), ...ruleMatch(rule)));
    dropped.push(was ?? rule.answer);
  }
  return dropped;
}

/** Whether a config reads at all; false when this build cannot read it. */
function reads(config: () => unknown): boolean {
  try {
    config();
    return true;
  } catch {
    return false;
  }
}
