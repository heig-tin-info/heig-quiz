/**
 * Drill seeding for the database tests of the modules that READ the drill's
 * tables (the `stats` module, ADR-039 §6b): a card and a round of targeted
 * revision inserted straight, as the `drill` module leaves them, so a test
 * sets any history without serving and answering through the routes.
 */
import { randomUUID } from "node:crypto";

import type { Db } from "../db/client.js";
import { drillCards, drillRevisionAnswers, drillRevisionRounds } from "../db/schema.js";
import type { Seeded } from "./live.js";

/** The drill card of `userId` on `questionId`, met in the seed's exam: one per student and question. */
export async function seedDrillCard(db: Db, seed: Seeded, userId: string, questionId: string): Promise<string> {
  const id = randomUUID();
  const at = new Date("2026-09-01T08:00:00.000Z");
  await db.insert(drillCards).values({
    id,
    userId,
    questionId,
    classroomId: seed.classroomId,
    evaluationId: seed.evaluationId,
    dueAt: at,
    keyHash: "key",
    createdAt: at,
  });
  return id;
}

/** One pass of a card in a round: served at `servedAt`, answered `timeMs` later, or never (null). */
export interface RevisionPass {
  pass?: 1 | 2;
  servedAt: Date;
  timeMs: number | null;
  correctness?: "right" | "wrong";
}

/** A round of targeted revision of `userId` on one card, started at its first pass, with those passes. */
export async function seedRevisionRound(
  db: Db,
  seed: Seeded,
  userId: string,
  cardId: string,
  passes: readonly [RevisionPass, ...RevisionPass[]],
): Promise<string> {
  const roundId = randomUUID();
  await db.insert(drillRevisionRounds).values({
    id: roundId,
    userId,
    classroomId: seed.classroomId,
    cardIds: [cardId],
    startedAt: passes[0].servedAt,
    cardsServed: 1,
  });
  for (const { pass = 1, servedAt, timeMs, correctness = "right" } of passes) {
    await db.insert(drillRevisionAnswers).values({
      id: randomUUID(),
      roundId,
      cardId,
      pass,
      servedAt,
      serveSeed: 1,
      answeredAt: timeMs === null ? null : new Date(servedAt.getTime() + timeMs),
      correctness: timeMs === null ? null : correctness,
      timeMs,
    });
  }
  return roundId;
}
