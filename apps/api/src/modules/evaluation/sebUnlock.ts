/**
 * The unlock password of an evaluation's Safe Exam Browser (ADR-027,
 * addendum of 2026-11-06): the `.seb` download hashes it into the file, the
 * staff's live screen shows it. Staff-only, never copied, never audited.
 */
import { randomInt } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { drawSebUnlockPassword } from "@quiz/domain";

import { evaluations } from "../../db/schema.js";
import type { DbOrTx, EvaluationRecord } from "./shared.js";

/**
 * The unlock password of `evaluation`: the stored one, or one drawn now from
 * the CSPRNG and stored by a single statement, so two first downloads at the
 * same moment keep the one that landed first (as `paperSeedOf`). Never
 * changed once drawn: every `.seb` of the evaluation carries the same hash.
 */
export async function sebUnlockPasswordOf(
  db: DbOrTx,
  evaluation: Pick<EvaluationRecord, "id" | "sebUnlockPassword">,
): Promise<string> {
  if (evaluation.sebUnlockPassword !== null) return evaluation.sebUnlockPassword;
  const drawn = drawSebUnlockPassword((n) => randomInt(n));
  const [row] = await db
    .update(evaluations)
    .set({ sebUnlockPassword: sql`coalesce(${evaluations.sebUnlockPassword}, ${drawn})` })
    .where(eq(evaluations.id, evaluation.id))
    .returning({ password: evaluations.sebUnlockPassword });
  if (row?.password == null) throw new Error(`evaluation ${evaluation.id} has no SEB unlock password`);
  return row.password;
}
