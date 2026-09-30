/**
 * The activities of every kind, where a page lists them together (ADR-035
 * §2). Each list is the concatenation of the kinds' own; the web app orders
 * and groups the rows itself (`activities/model.ts`).
 *
 * `KINDS` is a plain list, not a registry: a kind is added here by hand, in
 * the same pull request as its module (the projects, M3-02).
 */
import type { ActivitySummary } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import type { Caller } from "../guards.js";
import { evaluationActivity } from "./evaluation.js";

const KINDS = [evaluationActivity] as const;

/** `GET /activities`: what the caller manages in their own name, every kind. */
export async function listForTeacher(db: Db, caller: Caller, now: Date): Promise<ActivitySummary[]> {
  return (await Promise.all(KINDS.map((k) => k.listForTeacher(db, caller, now)))).flat();
}
