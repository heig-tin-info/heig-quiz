/**
 * The integrity journal as the staff read it (ADR-088 §7): incidents derived
 * on the server from the attempt's journal rows (`integrityIncidents`,
 * `@quiz/domain`), never the rows themselves. Staff only; there is no student
 * view of the journal.
 */
import { z } from "zod";

/**
 * One incident: the page left (`durationMs` null while the absence goes on),
 * or a paste from outside it (its length, and whether the page had just lost
 * the focus). Indicative, never proof.
 */
export const IntegrityIncident = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("left"),
    at: z.iso.datetime(),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    kind: z.literal("paste"),
    at: z.iso.datetime(),
    length: z.number().int().nonnegative().nullable(),
    afterFocusLoss: z.boolean(),
  }),
]);
export type IntegrityIncident = z.infer<typeof IntegrityIncident>;
export type IntegrityIncidentKind = IntegrityIncident["kind"];

/**
 * `GET /evaluations/:id/incidents`: every attempt's incidents, in time order.
 * `userId` lets the dashboard name an entry as its grid does (names hidden,
 * F-DASH-02); `displayName` names an attempt the grid has no row for, and
 * only while the names are shown. Whether the evaluation keeps the journal
 * at all is the dashboard's `evaluation.journalOn`.
 */
export const EvaluationIncidents = z.object({
  incidents: z.array(
    z.object({
      attemptId: z.uuid(),
      userId: z.uuid().nullable(),
      displayName: z.string(),
      /** The inspector's pseudonym: the name of an entry with no grid row while names are hidden. */
      pseudonym: z.string(),
      incident: IntegrityIncident,
    }),
  ),
  serverNow: z.iso.datetime(),
});
export type EvaluationIncidents = z.infer<typeof EvaluationIncidents>;
