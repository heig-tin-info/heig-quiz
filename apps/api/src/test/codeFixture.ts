/**
 * A closed evaluation holding ONE runner-backed question, answered by one
 * student (WP6 tests).
 *
 * It exists because the runner half of the grading flow cannot be exercised
 * with the fake `short` type: what has to be reproduced is a `grade()` that
 * returns `pending: runner` and a `finalizeRunner` that turns an outcome into
 * points. The type is `fakeRunnableCode` (`./fakeType.ts`), which the caller
 * registers, and everything else goes through the real services — the pool
 * pipeline publishes the question, the evaluation service adds the item, the
 * live service starts the attempt and stores the answer.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { questions } from "../db/schema.js";
import * as evaluationService from "../modules/evaluation/service.js";
import * as live from "../modules/live/service.js";
import { loadConfig, typeOf } from "../modules/pool/config.js";
import * as poolService from "../modules/pool/service.js";
import { seedLive } from "./live.js";

export interface CodeFixture {
  evaluationId: string;
  itemId: string;
  attemptId: string;
  studentId: string;
  teacherId: string;
  classroomId: string;
}

/** The config the fake `code` type accepts: one visible case worth a point. */
export const codeConfig = {
  template: "int main(void) { return 0; }",
  runsPerMinute: 2,
  cases: [{ name: "visible-1", expected: "ok", visible: true }],
};

export async function seedCodeEvaluation(db: Db, now: Date): Promise<CodeFixture> {
  const seed = await seedLive(db, { students: 1, questions: 0 });

  const questionId = await poolService.createQuestion(db, {
    poolId: seed.poolId,
    type: "code",
    internalName: `code-${nextSuffix()}`,
    createdBy: seed.teacherId,
  });
  const [question] = await db.select().from(questions).where(eq(questions.id, questionId));
  await poolService.putDraft(db, question!, { config: codeConfig });
  await poolService.publishQuestion(db, question!, { userId: seed.teacherId });

  let evaluation = (await evaluationService.byId(db, seed.evaluationId))!;
  const items = await evaluationService.addItems(
    db,
    evaluation,
    [questionId],
    (type, version) =>
      typeOf(type).defaultPoints(
        loadConfig(type, { config: version.config, configVersion: version.configVersion }),
      ),
    { attemptCount: 0 },
  );
  const itemId = items[0]!.id;

  evaluation = await evaluationService.applyState(db, evaluation, "running", now);
  const participant = (await live.participantOf(db, evaluation, seed.studentIds[0]!))!;
  const created = await live.ensureAttempt(db, evaluation, participant, now);
  const attempt = await live.beginAttempt(db, evaluation, created, participant, now);
  await live.saveAnswer(db, {
    evaluation,
    attempt,
    itemId,
    payload: { regions: ["return 0;"] },
    revision: 1,
    now,
  });
  await live.closeEvaluation(db, evaluation, now);

  return {
    evaluationId: evaluation.id,
    itemId,
    attemptId: attempt.id,
    studentId: seed.studentIds[0]!,
    teacherId: seed.teacherId,
    classroomId: seed.classroomId,
  };
}

/** A short unique suffix: `internal_name` is unique inside a pool. */
let counter = 0;
function nextSuffix(): string {
  counter += 1;
  return String(counter);
}
