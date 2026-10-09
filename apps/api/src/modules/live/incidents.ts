/**
 * The integrity journal read as incidents, for the staff (ADR-088 §7): the
 * dashboard's per-row count, the inspector's list, and the evaluation's list.
 * One query for any number of attempts, never one per row; the pairing, the
 * one-second rule and the cap at the attempt's end are `integrityIncidents`'s
 * (`@quiz/domain`), applied on the server's own times.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import {
  INTEGRITY_EVENT_KINDS,
  isIntegrityEventKind,
  type AttemptEventKind,
  type EvaluationIncidents,
  type IntegrityIncident,
} from "@quiz/contracts";
import { integrityIncidents, integrityJournalOn, uniquePseudonyms, type Incident, type JournalRow } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { attemptEvents, attempts, users } from "../../db/schema.js";
import { settingsOf, type EvaluationRecord } from "../evaluation/service.js";
import type { AttemptRecord } from "./attempt.js";
import { fullName } from "./names.js";

/** What an attempt's end is read from: `closedAt` is set on every end, a hand-in included. */
type Ended = Pick<AttemptRecord, "id" | "closedAt" | "deadlineAt">;

/** Whether the evaluation keeps the integrity journal at all (a poll never does). */
export function journalOn(evaluation: EvaluationRecord): boolean {
  return integrityJournalOn(evaluation.mode, settingsOf(evaluation).logVisibility);
}

/**
 * The incidents of one attempt from its journal rows in time order — of any
 * kind: the others are ignored, so the inspector derives them from the very
 * rows it lists.
 */
export function incidentsFrom(rows: readonly (JournalRow & { kind: AttemptEventKind })[], attempt: Ended, now: Date) {
  return integrityIncidents(
    rows.filter((row) => isIntegrityEventKind(row.kind)),
    attempt.closedAt ?? attempt.deadlineAt,
    now,
  );
}

/** The incidents of each of `list`, keyed by attempt id; an attempt with none is absent. */
export async function incidentsOf(db: Db, list: readonly Ended[], now: Date): Promise<Map<string, Incident[]>> {
  const out = new Map<string, Incident[]>();
  if (list.length === 0) return out;
  const rows = await db
    .select({ attemptId: attemptEvents.attemptId, kind: attemptEvents.kind, at: attemptEvents.at, details: attemptEvents.details })
    .from(attemptEvents)
    .where(
      and(
        inArray(attemptEvents.attemptId, list.map((a) => a.id)),
        inArray(attemptEvents.kind, [...INTEGRITY_EVENT_KINDS]),
      ),
    )
    .orderBy(asc(attemptEvents.attemptId), asc(attemptEvents.at), asc(attemptEvents.id));
  const journals = new Map<string, typeof rows>();
  for (const row of rows) {
    const journal = journals.get(row.attemptId) ?? [];
    journal.push(row);
    journals.set(row.attemptId, journal);
  }
  for (const attempt of list) {
    const journal = journals.get(attempt.id);
    if (!journal) continue;
    const incidents = incidentsFrom(journal, attempt, now);
    if (incidents.length > 0) out.set(attempt.id, incidents);
  }
  return out;
}

/** An incident on the wire. */
export function incidentOut(incident: Incident): IntegrityIncident {
  return { ...incident, at: iso(incident.at) };
}

/** `GET /evaluations/:id/incidents`: every attempt's incidents, in time order. */
export async function evaluationIncidents(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<EvaluationIncidents> {
  const list = await db
    .select({
      id: attempts.id,
      userId: attempts.userId,
      closedAt: attempts.closedAt,
      deadlineAt: attempts.deadlineAt,
      givenName: users.givenName,
      familyName: users.familyName,
      email: users.email,
    })
    .from(attempts)
    .leftJoin(users, eq(users.id, attempts.userId))
    .where(eq(attempts.evaluationId, evaluation.id));
  const byAttempt = await incidentsOf(db, list, now);
  // The inspector's pseudonym, per person: what an entry the grid has no row
  // for is called while the names are hidden.
  const owner = (a: (typeof list)[number]) => a.userId ?? a.id;
  const pseudonyms = uniquePseudonyms(evaluation.id, [...new Set(list.map(owner))]);
  const incidents = list.flatMap((attempt) =>
    (byAttempt.get(attempt.id) ?? []).map((incident) => ({
      attemptId: attempt.id,
      userId: attempt.userId,
      displayName: fullName(attempt.givenName, attempt.familyName, attempt.email ?? "—"),
      pseudonym: pseudonyms.get(owner(attempt)) ?? "—",
      incident,
    })),
  );
  incidents.sort((a, b) => a.incident.at.getTime() - b.incident.at.getTime());
  return {
    incidents: incidents.map((entry) => ({ ...entry, incident: incidentOut(entry.incident) })),
    serverNow: iso(now),
  };
}
