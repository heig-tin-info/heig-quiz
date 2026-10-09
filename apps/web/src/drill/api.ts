/**
 * The drill's HTTP surface on the client (ADR-041, #317). Every body sent
 * goes through the schema of `@quiz/contracts/drill` that the API validates
 * it with (invariant 7); every answer is typed by the same module, as the
 * rest of the app reads its answers.
 */
import { useQuery } from "@tanstack/react-query";

import {
  DrillAnswerBody,
  DrillClassroomBody,
  DrillOptOutBody,
  type DrillProgressQuery,
  DrillSessionQuery,
  DrillShownBody,
  EvaluationDrillBody,
  type DrillCalibrationLevel,
  type DrillCardsRemoved,
  type DrillClassroom,
  type DrillClassroomSettings,
  type DrillDeviceClass,
  type DrillProgress,
  type DrillQuestionConfidence,
  type DrillReviewResult,
  type DrillServed,
  type DrillSession,
  type DrillStudentActivity,
  type DrillConceptMastery,
  type EvaluationDrill,
} from "@quiz/contracts";

import { api } from "../api";
import { classroomDrillKey, drillCalibrationKey, drillClassroomsKey, drillSessionKey } from "../queryKeys";
import { useCoarsePointer } from "../ui";

/** A write's body, parsed by its contract before it leaves. */
const send = <T,>(method: string, schema: { parse: (v: unknown) => T }, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(schema.parse(body)),
});

/** The device class of this review (ADR-041 §4): a coarse pointer is a phone or a tablet. */
export function useDrillDevice(): DrillDeviceClass {
  return useCoarsePointer() ? "coarse" : "fine";
}

// --- Student ---------------------------------------------------------------

export const fetchDrillSession = (device: DrillDeviceClass) =>
  api<DrillSession>(
    `/app/api/drill/session?${new URLSearchParams(DrillSessionQuery.parse({ device }))}`,
  );

export const fetchDrillClassrooms = () => api<DrillClassroom[]>("/app/api/drill/classrooms");

export const serveCard = (cardId: string) =>
  api<DrillServed>(`/app/api/drill/cards/${cardId}/serve`, { method: "POST" });

/**
 * `keepalive`, like the attempt's journal: the hidden report leaves as the
 * tab goes away, and a hidden report LOST would leave the interval open on
 * the server, crediting the time off screen up to the idle cap.
 */
export const reportShown = (cardId: string, shown: boolean) =>
  api<void>(`/app/api/drill/cards/${cardId}/shown`, {
    ...send("POST", DrillShownBody, { shown }),
    keepalive: true,
  });

/** `confidence` is the student's, null when they skipped it (ADR-085); the server only stores it. */
export const answerCard = (
  cardId: string,
  answer: unknown,
  deviceClass: DrillDeviceClass,
  confidence: number | null = null,
) =>
  api<DrillReviewResult>(
    `/app/api/drill/cards/${cardId}/answer`,
    send("POST", DrillAnswerBody, { answer, deviceClass, confidence }),
  );

export const setOptOut = (classroomId: string, optedOut: boolean) =>
  api<DrillClassroom>(
    `/app/api/drill/classrooms/${classroomId}/opt-out`,
    send("PUT", DrillOptOutBody, { optedOut }),
  );

/** The student's drill classrooms: what decides whether the Drill entries are drawn at all. */
export function useDrillClassrooms(enabled = true) {
  return useQuery({
    queryKey: drillClassroomsKey,
    queryFn: fetchDrillClassrooms,
    enabled,
    staleTime: 60_000,
  });
}

/** Today's session for this device class. */
export function useDrillSession(device: DrillDeviceClass, enabled = true) {
  return useQuery({
    queryKey: drillSessionKey(device),
    queryFn: () => fetchDrillSession(device),
    enabled,
    staleTime: 60_000,
  });
}

/** The student's own calibration (ADR-085 §8): the five levels, lowest first. */
export function useDrillCalibration(enabled = true) {
  return useQuery({
    queryKey: drillCalibrationKey,
    queryFn: () => api<DrillCalibrationLevel[]>("/app/api/drill/calibration"),
    enabled,
  });
}

/**
 * What the navigation needs (DESIGN.md, "The student's bottom bar"): whether
 * the student has any classroom with the drill on — the Drill slot and the
 * sidebar row are drawn only then — and whether today's session holds
 * anything, for the "today's drill is available" badge. No count, no streak
 * (06, question 28): only whether there is something today.
 */
export interface DrillAvailability {
  shown: boolean;
  available: boolean;
  /** Today's session, while it holds something; null otherwise. */
  session: DrillSession | null;
}

export function useDrillAvailability(enabled: boolean): DrillAvailability {
  const device = useDrillDevice();
  const rooms = useDrillClassrooms(enabled);
  const shown = enabled && (rooms.data?.length ?? 0) > 0;
  const today = useDrillSession(device, shown).data;
  const session = shown && today && today.cards.length > 0 ? today : null;
  return { shown, available: session !== null, session };
}

// --- Teacher ---------------------------------------------------------------

export const setClassroomDrill = (classroomId: string, enabled: boolean) =>
  api<DrillClassroomSettings>(
    `/app/api/classrooms/${classroomId}/drill`,
    send("PUT", DrillClassroomBody, { enabled }),
  );

export const fetchEvaluationDrill = (evaluationId: string) =>
  api<EvaluationDrill>(`/app/api/evaluations/${evaluationId}/drill`);

export const setEvaluationDrill = (evaluationId: string, allowDrill: boolean) =>
  api<EvaluationDrill>(
    `/app/api/evaluations/${evaluationId}/drill`,
    send("PUT", EvaluationDrillBody, { allowDrill }),
  );

export const removeEvaluationCards = (evaluationId: string) =>
  api<DrillCardsRemoved>(`/app/api/evaluations/${evaluationId}/drill/cards`, { method: "DELETE" });

// --- Teacher's view (slice 4) ------------------------------------------------

/** Each student's activity in the classroom's drill (ADR-041 §8). */
export function useClassroomDrillActivity(classroomId: string) {
  return useQuery({
    queryKey: classroomDrillKey(classroomId, "activity"),
    queryFn: () => api<DrillStudentActivity[]>(`/app/api/classrooms/${classroomId}/drill/activity`),
  });
}

/**
 * One student's weeks (an enrollment id). The query is typed by its
 * contract, not parsed by it: the id comes from the server's own answer,
 * like the ids of every path the app builds, and the mock's readable ids
 * are not uuids.
 */
export function useDrillProgress(classroomId: string, student: string) {
  const query: DrillProgressQuery = { student };
  return useQuery({
    queryKey: classroomDrillKey(classroomId, `progress:${student}`),
    queryFn: () =>
      api<DrillProgress>(`/app/api/classrooms/${classroomId}/drill/progress?${new URLSearchParams(query)}`),
  });
}

/** The mastery per concept of the classroom (ADR-041 §10, item 10). */
export function useClassroomDrillMastery(classroomId: string) {
  return useQuery({
    queryKey: classroomDrillKey(classroomId, "mastery"),
    queryFn: () => api<DrillConceptMastery[]>(`/app/api/classrooms/${classroomId}/drill/mastery`),
  });
}

/** Per question, the classroom's 2×2 of confidence (ADR-085 §8): only questions stated by enough students. */
export function useClassroomDrillConfidence(classroomId: string) {
  return useQuery({
    queryKey: classroomDrillKey(classroomId, "confidence"),
    queryFn: () => api<DrillQuestionConfidence[]>(`/app/api/classrooms/${classroomId}/drill/confidence`),
  });
}
